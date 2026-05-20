#!/usr/bin/env node

/**
 * SessionStart hook — silent health check for Reasonix MCP.
 *
 * Runs `reasonix setup --json` on session start to verify:
 *   - Node.js version
 *   - DeepSeek API Key is configured
 *   - DeepSeek API is reachable
 *
 * Writes status to .reasonix/health.json for the host agent to read.
 * Never blocks session start — all errors are silent.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const BIN = path.join(ROOT, "bin", "reasonix.js");

function getProjectRoot() {
  let current = process.cwd();
  for (let i = 0; i < 20; i++) {
    const reasonixDir = path.join(current, ".reasonix");
    if (fs.existsSync(reasonixDir)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

try {
  const result = execSync(`node "${BIN}" setup --json`, {
    cwd: getProjectRoot(),
    encoding: "utf8",
    timeout: 15_000,
  });

  // Write health file
  const projectRoot = getProjectRoot();
  const healthDir = path.join(projectRoot, ".reasonix");
  fs.mkdirSync(healthDir, { recursive: true });
  const health = JSON.parse(result);
  health.checkedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(healthDir, "health.json"),
    JSON.stringify(health, null, 2),
    "utf8"
  );
} catch {
  // Silent — never block session start
}

process.exit(0);
