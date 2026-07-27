#!/usr/bin/env node
// bw-to-karto.mjs — sync INFORMATIONNELLE : lit l'inventaire des comptes du coffre
// Bitwarden (via le pont bw serve) et le classe par catégorie pour l'annuaire karto.
//
// ⚠️ Ne lit QUE noms + domaines + identifiants (login) + NOMS des champs masqués.
// JAMAIS une valeur de secret. Sortie = data/account_registry.local.json (GITIGNORÉ →
// jamais sur GitHub ; baké uniquement dans le coffre chiffré index.html au prochain rebuild)
// + le champ `store` des secrets de data/disk_inventory.json (voir plus bas).
//
//   node bw-to-karto.mjs      # déverrouille tout seul (fenêtre masquée, cf. bw-unlock.mjs)
//
// Trois défauts corrigés le 25/07/2026 (item C1 de ROADMAP.md) :
//   1. il exigeait un `export BW_SESSION=…` tapé à la main dans un terminal, et échouait
//      sinon — d'où un collecteur qu'on ne lançait jamais. Il utilise `bwUnlock()` comme
//      tous les autres scripts du coffre ;
//   2. il ignorait tout item de type ≠ 1, donc les NOTES SÉCURISÉES — c'est-à-dire là où
//      vivent les jetons et clés d'API (39 sur 410 items). karto ne pouvait pas savoir
//      qu'un secret trouvé dans un .env est aussi rangé au coffre ;
//   3. il n'estampillait pas sa source dans data/sources.json, donc le répertoire affichait
//      « jamais synchronisée » alors que le collecteur avait tourné.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { bwUnlock } from './bw-unlock.mjs';
import { touchSource } from './karto-sources.mjs';

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

// Session : celle passée par l'appelant (vault-add.mjs) sinon déverrouillage autonome.
let session = process.env.BW_SESSION || '';
if (!session) {
  try { session = bwUnlock(); }
  catch (e) { console.error('✗ ' + (e?.message || e)); process.exit(2); }
}
let items;
try {
  items = JSON.parse(execFileSync('bw', ['list', 'items'], { encoding: 'utf8', env: { ...process.env, BW_SESSION: session }, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 }));
} catch (e) {
  console.error('✗ Lecture du coffre échouée (session refusée ?). Relance : node bw-to-karto.mjs');
  process.exit(2);
}

// ---------------------------------------------------------------------------------------
//  Index des NOMS de champs masqués → entrées du coffre qui les portent. TOUS les types
//  d'items (y compris les notes sécurisées), car `vault-add.mjs` dépose un secret en
//  note de type 2 avec un champ masqué NOMMÉ D'APRÈS LA VARIABLE (`fields[].name`).
//  C'est donc la convention de rangement du dépôt qui rend l'appariement factuel — pas
//  une heuristique de nommage inventée ici. Aucune VALEUR n'est lue.
// ---------------------------------------------------------------------------------------
const byField = new Map();
for (const it of items) {
  for (const f of (it.fields || [])) {
    if (!f || f.type !== 1 || !f.name) continue;
    const k = String(f.name).trim().toUpperCase();
    if (!byField.has(k)) byField.set(k, []);
    byField.get(k).push(it.name || '(sans nom)');
  }
}

const accounts = [];
for (const it of items) {
  if (it.type !== 1) continue;                       // annuaire des COMPTES : logins seulement
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

// ---------------------------------------------------------------------------------------
//  RANGEMENT DES SECRETS DISQUE — renseigne `store` sur data/disk_inventory.json.
//
//  Vocabulaire (celui déjà en place côté comptes, cf. template.html STORE_MODES) :
//    'bw'       le coffre porte une entrée dont un champ masqué a CE nom de variable,
//               ET dont le nom d'entrée désigne CE fichier (ex. « monapp — .env »).
//    'template' fichier .example / template : il n'y a aucune valeur à ranger.
//    'none'     aucune entrée du coffre ne porte ce nom de variable pour ce fichier.
//
//  ⚠️ Ce que 'none' dit exactement : « non retrouvé au coffre par son nom ». PAS
//  « n'existe nulle part » — le service peut y figurer sous une autre forme (un login
//  de compte n'est pas la clé d'API du même service). Ne pas surinterpréter en alerte.
//
//  Écriture non destructive au sens de la règle d'ingestion : on ne touche QUE `store`,
//  jamais un autre champ, et le fichier est réécrit avec le même formatage (indent 1).
//  `build.mjs` ne recopie pas ce champ dans le coffre → aucun effet sur l'affichage.
// ---------------------------------------------------------------------------------------
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function patchDiskStore() {
  const f = join(__dir, 'data/disk_inventory.json');
  if (!existsSync(f)) return null;
  const disk = JSON.parse(readFileSync(f, 'utf8'));
  const tally = {}; let changed = 0;
  for (const p of (disk.projects || [])) for (const ef of (p.envFiles || [])) {
    const path = ef.path || '';
    const parent = norm(basename(dirname(path)));
    const isTemplate = /\.example|template/i.test(path);
    for (const v of (ef.vars || [])) {
      let store;
      if (isTemplate || v.service === 'template') store = 'template';
      else {
        const cands = byField.get(String(v.name || '').trim().toUpperCase()) || [];
        const key = parent.slice(0, 6);       // « monapp » ↔ « monapp — .env » : préfixe du dossier
        store = (key && cands.some(c => norm(c).includes(key))) ? 'bw' : 'none';
      }
      tally[store] = (tally[store] || 0) + 1;
      if (v.store !== store) { v.store = store; changed++; }
    }
  }
  if (changed) writeFileSync(f, JSON.stringify(disk, null, 1));
  return { changed, tally };
}
const st = patchDiskStore();
if (st) {
  const total = Object.values(st.tally).reduce((a, b) => a + b, 0);
  console.log(`\n✓ Rangement des secrets disque : ${total} référence(s) qualifiée(s) (${st.changed} modifiée(s)).`);
  for (const k of ['bw', 'here', 'template', 'none']) if (st.tally[k]) console.log(`   ${k.padEnd(9)} ${st.tally[k]}`);
} else {
  console.log('\n· data/disk_inventory.json absent — rangement des secrets non qualifié.');
}

touchSource(__dir, 'bitwarden');   // le répertoire des sources cesse d'annoncer « jamais synchronisée »

console.log(`\nÉcrit : data/account_registry.local.json (gitignoré) + data/disk_inventory.json (store).`);
console.log(`Rebuild chiffré pour le publier dans karto :`);
console.log(`   node karto-sync.mjs rebuild --passphrase "…" && ./deploy-karto.sh`);
