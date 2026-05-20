#!/usr/bin/env node

/**
 * Stop hook — optional review gate for Reasonix MCP.
 *
 * When enabled, runs after every Claude turn to check whether
 * the current code changes should be reviewed by Reasonix before
 * the session continues.
 *
 * Invokes reasonix_review_changes via the MCP tool.
 * Returns non-zero exit code to block the session if BLOCK verdict.
 *
 * Disabled by default — enable with: reasonix setup --enable-review-gate
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

function isGateEnabled() {
  try {
    const projectRoot = getProjectRoot();
    const configPath = path.join(projectRoot, ".reasonix", "config.toml");
    const content = fs.readFileSync(configPath, "utf8");
    return /review_gate\s*=\s*true/.test(content);
  } catch {
    return false;
  }
}

// Only run if gate is explicitly enabled
if (!isGateEnabled()) {
  process.exit(0);
}

// Check if there are uncommitted changes
try {
  const cwd = getProjectRoot();
  const diffStat = execSync("git diff --shortstat HEAD", {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (!diffStat.trim()) {
    process.exit(0); // No changes to review
  }
} catch {
  process.exit(0); // Not a git repo or git failed — skip
}

// Gate is enabled and there are changes — this is where we'd invoke
// reasonix_review_changes. For now, this is a placeholder:
// the host agent must implement MCP tool invocation in hooks.
// When MCP hook invocation is available, uncomment:
//
// const result = execSync(`... invoke reasonix_review_changes...`);
// if (result.includes("BLOCK")) process.exit(1);

process.exit(0);
