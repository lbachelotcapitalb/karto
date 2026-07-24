#!/usr/bin/env node
// karto-ingest.mjs — INGESTION EN MASSE par source (l'« aspirateur » de karto).
// Complète karto-write.mjs (fiches unitaires) : ici une session Claude qui a les MCP/CLI/
// navigateur d'une source (Make, Cloudflare, Drive, VPS…) reverse STRUCTURELLEMENT ce
// qu'elle a lu, au lieu de « reporter à la main » dans les JSON (KARTO.md § Connecteurs).
//
// Contrat par handler : merge idempotent par clé (id/name), PRÉSERVE l'enrichissement
// manuel (claudeTier, chain, does, obs, criticite, usedBy…), garde anti-secret sur tout
// le payload, backup .bak, estampille data/sources.json (fraîcheur par source).
// Après ingestion : karto_rebuild / node karto-db.mjs build.
//
// Usage CLI : node karto-ingest.mjs <source> '<json>'      (ou importé par karto-mcp.mjs)
//             node karto-ingest.mjs list                    (sources ingérables + moules)

import { loadData, saveData, noSecret, SECRET_ERR, canonize } from './karto-write.mjs';
import { touchSource } from './karto-sources.mjs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

// merge d'un tableau par clé : les champs du nouvel item écrasent, SAUF ceux de `keep`
// (enrichissement manuel) qui ne sont écrasés que s'ils étaient absents.
function mergeBy(arr, items, keyOf, keep = []) {
  arr = arr || [];
  let created = 0, updated = 0;
  for (const it of items || []) {
    const k = canonize(keyOf(it));
    if (!k) continue;
    const i = arr.findIndex(x => canonize(keyOf(x)) === k);
    if (i < 0) { arr.push(it); created++; }
    else {
      const prev = arr[i];
      const kept = {}; for (const f of keep) if (prev[f] !== undefined && it[f] === undefined) kept[f] = prev[f];
      arr[i] = { ...prev, ...it, ...kept };
      updated++;
    }
  }
  return { arr, created, updated };
}

// Les URLs de webhook Make portent le token déclencheur → jamais stockées en clair.
const redactHook = u => typeof u === 'string' ? u.replace(/(hook\.[a-z0-9.]*make\.com\/)[a-z0-9]{8,}/i, '$1<redacted — token déclencheur = secret, vit dans Make>') : u;

