#!/usr/bin/env node
// karto-query.mjs — l'INTERFACE IA de karto. Une session Claude (ou toi) interroge
// la base de connaissances karto.db pour sourcer / croiser ton SI sans tout relire.
//
//   node karto-query.mjs schema                 -> structure de la base + exemples (À LIRE EN 1er)
//   node karto-query.mjs stats                  -> compteurs
//   node karto-query.mjs search <termes…>       -> recherche plein-texte (toutes entités)
//   node karto-query.mjs entity <id|nom>        -> fiche complète + voisins (graphe)
//   node karto-query.mjs related <id|nom> [n]   -> voisinage graphe profondeur n (def 1)
//   node karto-query.mjs sql "SELECT …"         -> SQL lecture seule -> JSON
//   node karto-query.mjs secrets [--critical]   -> emplacements de secrets (sans valeurs)
//   node karto-query.mjs exposures              -> expositions de sécurité
//   node karto-query.mjs bridges                -> bases connectées + comment les requêter
//
// Sortie = JSON sur stdout (consommable par l'IA), sauf `schema` (texte).

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const DB = join(__dir, 'karto.db');
if (!existsSync(DB)) { console.error('✗ karto.db absent — lance `node karto-db.mjs build`'); process.exit(1); }
const db = new DatabaseSync(DB, { readOnly: true });
const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const out = o => console.log(JSON.stringify(o, null, 2));
const parseAttrs = r => { if (r && typeof r.attrs === 'string') { try { r.attrs = JSON.parse(r.attrs); } catch {} } return r; };

function resolve(token) {
  // accepte un id exact, sinon match par nom/canonical (partiel)
  let r = db.prepare('SELECT * FROM entity WHERE id = ?').get(token);
  if (r) return r;
  const t = token.toLowerCase();
  r = db.prepare('SELECT * FROM entity WHERE canonical = ?').get(t)
    || db.prepare("SELECT * FROM entity WHERE canonical LIKE ? ORDER BY length(name) LIMIT 1").get('%' + t + '%')
    || db.prepare("SELECT * FROM entity WHERE id LIKE ? LIMIT 1").get('%' + t + '%');
  return r;
}
function neighbors(id) {
  const o = db.prepare(`SELECT e.rel, e.dst id, x.name, x.kind FROM edge e LEFT JOIN entity x ON x.id=e.dst WHERE e.src=?`).all(id);
  const i = db.prepare(`SELECT e.rel, e.src id, x.name, x.kind FROM edge e LEFT JOIN entity x ON x.id=e.src WHERE e.dst=?`).all(id);
  return { out: o, in: i };
}

