#!/usr/bin/env node
// karto-sources.mjs — helper du RÉPERTOIRE DES SOURCES (data/sources.json).
// Chaque collecteur estampille sa source à la fin de sa collecte : touchSource('mac-disk').
// La dimension Fraîcheur du diagnostic lit ensuite last_synced vs cadence_days par source.
//
//   import { touchSource } from './karto-sources.mjs';  touchSource(__dir, 'skills');
//   node karto-sources.mjs            → état de fraîcheur de toutes les sources (CLI)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const file = dir => join(dir, 'data', 'sources.json');

export function loadSources(dir) {
  try { return JSON.parse(readFileSync(file(dir), 'utf8')); } catch { return { sources: [] }; }
}

// Estampille last_synced=now (+ patch optionnel : status, note). Silencieux si la source
// n'existe pas — un collecteur ne doit jamais planter à cause du répertoire.
export function touchSource(dir, id, patch = {}) {
  if (!existsSync(file(dir))) return false;
  const reg = loadSources(dir);
  const s = (reg.sources || []).find(x => x.id === id);
  if (!s) return false;
  s.last_synced = new Date().toISOString();
  Object.assign(s, patch);
  writeFileSync(file(dir), JSON.stringify(reg, null, 2) + '\n');
  return true;
}

// Âge en jours (null si jamais synchronisée)
export const ageDays = s => s.last_synced ? Math.floor((Date.now() - new Date(s.last_synced)) / 86400000) : null;
// Une source est périmée si elle a une cadence attendue et que l'âge la dépasse (jamais synchro = périmée)
export const isStale = s => s.cadence_days != null && (ageDays(s) == null || ageDays(s) > s.cadence_days);

/* ---------- CLI : état de fraîcheur ---------- */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dir = dirname(fileURLToPath(import.meta.url));
  const { sources } = loadSources(dir);
  if (!sources.length) { console.error('✗ data/sources.json absent ou vide'); process.exit(1); }
  const icon = s => s.status === 'planned' ? '⏳' : s.status === 'probe' ? '❓' : isStale(s) ? '🔴' : s.last_synced ? '🟢' : '⚪';
  for (const s of sources) {
    const a = ageDays(s);
    console.log(`${icon(s)} ${s.id.padEnd(16)} ${String(a == null ? 'jamais' : a + ' j').padStart(8)}  ${s.status.padEnd(8)} ${s.name}`);
  }
}
