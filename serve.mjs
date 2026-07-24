import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';
const dir = new URL('.', import.meta.url).pathname;
const root = dir.endsWith(sep) ? dir : dir + sep;
const types = { '.html': 'text/html', '.json': 'application/json', '.mjs': 'text/javascript' };
createServer((req, res) => {
  let p = req.url.split('?')[0]; if (p === '/') p = '/index.html';
  let full;
  try { full = normalize(join(dir, decodeURIComponent(p))); } catch { res.writeHead(400); res.end('bad request'); return; }
  // garde-fou path-traversal : rester sous le dossier servi
  if (!full.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const buf = readFileSync(full);
    res.writeHead(200, { 'Content-Type': types[extname(full)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(8901, '127.0.0.1', () => console.log('serving on http://localhost:8901 (127.0.0.1 only)'));
