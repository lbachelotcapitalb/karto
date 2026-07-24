#!/usr/bin/env node
// gouvernance.mjs — table de gouvernance agentique (paliers d'autonomie × risques).
// Joint karto.db (entités automation/launchagent/scenario) avec l'overlay softcode
// data/gouvernance_agentique.json (clé = bout unique du nom, 1er match gagne).
// Zéro dépendance. Lecture seule.
//
//   node gouvernance.mjs            # table Markdown groupée par palier + trous de couverture
//   node gouvernance.mjs --json     # sortie machine (pour le cron hebdo karto / le canal d'alerte)
//
// Exporte computeGouvernance(dir) — réutilisé par build.mjs (badges + matrice de l'onglet
// Agents) et le cron hebdo. Mise à jour de la classification : éditer le JSON, pas ce fichier.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './karto-sqlite.mjs';

export function computeGouvernance(dir) {
  const overlay = JSON.parse(readFileSync(join(dir, 'data', 'gouvernance_agentique.json'), 'utf8'));
  const govKeys = Object.keys(overlay.gov); // ordre du fichier = priorité (spécifique en premier)
  const PALIER_ORDER = overlay._meta.enums.palier;

  const db = openDb(join(dir, 'karto.db'), { readOnly: true });
  const rows = db.prepare(
    "SELECT kind, name FROM entity WHERE kind IN ('automation','launchagent','scenario') ORDER BY kind, name"
  ).all();
  db.close();

  const classify = name => {
    const lc = name.toLowerCase();
    for (const k of govKeys) if (lc.includes(k.toLowerCase())) return { key: k, ...overlay.gov[k] };
    return null;
  };

  // launchagents dont l'automation homonyme est déjà classée = doublons de vue, on les fusionne
  const seen = new Map(); // name(lc) -> entry
  const uncovered = [];
  for (const r of rows) {
    const gov = classify(r.name);
    if (!gov) { uncovered.push(`${r.kind} · ${r.name}`); continue; }
    const id = r.name.toLowerCase();
    if (!seen.has(id)) seen.set(id, { name: r.name, kind: r.kind, ...gov });
  }
  const entries = [...seen.values()];
  return {
    generatedFrom: 'karto.db + data/gouvernance_agentique.json',
    palierOrder: PALIER_ORDER,
    palierDoc: overlay._meta.palierDoc,
    counts: Object.fromEntries(PALIER_ORDER.map(p => [p, entries.filter(e => e.palier === p).length])),
    entries, uncovered,
  };
}

/* ---------- CLI ---------- */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const ROOT = dirname(fileURLToPath(import.meta.url));
  const asJson = process.argv.includes('--json');
  const g = computeGouvernance(ROOT);

  if (asJson) { console.log(JSON.stringify(g, null, 2)); process.exit(0); }

  const W = { 'publie-auto': '🔴', 'write-back': '🟠', draft: '🟡', outil: '🔵', lecture: '🟢', infra: '⚪', 'a-qualifier': '❓' };
  console.log('# Gouvernance agentique — paliers d’autonomie × risques\n');
  console.log(`_${g.entries.length} automatisations classées, ${g.uncovered.length} non couvertes. Source : data/gouvernance_agentique.json._\n`);
  for (const palier of g.palierOrder) {
    const group = g.entries.filter(e => e.palier === palier);
    if (!group.length) continue;
    console.log(`## ${W[palier] || ''} ${palier} — ${g.palierDoc[palier]}\n`);
    console.log('| Automatisation | Risque dominant | Relecture humaine | Continuité d’état | Trace |');
    console.log('|---|---|---|---|---|');
    for (const e of group) {
      const note = e.note ? ` — _${e.note}_` : '';
      console.log(`| **${e.name}**${note} | ${e.risque} | ${e.relecture} | ${e.continuite || '—'} | ${e.trace} |`);
    }
    console.log('');
  }
  if (g.uncovered.length) {
    console.log('## ⚠️ Non couvertes (à classer dans gouvernance_agentique.json)\n');
    for (const u of g.uncovered) console.log(`- ${u}`);
  }
}
