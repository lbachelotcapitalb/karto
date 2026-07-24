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
import { keyIdOf, KEYFILE } from './karto-kid.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const file = join(__dir, 'index.html');

// Paramètres de chiffrement : DOIVENT rester alignés sur build.mjs (l. 474).
// Un rekey qui dérive moins cher que le build affaiblit le coffre en silence.
const ITER = 600000;
const MIN_PASS = 12;

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
if (newPass.length < MIN_PASS) {
  console.error(`✗ Trop court (min ${MIN_PASS} caractères).`);
  console.error('  Le coffre est un fichier : qui l\'obtient l\'attaque HORS LIGNE, sans limite');
  console.error('  de débit. La longueur de la passphrase est la seule barrière.');
  process.exit(1);
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const key = await deriveKey(newPass, salt, ITER, 'encrypt');
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(model))));
const u8 = u => Buffer.from(u).toString('base64');
// `kid` est ADDITIF et OBLIGATOIRE : deploy-karto.sh refuse tout coffre sans empreinte
// (ou portant une empreinte étrangère). Un rekey sans kid produisait un coffre correct
// mais INDÉPLOYABLE — le chemin « je change de passphrase » était donc mort.
const kid = await keyIdOf(newPass);
const payload = JSON.stringify({ salt: u8(salt), iv: u8(iv), ct: u8(ct), iter: ITER, kid });

const selfB64 = sm[1];
const core = Buffer.from(selfB64, 'base64').toString('utf8');
const out = core.split('__PAYLOAD__').join(payload).split('__SELF__').join(selfB64);
writeFileSync(file, out);

// La nouvelle passphrase est PROUVÉE (l'ancienne a ouvert le coffre, la nouvelle vient
// d'être saisie deux fois) : on peut ré-ancrer la clé canonique sans risque de graver
// un typo. Sans ça, build.mjs et deploy-karto.sh rejetteraient le coffre fraîchement rekeyé.
writeFileSync(KEYFILE, JSON.stringify({
  v: 1, kid, updated: new Date().toISOString().slice(0, 10),
  note: "Empreinte PBKDF2-600k de la passphrase CANONIQUE du coffre. Ne contient PAS la passphrase. Ré-ancrée par rekey.mjs après un changement volontaire de passphrase."
}, null, 2) + '\n');

console.log('✓ Passphrase changée. index.html réécrit (toutes tes données conservées).');
console.log(`  clé canonique ACTUALISÉE → .karto-key.json (kid ${kid.slice(0, 8)}…)`);
console.log('  → déploie le nouveau coffre : ./deploy-karto.sh');
