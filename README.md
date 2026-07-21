# attest-mcp

Listed on the [official MCP Registry](https://registry.modelcontextprotocol.io/) as
`io.github.SPAZIO-GENESI/attest-mcp`.

MCP server for [Spazio Genesi](https://attestazione.spaziogenesi.org)'s attestation
service — attest, verify, and check the existence of digital works from any MCP-capable
AI agent (Claude Code, Claude Desktop, etc.).

**Full privacy**: file bytes never leave your device. The fingerprint (SHA-256) is
computed locally, streamed from disk — only the hash and optional metadata are sent.

## What it does

The attestation service timestamps a file's SHA-256 fingerprint, signs it (HMAC), and
can produce a signed PDF certificate plus an OpenTimestamps proof anchored in Bitcoin.
This server exposes that service as MCP tools, so an agent can attest and verify works
on your behalf without a browser.

## Why this, not just an OpenTimestamps wrapper

Several MCP servers can submit a hash to an OpenTimestamps calendar. As far as
we know, this is the only one that hands back a **complete proof of
existence** — a signed PDF certificate, a recognized RFC 3161 timestamp, and
a Bitcoin anchor — for **free**, with the file's bytes never leaving the
caller's machine. No account, no upload, no paid notarization chain. If you
know of another MCP server with the same combination (full certificate +
free + local hashing), we'd genuinely like to hear about it — open an issue.

## Install

**Claude Desktop** — one command, no manual JSON editing:

```bash
npx -y @spazio-genesi/attest-mcp-setup
```

This finds your `claude_desktop_config.json` (Windows/macOS/Linux), adds the
`attest-mcp` entry, and backs up the original file first. It refuses to touch
anything if the existing file isn't valid JSON — it never guesses. Restart
Claude Desktop afterwards. To remove it again: add `--uninstall`. To preview
without writing: add `--dry-run`.

**Claude Code**:

```bash
claude mcp add attest-mcp -- npx -y @spazio-genesi/attest-mcp
```

**Manual / other clients** — add this to your MCP client's config:

```json
{
  "mcpServers": {
    "attest-mcp": {
      "command": "npx",
      "args": ["-y", "@spazio-genesi/attest-mcp"]
    }
  }
}
```

## Authentication

Two ways to authenticate, matching the underlying service:

1. **API key** (for partner integrations, issued manually by Spazio Genesi):
   set the `IMGAUTH_API_KEY` environment variable.
2. **Device flow** (for personal/agent use): call the `authorize` tool with no
   arguments. It returns a URL — open it, approve with the human-verification
   widget, then call `authorize` again with the returned code. The session
   token (24h, 20 attestations) is saved to `~/.config/attest-mcp/credentials.json`
   (permissions `600` where supported) and used automatically after that.

Either way, the credential only unlocks the anti-bot check on attestation — the
server-side timestamp, cryptographic signature, and rate limits are unchanged.

## Tools

| Tool | What it does |
|---|---|
| `authorize` | Start or continue the device-flow authorization. |
| `attest_file` | Hash a local file (streamed) and attest it. |
| `get_certificate_pdf` | Mint a fresh signed PDF, or recover an already-archived one, saved to disk. |
| `verify_file` | Hash a local file and check it against a declared hash + signature. |
| `verify_certificate` | Verify a certificate's signature without a local file. |
| `check_anchor` | Check/download the OpenTimestamps (Bitcoin) proof. |
| `service_status` | Traffic-light status of the attestation service. |

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `IMGAUTH_API_KEY` | — | API key credential, bypasses the device flow. |
| `IMGAUTH_BASE_URL` | `https://imgauth.spaziogenesi.org` | Override for local development (`http://localhost:8787`). |
| `IMGAUTH_CERT_PAGE_BASE` | `https://attestazione.spaziogenesi.org` | Override for the permanent-certificate-page base URL. |

## Troubleshooting

If your client reports **"Server disconnected"**, check its log first: this server
writes diagnostics to stderr, which MCP clients capture. On Claude Desktop the log
lives in `%APPDATA%\Claude\logs\mcp-server-attest-mcp.log` (Windows) or
`~/Library/Logs/Claude/mcp-server-attest-mcp.log` (macOS).

You should see one line per lifecycle event:

```
[attest-mcp 2026-07-21T11:14:12.948Z] v0.2.2 ready on stdio (node v22.22.2, pid 32316)
[attest-mcp 2026-07-21T11:14:12.965Z] exiting (code 0)
```

- `exiting (code 0)` — ordinary shutdown: the client closed stdin. After a laptop
  sleep or a client restart this is expected; just restart the client to reconnect.
- `fatal: …` followed by `exiting (code 1)` — a real crash, with the stack trace on
  the preceding line. Please [open an issue](https://github.com/SPAZIO-GENESI/attest-mcp/issues)
  with it.
- No `ready` line at all — the process never started: check that `node` is on PATH
  and at least v18 (`node --version`).

stdout carries the JSON-RPC protocol and is never used for logging.

## Known limitation

The certificate PDF and its text are in **Italian** (Spazio Genesi is an Italian
non-profit and the certificate is a legal-facing document). The MCP tool
descriptions and this README are in English for an international audience.

## Development

```bash
npm install
npm test          # unit tests (hash vectors)
IMGAUTH_BASE_URL=http://localhost:8787 npm start   # against a local `wrangler dev`
```

## Security

Report vulnerabilities → [`/sicurezza/`](https://attestazione.spaziogenesi.org/sicurezza/)
(responsible disclosure policy, safe harbor for good-faith research) — this
repo has no `security.txt` of its own (npm package, no static assets), but
the policy covers the whole project.

## License

MIT — see [LICENSE](LICENSE). This is a client for the attestation service; the
service itself ([imgauth](https://github.com/SPAZIO-GENESI/imgauth)) is AGPL-3.0.
