#!/usr/bin/env node
// vault-add.mjs — ajoute UNE entrée (login ou secret/token) dans un coffre-fort
// numérique SANS frontend, puis rafraîchit karto. Le cœur est agnostique du coffre :
// la logique propre à chaque coffre vit derrière un PROVIDER (unlock / createLogin /
// createSecret / sync / refreshKartoRegistry). Aujourd'hui : Bitwarden. Ajouter
// 1Password (`op`) ou KeePassXC (`keepassxc-cli`) = un adaptateur de plus dans PROVIDERS,
// pas une réécriture. Les coffres SANS CLI scriptable (NordPass, Dashlane, LastPass) ne
// peuvent pas implémenter l'écriture — ils relèveront du futur import d'inventaire (lecture).
//
// Les VALEURS secrètes (mdp maître, valeur à stocker, passphrase karto) se tapent dans une
// fenêtre macOS native masquée — jamais collées dans le chat, jamais persistées (RAM seulement).
//
// Usage :
//   node vault-add.mjs --type login  --name "OVH" --url ovh.com --username you@example.com
//   node vault-add.mjs --type login  --name "OVH" --username you@example.com --generate
//   node vault-add.mjs --type secret --name "Hostinger — API" --field HOSTINGER_API_TOKEN --folder env
//   (--provider bitwarden  par défaut · --no-karto  pour ne pas rebuild/deploy karto)

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { bwUnlock } from './bw-unlock.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const ASK = `${process.env.HOME}/.claude/skills/autocli-password/scripts/ask-secret.sh`;
const AGENT = `${process.env.HOME}/.claude/skills/autocli-password/scripts/secret-agent.mjs`;

const arg = f => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };
const has = f => process.argv.includes(f);

const PROVIDER = arg('--provider') || 'bitwarden';
const TYPE = arg('--type');                    // login | secret
const NAME = arg('--name');
const URL = arg('--url') || '';
const USER = arg('--username') || '';
const FIELD = arg('--field') || 'value';       // nom du champ masqué (type secret)
const FOLDER = arg('--folder') || 'env';
const GENERATE = has('--generate');
const NO_KARTO = has('--no-karto');

// --- saisie masquée (partagée par tous les providers) ----------------------
// cacheKey optionnel → mémorisation RAM opt-in (durée choisie dans la fenêtre, ≤ 1 h).
const ask = (prompt, title, cacheKey) =>
  execFileSync('bash', cacheKey ? [ASK, prompt, title, cacheKey] : [ASK, prompt, title],
    { encoding: 'utf8' }).trim();   // throw si annulé/vide
// Oublie un secret mémorisé (à appeler si la validation échoue : un typ-o ne doit pas rester collé).
const dropCache = (key) => { try { execFileSync('node', [AGENT, 'drop', key], { stdio: 'ignore' }); } catch {} };

// ===========================================================================
//  PROVIDERS — un adaptateur par coffre. Interface :
//    name, label
//    async unlock(ask)                         → ctx opaque        | throw
//    ensureFolder(ctx, name)                   → folderId | null
//    generate(ctx)                             → string
//    createLogin(ctx, {name,url,username,password,folderId})
//    createSecret(ctx, {name,field,value,folderId})
//    sync(ctx)
//    refreshKartoRegistry?(ctx, dir)           → bool  (optionnel : lecture inventaire)
// ===========================================================================
const PROVIDERS = {
  bitwarden: (() => {
    const enc = o => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
    const bw = (args, { session, input } = {}) => {
      const env = { ...process.env };
      if (session) env.BW_SESSION = session;
      return execFileSync('bw', args, { input, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'inherit'] });
    };
    return {
      name: 'bitwarden', label: 'Bitwarden',
      async unlock(ask) {
        // Déverrouillage robuste (raw/NFC/NFD via --passwordenv) + session mémorisée en RAM
        // et réutilisée par toutes les commandes suivantes : une saisie par session de travail.
        return { session: bwUnlock({ ask }) };
      },
      ensureFolder({ session }, name) {
        const folders = JSON.parse(bw(['list', 'folders'], { session }));
        let id = (folders.find(f => f.name === name) || {}).id;
        if (!id) {
          const t = JSON.parse(bw(['get', 'template', 'folder'], { session })); t.name = name;
          id = JSON.parse(bw(['create', 'folder', enc(t)], { session })).id;
        }
        return id;
      },
      generate({ session }) { return bw(['generate', '-ulns', '--length', '20'], { session }).trim(); },
      createLogin({ session }, { name, url, username, password, folderId }) {
        const item = { type: 1, name, folderId,
          login: { username: username || null, password, uris: url ? [{ uri: url, match: null }] : [] } };
        bw(['create', 'item', enc(item)], { session });
      },
      createSecret({ session }, { name, field, value, folderId }) {
        const item = { type: 2, name, folderId, notes: 'Secret déposé via vault-add.',
          secureNote: { type: 0 }, fields: [{ name: field, value, type: 1 }] };   // type 1 = masqué
        bw(['create', 'item', enc(item)], { session });
      },
      sync({ session }) { bw(['sync'], { session }); },
      refreshKartoRegistry({ session }, dir) {
        const r = spawnSync('node', [join(dir, 'bw-to-karto.mjs')],
          { cwd: dir, stdio: 'inherit', env: { ...process.env, BW_SESSION: session } });
        return r.status === 0;
      },
    };
  })(),

  // 1password / keepassxc : adaptateurs futurs.
  //   1password    → CLI `op`            (op item create …)
  //   keepassxc    → CLI `keepassxc-cli` (add / add-attribute)
  // Implémenter la même interface puis ajouter l'entrée ici.
};

