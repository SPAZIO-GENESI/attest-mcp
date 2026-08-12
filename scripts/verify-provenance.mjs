#!/usr/bin/env node
// Verifica indipendente dell'attestazione di provenienza SLSA/in-toto su un
// binario di sg-attest, SENZA `gh` autenticato: solo l'endpoint REST pubblico
// delle attestazioni di GitHub (nessun token) e le librerie Sigstore, che a
// loro volta verificano contro l'infrastruttura pubblica di Sigstore (Rekor,
// Fulcio, TUF) — anch'essa senza credenziali. Vedi CTL-build-provenance nel
// registro GTF e ADR-A1 per il contesto completo.
//
// Uso, da un checkout di questo repo (dopo `npm install`):
//   node scripts/verify-provenance.mjs <percorso-binario> \
//     --repo SPAZIO-GENESI/attest-mcp \
//     --tag v0.4.2 \
//     [--workflow release-binaries.yml]
//
// Uso standalone (senza clonare il repo): scarica solo questo file, poi
//   npm install sigstore
//   node verify-provenance.mjs <percorso-binario> --repo ... --tag ...
//
// Esce 0 se la verifica riesce, 1 altrimenti.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { verify as sigstoreVerify } from 'sigstore';

function parseArgs(argv) {
  const args = { workflow: 'release-binaries.yml' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') args.repo = argv[++i];
    else if (a === '--tag') args.tag = argv[++i];
    else if (a === '--workflow') args.workflow = argv[++i];
    else positional.push(a);
  }
  args.filePath = positional[0];
  if (!args.filePath || !args.repo || !args.tag) {
    console.error(
      'Uso: node verify-provenance.mjs <binario> --repo <owner>/<repo> --tag <vX.Y.Z> [--workflow <file.yml>]'
    );
    process.exit(2);
  }
  const [owner, repo] = args.repo.split('/');
  if (!owner || !repo) {
    console.error('--repo deve essere nella forma <owner>/<repo>');
    process.exit(2);
  }
  args.owner = owner;
  args.repo = repo;
  return args;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchAttestations(owner, repo, digestHex) {
  const url = `https://api.github.com/repos/${owner}/${repo}/attestations/sha256:${digestHex}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sg-attest-verify-provenance-script',
      // Nessun header Authorization: è esattamente il punto di questo script —
      // l'endpoint delle attestazioni è pubblico anche sui repository pubblici.
    },
  });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`GitHub API ha risposto ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  return body.attestations ?? [];
}

async function main() {
  const { filePath, owner, repo, tag, workflow } = parseArgs(process.argv.slice(2));

  const fileBytes = readFileSync(filePath);
  const digestHex = createHash('sha256').update(fileBytes).digest('hex');
  const fileName = basename(filePath);

  console.log(`Binario:  ${filePath}`);
  console.log(`SHA-256:  ${digestHex}`);
  console.log(
    `Richiesta (senza credenziali): GET api.github.com/repos/${owner}/${repo}/attestations/sha256:${digestHex}`
  );

  const attestations = await fetchAttestations(owner, repo, digestHex);
  if (attestations.length === 0) {
    console.error(
      "\nNessuna attestazione trovata per questo digest. Se il file dovrebbe essere" +
        ' esattamente quello pubblicato nella Release, questo significa che NON è stato' +
        ' costruito dal workflow attestato — un solo byte alterato cambia il digest e' +
        ' quindi la chiave stessa con cui si cerca l\'attestazione.'
    );
    process.exit(1);
  }
  console.log(`Trovate ${attestations.length} attestazione/i per questo digest.\n`);

  const expectedIssuer = 'https://token.actions.githubusercontent.com';
  const identityPattern = new RegExp(
    `^https://github\\.com/${escapeRegExp(owner)}/${escapeRegExp(repo)}/\\.github/workflows/${escapeRegExp(
      workflow
    )}@refs/tags/${escapeRegExp(tag)}$`
  );

  let verifiedOk = false;
  let lastError;

  for (const [i, att] of attestations.entries()) {
    try {
      // 1) Verifica crittografica del bundle Sigstore: catena di certificati
      // fino alla root Fulcio pubblica, inclusione nel transparency log Rekor
      // pubblico, identità del certificato (issuer OIDC + SAN del workflow).
      // Tutto contro infrastruttura Sigstore pubblica (via TUF), nessun account.
      const signer = await sigstoreVerify(att.bundle, {
        certificateIssuer: expectedIssuer,
        certificateIdentityURI: identityPattern,
      });

      // 2) Legame artefatto <-> attestazione, fatto esplicitamente a mano:
      // per un bundle DSSE (questo caso — un'attestazione, non una firma di
      // messaggio), sigstore.verify() NON confronta il digest dell'artefatto
      // con il subject dell'attestazione — verifica solo l'integrità interna
      // della busta DSSE (payload legato alla firma). Un bundle
      // crittograficamente valido resterebbe tale anche passando bytes
      // completamente estranei come artefatto: il legame va controllato qui,
      // leggendo il predicato in-toto e cercando un subject il cui digest
      // coincide con quello calcolato ora sul file scaricato. Si cerca per
      // DIGEST, non per nome file: il digest è ciò che è stato firmato, il
      // nome è solo un'etichetta (un file rinominato dopo il download resta
      // verificabile). Un nome diverso da quello atteso è comunque segnalato
      // sotto, perché può indicare un file "giusto nel contenuto" ma
      // scambiato di piattaforma (es. l'exe Windows rinominato come binario
      // Linux) — un avviso, non un fallimento della prova crittografica.
      const payload = JSON.parse(
        Buffer.from(att.bundle.dsseEnvelope.payload, 'base64').toString('utf8')
      );
      const subject = (payload.subject ?? []).find((s) => s.digest?.sha256 === digestHex);
      if (!subject) {
        const names = (payload.subject ?? []).map((s) => s.name).join(', ');
        throw new Error(
          `nessun subject in questa attestazione ha il digest del file (${digestHex}); subject presenti: ${names}`
        );
      }

      console.log(`Attestazione #${i}: verifica riuscita`);
      console.log(`  identità certificato : ${signer.identity?.subjectAlternativeName}`);
      console.log(`  issuer OIDC          : ${signer.identity?.extensions?.issuer}`);
      console.log(`  predicateType        : ${payload.predicateType}`);
      console.log(`  subject verificato   : ${subject.name} sha256:${subject.digest.sha256}`);
      if (subject.name !== fileName) {
        console.log(
          `  ATTENZIONE: il nome locale ("${fileName}") non corrisponde al nome attestato` +
            ` ("${subject.name}") — il contenuto è autentico, ma verificane la provenienza` +
            ' prima di considerarlo il file per la piattaforma che ti aspetti.'
        );
      }
      verifiedOk = true;
      break;
    } catch (err) {
      lastError = err;
      console.log(`Attestazione #${i}: fallita (${err.message})`);
    }
  }

  if (!verifiedOk) {
    console.error(`\nVerifica FALLITA. Ultimo errore: ${lastError?.message ?? 'sconosciuto'}`);
    process.exit(1);
  }

  console.log(
    '\nVerifica riuscita: questo file è stato costruito dal workflow e dal tag attesi,' +
      ' e nessuna credenziale è stata usata in nessun passo.'
  );
}

main().catch((err) => {
  console.error('Errore:', err.stack || err.message);
  process.exit(1);
});
