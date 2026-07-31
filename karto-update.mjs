#!/usr/bin/env node
// karto-update.mjs — applique une mise à jour de karto SANS jamais toucher au coffre.
//
//   node karto-update.mjs            # applique si une version plus récente existe
//   node karto-update.mjs --check    # dit seulement s'il y a une MAJ (n'applique rien)
//   node karto-update.mjs --force    # applique même si le manifeste n'est pas plus récent
//
// PRINCIPE (cf. CHANGELOG « règle de bump ») :
//  - patch/minor  = RE-WRAP : on récupère le CODE neuf (tarball public), puis on ré-injecte
//    le payload chiffré EXISTANT tel quel dans le nouveau template.html. Le ciphertext ne
//    bouge pas d'un octet → même kid → AUCUN risque de verrouillage, AUCUNE passphrase requise.
//  - major        = migration : refusé en mode silencieux ici (schéma/format cassant). On
//    l'annonce et on sort en erreur ; la migration guidée se fait à part.
//
// Ce que la MAJ NE touche JAMAIS (liste de préservation) : le coffre index.html, la clé
// canonique .karto-key.json, la config karto.config.json, la base karto.db*, data/*.json,
// les .env* et le cache de check. Le CODE (template.html, *.mjs, *.py, docs) est remplacé.
//
// stdout = JSON de résultat (consommé par l'endpoint /update de karto-serve) ; logs sur stderr.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const FORCE = args.includes('--force');
const log = s => process.stderr.write(s + '\n');
const out = o => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(o.ok ? 0 : 1); };

// ── Fichiers/dossiers JAMAIS écrasés par une MAJ (données de l'utilisateur) ────────────
const PRESERVE = new Set([
  'index.html', '.karto-key.json', 'karto.config.json',
  'karto.db', 'karto.db-shm', 'karto.db-wal',
  '.karto-update-cache.json', '.last-deployed-md5',
]);
const PRESERVE_PREFIX = ['data/', '.env', '.git', 'node_modules/', '.backups/', 'runtime/'];
const preserved = rel => PRESERVE.has(rel) || PRESERVE_PREFIX.some(p => rel === p.replace(/\/$/, '') || rel.startsWith(p));

const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const cmpSemver = (a, b) => { const pa = String(a).split('.').map(n => parseInt(n, 10) || 0), pb = String(b).split('.').map(n => parseInt(n, 10) || 0); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return 1; if ((pa[i] || 0) < (pb[i] || 0)) return -1; } return 0; };

const CFG = readJson(join(__dir, 'karto.config.json'), {});
const UPD = CFG.updates || {};
const INSTALLED = (readJson(join(__dir, 'version.json'), {}) || {}).version || '0.0.0';

// ── 1) Résoudre le manifeste distant (upstream) ───────────────────────────────────────
async function fetchManifest() {
  const cached = readJson(join(__dir, '.karto-update-cache.json'), null);
  if (!UPD.manifestUrl || typeof fetch !== 'function') return cached && cached.manifest;
  try {
    const opts = AbortSignal.timeout ? { signal: AbortSignal.timeout(6000) } : {};
    const r = await fetch(UPD.manifestUrl + (UPD.manifestUrl.includes('?') ? '&' : '?') + 't=' + Date.now(), opts);
    if (r.ok) return await r.json();
  } catch (e) { log('manifeste distant injoignable (' + (e.message || e) + ') — repli sur le cache'); }
  return cached && cached.manifest;
}

// ── 2) Copie récursive du CODE neuf, en sautant la liste de préservation ───────────────
function copyCode(fromRoot, toRoot, sub = '') {
  const dir = join(fromRoot, sub);
  for (const name of readdirSync(dir)) {
    const rel = sub ? sub + '/' + name : name;
    if (preserved(rel)) continue;                       // ne jamais écraser les données
    const src = join(fromRoot, rel), st = statSync(src);
    if (st.isDirectory()) { mkdirSync(join(toRoot, rel), { recursive: true }); copyCode(fromRoot, toRoot, rel); }
    else { mkdirSync(dirname(join(toRoot, rel)), { recursive: true }); copyFileSync(src, join(toRoot, rel)); }
  }
}

