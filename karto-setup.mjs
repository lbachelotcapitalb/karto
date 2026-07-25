#!/usr/bin/env node
// karto-setup.mjs — LA source unique de vérité de la COMPLÉTUDE d'une carte karto.
//
// Un tiers qui vient d'installer karto a une carte quasi vide. Ce module dit, en un seul endroit,
// « où en est le remplissage » — pour que les DEUX bouts s'accordent au chiffre près :
//   · le NAVIGATEUR (jauge de la popup d'onboarding — `scoreSetup` est injecté dans template.html
//     par build.mjs, cf. placeholder /*__SETUP_FN__*/), et
//   · l'IA du tiers via le CLI `node karto-query.mjs setup` et l'outil MCP `karto_setup_status`.
//
// PRINCIPE ANTI-DÉRIVE : la LOGIQUE DE SCORE (seuils, libellés, poids, prochaines actions) vit ici
// et NULLE PART AILLEURS. Chaque bout se contente de produire un objet `counts` plat
// ({owner, account, host, project, secret, dependency}) depuis SA source (SQL côté Node, modèle en
// mémoire côté navigateur) puis appelle `scoreSetup(counts)`. Deux compteurs triviaux, un seul juge.
//
// Les checks sont TOUS satisfiables (pas de jauge qui plafonne à 90 % sans dire pourquoi) : quand
// les six passent, la carte a une colonne vertébrale — identité, un compte, un hébergement, un
// projet, un emplacement de secret, une dépendance. La revue des expositions est un nudge FINAL
// (elle n'empêche pas d'atteindre 100 %, faute d'un signal fiable partagé navigateur↔Node).

// ————————————————————————————————————————————————————————————————————————————————————————————————
// SPEC — le référentiel de complétude. `key` = clé dans `counts` ; `min` = seuil (nombre) ou true
// (booléen) ; `weight` = importance relative ; `hint` = comment le remplir (montré à l'utilisateur).
export const SETUP_CHECKS = [
  { id: 'owner',      key: 'owner',      min: true, weight: 1, label: 'Ton identité',
    hint: "Renseigne ton nom dans karto.config.json (owner.name) — c'est le point d'ancrage de ta carte." },
  { id: 'account',    key: 'account',    min: 1, weight: 2, label: 'Au moins un compte',
    hint: 'Connecte ton coffre (node vault-connect.mjs detect) ou ajoute un compte en mode édition — karto recense tes comptes, jamais tes mots de passe.' },
  { id: 'host',       key: 'host',       min: 1, weight: 2, label: 'Au moins un hébergement',
    hint: 'Ajoute où vivent tes services : un serveur, un hébergeur, un cloud.' },
  { id: 'project',    key: 'project',    min: 1, weight: 2, label: 'Au moins un projet',
    hint: 'Ajoute un projet : une app, un site, un chantier — ce que tu fais tourner.' },
  { id: 'secret',     key: 'secret',     min: 1, weight: 2, label: 'Au moins un emplacement de secret',
    hint: "Indique OÙ vit une clé (dans quel coffre / .env). karto stocke l'emplacement, jamais la valeur." },
  { id: 'dependency', key: 'dependency', min: 1, weight: 1, label: 'Au moins une dépendance',
    hint: 'Relie ce qui dépend de quoi : un projet → sa base, son hébergement. C\'est ce qui donne le « si ça tombe, quoi casse ».' },
];
const TOTAL_WEIGHT = SETUP_CHECKS.reduce((s, c) => s + c.weight, 0);

const passes = (c, counts) => {
  const v = counts?.[c.key];
  return c.min === true ? !!v : Number(v || 0) >= c.min;
};

