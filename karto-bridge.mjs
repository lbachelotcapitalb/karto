#!/usr/bin/env node
// karto-bridge.mjs — le « bridge des bases connectées ».
// Registre SOFTCODE de toutes les bases/services où vit ta donnée, + COMMENT y
// accéder (jamais de secret), + un instantané de SCHÉMA (tables/colonnes, pas de
// lignes) pour les bases réellement atteignables depuis cette machine.
//
//   node karto-bridge.mjs gen     -> (re)dérive data/bridges.json depuis les inventaires
//   node karto-bridge.mjs probe   -> sonde le schéma des bridges atteignables (sqlite/psql)
//   node karto-bridge.mjs list    -> affiche le registre
//
// Le but : l'IA lit data/bridges.json (ou karto.db table bridge) pour savoir
// instantanément quelles bases existent, leur forme, et la commande pour requêter.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const cmd = process.argv[2] || 'list';
const load = f => { try { return JSON.parse(readFileSync(join(__dir, 'data', f), 'utf8')); } catch { return null; } };
const sh = (c, t = 8000) => { try { return execSync(c, { timeout: t, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim(); } catch { return null; } };
const BRIDGES = join(__dir, 'data', 'bridges.json');

/* ---------------- gen : dérive le registre depuis cloud_inventory + machine_inventory ---------------- */
function gen() {
  const cloud = load('cloud_inventory.json') || {};
  const mi = load('machine_inventory.json') || {};
  const disk = load('disk_inventory.json') || {};
  const prev = load('bridges.json');
  const prevById = new Map((prev?.bridges || []).map(b => [b.id, b]));
  const bridges = [];
  // `gen` re-dérive le registre depuis les inventaires : il doit PRÉSERVER ce qu'un sondage a
  // appris et qu'aucun inventaire ne contient. schemaProvenance et probeNote en font partie —
  // sans eux, un schéma survivait à `gen` mais perdait d'où il vient (et un schéma sans
  // provenance est indiscernable d'une supposition, cf. le moule bridge-schema).
  const add = b => {
    const old = prevById.get(b.id);
    if (old?.schema && !b.schema) b.schema = old.schema;
    if (old?.schemaProvenance) b.schemaProvenance = old.schemaProvenance;
    if (old?.probeNote) b.probeNote = old.probeNote;
    if (old?.lastIndexed) b.lastIndexed = b.lastIndexed || old.lastIndexed;
    // Un verdict de SONDAGE prime sur le statut recopié de l'inventaire. Même doctrine qu'en
    // B1 : l'intention vit dans la carte, l'état vient du système — et seule la sonde a
    // réellement touché la chose. Défaut préexistant révélé le 25/07 : un `gen` lancé après un
    // `probe` remettait « indexed » à « reachable »/« registered », donc l'indexation d'un
    // bridge disparaissait à la première re-dérivation, en silence.
    if (['absent', 'not-indexable', 'unreachable', 'indexed', 'declared'].includes(old?.status)) b.status = old.status;
    bridges.push(b);
  };

  // Supabase (cloud) — chaque projet = une base Postgres managée
  for (const d of [...(cloud.supabase?.projects || []), ...(cloud.supabase?.offAccount || [])]) {
    add({ id: 'sb-' + (d.ref || d.name).replace(/[^a-z0-9]/gi, '').slice(0, 24), kind: 'postgres', name: 'Supabase ' + d.name, vendor: 'Supabase',
      target: d.host || (d.ref ? `db.${d.ref}.supabase.co` : ''), app: d.app,
      reach: { via: 'supabase-pat', ref: d.ref, env: 'SUPABASE_ACCESS_TOKEN', dashboard: d.ref ? `https://supabase.com/dashboard/project/${d.ref}` : '', mcp: 'supabase MCP (1 compte à la fois)', query: d.ref ? `node supabase-refresh.mjs  # ou MCP execute_sql sur ${d.ref}` : '' },
      status: d.status === 'ACTIVE_HEALTHY' ? 'active' : (d.status || 'registered').toLowerCase() });
  }
  // Bases locales (machine) — postgres en cours / fichiers sqlite
  for (const ldb of (mi.localDatabases || [])) {
    if (ldb.file) add({ id: 'sqlite-' + (ldb.path || '').split('/').pop().replace(/[^a-z0-9]/gi, '').slice(0, 24), kind: 'sqlite', name: 'SQLite ' + (ldb.path || '').split('/').pop(), vendor: 'SQLite', target: ldb.path, reach: { via: 'sqlite3', path: ldb.path, query: `sqlite3 -json "${ldb.path}" "<SQL>"` }, status: 'reachable' });
    else if (ldb.engine === 'postgres' && ldb.running) {
      // retrouve un .env qui porte un DATABASE_URL pour ce postgres local
      const proj = (disk.projects || []).find(p => (p.envFiles || []).some(ef => (ef.vars || []).some(v => /DATABASE_URL/.test(v.name))) && /postgres/i.test(JSON.stringify(p.integrations || []) + (p.stack || []).join(',')));
      const ef = proj?.envFiles?.find(e => (e.vars || []).some(v => /DATABASE_URL/.test(v.name)));
      add({ id: 'pg-local', kind: 'postgres', name: 'Postgres local' + (proj ? ` (${proj.name})` : ''), vendor: 'PostgreSQL', target: ldb.hint || '127.0.0.1', app: proj?.name,
        reach: { via: 'psql', envFile: ef?.path || '(introuvable)', var: 'DATABASE_URL', note: 'psql non sur PATH — fournir le binaire/URL pour requêter', query: 'psql "$DATABASE_URL" -c "\\\\dt"' }, status: 'running' });
    }
  }
  // IndexedDB (apps local-first) — dérivé des projets
  for (const p of (disk.projects || [])) {
    if (/indexeddb|idb-keyval/i.test((p.stack || []).join(' ') + ' ' + (p.notes || ''))) {
      const key = (p.notes || '').match(/cl[ée]\s+([a-z0-9:_-]+)/i)?.[1] || (p.name + ':state');
      add({ id: 'idb-' + p.name.toLowerCase().replace(/[^a-z0-9]/g, ''), kind: 'indexeddb', name: p.name + ' (IndexedDB navigateur)', vendor: 'Browser', target: key, app: p.name,
        reach: { via: 'browser', key, note: 'Donnée client-only ; export JSON via l\'app. Pas de copie hors du Mac sans export.', export: 'bouton « Exporter » dans l\'app' }, status: 'client-only' });
    }
  }
  // Coffre de secrets Bitwarden
  // D4 — `accountId` : le générateur SAIT de quel compte il dérive le pont (il en fabrique
  // l'id juste en dessous) et jetait l'information. Résultat : 5 ponts orphelins dans le
  // graphe, alors que le lien était connu à la source. Même motif qu'en C1, où le `store`
  // d'un secret était câblé à null à l'ingestion : la donnée existait, elle n'était pas
  // portée. On l'écrit — karto-db la résout en arête, sans jamais deviner d'après l'id.
  for (const a of (cloud.accounts || [])) {
    if (/bitwarden/i.test(a.provider)) add({ id: 'bw-vault', kind: 'secrets', name: 'Bitwarden (coffre)', vendor: 'Bitwarden', target: a.url, accountId: a.id, reach: { via: 'bw-cli', note: 'bw unlock --raw → BW_SESSION ; lister sans révéler : bw list items', query: 'bw list items | (jq) noms only' }, status: 'registered' });
    if (/google/i.test(a.provider) && /drive/i.test(a.note || a.url || '')) add({ id: 'gdrive-' + a.id, kind: 'files', name: 'Google Drive · ' + (a.email || a.identity || a.id), vendor: 'Google', target: a.email, accountId: a.id, reach: { via: 'mcp', note: 'Google Drive MCP (on-demand dans une session Claude)', query: 'MCP search_files / read_file_content' }, status: 'registered' });
  }

  const out = { _doc: 'Registre SOFTCODE des bases/services connectés (le « bridge »). Dérivé par `node karto-bridge.mjs gen` depuis cloud_inventory + machine_inventory. reach = COMMENT atteindre la donnée (jamais de secret). schema = instantané de structure (rempli par `probe`). Édite/ajoute une entrée à la main et relance `gen` (les schémas déjà sondés sont préservés).', generated: new Date().toISOString().slice(0, 10), bridges };
  writeFileSync(BRIDGES, JSON.stringify(out, null, 2));
  console.log(`✓ data/bridges.json — ${bridges.length} bridges`);
  const byKind = {}; for (const b of bridges) byKind[b.kind] = (byKind[b.kind] || 0) + 1;
  console.log('  ' + Object.entries(byKind).map(([k, v]) => `${v} ${k}`).join(' · '));
}

/* ---------------- accès aux jetons du coffre (jamais affichés, jamais persistés) ----------------
 * Les PAT Supabase vivent dans Bitwarden. On les lit en RAM au moment du sondage. Plusieurs
 * comptes coexistent (Mon Organisation, MonAutreCompte…) : on essaie chaque PAT et on garde celui qui
 * répond pour ce projet — plutôt qu'un mapping ref→compte codé en dur qui périmerait au
 * premier projet déplacé. `null` si le coffre est verrouillé : on saute, on n'invente pas.  */
const PAT_SOURCES = [
  { item: 'Supabase · Management PAT — Mon Organisation', field: null },              // PAT dans le mot de passe
  { item: 'Supabase · PAT polar (compte MonAutreCompte)', field: 'SUPABASE_POLAR_PAT' },
];
let _pats = null;
function supabasePats(session) {
  if (_pats) return _pats;
  _pats = [];
  if (!session) return _pats;
  for (const s of PAT_SOURCES) {
    try {
      const item = JSON.parse(execFileSync('bw', ['get', 'item', s.item], { encoding: 'utf8', env: { ...process.env, BW_SESSION: session }, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
      const v = s.field ? (item.fields || []).find(f => f.name === s.field)?.value : item.login?.password;
      if (v) _pats.push({ label: s.item, token: v });
    } catch { /* item absent → PAT suivant */ }
  }
  return _pats;
}

// Introspection d'un projet Supabase par l'API Management (le port Postgres direct n'est pas
// joignable depuis le Mac — constat A6). Renvoie null si AUCUN PAT ne couvre ce projet :
// « non couvert » et « vide » sont deux choses différentes, on ne les confond pas.
async function supabaseSchema(ref, pats) {
  const SQL = "select table_name, column_name, data_type from information_schema.columns "
            + "where table_schema = 'public' order by table_name, ordinal_position";
  for (const p of pats) {
    try {
      const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + p.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: SQL }),
      });
      if (!r.ok) continue;                                  // 401/404 = ce PAT ne couvre pas ce projet
      const rows = await r.json();
      if (!Array.isArray(rows)) continue;
      const byTable = new Map();
      for (const row of rows) {
        if (!byTable.has(row.table_name)) byTable.set(row.table_name, []);
        byTable.get(row.table_name).push(`${row.column_name}:${row.data_type}`);
      }
      return { via: p.label, tables: [...byTable].map(([name, columns]) => ({ name, columns })) };
    } catch { /* PAT suivant */ }
  }
  return null;
}

// Structure du coffre : dossiers, comptage par type, et NOMS des champs masqués.
// Aucune valeur, aucun nom d'entrée — le « schéma » d'un coffre, c'est sa forme.
function vaultSchema(session) {
  if (!session) return null;
  try {
    const items = JSON.parse(execFileSync('bw', ['list', 'items'], { encoding: 'utf8', env: { ...process.env, BW_SESSION: session }, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }));
    let folders = [];
    try { folders = JSON.parse(execFileSync('bw', ['list', 'folders'], { encoding: 'utf8', env: { ...process.env, BW_SESSION: session }, stdio: ['ignore', 'pipe', 'ignore'] })).map(f => f.name).filter(Boolean); } catch {}
    const TYPES = { 1: 'login', 2: 'note sécurisée', 3: 'carte', 4: 'identité' };
    const byType = {};
    const fieldNames = new Set();
    for (const it of items) {
      const t = TYPES[it.type] || ('type ' + it.type);
      byType[t] = (byType[t] || 0) + 1;
      for (const f of (it.fields || [])) if (f?.type === 1 && f.name) fieldNames.add(f.name);
    }
    return { total: items.length, byType, folders, maskedFieldNames: [...fieldNames].sort(),
      note: 'Forme du coffre seulement : comptes par type, dossiers, et NOMS des champs masqués. Aucune valeur, aucun nom d\'entrée.' };
  } catch { return null; }
}

/* ---------------- probe : sonde le schéma des bridges atteignables ---------------- */
async function probe() {
  const reg = load('bridges.json'); if (!reg) { console.error('✗ data/bridges.json absent — lance `gen` d\'abord'); process.exit(1); }
  let probed = 0;
  // Session Bitwarden : celle de l'appelant, sinon déverrouillage autonome (fenêtre masquée).
  let session = process.env.BW_SESSION || '';
  if (!session) { try { session = (await import('./bw-unlock.mjs')).bwUnlock(); } catch { session = ''; } }
  const pats = supabasePats(session);
  if (!session) console.log('  · coffre verrouillé — Supabase et Bitwarden non sondés (ni inventés)');

  for (const b of reg.bridges) {
    if (b.kind === 'sqlite' && b.reach?.path && existsSync(b.reach.path)) {
      const tables = (sh(`sqlite3 "${b.reach.path}" ".tables"`) || '').split(/\s+/).filter(Boolean);
      const schema = { tables: [] };
      for (const t of tables.slice(0, 50)) {
        const cols = (sh(`sqlite3 -json "${b.reach.path}" "PRAGMA table_info('${t.replace(/'/g, '')}')"`) || '[]');
        let parsed = []; try { parsed = JSON.parse(cols).map(c => `${c.name}:${c.type || '?'}`); } catch {}
        schema.tables.push({ name: t, columns: parsed });
      }
      b.schema = schema; b.lastIndexed = new Date().toISOString(); b.status = 'indexed'; probed++;
      console.log(`  ✓ ${b.name} — ${schema.tables.length} tables`);
    } else if (b.kind === 'postgres' && b.reach?.via === 'psql') {
      // tentative seulement si DATABASE_URL est dans l'environnement (jamais lu d'un fichier)
      const url = process.env.DATABASE_URL;
      if (url && sh('command -v psql')) {
        const t = sh(`psql "${url}" -At -c "select tablename from pg_tables where schemaname not in ('pg_catalog','information_schema')"`);
        if (t) { b.schema = { tables: t.split('\n').filter(Boolean).map(name => ({ name })) }; b.lastIndexed = new Date().toISOString(); b.status = 'indexed'; probed++; console.log(`  ✓ ${b.name} — ${b.schema.tables.length} tables`); continue; }
      }
      console.log(`  · ${b.name} — non sondé (psql/DATABASE_URL indisponible ici)`);
    } else if (b.reach?.via === 'supabase-pat' && b.reach?.ref) {
      const s = await supabaseSchema(b.reach.ref, pats);
      if (s) {
        b.schema = { tables: s.tables }; b.lastIndexed = new Date().toISOString(); b.status = 'indexed'; probed++;
        console.log(`  ✓ ${b.name} — ${s.tables.length} tables (schema public, via « ${s.via} »)`);
      } else if (b.schema && Object.keys(b.schema).length) {
        // ON REMPLIT LES TROUS, ON N'ÉCRASE JAMAIS (règle d'ingestion du lot D) : ce bridge a
        // déjà un schéma obtenu par un AUTRE canal (ex. introspection depuis le VPS, où vit son
        // identifiant). Le fait que MON canal n'y arrive pas n'est pas une information sur lui.
        console.log(`  = ${b.name} — déjà indexé par un autre canal (${b.schemaProvenance ? b.schemaProvenance.split('(')[0].trim() : 'provenance non notée'}) — laissé intact`);
      } else {
        // Distinguer « aucun PAT ne le couvre » de « le projet n'existe pas » : le second se
        // voit au DNS (un projet Supabase vivant résout toujours son apex).
        const alive = !!sh(`dig +short ${b.reach.ref}.supabase.co`);
        b.status = alive ? 'unreachable' : 'absent';
        b.probeNote = alive
          ? 'Projet VIVANT (apex DNS résout) mais aucun PAT du coffre ne le couvre — schéma non lisible d\'ici. Ajouter un PAT de son compte pour l\'indexer.'
          : 'Projet INEXISTANT : son apex DNS ne résout pas, alors qu\'un projet Supabase vivant résout toujours. Référence à retirer de la carte (décision de Owner requise).';
        console.log(`  ${alive ? '·' : '✗'} ${b.name} — ${alive ? 'vivant mais hors périmètre des PAT' : 'INEXISTANT (DNS ne résout pas)'}`);
      }
    } else if (b.reach?.via === 'bw-cli') {
      const s = vaultSchema(session);
      if (s) {
        b.schema = s; b.lastIndexed = new Date().toISOString(); b.status = 'indexed'; probed++;
        console.log(`  ✓ ${b.name} — ${s.total} entrées · ${s.folders.length} dossiers · ${s.maskedFieldNames.length} noms de champs masqués`);
      } else console.log(`  · ${b.name} — coffre verrouillé, non sondé`);
    } else {
      console.log(`  · ${b.name} — sondage distant (via ${b.reach?.via}) non exécuté localement`);
    }
  }
  writeFileSync(BRIDGES, JSON.stringify(reg, null, 2));
  import('./karto-sources.mjs').then(m => m.touchSource(__dir, 'bridges')).catch(() => {});
  const withSchema = reg.bridges.filter(b => b.schema && Object.keys(b.schema).length).length;
  console.log(`✓ ${probed} bridge(s) sondé(s) cette passe — ${withSchema}/${reg.bridges.length} bridges ont un schéma`);
}

function list() {
  const reg = load('bridges.json'); if (!reg) { console.error('✗ data/bridges.json absent — lance `gen`'); process.exit(1); }
  for (const b of reg.bridges) {
    const tbl = b.schema?.tables?.length ? ` · ${b.schema.tables.length} tables` : '';
    console.log(`[${b.kind}] ${b.name}  →  ${b.reach?.via}${tbl}  (${b.status})`);
  }
  console.log(`\n${reg.bridges.length} bridges. Détail/forme : data/bridges.json. Requête : voir reach.query de chaque bridge.`);
}

if (cmd === 'gen') gen();
else if (cmd === 'probe') await probe();
else list();
