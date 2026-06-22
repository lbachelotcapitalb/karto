#!/usr/bin/env node
// karto-db.mjs — matérialise tous les data/*.json en une base SQLite requêtable :
// karto.db. C'est la « grosse base de données » : un graphe de connaissances
// (entity + edge) que l'IA interroge via karto-query.mjs pour sourcer/croiser.
//
// Softcode : on ingère les data/*.json tels quels (rien de spécifique au propriétaire en dur).
// Aucune VALEUR de secret n'entre dans karto.db — uniquement noms/emplacements.
//
// Usage : node karto-db.mjs build      (reconstruit karto.db depuis data/*.json)
//         node karto-db.mjs stats      (compte les entités par type)

import { openDb } from './karto-sqlite.mjs';
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dir, 'karto.db');
const cmd = process.argv[2] || 'build';

const load = f => { try { return JSON.parse(readFileSync(join(__dir, 'data', f), 'utf8')); } catch { return null; } };
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const canon = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const cfg = (() => { try { return JSON.parse(readFileSync(join(__dir, 'karto.config.json'), 'utf8')); } catch { return {}; } })();
const gh = cfg.github || {};   // identité GitHub owner (softcode) — pas en dur

if (cmd === 'stats') {
  if (!existsSync(DB_PATH)) { console.error('✗ karto.db absent — lance `node karto-db.mjs build`'); process.exit(1); }
  const db = openDb(DB_PATH, { readOnly: true });
  console.log('Entités par type :');
  for (const r of db.prepare('SELECT kind, COUNT(*) n FROM entity GROUP BY kind ORDER BY n DESC').all()) console.log(`  ${String(r.n).padStart(4)}  ${r.kind}`);
  const e = db.prepare('SELECT COUNT(*) n FROM edge').get().n;
  const s = db.prepare('SELECT COUNT(*) n FROM secret_ref').get().n;
  const x = db.prepare('SELECT COUNT(*) n FROM exposure').get().n;
  const b = db.prepare('SELECT COUNT(*) n FROM bridge').get().n;
  console.log(`Liens: ${e} · Emplacements de secrets: ${s} · Expositions: ${x} · Bridges: ${b}`);
  process.exit(0);
}

/* ---------- (re)création du schéma ---------- */
for (const sfx of ['', '-wal', '-shm', '-journal']) { try { if (existsSync(DB_PATH + sfx)) unlinkSync(DB_PATH + sfx); } catch {} }
const db = openDb(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE entity (
    id TEXT PRIMARY KEY,        -- ex: project:my-app
    kind TEXT NOT NULL,         -- project|account|database|repo|host|automation|scenario|connector|webhook|ea_asset|data_asset|device|runtime|cli|launchagent|ssh_host|secret|bridge
    name TEXT NOT NULL,
    canonical TEXT,             -- name normalisé (jointures cross-source)
    vendor TEXT, hosting TEXT, url TEXT, path TEXT, status TEXT,
    criticite TEXT, cycle TEXT, statut TEXT, cout REAL,
    domaine TEXT, owner TEXT,
    source TEXT,                -- fichier data/ d'origine
    doc TEXT,                   -- texte plein (recherche LIKE)
    attrs TEXT                  -- JSON détaillé
  );
  CREATE INDEX idx_entity_kind ON entity(kind);
  CREATE INDEX idx_entity_canon ON entity(canonical);
  CREATE TABLE edge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    src TEXT NOT NULL, dst TEXT NOT NULL, rel TEXT, source TEXT
  );
  CREATE INDEX idx_edge_src ON edge(src);
  CREATE INDEX idx_edge_dst ON edge(dst);
  CREATE TABLE secret_ref (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, service TEXT, owner_entity TEXT, path TEXT,
    store TEXT, category TEXT, source TEXT
  );
  CREATE TABLE exposure (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    severity TEXT, what TEXT, location TEXT, recommendation TEXT
  );
  CREATE TABLE bridge (
    id TEXT PRIMARY KEY, kind TEXT, name TEXT, vendor TEXT,
    target TEXT, reach TEXT, status TEXT, last_indexed TEXT, schema_json TEXT
  );
  CREATE TABLE vendor_domain ( name TEXT PRIMARY KEY, domain TEXT );
  CREATE TABLE meta ( key TEXT PRIMARY KEY, value TEXT );
