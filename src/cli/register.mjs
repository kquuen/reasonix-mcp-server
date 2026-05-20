/**
 * Register — Reasonix MCP registration CLI commands
 *
 * Handles `reasonix register`, `reasonix unregister`, and `reasonix status`.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  detectClients,
  readMcpConfig,
  writeMcpConfig,
  addServerToConfig,
  removeServerFromConfig,
} from "./detect.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const SERVER_SCRIPT = path.join(ROOT, "src", "server", "index.mjs");

/* ------------------------------------------------------------------ */
/*  API Key helpers                                                   */
/* ------------------------------------------------------------------ */

function getEnvApiKey() {
  const key = process.env.DEEPSEEK_API_KEY;
  return key && key.startsWith("sk-") ? key : null;
}

function promptApiKey() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question("Enter DeepSeek API Key (sk-...): ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function writeGlobalConfig(apiKey) {
  const homeConfigDir = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".reasonix"
  );
  await fs.promises.mkdir(homeConfigDir, { recursive: true });
  const configPath = path.join(homeConfigDir, "config.toml");
  await fs.promises.writeFile(
    configPath,
    `[reasonix]\napi_key = "${apiKey}"\n`,
    "utf8"
  );
  return configPath;
}

/* ------------------------------------------------------------------ */
/*  Server entry builder                                              */
/* ------------------------------------------------------------------ */

function buildServerEntry(apiKey) {
  return {
    command: "node",
    args: [SERVER_SCRIPT],
    ...(apiKey ? { env: { DEEPSEEK_API_KEY: apiKey } } : {}),
  };
}

/* ------------------------------------------------------------------ */
/*  Hook & Agent helpers (Claude Code integration)                    */
/* ------------------------------------------------------------------ */

function writeClaudeHooks(client) {
  const hooksDir = path.dirname(client.hooksPath);
  fs.mkdirSync(hooksDir, { recursive: true });

  // Read existing hooks config (if any)
  let existing = {};
  if (fs.existsSync(client.hooksPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(client.hooksPath, "utf8"));
      // Backup before modifying
      fs.copyFileSync(client.hooksPath, client.hooksPath + ".bak");
    } catch {
      // Corrupt or empty — start fresh
    }
  }

  // Reasonix hook entry
  const reasonixHook = {
    hooks: [
      {
        type: "command",
        command: `node "${path.join(ROOT, "hooks", "session-start.mjs")}"`,
        timeout: 15,
      },
    ],
  };

  // Merge into existing hooks
  existing.hooks = existing.hooks || {};
  existing.hooks.SessionStart = existing.hooks.SessionStart || [];

  // Check if reasonix hook already exists
  const exists = existing.hooks.SessionStart.some((group) =>
    group.hooks?.some(
      (h) =>
        h.type === "command" &&
        h.command &&
        h.command.includes("reasonix-mcp-server")
    )
  );

  if (!exists) {
    existing.hooks.SessionStart.push(reasonixHook);
  }

  fs.writeFileSync(
    client.hooksPath,
    JSON.stringify(existing, null, 2) + "\n",
    "utf8"
  );
}

function copyAgentDefinition(client) {
  const agentsDir = client.agentsDir;
  fs.mkdirSync(agentsDir, { recursive: true });

  const src = path.join(ROOT, "agents", "reasonix-rescue.md");
  const dst = path.join(agentsDir, "reasonix-rescue.md");

  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  }
}

/* ------------------------------------------------------------------ */
/*  Commands                                                          */
/* ------------------------------------------------------------------ */

export async function cmdRegister() {
  const cwd = process.cwd();
  const clients = detectClients(cwd);
  let apiKey = getEnvApiKey();

  if (!apiKey) {
    process.stderr.write("DEEPSEEK_API_KEY not set in environment.\n");
    apiKey = await promptApiKey();
    if (apiKey) {
      const configPath = await writeGlobalConfig(apiKey);
      process.stderr.write(`API Key saved to ${configPath}\n`);
    }
  }

  const serverEntry = buildServerEntry(apiKey);
  const results = [];

  for (const client of clients) {
    if (!client.exists) {
      results.push({
        client: client.name,
        status: "skipped",
        reason: "config not found",
      });
      continue;
    }

    try {
      const config = readMcpConfig(client.configPath);
      if (config.mcpServers?.reasonix) {
        results.push({ client: client.name, status: "already_registered" });
      } else {
        addServerToConfig(config, "reasonix", serverEntry);
        writeMcpConfig(client.configPath, config);

        // Claude Code: also write hooks config and copy agent definition
        if (client.key === "claude-code" && client.hooksPath) {
          try {
            writeClaudeHooks(client);
            results.push({ client: client.name, status: "registered", hooks: "configured" });
          } catch {
            // Hooks are optional — don't fail registration
          }
        }
        if (client.agentsDir) {
          try {
            copyAgentDefinition(client);
          } catch {
            // Agent is optional
          }
        }

        if (!results.find((r) => r.client === client.name && r.status === "registered")) {
          results.push({ client: client.name, status: "registered" });
        }
      }
    } catch (err) {
      results.push({
        client: client.name,
        status: "error",
        reason: err.message,
      });
    }
  }

  const registered = results.filter((r) => r.status === "registered").length;
  const already = results.filter((r) => r.status === "already_registered").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const errors = results.filter((r) => r.status === "error").length;

  console.log(JSON.stringify(results, null, 2));
  process.stderr.write(
    `\nDone: ${registered} registered, ${already} already, ${skipped} skipped, ${errors} errors.\n`
  );

  if (apiKey && registered > 0) {
    process.stderr.write(
      "Run 'reasonix setup' to verify everything is working.\n"
    );
  }
}

export async function cmdUnregister() {
  const clients = detectClients(process.cwd());
  const results = [];

  for (const client of clients) {
    if (!client.exists) continue;

    try {
      const config = readMcpConfig(client.configPath);
      if (config.mcpServers?.reasonix) {
        removeServerFromConfig(config, "reasonix");
        writeMcpConfig(client.configPath, config);
        results.push({ client: client.name, status: "unregistered" });
      } else {
        results.push({ client: client.name, status: "not_registered" });
      }
    } catch (err) {
      results.push({
        client: client.name,
        status: "error",
        reason: err.message,
      });
    }
  }

  console.log(JSON.stringify(results, null, 2));
}

export async function cmdStatus() {
  const clients = detectClients(process.cwd());
  const results = clients.map((client) => {
    if (!client.exists) {
      return {
        client: client.name,
        registered: false,
        reason: "config not found",
      };
    }
    try {
      const config = readMcpConfig(client.configPath);
      return {
        client: client.name,
        registered: !!config.mcpServers?.reasonix,
        configPath: client.configPath,
      };
    } catch {
      return {
        client: client.name,
        registered: false,
        reason: "unreadable",
      };
    }
  });

  console.log(JSON.stringify(results, null, 2));
}
