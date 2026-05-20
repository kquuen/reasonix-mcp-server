#!/usr/bin/env node

/**
 * Reasonix MCP Server — stdio transport
 *
 * Exposes 6 MCP tools for any MCP-compatible host agent:
 *   - reasonix_start_task    → { job_id }   (async, returns immediately)
 *   - reasonix_get_status    → { phase, progress, touchedFiles, ... }
 *   - reasonix_get_result    → { output, touchedFiles, ... }
 *   - reasonix_cancel_task   → { status: "cancelled" }
 *   - reasonix_review_changes → { verdict: "ALLOW" | "BLOCK" }
 *   - reasonix_resume_task   → { job_id } (continues from history)
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (MCP stdio transport)
 * Job state: .reasonix/jobs/<jobId>.json (persisted, survives restart)
 *
 * Usage: node src/server/index.mjs
 *   (Host agent starts this as a subprocess via MCP stdio)
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, execSync } from "node:child_process";

import { fileURLToPath } from "node:url";
import { loadConfig } from "../core/config.mjs";
import { buildAdversarialReviewPrompt, parseReviewOutput } from "../core/review.mjs";
import {
  generateJobId,
  createJobRecord,
  readJob,
  writeJob,
  listJobs,
} from "../core/state.mjs";

/* ------------------------------------------------------------------ */
/*  Logger                                                             */
/* ------------------------------------------------------------------ */

const LOG_PREFIX = "[reasonix-mcp]";
function log(...args) {
  // Stderr — must not pollute MCP stdout channel
  process.stderr.write(`${LOG_PREFIX} ${args.join(" ")}\n`);
}

/* ------------------------------------------------------------------ */
/*  MCP JSON-RPC helpers                                              */
/* ------------------------------------------------------------------ */

function sendMessage(msg) {
  const line = JSON.stringify(msg);
  process.stdout.write(line + "\n");
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const err = { code, message };
  if (data) err.data = data;
  sendMessage({ jsonrpc: "2.0", id, error: err });
}

function sendNotification(method, params) {
  sendMessage({ jsonrpc: "2.0", method, params });
}

/* ------------------------------------------------------------------ */
/*  Tool definitions (MCP schema)                                     */
/* ------------------------------------------------------------------ */

const MCP_TOOLS = [
  {
    name: "reasonix_start_task",
    description: `Start a Reasonix coding task in the background.

Use this when you need Reasonix to investigate, implement, fix, or refactor code.
The task runs asynchronously — poll with reasonix_get_status, collect with reasonix_get_result.

The host agent determines the model tier:
  - deepseek-v4-flash: for simple/well-scoped tasks
  - deepseek-v4-pro: for complex cross-file tasks needing stronger reasoning`,
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Task description for Reasonix to execute. Be specific about files and desired outcome.",
        },
        model: {
          type: "string",
          enum: ["deepseek-v4-flash", "deepseek-v4-pro"],
          description:
            "Model tier. The host agent judges task complexity and chooses. flash for simple, pro for complex.",
        },
        cwd: {
          type: "string",
          description: "Working directory (default: project root)",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "reasonix_get_status",
    description: "Get real-time progress of a running Reasonix task.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Job ID returned by reasonix_start_task",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "reasonix_get_result",
    description: "Get the final result of a completed Reasonix task.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Job ID returned by reasonix_start_task",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "reasonix_review_changes",
    description: "Adversarial review of current uncommitted code changes before ending the session. Returns ALLOW or BLOCK with findings.",
    inputSchema: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          description: "Optional focus: 'race conditions', 'auth', 'data loss', 'rollback safety', etc.",
        },
      },
    },
  },
  {
    name: "reasonix_cancel_task",
    description: "Cancel a running Reasonix task. Kills the worker process.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Job ID to cancel",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "reasonix_resume_task",
    description: "Continue a previous Reasonix task from where it left off. Preserves full conversation context including tool calls and results.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Previous job ID to resume (must be completed/failed)",
        },
        instruction: {
          type: "string",
          description: "Additional instruction for this continuation, e.g. 'apply the top fix', 'dig deeper'",
        },
        model: {
          type: "string",
          enum: ["deepseek-v4-flash", "deepseek-v4-pro"],
          description: "Model to use (default: same as original task)",
        },
      },
      required: ["job_id"],
    },
  },
];