`);

const ents = new Map();   // id -> entity
const edges = [];
const byCanon = new Map(); // canonical -> id (1er gagnant, pour résoudre les liens par nom)

function E(id, kind, name, extra = {}) {
  if (ents.has(id)) { Object.assign(ents.get(id), extra); return id; }
  const c = canon(name);
  const e = { id, kind, name, canonical: c, vendor: null, hosting: null, url: null, path: null, status: null, criticite: null, cycle: null, statut: null, cout: null, domaine: null, owner: null, source: null, attrs: {}, ...extra };
  ents.set(id, e);
  if (c && !byCanon.has(c)) byCanon.set(c, id);
  return id;
}
function L(src, dst, rel, source) { if (src && dst && src !== dst) edges.push({ src, dst, rel, source }); }
// résout une référence "par nom" vers un id d'entité existant (sinon renvoie tel quel)
const ref = name => byCanon.get(canon(name)) || null;

/* ============ disk_inventory ============ */
const disk = load('disk_inventory.json') || {};
const owner = disk._meta?.owner || '';
for (const p of (disk.projects || [])) {
  const id = E('project:' + slug(p.name), 'project', p.name, {
    hosting: p.hosting, url: p.deployUrl, path: p.path, statut: 'Actif', owner,
    source: 'disk_inventory.json',
    attrs: { stack: p.stack, branch: p.branch, gitRemotes: p.gitRemotes, integrations: p.integrations, notes: p.notes, ci: p.ci, scripts: p.scripts }
  });
  // déploiement / hébergeur
  if (/netlify/i.test(p.hosting || '')) L(id, 'host:netlify', 'déployé', 'disk_inventory.json');
  if (/hetzner/i.test(p.hosting || '')) L(id, 'host:hetzner', 'déployé', 'disk_inventory.json');
  // intégrations -> connecteur/compte (résolu plus tard par nom)
  for (const i of (p.integrations || [])) L(id, 'int:' + slug(i), 'utilise', 'disk_inventory.json');
  // remotes -> repo/compte
  for (const r of (p.gitRemotes || [])) { if (gh.user && r.includes('github.com/' + gh.user)) L(id, 'account:gh-perso', 'repo', 'disk_inventory.json'); if (gh.altUser && r.includes(gh.altUser)) L(id, 'account:gh-jbct', 'repo', 'disk_inventory.json'); }
  // emplacements de secrets (NOMS only)
  for (const ef of (p.envFiles || [])) for (const v of (ef.vars || [])) {
    const critical = /service_role|secret|password|mot de passe|critique/i.test((v.name || '') + ' ' + (v.service || ''));
    db.prepare('INSERT INTO secret_ref(name,service,owner_entity,path,store,category,source) VALUES(?,?,?,?,?,?,?)')
      .run(v.name, v.service, id, ef.path, null, critical ? 'critical' : 'secret', 'disk_inventory.json');
  }
}
const unresolvedInts = new Set(), unresolvedProjects = new Set(), unresolvedDeps = [];
for (const a of (disk.systemAutomation || [])) {
  const id = E('automation:' + slug(a.name), 'automation', a.name, {
    statut: a.enabled ? 'Actif' : 'En pause', source: 'disk_inventory.json', owner,
    attrs: { type: a.type, schedule: a.schedule, enabled: a.enabled, does: a.does, claudeTier: a.claudeTier, chain: a.chain, path: a.path, manifest: a.manifest }
  });
  // lien automatisation -> projet : champ explicite a.project (plus d'inférence regex).
  // a.project peut être une phrase libre ("x (analytics) + y") : ne créer l'edge que si ça résout
  // vers une vraie entité, sinon on le signale plutôt que de fabriquer un dst pendant.
  if (a.project) { const pid = ref(a.project); if (pid) L(id, pid, 'planifie', 'disk_inventory.json'); else unresolvedProjects.add(a.project); }
}
for (const x of (disk.exposures || [])) db.prepare('INSERT INTO exposure(severity,what,location,recommendation) VALUES(?,?,?,?)').run(x.severity, x.what, x.where, x.recommendation);

/* ============ cloud_inventory ============ */
const cloud = load('cloud_inventory.json') || {};
for (const [name, domain] of Object.entries(cloud.vendorDomains || {})) { if (name === '_doc') continue; db.prepare('INSERT OR IGNORE INTO vendor_domain(name,domain) VALUES(?,?)').run(name, domain); }
for (const a of (cloud.accounts || [])) {
  const id = E('account:' + slug(a.id), 'account', a.provider + (a.identity ? ' · ' + a.identity : ''), {
    vendor: a.provider, url: a.url, status: 'Actif', source: 'cloud_inventory.json', owner,
    attrs: { accountId: a.id, identity: a.identity, scopes: a.scopes, note: a.note, email: a.email, ids: a.ids }
  });
  // alias canonique provider->compte : 1er gagnant (gh-perso avant gh-jbct, sb-bcapital avant les autres)
  if (!byCanon.has(canon(a.provider))) byCanon.set(canon(a.provider), id);
  for (const v of (a.ids || [])) {
    if (v.cat === 'secret') db.prepare('INSERT INTO secret_ref(name,service,owner_entity,path,store,category,source) VALUES(?,?,?,?,?,?,?)').run(v.k, a.provider, id, 'coffre karto (compte)', v.store || null, 'secret', 'cloud_inventory.json');
  }
}
// résolution d'un compte par sa clé/identité (pour rattacher chaque base au BON compte)
const acctByKey = new Map();
for (const a of (cloud.accounts || [])) { const aid = 'account:' + slug(a.id); if (a.accountKey) acctByKey.set(canon(a.accountKey), aid); if (a.identity) acctByKey.set(canon(a.identity), aid); }
const sb = cloud.supabase || {};
for (const d of [...(sb.projects || []), ...(sb.offAccount || [])]) {
  const id = E('database:' + slug(d.ref || d.name), 'database', 'Supabase ' + d.name, {
    vendor: 'Supabase', hosting: d.region, status: d.status, url: d.ref ? `https://supabase.com/dashboard/project/${d.ref}` : null,
    source: 'cloud_inventory.json', owner,
    attrs: { ref: d.ref, pg: d.pg, host: d.host, account: d.account, app: d.app, appNote: d.appNote, note: d.note, created: d.created }
  });
  if (d.account) L(id, acctByKey.get(canon(d.account)) || ref('Supabase') || null, 'héberge', 'cloud_inventory.json');
  if (d.app) { const pid = ref(d.app) || ('project:' + slug(d.app.split(' ')[0])); L(pid, id, 'utilise', 'cloud_inventory.json'); }
}
const cgh = cloud.github || {};
for (const r of (cgh.repos || [])) {
  const id = E('repo:' + slug(r.name), 'repo', r.name, { vendor: 'GitHub', url: 'https://github.com/' + r.name, source: 'cloud_inventory.json', owner, attrs: { visibility: r.visibility, desc: r.desc, updated: r.updated } });
  L(id, /jbct-hub/.test(r.name) ? 'account:gh-jbct' : 'account:gh-perso', 'appartient', 'cloud_inventory.json');
  const pn = r.name.split('/').pop(); const pid = ref(pn); if (pid && pid.startsWith('project:')) L(pid, id, 'code', 'cloud_inventory.json');
}
for (const g of (cgh.actions || [])) E('automation:gha-' + slug(g.repo + '-' + g.workflow), 'automation', `GHA ${g.repo} · ${g.workflow}`, { vendor: 'GitHub', statut: g.status === 'active' ? 'Actif' : 'En pause', source: 'cloud_inventory.json', attrs: { trigger: g.trigger, does: g.does, claudeTier: g.claudeTier, chain: g.chain, repo: g.repo } });
const mk = cloud.make || {};
for (const s of (mk.scenarios || [])) { const id = E('scenario:' + slug(s.id || s.name), 'scenario', 'Make · ' + s.name, { vendor: 'Make', statut: s.active ? 'Actif' : 'En pause', source: 'cloud_inventory.json', attrs: { trigger: s.trigger, modules: s.modules, does: s.does, claudeTier: s.claudeTier, chain: s.chain } }); L(id, ref('Make') || 'account:make', 'scénario', 'cloud_inventory.json'); }
for (const c of (mk.connections || [])) E('connector:' + slug(c.id || c.app), 'connector', 'Make · ' + c.app, { vendor: c.app, source: 'cloud_inventory.json', attrs: { type: c.type, account: c.account, usedBy: c.usedBy, expire: c.expire } });
for (const w of (mk.webhooks || [])) E('webhook:' + slug(w.id || w.name), 'webhook', w.name, { vendor: 'Make', status: w.enabled ? 'actif' : 'inactif', url: w.url, source: 'cloud_inventory.json', attrs: { type: w.type, scenario: w.scenario, queue: w.queue } });
// hôtes & workloads
E('host:netlify', 'host', 'Netlify', { vendor: 'Netlify', source: 'cloud_inventory.json' });
const het = cloud.hetzner || {};
E('host:hetzner', 'host', 'Hetzner VPS', { vendor: 'Hetzner', hosting: het.vps, source: 'cloud_inventory.json', attrs: { workloads: het.workloads } });
for (const w of (het.workloads || [])) { const id = E('workload:' + slug(w.name), 'workload', w.name, { vendor: 'Hetzner', path: w.path, source: 'cloud_inventory.json', attrs: { trigger: w.trigger, does: w.does, secrets: w.secrets } }); L(id, 'host:hetzner', 'tourne-sur', 'cloud_inventory.json'); }
// noms de domaine (DNS / hébergement / email dérivés du DNS réel)
for (const d of ((cloud.domains && cloud.domains.list) || [])) {
  const id = E('domain:' + slug(d.name), 'domain', d.name, {
    vendor: (d.registrar && d.registrar !== 'a confirmer') ? d.registrar : (d.dns || null),
    hosting: d.host, url: 'https://' + d.name, status: d.statut, criticite: d.criticite,
    source: 'cloud_inventory.json', owner,
    attrs: { registrar: d.registrar, dns: d.dns, host: d.host, email: d.email, usedBy: d.usedBy, subdomains: d.subdomains, project: d.project, note: d.note }
  });
  if (d.dns) L(id, ref(d.dns) || ('vendor:' + slug(d.dns)), 'dns', 'cloud_inventory.json');
  if (d.host) L(id, ref(d.host) || ('vendor:' + slug(d.host)), 'héberge', 'cloud_inventory.json');
  if (d.email) L(id, ref(d.email) || ('vendor:' + slug(d.email)), 'email', 'cloud_inventory.json');
  if (d.project) L(ref(d.project) || ('project:' + slug(d.project)), id, 'domaine', 'cloud_inventory.json');
}

