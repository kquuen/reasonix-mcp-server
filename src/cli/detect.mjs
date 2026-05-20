/**
 * Detect — MCP client discovery for Reasonix CLI
 *
 * Finds installed MCP-compatible clients and their configuration files
 * so `reasonix register` can auto-write the server entry.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();

/**
 * Known MCP client definitions.
 * Each entry has a name, a key (for internal use), and a configPath
 * resolver (function receiving optional cwd, returning the full path).
 */
const KNOWN_CLIENTS = [
  {
    name: "Kimi Code",
    key: "kimi-code",
    configPath: () => path.join(HOME, ".config", "kimi", "mcp.json"),
  },
  {
    name: "Cursor",
    key: "cursor",
    configPath: () => path.join(HOME, ".cursor", "mcp.json"),
  },
  {
    name: "Claude Code",
    key: "claude-code",
    configPath: () => path.join(HOME, ".claude", "mcp.json"),
    hooksPath: () => path.join(HOME, ".claude", "hooks", "hooks.json"),
    agentsDir: () => path.join(HOME, ".claude", "agents"),
  },
  {
    name: "Project-level MCP",
    key: "project-mcp",
    configPath: (cwd) => path.join(cwd || process.cwd(), ".mcp.json"),
  },
];

/**
 * Detect all known clients, returning their name, key, config path, and
 * whether the config file already exists.
 */
export function detectClients(cwd) {
  return KNOWN_CLIENTS.map((client) => {
    const cfgPath =
      typeof client.configPath === "function"
        ? client.configPath(cwd)
        : client.configPath();
    const exists = fs.existsSync(cfgPath);
    const result = { name: client.name, key: client.key, configPath: cfgPath, exists };
    if (client.hooksPath) {
      result.hooksPath =
        typeof client.hooksPath === "function"
          ? client.hooksPath(cwd)
          : client.hooksPath();
    }
    if (client.agentsDir) {
      result.agentsDir =
        typeof client.agentsDir === "function"
          ? client.agentsDir(cwd)
          : client.agentsDir();
    }
    return result;
  });
}

/** Read and parse an MCP client config file. Returns { mcpServers: {} } on failure. */
export function readMcpConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return { mcpServers: {} };
  }
}

/** Write an MCP client config file. Backs up the existing file as .bak. */
export function writeMcpConfig(configPath, config) {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, configPath + ".bak");
  }
  fs.writeFileSync(
    configPath,
    JSON.stringify(config, null, 2) + "\n",
    "utf8"
  );
}

/** Add a server entry to an MCP config object. Mutates in place. */
export function addServerToConfig(config, serverName, serverEntry) {
  config.mcpServers = config.mcpServers || {};
  config.mcpServers[serverName] = serverEntry;
  return config;
}

/** Remove a server entry from an MCP config object. Mutates in place. */
export function removeServerFromConfig(config, serverName) {
  if (config.mcpServers) {
    delete config.mcpServers[serverName];
  }
  return config;
}
