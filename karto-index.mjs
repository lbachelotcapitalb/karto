#!/usr/bin/env node
// karto-index.mjs — pipeline complet du BACKEND requêtable, en une commande.
// Rafraîchit l'inventaire machine, dérive + sonde les bridges, et (re)construit
// la base de connaissances karto.db. Ne touche PAS au coffre chiffré index.html
// (ça reste le garde-fou passphrase de build.mjs / karto-sync.mjs rebuild).
//
//   node karto-index.mjs            collect → bridge gen → bridge probe → db build
//   node karto-index.mjs --no-probe (saute le sondage de schéma, plus rapide)

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const noProbe = process.argv.includes('--no-probe');
const run = (file, args = []) => { console.log(`\n▸ node ${file} ${args.join(' ')}`); execFileSync('node', [join(__dir, file), ...args], { stdio: 'inherit' }); };

run('karto-collect.mjs');
run('karto-bridge.mjs', ['gen']);
if (!noProbe) run('karto-bridge.mjs', ['probe']);
run('karto-db.mjs', ['build']);
console.log('\n✓ Backend karto à jour. Interroge-le : node karto-query.mjs schema');
console.log('  (Pour répercuter dans le dashboard chiffré : node karto-sync.mjs rebuild --passphrase "…")');
