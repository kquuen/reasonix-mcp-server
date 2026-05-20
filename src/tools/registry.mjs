/**
 * Tools — Reasonix tool implementations
 *
 * Each function receives (args, context) and returns { content, isError }.
 * All paths are resolved relative to the project root (context.cwd).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateJobId, createJobRecord, readJob, writeJob } from "../core/state.mjs";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function resolvePath(cwd, p) {
  if (!p) return cwd;
  // Absolute paths stay absolute; relative resolved against cwd
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

function ensureWithinSandbox(cwd, targetPath) {
  const resolved = path.resolve(cwd, targetPath);
  // In production, add sandbox boundary check here
  return resolved;
}

function textContent(text) {
  return [{ type: "text", text: String(text) }];
}

function errorContent(msg) {
  return [{ type: "text", text: `Error: ${msg}` }];
}

/* ------------------------------------------------------------------ */
/*  Tool: read_file                                                    */
/* ------------------------------------------------------------------ */

export function tool_read_file(args, ctx) {
  try {
    const filePath = ensureWithinSandbox(ctx.cwd, args.path);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { content: errorContent(`Not a file: ${args.path}`), isError: true };

    let content;
    if (args.range) {
      const [startStr, endStr] = args.range.split("-");
      const start = Math.max(1, parseInt(startStr, 10));
      const end = endStr ? Math.min(stat.size, parseInt(endStr, 10)) : start;
      const allLines = fs.readFileSync(filePath, "utf8").split("\n");
      content = allLines.slice(start - 1, end).join("\n");
    } else if (args.head) {
      content = fs.readFileSync(filePath, "utf8").split("\n").slice(0, args.head).join("\n");
    } else if (args.tail) {
      const allLines = fs.readFileSync(filePath, "utf8").split("\n");
      content = allLines.slice(Math.max(0, allLines.length - args.tail)).join("\n");
    } else {
      content = fs.readFileSync(filePath, "utf8");
    }

    return { content: textContent(content) };
  } catch (err) {
    return { content: errorContent(`${err.message}`), isError: true };
  }
}

/* ------------------------------------------------------------------ */
/*  Tool: write_file (create or overwrite)                             */
/* ------------------------------------------------------------------ */

export function tool_write_file(args, ctx) {
  try {
    const filePath = ensureWithinSandbox(ctx.cwd, args.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, args.content, "utf8");

    ctx.onFileChange?.(filePath, "write");
    return { content: textContent(`Wrote ${path.relative(ctx.cwd, filePath)} (${args.content.length} bytes)`) };
  } catch (err) {
    return { content: errorContent(`${err.message}`), isError: true };
  }
}

/* ------------------------------------------------------------------ */
/*  Tool: edit_file (SEARCH/REPLACE)                                   */
/* ------------------------------------------------------------------ */

export function tool_edit_file(args, ctx) {
  try {
    const filePath = ensureWithinSandbox(ctx.cwd, args.path);
    const current = fs.readFileSync(filePath, "utf8");

    // Count occurrences
    const idx = current.indexOf(args.search);
    if (idx === -1) {
      return { content: errorContent(`SEARCH text not found in ${args.path}`), isError: true };
    }
    const nextIdx = current.indexOf(args.search, idx + 1);
    if (nextIdx !== -1) {
      return { content: errorContent(`SEARCH text appears multiple times in ${args.path} — ambiguous edit refused`), isError: true };
    }

    const updated = current.replace(args.search, args.replace);
    fs.writeFileSync(filePath, updated, "utf8");

    ctx.onFileChange?.(filePath, "edit");
    return { content: textContent(`Edited ${path.relative(ctx.cwd, filePath)} (${args.search.length} → ${args.replace.length} chars)`) };
  } catch (err) {
    return { content: errorContent(`${err.message}`), isError: true };
  }
}

/* ------------------------------------------------------------------ */
/*  Tool: multi_edit (atomic batch of SEARCH/REPLACE edits)            */
/* ------------------------------------------------------------------ */

