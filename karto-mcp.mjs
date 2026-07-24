#!/usr/bin/env node
// karto-mcp.mjs — serveur MCP de karto (stdio, JSON-RPC 2.0, ZÉRO dépendance).
// Expose la base de connaissances karto.db comme OUTILS MCP, pour que n'importe
// quelle session Claude interroge le SI de Owner en langage naturel, sans CLI.
//
// Outils (lecture seule) :
//   karto_search  {query}            -> entités correspondant aux termes
//   karto_entity  {name}             -> fiche complète + voisins (graphe)
//   karto_impact  {name, depth?}     -> rayon d'impact (qui casse si ça tombe)
//   karto_sql     {query}            -> SQL SELECT/WITH en lecture seule -> lignes
//
// Enregistrement (config Claude) : commande = node, args = [chemin de ce fichier].
// stdout est RÉSERVÉ au protocole ; tout log va sur stderr.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, engineName, checkReadOnlySql } from './karto-sqlite.mjs';
import { execFileSync } from 'node:child_process';
import { OPS } from './karto-write.mjs';
import { ingest, INGEST } from './karto-ingest.mjs';
import { loadSources, ageDays, isStale } from './karto-sources.mjs';
import { runDiagnostics } from './karto-diagnostics.mjs';
import { runScenarios } from './karto-scenarios.mjs';

// Écriture OPT-IN : le MCP est lecture seule par défaut. Active avec KARTO_MCP_WRITE=1.
const WRITE = process.env.KARTO_MCP_WRITE === '1';

const __dir = dirname(fileURLToPath(import.meta.url));
const DB = join(__dir, 'karto.db');
if (!existsSync(DB)) { process.stderr.write('✗ karto.db absent — lance d’abord `node karto-db.mjs build` (ou `node karto-index.mjs`).\n'); process.exit(1); }
if (engineName() === 'none') { process.stderr.write('✗ Aucun moteur SQLite — installe Node ≥ 22 (recommandé) OU le binaire `sqlite3` (macOS l’a ; sinon brew/apt install sqlite3).\n'); process.exit(1); }
let db;
try { db = openDb(DB, { readOnly: true }); }
catch (e) { process.stderr.write('✗ ' + (e.message || e) + '\n'); process.exit(1); }

// ---------- helpers (repris de karto-query) ----------
const parseAttrs = r => { if (r && typeof r.attrs === 'string') { try { r.attrs = JSON.parse(r.attrs); } catch {} } return r; };
function resolve(token) {
  let r = db.prepare('SELECT * FROM entity WHERE id = ?').get(token);
  if (r) return r;
  const t = String(token || '').toLowerCase();
  return db.prepare('SELECT * FROM entity WHERE canonical = ?').get(t)
    || db.prepare("SELECT * FROM entity WHERE canonical LIKE ? ORDER BY length(name) LIMIT 1").get('%' + t + '%')
    || db.prepare("SELECT * FROM entity WHERE id LIKE ? LIMIT 1").get('%' + t + '%');
}
function neighbors(id) {
  const o = db.prepare('SELECT e.rel, e.dst id, x.name, x.kind FROM edge e LEFT JOIN entity x ON x.id=e.dst WHERE e.src=?').all(id);
  const i = db.prepare('SELECT e.rel, e.src id, x.name, x.kind FROM edge e LEFT JOIN entity x ON x.id=e.src WHERE e.dst=?').all(id);
  return { out: o, in: i };
}

