#!/usr/bin/env node

/**
 * Worker — background Reasonix task executor
 *
 * Spawned by the MCP server for each reasonix_start_task call.
 * Communicates progress by writing to the job state file.
 *
 * Protocol:
 *   1. Load job config from args (jobId, cwd, etc.)
 *   2. Call DeepSeek Chat API with Reasonix system prompt + tools
 *   3. Loop: AI response → execute tool calls → send results back
 *   4. Write final result to state file
 *
 * Usage: node src/worker/index.mjs --job-id <id>
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../core/config.mjs";
import {
  readJob,
  writeJob,
  writeJobProgress,
  pushTouchedFile,
} from "../core/state.mjs";
import {
  TOOL_REGISTRY,
  TOOL_NAMES,
  TOOL_DEFINITIONS,
} from "../tools/registry.mjs";

/* ------------------------------------------------------------------ */
/*  Parse arguments                                                    */
/* ------------------------------------------------------------------ */

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--job-id" && i + 1 < args.length) opts.jobId = args[++i];
    if (args[i] === "--cwd" && i + 1 < args.length) opts.cwd = args[++i];
    if (args[i] === "--jobs-dir" && i + 1 < args.length) opts.jobsDir = args[++i];
    if (args[i] === "--mode" && i + 1 < args.length) opts.mode = args[++i];
    if (args[i] === "--resume-job-id" && i + 1 < args.length) opts.resumeJobId = args[++i];
  }
  if (!opts.jobId) {
    process.stderr.write("Usage: worker.mjs --job-id <id> [--cwd <dir>]\n");
    process.exit(1);
  }
  return opts;
}

/* ------------------------------------------------------------------ */
/*  DeepSeek API helper — fetch-based, no deps                        */
/* ------------------------------------------------------------------ */

async function callDeepSeek(apiConfig, messages, tools, options = {}) {
  const { baseUrl, apiKey } = apiConfig;
  const model = options.model || apiConfig.modelDefault;

  // max_tokens: per-model config (pro gets more for reasoning overhead)
  const isPro = model === apiConfig.modelPro;
  const maxTokens = isPro
    ? (apiConfig.maxTokensPro || 16384)
    : (apiConfig.maxTokens || 8192);

  const body = {
    model,
    messages,
    tools: tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.inputSchema || { type: "object", properties: {} },
      },
    })),
    tool_choice: "auto",
    max_tokens: maxTokens,
    temperature: 0,
    stream: false,
  };

  if (!tools || tools.length === 0) {
    delete body.tools;
    delete body.tool_choice;
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  return data;
}

/* ------------------------------------------------------------------ */
/*  Reasonix system prompt (condensed)                                */
/* ------------------------------------------------------------------ */