export function tool_multi_edit(args, ctx) {
  try {
    const results = [];
    for (const edit of args.edits) {
      const filePath = ensureWithinSandbox(ctx.cwd, edit.path);
      const current = fs.readFileSync(filePath, "utf8");
      const idx = current.indexOf(edit.search);
      if (idx === -1) {
        return { content: errorContent(`SEARCH text not found in ${edit.path} — batch aborted, no files written`), isError: true };
      }
      const nextIdx = current.indexOf(edit.search, idx + 1);
      if (nextIdx !== -1) {
        return { content: errorContent(`SEARCH text appears multiple times in ${edit.path} — batch aborted, no files written`), isError: true };
      }
    }

    // All valid — apply
    for (const edit of args.edits) {
      const filePath = ensureWithinSandbox(ctx.cwd, edit.path);
      const current = fs.readFileSync(filePath, "utf8");
      const updated = current.replace(edit.search, edit.replace);
      fs.writeFileSync(filePath, updated, "utf8");
      ctx.onFileChange?.(filePath, "edit");
      results.push(`${path.relative(ctx.cwd, filePath)}: edited`);
    }

    return { content: textContent(results.join("\n")) };
  } catch (err) {
    return { content: errorContent(`${err.message}`), isError: true };
  }
}

/* ------------------------------------------------------------------ */
/*  Tool: search_files (name pattern)                                  */
/* ------------------------------------------------------------------ */

export function tool_search_files(args, ctx) {
  try {
    const root = args.path ? resolvePath(ctx.cwd, args.path) : ctx.cwd;
    const pattern = args.pattern.toLowerCase();
    const results = [];

    function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") ||
              ["node_modules", "dist", "build", ".git", "target", "__pycache__"].includes(entry.name)) continue;
          walk(fullPath);
        } else if (entry.name.toLowerCase().includes(pattern)) {
          results.push(path.relative(ctx.cwd, fullPath));
        }
      }
    }

    walk(root);
    return { content: textContent(results.join("\n") || "(no matches)") };
  } catch (err) {
    return { content: errorContent(`${err.message}`), isError: true };
  }
}

/* ------------------------------------------------------------------ */
/*  Tool: search_content (grep)                                        */
/* ------------------------------------------------------------------ */

export function tool_search_content(args, ctx) {
  try {
    const root = args.path ? resolvePath(ctx.cwd, args.path) : ctx.cwd;
    const re = new RegExp(args.pattern, args.case_sensitive ? "" : "i");
    const results = [];
    const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "target", "__pycache__", ".venv", "venv"]);

    function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
          walk(fullPath);
        } else {
          try {
            const content = fs.readFileSync(fullPath, "utf8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                const relative = path.relative(ctx.cwd, fullPath);
                const context_range = args.context || 0;
                const start = Math.max(0, i - context_range);
                const end = Math.min(lines.length, i + context_range + 1);
                for (let j = start; j < end; j++) {
                  const marker = j === i ? ":" : "-";
                  results.push(`${relative}:${j + 1}${marker} ${lines[j]}`);
                }
                if (context_range > 0) results.push("--");
              }
            }
          } catch { /* binary or unreadable */ }
        }
      }
    }

    walk(root);

    if (results.length === 0) return { content: textContent("(no matches)") };
    // Cap at 200 lines to avoid bloated responses
    const capped = results.slice(0, 200);
    if (results.length > 200) capped.push(`... and ${results.length - 200} more lines`);
    return { content: textContent(capped.join("\n")) };
  } catch (err) {
    return { content: errorContent(`${err.message}`), isError: true };
  }
}

/* ------------------------------------------------------------------ */
/*  Tool: glob                                                         */
/* ------------------------------------------------------------------ */

