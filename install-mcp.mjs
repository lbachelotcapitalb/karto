#!/usr/bin/env node
// install-mcp.mjs — installe le serveur MCP karto chez n'importe quel utilisateur, en une commande.
//   node install-mcp.mjs
// Détecte le moteur SQLite (node:sqlite ou binaire sqlite3), construit karto.db si besoin,
// enregistre le serveur dans Claude Code (CLI `claude`) et/ou Claude Desktop, et imprime
// un snippet de config manuelle pour les autres clients (Cursor…). Idempotent. Zéro dépendance.

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { engineName } from './karto-sqlite.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const MCP = join(__dir, 'karto-mcp.mjs');
const DB = join(__dir, 'karto.db');
const log = (...a) => console.log(...a);

log('\nkarto · installation du serveur MCP');
const major = +process.versions.node.split('.')[0];
const eng = engineName();
log(`  Node ${process.versions.node} · moteur SQLite : ${eng}`);
if (eng === 'none') {
  console.error("✗ Aucun moteur SQLite disponible.\n  → Installe Node ≥ 22 (recommandé) OU le binaire sqlite3 (macOS l'a ; sinon `brew install sqlite` / `apt install sqlite3`), puis relance.");
  process.exit(1);
}
if (major < 22) log('  ℹ Node < 22 → repli automatique sur le binaire `sqlite3` (build + requête). OK.');

// 1) base
if (!existsSync(DB)) {
  log('  → karto.db absent : construction…');
  try { execFileSync('node', [join(__dir, 'karto-db.mjs'), 'build'], { cwd: __dir, stdio: 'inherit' }); }
  catch (e) { console.error('✗ build de karto.db échoué : ' + (e.message || e)); process.exit(1); }
} else log('  ✓ karto.db présent');

// option : --write active les outils d'édition (l'IA peut AJOUTER de la donnée, pas juste lire)
const WANT_WRITE = process.argv.includes('--write');
if (WANT_WRITE) log('  ✎ Mode ÉCRITURE activé (KARTO_MCP_WRITE=1) — l’IA pourra ajouter/éditer de la donnée.');

// 2) Claude Code (CLI `claude`)
try {
  const envArgs = WANT_WRITE ? ['-e', 'KARTO_MCP_WRITE=1'] : [];
  execFileSync('claude', ['mcp', 'add', '--scope', 'user', 'karto', ...envArgs, '--', 'node', MCP], { stdio: 'pipe' });
  log('  ✓ Claude Code : serveur « karto » enregistré (scope user)');
} catch (e) {
  const m = ((e.stderr || e.message || '') + '');
  if (/exists/i.test(m)) log('  ✓ Claude Code : déjà enregistré');
  else log('  ℹ Claude Code (CLI `claude`) non détecté — utilise la config manuelle ci-dessous.');
}

// 3) Claude Desktop (fichier de config selon l'OS)
const deskPath = platform() === 'darwin'
  ? join(homedir(), 'Library/Application Support/Claude/claude_desktop_config.json')
  : platform() === 'win32'
    ? join(process.env.APPDATA || join(homedir(), 'AppData/Roaming'), 'Claude/claude_desktop_config.json')
    : join(homedir(), '.config/Claude/claude_desktop_config.json');
try {
  if (existsSync(deskPath)) {
    const cfg = JSON.parse(readFileSync(deskPath, 'utf8'));
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers.karto = { command: 'node', args: [MCP], ...(WANT_WRITE ? { env: { KARTO_MCP_WRITE: '1' } } : {}) };
    copyFileSync(deskPath, deskPath + '.bak-karto');
    writeFileSync(deskPath, JSON.stringify(cfg, null, 2) + '\n');
    log('  ✓ Claude Desktop : config mise à jour (' + deskPath + ', backup .bak-karto)');
  } else log('  ℹ Claude Desktop non détecté (' + deskPath + ').');
} catch (e) { log('  ⚠ Claude Desktop : ' + (e.message || e)); }

// 4) snippet universel
log('\n  Config manuelle (Cursor / autre client MCP) — bloc à fusionner :');
const manual = { mcpServers: { karto: { command: 'node', args: [MCP], ...(WANT_WRITE ? { env: { KARTO_MCP_WRITE: '1' } } : {}) } } };
log('  ' + JSON.stringify(manual, null, 2).replace(/\n/g, '\n  '));
if (!WANT_WRITE) log('\n  ℹ Lecture seule par défaut. Pour laisser l’IA AJOUTER/ÉDITER de la donnée : relance avec  node install-mcp.mjs --write');
log('\n✅ Terminé. REDÉMARRE ton client Claude pour charger les 4 outils : karto_search, karto_entity, karto_impact, karto_sql.\n');