// ---------- implémentation des outils ----------
const TOOLS = {
  karto_schema: {
    description: "À APPELER EN PREMIER. Décrit karto : modèle de données (tables/colonnes), types d'entités (kinds), relations du graphe, compteurs, et recettes de requêtes. Permet à l'IA de comprendre karto sans rien lire d'autre.",
    inputSchema: { type: 'object', properties: {} },
    run() {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(t => ({
        table: t.name,
        rows: db.prepare(`SELECT COUNT(*) c FROM ${t.name}`).get().c,
        columns: db.prepare(`PRAGMA table_info(${t.name})`).all().map(c => c.name)
      }));
      return {
        about: "karto = base de connaissances du SI (graphe entity+edge). Lecture seule. attrs est du JSON (json_extract(attrs,'$.stack')). Aucune VALEUR de secret n'est stockée — seulement noms/emplacements (table secret_ref).",
        kinds: db.prepare('SELECT kind, COUNT(*) n FROM entity GROUP BY kind ORDER BY n DESC').all(),
        relations: db.prepare('SELECT DISTINCT rel FROM edge ORDER BY rel').all().map(r => r.rel),
        tables,
        tools: {
          karto_search: "recherche plein-texte (entités)",
          karto_entity: "fiche + voisins du graphe",
          karto_impact: "rayon d'impact (si X tombe, quoi casse)",
          karto_sql: "SQL SELECT/WITH lecture seule",
          karto_diagnostics: "santé de la carte (score + dimensions + trous)",
          karto_scenario: "scénarios de résilience what-if (coût, secrets, automatisations)",
          karto_discover: "répertoire des sources : quoi re-sourcer, comment, fraîcheur par source"
        },
        recipes: [
          { q: "où vit la clé Resend ?", tool: "karto_search('resend')` puis `karto_entity" },
          { q: "qu'est-ce qui casse si le VPS tombe ?", tool: "karto_impact('Hetzner VPS')" },
          { q: "bases sans sauvegarde", tool: "karto_sql(\"SELECT name FROM entity WHERE kind='database'\")` (+ détail backup via attrs / cloud)" },
          { q: "actifs critiques", tool: "karto_sql(\"SELECT name,vendor FROM entity WHERE criticite='Critique'\")" },
          { q: "emplacements de secrets critiques", tool: "karto_sql(\"SELECT name,service,path FROM secret_ref WHERE category='critical'\")" },
          { q: "qui utilise Supabase", tool: "karto_sql(\"SELECT src FROM edge WHERE rel='utilise' AND dst LIKE '%supabase%'\")" }
        ]
      };
    }
  },
  karto_search: {
    description: "Recherche plein-texte dans le SI de Owner (projets, comptes, bases, automatisations, secrets, hôtes…). Renvoie les entités correspondantes.",
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Termes de recherche (espace = ET)' } }, required: ['query'] },
    run({ query }) {
      const terms = String(query || '').trim().split(/\s+/).filter(Boolean);
      if (!terms.length) return [];
      const where = terms.map(() => 'doc LIKE ?').join(' AND ');
      return db.prepare(`SELECT id, kind, name, vendor, criticite, status, statut FROM entity WHERE ${where} ORDER BY kind, name LIMIT 60`).all(...terms.map(t => '%' + t.toLowerCase() + '%'));
    }
  },
  karto_entity: {
    description: "Fiche complète d'une entité (par nom ou id) + ses voisins dans le graphe (stack, base, secrets liés, hôte…).",
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: "Nom ou id de l'entité (ex. 'myapp', 'Hetzner VPS')" } }, required: ['name'] },
    run({ name }) {
      const r = resolve(name); if (!r) return { error: 'introuvable', token: name };
      return { ...parseAttrs(r), neighbors: neighbors(r.id) };
    }
  },
  karto_impact: {
    description: "Rayon d'impact : si ce nœud tombe, qu'est-ce qui casse ? Remonte les dépendances entrantes (transitif).",
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Nom du socle (ex. "Hetzner VPS", "my-laptop.lan", "Supabase polar")' }, depth: { type: 'number', description: 'Profondeur max (défaut 5)' } }, required: ['name'] },
    run({ name, depth }) {
      const r = resolve(name); if (!r) return { error: 'introuvable', token: name };
      const d0 = Math.min(parseInt(depth || 5, 10) || 5, 8);
      const nameOf = id => db.prepare('SELECT name FROM entity WHERE id=?').get(id)?.name || id;
      const seen = new Set([r.id]); let frontier = [r.id]; const impacted = [];
      for (let d = 0; d < d0; d++) {
        const next = [];
        for (const id of frontier) {
          for (const e of db.prepare('SELECT e.rel, e.src id, x.name, x.kind FROM edge e LEFT JOIN entity x ON x.id=e.src WHERE e.dst=?').all(id)) {
            if (!e.id || seen.has(e.id)) continue; seen.add(e.id); next.push(e.id);
            impacted.push({ name: e.name, kind: e.kind, rel: e.rel, via: nameOf(id), depth: d + 1 });
          }
        }
        frontier = next;
      }
      return { node: r.name, kind: r.kind, blastRadius: impacted.length, impacted };
    }
  },
  karto_sql: {
    description: "SQL en LECTURE SEULE sur karto.db (graphe entity/edge + secret_ref, exposure, bridge). SELECT/WITH/EXPLAIN/VALUES/PRAGMA de lecture autorisés ; les mutateurs (INSERT/UPDATE/DELETE/DROP…) sont refusés. attrs est du JSON (json_extract(attrs,'$.stack')).",
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Requête SELECT ou WITH' } }, required: ['query'] },
    run({ query }) {
      const q = String(query || '').trim();
      const guard = checkReadOnlySql(q);
      if (guard.error) return { error: guard.error };
      try { return db.prepare(q).all(); } catch (e) { return { error: String(e.message || e) }; }
    }
  },
  karto_diagnostics: {
    description: "Diagnostic automatique de la SANTÉ de la carte : score global /100 + dimensions notées (sécurité, rangement des secrets, sauvegarde/résilience, cycle de vie, couverture, fraîcheur) avec la liste actionnable des trous. Agrège les signaux existants, n'invente pas de bruit.",
    inputSchema: { type: 'object', properties: {} },
    run() { return runDiagnostics(__dir); }
  },
  karto_discover: {
    description: "RÉPERTOIRE DES SOURCES de la stack à sourcer : quelles sources alimentent karto, avec quelle méthode (CLI/API/MCP/SSH/navigateur), lesquelles sont périmées ou jamais collectées, et COMMENT re-sourcer chacune depuis cette session (collector à lancer ou howto MCP). Appelle-le pour savoir quoi rafraîchir — puis reverse le résultat via karto_ingest (si écriture active) ou le CLI node karto-ingest.mjs.",
    inputSchema: { type: 'object', properties: {} },
    run() {
      const { sources } = loadSources(__dir);
      const view = s => ({ id: s.id, name: s.name, method: s.method, status: s.status, age_days: ageDays(s), cadence_days: s.cadence_days ?? null, how: s.collector || s.howto || null, note: s.note });
      const tracked = sources.filter(s => !['planned', 'probe'].includes(s.status));
      // candidats de connexion découverts dans l'historique navigateur (local, jamais poussé)
      let candidates = null;
      try {
        const bc = JSON.parse(readFileSync(join(__dir, 'data', 'browser_candidates.local.json'), 'utf8'));
        const nv = (bc.candidates || []).filter(c => c.status === 'nouveau');
        candidates = { generated: bc.generated, window_days: bc.window_days, nouveaux: nv.map(c => ({ app: c.app, domain: c.domain, visits: c.visits, last: c.last })), note: 'SaaS réellement fréquentés mais ABSENTS de l’onglet Comptes. Proposer à Owner, puis karto_add_account pour ceux qu’il valide.' };
      } catch {}
      return {
        stale: tracked.filter(isStale).map(view),
        fresh: tracked.filter(s => !isStale(s)).map(view),
        gaps: sources.filter(s => ['planned', 'probe'].includes(s.status)).map(view),
        candidates,
        ingestable: Object.fromEntries(Object.entries(INGEST).map(([k, h]) => [k, h.mold])),
        instructions: "1) Traite `stale` en priorité : lance `how` (collector CLI) ou suis `howto` avec tes MCP de session. 2) `gaps` = sources sans collecteur — si tu as le moyen de sonder (MCP, navigateur, terminal), fais-le et reverse via karto_ingest (source-status pour l'existence, handler dédié pour la data). 3) `candidates.nouveaux` = connexions à proposer à Owner (jamais recensées d'office). 4) Termine par karto_rebuild."
      };
    }
  },
  karto_scenario: {
    description: "Scénario de résilience « what-if » : si un socle tombe, qu'est-ce qui casse (rayon d'impact), quelles automatisations cassent, quels secrets sont à roter, quel coût/mois en jeu. Sans argument = tous les scénarios définis (data/scenarios.json) triés par ampleur ; avec name = un scénario (id/label) ou un nom de nœud ad-hoc.",
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: "id/label d'un scénario, ou nom d'un nœud à faire tomber (ex. 'Hetzner VPS')" } } },
    run({ name }) { return runScenarios(__dir, name || null); }
  }
};

