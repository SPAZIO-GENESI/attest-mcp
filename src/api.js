import { getBearerToken, BASE_URL, CERT_PAGE_BASE } from "./config.js";

export class ApiError extends Error {
  constructor(message, status, hint) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.hint = hint;
  }
}

function hintFor(status) {
  if (status === 401) return "Run the 'authorize' tool, or set IMGAUTH_API_KEY.";
  if (status === 403) return "Credential invalid, revoked, or expired — run 'authorize' again.";
  if (status === 429) return "Quota exhausted or rate-limited — wait a bit, or run 'authorize' for a fresh session.";
  return null;
}

async function authHeaders() {
  const token = await getBearerToken();
  if (!token) throw new ApiError("No credential configured.", 401, hintFor(401));
  return { Authorization: `Bearer ${token}` };
}

async function readJsonOrThrow(res) {
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new ApiError(body?.error || `HTTP ${res.status}`, res.status, hintFor(res.status));
  }
  return body;
}

// POST /api/hash with a bearer credential: attests a locally-computed digest,
// bypassing the Turnstile challenge (P21). Never sends file bytes.
export async function attestHash({ sha256, name, type, size, titolo, autore, anno, note }) {
  const res = await fetch(`${BASE_URL}/api/hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ sha256, name, type, size, titolo, autore, anno, note }),
  });
  return readJsonOrThrow(res);
}

// POST /api/cert-pdf: mints a freshly-signed PDF. `attestation` must be the
// exact object returned by attestHash() — the server re-verifies the HMAC
// against sha256+timestamp_iso(+metadata) before signing, so partial or
// hand-edited payloads are rejected.
export async function mintCertificatePdf(attestation) {
  const res = await fetch(`${BASE_URL}/api/cert-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(attestation),
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    throw new ApiError(body?.error || `HTTP ${res.status}`, res.status, hintFor(res.status));
  }
  return Buffer.from(await res.arrayBuffer());
}

// GET /api/cert?hash=: recovers an already-archived certificate (no auth
// needed — same trust model as the QR/?hash= link: only someone who already
// knows the fingerprint can fetch it).
export async function recoverCertificatePdf(hash) {
  const res = await fetch(`${BASE_URL}/api/cert?hash=${encodeURIComponent(hash)}`);
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    throw new ApiError(body?.error || `HTTP ${res.status}`, res.status);
  }
  return Buffer.from(await res.arrayBuffer());
}

// POST /api/verify without `image`: verifies only the HMAC signature of the
// declared attestation(+metadata) — the hash/file match, if any, is checked
// locally by the caller (verify_file). No auth required (read-only, public).
export async function verifyClaim({ hash, attestazione, hmac, titolo, autore, anno, note }) {
  const form = new FormData();
  form.append("hash", hash);
  if (attestazione) form.append("attestazione", attestazione);
  if (hmac) form.append("hmac", hmac);
  if (titolo) form.append("titolo", titolo);
  if (autore) form.append("autore", autore);
  if (anno) form.append("anno", anno);
  if (note) form.append("note", note);
  const res = await fetch(`${BASE_URL}/api/verify`, { method: "POST", body: form });
  return readJsonOrThrow(res);
}

// GET /api/cert?hash=: existence-only check, used by the CLI's `verify` command
// to report archive status without paying the cost of buffering the whole PDF
// into memory (cancel the body as soon as we have the status).
export async function checkArchived(hash) {
  const res = await fetch(`${BASE_URL}/api/cert?hash=${encodeURIComponent(hash)}`);
  if (res.body) await res.body.cancel();
  return res.ok;
}

// GET /api/ots?hash=: OpenTimestamps proof of anchoring in Bitcoin, if any.
export async function checkAnchor(hash) {
  const res = await fetch(`${BASE_URL}/api/ots?hash=${encodeURIComponent(hash)}`);
  if (res.status === 404) return { exists: false };
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    throw new ApiError(body?.error || `HTTP ${res.status}`, res.status);
  }
  return { exists: true, bytes: Buffer.from(await res.arrayBuffer()) };
}

// GET /api/status: traffic-light status of worker/archive/signer/anchor.
export async function serviceStatus() {
  const res = await fetch(`${BASE_URL}/api/status`);
  return readJsonOrThrow(res);
}

// POST /api/agent/authorize: starts the device flow (no auth). Returns a
// short-lived code plus the human-facing verification URL.
export async function startAuthorize() {
  const res = await fetch(`${BASE_URL}/api/agent/authorize`, { method: "POST" });
  return readJsonOrThrow(res);
}

// GET /api/agent/token?code=: polls the device flow. Distinct from
// readJsonOrThrow because 410 (expired) and non-200 states here are normal
// poll outcomes, not transport errors — the caller inspects `status`.
export async function pollAuthorizeToken(code) {
  const res = await fetch(`${BASE_URL}/api/agent/token?code=${encodeURIComponent(code)}`);
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return body ?? { status: "error" };
}

export function permanentUrl(hash) {
  return `${CERT_PAGE_BASE}/c/${hash}`;
}