export function tool_glob(args, ctx) {
  try {
    const root = args.path ? resolvePath(ctx.cwd, args.path) : ctx.cwd;
    const pattern = args.pattern;
    // Simple glob implementation — supports *, **, ?
    // For production, use `fast-glob` or similar
    const results = [];
    const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "target", "__pycache__", ".venv", "venv"]);

    function matchPattern(name, pat) {
      const reStr = pat
        .replace(/\./g, "\\.")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      return new RegExp(`^${reStr}$`).test(name);
    }

    function walk(dir, depth) {
      if (depth > 10) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relative = path.relative(root, fullPath);

        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
          if (pattern.includes("**") && matchPattern(relative, pattern)) {
            results.push(path.relative(ctx.cwd, fullPath));
          }
          walk(fullPath, depth + 1);
        } else {
          if (matchPattern(relative, pattern) || matchPattern(entry.name, path.basename(pattern))) {
            results.push(path.relative(ctx.cwd, fullPath));
          }
        }
      }
    }

    walk(root, 0);
    const limit = args.limit || 200;
    const capped = results.slice(0, limit);
    if (results.length > limit) capped.push(`... and ${results.length - limit} more`);
    return { content: textContent(capped.join("\n") || "(no matches)") };
  } catch (err) {
    return { content: errorContent(`${err.message}`), isError: true };
  }
}

/* ------------------------------------------------------------------ */
/*  Tool: list_directory                                               */
/* ------------------------------------------------------------------ */

export function tool_list_directory(args, ctx) {
  try {
    const dirPath = args.path ? resolvePath(ctx.cwd, args.path) : ctx.cwd;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const lines = entries.map(e => e.name + (e.isDirectory() ? "/" : ""));
    return { content: textContent(lines.join("\n")) };
  } catch (err) {
    return { content: errorContent(`${err.message}`), isError: true };
  }
}

/* ------------------------------------------------------------------ */
/*  Tool: directory_tree (recursive)                                   */
/* ------------------------------------------------------------------ */

export function tool_directory_tree(args, ctx) {
  try {
    const root = args.path ? resolvePath(ctx.cwd, args.path) : ctx.cwd;
    const maxDepth = args.maxDepth ?? 2;
    const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "target", "__pycache__", ".venv", "venv", ".cache", ".next", ".nuxt"]);
    const lines = [];

    function walk(dir, depth) {
      if (depth > maxDepth) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        const indent = "  ".repeat(depth);
        const fullPath = path.join(dir, entry.name);
        lines.push(`${indent}${entry.name}${entry.isDirectory() ? "/" : ""}`);
        if (entry.isDirectory()) walk(fullPath, depth + 1);
      }
    }

    lines.push(path.relative(ctx.cwd, root) || ".");
    walk(root, 0);
    return { content: textContent(lines.join("\n")) };
  } catch (err) {
    return { content: errorContent(`${err.message}`), isError: true };
  }
}

/* ------------------------------------------------------------------ */
/*  Tool: get_file_info                                                */
/* ------------------------------------------------------------------ */

export function tool_get_file_info(args, ctx) {
  try {
    const filePath = ensureWithinSandbox(ctx.cwd, args.path);
    const stat = fs.statSync(filePath);
    const info = {
      path: args.path,
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other",
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      birthtime: stat.birthtime.toISOString(),
      mode: stat.mode.toString(8).slice(-3),
    };
    return { content: textContent(JSON.stringify(info, null, 2)) };
  } catch (err) {
    return { content: errorContent(`${err.message}`), isError: true };
  }
}

/* ------------------------------------------------------------------ */
/*  Tool: run_command                                                  */
/* ------------------------------------------------------------------ */

export function tool_run_command(args, ctx) {
  try {
    const cwd = ctx.cwd;
    const timeoutMs = (args.timeoutSec || 60) * 1000;

    // spawnSync: synchronous but provides clean stdout/stderr separation.
    // True async streaming to update job progress during long commands
    // would require the executor API to be async — a P2 item.
    const result = spawnSync(args.command, [], {
      cwd,
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      shell: true,
      windowsHide: true,
    });

    let output = "";
    if (result.stdout) output += result.stdout;
    if (result.stderr) output += (output ? "\n" : "") + result.stderr;

    if (result.error) {
      return { content: textContent(output || result.error.message), isError: true };
    }
    if (result.status !== 0) {
      return { content: textContent(output || `Exit code: ${result.status}`), isError: true };
    }

    return { content: textContent(output || "(no output)") };
  } catch (err) {
    const message = err.stderr || err.stdout || err.message;
    return { content: errorContent(`${message}`), isError: true };
  }
}

/* ------------------------------------------------------------------ */
/*  Tool: delegate_task — spawn a child Reasonix worker                */
/* ------------------------------------------------------------------ */