// ---------- OUTILS D'ÉCRITURE (opt-in KARTO_MCP_WRITE=1) — mutent data/*.json, jamais le code ----------
if (WRITE) {
  const run = (op, a) => { const r = OPS[op](a); if (r && r.ok) r.next = 'Appelle karto_rebuild quand tu as fini pour rafraîchir la base.'; return r; };
  Object.assign(TOOLS, {
    karto_add_account: { description: "ÉCRITURE. Ajoute/maj un compte (SaaS, IA…). Jamais de valeur de secret. category:'IA' le fait apparaître dans l'onglet IA.", inputSchema: { type: 'object', properties: { provider: { type: 'string' }, identity: { type: 'string' }, email: { type: 'string' }, url: { type: 'string' }, plan: { type: 'string' }, category: { type: 'string' }, note: { type: 'string' } }, required: ['provider'] }, run: a => run('add-account', a) },
    karto_set_attribut: { description: "ÉCRITURE. Pose un attribut curé sur un actif (criticite/cycle/cout/statut/domaine/type/vendor/hosting). Crée l'actif s'il manque.", inputSchema: { type: 'object', properties: { name: { type: 'string' }, key: { type: 'string' }, value: {} }, required: ['name', 'key', 'value'] }, run: a => run('set-attribut', a) },
    karto_add_dependance: { description: "ÉCRITURE. Ajoute une dépendance « from dépend de to » (rayon d'impact).", inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, note: { type: 'string' }, rel: { type: 'string' } }, required: ['from', 'to'] }, run: a => run('add-dependance', a) },
    karto_add_exposure: { description: 'ÉCRITURE. Ajoute une exposition sécurité. Jamais de valeur de secret.', inputSchema: { type: 'object', properties: { what: { type: 'string' }, severity: { type: 'string' }, where: { type: 'string' }, recommendation: { type: 'string' }, status: { type: 'string' } }, required: ['what'] }, run: a => run('add-exposure', a) },
    karto_add_data_asset: { description: 'ÉCRITURE. Ajoute une donnée stratégique.', inputSchema: { type: 'object', properties: { label: { type: 'string' }, sensibilite: { type: 'string' }, emplacements: { type: 'array' }, restauration: { type: 'array' } }, required: ['label'] }, run: a => run('add-data-asset', a) },
    karto_add_project: { description: 'ÉCRITURE. Ajoute/maj un projet.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, hosting: { type: 'string' }, deployUrl: { type: 'string' }, path: { type: 'string' }, stack: { type: 'array' }, integrations: { type: 'array' }, notes: { type: 'string' } }, required: ['name'] }, run: a => run('add-project', a) },
    karto_ingest: { description: "ÉCRITURE EN MASSE par source (l'aspirateur). La session qui a lu une source via ses MCP/CLI/navigateur reverse le résultat structuré : merge idempotent, enrichissement manuel préservé, garde anti-secret, fraîcheur estampillée. Appelle karto_discover d'abord pour le moule (`ingestable`) de chaque source.", inputSchema: { type: 'object', properties: { source: { type: 'string', description: 'make | cloudflare | gdrive | hetzner-workloads | mcp-tools | runs | hostinger-domains | source-status' }, payload: { type: 'object', description: 'Payload au moule de la source (cf. karto_discover.ingestable)' } }, required: ['source', 'payload'] }, run: a => { const r = ingest(a.source, a.payload); if (r && r.ok) r.next = 'Appelle karto_rebuild quand tu as fini pour rafraîchir la base.'; return r; } },
    karto_rebuild: { description: 'Reconstruit la base requêtable karto.db après des écritures (le visuel chiffré reste derrière la passphrase).', inputSchema: { type: 'object', properties: {} }, run: () => { try { const out = execFileSync('node', [join(__dir, 'karto-db.mjs'), 'build'], { encoding: 'utf8' }); db = openDb(DB, { readOnly: true }); const m = out.match(/(\d+) entités.*?(\d+) liens/); return { ok: true, message: m ? `reconstruit — ${m[1]} entités, ${m[2]} liens` : 'reconstruit' }; } catch (e) { return { error: 'rebuild échoué: ' + (((e.stderr || e.message || '') + '').slice(0, 200)) }; } } }
  });
}

