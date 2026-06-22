#!/usr/bin/env node
// karto-collect.mjs — scanner de machine GÉNÉRIQUE (zéro dépendance).
// Lit karto.config.json (périmètre + identité), sonde la machine, écrit
// data/machine_inventory.json. NE LIT JAMAIS de valeur de secret : uniquement
// présence de fichiers, noms, topologie. Softcode : tout dérive de la config,
// donc un autre utilisateur obtient SON inventaire sans toucher au code.
//
// Usage : node karto-collect.mjs            (écrit data/machine_inventory.json)
//         node karto-collect.mjs --print    (affiche sans écrire)

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir, hostname, platform, arch, release } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const PRINT = process.argv.includes('--print');
const HOME = homedir();
const expand = p => p.replace(/^~(?=$|\/)/, HOME);
const cfg = JSON.parse(readFileSync(join(__dir, 'karto.config.json'), 'utf8'));

// exécute une commande bornée, renvoie stdout (trim) ou null. Jamais d'exception qui sort.
function sh(cmd, { timeout = 6000 } = {}) {
  try { return execSync(cmd, { timeout, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim(); }
  catch { return null; }
}
const which = bin => sh(`command -v ${bin}`) || null;

/* ---------- runtimes ---------- */
const runtimes = [];
for (const bin of cfg.runtimeBins) {
  const path = which(bin);
  if (!path) continue;
  let version = sh(`${bin} --version`) || sh(`${bin} -v`) || '';
  version = (version.split('\n')[0] || '').slice(0, 60);
  runtimes.push({ bin, path, version });
}

/* ---------- CLIs cloud/dev (présence + état d'auth, SANS secret) ---------- */
const clis = [];
for (const c of cfg.clis) {
  const path = which(c.bin);
  if (!path) continue;
  const out = c.auth ? sh(c.auth, { timeout: 8000 }) : null;
  // on ne garde qu'un résumé court : logged-in ? + 1re ligne utile (compte visible)
  let authed = out != null && out !== '';
  let hint = '';
  if (out) {
    const line = out.split('\n').find(l => /logged in|account|user|email|@|✓|status|unlocked|locked/i.test(l)) || out.split('\n')[0];
    hint = (line || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  clis.push({ bin: c.bin, name: c.name, path, authed, hint });
}

/* ---------- projets (scan git borné) ---------- */
const ignore = new Set(cfg.scan.ignoreDirs || []);
function listDirs(root, depth, acc) {
  if (depth < 0) return;
  let entries; try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || ignore.has(e.name)) continue;
    const full = join(root, e.name);
    acc.push(full);
    if (depth > 0) listDirs(full, depth - 1, acc);
  }
}
function detectStack(dir) {
  const hints = [];
  const pkg = join(dir, 'package.json');
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(readFileSync(pkg, 'utf8'));
      const deps = { ...(j.dependencies || {}), ...(j.devDependencies || {}) };
      hints.push(`node:${j.name || '?'}`);
      for (const k of ['react', 'next', 'vite', 'vue', 'svelte', 'express', 'fastify', '@supabase/supabase-js', 'prisma', 'playwright', 'typescript']) if (deps[k]) hints.push(k);
    } catch {}
  }
  for (const [f, tag] of [['requirements.txt', 'python'], ['pyproject.toml', 'python'], ['Cargo.toml', 'rust'], ['go.mod', 'go'], ['Gemfile', 'ruby'], ['composer.json', 'php'], ['Dockerfile', 'docker'], ['netlify.toml', 'netlify'], ['vercel.json', 'vercel']])
    if (existsSync(join(dir, f))) hints.push(tag);
  return [...new Set(hints)];
}
const projects = [];
const candidates = [];
for (const root of (cfg.scan.projectRoots || [])) {
  const r = expand(root);
  if (existsSync(r)) listDirs(r, (cfg.scan.maxDepth || 1) - 1, candidates);
}
for (const dir of candidates) {
  if (!existsSync(join(dir, '.git'))) continue;
  const remotes = (sh(`git -C "${dir}" remote -v`) || '').split('\n').filter(Boolean)
    .filter(l => l.includes('(fetch)'))
    .map(l => l.replace(/\s*\(fetch\)$/, '').replace(/x-access-token:[^@]+@/, '***@').replace(/\/\/[^/@\s]+:[^/@\s]+@/, '//***@').replace(/[?&]?token=[^@\s]+/, ''));
  const branch = sh(`git -C "${dir}" rev-parse --abbrev-ref HEAD`) || '';
  const lastCommit = sh(`git -C "${dir}" log -1 --format=%cs`) || '';
  const dirty = (sh(`git -C "${dir}" status --porcelain`) || '').split('\n').filter(Boolean).length;
  projects.push({ path: dir, name: dir.split('/').pop(), remotes, branch, lastCommit, dirtyFiles: dirty, hasRemote: remotes.length > 0, stack: detectStack(dir) });
}

/* ---------- automatisations launchd ---------- */
const launchAgents = [];
const laDir = expand(cfg.scan.launchAgents || '~/Library/LaunchAgents');
if (existsSync(laDir)) {
  for (const f of readdirSync(laDir)) {
    if (!/\.plist(\.disabled)?$/.test(f)) continue;
    const full = join(laDir, f);
    let raw = ''; try { raw = readFileSync(full, 'utf8'); } catch {}
    const label = (raw.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/) || [])[1] || f.replace(/\.plist.*/, '');
    const prog = (raw.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/) || [])[1] || '';
    const argv = [...prog.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]).join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    const interval = (raw.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/) || [])[1];
    const calendar = /StartCalendarInterval/.test(raw);
    launchAgents.push({ file: f, label, enabled: !f.endsWith('.disabled'), schedule: interval ? `every ${interval}s` : (calendar ? 'calendar' : 'on-load'), command: argv });
  }
}