const REASONIX_SYSTEM_PROMPT = `你是一个 Reasonix 编码助手，由 DeepSeek 驱动。

## 核心规则
1. **证据绑定** — 每个关于代码的事实性陈述必须可验证。引用文件路径。
2. **否定即查证** — 说"没有"之前先搜。搜不到则引用搜索为证。
3. **先读后写** — 改文件前先看清当前内容。使用 read_file。
4. **最小改动** — 一行能解决不碰十行。
5. **不夹带私货** — 用户问什么改什么。
6. **改后必验** — 改完检查结果，运行测试或 lint 确认。
7. **风格一致** — 遵循现有命名、缩进、注释习惯。

## edit_file 使用规范（重要）
- edit_file 的 SEARCH 文本必须是文件中**逐字逐句**存在的精确文本，包括空格和缩进。
- SEARCH 文本必须在文件中**唯一出现一次**。如果出现多次，edit_file 会被拒绝。
- 修改前用 read_file 确认文件当前内容，确保 SEARCH 匹配。
- 如果 SEARCH 不唯一：
  a. 扩大 SEARCH 范围（多包含几行上下文），让它变得唯一
  b. 或改用 write_file 重写整个文件
- 如果 SEARCH 找不到：
  a. **不要立即重试** — 先用 read_file 重新确认文件实际内容
  b. 可能是文件已被之前的编辑修改，或者行号/空格不匹配
  c. 调整 SEARCH 文本后重试，最多 3 次

## 工具使用
- 你有丰富的文件操作工具：read_file, write_file, edit_file, multi_edit, search_files, search_content, glob, list_directory, directory_tree, get_file_info, run_command, create_directory, move_file, copy_file, delete_file, delete_directory
- 使用工具完成实际工作。不要只说"我会做什么"——直接用工具去做。
- run_command 用于运行测试、lint、build、git 等常规命令。
- 读取文件前，先用 get_file_info 确认文件大小。超过 100KB 的文件，用 read_file 的 head/tail/range 参数分段读取。

## 大文件处理
- 读取文件前，如果文件未知，先用 get_file_info 确认大小。
- 超过 100KB 的文件不要一次性读取全部内容 — 用 head/tail/range 分段读。
- 避免读取 node_modules、dist、build、.git 等依赖/构建目录。

## 命令执行安全
- 可以运行测试、lint、build、git 等常规开发命令。
- 不要运行会修改系统配置、删除大量文件、或带破坏性标志的命令。
- 如果命令需要超过 60 秒，考虑拆分或缩小范围。

## 错误处理与自我纠错
- 工具调用返回错误时，**不要放弃** — 分析错误原因，修正参数后重试。
- 常见可恢复错误及处理：
  - \`SEARCH text not found\` → 重新 read_file 确认实际内容，调整 search 文本
  - \`SEARCH text appears multiple times\` → 扩大 SEARCH 范围包含更多上下文
  - \`Not a file\` → 用 list_directory 或 glob 确认正确路径
  - \`Destination already exists\` → 先 delete_file 再 copy_file
  - 命令返回非零退出码 → 阅读错误输出，判断是配置问题还是代码问题
- **不要连续三次重试同一个失败的操作**。如果三次都失败：
  - 停止该操作
  - 在最终输出中报告问题和已尝试的方法

## 停止条件
当满足以下任一条件时，停止调用工具，直接输出最终答案：
1. **任务已完成** — 代码已修改、测试已通过、结果已确认
2. **无法完成** — 权限不足、环境缺失、关键信息无法获得
3. **连续失败** — 同一操作连续 3 次失败
4. **信息搜集完成** — 纯诊断/研究任务，已收集到足够信息回答用户问题

## 任务执行
- 收到任务描述后，自主规划并执行。
- 工作流：收集信息（read/search）→ 分析 → 做改动（edit/write）→ 验证（run_command）。
- 每次工具调用后，简要说明当前进展。
- 任务完成后，输出总结：
  - 改了哪些文件
  - 每个文件改了什么、为什么
  - 有哪些风险点或需要人工检查的事项

## 安全
- 不做未经确认的大规模重构。
- API密钥不写入文件、不打印。
- 保持改动聚焦在任务描述范围内，不要顺手"顺便优化"无关代码。`;

/* ------------------------------------------------------------------ */
/*  Tool runner                                                        */
/* ------------------------------------------------------------------ */

