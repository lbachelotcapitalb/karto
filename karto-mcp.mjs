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

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, engineName } from './karto-sqlite.mjs';
import { execFileSync } from 'node:child_process';
import { OPS } from './karto-write.mjs';

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
          karto_sql: "SQL SELECT/WITH lecture seule"
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
    description: "SQL en LECTURE SEULE sur karto.db (graphe entity/edge + secret_ref, exposure, bridge). Seuls SELECT/WITH sont autorisés. attrs est du JSON (json_extract(attrs,'$.stack')).",
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Requête SELECT ou WITH' } }, required: ['query'] },
    run({ query }) {
      const q = String(query || '').trim();
      if (!/^(select|with)\b/i.test(q)) return { error: 'lecture seule : seuls SELECT/WITH sont autorisés' };
      if (/;\s*\S/.test(q)) return { error: 'une seule requête à la fois (pas de ;)' };
      try { return db.prepare(q).all(); } catch (e) { return { error: String(e.message || e) }; }
    }
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
    karto_rebuild: { description: 'Reconstruit la base requêtable karto.db après des écritures (le visuel chiffré reste derrière la passphrase).', inputSchema: { type: 'object', properties: {} }, run: () => { try { const out = execFileSync('node', [join(__dir, 'karto-db.mjs'), 'build'], { encoding: 'utf8' }); db = openDb(DB, { readOnly: true }); const m = out.match(/(\d+) entités.*?(\d+) liens/); return { ok: true, message: m ? `reconstruit — ${m[1]} entités, ${m[2]} liens` : 'reconstruit' }; } catch (e) { return { error: 'rebuild échoué: ' + (((e.stderr || e.message || '') + '').slice(0, 200)) }; } } }
  });
}

// ---------- transport MCP (stdio, JSON-RPC 2.0 délimité par lignes) ----------
const SERVER = { name: 'karto', version: '1.0.0' };
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
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
process.stderr.write('karto MCP prêt (4 outils, lecture seule)\n');
