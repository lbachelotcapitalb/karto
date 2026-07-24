#!/usr/bin/env node
// clouds-probe.mjs — sonde l'EXISTENCE réelle des clouds « incertains » du répertoire des
// sources (status probe : Vercel, Netlify, Railway…) via leurs CLIs, et reverse le verdict
// dans data/sources.json (status ok/absent + note). Zéro secret : whoami/status only.
//
//   node clouds-probe.mjs

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { ingest } from './karto-ingest.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const sh = (bin, args) => { try { return { out: execFileSync(bin, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; } catch (e) { return { err: (e.code === 'ENOENT') ? 'CLI absent' : String(e.stderr || e.message || '').trim().slice(0, 120) }; } };

const PROBES = [
  { id: 'vercel', bin: 'vercel', args: ['whoami'] },
  { id: 'netlify', bin: 'netlify', args: ['api', 'getCurrentUser'], pick: out => { try { return 'login ' + (JSON.parse(out).email || '?'); } catch { return out.split('\n')[0]; } } },
  { id: 'railway', bin: 'railway', args: ['whoami'] },
];

for (const p of PROBES) {
  const r = sh(p.bin, p.args);
  let status, note;
  if (r.err === 'CLI absent') { status = 'probe'; note = `CLI ${p.bin} absent de la machine — existence du compte à vérifier autrement (navigateur/email).`; }
  else if (r.err) { status = 'probe'; note = `CLI présent mais non authentifié (${r.err.split('\n')[0]}) — compte incertain.`; }
  else { status = 'manual'; note = `Compte confirmé via ${p.bin} : ${(p.pick ? p.pick(r.out) : r.out.split('\n')[0]).slice(0, 100)}. Collecteur de projets à brancher.`; }
  const res = ingest('source-status', { id: p.id, status, note });
  console.log(`${res.ok ? '✓' : '✗'} ${p.id} → ${status} — ${note}`);
}