function executeToolCall(toolCall, ctx) {
  const { name, arguments: argsStr } = toolCall.function;
  const handler = TOOL_REGISTRY[name];
  if (!handler) {
    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify({ error: `Unknown tool: ${name}` }),
    };
  }

  try {
    const args = JSON.parse(argsStr);

    // Log what we're doing
    const action = name === "read_file" ? `Reading ${args.path}`
      : name === "write_file" ? `Writing ${args.path}`
      : name === "edit_file" ? `Editing ${args.path}`
      : name === "run_command" ? `Running: ${args.command.slice(0, 80)}`
      : name;

    writeJobProgress(ctx.jobsDir, ctx.jobId, {
      currentAction: action,
      messagesCount: ctx.messageCount,
      toolCallsCount: ctx.toolCallCount,
    });

    const result = handler(args, ctx);

    if (name === "write_file" || name === "edit_file" || name === "multi_edit") {
      pushTouchedFile(ctx.jobsDir, ctx.jobId, args.path || "(multi)");
    }

    ctx.toolCallCount++;
    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify(result.content),
    };
  } catch (err) {
    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify({ error: err.message }),
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Build result payload                                              */
/* ------------------------------------------------------------------ */

function buildResult(messages, touchedFiles) {
  // Get the last assistant message as the final answer
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const lastUserContent = [...messages].reverse().find((m) => m.role === "user");

  const output = lastAssistant?.content || "(no output)";

  // Count tokens roughly
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);

  return {
    output,
    touchedFiles: [...new Set(touchedFiles)],
    messagesCount: messages.length,
    estimatedTokens: Math.ceil(totalChars / 4),
    completedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*  Main worker loop                                                   */
/* ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs();
  const config = loadConfig(opts.cwd);
  const { projectRoot } = config;

  // Use explicit --jobs-dir if provided, otherwise fall back to config
  const jobsDir = opts.jobsDir || config.jobsDir;
  const job = readJob(jobsDir, opts.jobId);
  if (!job) {
    process.stderr.write(`Job ${opts.jobId} not found\n`);
    process.exit(1);
  }

  // Update status to running
  job.status = "running";
  job.phase = "initializing";
  job.timestamps.started = new Date().toISOString();
  writeJob(jobsDir, job);

  const ctx = {
    cwd: job.cwd || projectRoot,
    jobsDir,
    jobId: job.id,
    messageCount: 0,
    toolCallCount: 0,
    onFileChange(filePath, action) {
      pushTouchedFile(jobsDir, job.id, filePath);
    },
  };

  // Resolve model: task-specified → config default
  let modelName = job.model || "deepseek-v4-flash";
  // Map Reasonix model names to DeepSeek API model names
  if (modelName === "deepseek-v4-flash") modelName = config.modelDefault;
  else if (modelName === "deepseek-v4-pro") modelName = config.modelPro;

  // Build API config
  if (!config.apiKey) {
    job.status = "failed";
    job.phase = "failed";
    job.error = "DEEPSEEK_API_KEY not set. Set environment variable or add to .reasonix/config.toml";
    job.timestamps.completed = new Date().toISOString();
    writeJob(jobsDir, job);
    process.stderr.write(job.error + "\n");
    process.exit(1);
  }

  const apiConfig = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    modelDefault: config.modelDefault,
    modelPro: config.modelPro,
    maxTokens: config.maxTokens,
    maxTokensPro: config.maxTokensPro,
  };

  // Initialize messages
  let messages;

  if (job.history && job.history.length > 0) {
    // Resume: restore saved conversation history
    process.stderr.write(`[reasonix-worker] Resuming job ${job.id} with ${job.history.length} messages\n`);
    messages = [...job.history];

    // Append resume instruction as new user message if present
    if (job.resumeInstruction) {
      messages.push({ role: "user", content: job.resumeInstruction });
    }
  } else {
    // Fresh task: build context-aware user prompt
    const contextLines = [
      `## 上下文`,
      `- 当前时间: ${new Date().toISOString()}`,
      `- 项目根目录: ${ctx.cwd}`,
      `- 使用模型: ${modelName}`,
      `- 任务 ID: ${job.id}`,
      ``,
      `## 任务`,
      job.prompt || "(no prompt)",
    ];

    messages = [
      { role: "system", content: REASONIX_SYSTEM_PROMPT },
      { role: "user", content: contextLines.join("\n") },
    ];
  }

  // Tool filtering — review mode is read-only
  const mode = job.mode || opts.mode || "task";
  let activeToolDefs = TOOL_DEFINITIONS;
  let activeToolNames = TOOL_NAMES;

  if (mode === "review") {
    const WRITE_TOOLS = new Set([
      "write_file", "edit_file", "multi_edit",
      "create_directory", "move_file", "copy_file",
      "delete_file", "delete_directory",
    ]);
    activeToolDefs = TOOL_DEFINITIONS.filter((t) => !WRITE_TOOLS.has(t.name));
    activeToolNames = activeToolDefs.map((t) => t.name);
    process.stderr.write(`[reasonix-worker] Review mode — ${activeToolDefs.length}/${TOOL_DEFINITIONS.length} tools (write filtered)\n`);

    // Append read-only constraint to last message (first message is system prompt)
    messages[0].content += "\n\n## 审查模式约束\n- 当前处于只读审查模式。你不能修改任何文件。\n- 只能使用 read/search/run_command 等读取工具。\n- 你的任务是审查代码变更的质量和风险，不是修复问题。\n- 不要建议具体的修复代码，只指出问题和风险。";
  }

  if (mode === "subtask") {
    // Subtask: scope-limiting constraint appended to system prompt
    messages[0].content += "\n\n## 子任务约束\n- 你是一个子任务 Worker，只负责解决当前子任务。\n- 不要修改任务描述范围之外的文件。\n- 完成后直接输出结果和总结，不要继续探索或扩展范围。\n- 如果子任务可以拆分为更小的独立子任务，可以调用 delegate_task。";
  }

  // Execution loop
  job.phase = "executing";
  writeJob(jobsDir, job);

  const touchedFiles = [];
  const maxIterations = config.maxToolIterations || 50;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    ctx.messageCount = messages.length;
    writeJobProgress(jobsDir, job.id, { pct: Math.round((iteration / maxIterations) * 80) });

    // Call DeepSeek API
    let response;
    try {
      response = await callDeepSeek(apiConfig, messages, activeToolDefs, {
        model: modelName,
      });
    } catch (err) {
      job.status = "failed";
      job.phase = "failed";
      job.error = err.message;
      job.timestamps.completed = new Date().toISOString();
      job.result = buildResult(messages, touchedFiles);
      writeJob(jobsDir, job);
      process.stderr.write(`API error: ${err.message}\n`);
      process.exit(1);
    }

    const choice = response.choices?.[0];
    if (!choice) {
      job.status = "failed";
      job.phase = "failed";
      job.error = "Empty API response";
      job.timestamps.completed = new Date().toISOString();
      writeJob(jobsDir, job);
      process.exit(1);
    }

    const msg = choice.message;

    // If the AI wants to call tools, execute them
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      // Add assistant message with tool calls
      const assistantMsg = {
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      };
      messages.push(assistantMsg);

      // Execute each tool call
      for (const tc of msg.tool_calls) {
        const toolResult = executeToolCall(tc, ctx);
        messages.push(toolResult);

        // Track touched files from write/edit operations
        if (["write_file", "edit_file", "multi_edit"].includes(tc.function.name)) {
          try {
            const args = JSON.parse(tc.function.arguments);
            if (args.path) touchedFiles.push(args.path);
            if (args.edits) args.edits.forEach((e) => touchedFiles.push(e.path));
          } catch { /* ignore */ }
        }
      }

      // Save full conversation history for resume support
      job.history = messages.map((m) => {
        // Deep-copy tool_calls arrays to avoid mutation
        if (m.tool_calls) {
          return { ...m, tool_calls: m.tool_calls.map((tc) => ({ ...tc, function: { ...tc.function } })) };
        }
        return { ...m };
      });

      // Mark still running
      writeJobProgress(jobsDir, job.id, {
        pct: Math.round((iteration / maxIterations) * 80),
        toolCallsCount: ctx.toolCallCount,
      });
    } else {
      // AI finished — no more tool calls
      messages.push({ role: "assistant", content: msg.content || "" });

      // Save final history for resume
      job.history = messages.map((m) => {
        if (m.tool_calls) {
          return { ...m, tool_calls: m.tool_calls.map((tc) => ({ ...tc, function: { ...tc.function } })) };
        }
        return { ...m };
      });

      // Build and write final result
      job.status = "completed";
      job.phase = "done";
      job.timestamps.completed = new Date().toISOString();
      job.result = buildResult(messages, touchedFiles);

      // Update progress to 100%
      job.progress.pct = 100;
      job.progress.currentAction = "Completed";
      job.progress.touchedFiles = [...new Set([...touchedFiles, ...(job.progress.touchedFiles || [])])];

      writeJob(jobsDir, job);
      process.stdout.write(JSON.stringify({ status: "completed", jobId: job.id }) + "\n");
      process.exit(0);
    }
  }

  // Save history even on forced completion
  job.history = messages.map((m) => {
    if (m.tool_calls) {
      return { ...m, tool_calls: m.tool_calls.map((tc) => ({ ...tc, function: { ...tc.function } })) };
    }
    return { ...m };
  });

  // Hit max iterations — force complete
  job.status = "completed";
  job.phase = "done(max-iterations)";
  job.timestamps.completed = new Date().toISOString();
  job.result = buildResult(messages, touchedFiles);
  job.progress.pct = 100;
  job.progress.currentAction = "Completed (reached max iterations)";
  writeJob(jobsDir, job);
  process.stdout.write(JSON.stringify({ status: "completed(max-iterations)", jobId: job.id }) + "\n");
}

main().catch((err) => {
  process.stderr.write(`Worker fatal: ${err.message}\n`);
  process.exit(1);
});
