#!/usr/bin/env node
// vault-connect.mjs — connecte UN coffre-fort (Bitwarden / 1Password / KeePassXC) à karto et en
// importe l'INVENTAIRE (noms / domaines / identifiants — JAMAIS les mots de passe) vers le
// registre local que le dashboard affiche. Généralise `karto-unlock.command` (Bitwarden-only)
// derrière une abstraction `provider`, sœur de celle de `vault-add.mjs`.
//
// Multiplateforme. La passphrase/déverrouillage se tape en MASQUÉ (raw stdin si terminal ;
// sinon fenêtre native via le skill autocli-password). Aucune valeur de secret n'est lue.
//
//   node vault-connect.mjs detect                          # quels CLIs sont installés
//   node vault-connect.mjs status                          # état de la connexion courante
//   node vault-connect.mjs connect --provider bitwarden
//   node vault-connect.mjs connect --provider onepassword
//   node vault-connect.mjs connect --provider keepassxc --db chemin.kdbx [--keyfile k]
//
// Écrit : data/account_registry.local.json (inventaire, gitignoré) + data/vault_connection.json
// (état affichable). Pour publier dans le coffre karto : rebuild chiffré + deploy.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const ASK = `${process.env.HOME}/.claude/skills/autocli-password/scripts/ask-secret.sh`;
const arg = f => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };

// --- saisie masquée : terminal (tous OS) sinon fenêtre native (Claude-driven) ----------
function askHiddenTTY(prompt) {
  return new Promise(res => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = ch => {
      const code = ch.charCodeAt(0);
      if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stdout.write('\n'); res(buf); }
      else if (code === 3) { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
      else if (code === 127 || code === 8) buf = buf.slice(0, -1);
      else if (code >= 32) buf += ch;
    };
    stdin.on('data', onData);
  });
}
async function askSecret(prompt, title) {
  if (process.stdin.isTTY) return askHiddenTTY(prompt);
  if (existsSync(ASK)) return execFileSync('bash', [ASK, prompt, title], { encoding: 'utf8' }).trim();
  throw new Error('Ni terminal interactif ni fenêtre de saisie disponible.');
}

// --- classification par taxonomie (identique à bw-to-karto) ----------------------------
const tax = JSON.parse(readFileSync(join(DIR, 'data/account_taxonomy.json'), 'utf8'));
const ORDER = tax.ordre || Object.keys(tax.regles || {});
const FALLBACK = ORDER[ORDER.length - 1] || 'Perso · Autre';
const host = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase(); } };
function classify(domain, name) {
  const hay = (domain + ' ' + name).toLowerCase();
  for (const cat of ORDER) for (const pat of (tax.regles[cat] || [])) if (hay.includes(String(pat).toLowerCase().trim())) return cat;
  return FALLBACK;
}

