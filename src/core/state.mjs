/**
 * State — Job state persistence for Reasonix MCP Server
 *
 * Thread-safe via atomic writes (.tmp → rename).
 * Each job is a JSON file at <jobsDir>/<jobId>.json.
 */
import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                  */
/* ------------------------------------------------------------------ */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath, data) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

/* ------------------------------------------------------------------ */
/*  Job ID generation                                                 */
/* ------------------------------------------------------------------ */

let _counter = 0;

export function generateJobId() {
  _counter += 1;
  const ts = Date.now().toString(36);
  const seq = _counter.toString(36).padStart(4, "0");
  const rand = Math.random().toString(36).slice(2, 5);
  return `task-${ts}-${seq}-${rand}`;
}

/* ------------------------------------------------------------------ */
/*  Job record helpers                                                */
/* ------------------------------------------------------------------ */

export function createJobRecord({
  id,
  prompt,
  model,
  cwd,
  write,
  history,              // Array<{role, content, tool_calls?}> — persisted conversation for resume
  resumeInstruction,    // string — extra instruction appended on resume
  parentId,             // string — parent job ID (for delegate sub-tasks)
  mode,                 // "task" | "review" | "subtask"
}) {
  return {
    id,
    prompt: prompt || "",
    model: model || "deepseek-v4-flash",
    cwd: cwd || process.cwd(),
    write: write !== false,
    mode: mode || "task",

    status: "queued",        // queued → running → completed | failed | cancelled
    phase: "queued",         // queued | initializing | executing | reviewing | done

    progress: {
      pct: 0,
      currentAction: "",
      touchedFiles: [],
      messagesCount: 0,
      toolCallsCount: 0,
    },

    timestamps: {
      created: new Date().toISOString(),
      started: null,
      completed: null,
    },

    // --- Resume support ---
    history: history || [],           // full conversation messages array
    resumeInstruction: resumeInstruction || null,

    // --- Delegate support ---
    parentId: parentId || null,
    children: [],                     // child job IDs

    result: null,            // populated on completion
    error: null,             // populated on failure
  };
}

/* ------------------------------------------------------------------ */
/*  Read / Write / List                                               */
/* ------------------------------------------------------------------ */

export function readJob(jobsDir, jobId) {
  const filePath = path.join(jobsDir, `${jobId}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function writeJob(jobsDir, job) {
  ensureDir(jobsDir);
  const filePath = path.join(jobsDir, `${job.id}.json`);
  atomicWrite(filePath, job);
}

export function writeJobField(jobsDir, jobId, key, value) {
  const job = readJob(jobsDir, jobId);
  if (!job) return;
  job[key] = value;
  writeJob(jobsDir, job);
}

export function writeJobProgress(jobsDir, jobId, patch) {
  const job = readJob(jobsDir, jobId);
  if (!job) return;
  Object.assign(job.progress, patch);
  writeJob(jobsDir, job);
}

export function pushTouchedFile(jobsDir, jobId, filePath) {
  const job = readJob(jobsDir, jobId);
  if (!job) return;
  if (!job.progress.touchedFiles.includes(filePath)) {
    job.progress.touchedFiles.push(filePath);
  }
  writeJob(jobsDir, job);
}

export function listJobs(jobsDir) {
  ensureDir(jobsDir);
  const files = fs.readdirSync(jobsDir);
  const jobs = [];
  for (const f of files) {
    if (!f.endsWith(".json") || f.includes(".tmp")) continue;
    try {
      const data = fs.readFileSync(path.join(jobsDir, f), "utf8");
      jobs.push(JSON.parse(data));
    } catch {
      // skip corrupted files
    }
  }
  return jobs.sort((a, b) => {
    return (b.timestamps?.created || "").localeCompare(a.timestamps?.created || "");
  });
}

export function deleteJob(jobsDir, jobId) {
  const filePath = path.join(jobsDir, `${jobId}.json`);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore if already gone
  }
}
