// LOCAL-ONLY harness for `sg-attest` (P39): exercises every command end-to-end
// against an isolated `wrangler dev` imgauth instance. NOT run by `npm test`
// (needs a real local imgauth + a seeded credential) — same reasoning as
// attest-mcp-remote's test/smoke-auth.mjs, which this mirrors.
//
// Setup (once), from the imgauth repo:
//   for f in health_log agent_access dev_selfservice conventions voucher pro \
//            pro_cancel_scheduled dev_profile integrations; do
//     npx wrangler d1 execute imgauth-health --local --persist-to <SHORT_DIR> \
//       --file "schema/$f.sql"
//   done
// (⚠️ use a SHORT --persist-to path — a deep one hits Windows MAX_PATH and
// `wrangler d1 execute` fails with an opaque "internal error", see P39 notes.)
//
// Seed a test API key directly into that D1 (never --remote), then start:
//   npx wrangler dev --local --persist-to <SHORT_DIR> --port 18787 \
//     --var HMAC_SECRET:<any-string> --var ADMIN_SECRET:<any-string> \
//     --var SIGNER_URL: --var TURNSTILE_SECRET:
// (SIGNER_URL empty avoids calling the real authart signer from local dev —
// cert-pdf still succeeds, unsigned, same recipe as P24/P26.)
//
// Env (all required):
//   P39_IMGAUTH_BASE   e.g. http://127.0.0.1:18787
//   P39_IMGAUTH_DIR    local path of the imgauth repo (for wrangler d1 execute)
//   P39_PERSIST        the --persist-to dir of the isolated imgauth state
//   P39_API_KEY        a seeded sg_k_… credential in that isolated D1
//   P39_CONFIG_DIR     throwaway dir for ATTEST_MCP_CONFIG_DIR (authorize test)
//
// Usage: node test/cli-smoke.local.mjs
//
// Teardown gotcha: `wrangler dev`'s actual runtime is a separate `workerd.exe`
// process (Windows) — killing only the `node.exe`/wrangler PID leaves it
// running and holding the D1/R2 SQLite files locked ("Device or resource
// busy" on rm -rf). Kill `workerd.exe` too before deleting --persist-to.

import { spawnSync, spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

function need(k) {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing env ${k} — this is a local-only harness, see the header comment.`);
    process.exit(2);
  }
  return v;
}

const IMGAUTH_BASE = need("P39_IMGAUTH_BASE");
const IMGAUTH_DIR = need("P39_IMGAUTH_DIR");
const PERSIST = need("P39_PERSIST");
const API_KEY = need("P39_API_KEY");
const CONFIG_DIR = need("P39_CONFIG_DIR");

if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(IMGAUTH_BASE)) {
  console.error("Refusing to run: P39_IMGAUTH_BASE must be a local address (this harness writes to D1 directly).");
  process.exit(2);
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}${detail ? " — " + String(detail).slice(0, 300) : ""}`);
  }
}

