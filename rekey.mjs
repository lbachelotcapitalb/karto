#!/usr/bin/env node
// Change la passphrase du coffre SANS rien perdre : déchiffre index.html avec
// l'ancienne, re-chiffre avec la nouvelle, réécrit index.html. Préserve toutes
// tes saisies (valeurs, IDs) déjà enregistrées dans le fichier.
//
//   node rekey.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const __dir = dirname(fileURLToPath(import.meta.url));
const file = join(__dir, 'index.html');

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl._writeToOutput = s => { for (const ch of s) process.stdout.write(ch === '\n' || ch === '\r' ? ch : '*'); };
const _q = [], _w = [];                              // file d'attente : robuste TTY + pipe
rl.on('line', l => { const w = _w.shift(); if (w) w(l); else _q.push(l); });
function ask(q) { process.stdout.write(q); return new Promise(res => { const l = _q.shift(); l !== undefined ? res(l) : _w.push(res); }); }

const html = readFileSync(file, 'utf8');
const pm = html.match(/<script id="payload"[^>]*>([\s\S]*?)<\/script>/);
const sm = html.match(/SELF_B64="([^"]*)"/);
if (!pm || !sm) { console.error('✗ index.html invalide (payload/template introuvable).'); process.exit(1); }
const p = JSON.parse(pm[1]);
if (!p.ct) { console.error('✗ index.html n\'est pas chiffré (mode --plain). Rien à re-keyer.'); process.exit(1); }

const b64 = s => Buffer.from(s, 'base64');
const enc = new TextEncoder();

async function deriveKey(pass, salt, iter, use) {
  const km = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, [use]);
}

const oldPass = await ask('Ancienne passphrase : ');
let model;
try {
  const key = await deriveKey(oldPass, b64(p.salt), p.iter, 'decrypt');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(p.iv) }, key, b64(p.ct));
  model = JSON.parse(new TextDecoder().decode(pt));
} catch { console.error('✗ Ancienne passphrase incorrecte.'); process.exit(1); }

const newPass = await ask('Nouvelle passphrase : ');
const confirm = await ask('Confirme la nouvelle    : ');
rl.close();
if (newPass !== confirm) { console.error('✗ Les deux saisies diffèrent.'); process.exit(1); }
if (newPass.length < 6) { console.error('✗ Trop court (min 6 caractères).'); process.exit(1); }

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const iter = 250000;
const key = await deriveKey(newPass, salt, iter, 'encrypt');
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(model))));
const u8 = u => Buffer.from(u).toString('base64');
const payload = JSON.stringify({ salt: u8(salt), iv: u8(iv), ct: u8(ct), iter });

const selfB64 = sm[1];
const core = Buffer.from(selfB64, 'base64').toString('utf8');
const out = core.split('__PAYLOAD__').join(payload).split('__SELF__').join(selfB64);
writeFileSync(file, out);
console.log('✓ Passphrase changée. index.html réécrit (toutes tes données conservées).');