/* ------------------------------------------------------------------ */
/*  Active worker tracking                                            */
/* ------------------------------------------------------------------ */

const activeWorkers = new Map(); // jobId → ChildProcess

/* ------------------------------------------------------------------ */
/*  Global worker process terminator (platform-aware)                 */
/* ------------------------------------------------------------------ */

function terminateWorker(child) {
  if (!child || child.killed) return;

  if (process.platform === "win32") {
    // Windows: SIGTERM is unreliable. Use taskkill /T (tree kill) /F (force).
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch { /* process already gone */ }
  } else {
    // POSIX: SIGTERM first, then SIGKILL after 3s grace
    try { child.kill("SIGTERM"); } catch { /* ok */ }
    setTimeout(() => {
      if (!child.killed) {
        try { child.kill("SIGKILL"); } catch { /* ok */ }
      }
    }, 3000);
  }
}

/* ------------------------------------------------------------------ */
/*  Tool handlers                                                      */
/* ------------------------------------------------------------------ */

function handleStartTask(args, config) {
  const prompt = (args.prompt || "").trim();
  if (!prompt) {
    return { error: "prompt is required", isError: true };
  }

  const jobId = generateJobId();
  const model = args.model || "deepseek-v4-flash";
  const cwd = args.cwd || process.cwd();

  // Validate model
  if (!["deepseek-v4-flash", "deepseek-v4-pro"].includes(model)) {
    return { error: `Invalid model: ${model}. Use deepseek-v4-flash or deepseek-v4-pro.`, isError: true };
  }

  // Create job record
  const job = createJobRecord({
    id: jobId,
    prompt,
    model,
    cwd,
    write: true,
  });
  writeJob(config.jobsDir, job);

  // Spawn worker
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(__dirname, "..", "worker", "index.mjs");
  const child = spawn(process.execPath, [workerPath, "--job-id", jobId, "--cwd", cwd, "--jobs-dir", config.jobsDir], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    windowsHide: true,
  });

  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
  });

  child.on("exit", (code) => {
    activeWorkers.delete(jobId);
    const jobRecord = readJob(config.jobsDir, jobId);
    if (jobRecord && (jobRecord.status === "running" || jobRecord.status === "queued")) {
      // Worker exited before marking completion
      jobRecord.status = code === 0 ? "completed" : "failed";
      jobRecord.phase = code === 0 ? "done" : "failed";
      jobRecord.timestamps.completed = new Date().toISOString();
      if (code !== 0 && !jobRecord.error) {
        jobRecord.error = `Worker exited with code ${code}: ${stderrBuf.slice(0, 500)}`;
      }
      writeJob(config.jobsDir, jobRecord);
    }
    log(`Worker ${jobId} exited with code ${code}`);
  });

  child.on("error", (err) => {
    activeWorkers.delete(jobId);
    const jobRecord = readJob(config.jobsDir, jobId);
    if (jobRecord) {
      jobRecord.status = "failed";
      jobRecord.phase = "failed";
      jobRecord.error = `Failed to spawn worker: ${err.message}`;
      jobRecord.timestamps.completed = new Date().toISOString();
      writeJob(config.jobsDir, jobRecord);
    }
  });

  activeWorkers.set(jobId, child);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          job_id: jobId,
          status: "queued",
          model,
          summary: prompt.length > 80 ? prompt.slice(0, 77) + "..." : prompt,
        }),
      },
    ],
  };
}

function handleGetStatus(args, config) {
  const jobId = (args.job_id || "").trim();
  if (!jobId) {
    return { error: "job_id is required", isError: true };
  }

  const job = readJob(config.jobsDir, jobId);
  if (!job) {
    return { error: `Job not found: ${jobId}`, isError: true };
  }

  const isRunning = activeWorkers.has(jobId) && job.status === "running";
  const elapsed = job.timestamps.started
    ? Date.now() - new Date(job.timestamps.started).getTime()
    : 0;

  // Recursive child status for delegate tasks
  let children = null;
  if (job.children && job.children.length > 0) {
    children = job.children.map((childId) => {
      const child = readJob(config.jobsDir, childId);
      if (!child) return { job_id: childId, status: "missing" };
      const childRunning = activeWorkers.has(childId) && child.status === "running";
      return {
        job_id: child.id,
        status: childRunning ? "running" : child.status,
        phase: child.phase,
        progress: { pct: child.progress?.pct || 0, touchedFiles: child.progress?.touchedFiles || [] },
      };
    });
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          job_id: job.id,
          status: isRunning ? "running" : job.status,
          phase: job.phase,
          progress: {
            pct: job.progress?.pct || 0,
            currentAction: job.progress?.currentAction || "",
            touchedFiles: job.progress?.touchedFiles || [],
            messagesCount: job.progress?.messagesCount || 0,
            toolCallsCount: job.progress?.toolCallsCount || 0,
          },
          elapsed_ms: elapsed,
          model: job.model,
          parentId: job.parentId || null,
          children: children,
        }),
      },
    ],
  };
}