// ---------- RESOURCES (données contextuelles lisibles par l'IA) ----------
const RESOURCES = {
  'karto://schema': { name: 'Schéma karto', description: "Modèle de données, kinds, relations, recettes — à lire en premier.", mimeType: 'application/json', read: () => TOOLS.karto_schema.run() },
  'karto://diagnostics': { name: 'Santé de la carte', description: "Score qualité + dimensions + trous actionnables.", mimeType: 'application/json', read: () => runDiagnostics(__dir) },
  'karto://scenarios': { name: 'Scénarios de résilience', description: "Tous les what-if (impact, secrets, automatisations, coût).", mimeType: 'application/json', read: () => runScenarios(__dir, null) }
};

// ---------- PROMPTS (modèles pré-câblés) ----------
const PROMPTS = {
  'sante-carte': { description: "État de santé du SI + 3 priorités.", arguments: [], build: () => "Appelle karto_diagnostics, donne le score global et, pour chaque dimension en orange/rouge, les 1-2 actions prioritaires. Termine par les 3 priorités absolues." },
  'audit-securite': { description: "Audit des expositions de sécurité ouvertes.", arguments: [], build: () => "Appelle karto_diagnostics (dimension Sécurité) et karto_sql sur la table exposure. Liste les expositions ouvertes par sévérité et propose un plan de remédiation ordonné." },
  'impact': { description: "Que casse-t-il si un socle tombe ?", arguments: [{ name: 'node', description: 'Nom du socle (ex. Hetzner VPS)', required: true }], build: a => `Appelle karto_scenario avec name="${a.node || ''}" (ou karto_impact). Résume le rayon d'impact, les automatisations cassées, les secrets à roter et le coût en jeu, puis propose un plan de continuité.` },
  'ou-vit-secret': { description: "Localiser un secret.", arguments: [{ name: 'secret', description: 'Nom/service du secret', required: true }], build: a => `Trouve où vit le secret "${a.secret || ''}" : karto_search puis karto_entity. Donne l'emplacement (store/path), le service, et s'il est tracé dans Bitwarden ou en clair.` }
};

