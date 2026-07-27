#!/usr/bin/env node
// karto-naming.mjs — conventions de NOMMAGE partagées entre le builder du graphe et les
// collecteurs. Le nom d'une entité est sa clé de rattachement (karto-db rapproche un run
// d'une automatisation par `canonical.includes(clé)`) : si deux fichiers la calculent
// chacun de leur côté, le run tombe à côté de l'entité en silence. Une seule définition.

// Interpréteurs : « /bin/bash /opt/x/gen_guard.sh » doit nommer l'entité d'après gen_guard.sh,
// pas d'après bash — sinon deux crons de même horaire lancés par bash portent le même slug et
// FUSIONNENT silencieusement en une seule entité.
const INTERP = /^(\/usr)?(\/local)?\/bin\/(bash|sh|zsh|node|python3?|env|runuser)$/;

// Le « vrai script » d'une ligne de cron (chemin complet).
export function cronScript(command) {
  const words = String(command || '').split(/\s+/);
  return words.find(w => /\.(sh|mjs|js|py)$/.test(w))
    || words.find(w => /\//.test(w) && !INTERP.test(w))
    || words.find(w => /\//.test(w))
    || String(command || '').slice(0, 40);
}

// Nom d'entité d'une ligne de cron : « script.sh (user · horaire) ».
export const cronEntityName = c => `${cronScript(c.command).split('/').pop()} (${c.user} · ${c.schedule})`;