/* ============ ea_inventory (criticité/cycle/coût curatés) ============ */
const ea = load('ea_inventory.json') || {};
for (const a of (ea.assets || [])) {
  // enrichit l'entité de même nom si elle existe, sinon crée un ea_asset
  const existing = ref(a.name);
  if (existing && ents.has(existing)) {
    Object.assign(ents.get(existing), { criticite: a.criticite, cycle: a.cycle, statut: a.statut, cout: a.cout, domaine: a.domaine, vendor: ents.get(existing).vendor || a.vendor });
    ents.get(existing).attrs.ea = { type: a.type, links: a.links, rel: a.rel };
    for (const r of (a.rel || [])) L(existing, ref(r) || ('ea:' + slug(r)), 'lié', 'ea_inventory.json');
  } else {
    const id = E('ea:' + slug(a.name), 'ea_asset', a.name, { vendor: a.vendor, hosting: a.hosting, criticite: a.criticite, cycle: a.cycle, statut: a.statut, cout: a.cout, domaine: a.domaine, owner: a.owner, source: 'ea_inventory.json', attrs: { type: a.type, links: a.links, rel: a.rel } });
    for (const r of (a.rel || [])) L(id, ref(r) || ('ea:' + slug(r)), 'lié', 'ea_inventory.json');
  }
}