// ---------- transport MCP (stdio, JSON-RPC 2.0 délimité par lignes) ----------
const SERVER = { name: 'karto', version: '1.1.0' };
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: SERVER
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return; // notifications : pas de réponse
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (method === 'tools/call') {
    const name = params && params.name; const args = (params && params.arguments) || {};
    const tool = TOOLS[name];
    if (!tool) return fail(id, -32602, 'outil inconnu : ' + name);
    try {
      const res = tool.run(args);
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: 'Erreur : ' + String(e.message || e) }], isError: true });
    }
  }
  if (method === 'resources/list') {
    return reply(id, { resources: Object.entries(RESOURCES).map(([uri, r]) => ({ uri, name: r.name, description: r.description, mimeType: r.mimeType })) });
  }
  if (method === 'resources/read') {
    const uri = params && params.uri; const r = RESOURCES[uri];
    if (!r) return fail(id, -32602, 'ressource inconnue : ' + uri);
    try { return reply(id, { contents: [{ uri, mimeType: r.mimeType, text: JSON.stringify(r.read(), null, 2) }] }); }
    catch (e) { return fail(id, -32603, String(e.message || e)); }
  }
  if (method === 'prompts/list') {
    return reply(id, { prompts: Object.entries(PROMPTS).map(([name, p]) => ({ name, description: p.description, arguments: p.arguments })) });
  }
  if (method === 'prompts/get') {
    const name = params && params.name; const p = PROMPTS[name];
    if (!p) return fail(id, -32602, 'prompt inconnu : ' + name);
    const text = p.build((params && params.arguments) || {});
    return reply(id, { description: p.description, messages: [{ role: 'user', content: { type: 'text', text } }] });
  }
  if (id !== undefined) fail(id, -32601, 'méthode non supportée : ' + method);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    try { handle(msg); } catch (e) { if (msg && msg.id !== undefined) fail(msg.id, -32603, String(e.message || e)); }
  }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write(`karto MCP prêt (${Object.keys(TOOLS).length} outils, ${Object.keys(RESOURCES).length} resources, ${Object.keys(PROMPTS).length} prompts${WRITE ? ', écriture ON' : ', lecture seule'})\n`);
