import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const BASE_URL = process.env.IMGAUTH_BASE_URL || "https://imgauth.spaziogenesi.org";
export const CERT_PAGE_BASE = process.env.IMGAUTH_CERT_PAGE_BASE || "https://attestazione.spaziogenesi.org";

// Overridable so tests (and the CLI's own smoke harness) never touch a real
// user's saved session token — same override pattern as BASE_URL above.
const CONFIG_DIR = process.env.ATTEST_MCP_CONFIG_DIR || join(homedir(), ".config", "attest-mcp");
const CREDENTIALS_PATH = join(CONFIG_DIR, "credentials.json");

// Resolves the bearer token to send: an explicit IMGAUTH_API_KEY env var wins
// (the "convenzione" API key case); otherwise falls back to the session token
// saved on disk by the `authorize` tool (device flow).
export async function getBearerToken() {
  if (process.env.IMGAUTH_API_KEY) return process.env.IMGAUTH_API_KEY.trim();
  const creds = await readCredentials();
  if (!creds?.token) return null;
  if (creds.expiresAt && Date.now() > creds.expiresAt) return null;
  return creds.token;
}

export async function readCredentials() {
  try {
    return JSON.parse(await readFile(CREDENTIALS_PATH, "utf8"));
  } catch {
    return null;
  }
}

// Persists the session token from the device flow. Permissions 600 (owner
// read/write only) where the platform supports it: treat this like a password.
export async function saveCredentials({ token, expiresAt }) {
  await mkdir(dirname(CREDENTIALS_PATH), { recursive: true });
  await writeFile(
    CREDENTIALS_PATH,
    JSON.stringify({ token, expiresAt, savedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
  try {
    await chmod(CREDENTIALS_PATH, 0o600);
  } catch {
    /* best-effort: platforms without POSIX permissions (e.g. Windows) ignore this */
  }
}

export { CREDENTIALS_PATH };
