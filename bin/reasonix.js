#!/usr/bin/env node

/**
 * Reasonix MCP Server CLI
 *
 * Usage:
 *   reasonix register     Register with detected MCP clients
 *   reasonix unregister   Remove from all registered clients
 *   reasonix status       Show registration status
 *   reasonix setup        Check environment and connectivity
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const HELP = `Reasonix MCP Server CLI

Usage:
  reasonix register     Register with detected MCP clients
  reasonix unregister   Remove from all registered clients
  reasonix status       Show registration status
  reasonix setup        Check environment and connectivity
`;

async function main() {
  const subcommand = process.argv[2];

  switch (subcommand) {
    case "register":
      return (await import("../src/cli/register.mjs")).cmdRegister();
    case "unregister":
      return (await import("../src/cli/register.mjs")).cmdUnregister();
    case "status":
      return (await import("../src/cli/register.mjs")).cmdStatus();
    case "setup":
      return (await import("../src/cli/setup.mjs")).cmdSetup();
    default:
      console.log(HELP);
      process.exit(0);
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
