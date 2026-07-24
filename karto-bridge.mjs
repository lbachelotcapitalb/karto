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
import { execSync } from 'node:child_process';
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
  const add = b => { const old = prevById.get(b.id); if (old?.schema && !b.schema) b.schema = old.schema; if (old?.lastIndexed) b.lastIndexed = b.lastIndexed || old.lastIndexed; bridges.push(b); };

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
  for (const a of (cloud.accounts || [])) {
    if (/bitwarden/i.test(a.provider)) add({ id: 'bw-vault', kind: 'secrets', name: 'Bitwarden (coffre)', vendor: 'Bitwarden', target: a.url, reach: { via: 'bw-cli', note: 'bw unlock --raw → BW_SESSION ; lister sans révéler : bw list items', query: 'bw list items | (jq) noms only' }, status: 'registered' });
    if (/google/i.test(a.provider) && /drive/i.test(a.note || a.url || '')) add({ id: 'gdrive-' + a.id, kind: 'files', name: 'Google Drive · ' + (a.email || a.identity || a.id), vendor: 'Google', target: a.email, reach: { via: 'mcp', note: 'Google Drive MCP (on-demand dans une session Claude)', query: 'MCP search_files / read_file_content' }, status: 'registered' });
  }

  const out = { _doc: 'Registre SOFTCODE des bases/services connectés (le « bridge »). Dérivé par `node karto-bridge.mjs gen` depuis cloud_inventory + machine_inventory. reach = COMMENT atteindre la donnée (jamais de secret). schema = instantané de structure (rempli par `probe`). Édite/ajoute une entrée à la main et relance `gen` (les schémas déjà sondés sont préservés).', generated: new Date().toISOString().slice(0, 10), bridges };
  writeFileSync(BRIDGES, JSON.stringify(out, null, 2));
  console.log(`✓ data/bridges.json — ${bridges.length} bridges`);
  const byKind = {}; for (const b of bridges) byKind[b.kind] = (byKind[b.kind] || 0) + 1;
  console.log('  ' + Object.entries(byKind).map(([k, v]) => `${v} ${k}`).join(' · '));
}

/* ---------------- probe : sonde le schéma des bridges atteignables ---------------- */
function probe() {
  const reg = load('bridges.json'); if (!reg) { console.error('✗ data/bridges.json absent — lance `gen` d\'abord'); process.exit(1); }
  let probed = 0;
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
    } else {
      console.log(`  · ${b.name} — sondage distant (via ${b.reach?.via}) non exécuté localement`);
    }
  }
  writeFileSync(BRIDGES, JSON.stringify(reg, null, 2));
  import('./karto-sources.mjs').then(m => m.touchSource(__dir, 'bridges')).catch(() => {});
  console.log(`✓ ${probed} bridge(s) sondé(s) avec schéma`);
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
else if (cmd === 'probe') probe();
else list();