function handleGetResult(args, config) {
  const jobId = (args.job_id || "").trim();
  if (!jobId) {
    return { error: "job_id is required", isError: true };
  }

  const job = readJob(config.jobsDir, jobId);
  if (!job) {
    return { error: `Job not found: ${jobId}`, isError: true };
  }

  // If job file shows completed/failed/cancelled, return it immediately.
  // (Worker writes the status file before exiting, so the file is authoritative
  //  even if the process hasn't fully torn down yet.)
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "orphaned") {
    // Result is ready — proceed to return it
  } else if (job.status === "running" || job.status === "queued") {
    return {
      error: `Job ${jobId} is still ${job.status}. Use reasonix_get_status first.`,
      isError: true,
    };
  } else {
    return {
      error: `Job ${jobId} has unknown status: ${job.status}`,
      isError: true,
    };
  }

  const result = job.result || {};
  const elapsed = job.timestamps.started && job.timestamps.completed
    ? new Date(job.timestamps.completed).getTime() - new Date(job.timestamps.started).getTime()
    : 0;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          job_id: job.id,
          status: job.status,
          phase: job.phase,
          model: job.model,
          elapsed_ms: elapsed,
          summary: result.output
            ? (result.output.length > 200 ? result.output.slice(0, 197) + "..." : result.output)
            : "(no output)",
          output: result.output || "",
          touchedFiles: result.touchedFiles || [],
          messagesCount: result.messagesCount || 0,
          estimatedTokens: result.estimatedTokens || 0,
          canResume: job.status === "completed" && job.history && job.history.length > 0,
          error: job.error || null,
          completedAt: job.timestamps.completed,
        }),
      },
    ],
  };
}

function handleCancelTask(args, config) {
  const jobId = (args.job_id || "").trim();
  if (!jobId) {
    return { error: "job_id is required", isError: true };
  }

  const child = activeWorkers.get(jobId);
  const job = readJob(config.jobsDir, jobId);

  if (child) {
    terminateWorker(child);
    activeWorkers.delete(jobId);
  }

  if (job) {
    job.status = "cancelled";
    job.phase = "cancelled";
    job.timestamps.completed = new Date().toISOString();
    job.result = job.result || { output: "(cancelled)" };
    writeJob(config.jobsDir, job);
  }

  const elapsed = job?.timestamps?.started
    ? Date.now() - new Date(job.timestamps.started).getTime()
    : 0;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          job_id: jobId,
          status: "cancelled",
          terminated_after_ms: elapsed,
        }),
      },
    ],
  };
}

