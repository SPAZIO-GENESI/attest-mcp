#!/usr/bin/env node
import { basename } from "node:path";
import { writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { hashFile } from "./hash.js";
import { saveCredentials } from "./config.js";
import {
  ApiError,
  attestHash,
  mintCertificatePdf,
  recoverCertificatePdf,
  verifyClaim,
  checkAnchor,
  serviceStatus,
  startAuthorize,
  pollAuthorizeToken,
  permanentUrl,
} from "./api.js";

const server = new McpServer({ name: "attest-mcp", version: "0.1.0" });

function ok(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function fail(err) {
  const message = err instanceof ApiError
    ? [err.message, err.hint].filter(Boolean).join(" ")
    : err?.message || String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

// ── authorize: two-step device flow, driven by the calling agent ───────────
// Call with no `code` to start: shows the human a URL + short-lived code.
// Call again with that `code` (repeatedly, a few seconds apart) to poll;
// once approved, the session token is saved to ~/.config/attest-mcp/credentials.json
// and every other tool starts working automatically.
server.registerTool(
  "authorize",
  {
    title: "Authorize this agent",
    description:
      "Start or continue the device-flow authorization. Call with no arguments to begin: " +
      "show the returned verification_url to the human and ask them to open it and approve. " +
      "Then call again passing the same `code`, a few seconds apart, until status is 'approved' " +
      "(token saved automatically) or 'expired' (start over). Grants 20 attestations for 24 hours.",
    inputSchema: {
      code: z.string().optional().describe("The code from a previous authorize call, to resume polling."),
    },
  },
  async ({ code }) => {
    try {
      if (!code) {
        const started = await startAuthorize();
        return ok({
          status: "pending",
          code: started.code,
          verification_url: started.verification_url,
          expires_in: started.expires_in,
          message: `Show this URL to the human and ask them to approve: ${started.verification_url} — then call authorize again with code "${started.code}".`,
        });
      }
      const polled = await pollAuthorizeToken(code);
      if (polled.status === "approved" && polled.token) {
        await saveCredentials({ token: polled.token, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
        return ok({ status: "approved", message: "Session authorized and saved. You can now attest, verify, and check works." });
      }
      if (polled.status === "pending") {
        return ok({ status: "pending", message: "Not yet approved — wait a few seconds and call authorize again with the same code." });
      }
      if (polled.status === "claimed") {
        return ok({ status: "claimed", message: "This code's token was already delivered in a previous call." });
      }
      return ok({ status: polled.status || "expired", message: "This authorization request is no longer valid — call authorize with no arguments to start over." });
    } catch (err) {
      return fail(err);
    }
  }
);

// ── attest_file: the core operation ─────────────────────────────────────────
server.registerTool(
  "attest_file",
  {
    title: "Attest a file",
    description:
      "Compute the SHA-256 fingerprint of a local file (streamed, never sent anywhere) and attest it: " +
      "the server timestamps it and returns a signed attestation. Requires a credential — run 'authorize' first, " +
      "or set IMGAUTH_API_KEY. Optional declared metadata (titolo/autore/anno/note) is bound to the signature.",
    inputSchema: {
      path: z.string().describe("Absolute or relative path to the local file."),
      titolo: z.string().optional().describe("Declared title of the work (optional)."),
      autore: z.string().optional().describe("Declared author (optional)."),
      anno: z.string().optional().describe("Declared year/version (optional)."),
      note: z.string().optional().describe("Declared free-text note (optional)."),
    },
  },
  async ({ path, titolo, autore, anno, note }) => {
    try {
      const { sha256, size } = await hashFile(path);
      const attestation = await attestHash({ sha256, name: basename(path), size, titolo, autore, anno, note });
      return ok({ ...attestation, permanent_url: permanentUrl(sha256) });
    } catch (err) {
      return fail(err);
    }
  }
);

// ── get_certificate_pdf: mint a fresh one, or recover an existing one ──────
server.registerTool(
  "get_certificate_pdf",
  {
    title: "Get the certificate PDF",
    description:
      "Get the signed certificate PDF for an attested work, saving it to a local file. " +
      "Pass `attestation` (the exact object returned by attest_file) right after attesting, to mint a " +
      "freshly-signed PDF. Pass only `hash` to recover an already-archived certificate instead (no credential needed).",
    inputSchema: {
      hash: z.string().describe("The SHA-256 fingerprint (64 hex chars)."),
      attestation: z.record(z.string(), z.any()).optional().describe("The full object returned by attest_file, to mint a new PDF."),
      save_to: z.string().optional().describe("Local file path to save the PDF to (default: ./certificato_<hash12>.pdf)."),
    },
  },
  async ({ hash, attestation, save_to }) => {
    try {
      const bytes = attestation ? await mintCertificatePdf(attestation) : await recoverCertificatePdf(hash);
      const outPath = save_to || `./certificato_${hash.slice(0, 12)}.pdf`;
      await writeFile(outPath, bytes);
      return ok({ saved_to: outPath, bytes: bytes.length, permanent_url: permanentUrl(hash) });
    } catch (err) {
      return fail(err);
    }
  }
);

// ── verify_file: local hash + HMAC check, no bytes sent ────────────────────
server.registerTool(
  "verify_file",
  {
    title: "Verify a file against a certificate",
    description:
      "Compute the SHA-256 of a local file and check it against a declared hash/attestation, plus verify the " +
      "HMAC signature server-side (no file bytes are ever sent). Pass the fields as read from the certificate " +
      "(hash, attestazione, hmac, and any declared titolo/autore/anno/note).",
    inputSchema: {
      path: z.string().describe("Local file to verify."),
      hash: z.string().optional().describe("Declared SHA-256 to compare against (from the certificate)."),
      attestazione: z.string().optional().describe("The attestation string from the certificate."),
      hmac: z.string().optional().describe("The HMAC signature from the certificate."),
      titolo: z.string().optional(),
      autore: z.string().optional(),
      anno: z.string().optional(),
      note: z.string().optional(),
    },
  },
  async ({ path, hash, attestazione, hmac, titolo, autore, anno, note }) => {
    try {
      const { sha256 } = await hashFile(path);
      const matches = hash ? sha256.toLowerCase() === String(hash).toLowerCase() : null;
      let hmacResult = null;
      if (attestazione && hmac) {
        hmacResult = await verifyClaim({ hash: hash || sha256, attestazione, hmac, titolo, autore, anno, note });
      }
      return ok({
        hash_calcolato_locale: sha256,
        hash_dichiarato: hash ?? null,
        coincide: matches,
        hmac_valido: hmacResult?.hmac_valido ?? null,
        permanent_url: permanentUrl(sha256),
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ── verify_certificate: HMAC-only check, no local file involved ────────────
server.registerTool(
  "verify_certificate",
  {
    title: "Verify a certificate's signature",
    description:
      "Verify the HMAC signature of a certificate's attestation (+ declared metadata, if any) without checking " +
      "against any local file. Confirms authenticity and integrity of the declared data, not that a given file matches.",
    inputSchema: {
      hash: z.string().describe("The SHA-256 fingerprint from the certificate."),
      attestazione: z.string().describe("The attestation string from the certificate."),
      hmac: z.string().describe("The HMAC signature from the certificate."),
      titolo: z.string().optional(),
      autore: z.string().optional(),
      anno: z.string().optional(),
      note: z.string().optional(),
    },
  },
  async ({ hash, attestazione, hmac, titolo, autore, anno, note }) => {
    try {
      const result = await verifyClaim({ hash, attestazione, hmac, titolo, autore, anno, note });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── check_anchor: OpenTimestamps / Bitcoin anchoring proof ─────────────────
server.registerTool(
  "check_anchor",
  {
    title: "Check the Bitcoin anchoring proof",
    description: "Check whether a fingerprint has an OpenTimestamps proof, optionally saving the .ots proof file to disk.",
    inputSchema: {
      hash: z.string().describe("The SHA-256 fingerprint."),
      save_to: z.string().optional().describe("Local file path to save the .ots proof to, if it exists."),
    },
  },
  async ({ hash, save_to }) => {
    try {
      const result = await checkAnchor(hash);
      if (!result.exists) return ok({ exists: false });
      let savedTo = null;
      if (save_to) {
        await writeFile(save_to, result.bytes);
        savedTo = save_to;
      }
      return ok({ exists: true, saved_to: savedTo, verify_at: "https://opentimestamps.org" });
    } catch (err) {
      return fail(err);
    }
  }
);

// ── service_status: traffic light ───────────────────────────────────────────
server.registerTool(
  "service_status",
  {
    title: "Check service status",
    description: "Get the traffic-light status of the attestation service (worker, archive, signer, Bitcoin anchor).",
    inputSchema: {},
  },
  async () => {
    try {
      const status = await serviceStatus();
      return ok(status);
    } catch (err) {
      return fail(err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("attest-mcp fatal error:", err);
  process.exit(1);
});