/* ============ data_assets (données stratégiques) ============ */
const da = load('data_assets.json') || {};
for (const a of (da.assets || [])) {
  const id = E('data:' + slug(a.id || a.label), 'data_asset', a.label, { source: 'data_assets.json', owner, attrs: { sensibilite: a.sensibilite, emplacements: a.emplacements, restauration: a.restauration } });
  for (const loc of (a.emplacements || [])) { const cn = da.canaux?.[loc.canal]; if (cn?.vendor) L(id, ref(cn.vendor) || ('vendor:' + slug(cn.vendor)), 'stocké-sur', 'data_assets.json'); }
}

/* ============ machine_inventory (auto-collecté) ============ */
const mi = load('machine_inventory.json');
if (mi) {
  const hostId = E('device:' + slug(mi.host?.hostname || 'mac'), 'device', mi.host?.hostname || 'Machine', { source: 'machine_inventory.json', owner: mi._meta?.owner, attrs: mi.host });
  for (const r of (mi.runtimes || [])) E('runtime:' + slug(r.bin), 'runtime', r.bin, { source: 'machine_inventory.json', path: r.path, attrs: { version: r.version } });
  for (const c of (mi.clis || [])) E('cli:' + slug(c.bin), 'cli', c.name, { source: 'machine_inventory.json', path: c.path, status: c.authed ? 'authentifié' : 'présent', attrs: { hint: c.hint } });
  for (const la of (mi.launchAgents || [])) { const id = E('launchagent:' + slug(la.label), 'launchagent', la.label, { source: 'machine_inventory.json', statut: la.enabled ? 'Actif' : 'En pause', attrs: { schedule: la.schedule, command: la.command, file: la.file } }); L(id, hostId, 'tourne-sur', 'machine_inventory.json'); }
  for (const d of (mi.localDatabases || [])) { const nm = d.file ? ('SQLite ' + (d.path || '').split('/').pop()) : (d.engine + (d.running ? ' (running)' : '')); const id = E('localdb:' + slug((d.path || d.engine) + (d.processes || '')), 'database', nm, { vendor: d.engine, source: 'machine_inventory.json', path: d.path, status: d.running ? 'running' : (d.status || null), attrs: d }); L(id, hostId, 'sur', 'machine_inventory.json'); }
  for (const h of (mi.sshHosts || [])) E('ssh_host:' + slug(h.alias), 'ssh_host', h.alias, { source: 'machine_inventory.json', hosting: h.hostName, attrs: h });
  // enrichit les projets locaux (dirty, lastCommit, hasRemote) si match par nom
  for (const p of (mi.projects || [])) { const pid = ref(p.name); if (pid && ents.has(pid)) Object.assign(ents.get(pid).attrs, { local: { lastCommit: p.lastCommit, dirtyFiles: p.dirtyFiles, hasRemote: p.hasRemote, branch: p.branch } }); else E('project:' + slug(p.name), 'project', p.name, { path: p.path, source: 'machine_inventory.json', attrs: { stack: p.stack, branch: p.branch, lastCommit: p.lastCommit, hasRemote: p.hasRemote, gitRemotes: p.remotes, autoDiscovered: true } }); }
  db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('machine', JSON.stringify(mi.host));
}

