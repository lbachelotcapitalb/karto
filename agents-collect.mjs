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