// ── 3) RE-WRAP : nouveau template + payload chiffré EXISTANT (ciphertext intact) ───────
function rewrapVault() {
  const indexPath = join(__dir, 'index.html');
  if (!existsSync(indexPath)) { log('pas de coffre index.html à re-wrapper (installation neuve ?) — sauté'); return false; }
  const oldHtml = readFileSync(indexPath, 'utf8');
  const m = oldHtml.match(/<script id="payload"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('coffre index.html sans <script id="payload"> — re-wrap impossible, coffre laissé intact.');
  const payload = m[1];                                 // JSON chiffré, ré-injecté TEL QUEL
  const mode = /MODE="enc"/.test(oldHtml) ? 'enc' : (/MODE="plain"/.test(oldHtml) ? 'plain' : 'enc');
  const version = (readJson(join(__dir, 'version.json'), {}) || {}).version || INSTALLED;
  const tpl = readFileSync(join(__dir, 'template.html'), 'utf8');
  const core = tpl.replace(/__MODE__/g, mode).replace(/__VERSION__/g, version);
  const selfB64 = Buffer.from(core, 'utf8').toString('base64');
  const safePayload = payload.replace(/<\/script/gi, '<\\/script');
  const rebuilt = core.split('__PAYLOAD__').join(safePayload).split('__SELF__').join(selfB64);
  // Garde-fou : le kid (empreinte de clé) doit être INCHANGÉ — sinon on refuse d'écrire.
  const kidOf = h => { try { const mm = h.match(/<script id="payload"[^>]*>([\s\S]*?)<\/script>/); return mm ? (JSON.parse(mm[1]).kid || '') : ''; } catch { return ''; } };
  if (mode === 'enc' && kidOf(oldHtml) !== kidOf(rebuilt)) throw new Error('kid divergent après re-wrap — abandon (le coffre reste intact).');
  writeFileSync(indexPath, rebuilt);
  return true;
}

async function main() {
  const manifest = await fetchManifest();
  const latest = manifest && manifest.version;
  const hasNewer = latest && cmpSemver(latest, INSTALLED) > 0;

  if (CHECK_ONLY) return out({ ok: true, installed: INSTALLED, latest: latest || null, updateAvailable: !!hasNewer, type: manifest && manifest.type || null });
  if (!hasNewer && !FORCE) return out({ ok: true, installed: INSTALLED, latest: latest || INSTALLED, updated: false, message: 'déjà à jour' });

  // Major = migration cassante : pas d'application silencieuse.
  const isMajor = (manifest && manifest.type === 'major') || (latest && (parseInt(latest, 10) || 0) > (parseInt(INSTALLED, 10) || 0));
  if (isMajor && !FORCE) return out({ ok: false, installed: INSTALLED, latest, error: 'Mise à jour MAJEURE (' + latest + ') : migration requise. Sauvegarde ton coffre puis suis la procédure de migration — application automatique refusée par sécurité.' });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = join(tmpdir(), 'karto-update-' + ts);
  const distUrl = process.env.KARTO_DIST_URL || (UPD.distUrl) || 'https://github.com/YOUR-ORG/karto/archive/refs/heads/main.tar.gz';
  try {
    // Backup du coffre + clé + config AVANT toute écriture.
    const backup = join(__dir, '.backups', 'update-' + ts);
    mkdirSync(backup, { recursive: true });
    for (const f of ['index.html', '.karto-key.json', 'karto.config.json', 'version.json']) if (existsSync(join(__dir, f))) copyFileSync(join(__dir, f), join(backup, f));
    log('backup → ' + relative(__dir, backup));

    // Récupérer le CODE neuf (tarball public) — mêmes outils que install.sh (curl + tar).
    mkdirSync(tmp, { recursive: true });
    log('téléchargement du code…');
    execFileSync('curl', ['-fsSL', distUrl, '-o', join(tmp, 'karto.tar.gz')], { stdio: ['ignore', 'ignore', 'inherit'] });
    execFileSync('tar', ['-xf', join(tmp, 'karto.tar.gz'), '-C', tmp, '--strip-components=1'], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (!existsSync(join(tmp, 'template.html'))) throw new Error('tarball incomplet (template.html absent) — rien appliqué.');

    // Remplacer le code, préserver les données.
    log('installation du code neuf (données préservées)…');
    copyCode(tmp, __dir);

    // Re-wrap : nouveau renderer + payload chiffré existant.
    const rewrapped = rewrapVault();
    const newVersion = (readJson(join(__dir, 'version.json'), {}) || {}).version || latest;
    out({ ok: true, installed: INSTALLED, latest: newVersion, updated: true, rewrapped, backup: relative(__dir, backup), message: 'karto mis à jour en ' + newVersion + (rewrapped ? ' (coffre re-wrappé, données intactes)' : '') });
  } catch (e) {
    out({ ok: false, installed: INSTALLED, latest: latest || null, error: String(e.message || e) });
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

main();
