# attest-mcp

Listed on the [official MCP Registry](https://registry.modelcontextprotocol.io/) as
`io.github.SPAZIO-GENESI/attest-mcp`.

MCP server **and CLI** for [Spazio Genesi](https://attestazione.spaziogenesi.org)'s
attestation service — attest, verify, and check the existence of digital works from
any MCP-capable AI agent (Claude Code, Claude Desktop, etc.) or straight from a
terminal / CI pipeline.

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

## CLI (`sg-attest`)

Same package, no separate install. The CLI is a `bin` alongside the MCP server,
sharing the same hashing/API/config code — same full privacy (streamed local
hash, file bytes never sent), same credentials.

```bash
npx -y -p @spazio-genesi/attest-mcp sg-attest attest ./work.png
npx -y -p @spazio-genesi/attest-mcp sg-attest verify ./work.png --hash <sha256>
```

(`-p` is required: `sg-attest` is a secondary `bin` of the package, and plain
`npx -y @spazio-genesi/attest-mcp` runs the MCP server instead.)

One advantage over the site: **no 1 GB cap**. The browser is limited by
WebCrypto (which loads the whole file into memory); this CLI streams from
disk on Node, so it can attest files of any size.

| Command | What it does | Credential |
|---|---|---|
| `attest <file> [--title --author --year --note] [--pdf <out>]` | Hash locally (streamed) → attest → print fingerprint, attestation, HMAC. Nothing is archived and no `/c/<hash>` page exists without `--pdf`; only `--pdf <out>` mints the signed certificate **and** prints the verification link | Yes |
| `verify <file> [--hash <sha256>]` | Hash locally; with `--hash`, compares (exit 2 if different); also reports archive/anchor status | No |
| `verify-cert --hash --attestazione --hmac [--titolo --autore --anno --note]` | Verifies a certificate's HMAC signature, no local file involved | No |
| `cert <hash> [-o <file.pdf>]` | Recovers an already-archived certificate | No |
| `anchor <hash> [-o <file.ots>]` | Checks/downloads the OpenTimestamps (Bitcoin) proof | No |
| `status` | Traffic-light status of the service | No |
| `authorize` | Device flow: prints a URL to approve, polls, saves the token | — |
| `--version` / `--help` | Version (from `package.json`) and usage | — |

Every command accepts `--json` (emits one JSON object on stdout, for scripting)
and `--quiet` (reduces non-essential human-readable output). Errors go to
stderr; the CLI never prints a credential (API key or session token) to
stdout, stderr, or `--json` output — same discipline as the MCP server.

**Exit codes** (a stable contract, for CI/scripting):

| Code | Meaning |
|---|---|
| `0` | Success / positive outcome |
| `1` | Operational error (network, auth, bad input) |
| `2` | Negative verification outcome (hash mismatch, invalid signature) |

Authentication is the same as the MCP server: `IMGAUTH_API_KEY` env var, or a
session token saved by `sg-attest authorize` (device flow). There is no
`--key` flag — a credential on the command line ends up in shell history; use
the env var (or a CI secret) instead.

A GitHub Action that uses this CLI to attest build artifacts in CI lives in a
companion repo: [`attest-action`](https://github.com/SPAZIO-GENESI/attest-action).

### Standalone binaries (no Node required)

For a machine or CI runner without Node.js, download a pre-compiled `sg-attest`
executable from the [Releases page](https://github.com/SPAZIO-GENESI/attest-mcp/releases) —
same commands, same behavior, nothing to install.

| OS | Architecture | File |
|---|---|---|
| Linux | x64 | `sg-attest-linux-x64` |
| Linux | arm64 | `sg-attest-linux-arm64` |
| macOS | Intel | `sg-attest-macos-x64` |
| macOS | Apple Silicon | `sg-attest-macos-arm64` |
| Windows | x64 | `sg-attest-windows-x64.exe` |
| Windows | ARM64 | `sg-attest-windows-arm64.exe` |

Each release also includes `SHA256SUMS.txt`. Verify the download before running it:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing   # Linux/macOS
```

```powershell
(Get-FileHash .\sg-attest-windows-x64.exe -Algorithm SHA256).Hash   # compare by eye to SHA256SUMS.txt
```

⚠️ The binaries are **not code-signed**: expect an "unknown publisher" warning
from Windows SmartScreen or macOS Gatekeeper the first time you run one. The
checksum above is the integrity guarantee in the meantime — the binary is
built and published by [GitHub Actions](.github/workflows/release-binaries.yml)
directly from this repo's source, nothing hand-uploaded.

Usage is identical to the npm-installed CLI, just call the file directly:

```bash
chmod +x ./sg-attest-linux-x64          # Linux/macOS only
./sg-attest-linux-x64 attest ./work.png --pdf cert.pdf
./sg-attest-linux-x64 status
```

`npx`/`npm` remain the primary distribution channel (and what `attest-action`
uses in CI) — the binaries are an additional channel, not a replacement.

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
npm test          # unit tests (hash vectors, CLI argument parsing)
IMGAUTH_BASE_URL=http://localhost:8787 npm start   # MCP server against a local `wrangler dev`
IMGAUTH_BASE_URL=http://localhost:8787 node src/cli.js status   # CLI against the same
```

`test/cli-smoke.local.mjs` is a local-only harness (not run by `npm test`) that
exercises every `sg-attest` command end-to-end against an isolated `wrangler dev`
imgauth instance — see the header comment in that file for the required env vars.

## Security

Report vulnerabilities → [`/sicurezza/`](https://attestazione.spaziogenesi.org/sicurezza/)
(responsible disclosure policy, safe harbor for good-faith research) — this
repo has no `security.txt` of its own (npm package, no static assets), but
the policy covers the whole project.

## License

MIT — see [LICENSE](LICENSE). This is a client for the attestation service; the
service itself ([imgauth](https://github.com/SPAZIO-GENESI/imgauth)) is AGPL-3.0.
