#!/usr/bin/env node
import { basename } from "node:path";
import { writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { hashFile } from "./hash.js";
import { saveCredentials } from "./config.js";
import {
  ApiError,
  attestHash,
  mintCertificatePdf,
  recoverCertificatePdf,
  verifyClaim,
  checkAnchor,
  checkArchived,
  serviceStatus,
  startAuthorize,
  pollAuthorizeToken,
  permanentUrl,
} from "./api.js";

// Single source of truth for the version: package.json (never hardcoded —
// lesson from attest-mcp 0.2.2, see CLAUDE.md).
const { version: VERSION } = createRequire(import.meta.url)("../package.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Thrown for bad invocations (unknown flag, missing required argument) —
// distinct from ApiError (network/auth) and any other runtime failure, so
// main() can report it without the "run authorize" hint meant for API errors.
class CliUsageError extends Error {}

// ── argument parsing — no new dependency ────────────────────────────────────
// `spec` maps a flag's long name to { boolean?, alias? }. Positionals are
// whatever isn't consumed as a flag or its value. `--` stops flag parsing.
function parseFlags(argv, spec) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let name;
    let inlineValue;
    if (tok.startsWith("--")) {
      const rest = tok.slice(2);
      const eq = rest.indexOf("=");
      name = eq === -1 ? rest : rest.slice(0, eq);
      if (eq !== -1) inlineValue = rest.slice(eq + 1);
    } else if (tok.startsWith("-") && tok.length > 1) {
      const alias = tok.slice(1);
      name = Object.keys(spec).find((key) => spec[key].alias === alias);
      if (!name) throw new CliUsageError(`Opzione sconosciuta: ${tok}`);
    } else {
      positionals.push(tok);
      continue;
    }
    const def = spec[name];
    if (!def) throw new CliUsageError(`Opzione sconosciuta: --${name}`);
    if (def.boolean) {
      flags[name] = true;
      continue;
    }
    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new CliUsageError(`--${name} richiede un valore`);
    flags[name] = value;
  }
  return { flags, positionals };
}

const GLOBAL_SPEC = {
  json: { boolean: true },
  quiet: { boolean: true },
  help: { boolean: true, alias: "h" },
};

function mergeSpec(spec) {
  return { ...GLOBAL_SPEC, ...spec };
}

// ── output helpers ───────────────────────────────────────────────────────────
function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function printLines(lines) {
  console.log(lines.filter((l) => l !== null && l !== undefined).join("\n"));
}

function reportError(err) {
  const message =
    err instanceof ApiError ? [err.message, err.hint].filter(Boolean).join(" ") : err?.message || String(err);
  console.error(message);
}

// ── commands ─────────────────────────────────────────────────────────────────
async function cmdAttest(argv) {
  const { flags, positionals } = parseFlags(
    argv,
    mergeSpec({ title: {}, author: {}, year: {}, note: {}, pdf: {} })
  );
  if (flags.help) {
    printLines([
      "Uso: sg-attest attest <file> [--title <t>] [--author <a>] [--year <y>] [--note <n>] [--pdf <out.pdf>]",
      "",
      "Calcola l'impronta SHA-256 del file in locale (streaming, mai inviato) e la attesta.",
      "Richiede una credenziale: IMGAUTH_API_KEY oppure 'sg-attest authorize'.",
      "Con --pdf, scarica anche il certificato firmato nel percorso indicato.",
    ]);
    return;
  }
  const file = positionals[0];
  if (!file) throw new CliUsageError("Serve il percorso di un file: sg-attest attest <file>");

  const { sha256, size } = await hashFile(file);
  const attestation = await attestHash({
    sha256,
    name: basename(file),
    size,
    titolo: flags.title,
    autore: flags.author,
    anno: flags.year,
    note: flags.note,
  });

  let certSavedTo = null;
  let certBytes = 0;
  if (flags.pdf) {
    const bytes = await mintCertificatePdf(attestation);
    await writeFile(flags.pdf, bytes);
    certSavedTo = flags.pdf;
    certBytes = bytes.length;
  }

  const result = { ...attestation, permanent_url: permanentUrl(sha256), certificate_saved_to: certSavedTo };

  if (flags.json) {
    printJson(result);
    return;
  }
  printLines([
    `Impronta:      ${attestation.sha256}`,
    `Attestazione:  ${attestation.attestazione}`,
    `Emesso:        ${attestation.timestamp_leggibile || attestation.timestamp_iso}`,
    `Firma HMAC:    ${attestation.hmac}`,
    `Verifica:      ${permanentUrl(sha256)}`,
    certSavedTo ? `Certificato:   ${certSavedTo} (${certBytes} byte)` : null,
  ]);
}