const cliExists = bin => { try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const version = (bin) => { try { return execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim().split('\n')[0]; } catch { return null; } };

// =======================================================================================
//  PROVIDERS — interface : { name, label, cli, install, detect(), unlock(opts), inventory(ctx,opts) }
//  inventory() renvoie [{name, domain, username, hasPassword, secretFields}] — JAMAIS de valeur.
// =======================================================================================
const PROVIDERS = {
  bitwarden: {
    name: 'bitwarden', label: 'Bitwarden', cli: 'bw', install: 'https://bitwarden.com/help/cli/',
    detect() { return { installed: cliExists('bw'), version: version('bw') }; },
    async unlock() {
      const status = JSON.parse(execFileSync('bw', ['status'], { encoding: 'utf8' }).trim());
      if (status.status === 'unauthenticated') throw new Error('Bitwarden non connecté. Lance une fois : bw login');
      let session = process.env.BW_SESSION || '';
      if (status.status !== 'unlocked' || !session) {
        const master = (await askSecret('Mot de passe maître Bitwarden (déverrouillage)', 'Bitwarden · déverrouiller')).normalize('NFC');
        try { session = execFileSync('bw', ['unlock', '--passwordenv', 'BW_MASTER', '--raw'], { encoding: 'utf8', env: { ...process.env, BW_MASTER: master } }).trim(); }
        catch { throw new Error('Déverrouillage refusé (mot de passe maître invalide ?).'); }
      }
      if (!session) throw new Error('Pas de session Bitwarden.');
      return { session };
    },
    inventory({ session }) {
      const items = JSON.parse(execFileSync('bw', ['list', 'items'], { encoding: 'utf8', env: { ...process.env, BW_SESSION: session }, maxBuffer: 64 * 1024 * 1024 }));
      const out = [];
      for (const it of items) {
        if (it.type !== 1) continue;                       // logins seulement
        out.push({
          name: it.name || '', domain: host((it.login?.uris || [])[0]?.uri), username: it.login?.username || '',
          hasPassword: !!(it.login && it.login.password),
          secretFields: (it.fields || []).filter(f => f && f.type === 1 && f.name).map(f => f.name),
        });
      }
      return out;
    },
  },

  // ⚠️ Adaptateur CODÉ selon le contrat CLI `op`, NON VÉRIFIÉ (1Password non installé ici).
  onepassword: {
    name: 'onepassword', label: '1Password', cli: 'op', install: 'https://developer.1password.com/docs/cli/get-started/',
    detect() { return { installed: cliExists('op'), version: version('op') }; },
    async unlock() {
      try { execFileSync('op', ['account', 'list'], { encoding: 'utf8' }); }
      catch { const r = spawnSync('op', ['signin'], { stdio: 'inherit' }); if (r.status !== 0) throw new Error('Connexion 1Password requise : op signin'); }
      return {};
    },
    inventory() {
      // overview seulement : title + urls + additional_information(=username pour les Login). Jamais `op item get` (lirait plus).
      const items = JSON.parse(execFileSync('op', ['item', 'list', '--categories', 'Login', '--format', 'json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) || '[]');
      return items.map(it => ({
        name: it.title || '', domain: host((it.urls || []).find(u => u.primary)?.href || (it.urls || [])[0]?.href),
        username: it.additional_information || '', hasPassword: true, secretFields: [],
      }));
    },
  },

  // ⚠️ Adaptateur CODÉ selon le contrat CLI `keepassxc-cli`, NON VÉRIFIÉ (KeePassXC non installé ici).
  keepassxc: {
    name: 'keepassxc', label: 'KeePassXC', cli: 'keepassxc-cli', install: 'https://keepassxc.org/docs/',
    detect() { return { installed: cliExists('keepassxc-cli'), version: version('keepassxc-cli') }; },
    async unlock(opts) {
      const db = opts.db; if (!db || !existsSync(db)) throw new Error('Base .kdbx requise : --db chemin.kdbx');
      const pw = await askSecret(`Mot de passe de la base ${db}`, 'KeePassXC · ouvrir');
      const base = ['--quiet']; if (opts.keyfile) base.push('-k', opts.keyfile);
      try { execFileSync('keepassxc-cli', ['ls', ...base, db], { input: pw + '\n', encoding: 'utf8' }); }   // test d'ouverture
      catch { throw new Error('Ouverture de la base refusée (mot de passe / keyfile ?).'); }
      return { db, keyfile: opts.keyfile, pw, base };
    },
    inventory({ db, pw, base }) {
      const entries = execFileSync('keepassxc-cli', ['ls', '-R', '-f', ...base, db], { input: pw + '\n', encoding: 'utf8' })
        .split('\n').map(s => s.trim()).filter(e => e && !e.endsWith('/'));
      const out = [];
      for (const e of entries) {
        try {
          // UNIQUEMENT Title/URL/UserName — JAMAIS l'attribut Password.
          const [title, url, user] = execFileSync('keepassxc-cli', ['show', '-a', 'Title', '-a', 'URL', '-a', 'UserName', ...base, db, e], { input: pw + '\n', encoding: 'utf8' }).split('\n');
          out.push({ name: (title || e).trim(), domain: host((url || '').trim()), username: (user || '').trim(), hasPassword: true, secretFields: [] });
        } catch { /* entrée illisible → ignorée */ }
      }
      return out;
    },
  },
};

// --- persistance (mêmes formats que bw-to-karto pour rester consommable tel quel) -------
function writeRegistry(accounts) {
  accounts.sort((a, b) => a.category.localeCompare(b.category) || (a.domain || a.name).localeCompare(b.domain || b.name));
  const byCategory = {};
  for (const a of accounts) byCategory[a.category] = (byCategory[a.category] || 0) + 1;
  const out = { generated: new Date().toISOString().slice(0, 10), total: accounts.length, ordre: ORDER, byCategory, accounts };
  writeFileSync(join(DIR, 'data/account_registry.local.json'), JSON.stringify(out, null, 1));
  return byCategory;
}
function writeConnection(p, total, byCategory) {
  const out = { generated: new Date().toISOString().slice(0, 10), provider: p.name, label: p.label, connected: true, total, byCategory };
  writeFileSync(join(DIR, 'data/vault_connection.json'), JSON.stringify(out, null, 1));
}

// =======================================================================================
//  CLI
// =======================================================================================
const cmd = process.argv[2];

if (cmd === 'detect') {
  console.log('Coffres détectés :');
  for (const p of Object.values(PROVIDERS)) {
    const d = p.detect();
    console.log(`  ${d.installed ? '✓' : '·'} ${p.label.padEnd(11)} ${d.installed ? (d.version || 'installé') : 'absent — ' + p.install}`);
  }
  console.log('\nConnecter : node vault-connect.mjs connect --provider <bitwarden|onepassword|keepassxc>');
  process.exit(0);
}

if (cmd === 'status') {
  const f = join(DIR, 'data/vault_connection.json');
  if (!existsSync(f)) { console.log('Aucun coffre connecté. → node vault-connect.mjs detect'); process.exit(0); }
  const s = JSON.parse(readFileSync(f, 'utf8'));
  console.log(`Coffre connecté : ${s.label} — ${s.total} comptes inventoriés (maj ${s.generated}).`);
  for (const cat of (s.ordre || Object.keys(s.byCategory || {}))) if (s.byCategory?.[cat]) console.log(`   ${cat} : ${s.byCategory[cat]}`);
  process.exit(0);
}

if (cmd === 'connect' || cmd === 'to-registry') {
  const provider = PROVIDERS[arg('--provider')];
  if (!provider) { console.error(`✗ --provider requis : ${Object.keys(PROVIDERS).join(' | ')}`); process.exit(1); }
  const d = provider.detect();
  if (!d.installed) { console.error(`✗ ${provider.label} (CLI ${provider.cli}) introuvable. Installe-le : ${provider.install}`); process.exit(2); }

  let ctx;
  try { ctx = await provider.unlock({ db: arg('--db'), keyfile: arg('--keyfile') }); }
  catch (e) { console.error('✗ ' + e.message); process.exit(2); }

  console.log(`Lecture de l'inventaire ${provider.label} (noms/domaines/identifiants, jamais les mots de passe)…`);
  let accounts;
  try { accounts = provider.inventory(ctx).map(a => ({ ...a, category: classify(a.domain, a.name) })); }
  catch (e) { console.error('✗ Lecture de l\'inventaire échouée : ' + e.message); process.exit(1); }
  if (ctx.pw) ctx.pw = null;                               // KeePassXC : on lâche le mdp base

  const byCategory = writeRegistry(accounts);
  writeConnection(provider, accounts.length, byCategory);
  console.log(`✓ ${provider.label} connecté : ${accounts.length} comptes inventoriés (aucun mot de passe lu).`);
  for (const cat of ORDER) if (byCategory[cat]) console.log(`   ${cat} : ${byCategory[cat]}`);
  console.log('\nÉcrit data/account_registry.local.json + data/vault_connection.json (gitignorés).');
  console.log('Publier dans le coffre karto : rebuild chiffré + deploy.');
  process.exit(0);
}

console.error('Commande inconnue. Utilise : detect | status | connect | to-registry');
process.exit(1);