// scoreSetup(counts) → verdict PUR (aucune I/O). C'est la fonction partagée navigateur↔Node.
export function scoreSetup(counts = {}) {
  const checks = SETUP_CHECKS.map(c => ({
    id: c.id, label: c.label, hint: c.hint, weight: c.weight,
    done: passes(c, counts),
    have: c.min === true ? (counts?.[c.key] ? 1 : 0) : Number(counts?.[c.key] || 0),
    need: c.min === true ? 1 : c.min,
  }));
  const doneWeight = checks.filter(c => c.done).reduce((s, c) => s + c.weight, 0);
  const score = Math.round((doneWeight / TOTAL_WEIGHT) * 100);
  const missing = checks.filter(c => !c.done);
  const nextActions = missing.map(c => c.hint);
  // Nudge final, hors score : une fois la colonne vertébrale posée, inviter à la revue sécurité.
  if (!missing.length) nextActions.push('Passe en revue l\'onglet « Sécurité & données » : les expositions (secrets en clair, absence de sauvegarde…) remontent là.');
  return {
    score,
    complete: missing.length === 0,
    done: checks.filter(c => c.done).length,
    total: checks.length,
    checks,
    missing: missing.map(c => ({ id: c.id, label: c.label, hint: c.hint })),
    nextActions,
  };
}

// ————————————————————————————————————————————————————————————————————————————————————————————————
// ADAPTATEUR NODE — produit `counts` depuis karto.db. (Le navigateur a le sien, depuis le modèle.)
// Ne s'exécute QUE côté Node ; jamais injecté dans le navigateur (qui n'a pas de SQL).
const HOST_KINDS = ['host', 'ssh_host'];
const DEP_RELS = ['dépend de', 'utilise', 'héberge', 'tourne-sur', 'stocké-sur',
  'se connecte·api', 'se connecte·service', 'se connecte·datastore', 'se connecte·mcp'];

export function countsFromDb(db, opts = {}) {
  const n = sql => { try { return db.prepare(sql).get().c; } catch { return 0; } };
  const kindCount = k => n(`SELECT COUNT(*) c FROM entity WHERE kind='${k}'`);
  const hostCount = () => n(`SELECT COUNT(*) c FROM entity WHERE kind IN (${HOST_KINDS.map(k => `'${k}'`).join(',')}) OR (hosting IS NOT NULL AND hosting <> '')`);
  const depCount = () => n(`SELECT COUNT(*) c FROM edge WHERE rel IN (${DEP_RELS.map(r => `'${r.replace(/'/g, "''")}'`).join(',')})`);
  const secretCount = () => { try { return db.prepare('SELECT COUNT(*) c FROM secret_ref').get().c; } catch { return 0; } };
  return {
    owner: !!(opts.ownerName && String(opts.ownerName).trim()),
    account: kindCount('account'),
    host: hostCount(),
    project: kindCount('project'),
    secret: secretCount(),
    dependency: depCount(),
  };
}

// CLI direct : `node karto-setup.mjs [--json]` (repli si on ne passe pas par karto-query setup).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import('node:sqlite');
  const { existsSync, readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dir = dirname(fileURLToPath(import.meta.url));
  const DB = join(__dir, 'karto.db');
  if (!existsSync(DB)) { console.error('✗ karto.db absent — lance `node karto-db.mjs build`.'); process.exit(1); }
  let ownerName = '';
  try { ownerName = JSON.parse(readFileSync(join(__dir, 'karto.config.json'), 'utf8'))?.owner?.name || ''; } catch {}
  const db = new DatabaseSync(DB, { readOnly: true });
  const res = scoreSetup(countsFromDb(db, { ownerName }));
  if (process.argv.includes('--json')) { console.log(JSON.stringify(res, null, 2)); process.exit(0); }
  const bar = '█'.repeat(Math.round(res.score / 5)).padEnd(20, '░');
  console.log(`\n  Complétude de la carte : ${res.score}%  [${bar}]  (${res.done}/${res.total})\n`);
  for (const c of res.checks) console.log(`  ${c.done ? '✓' : '○'} ${c.label}${c.done ? '' : `  — ${c.hint}`}`);
  if (res.nextActions.length) { console.log('\n  Prochaines actions :'); res.nextActions.forEach(a => console.log('   • ' + a)); }
  console.log('');
}
