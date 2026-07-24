#!/usr/bin/env node
// bw-unlock.mjs — déverrouillage Bitwarden ROBUSTE et MÉMORISÉ, factorisé pour tous les
// scripts du coffre (bw-get, vault-add, vault-connect, karto-*.command). Résout deux bugs
// qui obligeaient à retaper le mot de passe maître de nombreuses fois :
//
//   1) FIABILITÉ (le même mot de passe échouait puis finissait par passer) — le mot de passe
//      maître accentué peut arriver de macOS en forme composée (« é » = 1 octet) ou décomposée
//      (« e » + « ´ » = 2 octets) ; Bitwarden compare octet-à-octet. On teste donc raw, NFC et
//      NFD (1ʳᵉ forme qui déverrouille gagne) — couvre les deux encodages d'un accent.
//      ⚠️ TOUJOURS `--passwordenv` : `printf | bw unlock --raw` échoue en silence (pitfall 24/06).
//
//   2) RE-SAISIE (on redemandait « dans la foulée » à chaque commande) — la session obtenue
//      est mise en cache dans l'agent RAM éphémère (secret-agent.mjs, clé « bw-session »,
//      TTL 24 h, jamais sur disque) et réutilisée par TOUTES les commandes suivantes tant que
//      le coffre reste déverrouillé. Une saisie par session de travail, plus zéro.
//
// La session est validée avant réutilisation (`bw status`), donc un jeton expiré/verrouillé
// est détecté et on reprompte une fois — jamais de session morte silencieuse.
//
// Panique / oubli immédiat : node ~/.claude/skills/autocli-password/scripts/secret-agent.mjs flush
//
// API : import { bwUnlock } from './bw-unlock.mjs' ; const session = bwUnlock()
// CLI : node bw-unlock.mjs --print-session   → imprime le jeton de session sur stdout
//       node bw-unlock.mjs                    → déverrouille et met en cache (rien sur stdout)

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const HOME = process.env.HOME;
const ASK = `${HOME}/.claude/skills/autocli-password/scripts/ask-secret.sh`;
const AGENT = `${HOME}/.claude/skills/autocli-password/scripts/secret-agent.mjs`;
const SESSION_KEY = 'bw-session';
const SESSION_TTL = String(24 * 3600);         // 24 h — max doctrine RAM (une saisie/jour) ; jamais sur disque

// --- état du coffre (avec ou sans jeton de session) -------------------------
function bwStatus(session) {
  try {
    const env = { ...process.env };
    if (session) env.BW_SESSION = session; else delete env.BW_SESSION;
    return JSON.parse(execFileSync('bw', ['status'], { encoding: 'utf8', env }).trim());
  } catch { return null; }
}

// --- agent RAM (secret-agent.mjs) : get exit 3 si absent → '' ---------------
function agentGet(key) {
  try { return execFileSync('node', [AGENT, 'get', key], { encoding: 'utf8' }); }
  catch { return ''; }
}
function agentSet(key, ttl, value) {
  try { execFileSync('node', [AGENT, 'set', key, ttl], { input: value, stdio: ['pipe', 'ignore', 'ignore'] }); }
  catch { /* pas de cache → on reprompt au prochain run, sans casser */ }
}
function agentDrop(key) { try { execFileSync('node', [AGENT, 'drop', key], { stdio: 'ignore' }); } catch {} }

// --- saisie masquée par défaut : fenêtre native (skill autocli-password) ----
function defaultAsk(prompt, title) {
  if (!existsSync(ASK)) throw new Error(`Fenêtre de saisie introuvable : ${ASK} (skill autocli-password requis).`);
  return execFileSync('bash', [ASK, prompt, title], { encoding: 'utf8' }).trim();
}

// ===========================================================================
//  bwUnlock — renvoie un BW_SESSION valide, en re-demandant le moins possible.
//  Ordre : session d'env validée → session en cache RAM validée → saisie unique.
// ===========================================================================
export function bwUnlock({ ask } = {}) {
  const askFn = ask || defaultAsk;

  const st = bwStatus();
  if (!st) throw new Error('CLI `bw` indisponible (Bitwarden non installé ?).');
  if (st.status === 'unauthenticated')
    throw new Error('Bitwarden non connecté. Dans TON terminal : bw login (une fois), puis relance.');

  // 1) session déjà présente dans l'environnement → validée
  const envSession = process.env.BW_SESSION || '';
  if (envSession) {
    const s = bwStatus(envSession);
    if (s && s.status === 'unlocked') return envSession;
  }

  // 2) session mémorisée en RAM → validée (sinon on la jette)
  const cached = agentGet(SESSION_KEY);
  if (cached) {
    const s = bwStatus(cached);
    if (s && s.status === 'unlocked') return cached;
    agentDrop(SESSION_KEY);
  }

  // 3) saisie UNIQUE + déverrouillage robuste (raw/NFC/NFD via --passwordenv)
  const raw = askFn('Mot de passe maître Bitwarden (déverrouillage)', 'Bitwarden · déverrouiller');
  if (!raw) throw new Error('Saisie vide / annulée — abandon.');
  for (const master of [...new Set([raw, raw.normalize('NFC'), raw.normalize('NFD')])]) {
    try {
      const s = execFileSync('bw', ['unlock', '--passwordenv', 'BW_MASTER', '--raw'],
        { encoding: 'utf8', env: { ...process.env, BW_MASTER: master } }).trim();
      if (s) { agentSet(SESSION_KEY, SESSION_TTL, s); return s; }
    } catch { /* forme suivante */ }
  }
  throw new Error('Déverrouillage refusé (mot de passe maître invalide ? formes raw/NFC/NFD testées). Relance.');
}

// --- CLI --------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const session = bwUnlock();
    if (process.argv.includes('--print-session')) process.stdout.write(session);
    else process.stderr.write('✓ Coffre déverrouillé (session en cache RAM, réutilisée par les commandes suivantes).\n');
    process.exit(0);
  } catch (e) { process.stderr.write('✗ ' + (e?.message || e) + '\n'); process.exit(2); }
}