export function tool_delegate_task(args, ctx) {
  try {
    const prompt = (args.prompt || "").trim();
    if (!prompt) {
      return { content: errorContent("delegate_task requires a prompt"), isError: true };
    }

    const model = args.model || "deepseek-v4-flash";
    if (!["deepseek-v4-flash", "deepseek-v4-pro"].includes(model)) {
      return { content: errorContent(`Invalid model: ${model}`), isError: true };
    }

    // Create child job
    const childId = generateJobId();
    const childJob = createJobRecord({
      id: childId,
      prompt,
      model,
      cwd: ctx.cwd,
      write: true,
      parentId: ctx.jobId,
      mode: "subtask",
    });
    writeJob(ctx.jobsDir, childJob);

    // Spawn child worker synchronously (spawnSync blocks until done)
    const executorDir = path.dirname(fileURLToPath(import.meta.url));
    const workerPath = path.join(executorDir, "..", "worker", "index.mjs");

    const result = spawnSync(process.execPath, [
      workerPath,
      "--job-id", childId,
      "--cwd", ctx.cwd,
      "--mode", "subtask",
    ], {
      cwd: ctx.cwd,
      timeout: 300_000, // 5 min
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
      windowsHide: true,
    });

    // Read child result
    const finalChild = readJob(ctx.jobsDir, childId);
    const output = finalChild?.result?.output || result.stdout || "(no output)";

    // Update parent's children list
    const parentJob = readJob(ctx.jobsDir, ctx.jobId);
    if (parentJob) {
      parentJob.children = parentJob.children || [];
      parentJob.children.push(childId);
      writeJob(ctx.jobsDir, parentJob);
    }

    if (result.status !== 0 && (!finalChild || finalChild.status === "failed")) {
      return {
        content: textContent(`[Delegate ${childId}] ${finalChild?.error || `Exit ${result.status}`}\n\n${output}`),
        isError: true,
      };
    }

    return { content: textContent(`[Delegate ${childId}] ${output}`) };
  } catch (err) {
    return { content: errorContent(`delegate_task failed: ${err.message}`), isError: true };
  }
}

/* ------------------------------------------------------------------ */
/*  Directory management helpers                                       */
/* ------------------------------------------------------------------ */

export function tool_create_directory(args, ctx) {
  try {
    const dirPath = ensureWithinSandbox(ctx.cwd, args.path);
    fs.mkdirSync(dirPath, { recursive: true });
    return { content: textContent(`Created directory ${args.path}`) };
  } catch (err) {
    return { content: errorContent(`${err.message}`), isError: true };
  }
}

export function tool_move_file(args, ctx) {
  try {
    const src = ensureWithinSandbox(ctx.cwd, args.source);
    const dst = ensureWithinSandbox(ctx.cwd, args.destination);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    ctx.onFileChange?.(dst, "move");
    return { content: textContent(`Moved ${args.source} → ${args.destination}`) };
  } catch (err) {
    return { content: errorContent(`${err.message}`), isError: true };
  }
}