async function cmdVerify(argv) {
  const { flags, positionals } = parseFlags(argv, mergeSpec({ hash: {} }));
  if (flags.help) {
    printLines([
      "Uso: sg-attest verify <file> [--hash <sha256>]",
      "",
      "Calcola l'impronta del file in locale; con --hash la confronta (exit 2 se diversa).",
      "Controlla anche se l'impronta è in archivio e se ha una prova di ancoraggio.",
    ]);
    return;
  }
  const file = positionals[0];
  if (!file) throw new CliUsageError("Serve il percorso di un file: sg-attest verify <file>");

  const { sha256 } = await hashFile(file);
  const declared = flags.hash ? String(flags.hash).toLowerCase() : null;
  const coincide = declared ? sha256.toLowerCase() === declared : null;

  const [archiviato, ancoraggio] = await Promise.all([checkArchived(sha256), checkAnchor(sha256)]);

  const result = {
    file,
    hash_calcolato_locale: sha256,
    hash_dichiarato: declared,
    coincide,
    in_archivio: archiviato,
    ancorato: ancoraggio.exists,
    permanent_url: permanentUrl(sha256),
  };

  if (flags.json) {
    printJson(result);
  } else {
    printLines([
      `File:          ${file}`,
      `Impronta:      ${sha256}`,
      `Dichiarata:    ${declared || "—"}`,
      `Coincide:      ${coincide === null ? "n.d." : coincide ? "sì" : "no"}`,
      `In archivio:   ${archiviato ? "sì" : "no"}`,
      `Ancorata:      ${ancoraggio.exists ? "sì" : "no"}`,
      `Verifica:      ${permanentUrl(sha256)}`,
    ]);
  }
  if (coincide === false) process.exitCode = 2;
}

async function cmdVerifyCert(argv) {
  const { flags } = parseFlags(
    argv,
    mergeSpec({ hash: {}, attestazione: {}, hmac: {}, titolo: {}, autore: {}, anno: {}, note: {} })
  );
  if (flags.help) {
    printLines([
      "Uso: sg-attest verify-cert --hash <sha256> --attestazione <str> --hmac <str>",
      "                           [--titolo --autore --anno --note]",
      "",
      "Verifica la firma HMAC di un'attestazione (dati letti da un certificato), senza",
      "toccare alcun file locale — l'attestazione e l'hmac vanno copiati dal certificato.",
    ]);
    return;
  }
  for (const req of ["hash", "attestazione", "hmac"]) {
    if (!flags[req]) throw new CliUsageError(`--${req} è obbligatorio`);
  }
  const result = await verifyClaim({
    hash: flags.hash,
    attestazione: flags.attestazione,
    hmac: flags.hmac,
    titolo: flags.titolo,
    autore: flags.autore,
    anno: flags.anno,
    note: flags.note,
  });
  if (flags.json) printJson(result);
  else printLines([`Firma valida:  ${result.hmac_valido ? "sì" : "no"}`]);
  if (result.hmac_valido === false) process.exitCode = 2;
}

async function cmdCert(argv) {
  const { flags, positionals } = parseFlags(argv, mergeSpec({ output: { alias: "o" } }));
  if (flags.help) {
    printLines([
      "Uso: sg-attest cert <hash> [-o <file.pdf>]",
      "",
      "Recupera dall'archivio il certificato PDF già emesso per quell'impronta (nessuna credenziale richiesta).",
    ]);
    return;
  }
  const hash = positionals[0];
  if (!hash) throw new CliUsageError("Serve l'impronta: sg-attest cert <hash>");
  const bytes = await recoverCertificatePdf(hash);
  const outPath = flags.output || `./certificato_${hash.slice(0, 12)}.pdf`;
  await writeFile(outPath, bytes);
  const result = { saved_to: outPath, bytes: bytes.length, permanent_url: permanentUrl(hash) };
  if (flags.json) printJson(result);
  else printLines([`Salvato: ${outPath} (${bytes.length} byte)`]);
}

async function cmdAnchor(argv) {
  const { flags, positionals } = parseFlags(argv, mergeSpec({ output: { alias: "o" } }));
  if (flags.help) {
    printLines([
      "Uso: sg-attest anchor <hash> [-o <file.ots>]",
      "",
      "Controlla se esiste una prova OpenTimestamps (ancoraggio Bitcoin) per quell'impronta.",
    ]);
    return;
  }
  const hash = positionals[0];
  if (!hash) throw new CliUsageError("Serve l'impronta: sg-attest anchor <hash>");
  const result = await checkAnchor(hash);
  let savedTo = null;
  if (result.exists && flags.output) {
    await writeFile(flags.output, result.bytes);
    savedTo = flags.output;
  }
  const out = { exists: result.exists, saved_to: savedTo };
  if (flags.json) {
    printJson(out);
  } else {
    printLines([
      result.exists ? "Prova di ancoraggio: presente." : "Prova di ancoraggio: assente.",
      savedTo ? `Salvata: ${savedTo}` : result.exists && !flags.output ? "Usa -o <file.ots> per salvarla." : null,
    ]);
  }
}

