#!/usr/bin/env node
// release.mjs — bump de version karto (semver) + entrée CHANGELOG. SEUL point d'édition
// de version.json (ne l'édite jamais à la main). N'écrit RIEN d'autre : le build et la
// publication restent des gestes séparés et explicites.
//
//   node release.mjs patch -m "Correctif du collecteur Make"
//   node release.mjs minor -m "Nouvel écran Agents"
//   node release.mjs major -m "Nouveau format de coffre (migration)"
//   node release.mjs --show                # affiche la version courante, ne bump rien
//
// Règle de bump (cf. CHANGELOG) — liée au RISQUE POUR LE COFFRE, pas à la taille du diff :
//   patch = re-wrap sûr · minor = feature rétro-compatible (re-wrap) · major = migration.
//
// Après le bump, la marche à suivre est rappelée : rebuild chiffré → deploy app →
// publier le manifeste (deploy-onepager.sh) → pousser le repo public. Chaque étape reste
// manuelle : c'est ce qui découple « poussé » de « publié » (rollout piloté).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const VJSON = join(__dir, 'version.json');
const CLOG = join(__dir, 'CHANGELOG.md');
const args = process.argv.slice(2);
const die = m => { process.stderr.write('✗ ' + m + '\n'); process.exit(1); };

const cur = JSON.parse(readFileSync(VJSON, 'utf8'));
if (args.includes('--show')) { process.stdout.write('karto ' + cur.version + ' (' + (cur.type || '?') + ', ' + (cur.date || '?') + ')\n'); process.exit(0); }

const level = args[0];
if (!['patch', 'minor', 'major'].includes(level)) die('usage : node release.mjs patch|minor|major -m "notes"   (ou --show)');
const mi = args.indexOf('-m');
const notes = mi >= 0 ? args.slice(mi + 1).join(' ').trim() : '';
if (!notes) die('note obligatoire : -m "ce que cette version apporte" (sert au CHANGELOG et au bandeau de notif)');

const [maj, min, pat] = String(cur.version).split('.').map(n => parseInt(n, 10) || 0);
const next = level === 'major' ? `${maj + 1}.0.0` : level === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
const date = new Date().toISOString().slice(0, 10);

// min_from : plus ancienne version depuis laquelle une MAJ directe reste sûre. Un major
// relève la barre à lui-même (en-deçà = migration/ré-install) ; patch/minor la conservent.
const min_from = level === 'major' ? next : (cur.min_from || cur.version);

const out = { ...cur, version: next, date, type: level, min_from, notes };
writeFileSync(VJSON, JSON.stringify(out, null, 2) + '\n');

// Insère l'entrée en tête de la liste du CHANGELOG (sous le séparateur '---').
const entry = `## ${next} — ${date} (${level})\n\n- ${notes}\n`;
let log = readFileSync(CLOG, 'utf8');
const anchor = '\n---\n';
const i = log.indexOf(anchor);
if (i >= 0) log = log.slice(0, i + anchor.length) + '\n' + entry + log.slice(i + anchor.length);
else log = log.trimEnd() + '\n\n' + entry;
writeFileSync(CLOG, log);

process.stdout.write(`✓ ${cur.version} → ${next} (${level}) · ${date}\n`);
process.stdout.write(`  version.json + CHANGELOG.md mis à jour.\n\n`);
process.stdout.write(`  Étapes suivantes (chacune explicite — rollout piloté) :\n`);
process.stdout.write(`   1. Rebuild chiffré      : node karto-sync.mjs rebuild --passphrase '…'\n`);
process.stdout.write(`   2. Deploy de l'app       : ./deploy-karto.sh\n`);
process.stdout.write(`   3. PUBLIER le manifeste  : ./deploy-onepager.sh   (expose version.json → déclenche la notif chez les instances)\n`);
process.stdout.write(`   4. Pousser le code public : make-public + push du repo public (le tarball que les instances téléchargent)\n`);
if (level === 'major') process.stdout.write(`\n  ⚠ MAJEURE : prévois/écris la migration — l'update auto refuse un major en re-wrap silencieux.\n`);