// ===========================================================================
//  ORCHESTRATION — agnostique du coffre
// ===========================================================================
if (!TYPE || !NAME || !['login', 'secret'].includes(TYPE)) {
  console.error('Usage: node vault-add.mjs --type login|secret --name "Nom" [--url x] [--username u] [--field NOM] [--generate] [--provider bitwarden] [--no-karto]');
  process.exit(1);
}
const provider = PROVIDERS[PROVIDER];
if (!provider) {
  console.error(`✗ Coffre « ${PROVIDER} » non supporté. Disponible : ${Object.keys(PROVIDERS).join(', ')}.`);
  console.error('  (NordPass/Dashlane/LastPass : pas de CLI d\'écriture — impossible côté add.)');
  process.exit(1);
}
if (!existsSync(ASK)) { console.error(`✗ Fenêtre de saisie introuvable : ${ASK} (skill autocli-password requis)`); process.exit(1); }

let ctx;
try { ctx = await provider.unlock(ask); }
catch (e) { console.error('✗ ' + e.message); process.exit(2); }

const folderId = provider.ensureFolder(ctx, FOLDER);

let secret;
if (GENERATE) { secret = provider.generate(ctx); console.log('🔑 Mot de passe fort généré (non affiché).'); }
else if (has('--value-stdin')) {
  // Valeur injectée par un pipe (ex. token obtenu programmatiquement, trop long à
  // retaper). Lue sur fd 0, jamais affichée. throw si vide.
  secret = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (!secret) { console.error('✗ --value-stdin : valeur vide sur stdin.'); process.exit(1); }
  console.log('↳ Valeur lue depuis stdin (non affichée).');
}
else { secret = ask(`Valeur à stocker pour « ${NAME} »`, `${provider.label} · nouvelle valeur`); }

if (TYPE === 'login') provider.createLogin(ctx, { name: NAME, url: URL, username: USER, password: secret, folderId });
else provider.createSecret(ctx, { name: NAME, field: FIELD, value: secret, folderId });
secret = null;                                            // on lâche la valeur au plus vite
console.log(`+ « ${NAME} » créé dans ${provider.label} (${TYPE === 'login' ? 'login' : 'secret/' + FIELD}, dossier ${FOLDER}).`);
provider.sync(ctx);
console.log('↻ Coffre synchronisé.');

// --- karto : registre local → rebuild chiffré → deploy ---------------------
if (NO_KARTO) { console.log('— karto non touché (--no-karto).'); process.exit(0); }

console.log('\n— Rafraîchissement karto —');
if (provider.refreshKartoRegistry) {
  if (!provider.refreshKartoRegistry(ctx, DIR)) {
    console.error('✗ Registre karto non mis à jour. (Le coffre, lui, est OK.)'); process.exit(1);
  }
} else {
  console.log(`— ${provider.label} n'alimente pas encore l'inventaire karto (lecture à brancher).`);
}

const cartoPass = ask('Passphrase karto (rebuild chiffré)', 'karto · rebuild', 'karto');
// karto-sync.mjs est un script d'OPS (non distribué). Là où il manque — installation tierce —
// on retombe sur build.mjs, qui est le noyau et lit la même variable CARTO_PASS.
const rebuildCmd = existsSync(join(DIR, 'karto-sync.mjs'))
  ? [join(DIR, 'karto-sync.mjs'), 'rebuild']
  : [join(DIR, 'build.mjs'), '--with-secrets'];
const r2 = spawnSync('node', rebuildCmd,
  { cwd: DIR, stdio: 'inherit', env: { ...process.env, CARTO_PASS: cartoPass } });
if (r2.status !== 0) { dropCache('karto');   // passphrase mémorisée peut-être fausse → on l'oublie
  console.error('✗ Rebuild karto échoué (coffre OK, registre local OK).'); process.exit(1); }

const r3 = spawnSync('bash', [join(DIR, 'deploy-karto.sh')], { cwd: DIR, stdio: 'inherit' });
if (r3.status !== 0) {
  console.error('⚠ Deploy karto bloqué/échoué (réseau sortant ?). Relance à la main :\n    cd ' + DIR + ' && ./deploy-karto.sh');
  process.exit(1);
}
console.log('\n✓ Terminé : coffre + karto à jour et déployé.');
