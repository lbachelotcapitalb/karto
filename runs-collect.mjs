#!/usr/bin/env node
// runs-collect.mjs — collecte l'ÉTAT RÉEL D'EXÉCUTION des automatisations (la « physiologie »).
// v1 : runs GitHub Actions (dernier run par workflow, via gh api). Les crons VPS suivront
// (export veille, phase 3) ; Make s'ingère en session via karto_ingest source=runs.
//
// Sortie : merge dans data/runs_summary.json via karto-ingest (clé = bout unique du nom
// d'automatisation « GHA <repo> · <workflow> ») → attrs.lastRun au prochain db build.
//
//   node runs-collect.mjs            → collecte + merge + estampille
//   node runs-collect.mjs --print    → montre ce qui serait mergé

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ingest } from './karto-ingest.mjs';
import { touchSource } from './karto-sources.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PRINT = process.argv.includes('--print');
const load = f => { try { return JSON.parse(readFileSync(join(__dir, 'data', f), 'utf8')); } catch { return null; } };

const cloud = load('cloud_inventory.json') || {};
const cgh = cloud.github || {};
// short name -> full name (owner/repo)
const fullOf = new Map((cgh.repos || []).map(r => [r.name.split('/').pop().toLowerCase(), r.name]));

const repos = [...new Set((cgh.actions || []).map(a => a.repo))];
const runs = [];
for (const short of repos) {
  const full = fullOf.get(String(short).toLowerCase());
  if (!full) { console.warn(`⚠ repo introuvable dans cloud.github.repos : ${short}`); continue; }
  let data;
  try { data = JSON.parse(execFileSync('gh', ['api', `repos/${full}/actions/runs?per_page=40`], { encoding: 'utf8', timeout: 30000 })); }
  catch (e) { console.warn(`⚠ gh api ${full} : ${String(e.message || e).slice(0, 80)}`); continue; }
  const latest = new Map();   // workflow name -> run le plus récent
  for (const r of (data.workflow_runs || [])) if (!latest.has(r.name)) latest.set(r.name, r);
  for (const [wf, r] of latest) {
    const dur = r.run_started_at && r.updated_at ? Math.round((new Date(r.updated_at) - new Date(r.run_started_at)) / 1000) : undefined;
    runs.push({
      key: `gha ${short} · ${wf}`,
      last_run: r.updated_at,
      status: r.conclusion === 'success' ? 'ok' : (r.status === 'in_progress' || r.status === 'queued') ? 'ok' : 'fail',
      ...(dur != null ? { duration_s: dur } : {}),
      note: r.conclusion || r.status,
      source: 'gha'
    });
  }
}

if (PRINT) { console.log(JSON.stringify(runs, null, 2)); process.exit(0); }
if (!runs.length) { console.log('∅ aucun run collecté'); process.exit(0); }
const r = ingest('runs', { runs });
if (r.error) { console.error('✗ ' + r.error); process.exit(1); }
touchSource(__dir, 'gha-runs', { status: 'ok', collector: 'node runs-collect.mjs' });
console.log(`✓ ${runs.length} run(s) GHA → runs_summary.json (created ${r.created} · updated ${r.updated}). Rebuild : node karto-db.mjs build`);
