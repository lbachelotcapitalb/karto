#!/usr/bin/env node
// agents-collect.mjs — nourrit la dimension softcode « agents » (data/agents.json) en ingérant les
// manifestes agent.json déclarés dans karto.config.json > agents.manifests[]. Les entrées manuelles
// (source:'manual', pour un agent sans manifeste encore) sont PRÉSERVÉES. Le schéma (_doc/_meta) du
// fichier est conservé tel quel. « Au fur et à mesure » : ajoute un agent.json à un projet + une ligne
// dans karto.config.json > agents.manifests, relance ce script (inclus dans karto-index.mjs).
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, 'data', 'agents.json');
const expandHome = p => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
const readJSON = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

const config = readJSON(join(__dir, 'karto.config.json')) || {};
const manifests = [...((config.agents && config.agents.manifests) || [])];

// AUTO-GLOB : découvre les agent.json à la racine des projets (scan.projectRoots) sans
// déclaration manuelle. manifests[] reste utile pour les emplacements hors racines
// (ex. un dossier applicatif hors ~/Desktop) ou pour forcer id/project.
const declared = new Set(manifests.map(m => expandHome(m.path)));
for (const rootRaw of ((config.scan && config.scan.projectRoots) || [])) {
  const root = expandHome(rootRaw);
  if (!existsSync(root)) continue;
  for (const d of readdirSync(root)) {
    const cand = join(root, d, 'agent.json');
    try { if (!statSync(join(root, d)).isDirectory()) continue; } catch { continue; }
    if (existsSync(cand) && !declared.has(cand)) { manifests.push({ id: null, project: d, path: cand, discovered: true }); declared.add(cand); }
  }
}

const EFFECT = { 'read-only': 'read', 'read-measure': 'measure', 'gated-write': 'write', 'gated-generate': 'generate' };
// Le libellé de l'hôte « vps » vient de la CONFIG, pas du code : un agent.json tiers qui déclare
// host:"vps" doit nommer LE VPS DE SON PROPRIÉTAIRE, pas celui de l'auteur de karto.
const HOST = { vps: (config.vps?.hostEntity || 'VPS'), local: 'local' };

// normalise un agent.json (schéma d'agent karto — cf. AGENTS.md) → entrée softcode karto
function normalize(m, src) {
  const skills = Array.isArray(m.skills) ? m.skills : [];
  const crons = Array.isArray(m.crons_live) ? m.crons_live : [];
  const conns = Array.isArray(m.connects_to) ? m.connects_to : [];

  const hosts = new Set();
  for (const c of conns) if (c.type === 'host' && c.name) hosts.add(c.name);
  for (const c of crons) if (c.host && HOST[c.host]) hosts.add(HOST[c.host]);
  if (m.data_stores && m.data_stores.backend === 'supabase' && !hosts.size) hosts.add('Supabase');

  const capabilities = skills.map(s => `${s.name}${s.effect ? ' — ' + s.effect : ''}`);
  const actions = skills.map(s => ({
    name: s.name,
    effect: EFFECT[s.effect] || 'read',
    desc: s.usage || (Array.isArray(s.channels) ? s.channels.join(', ') : '') || ''
  }));
  const chains = crons.map(c => ({
    id: c.id,
    status: 'live',
    desc: [c.schedule_utc, c.host && '@' + c.host, c.skill && '· ' + c.skill, c.role].filter(Boolean).join(' ')
  }));

  return {
    id: src.id || (m.name || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    name: m.name || src.id,
    summary: m.summary || '',
    status: m.status || 'actif',
    // D8 — conservés, alors qu'ils étaient jetés : `schema` dit dans quel FORMAT la fiche est
    // écrite (il doit être le même partout — trois valeurs différentes = trois vérités), et
    // `updated` dit de quand elle date. Sans eux, ni versionnage ni fraîcheur.
    schema: m.schema || null,
    updated: m.updated || null,
    source: 'manifest',
    project: src.project || m.name || null,
    manifest: src.path,
    host: [...hosts],
    capabilities,
    connects_to: conns.map(c => ({ type: c.type, name: c.name, note: c.note, ref: c.ref })),
    actions,
    chains,
    guardrails: Array.isArray(m.guardrails) ? m.guardrails : [],
    doc: (m.entrypoints && (m.entrypoints.human || m.entrypoints.agent)) || null
  };
}

const existing = readJSON(OUT) || {};
const manual = (existing.agents || []).filter(a => a.source === 'manual');

const manifestAgents = [];
for (const src of manifests) {
  const p = expandHome(src.path);
  if (!p || !existsSync(p)) { console.warn(`⚠ manifeste introuvable : ${src.path} (id ${src.id}) — ignoré`); continue; }
  const m = readJSON(p);
  if (!m) { console.warn(`⚠ manifeste illisible : ${src.path} — ignoré`); continue; }
  manifestAgents.push(normalize(m, src));
}

/* D8 — le `manifest` d'une entrée MANUELLE n'était jamais vérifié. Un manifeste déclaré
 * dans karto.config.json est contrôlé (l. 86) ; celui qu'une entrée manuelle mentionne ne
 * l'était pas — d'où `~/Desktop/monapp/agent.json`, chemin d'un dossier renommé en
 * `monapp` il y a des mois, affiché comme une source de vérité. Un pointeur mort est
 * pire qu'un champ vide : il fait croire qu'une fiche est adossée à quelque chose.
 * On ne le supprime pas en silence — on le NOMME et on le met à null. */
const pointeursMorts = [];
for (const a of manual) {
  if (!a.manifest) continue;
  const p = expandHome(a.manifest.startsWith('cartographie-it/') ? join(__dir, a.manifest.slice('cartographie-it/'.length)) : a.manifest);
  if (!existsSync(p)) { pointeursMorts.push(`${a.id} → ${a.manifest}`); a.manifest = null; }
}

// fusion : manifeste l'emporte sur un manuel de même id
const byId = new Map();
for (const a of [...manual, ...manifestAgents]) byId.set(a.id, a);
const agents = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));

writeFileSync(OUT, JSON.stringify({
  _doc: existing._doc,
  _meta: existing._meta,
  generated: new Date().toISOString(),
  agents,
}, null, 2) + '\n');

(await import('./karto-sources.mjs')).touchSource(__dir, 'agents');
const nbDiscovered = manifests.filter(m => m.discovered).length;
console.log(`✓ ${agents.length} agents → data/agents.json (${manifestAgents.length} manifeste(s) dont ${nbDiscovered} auto-découvert(s), ${manual.length} manuel(s))`);
// D8 — versionnage et fraîcheur : un manifeste sans `updated` ne dit pas s'il décrit encore
// l'agent, et des `schema` divergents signalent des formats qui ont cessé d'être le même.
const schemas = [...new Set(agents.map(a => a.schema).filter(Boolean))];
const sansDate = agents.filter(a => a.manifest && !a.updated).map(a => a.id);
console.log(`  registre : ${agents.filter(a => a.manifest).length} adossé(s) à un manifeste · ${pointeursMorts.length} pointeur(s) mort(s) · schéma(s) en usage : ${schemas.join(', ') || '—'}`);
if (pointeursMorts.length) console.warn(`  ⚠ pointeur(s) mort(s) remis à null (le fichier n'existe pas) : ${pointeursMorts.join(' · ')}`);
if (schemas.length > 1) console.warn(`  ⚠ ${schemas.length} versions de schéma coexistent — le format est censé être UN : ${schemas.join(' · ')}`);
if (sansDate.length) console.warn(`  ⚠ manifeste sans \`updated\` (fraîcheur inconnue) : ${sansDate.join(', ')}`);
