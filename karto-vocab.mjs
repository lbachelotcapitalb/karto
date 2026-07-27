#!/usr/bin/env node
// karto-vocab.mjs — LE vocabulaire de karto, en un seul endroit (roadmap D1).
//
// Pourquoi ce fichier existe : avant lui, « qu'est-ce qu'une automatisation ? » avait QUATRE
// réponses différentes dans quatre fichiers (karto-db, karto-scenarios, karto-diagnostics,
// gouvernance), et aucune des trois périphériques n'incluait les 41 crons du VPS. Une liste
// recopiée diverge ; une liste importée, non.
//
// Il fait trois choses, toutes pilotées par data/karto_vocabulary.json :
//   1. NORMALISER à l'ingestion (kind fusionné, rel re-typé, casse/accents des valeurs) ;
//   2. SIGNALER toute valeur inconnue au lieu de l'écrire en silence — une valeur inventée
//      par un collecteur doit se voir au build, pas six mois plus tard dans un GROUP BY ;
//   3. GÉNÉRER les contraintes CHECK de karto.db, pour que la base refuse elle-même ce que
//      le vocabulaire n'autorise pas. La preuve de D1 est ce refus.
//
// Le fichier JSON est la source de vérité. Ce module ne contient AUCUNE valeur en dur.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
export const VOCAB = JSON.parse(readFileSync(join(__dir, 'data', 'karto_vocabulary.json'), 'utf8'));

const noDoc = o => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !k.startsWith('_')));

export const KINDS = new Set(Object.keys(noDoc(VOCAB.kinds)));
export const RELS = new Set(Object.keys(noDoc(VOCAB.rels)));
export const RUNNERS = new Set(Object.keys(noDoc(VOCAB.runners)));
const FUSED_KINDS = noDoc(VOCAB.kindsFusionnes);
const FUSED_RELS = noDoc(VOCAB.relsSupprimes);
const COL = VOCAB.colonnes;

/* ─────────────────────────────────────────────────────────────────────────────
 * LA définition unique de « ce qui s'exécute ».
 * Importée par karto-db.mjs (rattachement des runs), karto-scenarios.mjs (rayon
 * d'impact), karto-diagnostics.mjs (dimension IA) et gouvernance.mjs (paliers).
 * Depuis la fusion des kinds, cron / launchd / make / webhook sont des `runner`
 * d'`automation` : la distinction qui justifiait quatre listes n'existe plus.
 * ──────────────────────────────────────────────────────────────────────────── */
export const EXECUTABLE_KINDS = new Set(['automation', 'agent', 'workload']);
export const isExecutable = kind => EXECUTABLE_KINDS.has(kind);

/* ─── Journal des valeurs hors vocabulaire ───────────────────────────────────
 * On ne jette pas et on ne devine pas : on garde la valeur d'origine et on la
 * signale en fin de build, avec sa provenance. C'est la règle du lot B : un
 * signal qu'on ne peut pas produire ne s'invente pas, mais un écart se dit. */
const unknowns = new Map();   // "niveau|champ=valeur" -> { niveau, champ, valeur, source, n }
// niveau 'inconnu' = personne n'a su la classer, le CHECK la rejettera → avertissement.
// niveau 'traite'  = normalisée ou relocalisée volontairement → compte rendu, PAS une alerte.
// Les mélanger produirait un rapport qui crie sur ce qui a fonctionné, et qu'on apprend
// donc à ignorer — le défaut exact des 26 fausses alertes de B1.
function flag(champ, valeur, source, niveau = 'inconnu') {
  const k = niveau + '|' + champ + '=' + valeur;
  const hit = unknowns.get(k);
  if (hit) { hit.n++; return; }
  unknowns.set(k, { niveau, champ, valeur, source: source || '?', n: 1 });
}
export const vocabReport = (niveau = 'inconnu') =>
  [...unknowns.values()].filter(u => u.niveau === niveau).sort((a, b) => b.n - a.n);