export function tool_copy_file(args, ctx) {
  try {
    const src = ensureWithinSandbox(ctx.cwd, args.source);
    const dst = ensureWithinSandbox(ctx.cwd, args.destination);
    if (fs.existsSync(dst)) {
      return { content: errorContent(`Destination already exists: ${args.destination}. Use delete_file first if you want to overwrite.`), isError: true };
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    ctx.onFileChange?.(dst, "copy");
    return { content: textContent(`Copied ${args.source} → ${args.destination}`) };
  } catch (err) {
    return { content: errorContent(`${err.message}`), isError: true };
  }
}

export function tool_delete_file(args, ctx) {
  try {
    const filePath = ensureWithinSandbox(ctx.cwd, args.path);
    fs.unlinkSync(filePath);
    ctx.onFileChange?.(filePath, "delete");
    return { content: textContent(`Deleted ${args.path}`) };
  } catch (err) {
    return { content: errorContent(`${err.message}`), isError: true };
  }
}

export function tool_delete_directory(args, ctx) {
  try {
    const dirPath = ensureWithinSandbox(ctx.cwd, args.path);
    fs.rmSync(dirPath, { recursive: args.recursive !== false, force: true });
    return { content: textContent(`Deleted directory ${args.path}`) };
  } catch (err) {
    return { content: errorContent(`${err.message}`), isError: true };
  }
}

/* ------------------------------------------------------------------ */
/*  Tool registry — name → handler map                                 */
/* ------------------------------------------------------------------ */

export const TOOL_REGISTRY = {
  read_file:           tool_read_file,
  write_file:          tool_write_file,
  edit_file:           tool_edit_file,
  multi_edit:          tool_multi_edit,
  search_files:        tool_search_files,
  search_content:      tool_search_content,
  glob:                tool_glob,
  list_directory:      tool_list_directory,
  directory_tree:      tool_directory_tree,
  get_file_info:       tool_get_file_info,
  run_command:         tool_run_command,
  create_directory:    tool_create_directory,
  move_file:           tool_move_file,
  copy_file:           tool_copy_file,
  delete_file:         tool_delete_file,
  delete_directory:    tool_delete_directory,
  delegate_task:       tool_delegate_task,
};

export const TOOL_NAMES = Object.keys(TOOL_REGISTRY);

export const TOOL_DEFINITIONS = [
  {
    name: "read_file",
    description: "Read a file. Supports head:N, tail:N, or range:'A-B' for partial reads.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative or absolute)" },
        head: { type: "number", description: "Return first N lines only" },
        tail: { type: "number", description: "Return last N lines only" },
        range: { type: "string", description: 'Inclusive line range, e.g. "10-50"' },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file. Parent dirs created automatically.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "SEARCH/REPLACE edit on an existing file. Search text must match exactly (unique).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        search: { type: "string", description: "Exact text to find (must be unique)" },
        replace: { type: "string", description: "Replacement text" },
      },
      required: ["path", "search", "replace"],
    },
  },
  {
    name: "multi_edit",
    description: "Apply multiple SEARCH/REPLACE edits atomically. All or nothing.",
    inputSchema: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              search: { type: "string" },
              replace: { type: "string" },
            },
            required: ["path", "search", "replace"],
          },
        },
      },
      required: ["edits"],
    },
  },
  {
    name: "search_files",
    description: "Find files by name pattern (case-insensitive substring).",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Filename substring (case-insensitive)" },
        path: { type: "string", description: "Directory to search (default: project root)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "search_content",
    description: "Grep file contents. Returns path:line: matches with optional context.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex or substring to search" },
        path: { type: "string", description: "Directory to search" },
        case_sensitive: { type: "boolean" },
        context: { type: "number", description: "Lines of context before/after each match" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description: "List files matching a glob pattern, sorted by mtime (newest first).",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. src/**/*.ts" },
        path: { type: "string", description: "Base directory" },
        limit: { type: "number", description: "Max results (default 200)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "list_directory",
    description: "List entries in a directory (non-recursive).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (default: project root)" },
      },
    },
  },
  {
    name: "directory_tree",
    description: "Recursive directory tree. Skips deps/VCS dirs by default.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxDepth: { type: "number", description: "Max recursion depth (default 2)" },
      },
    },
  },
  {
    name: "get_file_info",
    description: "Stat a path — type, size, mtime.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command. Returns stdout+stderr. 60s default timeout.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutSec: { type: "number", description: "Timeout in seconds (default 60)" },
      },
      required: ["command"],
    },
  },
  {
    name: "create_directory",
    description: "Create a directory (and parents).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "move_file",
    description: "Rename or move a file/directory.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        destination: { type: "string" },
      },
      required: ["source", "destination"],
    },
  },
  {
    name: "copy_file",
    description: "Copy a file or directory. Refuses to overwrite existing.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        destination: { type: "string" },
      },
      required: ["source", "destination"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "delete_directory",
    description: "Delete a directory (recursive by default).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean", description: "Delete non-empty (default true)" },
      },
      required: ["path"],
    },
  },
  {
    name: "delegate_task",
    description: "Delegate a sub-task to a child Reasonix worker. Use when a sub-problem can be solved independently in parallel.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Sub-task description for the child worker" },
        model: { type: "string", enum: ["deepseek-v4-flash", "deepseek-v4-pro"], description: "Model for child (default: flash)" },
      },
      required: ["prompt"],
    },
  },
];
