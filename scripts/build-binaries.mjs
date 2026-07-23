#!/usr/bin/env node
// Compila sg-attest (src/cli.js) in binari standalone via `bun build --compile`,
// uno per target, iniettando la versione da package.json a compile-time
// (vedi P40 F1: __SG_ATTEST_VERSION__ è il fallback usato quando il binario
// compilato non trova ../package.json su disco).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const VERSION = pkg.version;

const TARGETS = [
  { name: "sg-attest-linux-x64", target: "bun-linux-x64" },
  { name: "sg-attest-linux-arm64", target: "bun-linux-arm64" },
  { name: "sg-attest-macos-x64", target: "bun-darwin-x64" },
  { name: "sg-attest-macos-arm64", target: "bun-darwin-arm64" },
  { name: "sg-attest-windows-x64.exe", target: "bun-windows-x64" },
  { name: "sg-attest-windows-arm64.exe", target: "bun-windows-arm64" },
];

const onlyArg = process.argv.slice(2).find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length).split(",") : null;

const distDir = path.join(root, "dist");
mkdirSync(distDir, { recursive: true });

const selected = only
  ? TARGETS.filter((t) => only.includes(t.target) || only.includes(t.name))
  : TARGETS;

if (selected.length === 0) {
  console.error(`Nessun target combacia con --only=${onlyArg ?? ""}`);
  process.exit(1);
}

console.log(`sg-attest ${VERSION} — build di ${selected.length} target in ${distDir}\n`);

const failed = [];
for (const { name, target } of selected) {
  const outfile = path.join(distDir, name);
  process.stdout.write(`> ${name} (${target})... `);
  try {
    execFileSync(
      "bun",
      [
        "build",
        path.join(root, "src", "cli.js"),
        "--compile",
        `--target=${target}`,
        "--define",
        `__SG_ATTEST_VERSION__="${VERSION}"`,
        "--outfile",
        outfile,
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
    );
    console.log(existsSync(outfile) ? "ok" : "ok (file assente?!)");
  } catch (err) {
    console.log("FALLITO");
    console.error(err.stderr?.toString() || err.message);
    failed.push(name);
  }
}

if (failed.length > 0) {
  console.error(`\n${failed.length}/${selected.length} target falliti: ${failed.join(", ")}`);
  process.exit(1);
}

console.log(`\nTutti i binari sono in ${distDir}/ (versione ${VERSION}).`);