/* ── chaque handler : { source: id data/sources.json, mold: doc du payload, run(payload) } ── */
export const INGEST = {

  make: {
    source: 'make',
    mold: "{ org?, team?, plan?, scenarios?:[{id,name,active,trigger,modules[],does?}], connections?:[{id,app,type,account,usedBy[]?,expire?}], webhooks?:[{id,name,type,url?,enabled,scenario?,queue?}] } — les URLs de webhook sont auto-caviardées (token). Préservés : does/claudeTier/chain/obs des scénarios.",
    run(p = {}) {
      const c = loadData('cloud_inventory.json'); if (!c) return { error: 'cloud_inventory.json illisible' };
      c.make = c.make || {};
      for (const w of (p.webhooks || [])) w.url = redactHook(w.url);
      if (noSecret(p)) return SECRET_ERR;
      for (const k of ['org', 'team', 'plan']) if (p[k] != null) c.make[k] = p[k];
      const out = {};
      for (const [k, keyOf, keep] of [
        ['scenarios', x => x.id || x.name, ['does', 'claudeTier', 'chain', 'obs']],
        ['connections', x => x.id || x.app, ['usedBy']],
        ['webhooks', x => x.id || x.name, ['queue', 'scenario']],
      ]) {
        if (!p[k]) continue;
        const r = mergeBy(c.make[k], p[k], keyOf, keep);
        c.make[k] = r.arr; out[k] = { created: r.created, updated: r.updated };
      }
      saveData('cloud_inventory.json', c);
      return { ok: true, file: 'cloud_inventory.json', ...out };
    }
  },

  cloudflare: {
    source: 'cloudflare',
    mold: "{ account?, domain?, workers?, kvNamespaces?, d1Databases?, r2?, note? } — merge de scalaires (instantané).",
    run(p = {}) {
      if (noSecret(p)) return SECRET_ERR;
      const c = loadData('cloud_inventory.json'); if (!c) return { error: 'cloud_inventory.json illisible' };
      c.cloudflare = { ...(c.cloudflare || {}), ...p };
      saveData('cloud_inventory.json', c);
      return { ok: true, file: 'cloud_inventory.json', keys: Object.keys(p) };
    }
  },

  gdrive: {
    source: 'gdrive',
    mold: "{ account?, serviceAccount?, keyFolders?:[{name,id?,note?}], keySheets?:[{name,note?}] } — merge par name. Préservées : notes existantes.",
    run(p = {}) {
      if (noSecret(p)) return SECRET_ERR;
      const c = loadData('cloud_inventory.json'); if (!c) return { error: 'cloud_inventory.json illisible' };
      c.googleDrive = c.googleDrive || {};
      for (const k of ['account', 'serviceAccount']) if (p[k] != null) c.googleDrive[k] = p[k];
      const out = {};
      for (const k of ['keyFolders', 'keySheets']) {
        if (!p[k]) continue;
        const r = mergeBy(c.googleDrive[k], p[k], x => x.name, ['note']);
        c.googleDrive[k] = r.arr; out[k] = { created: r.created, updated: r.updated };
      }
      saveData('cloud_inventory.json', c);
      return { ok: true, file: 'cloud_inventory.json', ...out };
    }
  },

  'hetzner-workloads': {
    source: 'vps-hetzner',
    mold: "{ workloads:[{name,path?,trigger?,does?,secrets?:[NOMS only]}] } — merge par name. Préservés : does/secrets curatés.",
    run(p = {}) {
      if (noSecret(p)) return SECRET_ERR;
      if (!Array.isArray(p.workloads)) return { error: 'champ requis : workloads[]' };
      const c = loadData('cloud_inventory.json'); if (!c) return { error: 'cloud_inventory.json illisible' };
      c.hetzner = c.hetzner || {};
      const r = mergeBy(c.hetzner.workloads, p.workloads, x => x.name, ['does', 'secrets']);
      c.hetzner.workloads = r.arr;
      saveData('cloud_inventory.json', c);
      return { ok: true, file: 'cloud_inventory.json', created: r.created, updated: r.updated };
    }
  },

  'mcp-tools': {
    source: null,   // enrichissement des connecteurs, pas une source du répertoire
    mold: "{ connector: id|name (connectors.list), tools:[noms d'outils], readonly?, note? } — la session déclare les outils réellement exposés par un serveur MCP qu'elle a branché.",
    run(p = {}) {
      if (noSecret(p)) return SECRET_ERR;
      if (!p.connector || !Array.isArray(p.tools)) return { error: 'champs requis : connector, tools[]' };
      const c = loadData('cloud_inventory.json'); if (!c) return { error: 'cloud_inventory.json illisible' };
      const list = (c.connectors && c.connectors.list) || [];
      const k = canonize(p.connector);
      const hit = list.find(x => canonize(x.id) === k || canonize(x.name) === k || canonize(x.name).includes(k));
      if (!hit) return { error: `connecteur introuvable : ${p.connector} (connus : ${list.map(x => x.id).join(', ')})` };
      hit.tools = p.tools;
      if (p.readonly != null) hit.readonly = p.readonly;
      if (p.note) hit.note = p.note;
      saveData('cloud_inventory.json', c);
      return { ok: true, file: 'cloud_inventory.json', connector: hit.id, tools: p.tools.length };
    }
  },

  runs: {
    source: 'runs-local',
    mold: "{ runs:[{key: bout unique du nom de l'automatisation (convention automation_plain), last_run: ISO, status: 'ok'|'fail'|'stale', duration_s?, note?, source?: 'launchd'|'vps-cron'|'gha'|'make'}] } — merge par key → attrs.lastRun au build.",
    run(p = {}) {
      if (noSecret(p)) return SECRET_ERR;
      if (!Array.isArray(p.runs)) return { error: 'champ requis : runs[]' };
      const bad = p.runs.find(r => !r.key || !r.last_run || !['ok', 'fail', 'stale'].includes(r.status));
      if (bad) return { error: 'chaque run exige key, last_run (ISO), status ∈ ok|fail|stale — fautif : ' + JSON.stringify(bad).slice(0, 120) };
      const d = loadData('runs_summary.json') || { _doc: "Dernier passage connu par automatisation (clé = bout unique du nom, convention automation_plain). Alimenté par karto_ingest source=runs / runs-collect (phase 2). Mergé au build en attrs.lastRun.", runs: [] };
      const r = mergeBy(d.runs, p.runs, x => x.key);
      d.runs = r.arr; d.generated = new Date().toISOString();
      saveData('runs_summary.json', d);
      return { ok: true, file: 'runs_summary.json', created: r.created, updated: r.updated };
    }
  },

  supabase: {
    source: 'supabase',
    mold: "{ projects:[{ref,name,region?,status?,pg?,created?}] } — merge par ref dans cloud.supabase.projects. Préservés : account/app/appNote/usedBy/note curatés. (Alternative CLI : SUPABASE_ACCESS_TOKEN + karto-sync apply.)",
    run(p = {}) {
      if (noSecret(p)) return SECRET_ERR;
      if (!Array.isArray(p.projects)) return { error: 'champ requis : projects[]' };
      const c = loadData('cloud_inventory.json'); if (!c) return { error: 'cloud_inventory.json illisible' };
      c.supabase = c.supabase || {};
      const items = p.projects.map(x => ({ ...x, ...(x.ref && !x.host ? { host: 'db.' + x.ref + '.supabase.co' } : {}) }));
      const r = mergeBy(c.supabase.projects, items, x => x.ref || x.name, ['account', 'app', 'appNote', 'usedBy', 'note']);
      c.supabase.projects = r.arr;
      saveData('cloud_inventory.json', c);
      return { ok: true, file: 'cloud_inventory.json', created: r.created, updated: r.updated };
    }
  },

  'hostinger-domains': {
    source: 'hostinger',
    mold: "{ domains:[{name,registrar?,dns?,host?,email?,statut?}] } — merge par name ; les champs CURATÉS (criticite, usedBy, project, note, subdomains) sont préservés.",
    run(p = {}) {
      if (noSecret(p)) return SECRET_ERR;
      if (!Array.isArray(p.domains)) return { error: 'champ requis : domains[]' };
      const c = loadData('cloud_inventory.json'); if (!c) return { error: 'cloud_inventory.json illisible' };
      c.domains = c.domains || { list: [] };
      const r = mergeBy(c.domains.list, p.domains, x => x.name, ['criticite', 'usedBy', 'project', 'note', 'subdomains']);
      c.domains.list = r.arr;
      saveData('cloud_inventory.json', c);
      return { ok: true, file: 'cloud_inventory.json', created: r.created, updated: r.updated };
    }
  },

  'source-status': {
    source: null,
    mold: "{ id: id de data/sources.json, status?: 'ok'|'manual'|'snapshot'|'planned'|'probe'|'absent', note? } — résultat d'une sonde (ex. Railway : compte inexistant → status:'absent').",
    run(p = {}) {
      if (noSecret(p)) return SECRET_ERR;
      if (!p.id) return { error: 'champ requis : id' };
      const ok = touchSource(__dir, p.id, { ...(p.status ? { status: p.status } : {}), ...(p.note ? { note: p.note } : {}) });
      return ok ? { ok: true, file: 'sources.json', id: p.id } : { error: 'source inconnue : ' + p.id };
    }
  },
};

export function ingest(source, payload) {
  const h = INGEST[source];
  if (!h) return { error: `source ingérable inconnue : ${source}. Connues : ${Object.keys(INGEST).join(', ')}` };
  const r = h.run(payload || {});
  if (r && r.ok && h.source) touchSource(__dir, h.source);
  return r;
}

/* ── CLI ── */
if (process.argv[1] && process.argv[1].endsWith('karto-ingest.mjs')) {
  const [source, payload] = process.argv.slice(2);
  if (!source || source === 'list') {
    for (const [k, h] of Object.entries(INGEST)) console.log(`▸ ${k}\n  ${h.mold}\n`);
    process.exit(0);
  }
  let arg = {}; try { arg = payload ? JSON.parse(payload) : {}; } catch { console.error('JSON invalide'); process.exit(1); }
  const r = ingest(source, arg);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.error ? 1 : 0);
}