switch (cmd) {
  case 'schema': {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    console.log('# karto.db — base de connaissances du SI (graphe entity/edge)\n');
    for (const { name } of tables) {
      const cols = db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name).join(', ');
      const n = db.prepare(`SELECT COUNT(*) c FROM ${name}`).get().c;
      console.log(`TABLE ${name} (${n} lignes)\n  ${cols}`);
    }
    console.log(`\nKINDS d'entité : ${db.prepare('SELECT DISTINCT kind FROM entity ORDER BY kind').all().map(r => r.kind).join(', ')}`);
    console.log(`RELATIONS (edge.rel) : ${db.prepare('SELECT DISTINCT rel FROM edge ORDER BY rel').all().map(r => r.rel).join(', ')}`);
    console.log(`\nEXEMPLES :
  node karto-query.mjs search supabase resend
  node karto-query.mjs entity <projet>
  node karto-query.mjs related <entité> 2
  node karto-query.mjs impact <socle>            # rayon d'impact : si ça tombe, quoi casse
  node karto-query.mjs sql "SELECT name,criticite,cout FROM entity WHERE criticite='Critique'"
  node karto-query.mjs sql "SELECT s.name,s.path FROM secret_ref s WHERE s.category='critical'"
  node karto-query.mjs sql "SELECT name,vendor,status FROM bridge"
  node karto-query.mjs sql "SELECT src,rel,dst FROM edge WHERE rel='utilise'"
  node karto-query.mjs bridges
Astuce IA : 'sql' est en lecture seule ; attrs est du JSON (json_extract(attrs,'$.stack')).`);
    break;
  }
  case 'stats': {
    out({
      entitiesByKind: db.prepare('SELECT kind, COUNT(*) n FROM entity GROUP BY kind ORDER BY n DESC').all(),
      edges: db.prepare('SELECT COUNT(*) n FROM edge').get().n,
      secretLocations: db.prepare('SELECT COUNT(*) n FROM secret_ref').get().n,
      criticalSecretLocations: db.prepare("SELECT COUNT(*) n FROM secret_ref WHERE category='critical'").get().n,
      exposures: db.prepare('SELECT severity, COUNT(*) n FROM exposure GROUP BY severity').all(),
      bridges: db.prepare('SELECT COUNT(*) n FROM bridge').get().n,
      builtAt: db.prepare("SELECT value FROM meta WHERE key='builtAt'").get()?.value
    });
    break;
  }
  case 'search': {
    if (!rest.length) { console.error('usage: search <termes…>'); process.exit(1); }
    const where = rest.map(() => 'doc LIKE ?').join(' AND ');
    const params = rest.map(t => '%' + t.toLowerCase() + '%');
    out(db.prepare(`SELECT id, kind, name, vendor, criticite, status, statut FROM entity WHERE ${where} ORDER BY kind, name LIMIT 60`).all(...params));
    break;
  }
  case 'entity': {
    const r = resolve(rest.join(' ')); if (!r) { out({ error: 'introuvable', token: rest.join(' ') }); break; }
    out({ ...parseAttrs(r), neighbors: neighbors(r.id) });
    break;
  }
  case 'related': {
    const r = resolve(rest[0] || ''); if (!r) { out({ error: 'introuvable' }); break; }
    const depth = Math.min(parseInt(rest[1] || '1', 10) || 1, 3);
    const seen = new Set([r.id]); let frontier = [r.id]; const nodes = [{ id: r.id, name: r.name, kind: r.kind }]; const links = []; const seenL = new Set();
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const id of frontier) { const nb = neighbors(id); for (const e of [...nb.out, ...nb.in]) { if (!e.id) continue; const src = nb.out.includes(e) ? id : e.id, dst = nb.out.includes(e) ? e.id : id, lk = src + '|' + dst + '|' + e.rel; if (!seenL.has(lk)) { seenL.add(lk); links.push({ src, dst, rel: e.rel }); } if (!seen.has(e.id)) { seen.add(e.id); next.push(e.id); nodes.push({ id: e.id, name: e.name, kind: e.kind }); } } }
      frontier = next;
    }
    out({ root: r.id, depth, nodes, links });
    break;
  }
  case 'impact': {
    // rayon d'impact : si ce nœud tombe, qu'est-ce qui casse ? → remonte les arêtes ENTRANTES (dépendants)
    const r = resolve(rest[0] || ''); if (!r) { out({ error: 'introuvable', token: rest[0] }); break; }
    const depth = Math.min(parseInt(rest[1] || '5', 10) || 5, 8);
    const nameOf = id => db.prepare('SELECT name FROM entity WHERE id=?').get(id)?.name || id;
    const seen = new Set([r.id]); let frontier = [r.id]; const impacted = [];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const id of frontier) {
        const inc = db.prepare('SELECT e.rel, e.src id, x.name, x.kind FROM edge e LEFT JOIN entity x ON x.id=e.src WHERE e.dst=?').all(id);
        for (const e of inc) { if (!e.id || seen.has(e.id)) continue; seen.add(e.id); next.push(e.id); impacted.push({ name: e.name, kind: e.kind, rel: e.rel, via: nameOf(id), depth: d + 1 }); }
      }
      frontier = next;
    }
    out({ node: r.name, kind: r.kind, blastRadius: impacted.length, impacted });
    break;
  }
  case 'sql': {
    const q = rest.join(' ').trim();
    if (!/^(select|with|explain|pragma table_info)\b/i.test(q) || /;\s*\S/.test(q.replace(/;\s*$/, ''))) { console.error('✗ lecture seule : une seule requête SELECT/WITH/EXPLAIN autorisée'); process.exit(1); }
    try { out(db.prepare(q).all().map(parseAttrs)); } catch (e) { out({ error: e.message }); }
    break;
  }
  case 'secrets': {
    const crit = rest.includes('--critical');
    out(db.prepare(`SELECT name, service, owner_entity, path, store, category FROM secret_ref ${crit ? "WHERE category='critical'" : ''} ORDER BY category DESC, owner_entity`).all());
    break;
  }
  case 'exposures': out(db.prepare('SELECT severity, what, location, recommendation FROM exposure ORDER BY CASE severity WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END').all()); break;
  case 'bridges': out(db.prepare('SELECT id, kind, name, vendor, target, status, last_indexed, reach, schema_json FROM bridge ORDER BY kind, name').all().map(b => { try { b.reach = JSON.parse(b.reach); } catch {} if (b.schema_json) { try { b.schema = JSON.parse(b.schema_json); b.tables = (b.schema.tables || []).length; } catch {} } delete b.schema_json; return b; })); break;
  default:
    console.error('Commandes : schema | stats | search | entity | related | impact | sql | secrets | exposures | bridges\nCommence par : node karto-query.mjs schema');
    process.exit(1);
}