async function cmdStatus(argv) {
  const { flags } = parseFlags(argv, mergeSpec({}));
  if (flags.help) {
    printLines(["Uso: sg-attest status", "", "Stato semaforico dei servizi (worker/archivio/firmatario/ancoraggio)."]);
    return;
  }
  const status = await serviceStatus();
  if (flags.json) {
    printJson(status);
  } else {
    printLines([
      `Worker:      ${status.worker}`,
      `Archivio:    ${status.archive}`,
      `Firmatario:  ${status.signer}`,
      `Ancoraggio:  ${status.anchor}`,
      `Rilevato:    ${status.checked_at}`,
    ]);
  }
}

async function cmdAuthorize(argv) {
  const { flags } = parseFlags(argv, mergeSpec({}));
  if (flags.help) {
    printLines([
      "Uso: sg-attest authorize",
      "",
      "Avvia il device flow: apri l'URL mostrato, approva con il widget anti-bot,",
      "la credenziale viene salvata in automatico (24h, 20 attestazioni).",
    ]);
    return;
  }
  const started = await startAuthorize();
  if (!flags.json && !flags.quiet) {
    printLines([
      `Apri questo URL e approva: ${started.verification_url}`,
      `Codice: ${started.code} (scade tra ${started.expires_in}s)`,
      "In attesa di approvazione…",
    ]);
  }
  const intervalMs = (started.interval || 3) * 1000;
  const deadline = Date.now() + (started.expires_in || 600) * 1000;
  let final = { status: "expired" };
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const polled = await pollAuthorizeToken(started.code);
    if (polled.status === "approved" && polled.token) {
      await saveCredentials({ token: polled.token, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
      final = { status: "approved" };
      break;
    }
    if (polled.status === "claimed" || polled.status === "expired" || polled.status === "error") {
      final = { status: polled.status };
      break;
    }
    // "pending" — keep polling until the deadline.
  }
  if (flags.json) printJson(final);
  else printLines([final.status === "approved" ? "Autorizzato. Credenziale salvata." : `Non autorizzato (${final.status}).`]);
  if (final.status !== "approved") process.exitCode = 1;
}

// ── entry point ──────────────────────────────────────────────────────────────
const COMMANDS = {
  attest: cmdAttest,
  verify: cmdVerify,
  "verify-cert": cmdVerifyCert,
  cert: cmdCert,
  anchor: cmdAnchor,
  status: cmdStatus,
  authorize: cmdAuthorize,
};

function printUsage() {
  printLines([
    "Uso: sg-attest <comando> [opzioni]",
    "",
    "Comandi:",
    "  attest <file>       Calcola l'impronta e attesta il file (richiede credenziale)",
    "  verify <file>       Calcola l'impronta; verifica corrispondenza/archivio/ancoraggio",
    "  verify-cert         Verifica la firma HMAC di un'attestazione (nessun file)",
    "  cert <hash>         Recupera il certificato PDF archiviato",
    "  anchor <hash>       Controlla la prova di ancoraggio OpenTimestamps",
    "  status              Stato dei servizi",
    "  authorize           Avvia il device flow e salva la credenziale",
    "",
    "Opzioni globali: --json  --quiet  --help/-h  --version/-v",
    "",
    "Credenziale: variabile IMGAUTH_API_KEY, oppure 'sg-attest authorize'.",
    "Full privacy: il file è letto solo per calcolarne l'impronta in streaming;",
    "nessun byte lascia questa macchina, in nessun comando. Nessun tetto di dimensione",
    "(a differenza del sito, che è vincolato a 1 GB da WebCrypto nel browser).",
    "",
    "Documentazione: https://github.com/SPAZIO-GENESI/attest-mcp#readme",
  ]);
}

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (!first || first === "help") {
    printUsage();
    return;
  }
  if (first === "--version" || first === "-v") {
    console.log(VERSION);
    return;
  }
  if (first === "--help" || first === "-h") {
    printUsage();
    return;
  }

  const handler = COMMANDS[first];
  if (!handler) {
    console.error(`Comando sconosciuto: ${first}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  try {
    await handler(argv.slice(1));
  } catch (err) {
    if (err instanceof CliUsageError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    reportError(err);
    process.exitCode = 1;
  }
}

// Only auto-run when executed directly (as the `sg-attest` bin) — importing
// this module for unit tests (parseFlags) must not trigger main() against
// the test runner's own argv.
//
// ⚠️ The comparison must resolve symlinks. On Linux/macOS npm links a bin as
// a SYMLINK in node_modules/.bin, so argv[1] is that link path while
// import.meta.url is the real file (the ESM loader resolves symlinks): a plain
// string compare is false and main() never runs — the bin exits 0 in total
// silence. That shipped in 0.3.0 and broke every npx invocation off Windows.
function invokedAsBin() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  if (entry === self) return true;
  try {
    return realpathSync(entry) === self;
  } catch {
    return false;
  }
}

if (invokedAsBin()) {
  main();
}

export { parseFlags, CliUsageError, COMMANDS };
