/**
 * Setup — environment self-check for Reasonix MCP Server
 *
 * Checks Node.js version, DeepSeek API Key configuration, and API connectivity.
 * Used by `reasonix setup` and by the SessionStart hook.
 */

import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ */
/*  Checkers                                                          */
/* ------------------------------------------------------------------ */

function checkNode() {
  const version = process.version;
  const major = parseInt(version.slice(1).split(".")[0], 10);
  return {
    ok: major >= 18,
    version,
    message: major >= 18 ? version : `Need Node >= 18, have ${version}`,
  };
}

function checkApiKey() {
  // 1. Environment variable
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey && envKey.startsWith("sk-")) {
    return {
      ok: true,
      source: "DEEPSEEK_API_KEY env var",
      message: "Set via environment variable",
    };
  }

  // 2. Global config TOML
  const homeConfigDir = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".reasonix"
  );
  const homeConfigPath = path.join(homeConfigDir, "config.toml");

  try {
    const content = fs.readFileSync(homeConfigPath, "utf8");
    const match = content.match(/api_key\s*=\s*"([^"]+)"/);
    if (match && match[1].startsWith("sk-")) {
      return {
        ok: true,
        source: homeConfigPath,
        message: `Set via ${homeConfigPath}`,
      };
    }
  } catch {
    // File doesn't exist or can't be read
  }

  return {
    ok: false,
    source: null,
    message:
      "Not configured. Run 'reasonix register' or set DEEPSEEK_API_KEY env var.",
  };
}

async function checkConnectivity(apiKeySource) {
  // Only test if we have an env-var key (can read it directly)
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key || !key.startsWith("sk-")) {
    // Try reading from config
    const homeConfigDir = path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".reasonix"
    );
    const homeConfigPath = path.join(homeConfigDir, "config.toml");
    try {
      const content = fs.readFileSync(homeConfigPath, "utf8");
      const match = content.match(/api_key\s*=\s*"([^"]+)"/);
      if (match) {
        // Found in config, but can't test from here (key is in file, not env)
        return {
          ok: null,
          message:
            "API Key is in config file — connectivity will be verified on first task.",
        };
      }
    } catch {}
    return { ok: false, message: "No API Key configured — skipped." };
  }

  try {
    const res = await fetch("https://api.deepseek.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    return {
      ok: res.ok,
      message: res.ok
        ? "Connected to DeepSeek API"
        : `DeepSeek API returned HTTP ${res.status}`,
    };
  } catch (err) {
    return { ok: false, message: `Cannot reach DeepSeek API: ${err.message}` };
  }
}

/* ------------------------------------------------------------------ */
/*  Command                                                           */
/* ------------------------------------------------------------------ */

export async function cmdSetup() {
  const asJson = process.argv.includes("--json");

  const node = checkNode();
  const apiKey = checkApiKey();
  const connectivity = apiKey.ok
    ? await checkConnectivity(apiKey.source)
    : { ok: false, message: "Skipped (no API Key)" };

  const result = {
    node,
    apiKey,
    connectivity,
    ready: node.ok && apiKey.ok,
  };

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("Reasonix MCP Setup Check");
    console.log("========================");
    console.log(
      `Node.js:  ${node.ok ? "✓" : "✗"} ${node.message}`
    );
    console.log(
      `API Key:  ${apiKey.ok ? "✓" : "✗"} ${apiKey.message}`
    );
    console.log(
      `DeepSeek: ${
        connectivity.ok === null ? "?" : connectivity.ok ? "✓" : "✗"
      } ${connectivity.message}`
    );

    if (!node.ok || !apiKey.ok) {
      console.log("\nFix actions:");
      if (!node.ok)
        console.log("  • Install Node.js >= 18 from https://nodejs.org");
      if (!apiKey.ok)
        console.log(
          "  • Run 'reasonix register' to set API Key interactively"
        );
      if (apiKey.ok && connectivity.ok === false)
        console.log(
          "  • Check your network connection and API Key validity"
        );
    }

    if (result.ready) {
      console.log("\n✓ Reasonix MCP is ready to use.");
      console.log(
        "  Tell your AI: 'Use Reasonix to investigate this bug' or call reasonix_start_task directly."
      );
    }
  }

  process.exitCode = result.ready ? 0 : 1;
}
