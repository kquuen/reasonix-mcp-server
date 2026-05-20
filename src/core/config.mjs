/**
 * Config — configuration loader for Reasonix MCP Server
 *
 * Load order (later overrides earlier):
 *   1. Defaults
 *   2. TOML config file at <project>/.reasonix/config.toml
 *   3. Environment variables
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ */
/*  Defaults                                                          */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  /* DeepSeek API */
  apiKey: "",
  baseUrl: "https://api.deepseek.com",

  /* Model routing — host agent chooses which model per-task via start_task args */
  modelDefault: "deepseek-chat",
  modelPro: "deepseek-reasoner",

  /* Worker */
  workerTimeoutMs: 300_000,   // 5 min default
  maxToolIterations: 50,       // safety cap on AI→tool loop turns
  maxTokens: 8192,             // flash model max output tokens
  maxTokensPro: 16384,         // pro model max output tokens (more for reasoning)

  /* Job state */
  jobsDir: "",                 // resolved relative to project root

  /* Server */
  serverLogLevel: "info",      // debug | info | warn | error
};

/* ------------------------------------------------------------------ */
/*  Load TOML (minimal — no dependency, only the keys we need)        */
/* ------------------------------------------------------------------ */

function loadToml(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = {};

    let currentSection = "";
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();

      // Skip comments and blanks
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

      // Section header  [section]
      const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        continue;
      }

      // Key = value
      const kvMatch = trimmed.match(/^([^=]+?)\s*=\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        let value = kvMatch[2].trim();

        // Strip quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        } else if (value === "true") {
          value = true;
        } else if (value === "false") {
          value = false;
        } else if (!isNaN(Number(value))) {
          value = Number(value);
        }

        const sectionKey = currentSection ? `${currentSection}.${key}` : key;
        parsed[sectionKey] = value;
      }
    }

    return parsed;
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/*  Resolve config                                                    */
/* ------------------------------------------------------------------ */

function findProjectRoot(startDir) {
  let current = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(current, ".reasonix"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

export function loadConfig(cwd) {
  const projectRoot = findProjectRoot(cwd);
  const config = { ...DEFAULTS };

  // 1. Load TOML from two locations:
  //    a. project root (.reasonix found by walking up from cwd)
  //    b. server-local (.reasonix next to server.mjs)
  const projToml = loadToml(path.join(projectRoot, ".reasonix", "config.toml"));

  // b: server-local TOML — higher priority
  const thisFileDir = path.dirname(fileURLToPath(import.meta.url));
  const serverDir = path.resolve(thisFileDir, "..", ".."); // core/ → ../ = src/ → ../ = root
  const serverToml = loadToml(path.join(serverDir, ".reasonix", "config.toml"));

  // Merge: server-local overrides project-walked
  const toml = { ...projToml, ...serverToml };

  // Map TOML keys to config keys
  if (toml["reasonix.api_key"]) config.apiKey = String(toml["reasonix.api_key"]);
  if (toml["reasonix.base_url"]) config.baseUrl = String(toml["reasonix.base_url"]);
  if (toml["reasonix.model_default"]) config.modelDefault = String(toml["reasonix.model_default"]);
  if (toml["reasonix.model_pro"]) config.modelPro = String(toml["reasonix.model_pro"]);
  if (toml["reasonix.worker_timeout_ms"]) config.workerTimeoutMs = Number(toml["reasonix.worker_timeout_ms"]);
  if (toml["reasonix.max_tokens"]) config.maxTokens = Number(toml["reasonix.max_tokens"]);
  if (toml["reasonix.max_tokens_pro"]) config.maxTokensPro = Number(toml["reasonix.max_tokens_pro"]);
  if (toml["reasonix.server_log_level"]) config.serverLogLevel = String(toml["reasonix.server_log_level"]);

  // 2. Environment variables (override TOML)
  if (process.env.DEEPSEEK_API_KEY) config.apiKey = process.env.DEEPSEEK_API_KEY;
  if (process.env.DEEPSEEK_BASE_URL) config.baseUrl = process.env.DEEPSEEK_BASE_URL;
  if (process.env.REASONIX_LOG_LEVEL) config.serverLogLevel = process.env.REASONIX_LOG_LEVEL;
  if (process.env.REASONIX_WORKER_TIMEOUT) config.workerTimeoutMs = Number(process.env.REASONIX_WORKER_TIMEOUT);

  // 3. Resolve jobs directory
  config.jobsDir = path.join(projectRoot, ".reasonix", "jobs");
  config.projectRoot = projectRoot;

  return config;
}

/**
 * Load runtime-sensitive config (API key, model settings) on first use.
 *
 * Called lazily by handleStartTask — NOT at server startup.
 * This keeps `tools/list` response time < 5ms (no file I/O, no API calls).
 */
export function loadRuntimeConfig(staticConfig) {
  const projectRoot = staticConfig.projectRoot;

  // Re-read TOML for API key (may have been set after server start)
  const projToml = loadToml(path.join(projectRoot, ".reasonix", "config.toml"));

  const thisFileDir = path.dirname(fileURLToPath(import.meta.url));
  const serverDir = path.resolve(thisFileDir, "..", "..");
  const serverToml = loadToml(path.join(serverDir, ".reasonix", "config.toml"));

  const toml = { ...projToml, ...serverToml };

  const runtime = {
    apiKey: staticConfig.apiKey || "",
    baseUrl: staticConfig.baseUrl,
    modelDefault: staticConfig.modelDefault,
    modelPro: staticConfig.modelPro,
    maxTokens: staticConfig.maxTokens,
    maxTokensPro: staticConfig.maxTokensPro,
  };

  // TOML overrides
  if (toml["reasonix.api_key"] && !runtime.apiKey) runtime.apiKey = String(toml["reasonix.api_key"]);
  if (toml["reasonix.base_url"]) runtime.baseUrl = String(toml["reasonix.base_url"]);
  if (toml["reasonix.model_default"]) runtime.modelDefault = String(toml["reasonix.model_default"]);
  if (toml["reasonix.model_pro"]) runtime.modelPro = String(toml["reasonix.model_pro"]);

  // Environment variables (highest priority)
  if (process.env.DEEPSEEK_API_KEY) runtime.apiKey = process.env.DEEPSEEK_API_KEY;
  if (process.env.DEEPSEEK_BASE_URL) runtime.baseUrl = process.env.DEEPSEEK_BASE_URL;

  return runtime;
}