/* ============ bridges (registre des bases connectées) ============ */
const br = load('bridges.json');
if (br) for (const b of (br.bridges || [])) {
  db.prepare('INSERT OR REPLACE INTO bridge(id,kind,name,vendor,target,reach,status,last_indexed,schema_json) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(b.id, b.kind, b.name, b.vendor || null, b.target || null, JSON.stringify(b.reach || {}), b.status || 'registered', b.lastIndexed || null, b.schema ? JSON.stringify(b.schema) : null);
  E('bridge:' + slug(b.id), 'bridge', b.name, { vendor: b.vendor, source: 'bridges.json', status: b.status, attrs: { kind: b.kind, target: b.target, reach: b.reach, tables: (b.schema?.tables || []).length || undefined } });
}

/* ============ dependencies (rayon d'impact : "X dépend de Y") ============ */
const deps = load('dependencies.json') || {};
for (const dp of (deps.deps || [])) {
  const s = ref(dp.from), t = ref(dp.to);
  if (s && t) L(s, t, dp.rel || 'dépend de', 'dependencies.json');
  else unresolvedDeps.push(`${dp.from} → ${dp.to}`);
}

/* ---------- résolution des liens "int:*" — data-driven (P0+P1) ----------
 * Aucun mapping en dur. Chaque intégration (chaîne libre slugifiée) est résolue vers :
 *  (1) un COMPTE si un alias spécifique (aka/identity) ou un provider MONO-compte matche ;
 *  (2) sinon un nœud SERVICE matérialisé depuis le registre vendeurs (app_catalog ∪ vendorDomains) ;
 *  (3) sinon non résolu (loggé en fin de build).
 * Les providers MULTI-comptes (Google, Supabase, GitHub) ne sont JAMAIS devinés : on retombe sur le
 * service générique plutôt que de rattacher au mauvais compte (corrige les collisions canoniques). */
const catalog = load('app_catalog.json') || { apps: [] };
const vendorReg = new Map();   // slug -> {name, domain, category}  (registre vendeurs unifié)
const addVendor = (name, domain, category) => {
  for (const raw of [name, String(name || '').split(/[ .\/(]/)[0]]) { const ck = slug(raw); if (ck && ck.length >= 3 && !vendorReg.has(ck)) vendorReg.set(ck, { name, domain: domain || null, category: category || null }); }
};
for (const [n, d] of Object.entries(cloud.vendorDomains || {})) if (n !== '_doc') addVendor(n, d, null);  // génériques courts d'abord (Google, Make…)
for (const a of (catalog.apps || [])) addVendor(a.name, a.domain, a.category);                            // puis le catalog (catégories, noms longs)
const provCount = {};
for (const a of (cloud.accounts || [])) provCount[canon(a.provider)] = (provCount[canon(a.provider)] || 0) + 1;
const acctEntries = [];   // {key, id}  alias -> compte (plus spécifique d'abord)
for (const a of (cloud.accounts || [])) {
  const id = 'account:' + slug(a.id);
  const keys = new Set([...(a.aka || []), a.identity].filter(Boolean).map(slug));
  if (provCount[canon(a.provider)] === 1) { keys.add(slug(a.provider)); keys.add(slug(String(a.provider).split(/[ .\/]/)[0])); }
  for (const k of keys) if (k && k.length >= 3) acctEntries.push({ key: k, id });
}
acctEntries.sort((x, y) => y.key.length - x.key.length);
const tokHit = (intKey, key) => ('-' + intKey + '-').includes('-' + key + '-');   // match à la frontière de token
function resolveIntegration(intId) {
  const k = slug(intId.replace(/^(int|vendor):/, ''));
  for (const e of acctEntries) if (tokHit(k, e.key)) return e.id;                  // (1) compte
  let best = null;
  for (const [vk, v] of vendorReg) if (tokHit(k, vk) && (!best || vk.length > best.k.length)) best = { k: vk, v };
  if (best) { const sid = 'service:' + slug(best.v.name); E(sid, 'service', best.v.name, { vendor: best.v.name, domaine: best.v.domain, source: 'app_catalog.json', attrs: { category: best.v.category, materialized: true } }); return sid; }
  return null;                                                                     // (3) non résolu
}
// PRE-PASS : résout les dst "int:*" et "vendor:*" AVANT l'écriture des entités (pour matérialiser les services dans `ents`)
for (const l of edges) {
  if (typeof l.dst === 'string' && /^(int|vendor):/.test(l.dst)) {
    const r = resolveIntegration(l.dst);
    if (r) l.dst = r; else { l._drop = true; unresolvedInts.add(l.dst.replace(/^(int|vendor):/, '')); }
  }
}

/* ---------- écriture des entités + doc (recherche) ---------- */
const insE = db.prepare('INSERT OR REPLACE INTO entity(id,kind,name,canonical,vendor,hosting,url,path,status,criticite,cycle,statut,cout,domaine,owner,source,doc,attrs) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const nn = v => (v === undefined ? null : v);   // node:sqlite refuse undefined
db.exec('BEGIN');
for (const e of ents.values()) {
  const attrsStr = JSON.stringify(e.attrs || {});
  const doc = [e.name, e.kind, e.vendor, e.hosting, e.domaine, e.status, e.statut, e.criticite, e.path, e.url, attrsStr].filter(Boolean).join(' ').toLowerCase();
  insE.run(nn(e.id), nn(e.kind), nn(e.name), nn(e.canonical), nn(e.vendor), nn(e.hosting), nn(e.url), nn(e.path), nn(e.status), nn(e.criticite), nn(e.cycle), nn(e.statut), nn(e.cout), nn(e.domaine), nn(e.owner), nn(e.source), nn(doc), nn(attrsStr));
}
const insL = db.prepare('INSERT INTO edge(src,dst,rel,source) VALUES(?,?,?,?)');
for (const l of edges) {
  if (l._drop) continue;   // int:* non résolu (pré-passe)
  insL.run(nn(l.src), nn(l.dst), nn(l.rel), nn(l.source));
}
db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('builtAt', new Date().toISOString());
db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('owner', owner);
db.exec('COMMIT');
db.flush();   // repli CLI : matérialise les écritures bufferisées (no-op avec node:sqlite)

const n = ents.size, ne = edges.length;
const counts = {};
for (const e of ents.values()) counts[e.kind] = (counts[e.kind] || 0) + 1;
console.log(`✓ karto.db construit — ${n} entités · ${ne} liens`);
console.log('  ' + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(' · '));
if (unresolvedInts.size) console.warn(`  ⚠ ${unresolvedInts.size} intégration(s) non résolue(s) (edge omis) — ajoute un mapping dans resolveInt() ou un compte/connecteur : ${[...unresolvedInts].sort().join(', ')}`);
if (unresolvedProjects.size) console.warn(`  ⚠ ${unresolvedProjects.size} projet(s) d'automatisation non résolu(s) (champ "project" libre) : ${[...unresolvedProjects].join(' | ')}`);
if (unresolvedDeps.length) console.warn(`  ⚠ ${unresolvedDeps.length} dépendance(s) non résolue(s) (nom inconnu) : ${unresolvedDeps.join(' | ')}`);
const dangling = [...new Set(edges.filter(l => !l._drop && !ents.has(l.dst)).map(l => l.dst))];
if (dangling.length) console.warn(`  ⚠ ${dangling.length} cible(s) d'edge sans entité (lien orphelin) : ${dangling.join(', ')}`);

/* ---------- snapshot & DÉTECTION DE DÉRIVE (nouveautés depuis le dernier build) ---------- */
const snapPath = join(__dir, 'data', '.karto-snapshot.json');
const expo = (disk.exposures || []);
const cur = { ts: new Date().toISOString(), ids: {}, exposures: expo.length, exposuresOpen: expo.filter(e => (e.status || 'open') !== 'closed').length };
for (const e of ents.values()) cur.ids[e.id] = { kind: e.kind, name: e.name, status: e.status || e.statut || null };
let prev = null; try { prev = JSON.parse(readFileSync(snapPath, 'utf8')); } catch {}
if (prev) {
  const fresh = Object.keys(cur.ids).filter(id => !prev.ids[id]);
  const gone = Object.keys(prev.ids).filter(id => !cur.ids[id]);
  const chg = Object.keys(cur.ids).filter(id => prev.ids[id] && (prev.ids[id].status || '') !== (cur.ids[id].status || ''));
  const lines = [];
  const show = (ids, src) => ids.map(id => (src[id] || {}).name || id).slice(0, 14).join(', ') + (ids.length > 14 ? '…' : '');
  if (fresh.length) lines.push(`  ＋ ${fresh.length} nouveauté(s) : ${show(fresh, cur.ids)}`);
  if (gone.length) lines.push(`  － ${gone.length} disparue(s) : ${show(gone, prev.ids)}`);
  for (const id of chg) lines.push(`  ~ statut : ${cur.ids[id].name} « ${prev.ids[id].status || '∅'} » → « ${cur.ids[id].status || '∅'} »`);
  const expoDelta = cur.exposures - prev.exposures;
  if (expoDelta > 0) lines.push(`  ⚠ ${expoDelta} exposition(s) sécurité en plus (total ${cur.exposures}, dont ${cur.exposuresOpen} ouverte(s))`);
  if (lines.length) { console.log('\n🔔 Dérive depuis le dernier build :'); lines.forEach(l => console.log(l)); }
  else console.log('\n🔔 Aucune dérive depuis le dernier build.');
}
writeFileSync(snapPath, JSON.stringify(cur, null, 2));
