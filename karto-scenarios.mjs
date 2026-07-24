#!/usr/bin/env node
// karto-scenarios.mjs — scénarios de résilience « what-if ».
//
// Étend le rayon d'impact (karto_impact) en SCÉNARIOS nommés et comparables :
// « si X tombe, qu'est-ce qui casse, combien ça coûte, quels secrets/automatisations
// sont touchés ». Source softcode : data/scenarios.json. LECTURE SEULE.
//
//   node karto-scenarios.mjs            -> tous les scénarios + comparaison
//   node karto-scenarios.mjs vps-down   -> un scénario (par id/label/nom de nœud)
//
// Réutilisé par le MCP (karto_scenario) et bakable au dashboard (model.scenarios).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './karto-sqlite.mjs';

const AUTO_KINDS = new Set(['automation', 'launchagent', 'scenario', 'webhook']);

function makeResolver(db) {
  return token => {
    let r = db.prepare('SELECT * FROM entity WHERE id = ?').get(token);
    if (r) return r;
    const t = String(token || '').toLowerCase();
    return db.prepare('SELECT * FROM entity WHERE canonical = ?').get(t)
      || db.prepare('SELECT * FROM entity WHERE lower(name) = ?').get(t)
      || db.prepare("SELECT * FROM entity WHERE canonical LIKE ? ORDER BY length(name) LIMIT 1").get('%' + t + '%')
      || db.prepare("SELECT * FROM entity WHERE id LIKE ? LIMIT 1").get('%' + t + '%');
  };
}

// rayon d'impact transitif (arêtes ENTRANTES = dépendants) à partir d'un ensemble de racines
function blast(db, rootIds, depth = 6) {
  const seen = new Set(rootIds); let frontier = [...rootIds]; const impacted = [];
  const stmt = db.prepare('SELECT e.rel, e.src id, x.name, x.kind, x.cout FROM edge e LEFT JOIN entity x ON x.id=e.src WHERE e.dst=?');
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const id of frontier) for (const e of stmt.all(id)) {
      if (!e.id || seen.has(e.id)) continue; seen.add(e.id); next.push(e.id);
      impacted.push({ id: e.id, name: e.name, kind: e.kind, cout: e.cout, depth: d + 1 });
    }
    frontier = next;
  }
  return impacted;
}

export function computeScenario(db, scn, depth = 6) {
  // cas spécial : compromission du coffre → tous les secrets référencés
  if (scn.type === 'secrets-all') {
    const total = db.prepare('SELECT COUNT(*) n FROM secret_ref').get().n;
    const byCat = db.prepare('SELECT category, COUNT(*) n FROM secret_ref GROUP BY category').all();
    return {
      id: scn.id, label: scn.label, note: scn.note || null, kind: 'secrets',
      unresolved: [], roots: [], blastRadius: total,
      byKind: [{ kind: 'secret', n: total }],
      automations: [], costLost: 0,
      secrets: { count: total, byCategory: byCat },
      verdict: `${total} secret(s) exposé(s) — rotation générale requise.`
    };
  }
  const resolve = makeResolver(db);
  const roots = [], unresolved = [];
  for (const tok of (scn.nodes || [])) { const r = resolve(tok); if (r) roots.push(r); else unresolved.push(tok); }
  const rootIds = roots.map(r => r.id);
  const impacted = roots.length ? blast(db, rootIds, depth) : [];
  // agrégations
  const byKindMap = {}; for (const i of impacted) byKindMap[i.kind] = (byKindMap[i.kind] || 0) + 1;
  const byKind = Object.entries(byKindMap).map(([kind, n]) => ({ kind, n })).sort((a, b) => b.n - a.n);
  const autos = impacted.filter(i => AUTO_KINDS.has(i.kind)).map(i => i.name);
  const allIds = [...rootIds, ...impacted.map(i => i.id)];
  const ph = allIds.map(() => '?').join(',') || "''";
  const secrets = allIds.length
    ? db.prepare(`SELECT name, service, owner_entity, category FROM secret_ref WHERE owner_entity IN (${ph})`).all(...allIds)
    : [];
  const costLost = roots.reduce((s, r) => s + (r.cout || 0), 0) + impacted.reduce((s, i) => s + (i.cout || 0), 0);
  return {
    id: scn.id, label: scn.label, note: scn.note || null, kind: 'topology',
    unresolved,
    roots: roots.map(r => ({ name: r.name, kind: r.kind })),
    blastRadius: impacted.length,
    byKind,
    automations: autos,
    costLost: Math.round(costLost),
    secrets: { count: secrets.length, list: secrets.map(s => ({ name: s.name, owner: s.owner_entity, category: s.category })) },
    impacted: impacted.sort((a, b) => a.depth - b.depth).map(i => ({ name: i.name, kind: i.kind, depth: i.depth })),
    verdict: roots.length
      ? `${impacted.length} composant(s) impacté(s)` + (autos.length ? `, ${autos.length} automatisation(s) cassée(s)` : '') + (secrets.length ? `, ${secrets.length} secret(s) à roter` : '') + (costLost ? `, ${costLost} €/mois en jeu` : '') + '.'
      : `Aucun nœud résolu (${unresolved.join(', ')}).`
  };
}

export function runScenarios(dir, only) {
  const db = openDb(join(dir, 'karto.db'), { readOnly: true });
  let defs = [];
  try { defs = JSON.parse(readFileSync(join(dir, 'data/scenarios.json'), 'utf8')).scenarios || []; } catch {}
  if (only) {
    const m = defs.find(s => s.id === only || (s.label || '').toLowerCase().includes(only.toLowerCase()));
    if (m) return [computeScenario(db, m)];
    return [computeScenario(db, { id: 'adhoc', label: `Chute de « ${only} »`, nodes: [only] })];  // ad-hoc : nom de nœud direct
  }
  const results = defs.map(s => computeScenario(db, s));
  results.sort((a, b) => b.blastRadius - a.blastRadius);
  return results;
}

/* ---------- CLI ---------- */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dir = dirname(fileURLToPath(import.meta.url));
  if (!existsSync(join(dir, 'karto.db'))) { console.error('✗ karto.db absent — lance `node karto-db.mjs build`.'); process.exit(1); }
  const only = process.argv.slice(2).find(a => !a.startsWith('--'));
  const res = runScenarios(dir, only);
  if (process.argv.includes('--json')) { console.log(JSON.stringify(res, null, 2)); }
  else {
    console.log('\n  Scénarios de résilience — du plus large au plus contenu :\n');
    for (const r of res) {
      const tag = r.unresolved && r.unresolved.length ? ' ⚠' : '';
      console.log(`  ▸ ${r.label}${tag}`);
      console.log(`      ${r.verdict}`);
      if (r.byKind && r.byKind.length) console.log(`      impact: ${r.byKind.map(k => `${k.n} ${k.kind}`).join(' · ')}`);
      if (r.automations && r.automations.length) console.log(`      automatisations cassées: ${r.automations.slice(0, 6).join(', ')}${r.automations.length > 6 ? '…' : ''}`);
      console.log('');
    }
  }
}
