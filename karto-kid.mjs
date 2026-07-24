// karto-kid.mjs — empreinte de clé du coffre (anti-verrouillage passphrase).
// Module PUR (aucun effet de bord) : importable par build.mjs, keycheck.mjs,
// deploy-karto.sh… sans déclencher de build.
//
// kid = dérivation DÉTERMINISTE de la passphrase avec un sel FIXE (le coffre,
// lui, utilise un sel aléatoire à chaque build → son empreinte ne serait pas
// stable). 600 000 itérations = exactement le coût du coffre : publier le kid
// n'offre aucun raccourci à un attaquant (le coffre est déjà téléchargeable).
// Irréversible : le kid ne permet pas de retrouver la passphrase.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const KEYFILE = join(dirname(fileURLToPath(import.meta.url)), '.karto-key.json');

export async function keyIdOf(pass) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('karto-kid-v1'), iterations: 600000, hash: 'SHA-256' }, km, 256);
  return Buffer.from(bits).toString('hex').slice(0, 32);
}

// Extrait le kid d'un coffre (index.html) sans passphrase. null si absent/illisible.
export function kidOfVault(html) {
  const m = html.match(/<script id="payload"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]).kid || null; } catch { return null; }
}
