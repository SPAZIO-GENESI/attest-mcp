#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";

// Adds (or removes, with --uninstall) this server's entry in Claude Desktop's
// config file, so a tester doesn't have to hand-edit JSON. Deliberately
// defensive: never writes anything unless the existing file parses cleanly,
// backs up before touching it, and re-reads the result to confirm it's what
// we intended — a bad merge here is much worse than doing nothing.

const SERVER_ENTRY = {
  command: "npx",
  args: ["-y", "@spazio-genesi/attest-mcp"],
};

function configPath() {
  const home = homedir();
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform() === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  // Linux: unofficial, but some community builds use this path.
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const uninstall = args.includes("--uninstall");

  const path = configPath();
  console.log(`Claude Desktop config: ${path}`);

  let raw = "{}";
  let existed = false;
  if (existsSync(path)) {
    existed = true;
    raw = readFileSync(path, "utf8");
  }

  let config;
  try {
    config = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch (err) {
    console.error("\nThe existing config file is not valid JSON — refusing to touch it automatically.");
    console.error(`Parse error: ${err.message}`);
    console.error("\nFix it by hand (or back it up and remove it), then run this again.");
    process.exitCode = 1;
    return;
  }

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    console.error("Unexpected config file shape (not a JSON object) — refusing to touch it automatically.");
    process.exitCode = 1;
    return;
  }

  if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
    config.mcpServers = {};
  }

  if (uninstall) {
    if (!config.mcpServers["attest-mcp"]) {
      console.log("attest-mcp is not configured — nothing to remove.");
      return;
    }
    delete config.mcpServers["attest-mcp"];
    console.log("Removing attest-mcp from the config.");
  } else {
    const already = JSON.stringify(config.mcpServers["attest-mcp"]) === JSON.stringify(SERVER_ENTRY);
    if (already) {
      console.log("attest-mcp is already configured correctly. Nothing to do.");
      return;
    }
    config.mcpServers["attest-mcp"] = SERVER_ENTRY;
    console.log("Adding attest-mcp to the config.");
  }

  const output = JSON.stringify(config, null, 2) + "\n";

  // Validate before touching disk at all.
  try {
    JSON.parse(output);
  } catch {
    console.error("Internal error: generated config is not valid JSON. Aborting — nothing written.");
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log("\n--dry-run: would write:\n");
    console.log(output);
    return;
  }

  mkdirSync(dirname(path), { recursive: true });

  if (existed) {
    const backupPath = `${path}.bak-${Date.now()}`;
    copyFileSync(path, backupPath);
    console.log(`Backed up existing config to ${backupPath}`);
  }

  writeFileSync(path, output, "utf8");

  // Re-read what we just wrote — confirm it round-trips and has what we expect.
  const verify = JSON.parse(readFileSync(path, "utf8"));
  const ok = uninstall ? !verify.mcpServers?.["attest-mcp"] : !!verify.mcpServers?.["attest-mcp"];
  if (!ok) {
    console.error("Verification failed after write — please check the file manually.");
    process.exitCode = 1;
    return;
  }

  console.log("\nDone. Restart Claude Desktop completely (not just close the window) to pick up the change.");
}

main();
