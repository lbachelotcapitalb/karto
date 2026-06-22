#!/usr/bin/env node
// karto-init.mjs — bootstrap "de zéro à coffre ouvert", MULTIPLATEFORME (Mac/Windows/Linux).
// C'est le cœur que l'installeur public (curl|bash sur Mac, irm|iex sur Windows) appellera :
//   vérifie Node → (option) collecte → choisit la passphrase → build chiffré → ouvre karto.
//
// La passphrase est saisie EN MASQUÉ dans le terminal (raw stdin, marche Mac+Windows), jamais
// affichée, jamais persistée. AUCUNE récupération possible si oubliée (zero-knowledge) — d'où
// le rappel de sauvegarde explicite avant le build.
//
//   node karto-init.mjs            # tier léger (pas de scan machine)
//   node karto-init.mjs --full     # tier complet (lance les collecteurs avant build)
//   node karto-init.mjs --no-open  # ne pas ouvrir le navigateur à la fin

import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const DIR = dirname(fileURLToPath(import.meta.url));
const has = f => process.argv.includes(f);
const FULL = has('--full');
const NO_OPEN = has('--no-open');

// 1) garde-fous runtime ------------------------------------------------------
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) { console.error(`✗ Node ${process.versions.node} trop ancien — Node 20+ requis (https://nodejs.org).`); process.exit(1); }
if (!existsSync(join(DIR, 'build.mjs'))) { console.error('✗ build.mjs introuvable — lance ce script depuis le dossier karto.'); process.exit(1); }

// 2) saisie masquée multiplateforme (terminal attaché → raw stdin) -----------
function askHidden(prompt) {
  return new Promise((res, rej) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return rej(new Error('Pas de terminal interactif (lance karto-init dans un terminal).'));
    process.stdout.write(prompt);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = ch => {
      const code = ch.charCodeAt(0);
      if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stdout.write('\n'); res(buf); }
      else if (code === 3) { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }   // Ctrl-C
      else if (code === 127 || code === 8) buf = buf.slice(0, -1);                                        // backspace / DEL
      else if (code >= 32) buf += ch;                                                                     // imprimable seulement
    };
    stdin.on('data', onData);
  });
}

console.log('\n  +- karto - premiere configuration ----------------------');
console.log('  |  Carte chiffree de ton SI, 100% locale, sans serveur.');
console.log('  +-------------------------------------------------------\n');

// 3) tier "complet" : collecte avant build (optionnel) -----------------------
if (FULL) {
  if (existsSync(join(DIR, 'karto-index.mjs'))) {
    console.log('  Mode complet : collecte de l\'inventaire local…');
    const r = spawnSync('node', [join(DIR, 'karto-index.mjs')], { cwd: DIR, stdio: 'inherit' });
    if (r.status !== 0) console.warn('  ⚠ collecte incomplète — on continue avec les données présentes.\n');
  } else console.warn('  ⚠ --full demandé mais karto-index.mjs absent — mode léger.\n');
}

// 4) passphrase (2× confirmation) -------------------------------------------
let pass;
try {
  for (;;) {
    const a = await askHidden('  Choisis ta passphrase karto (masquée, ≥ 8) : ');
    if (a.length < 8) { console.log('  ✗ minimum 8 caractères.\n'); continue; }
    const b = await askHidden('  Confirme la passphrase : ');
    if (a !== b) { console.log('  ✗ les deux saisies diffèrent, recommence.\n'); continue; }
    pass = a; break;
  }
} catch (e) { console.error('  ✗ ' + e.message); process.exit(1); }

console.log('\n  ⚠ NOTE TA PASSPHRASE MAINTENANT (gestionnaire de mots de passe / papier).');
console.log('     Zero-knowledge : aucune récupération possible. Sans elle, ce coffre est');
console.log('     définitivement illisible (les données se reconstruisent, pas cet artefact).\n');

// 5) build chiffré -----------------------------------------------------------
console.log('  Génération du coffre chiffré…');
const rb = spawnSync('node', [join(DIR, 'build.mjs'), '--passphrase', pass], { cwd: DIR, stdio: 'inherit' });
pass = null;                                            // on lâche la passphrase au plus vite
if (rb.status !== 0) { console.error('  ✗ build échoué (voir ci-dessus).'); process.exit(1); }
if (!existsSync(join(DIR, 'index.html'))) { console.error('  ✗ index.html non produit.'); process.exit(1); }
console.log('  ✓ Coffre chiffré généré (index.html).');

// 6) ouvrir ------------------------------------------------------------------
if (NO_OPEN) { console.log('\n  Terminé. Pour ouvrir karto plus tard : node karto-serve.mjs\n'); process.exit(0); }
console.log('\n  Ouverture de karto en local…');
const srv = spawn('node', [join(DIR, 'karto-serve.mjs')], { cwd: DIR, stdio: 'inherit' });
srv.on('error', e => { console.error('  ✗ Lancement du serveur local échoué : ' + e.message); process.exit(1); });
srv.on('exit', c => process.exit(c ?? 0));
