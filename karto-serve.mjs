#!/usr/bin/env node
// karto-serve.mjs — sert le dashboard karto sur 127.0.0.1 (localhost UNIQUEMENT),
// sans aucun hébergement distant. But : fournir un "secure context" pour Web Crypto
// (crypto.subtle) qui fonctionne dans TOUS les navigateurs, y compris Safari où le
// double-clic file:// est capricieux. Ce serveur ne fait QUE du statique : il ne
// déchiffre rien, ne touche ni au coffre ni à la passphrase — juste poser des octets.
//
//   node karto-serve.mjs            # port éphémère, ouvre le navigateur
//   node karto-serve.mjs --port 8123 --no-open
//
// Sécurité : bind 127.0.0.1 (jamais 0.0.0.0 → invisible du réseau local), anti-traversée
// de chemin (rien hors de ce dossier), liste blanche d'extensions.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const arg = f => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };
const PORT = Number(arg('--port')) || 0;          // 0 = port libre attribué par l'OS
const NO_OPEN = process.argv.includes('--no-open');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel === '/' || rel === '') rel = '/index.html';
    // anti-traversée : on résout DANS le dossier et on vérifie qu'on n'en sort pas
    const path = normalize(join(DIR, rel));
    if (!path.startsWith(DIR)) { res.writeHead(403).end('Forbidden'); return; }
    const ext = extname(path).toLowerCase();
    if (!MIME[ext]) { res.writeHead(404).end('Not found'); return; }
    const s = await stat(path).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-store' });
    res.end(await readFile(path));
  } catch { res.writeHead(500).end('Server error'); }
});

function openBrowser(url) {
  const p = process.platform;
  const [cmd, args] = p === 'darwin' ? ['open', [url]]
    : p === 'win32' ? ['cmd', ['/c', 'start', '', url]]   // '' = titre vide, sinon start mange l'URL
    : ['xdg-open', [url]];
  try { const c = spawn(cmd, args, { stdio: 'ignore', detached: true }); c.on('error', () => {}); c.unref?.(); return true; }
  catch { return false; }
}

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`\n  karto servi en local : ${url}`);
  console.log('  (127.0.0.1 uniquement — invisible du réseau. Rien n\'est hébergé à distance.)');
  console.log('  Ferme cette fenêtre (ou Ctrl-C) pour arrêter.\n');
  if (!NO_OPEN && !openBrowser(url)) console.log(`  Ouvre ${url} dans ton navigateur.`);
});
