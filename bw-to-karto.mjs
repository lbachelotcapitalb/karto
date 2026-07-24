#!/usr/bin/env node
// bw-to-karto.mjs — sync INFORMATIONNELLE : lit l'inventaire des comptes du coffre
// Bitwarden (via le pont bw serve) et le classe par catégorie pour l'annuaire karto.
//
// ⚠️ Ne lit QUE noms + domaines + identifiants (login). JAMAIS les mots de passe.
// Sortie = data/account_registry.local.json (GITIGNORÉ → jamais sur GitHub ; baké
// uniquement dans le coffre chiffré index.html au prochain rebuild).
//
//   export BW_SESSION=$(bw unlock --raw)     # tu tapes ton mot de passe Bitwarden
//   node bw-to-karto.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dir = dirname(fileURLToPath(import.meta.url));

const tax = JSON.parse(readFileSync(join(__dir, 'data/account_taxonomy.json'), 'utf8'));
const ORDER = tax.ordre || Object.keys(tax.regles || {});
const FALLBACK = ORDER[ORDER.length - 1] || 'Perso · Autre';

const host = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase(); } };
function classify(domain, name) {
  const hay = (domain + ' ' + name).toLowerCase();
  for (const cat of ORDER) { for (const pat of (tax.regles[cat] || [])) { if (hay.includes(String(pat).toLowerCase().trim())) return cat; } }
  return FALLBACK;
}

if (!process.env.BW_SESSION) {
  console.error('✗ Coffre verrouillé. Dans ton Terminal :\n    export BW_SESSION=$(bw unlock --raw)\n    node bw-to-karto.mjs');
  process.exit(2);
}
let items;
try {
  items = JSON.parse(execFileSync('bw', ['list', 'items'], { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 }));
} catch (e) {
  console.error('✗ Lecture du coffre échouée. Refais : export BW_SESSION=$(bw unlock --raw)');
  process.exit(2);
}

const accounts = [];
for (const it of items) {
  if (it.type !== 1) continue;                       // logins seulement (pas les notes/secrets)
  const domain = host((it.login?.uris || [])[0]?.uri);
  const username = it.login?.username || '';
  // PRÉSENCE des secrets (jamais les VALEURS) : a-t-il un mot de passe ? + NOMS des champs masqués (type 1).
  const hasPassword = !!(it.login && it.login.password);
  const secretFields = (it.fields || []).filter(f => f && f.type === 1 && f.name).map(f => f.name);
  accounts.push({ name: it.name || domain || '(sans nom)', domain, username, category: classify(domain, it.name || ''), hasPassword, secretFields });
  // NB : aucune VALEUR de secret lue ni stockée — seulement présence + noms de champs.
}
accounts.sort((a, b) => a.category.localeCompare(b.category) || (a.domain || a.name).localeCompare(b.domain || b.name));

const byCategory = {};
for (const a of accounts) byCategory[a.category] = (byCategory[a.category] || 0) + 1;

const out = { generated: new Date().toISOString().slice(0, 10), total: accounts.length, ordre: ORDER, byCategory, accounts };
writeFileSync(join(__dir, 'data/account_registry.local.json'), JSON.stringify(out, null, 1));

console.log(`✓ Annuaire synchronisé : ${accounts.length} comptes (sans aucun mot de passe).`);
for (const cat of ORDER) if (byCategory[cat]) console.log(`   ${cat} : ${byCategory[cat]}`);
console.log(`\nÉcrit dans data/account_registry.local.json (gitignoré). Rebuild chiffré pour le publier dans karto :`);
console.log(`   node karto-sync.mjs rebuild --passphrase "…" && ./deploy-karto.sh`);