async function handleReviewChanges(args, config) {
  // 1. Collect git diff
  const cwd = config.projectRoot;
  let diffText = "";
  try {
    diffText = execSync("git diff HEAD && git diff --cached HEAD", {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    try {
      diffText = execSync("git diff HEAD", { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    } catch {
      return {
        content: [{ type: "text", text: JSON.stringify({ verdict: "ALLOW", reason: "Unable to run git diff. Assuming no changes." }) }],
      };
    }
  }

  if (!diffText.trim()) {
    return {
      content: [{ type: "text", text: JSON.stringify({ verdict: "ALLOW", reason: "No code changes to review." }) }],
    };
  }

  // 2. Build adversarial review prompt
  const focus = (args.focus || "").trim();
  const prompt = buildAdversarialReviewPrompt(diffText, focus);

  // 3. Create review job (read-only, pro model)
  const jobId = generateJobId();
  const job = createJobRecord({
    id: jobId,
    prompt,
    model: "deepseek-v4-pro",
    cwd,
    write: false,
    mode: "review",
  });
  writeJob(config.jobsDir, job);

  // 4. Spawn review worker
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(__dirname, "..", "worker", "index.mjs");
  const child = spawn(process.execPath, [workerPath, "--job-id", jobId, "--cwd", cwd, "--jobs-dir", config.jobsDir, "--mode", "review"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    windowsHide: true,
  });

  // 5. Wait for review to complete (synchronous — host is waiting for verdict)
  await new Promise((resolve) => {
    child.on("exit", resolve);
    child.on("error", resolve);
    setTimeout(() => {
      try { terminateWorker(child); } catch {}
      resolve();
    }, 300_000);
  });

  // 6. Read result
  const finalJob = readJob(config.jobsDir, jobId);
  if (!finalJob || finalJob.status !== "completed") {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ verdict: "ALLOW", reason: finalJob?.error || "Review did not complete.", job_id: jobId }),
      }],
    };
  }

  // 7. Parse ALLOW/BLOCK
  const output = finalJob.result?.output || "";
  const parsed = parseReviewOutput(output);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        verdict: parsed.verdict,
        reason: parsed.reason,
        job_id: jobId,
        output: parsed.rawOutput,
      }),
    }],
  };
}

function handleResumeTask(args, config) {
  const prevJobId = (args.job_id || "").trim();
  if (!prevJobId) {
    return { error: "job_id is required", isError: true };
  }

  const prevJob = readJob(config.jobsDir, prevJobId);
  if (!prevJob) {
    return { error: `Previous job not found: ${prevJobId}`, isError: true };
  }

  if (prevJob.status === "running" || prevJob.status === "queued") {
    return { error: `Job ${prevJobId} is still ${prevJob.status}. Wait for it to complete or cancel it first.`, isError: true };
  }

  if (!prevJob.history || prevJob.history.length === 0) {
    return { error: `Job ${prevJobId} has no conversation history to resume from.`, isError: true };
  }

  const instruction = (args.instruction || "").trim() || "Continue from where you left off.";
  const model = args.model || prevJob.model || "deepseek-v4-flash";

  // Build resume instruction
  const resumeInstruction = [
    `## 续跑任务`,
    `- 原任务: ${prevJob.prompt.slice(0, 200)}`,
    `- 原任务状态: ${prevJob.status === "completed" ? "已完成" : "未完成"}`,
    `- 续跑指令: ${instruction}`,
  ].join("\n");

  // Create continuation job
  const newJobId = generateJobId();
  const cwd = prevJob.cwd || config.projectRoot;
  const newJob = createJobRecord({
    id: newJobId,
    prompt: prevJob.prompt,
    model,
    cwd,
    write: true,
    history: prevJob.history || [],
    resumeInstruction,
  });
  writeJob(config.jobsDir, newJob);

  // Spawn worker
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(__dirname, "..", "worker", "index.mjs");
  const child = spawn(process.execPath, [workerPath, "--job-id", newJobId, "--cwd", cwd, "--jobs-dir", config.jobsDir], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    windowsHide: true,
  });

  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
  });

  child.on("exit", (code) => {
    activeWorkers.delete(newJobId);
    const jobRecord = readJob(config.jobsDir, newJobId);
    if (jobRecord && (jobRecord.status === "running" || jobRecord.status === "queued")) {
      jobRecord.status = code === 0 ? "completed" : "failed";
      jobRecord.phase = code === 0 ? "done" : "failed";
      jobRecord.timestamps.completed = new Date().toISOString();
      if (code !== 0 && !jobRecord.error) {
        jobRecord.error = `Worker exited with code ${code}: ${stderrBuf.slice(0, 500)}`;
      }
      writeJob(config.jobsDir, jobRecord);
    }
    log(`Resumed worker ${newJobId} exited with code ${code}`);
  });

  child.on("error", (err) => {
    activeWorkers.delete(newJobId);
    const jobRecord = readJob(config.jobsDir, newJobId);
    if (jobRecord) {
      jobRecord.status = "failed";
      jobRecord.phase = "failed";
      jobRecord.error = `Failed to spawn worker: ${err.message}`;
      jobRecord.timestamps.completed = new Date().toISOString();
      writeJob(config.jobsDir, jobRecord);
    }
  });

  activeWorkers.set(newJobId, child);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          job_id: newJobId,
          status: "queued",
          model,
          resumed_from: prevJobId,
          summary: instruction.length > 80 ? instruction.slice(0, 77) + "..." : instruction,
        }),
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  MCP request dispatcher                                            */
/* ------------------------------------------------------------------ */