/* ---------- bases de données locales ---------- */
const localDatabases = [];
// serveurs en cours d'exécution
const ps = sh(`ps axo command`) || '';
for (const [re, engine] of [[/postgres:?\s/i, 'postgres'], [/mysqld/i, 'mysql'], [/redis-server/i, 'redis'], [/mongod/i, 'mongodb']]) {
  const lines = ps.split('\n').filter(l => re.test(l));
  if (lines.length) {
    // on extrait un indice de base/port sans dumper toute la commande
    const sample = lines.find(l => /\d+\.\d+\.\d+\.\d+|\bport\b|\/\w+\s+\w+\s/.test(l)) || lines[0];
    const safeHint = sample
      .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***@')                          // user:pass@ dans une URL
      .replace(/((?:password|passwd|pwd|token|secret|auth|key)[=:]\s*)\S+/gi, '$1***')  // password=… --token=…
      .replace(/(-p)\S+/g, '$1***')                                          // mysql -p<pwd>
      .replace(/\s+/g, ' ').trim().slice(0, 140);
    localDatabases.push({ engine, running: true, processes: lines.length, hint: safeHint });
  }
}
const brewServices = sh(`brew services list 2>/dev/null`);
if (brewServices) {
  for (const l of brewServices.split('\n').slice(1)) {
    const m = l.match(/^(\S+)\s+(\S+)/);
    if (m && /postgres|mysql|redis|mongo/i.test(m[1])) localDatabases.push({ engine: m[1], running: m[2] === 'started', via: 'brew services', status: m[2] });
  }
}
// fichiers SQLite/DuckDB sur disque (borné)
const dbExt = new Set(cfg.scan.dbFileExtensions || []);
function findDbFiles(root, depth, acc) {
  if (depth < 0 || acc.length > 200) return;
  let entries; try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || ignore.has(e.name)) continue;
    const full = join(root, e.name);
    if (e.isDirectory()) findDbFiles(full, depth - 1, acc);
    else if (dbExt.has('.' + e.name.split('.').pop())) { try { acc.push({ path: full, sizeKB: Math.round(statSync(full).size / 1024) }); } catch {} }
  }
}
const dbFiles = [];
for (const root of (cfg.scan.projectRoots || [])) { const r = expand(root); if (existsSync(r)) findDbFiles(r, (cfg.scan.dbFileMaxDepth || 2) - 1, dbFiles); }
for (const f of dbFiles) localDatabases.push({ engine: 'sqlite', file: true, path: f.path, sizeKB: f.sizeKB });

/* ---------- hôtes SSH (alias only, jamais de clé) ---------- */
const sshHosts = [];
const sshCfg = join(HOME, '.ssh', 'config');
if (existsSync(sshCfg)) {
  let cur = null;
  for (const line of readFileSync(sshCfg, 'utf8').split('\n')) {
    const m = line.match(/^\s*Host\s+(.+)$/i);
    if (m) { cur = { alias: m[1].trim() }; sshHosts.push(cur); continue; }
    if (!cur) continue;
    const h = line.match(/^\s*HostName\s+(.+)$/i); if (h) cur.hostName = h[1].trim();
    const u = line.match(/^\s*User\s+(.+)$/i); if (u) cur.user = u[1].trim();
    const p = line.match(/^\s*Port\s+(.+)$/i); if (p) cur.port = p[1].trim();
  }
}

/* ---------- navigateurs + serveurs MCP (noms only) ---------- */
const browsers = (cfg.browsers || []).filter(b => existsSync(b.app)).map(b => b.name);
const mcpServers = [];
for (const p of [join(HOME, 'Library/Application Support/Claude/claude_desktop_config.json'), join(HOME, '.claude.json')]) {
  if (!existsSync(p)) continue;
  try { const j = JSON.parse(readFileSync(p, 'utf8')); for (const k of Object.keys(j.mcpServers || {})) if (!mcpServers.includes(k)) mcpServers.push(k); } catch {}
}

/* ---------- assemblage ---------- */
const inv = {
  _meta: {
    title: 'Inventaire machine (auto-collecté) — karto-collect.mjs',
    owner: cfg.owner?.name || '',
    generated: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    policy: 'Présence/noms/topologie uniquement. Aucune valeur de secret lue. Softcode (dérive de karto.config.json).'
  },
  host: { hostname: hostname(), os: platform(), release: release(), arch: arch(), node: process.version },
  runtimes, clis, projects, launchAgents, localDatabases, sshHosts, browsers, mcpServers
};

if (PRINT) { console.log(JSON.stringify(inv, null, 2)); process.exit(0); }
writeFileSync(join(__dir, 'data/machine_inventory.json'), JSON.stringify(inv, null, 2));
console.log(`✓ data/machine_inventory.json écrit`);
console.log(`  ${runtimes.length} runtimes · ${clis.length} CLIs · ${projects.length} repos · ${launchAgents.length} launchAgents · ${localDatabases.length} bases locales · ${sshHosts.length} hôtes SSH · ${mcpServers.length} MCP`);
const noRemote = projects.filter(p => !p.hasRemote);
if (noRemote.length) console.log(`  ⚠ ${noRemote.length} repo(s) sans remote (risque backup) : ${noRemote.map(p => p.name).join(', ')}`);