function runCli(args, env = {}) {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli.js"), ...args], {
    env: { ...process.env, IMGAUTH_BASE_URL: IMGAUTH_BASE, ...env },
    encoding: "utf8",
    timeout: 30000,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not every command emits JSON here (e.g. --json omitted) */
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function d1Exec(sql) {
  const sqlFile = join(PERSIST, `smoke-${Date.now()}.sql`);
  writeFileSync(sqlFile, sql);
  const r = spawnSync("npx.cmd", ["wrangler", "d1", "execute", "imgauth-health", "--local", "--persist-to", PERSIST, "--file", sqlFile], {
    cwd: IMGAUTH_DIR,
    shell: true,
    encoding: "utf8",
    timeout: 120000,
  });
  try {
    unlinkSync(sqlFile);
  } catch {
    /* ignore */
  }
  if (r.status !== 0) throw new Error(`d1 exec failed: ${r.stderr?.slice(0, 400)}`);
}

// ── read-only commands ──────────────────────────────────────────────────────
console.log("Read-only commands");
{
  const r = runCli(["status", "--json"]);
  check("status exits 0", r.status === 0, r.stderr);
  check("status --json has worker field", r.json?.worker !== undefined, r.stdout);
}
{
  const r = runCli(["--version"]);
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  check("--version prints package.json version", r.stdout.trim() === pkg.version, r.stdout);
}
{
  const r = runCli(["bogus-command"]);
  check("unknown command exits 1", r.status === 1, r.stdout + r.stderr);
}

// ── attest end-to-end (a fresh, never-attested fingerprint) ─────────────────
console.log("attest → cert-pdf → verify → cert recovery");
const dir = mkdtempSync(join(tmpdir(), "sg-attest-smoke-"));
const workPath = join(dir, "work.bin");
writeFileSync(workPath, crypto.randomBytes(2048));
const pdfPath = join(dir, "cert.pdf");

const attestResult = runCli(["attest", workPath, "--title", "Smoke test P39", "--pdf", pdfPath, "--json"], {
  IMGAUTH_API_KEY: API_KEY,
});
check("attest exits 0", attestResult.status === 0, attestResult.stderr);
check("attest returns sha256 + hmac + attestazione", !!(attestResult.json?.sha256 && attestResult.json?.hmac && attestResult.json?.attestazione), attestResult.stdout);
check("attest saved a PDF (%PDF- header)", (() => {
  try {
    return readFileSync(pdfPath).subarray(0, 5).toString() === "%PDF-";
  } catch {
    return false;
  }
})());

const { sha256, attestazione, hmac } = attestResult.json || {};

{
  const r = runCli(["verify", workPath, "--hash", sha256, "--json"]);
  check("verify: matches", r.json?.coincide === true, r.stdout);
  check("verify: archived", r.json?.in_archivio === true, r.stdout);
}
{
  const r = runCli(["verify", workPath, "--hash", "0".repeat(64)]);
  check("verify: mismatch exits 2", r.status === 2, r.stdout);
}
{
  const r = runCli(["verify-cert", "--hash", sha256, "--attestazione", attestazione, "--hmac", hmac, "--titolo", "Smoke test P39", "--json"]);
  check("verify-cert: valid signature", r.json?.hmac_valido === true, r.stdout);
}
{
  const r = runCli(["verify-cert", "--hash", sha256, "--attestazione", attestazione, "--hmac", hmac, "--titolo", "Tampered", "--json"]);
  check("verify-cert: tampered metadata → invalid, exit 2", r.json?.hmac_valido === false && r.status === 2, r.stdout);
}
{
  const recoveredPath = join(dir, "recovered.pdf");
  const r = runCli(["cert", sha256, "-o", recoveredPath, "--json"]);
  check("cert: recovers the archived PDF", r.status === 0 && r.json?.bytes > 0, r.stderr);
}
{
  const r = runCli(["anchor", sha256, "--json"]);
  check("anchor: runs without error (exists true or false, network-dependent)", r.status === 0 && typeof r.json?.exists === "boolean", r.stdout + r.stderr);
}

// ── credential handling ──────────────────────────────────────────────────────
console.log("Credential errors");
{
  const r = runCli(["attest", workPath], { IMGAUTH_API_KEY: "", ATTEST_MCP_CONFIG_DIR: join(dir, "empty-config") });
  check("attest without credential exits 1", r.status === 1, r.stdout);
  check("attest without credential never echoes a key", !r.stdout.includes("sg_k_") && !r.stderr.includes("sg_k_"));
}
{
  const r = runCli(["attest", workPath], { IMGAUTH_API_KEY: "sg_k_deadbeef_notreal" });
  check("attest with invalid key exits 1", r.status === 1, r.stdout);
}

// ── authorize device flow (simulated approval, same technique as
//    attest-mcp-remote/test/smoke-auth.mjs: the human-Turnstile step is
//    replaced by writing the approval straight into the isolated local D1) ──
console.log("authorize (device flow, simulated approval)");
await new Promise((resolve) => {
  const child = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "cli.js"), "authorize"], {
    env: { ...process.env, IMGAUTH_BASE_URL: IMGAUTH_BASE, ATTEST_MCP_CONFIG_DIR: CONFIG_DIR },
  });
  let out = "";
  let approved = false;
  child.stdout.on("data", (chunk) => {
    out += chunk;
    const match = out.match(/Codice: ([0-9a-f]{16})/);
    if (match && !approved) {
      approved = true;
      const code = match[1];
      const id = crypto.randomBytes(4).toString("hex");
      const secret = crypto.randomBytes(32).toString("base64url");
      const secretHash = crypto.createHash("sha256").update(secret).digest("hex");
      const token = `sg_s_${id}_${secret}`;
      const now = Date.now();
      d1Exec(
        `INSERT INTO agent_credentials (id, kind, secret_hash, label, quota, used, period, expires_at, revoked, created_at) ` +
          `VALUES ('${id}', 'session', '${secretHash}', 'smoke-test', 20, 0, NULL, ${now + 24 * 3600 * 1000}, 0, '${new Date(now).toISOString()}'); ` +
          `UPDATE agent_authorizations SET status = 'approved', token_once = '${token}', credential_id = '${id}' WHERE code = '${code}';`
      );
    }
  });
  const timer = setTimeout(() => {
    child.kill();
    check("authorize: code observed and approval injected before timeout", false, "timed out waiting for the poll to pick up the approval");
    resolve();
  }, 20000);
  child.on("exit", (exitCode) => {
    clearTimeout(timer);
    check("authorize: exits 0 after approval", exitCode === 0, `exit code ${exitCode}`);
    let creds = null;
    try {
      creds = JSON.parse(readFileSync(join(CONFIG_DIR, "credentials.json"), "utf8"));
    } catch {
      /* ignore */
    }
    check("authorize: credentials saved to the (isolated) config dir", !!creds?.token, JSON.stringify(creds));
    resolve();
  });
});

// ── summary ──────────────────────────────────────────────────────────────────
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