async function handleRequest(id, method, params, config) {
  switch (method) {
    // --- MCP lifecycle ---
    case "initialize": {
      sendResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}, // we support tools/list and tools/call
        },
        serverInfo: {
          name: "reasonix-mcp-server",
          version: "0.1.0",
        },
      });
      return;
    }

    case "notifications/initialized": {
      // Client confirms initialization — nothing to do
      return;
    }

    case "notifications/cancelled": {
      // Client cancelled a request — nothing to do for now
      return;
    }

    // --- Tools ---
    case "tools/list": {
      sendResult(id, { tools: MCP_TOOLS });
      return;
    }

    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments || {};

      let result;
      switch (toolName) {
        case "reasonix_start_task":
          result = handleStartTask(args, config);
          break;
        case "reasonix_get_status":
          result = handleGetStatus(args, config);
          break;
        case "reasonix_get_result":
          result = handleGetResult(args, config);
          break;
        case "reasonix_cancel_task":
          result = handleCancelTask(args, config);
          break;
        case "reasonix_resume_task":
          result = handleResumeTask(args, config);
          break;
        case "reasonix_review_changes":
          result = await handleReviewChanges(args, config);
          break;
        default:
          sendError(id, -32601, `Unknown tool: ${toolName}`);
          return;
      }

      if (result?.isError) {
        sendResult(id, {
          content: [{ type: "text", text: result.error }],
          isError: true,
        });
      } else {
        sendResult(id, result);
      }
      return;
    }

    // --- Shutdown ---
    case "shutdown": {
      sendResult(id, null);
      return;
    }

    case "exit": {
      // Clean up workers
      for (const [, child] of activeWorkers) terminateWorker(child);
      process.exit(0);
    }

    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Main event loop — read JSON-RPC from stdin                        */
/* ------------------------------------------------------------------ */

function main() {
  const config = loadConfig(process.cwd());

  log(`Starting Reasonix MCP Server v0.1.0`);
  log(`Project root: ${config.projectRoot}`);
  log(`Jobs dir: ${config.jobsDir}`);
  log(`DeepSeek API: ${config.baseUrl}`);
  log(`Waiting for MCP messages on stdin...`);

  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;

    // Process complete lines
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        const { id, method, params } = msg;

        if (id != null) {
          // Request — has id, needs response (await for async tools like review_changes)
          handleRequest(id, method, params, config).catch((err) => {
            log(`Unhandled error in request ${id}: ${err.message}`);
          });
        } else {
          // Notification — no id, fire-and-forget
          handleRequest(null, method, params, config).catch(() => {});
        }
      } catch (err) {
        // Malformed JSON — log and skip
        log(`Parse error: ${err.message}`);
      }
    }
  });

  process.stdin.on("end", () => {
    log("stdin closed. Shutting down.");
    for (const [, child] of activeWorkers) terminateWorker(child);
    process.exit(0);
  });

  // Handle signals
  process.on("SIGINT", () => {
    log("SIGINT received. Cleaning up...");
    for (const [, child] of activeWorkers) terminateWorker(child);
    process.exit(0);
  });

  // Reap orphaned jobs from previous server lifecycle
  const orphanedJobs = listJobs(config.jobsDir).filter(j => j.status === "running" || j.status === "queued");
  for (const orphan of orphanedJobs) {
    orphan.status = "failed";
    orphan.phase = "orphaned";
    orphan.error = "Server restarted while this job was running.";
    orphan.timestamps.completed = orphan.timestamps.completed || new Date().toISOString();
    writeJob(config.jobsDir, orphan);
  }
  if (orphanedJobs.length > 0) {
    log(`Reaped ${orphanedJobs.length} orphaned job(s) from previous session.`);
  }

  process.on("SIGTERM", () => {
    log("SIGTERM received. Cleaning up...");
    for (const [, child] of activeWorkers) terminateWorker(child);
    process.exit(0);
  });
}

main();
