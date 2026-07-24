#!/usr/bin/env node
// browser-collect.mjs — mine l'HISTORIQUE NAVIGATEUR local pour repérer les connexions
// potentielles à recenser : SaaS/clouds réellement fréquentés mais absents de la carte.
//
// DOCTRINE VIE PRIVÉE (stricte) :
//   • DOMAINES AGRÉGÉS uniquement — jamais d'URL complète, de titre, de recherche,
//     de cookie ni de credential. La navigation personnelle (hors catalogue SaaS) est
//     IGNORÉE : seuls les domaines matchant app_catalog/vendorDomains/probes sortent.
//   • Sortie LOCALE : data/browser_candidates.local.json (gitignoré, jamais poussé).
//     Un candidat n'entre dans la carte que si Owner le valide (karto_add_account / ingest).
//
//   node browser-collect.mjs            → data/browser_candidates.local.json
//   node browser-collect.mjs --print    → stdout seulement
//
// Répond aussi aux sondes « existence de compte » (Railway, Vercel…) : zéro visite du
// dashboard en 180 j = très probablement pas de compte → note dans data/sources.json.

import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './karto-sqlite.mjs';
import { touchSource } from './karto-sources.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const PRINT = process.argv.includes('--print');
const WINDOW_DAYS = 180;
const load = f => { try { return JSON.parse(readFileSync(join(__dir, 'data', f), 'utf8')); } catch { return null; } };

/* ---------- sources d'historique (copie temporaire : les bases sont verrouillées) ---------- */
const HISTORIES = [
  { browser: 'Chrome', kind: 'chromium', path: join(HOME, 'Library/Application Support/Google/Chrome/Default/History') },
  { browser: 'Arc', kind: 'chromium', path: join(HOME, 'Library/Application Support/Arc/User Data/Default/History') },
  { browser: 'Brave', kind: 'chromium', path: join(HOME, 'Library/Application Support/BraveSoftware/Brave-Browser/Default/History') },
  { browser: 'Edge', kind: 'chromium', path: join(HOME, 'Library/Application Support/Microsoft Edge/Default/History') },
  { browser: 'Safari', kind: 'safari', path: join(HOME, 'Library/Safari/History.db') },
];

// chromium : last_visit_time = µs depuis 1601 ; safari : s depuis 2001-01-01
const CHROMIUM_EPOCH = Date.UTC(1601, 0, 1);
const SAFARI_EPOCH = Date.UTC(2001, 0, 1);
const cutoff = Date.now() - WINDOW_DAYS * 86400000;

const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };

// agrège host -> {visits, last(ms), browsers:Set}
const agg = new Map();
const bump = (host, visits, lastMs, browser) => {
  if (!host || lastMs < cutoff) return;
  const e = agg.get(host) || { visits: 0, last: 0, browsers: new Set() };
  e.visits += visits; e.last = Math.max(e.last, lastMs); e.browsers.add(browser);
  agg.set(host, e);
};

const tmp = mkdtempSync(join(tmpdir(), 'karto-bh-'));
const scanned = [];
for (const h of HISTORIES) {
  if (!existsSync(h.path)) continue;
  const cp = join(tmp, h.browser + '.db');
  try { copyFileSync(h.path, cp); } catch { console.warn(`⚠ ${h.browser} : historique illisible (accès disque complet ?) — ignoré`); continue; }
  try {
    const db = openDb(cp, { readOnly: true });
    if (h.kind === 'chromium') {
      // last_visit_time (µs depuis 1601) déborde l'entier JS sûr → réduit en SECONDES côté SQL
      for (const r of db.prepare('SELECT url, visit_count v, CAST(last_visit_time/1000000 AS INTEGER) t FROM urls WHERE visit_count > 0').all())
        bump(hostOf(r.url), r.v, CHROMIUM_EPOCH + r.t * 1000, h.browser);
    } else {
      for (const r of db.prepare('SELECT i.url url, i.visit_count v, MAX(x.visit_time) t FROM history_items i JOIN history_visits x ON x.history_item = i.id GROUP BY i.id').all())
        bump(hostOf(r.url), r.v, SAFARI_EPOCH + r.t * 1000, h.browser);
    }
    scanned.push(h.browser);
  } catch (e) { console.warn(`⚠ ${h.browser} : lecture échouée (${String(e.message || e).slice(0, 60)}) — ignoré`); }
}
rmSync(tmp, { recursive: true, force: true });