/* ─── Kinds ──────────────────────────────────────────────────────────────── */
// Renvoie { kind, attr?, valeur? } : le kind cible, et l'attribut qui doit porter
// la distinction supprimée par la fusion (runner, role, type, nature).
export function normKind(kind, source) {
  const f = FUSED_KINDS[kind];
  if (f) return { kind: f.vers, attr: f.attr, valeur: f.valeur };
  if (!KINDS.has(kind)) { flag('kind', kind, source); return { kind }; }
  return { kind };
}

/* ─── Relations ──────────────────────────────────────────────────────────── */
// Renvoie { rel, aRetyper? } ou null si la relation est à omettre.
export function normRel(rel, source) {
  const r = String(rel || '').trim();
  if (RELS.has(r)) return { rel: r };
  const f = FUSED_RELS[r];
  if (f) return { rel: f.vers, aRetyper: r === 'lié' || undefined };
  // `se connecte·` sans type (agents.json peut fournir un type vide) : inexploitable,
  // mais on le dit plutôt que de créer une relation au libellé tronqué.
  if (/^se connecte·?$/.test(r)) { flag('rel', 'se connecte· (type vide)', source); return null; }
  flag('rel', r, source);
  return { rel: r };
}

/* ─── Valeurs de colonnes ────────────────────────────────────────────────── */
// `silencieux: true` = simple test d'appartenance, sans journaliser : utilisé par splitStatut
// pour SONDER une valeur avant de la découper. Sans ça, une valeur finalement bien traitée
// serait quand même signalée comme inconnue.
function normEnum(colKey, value, source, { champ, silencieux = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const spec = COL[colKey];
  const raw = String(value).trim();
  if (spec.valeurs.includes(raw)) return raw;
  const table = spec.normalise || {};
  if (table[raw]) return table[raw];
  // repli insensible à la casse/aux accents, sur la table de normalisation ET sur l'enum
  const fold = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  for (const [from, to] of Object.entries(table)) if (fold(from) === fold(raw)) return to;
  for (const v of spec.valeurs) if (fold(v) === fold(raw)) return v;
  if (spec.ouvert) return raw;              // enum ouvert (domaine métier, owner) : on accepte
  if (!silencieux) flag(champ || colKey, raw, source);
  return raw;                                // conservé tel quel : le CHECK le rejettera, bruyamment
}

export const normStatut = (v, source) => normEnum('statut', v, source);
export const normCriticite = (v, source) => normEnum('criticite', v, source);
export const normCycle = (v, source) => normEnum('cycle', v, source);
export const normOwner = (v, source) => normEnum('owner', v, source);
export const normStore = (v, source) => normEnum('store', v, source);
export const normCategory = (v, source) => normEnum('category', v, source);
export const normSeverity = (v, source) => normEnum('severity', v, source);
export const normBridgeStatus = (v, source) => normEnum('bridgeStatus', v, source);
export const normSourceStatus = (v, source) => normEnum('sourceStatus', v, source);

// `domaine` : enum ouvert (une nouvelle ligne d'activité est une décision métier légitime,
// pas un défaut). Le seul contrôle est le motif qui a réellement pollué la colonne : un nom
// DNS rangé dans un champ de domaine métier.
export function normDomaine(v, source) {
  if (!v) return null;
  const raw = String(v).trim();
  // Déplacement VOULU (le nom DNS rejoint `url`), pas un échec de classement : niveau 'traite'.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(raw)) { flag('domaine → url (nom DNS)', raw, source, 'traite'); return null; }
  return normEnum('domaine', raw, source);
}

// `statut` en prose : une phrase n'est pas un statut. On garde le premier terme s'il est
// reconnu et on renvoie le reste à l'appelant, qui le range dans attrs.note.
export function splitStatut(v, source) {
  if (!v) return { statut: null, note: null };
  const raw = String(v).trim();
  // ⚠ normEnum renvoie la valeur BRUTE quand elle est inconnue (pour que le CHECK la rejette
  // bruyamment plutôt que de la voir disparaître) : elle est donc toujours truthy. Tester sa
  // seule vérité laissait passer « Actif (clé à roter) », 19 caractères, sans le découper.
  const known = s => { const r = normEnum('statut', s, source, { silencieux: true }); return COL.statut.valeurs.includes(r) ? r : null; };
  const direct = known(raw);
  if (direct) return { statut: direct, note: null };
  const m = raw.match(/^([^—(,;]+)\s*[—(,;]\s*(.+)$/);
  if (m) {
    const head = known(m[1].trim());
    // découpage réussi : la prose part dans attrs.note, ce n'est pas un défaut mais un traitement
    if (head) { flag('statut (prose découpée)', raw.slice(0, 60) + (raw.length > 60 ? '…' : ''), source, 'traite'); return { statut: head, note: m[2].replace(/\)$/, '').trim() }; }
  }
  return { statut: normStatut(raw, source), note: null };
}

/* ─── Génération des contraintes CHECK ───────────────────────────────────────
 * Les CHECK sont DÉRIVÉES du vocabulaire, jamais recopiées : c'est la seule façon
 * qu'éditer data/karto_vocabulary.json suffise. Les enums ouverts (domaine, owner)
 * n'en reçoivent pas — une contrainte y rejetterait une décision métier légitime. */
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const inList = vals => vals.map(q).join(',');
export function checkFor(column, colKey, { nullable = true } = {}) {
  const vals = colKey === 'kind' ? [...KINDS] : colKey === 'rel' ? [...RELS] : COL[colKey].valeurs;
  const body = `${column} IN (${inList(vals)})`;
  return nullable ? `CHECK (${column} IS NULL OR ${body})` : `CHECK (${body})`;
}

export const CHECKS = {
  entityKind: checkFor('kind', 'kind', { nullable: false }),
  entityStatut: checkFor('statut', 'statut'),
  entityCriticite: checkFor('criticite', 'criticite'),
  entityCycle: checkFor('cycle', 'cycle'),
  edgeRel: checkFor('rel', 'rel'),
  secretStore: checkFor('store', 'store'),
  secretCategory: checkFor('category', 'category'),
  exposureSeverity: checkFor('severity', 'severity'),
  bridgeStatus: checkFor('status', 'bridgeStatus'),
  sourceStatus: checkFor('status', 'sourceStatus'),
};

/* ─── CLI : `node karto-vocab.mjs` affiche le vocabulaire en vigueur ───────── */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const n = o => Object.keys(noDoc(o)).length;
  console.log(`Vocabulaire karto — source : data/karto_vocabulary.json`);
  console.log(`  kinds        ${n(VOCAB.kinds)}  (${n(VOCAB.kindsFusionnes)} fusionnés : ${Object.keys(FUSED_KINDS).join(', ')})`);
  console.log(`  rels         ${n(VOCAB.rels)}  (${n(VOCAB.relsSupprimes)} retirés : ${Object.keys(FUSED_RELS).join(', ')})`);
  console.log(`  runners      ${n(VOCAB.runners)}`);
  console.log(`  exécutables  ${[...EXECUTABLE_KINDS].join(', ')}   ← LA définition, importée par 4 fichiers`);
  for (const [k, spec] of Object.entries(noDoc(VOCAB.colonnes))) {
    console.log(`  ${k.padEnd(13)}${spec.valeurs.length} valeur(s)${spec.ouvert ? ' (enum ouvert — pas de CHECK)' : ''} : ${spec.valeurs.join(' · ')}`);
  }
  console.log(`\nContraintes générées :`);
  for (const [k, v] of Object.entries(CHECKS)) console.log(`  ${k.padEnd(18)} ${v.slice(0, 110)}${v.length > 110 ? '…' : ''}`);
}