/* ---------- croisement : catalogue SaaS + vendeurs connus + sondes ---------- */
const catalog = (load('app_catalog.json') || { apps: [] }).apps;
const cloud = load('cloud_inventory.json') || {};
const canon = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// domaine surveillé -> app {name, category}
const watch = new Map();
for (const a of catalog) if (a.domain) watch.set(a.domain.toLowerCase(), { name: a.name, category: a.category || null });
for (const [n, d] of Object.entries(cloud.vendorDomains || {})) if (n !== '_doc' && d && !watch.has(d.toLowerCase())) watch.set(d.toLowerCase(), { name: n, category: null });
// sondes d'existence (répond aux status:probe de data/sources.json)
const PROBES = { 'railway.app': 'railway', 'railway.com': 'railway', 'vercel.com': 'vercel', 'netlify.com': 'netlify', 'app.netlify.com': 'netlify' };
for (const d of Object.keys(PROBES)) if (!watch.has(d)) watch.set(d, { name: PROBES[d], category: 'probe' });

// comptes/services déjà recensés (pour marquer nouveau vs recensé)
const known = new Set();
for (const a of (cloud.accounts || [])) {
  known.add(canon(a.provider).split(/[ ·(]/)[0]);
  for (const k of (a.aka || [])) known.add(canon(k));
}
for (const s of ((cloud.connectors && cloud.connectors.list) || [])) known.add(canon(s.vendor));

const matchApp = host => {
  for (const [d, app] of watch) if (host === d || host.endsWith('.' + d)) return { domain: d, ...app };
  return null;
};

const byApp = new Map();   // app name -> {domain, category, visits, last, browsers, hosts}
for (const [host, e] of agg) {
  const m = matchApp(host);
  if (!m) continue;                                 // navigation hors périmètre SaaS → ignorée
  const k = m.name;
  const cur = byApp.get(k) || { app: m.name, domain: m.domain, category: m.category, visits: 0, last: 0, browsers: new Set(), hosts: new Set() };
  cur.visits += e.visits; cur.last = Math.max(cur.last, e.last);
  for (const b of e.browsers) cur.browsers.add(b);
  cur.hosts.add(host);
  byApp.set(k, cur);
}

const ignore = (load('browser_ignore.json') || { apps: {} }).apps;
const candidates = [...byApp.values()]
  .map(c => ({
    app: c.app, domain: c.domain, category: c.category,
    visits: c.visits, last: new Date(c.last).toISOString().slice(0, 10),
    browsers: [...c.browsers], hosts: [...c.hosts].slice(0, 6),
    status: ignore[c.app] != null ? 'ignoré' : known.has(canon(c.app).split(/[ ·(]/)[0]) ? 'recensé' : 'nouveau',
    ...(ignore[c.app] != null ? { why: ignore[c.app] } : {})
  }))
  .sort((a, b) => (a.status === b.status ? b.visits - a.visits : a.status === 'nouveau' ? -1 : 1));

/* ---------- verdicts de sonde (Railway & co) → data/sources.json ---------- */
const probeSeen = id => candidates.find(c => canon(c.app) === id);
for (const id of ['railway', 'vercel']) {
  const hit = probeSeen(id);
  const src = (load('sources.json') || { sources: [] }).sources.find(s => s.id === id);
  if (!src || src.status === 'ok' || src.status === 'manual') continue;   // déjà tranché par clouds-probe
  touchSource(__dir, id, hit
    ? { note: `Historique navigateur : ${hit.visits} visite(s) de ${hit.domain} (dernière ${hit.last}) — compte probable, à confirmer.` }
    : { status: 'absent', note: `Historique navigateur : zéro visite en ${WINDOW_DAYS} j — très probablement pas de compte.` });
}

const out = {
  _doc: `Candidats de connexion découverts dans l'historique navigateur (${WINDOW_DAYS} j, domaines agrégés UNIQUEMENT — aucune URL/titre/recherche stockés ; navigation hors catalogue SaaS ignorée). LOCAL et gitignoré : un candidat n'entre dans la carte qu'une fois validé (karto_add_account / karto_ingest). Régénérer : node browser-collect.mjs.`,
  generated: new Date().toISOString(),
  window_days: WINDOW_DAYS,
  browsers: scanned,
  candidates,
};

if (PRINT) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
writeFileSync(join(__dir, 'data', 'browser_candidates.local.json'), JSON.stringify(out, null, 2) + '\n');
touchSource(__dir, 'browser-history');
const nv = candidates.filter(c => c.status === 'nouveau');
console.log(`✓ data/browser_candidates.local.json — ${scanned.join('+') || 'aucun navigateur'} · ${candidates.length} app(s) SaaS fréquentée(s), dont ${nv.length} NON recensée(s)${nv.length ? ' : ' + nv.slice(0, 8).map(c => c.app).join(', ') : ''}`);
