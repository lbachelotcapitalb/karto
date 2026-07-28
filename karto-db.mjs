#!/usr/bin/env node
// karto-db.mjs — matérialise tous les data/*.json en une base SQLite requêtable :
// karto.db. C'est la « grosse base de données » : un graphe de connaissances
// (entity + edge) que l'IA interroge via karto-query.mjs pour sourcer/croiser.
//
// Softcode : on ingère les data/*.json tels quels (rien de spécifique au propriétaire en dur).
// Aucune VALEUR de secret n'entre dans karto.db — uniquement noms/emplacements.
//
// Usage : node karto-db.mjs build      (reconstruit karto.db depuis data/*.json)
//         node karto-db.mjs stats      (compte les entités par type)

import { openDb } from './karto-sqlite.mjs';
import { cronScript, cronEntityName } from './karto-naming.mjs';
import {
  normKind, normRel, normStatut, normCriticite, normCycle, normOwner, normDomaine,
  normStore, normCategory, normSeverity, normBridgeStatus, normSourceStatus,
  splitStatut, isExecutable, RUNNERS, CHECKS, vocabReport,
} from './karto-vocab.mjs';
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { extraireReferences, indexReferences } from './karto-refs.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dir, 'karto.db');
const cmd = process.argv[2] || 'build';

const load = f => { try { return JSON.parse(readFileSync(join(__dir, 'data', f), 'utf8')); } catch { return null; } };
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const canon = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const cfg = (() => { try { return JSON.parse(readFileSync(join(__dir, 'karto.config.json'), 'utf8')); } catch { return {}; } })();
const gh = cfg.github || {};   // identité GitHub owner (softcode) — pas en dur
// ids d'entité des comptes GitHub : ils vivent dans data/cloud_inventory.json (a.id) et sont
// nommés dans la config. Avant, le code testait le slug du compte secondaire EN DUR — celui de
// l'auteur de karto se retrouvait donc dans la carte de n'importe quel tiers.
const GH_ID = 'account:' + (gh.accountId || 'gh-perso');
const ALT_GH_ID = 'account:' + (gh.altAccountId || 'gh-alt');

if (cmd === 'stats') {
  if (!existsSync(DB_PATH)) { console.error('✗ karto.db absent — lance `node karto-db.mjs build`'); process.exit(1); }
  const db = openDb(DB_PATH, { readOnly: true });
  console.log('Entités par type :');
  for (const r of db.prepare('SELECT kind, COUNT(*) n FROM entity GROUP BY kind ORDER BY n DESC').all()) console.log(`  ${String(r.n).padStart(4)}  ${r.kind}`);
  const e = db.prepare('SELECT COUNT(*) n FROM edge').get().n;
  const s = db.prepare('SELECT COUNT(*) n FROM secret_ref').get().n;
  const x = db.prepare('SELECT COUNT(*) n FROM exposure').get().n;
  const b = db.prepare('SELECT COUNT(*) n FROM bridge').get().n;
  console.log(`Liens: ${e} · Emplacements de secrets: ${s} · Expositions: ${x} · Bridges: ${b}`);
  process.exit(0);
}

/* ---------- (re)création du schéma ---------- */
for (const sfx of ['', '-wal', '-shm', '-journal']) { try { if (existsSync(DB_PATH + sfx)) unlinkSync(DB_PATH + sfx); } catch {} }
const db = openDb(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE entity (
    id TEXT PRIMARY KEY,        -- ex: project:my-app  (le préfixe est un espace de noms, PAS le kind)
    kind TEXT NOT NULL,         -- vocabulaire fermé — voir data/karto_vocabulary.json
    name TEXT NOT NULL,
    canonical TEXT,             -- name normalisé (jointures cross-source)
    vendor TEXT, hosting TEXT, url TEXT, path TEXT,
    criticite TEXT, cycle TEXT, statut TEXT, cout REAL,
    domaine TEXT, owner TEXT,
    source TEXT,                -- fichier data/ d'origine
    doc TEXT,                   -- texte plein (recherche LIKE)
    attrs TEXT,                 -- JSON détaillé
    -- D1 : la colonne "status" a été SUPPRIMÉE. Elle empilait quatre vocabulaires
    -- (indexation d'un pont, auth d'un CLI, santé côté fournisseur, « en service »)
    -- et faisait doublon pur de "statut" sur ses 7 entités communes. L'intention vit
    -- ici (statut) ; l'état observé vit dans attrs (lastStatus / probe / auth).
    ${CHECKS.entityKind},
    ${CHECKS.entityStatut},
    ${CHECKS.entityCriticite},
    ${CHECKS.entityCycle}
  );
  CREATE INDEX idx_entity_kind ON entity(kind);
  CREATE INDEX idx_entity_canon ON entity(canonical);
  CREATE TABLE edge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- D2 — intégrité référentielle. Les deux extrémités RÉFÉRENCENT une entité : une arête
    -- vers un id inexistant est un lien que la carte affirme et qui ne mène nulle part
    -- (5 en base avant D2, toutes silencieuses — le build ne contrôlait que \`dst\`).
    src TEXT NOT NULL REFERENCES entity(id),
    dst TEXT NOT NULL REFERENCES entity(id),
    rel TEXT, source TEXT,
    ${CHECKS.edgeRel},
    -- Le même fait déclaré par deux collecteurs n'est pas deux faits. La provenance du
    -- doublon est reportée au build (qui l'a déclaré en second), elle n'est pas perdue.
    UNIQUE(src, dst, rel)
  );
  CREATE INDEX idx_edge_src ON edge(src);
  CREATE INDEX idx_edge_dst ON edge(dst);
  CREATE TABLE secret_ref (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, service TEXT, owner_entity TEXT, path TEXT,
    store TEXT, category TEXT, source TEXT,
    ${CHECKS.secretStore},
    ${CHECKS.secretCategory}
  );
  CREATE TABLE exposure (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    severity TEXT, what TEXT, location TEXT, recommendation TEXT,
    ${CHECKS.exposureSeverity}
  );
  CREATE TABLE bridge (
    id TEXT PRIMARY KEY, kind TEXT, name TEXT, vendor TEXT,
    target TEXT, reach TEXT, status TEXT, last_indexed TEXT, schema_json TEXT,
    ${CHECKS.bridgeStatus}
  );
  CREATE TABLE vendor_domain ( name TEXT PRIMARY KEY, domain TEXT );
  CREATE TABLE meta ( key TEXT PRIMARY KEY, value TEXT );
  CREATE TABLE source (
    id TEXT PRIMARY KEY,        -- répertoire des sources à sourcer (data/sources.json)
    name TEXT, method TEXT, collector TEXT, requires TEXT,
    cadence_days INTEGER, status TEXT, last_synced TEXT, howto TEXT, note TEXT,
    ${CHECKS.sourceStatus}
  );
  /* E1 — Action Types : la règle d'autorisation devient une DONNÉE requêtable, au lieu
     d'être recodée en 4 motifs différents dans 4 serveurs. Elle est APPLIQUÉE par le hook
     ~/.claude/hooks/mcp-guard.py, qui lit data/action_types.json ; cette table est là pour
     qu'on puisse l'interroger comme le reste de la carte (« qui a le droit d'écrire une
     compta ? » doit être une requête, pas une lecture de quatre dépôts). */
  CREATE TABLE action_type (
    id TEXT PRIMARY KEY,
    kind TEXT, action TEXT,
    outils TEXT,               -- JSON : motifs de noms d'outils MCP
    preconditions TEXT,        -- JSON : [{regle, verifiable, dit}]
    effet TEXT,
    agents_autorises TEXT      -- JSON : [] = boucle principale uniquement
  );
`);

const ents = new Map();   // id -> entity
const edges = [];
const byCanon = new Map(); // canonical -> id (1er gagnant, pour résoudre les liens par nom)
// D2 — byCanon garde le 1er gagnant ; la résolution différée, elle, doit voir TOUS les
// homonymes pour choisir par kind (« MonProjet-newsletter » est à la fois un skill et un
// actif applicatif). Tant que D3 n'a pas fusionné les doublons, l'homonymie est la règle.
const byCanonAll = new Map(); // canonical -> [ids]

/* ---------- D4 : règle d'ingestion NON DESTRUCTIVE (empruntée à Stape) ----------
 * « On remplit les trous, on n'écrase jamais. » Rien ne l'imposait : chaque re-déclaration
 * d'une entité faisait un `Object.assign`, donc le DERNIER collecteur passé gagnait — même
 * s'il en savait moins. Une source dégradée (API qui répond à moitié, sonde qui échoue et
 * renvoie des champs vides, collecteur lancé sur une machine incomplète) pouvait appauvrir la
 * carte SANS QUE RIEN NE LE DISE. C'est la même famille de défaut que tout le lot B : ce
 * n'est pas la panne qui coûte cher, c'est son silence.
 *
 * `fill` : une valeur vide n'écrase jamais ; une case vide se remplit ; une case déjà remplie
 * par une valeur DIFFÉRENTE est CONSERVÉE et le conflit est nommé en fin de build. Il faut
 * les deux moitiés — refuser en silence recréerait le silence qu'on vient de fermer.
 *
 * Ce qui reste volontairement AUTORISÉ à écraser (et pourquoi) : la couche EA et le verdict
 * d'un sondage. Ce ne sont pas des collecteurs concurrents, ce sont des couches d'autorité
 * déclarées — la criticité d'un actif est une décision de Owner, pas une observation de
 * machine. Elles passent par `curer()`, qui écrase MAIS journalise : le remplacement est un
 * fait rapporté, pas un effet de bord. */
const ecrasementsRefuses = [], curations = [];
const estVide = v => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
const bref = v => { const t = typeof v === 'string' ? v : JSON.stringify(v); return t.length > 60 ? t.slice(0, 57) + '…' : t; };
function fill(cible, patch, source, prefixe = '', qui = null) {
  const nom = qui || cible.id || '?';
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    // `attrs` se fusionne clé par clé. Avant D4, la re-déclaration d'une entité faisait un
    // Object.assign de premier niveau : l'objet `attrs` ENTIER était remplacé, donc tout ce
    // qu'un collecteur précédent y avait mis disparaissait sans un mot. C'est ce qui effaçait
    // `nature` des 8 nœuds fournisseur — un fait posé par la fusion de kinds de D1.
    if (k === 'attrs' && v && typeof v === 'object' && !Array.isArray(v)) { cible.attrs ||= {}; fill(cible.attrs, v, source, 'attrs.', nom); continue; }
    // le TROU se remplit, même par une valeur vide : `[]` est un « aucun » mesuré, `null` un
    // « non renseigné » déclaré. Les confondre avec l'absence perdrait de l'information.
    if (!(k in cible) || estVide(cible[k])) { cible[k] = v; continue; }
    if (estVide(v)) continue;                                   // un vide n'écrase jamais une valeur
    if (JSON.stringify(cible[k]) !== JSON.stringify(v))         // on n'écrase pas, on le dit
      ecrasementsRefuses.push(`${nom} · ${prefixe}${k} : « ${bref(cible[k])} » conservé, « ${bref(v)} » refusé (${source})`);
  }
  return cible;
}
// couche d'autorité : écrase, mais le remplacement est journalisé (jamais silencieux)
function curer(cible, patch, source) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (estVide(v)) continue;
    if (!estVide(cible[k]) && JSON.stringify(cible[k]) !== JSON.stringify(v))
      curations.push(`${cible.id} · ${k} : « ${bref(cible[k])} » → « ${bref(v)} » (${source})`);
    cible[k] = v;
  }
  return cible;
}

function E(id, kind, name, extra = {}) {
  if (ents.has(id)) { fill(ents.get(id), extra, extra.source || 'source non déclarée'); return id; }
  const c = canon(name);
  // D1 — fusion des kinds AU MOMENT DE LA CRÉATION, pour que tout ce qui filtre par kind
  // en aval (rattachement des runs, scénarios, gouvernance) voie déjà le kind définitif.
  // Les ids ne changent PAS : le préfixe d'id est un espace de noms, pas un type — c'est
  // déjà le cas de `localdb:` (database), `ea:` (ea_asset) et `bu:` (business_unit).
  // Renommer les ids aurait obligé à réécrire les deux extrémités des 343 arêtes.
  const nk = normKind(kind, extra.source);
  const e = { id, kind: nk.kind, name, canonical: c, vendor: null, hosting: null, url: null, path: null, status: null, criticite: null, cycle: null, statut: null, cout: null, domaine: null, owner: null, source: null, attrs: {}, ...extra };
  if (nk.attr) e.attrs = { ...e.attrs, [nk.attr]: nk.valeur };   // la distinction fusionnée est portée, pas perdue
  ents.set(id, e);
  if (c && !byCanon.has(c)) byCanon.set(c, id);
  if (c) { if (!byCanonAll.has(c)) byCanonAll.set(c, []); byCanonAll.get(c).push(id); }
  return id;
}
function L(src, dst, rel, source) { if (src && dst && src !== dst) edges.push({ src, dst, rel, source }); }

/* ---------- D2 — extrémité d'arête déclarée par NOM libre ----------
 * L'idiome d'origine était `ref(nom) || ('project:' + slug(nom))` : quand le nom ne résolvait
 * pas, on FABRIQUAIT un id. Deux défauts, tous deux silencieux :
 *   1. la résolution avait lieu au milieu de la passe — `ea:monapp` n'existait pas encore
 *      quand cloud_inventory le cherchait, donc « monapp » retombait sur `project:monapp`,
 *      un nœud qui n'existe dans aucune source ;
 *   2. l'id fabriqué ressemblait à un vrai id, donc rien ne le distinguait en aval.
 * REF() diffère la résolution en fin de build (toutes les entités existent) et déclare les
 * KINDS attendus. Ce qui ne résout pas est SIGNALÉ et l'arête n'est pas écrite : une arête
 * absente se voit, une arête pendante se croit. */
const ALT = '\u0001';   // séparateur d'alternatives à l'intérieur d'une REF
const REF = (name, kinds) => 'ref:' + kinds.join(',') + ':' + (Array.isArray(name) ? name.join(ALT) : name);
// Variante pour les listes `rel[]` d'ea_inventory : un nom libre y désigne tantôt un autre
// actif de la MÊME liste (« SB monapp », déclaré plus bas dans le fichier — d'où la
// résolution tardive), tantôt un fournisseur (« Make »). On tente l'annuaire des entités,
// puis le résolveur d'intégrations, qui ne devine jamais un fournisseur multi-comptes.
const REFI = name => 'refint:' + name;
const REFI_KINDS = ['ea_asset', 'account', 'host', 'database', 'project', 'workload', 'service'];

// D1 — `runner` (lanceur d'une automatisation). Il vient de la PROVENANCE quand elle est
// exacte : une ligne de crontab est un cron, un plist est un launchd, sans interprétation
// (c'est normKind qui le pose, via data/karto_vocabulary.json). Reste le cas de
// disk_inventory.json, dont le champ `type` est de la PROSE LIBRE — 33 valeurs distinctes
// pour 42 automatisations, du genre « cron VPS Hetzner … guard bash, gate 07h DST-proof ».
// Là on devine par mots-clés, et on marque `runnerInfere: true` : une supposition ne doit
// jamais se lire comme une mesure (règle du lot B).
const RUNNER_HINTS = [
  [/launchdaemon|launchagent|launchd/i, 'launchd'],
  [/\bcron\b|crontab/i, 'cron'],
  [/webhook/i, 'webhook'],
  [/hook git|post-receive|hook claude/i, 'hook'],
  [/systemd|\.service\b/i, 'systemd'],
  [/make\.com|scénario make/i, 'make'],
  [/github action|\bgha\b/i, 'gha'],
  [/manuel|à la demande|déclenché à la demande/i, 'manuel'],
];
function sniffRunner(prose) {
  for (const [re, r] of RUNNER_HINTS) if (re.test(String(prose || ''))) return r;
  return 'autre';
}
// résout une référence "par nom" vers un id d'entité existant (sinon renvoie tel quel)
const ref = name => byCanon.get(canon(name)) || null;
// Résout un nom en exigeant un KIND. `ref()` rend le premier homonyme enregistré : dès que
// deux entités partagent un nom, c'est un tirage au sort (défaut corrigé en D2/D3 sur les
// arêtes, ici sur les connexions d'agents). Rien trouvé = null, on ne dégrade pas tout seul.
const resolveParKind = (name, kind) => (byCanonAll.get(canon(name)) || []).find(i => ents.get(i)?.kind === kind) || null;

/* ============ disk_inventory ============ */
const disk = load('disk_inventory.json') || {};
const owner = disk._meta?.owner || '';
for (const p of (disk.projects || [])) {
  const id = E('project:' + slug(p.name), 'project', p.name, {
    hosting: p.hosting, url: p.deployUrl, path: p.path, statut: 'Actif', owner,
    source: 'disk_inventory.json',
    attrs: { stack: p.stack, branch: p.branch, gitRemotes: p.gitRemotes, integrations: p.integrations, notes: p.notes, ci: p.ci, scripts: p.scripts }
  });
  // déploiement / hébergeur
  if (/netlify/i.test(p.hosting || '')) L(id, 'host:netlify', 'déployé', 'disk_inventory.json');
  if (/hetzner/i.test(p.hosting || '')) L(id, 'host:hetzner', 'déployé', 'disk_inventory.json');
  // intégrations -> connecteur/compte (résolu plus tard par nom)
  for (const i of (p.integrations || [])) L(id, 'int:' + slug(i), 'utilise', 'disk_inventory.json');
  // remotes -> repo/compte
  for (const r of (p.gitRemotes || [])) { if (gh.user && r.includes('github.com/' + gh.user)) L(id, GH_ID, 'repo', 'disk_inventory.json'); if (gh.altUser && r.includes(gh.altUser)) L(id, ALT_GH_ID, 'repo', 'disk_inventory.json'); }
  // emplacements de secrets (NOMS only). `store` = rangement connu, renseigné par
  // bw-to-karto.mjs (appariement au coffre Bitwarden) — était câblé à null ici, donc
  // jeté à l'ingestion même quand la donnée existait (corrigé, cf. C1 de la roadmap).
  for (const ef of (p.envFiles || [])) for (const v of (ef.vars || [])) {
    const critical = /service_role|secret|password|mot de passe|critique/i.test((v.name || '') + ' ' + (v.service || ''));
    db.prepare('INSERT INTO secret_ref(name,service,owner_entity,path,store,category,source) VALUES(?,?,?,?,?,?,?)')
      .run(v.name, v.service, id, ef.path, normStore(v.store, 'disk_inventory.json'), critical ? 'critical' : 'secret', 'disk_inventory.json');
  }
}
const unresolvedInts = new Set(), unresolvedProjects = new Set(), unresolvedDeps = [], orphanSshAliases = [], unresolvedBridgeRefs = [], unresolvedGhaRepos = new Set();
for (const a of (disk.systemAutomation || [])) {
  const id = E('automation:' + slug(a.name), 'automation', a.name, {
    statut: a.enabled ? 'Actif' : 'En pause', source: 'disk_inventory.json', owner,
    attrs: { type: a.type, schedule: a.schedule, enabled: a.enabled, does: a.does, claudeTier: a.claudeTier, obs: a.obs, chain: a.chain, path: a.path, manifest: a.manifest,
             runner: sniffRunner(a.type), runnerInfere: true }
  });
  // lien automatisation -> projet : champ explicite a.project (plus d'inférence regex).
  // a.project peut être une phrase libre ("x (analytics) + y") : ne créer l'edge que si ça résout
  // vers une vraie entité, sinon on le signale plutôt que de fabriquer un dst pendant.
  /* D4 — `a.project` est saisi à la main : il porte parfois DEUX projets (« a + b ») et une
   * glose entre parenthèses (« cartographie-it (karto) »). Le champ ne résolvait alors pas du
   * tout, et 5 automatisations restaient sans lien pour une question d'écriture. On découpe
   * sur les séparateurs EXPLICITES et on retire la glose — c'est de la normalisation de ce
   * qui est déclaré, pas de l'inférence : chaque morceau doit ensuite correspondre au nom
   * d'une entité, sinon il reste signalé. */
  /* D4 — ce champ résolvait par `ref()` AU MILIEU DE LA PASSE, donc contre un annuaire
   * incomplet : « cartographie-it » désigne un projet que machine_inventory déclare PLUS BAS,
   * et le lien était perdu sans que rien ne dise pourquoi. C'est mot pour mot la cause des 5
   * arêtes pendantes de D2, sur un autre champ. On diffère la résolution.
   * Le libellé est saisi à la main : il porte parfois deux projets (« a + b ») et une glose
   * (« cartographie-it (karto) »). On propose donc des ALTERNATIVES — libellé complet, puis
   * sans glose — et le résolveur prend la première qui existe. Normaliser ce qui est déclaré
   * n'est pas inférer : chaque candidat doit correspondre au nom d'une entité réelle. */
  for (const brut of (a.project ? String(a.project).split(/\s*\+\s*/) : [])) {
    const complet = brut.trim();
    const degrade = complet.replace(/\s*\([^)]*\)/g, '').replace(/\s*—.*$/, '').trim();
    if (!complet) continue;
    L(id, REF([complet, degrade].filter((v, i, t) => v && t.indexOf(v) === i), ['project', 'ea_asset', 'workload', 'automation']), 'planifie', 'disk_inventory.json');
  }
}
for (const x of (disk.exposures || [])) db.prepare('INSERT INTO exposure(severity,what,location,recommendation) VALUES(?,?,?,?)').run(normSeverity(x.severity, 'disk_inventory.json'), x.what, x.where, x.recommendation);

/* ============ cloud_inventory ============ */
const cloud = load('cloud_inventory.json') || {};
for (const [name, domain] of Object.entries(cloud.vendorDomains || {})) { if (name === '_doc') continue; db.prepare('INSERT OR IGNORE INTO vendor_domain(name,domain) VALUES(?,?)').run(name, domain); }
for (const a of (cloud.accounts || [])) {
  // D3 — deux comptes Google sans `identity` s'appelaient tous les deux « Google » : même
  // canonical pour deux objets DIFFÉRENTS (Drive perso vs recrutement MonProjet). Ce n'est pas
  // un doublon à fusionner, c'est un nom qui ne distingue pas — et `canonical` sert de clé de
  // jointure, donc résoudre « Google » revenait à tirer au sort le premier arrivé. La donnée
  // portait déjà de quoi les distinguer : l'e-mail.
  const id = E('account:' + slug(a.id), 'account', a.provider + (a.identity ? ' · ' + a.identity : (a.email ? ' · ' + a.email : '')), {
    vendor: a.provider, url: a.url, status: 'Actif', source: 'cloud_inventory.json', owner,
    attrs: { accountId: a.id, identity: a.identity, scopes: a.scopes, note: a.note, email: a.email, ids: a.ids, nature: a.nature, branchement: a.branchement, bu: a.bu, aka: a.aka }
  });
  // alias canonique provider->compte : 1er gagnant (compte GitHub principal avant secondaire, etc.)
  // D4 — il n'était posé que dans `byCanon`, donc INVISIBLE de la résolution tardive REF()
  // qui, elle, lit `byCanonAll` pour pouvoir choisir par kind. « Make » ne résolvait donc pas
  // par REF, et c'est ce qui poussait le vieil idiome `ref('Make') || 'account:make'` — celui
  // qui fabrique un id (D2). On enregistre l'alias des deux côtés.
  if (!byCanon.has(canon(a.provider))) byCanon.set(canon(a.provider), id);
  { const c = canon(a.provider); if (c) { if (!byCanonAll.has(c)) byCanonAll.set(c, []); if (!byCanonAll.get(c).includes(id)) byCanonAll.get(c).push(id); } }
  for (const v of (a.ids || [])) {
    if (v.cat === 'secret') db.prepare('INSERT INTO secret_ref(name,service,owner_entity,path,store,category,source) VALUES(?,?,?,?,?,?,?)').run(v.k, a.provider, id, 'coffre karto (compte)', normStore(v.store, 'cloud_inventory.json'), 'secret', 'cloud_inventory.json');
  }
}
// résolution d'un compte par sa clé/identité (pour rattacher chaque base au BON compte)
const acctByKey = new Map();
for (const a of (cloud.accounts || [])) { const aid = 'account:' + slug(a.id); if (a.accountKey) acctByKey.set(canon(a.accountKey), aid); if (a.identity) acctByKey.set(canon(a.identity), aid); }
const sb = cloud.supabase || {};
for (const d of [...(sb.projects || []), ...(sb.offAccount || [])]) {
  const id = E('database:' + slug(d.ref || d.name), 'database', 'Supabase ' + d.name, {
    vendor: 'Supabase', hosting: d.region, status: d.status, url: d.ref ? `https://supabase.com/dashboard/project/${d.ref}` : null,
    source: 'cloud_inventory.json', owner,
    attrs: { ref: d.ref, pg: d.pg, host: d.host, account: d.account, app: d.app, appNote: d.appNote, note: d.note, created: d.created }
  });
  if (d.account) L(id, acctByKey.get(canon(d.account)) || ref('Supabase') || null, 'héberge', 'cloud_inventory.json');
  if (d.app) L(ref(d.app) || REF(d.app, ['project', 'ea_asset', 'workload']), id, 'utilise', 'cloud_inventory.json');
}
const cgh = cloud.github || {};
for (const r of (cgh.repos || [])) {
  const id = E('repo:' + slug(r.name), 'repo', r.name, { vendor: 'GitHub', url: 'https://github.com/' + r.name, source: 'cloud_inventory.json', owner, attrs: { visibility: r.visibility, desc: r.desc, updated: r.updated } });
  L(id, (gh.altUser && r.name.includes(gh.altUser)) ? ALT_GH_ID : GH_ID, 'appartient', 'cloud_inventory.json');
  const pn = r.name.split('/').pop(); const pid = ref(pn); if (pid && pid.startsWith('project:')) L(pid, id, 'code', 'cloud_inventory.json');
}
// D4 — un workflow GitHub Actions est du CODE qui vit dans un dépôt, et `g.repo` le nomme
// depuis toujours : 13 automatisations orphelines pour une référence non écrite. Le champ
// porte le nom COURT (« monapp ») là où l'entité dépôt porte le chemin complet
// (« lbachelotcapitalb/monapp ») : on apparie sur le dernier segment, à l'identique, et on
// SIGNALE au lieu de choisir si deux propriétaires ont un dépôt du même nom.
for (const g of (cgh.actions || [])) {
  const id = E('automation:gha-' + slug(g.repo + '-' + g.workflow), 'automation', `GHA ${g.repo} · ${g.workflow}`, { vendor: 'GitHub', statut: g.status === 'active' ? 'Actif' : 'En pause', source: 'cloud_inventory.json', attrs: { trigger: g.trigger, does: g.does, claudeTier: g.claudeTier, obs: g.obs, chain: g.chain, repo: g.repo, runner: 'gha' } });
  const cands = (cgh.repos || []).filter(r => canon(r.name.split('/').pop()) === canon(g.repo));
  if (cands.length === 1) L(id, 'repo:' + slug(cands[0].name), 'code', 'cloud_inventory.json');
  else unresolvedGhaRepos.add(`${g.repo} → ${cands.length} dépôt(s) de ce nom`);
}
const mk = cloud.make || {};
/* D4 — le compte Make se nommait par le vieil idiome `ref('Make') || 'account:make'` : si la
 * résolution échoue on FABRIQUE un id (l'idiome que D2 a banni — il tombait juste par hasard,
 * le provider étant déclaré « Make.com » et non « Make »). On le désigne par ce que la donnée
 * porte : le compte du fournisseur Make. Zéro candidat ou plusieurs → rien n'est écrit. */
const comptesMake = (cloud.accounts || []).filter(a => /^make(\.|$| )/i.test(String(a.provider || '')));
const MAKE_ID = comptesMake.length === 1 ? 'account:' + slug(comptesMake[0].id) : null;
if (comptesMake.length !== 1 && (mk.scenarios || mk.connections)) unresolvedInts.add(`compte Make (${comptesMake.length} candidat(s) — arêtes Make non écrites)`);
for (const s of (mk.scenarios || [])) { const id = E('scenario:' + slug(s.id || s.name), 'scenario', 'Make · ' + s.name, { vendor: 'Make', statut: s.active ? 'Actif' : 'En pause', source: 'cloud_inventory.json', attrs: { trigger: s.trigger, modules: s.modules, does: s.does, claudeTier: s.claudeTier, obs: s.obs, chain: s.chain } }); L(id, MAKE_ID, 'scénario', 'cloud_inventory.json'); }
// D3 — deux connexions Make vers Anthropic Claude portaient le MÊME nom pour deux comptes
// distincts (« MonProjet Recrutement » / « Social Media Generator »). Même correctif que les
// comptes Google : le nom dit ce que la donnée sait déjà, au lieu de laisser deux objets
// différents partager une clé de jointure.
// D4 — la connexion appartient au compte Make, et `usedBy` nomme les scénarios qui s'en
// servent : deux faits déjà dans la donnée, aucun n'était écrit → 5 connecteurs orphelins.
for (const c of (mk.connections || [])) {
  const id = E('connector:' + slug(c.id || c.app), 'connector', 'Make · ' + c.app + (c.account ? ' · ' + c.account : ''), { vendor: c.app, source: 'cloud_inventory.json', attrs: { type: c.type, account: c.account, usedBy: c.usedBy, expire: c.expire } });
  L(id, MAKE_ID, 'appartient', 'cloud_inventory.json');
  // `usedBy` nomme le scénario tel qu'il s'appelle CHEZ MAKE ; l'entité, elle, porte le
  // préfixe « Make · » (c'est ce que construit la boucle scenarios ci-dessus). On cherche donc
  // le nom d'entité, pas le nom brut — et un scénario supprimé (F0) reste à juste titre non résolu.
  for (const u of (Array.isArray(c.usedBy) ? c.usedBy : [c.usedBy].filter(Boolean)))
    L(REF('Make · ' + String(u), ['automation', 'project', 'workload']), id, 'utilise', 'cloud_inventory.json');
}
// connecteurs MCP / API (cloud.connectors) -> entités connector + lien vers Claude (MCP) et vers le compte fournisseur
for (const co of ((cloud.connectors && cloud.connectors.list) || [])) {
  const id = E('connector:' + slug(co.id), 'connector', co.name, { vendor: co.vendor, statut: co.status, source: 'cloud_inventory.json', attrs: { tier: co.tier, transport: co.transport, backend: co.backend, account: co.account, scope: co.scope, readonly: co.readonly, tools: co.tools, note: co.note, chain: co.chain } });
  L(ref('Claude') || 'account:anthropic', id, 'utilise', 'cloud_inventory.json');
  const v = ref(co.vendor); if (v && v !== id) L(id, v, 'lié', 'cloud_inventory.json');
}
for (const w of (mk.webhooks || [])) E('webhook:' + slug(w.id || w.name), 'webhook', w.name, { vendor: 'Make', status: w.enabled ? 'actif' : 'inactif', url: w.url, source: 'cloud_inventory.json', attrs: { type: w.type, scenario: w.scenario, queue: w.queue } });
// hôtes & workloads
E('host:netlify', 'host', 'Netlify', { vendor: 'Netlify', source: 'cloud_inventory.json' });
const het = cloud.hetzner || {};
E('host:hetzner', 'host', 'Hetzner VPS', { vendor: 'Hetzner', hosting: het.vps, source: 'cloud_inventory.json', attrs: { workloads: het.workloads } });
for (const w of (het.workloads || [])) { const id = E('workload:' + slug(w.name), 'workload', w.name, { vendor: 'Hetzner', path: w.path, source: 'cloud_inventory.json', attrs: { trigger: w.trigger, does: w.does, secrets: w.secrets } }); L(id, 'host:hetzner', 'tourne-sur', 'cloud_inventory.json'); }
// noms de domaine (DNS / hébergement / email dérivés du DNS réel)
for (const d of ((cloud.domains && cloud.domains.list) || [])) {
  const id = E('domain:' + slug(d.name), 'domain', d.name, {
    vendor: (d.registrar && d.registrar !== 'a confirmer') ? d.registrar : (d.dns || null),
    hosting: d.host, url: 'https://' + d.name, status: d.statut, criticite: d.criticite,
    source: 'cloud_inventory.json', owner,
    attrs: { registrar: d.registrar, dns: d.dns, host: d.host, email: d.email, usedBy: d.usedBy, subdomains: d.subdomains, project: d.project, note: d.note }
  });
  if (d.dns) L(id, ref(d.dns) || ('vendor:' + slug(d.dns)), 'dns', 'cloud_inventory.json');
  if (d.host) L(id, ref(d.host) || ('vendor:' + slug(d.host)), 'héberge', 'cloud_inventory.json');
  if (d.email) L(id, ref(d.email) || ('vendor:' + slug(d.email)), 'email', 'cloud_inventory.json');
  if (d.project) L(ref(d.project) || REF(d.project, ['project', 'ea_asset', 'workload']), id, 'domaine', 'cloud_inventory.json');
}

/* ============ ea_inventory (criticité/cycle/coût curatés) ============ */
/* D3 — réconciliation par IDENTIFIANT d'abord, par NOM ensuite (ordre emprunté à Stape).
 * « SB monapp » et « Supabase monapp » sont la MÊME base ; « monapp » et « monapp » la
 * même application. Leurs noms diffèrent d'un caractère, donc la jointure par nom échouait et
 * la couche EA (criticité, cycle, coût, domaine — la connaissance métier) se posait sur un
 * nœud PARALLÈLE au nœud technique. Aucun test par `canonical` ne pouvait le voir : les
 * canonical sont justement différents.
 * On joint sur ce que la donnée porte déjà de stable : la ref du projet Supabase et le chemin
 * du dépôt GitHub, tous deux dans les liens de l'actif. Joindre sur un identifiant est un
 * FAIT ; joindre sur une ressemblance de nom serait une supposition — et « SB Writer », dont
 * le projet a été supprimé le 22/06, reste donc à juste titre un nœud à part. */
function eaJumeauParIdentifiant(a) {
  for (const l of (a.links || [])) {
    const u = String(l.url || '');
    const sb = u.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
    if (sb) { const id = 'database:' + slug(sb[1]); if (ents.has(id)) return id; }
    const gh = u.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
    if (gh) {
      const chemin = gh[1].toLowerCase();
      // égalité EXACTE du chemin de dépôt : `includes` ferait matcher « polar » sur « polar-x »
      const cible = [...ents.values()].find(e => e.kind === 'project' && (e.attrs?.gitRemotes || []).some(r => {
        const m = String(r).toLowerCase().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\s|$)/);
        return m && m[1] === chemin;
      }));
      if (cible) return cible.id;
    }
  }
  return null;
}
// Le nom de l'actif EA doit continuer à RÉSOUDRE après fusion, sinon les `rel[]` des autres
// actifs (« SB monapp ») pointeraient dans le vide et leurs arêtes disparaîtraient.
const aliasVers = (nom, id) => {
  const c = canon(nom); if (!c) return;
  if (!byCanon.has(c)) byCanon.set(c, id);
  if (!byCanonAll.has(c)) byCanonAll.set(c, []);
  if (!byCanonAll.get(c).includes(id)) byCanonAll.get(c).push(id);
};
const ea = load('ea_inventory.json') || {};
const eaFusionnes = [];
for (const a of (ea.assets || [])) {
  // enrichit l'entité de même nom si elle existe, sinon celle de même identifiant, sinon crée
  const parNom = ref(a.name);
  const existing = (parNom && ents.has(parNom)) ? parNom : eaJumeauParIdentifiant(a);
  if (existing && ents.has(existing)) {
    if (existing !== parNom) { aliasVers(a.name, existing); eaFusionnes.push(`${a.name} → ${existing}`); }
    curer(ents.get(existing), { criticite: a.criticite, cycle: a.cycle, statut: a.statut, cout: a.cout, domaine: a.domaine, vendor: ents.get(existing).vendor || a.vendor }, 'ea_inventory.json');
    ents.get(existing).attrs.ea = { type: a.type, links: a.links, rel: a.rel };
    // D2 — le repli fabriquait `ea:<slug>` (« Make » → `ea:make`, jamais créé nulle part).
    // On passe par le résolveur d'intégrations déjà en place : compte si le fournisseur est
    // mono-compte, sinon nœud service, sinon signalé. Il ne DEVINE pas les multi-comptes.
    for (const r of (a.rel || [])) L(existing, ref(r) || REFI(r), 'lié', 'ea_inventory.json');
  } else {
    const id = E('ea:' + slug(a.name), 'ea_asset', a.name, { vendor: a.vendor, hosting: a.hosting, criticite: a.criticite, cycle: a.cycle, statut: a.statut, cout: a.cout, domaine: a.domaine, owner: a.owner, source: 'ea_inventory.json', attrs: { type: a.type, links: a.links, rel: a.rel } });
    for (const r of (a.rel || [])) L(id, ref(r) || REFI(r), 'lié', 'ea_inventory.json');
  }
}

/* ============ data_assets (données stratégiques) ============ */
const da = load('data_assets.json') || {};
for (const a of (da.assets || [])) {
  const id = E('data:' + slug(a.id || a.label), 'data_asset', a.label, { source: 'data_assets.json', owner, attrs: { sensibilite: a.sensibilite, emplacements: a.emplacements, restauration: a.restauration } });
  for (const loc of (a.emplacements || [])) { const cn = da.canaux?.[loc.canal]; if (cn?.vendor) L(id, ref(cn.vendor) || ('vendor:' + slug(cn.vendor)), 'stocké-sur', 'data_assets.json'); }
}

/* ============ collaboration (ouverture & collaborateurs) ============ */
const collab = load('collaboration.json') || {};
const peopleById = new Map((collab.people || []).map(p => [p.id, p]));
for (const p of (collab.people || [])) {
  E('person:' + slug(p.id), 'person', p.name || p.github || p.id, {
    source: 'collaboration.json', url: p.github ? 'https://github.com/' + p.github : null,
    attrs: { github: p.github, handle: p.id }
  });
}
for (const r of (collab.repos || [])) {
  const repoId = 'repo:' + slug(r.repo);
  const collaborators = (r.collaborators || []).map(c => ({ ...c, name: peopleById.get(c.person)?.name || null }));
  const openAttrs = { openness: r.openness, license: r.license || null, upstream: r.upstream || null, openNote: r.note || null, inferred: r.inferred || undefined, collaborators };
  if (ents.has(repoId)) fill(ents.get(repoId).attrs, openAttrs, 'collaboration.json', 'attrs.', repoId);
  else E(repoId, 'repo', r.repo, { vendor: 'GitHub', url: 'https://github.com/' + r.repo, source: 'collaboration.json', owner, attrs: { visibility: null, ...openAttrs } });
  // miroir de l'ouverture sur le projet lié (requêtes par projet)
  const pid = ref(r.repo.split('/').pop());
  if (pid && pid.startsWith('project:') && ents.has(pid)) ents.get(pid).attrs.openness = r.openness;
  // arêtes personne -> repo
  for (const c of (r.collaborators || [])) { const persId = 'person:' + slug(c.person); if (ents.has(persId)) L(persId, repoId, 'collabore', 'collaboration.json'); }
}

/* ============ machine_inventory (auto-collecté) ============ */
const mi = load('machine_inventory.json');
if (mi) {
  const hostId = E('device:' + slug(mi.host?.hostname || 'mac'), 'device', mi.host?.hostname || 'Machine', { source: 'machine_inventory.json', owner: mi._meta?.owner, attrs: mi.host });
  // D4 — 13 `cli` sur 13 étaient orphelins (le constat parlait de « 9/9 runtimes » : le kind
  // `runtime` a fusionné dans `cli` en D1). Un binaire relevé par ce collecteur l'a été SUR
  // cette machine, à ce chemin : c'est un fait de collecte, pas une déduction. Sans l'arête,
  // la carte ne pouvait pas répondre « qu'est-ce qui est installé sur ce Mac ».
  for (const r of (mi.runtimes || [])) L(E('runtime:' + slug(r.bin), 'runtime', r.bin, { source: 'machine_inventory.json', path: r.path, attrs: { version: r.version } }), hostId, 'tourne-sur', 'machine_inventory.json');
  for (const c of (mi.clis || [])) L(E('cli:' + slug(c.bin), 'cli', c.name, { source: 'machine_inventory.json', path: c.path, status: c.authed ? 'authentifié' : 'présent', attrs: { hint: c.hint } }), hostId, 'tourne-sur', 'machine_inventory.json');
  // D3 — le collecteur ENRICHIT l'automatisation curatée de même label au lieu de créer un
  // second nœud. Avant : `automation:X` (disk_inventory — does, claudeTier, obs, chain) était
  // ORPHELIN, et `launchagent:X` (auto-collecté, trois fois plus pauvre) portait la seule
  // arête. La connaissance et le graphe vivaient sur deux nœuds différents : demander « qui
  // tourne sur ce Mac » renvoyait les nœuds qui ne savent rien.
  for (const la of (mi.launchAgents || [])) {
    const obs = { schedule: la.schedule, command: la.command, file: la.file, enabled: la.enabled };
    const jumeau = byCanon.get(canon(la.label));
    if (jumeau && ents.get(jumeau)?.kind === 'automation') {
      // On remplit les trous, on n'écrase jamais (règle Stape). `statut` porte l'INTENTION
      // décidée dans la carte ; `enabled` est un état OBSERVÉ, il va dans attrs (règle D1) —
      // c'est ce qui réconcilie `app.moncompta.montage`, « En pause » côté carte parce que Owner
      // l'a décidé, « Actif » côté launchd parce que le plist est chargé.
      fill(ents.get(jumeau).attrs, { launchd: obs }, 'machine_inventory.json', 'attrs.', jumeau);
      L(jumeau, hostId, 'tourne-sur', 'machine_inventory.json');
    } else {
      const id = E('launchagent:' + slug(la.label), 'launchagent', la.label, { source: 'machine_inventory.json', statut: la.enabled ? 'Actif' : 'En pause', attrs: obs });
      L(id, hostId, 'tourne-sur', 'machine_inventory.json');
    }
  }
  for (const d of (mi.localDatabases || [])) { const nm = d.file ? ('SQLite ' + (d.path || '').split('/').pop()) : (d.engine + (d.running ? ' (running)' : '')); const id = E('localdb:' + slug((d.path || d.engine) + (d.processes || '')), 'database', nm, { vendor: d.engine, source: 'machine_inventory.json', path: d.path, status: d.running ? 'running' : (d.status || null), attrs: d }); L(id, hostId, 'sur', 'machine_inventory.json'); }
  // D1 — les alias SSH ne sont plus des entités. Les 3 (`vps`, `vps-443`, `vps-stealth`)
  // pointaient tous <IP de ton VPS> : c'étaient 3 CHEMINS D'ACCÈS vers une seule machine,
  // comptés comme 3 hôtes. Ils deviennent un attribut de l'hôte qu'ils atteignent.
  // Le rattachement se fait par l'adresse réellement présente dans la fiche de l'hôte —
  // pas par un mapping en dur, et un alias qui ne retrouve pas son hôte est SIGNALÉ.
  for (const h of (mi.sshHosts || [])) {
    const target = [...ents.values()].find(e => e.kind === 'host' && h.hostName &&
      (String(e.hosting || '').includes(h.hostName) || JSON.stringify(e.attrs || {}).includes(h.hostName)));
    if (target) ((target.attrs.sshAliases ||= [])).push({ alias: h.alias, user: h.user, port: h.port || '22', hostName: h.hostName });
    else orphanSshAliases.push(`${h.alias} → ${h.hostName}`);
  }
  // serveurs MCP réellement branchés sur la machine (auto-collectés) : enrichit le connecteur
  // curaté de même nom (cloud_inventory > connectors) sinon crée un connecteur autoDiscovered.
  for (const m of (mi.mcpServers || [])) {
    const srv = typeof m === 'string' ? { name: m } : m;
    const k = slug(srv.name);
    const hit = [...ents.values()].find(e => e.kind === 'connector' && (e.canonical === canon(srv.name) || ('-' + slug(e.name) + '-').includes('-' + k + '-')));
    // F2 — on GARDE la clé du serveur telle qu'elle est écrite dans la config du client MCP.
    // Elle était calculée ici puis jetée : le connecteur portait ensuite un nom (« karto MCP »)
    // que rien ne rattachait au serveur « karto ». C'est le motif de D4 — un annuaire qui jette
    // la référence qu'il avait sous la main — et c'est ce qui empêchait de confronter la fiche
    // au handshake. Joindre sur cet identifiant est un fait ; joindre sur le nom, une supposition.
    if (hit) fill(hit.attrs, { mcpServer: srv.name, local: { transport: srv.transport, scope: srv.scope, origin: srv.origin } }, 'machine_inventory.json', 'attrs.', hit.id);
    else { const id = E('connector:' + k, 'connector', srv.name, { source: 'machine_inventory.json', statut: 'Actif', attrs: { mcpServer: srv.name, transport: srv.transport, scope: srv.scope, origin: srv.origin, autoDiscovered: true } }); L(ref('Claude') || 'account:anthropic', id, 'utilise', 'machine_inventory.json'); }
  }
  // enrichit les projets locaux (dirty, lastCommit, hasRemote) si match par nom
  for (const p of (mi.projects || [])) { const pid = ref(p.name); if (pid && ents.has(pid)) fill(ents.get(pid).attrs, { local: { lastCommit: p.lastCommit, dirtyFiles: p.dirtyFiles, hasRemote: p.hasRemote, branch: p.branch } }, 'machine_inventory.json', 'attrs.', pid); else E('project:' + slug(p.name), 'project', p.name, { path: p.path, source: 'machine_inventory.json', attrs: { stack: p.stack, branch: p.branch, lastCommit: p.lastCommit, hasRemote: p.hasRemote, gitRemotes: p.remotes, autoDiscovered: true } }); }
  db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('machine', JSON.stringify(mi.host));
}

/* ============ vps_inventory (auto-collecté par vps-collect.mjs, SSH lecture seule) ============ */
const vi = load('vps_inventory.json');
if (vi) {
  const hostId = 'host:hetzner';   // créé par le bloc cloud_inventory ci-dessus
  if (ents.has(hostId)) fill(ents.get(hostId).attrs, {
    vps: { hostInfo: vi.hostInfo, services: vi.services, timers: vi.timers, optDirs: vi.optDirs, homeDirs: vi.homeDirs, srvSites: vi.srvSites, caddySites: vi.caddySites, collectedAt: vi._meta?.generatedAt, rootCrontab: vi._meta?.rootCrontab }
  }, 'vps_inventory.json', 'attrs.', hostId);
  // chaque ligne de cron réelle = entité vps_cron (nom = script + horaire) → détection des
  // automatisations qui tournent SANS être recensées (croisement avec kind automation).
  for (const c of (vi.crons || [])) {
    // Nommer par le SCRIPT, pas par l'interpréteur (voir karto-naming.mjs) — convention
    // PARTAGÉE avec runs-collect.mjs, qui rattache les runs de cron par ce même nom.
    const base = cronScript(c.command);
    const name = cronEntityName(c);
    const id = E('vps_cron:' + slug(c.user + '-' + base.split('/').pop() + '-' + c.schedule), 'vps_cron', name, {
      source: 'vps_inventory.json', statut: 'Actif', owner,
      attrs: { schedule: c.schedule, command: c.command, user: c.user }
    });
    L(id, hostId, 'tourne-sur', 'vps_inventory.json');
  }
  // services systemd applicatifs : enrichit le workload curaté de même nom, sinon crée autoDiscovered
  for (const s of (vi.services || [])) {
    const hit = [...ents.values()].find(e => e.kind === 'workload' && ('-' + slug(e.name) + '-').includes('-' + slug(s) + '-'));
    if (hit) (hit.attrs.systemd ||= []).push(s);
    else { const id = E('workload:' + slug(s), 'workload', s, { vendor: 'Hetzner', source: 'vps_inventory.json', statut: 'Actif', attrs: { systemdUnit: s + '.service', autoDiscovered: true } }); L(id, hostId, 'tourne-sur', 'vps_inventory.json'); }
  }
}

/* ============ bridges (registre des bases connectées) ============ */
const br = load('bridges.json');
if (br) for (const b of (br.bridges || [])) {
  db.prepare('INSERT OR REPLACE INTO bridge(id,kind,name,vendor,target,reach,status,last_indexed,schema_json) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(b.id, b.kind, b.name, b.vendor || null, b.target || null, JSON.stringify(b.reach || {}), normBridgeStatus(b.status, 'bridges.json') || 'registered', b.lastIndexed || null, b.schema ? JSON.stringify(b.schema) : null);
  // Le verdict de sondage du pont vit dans la table `bridge` (sa place) et dans attrs.probe —
  // plus dans une colonne `status` d'entité qui empilait quatre vocabulaires différents.
  // D3 — un pont vers une base DÉJÀ dans la carte n'est pas un second objet, c'est une façon
  // d'atteindre le même. Le nœud `bridge:*` était le plus riche (cible, portée, verdict de
  // sondage, nb de tables) et le plus ORPHELIN (0 arête sur 11), pendant que la base portait
  // les liens : c'est la cause racine du « bridge 12/12 déconnectés » relevé en B3. On
  // enrichit donc la base, et le détail d'indexation reste où est sa place — la table `bridge`.
  const attrsPont = { kind: b.kind, target: b.target, reach: b.reach, probe: normBridgeStatus(b.status, 'bridges.json'), tables: (b.schema?.tables || []).length || undefined };
  const jumelle = byCanon.get(canon(b.name));
  if (jumelle && ents.get(jumelle)?.kind === 'database') { ents.get(jumelle).attrs.bridge = { id: b.id, ...attrsPont }; continue; }
  const bid = E('bridge:' + slug(b.id), 'bridge', b.name, { vendor: b.vendor, source: 'bridges.json', attrs: { ...attrsPont, accountId: b.accountId } });
  /* D4 — les 5 ponts restants étaient orphelins alors que le générateur CONNAÎT leur compte :
   * il fabrique leur id à partir de `a.id` et jetait la référence (corrigé dans
   * karto-bridge.mjs, champ `accountId`). On rattache par cet IDENTIFIANT, jamais en
   * ré-analysant l'id du pont — un id est un espace de noms, pas une donnée (règle D1). */
  if (b.accountId) {
    const aid = 'account:' + slug(b.accountId);
    if (ents.has(aid)) L(bid, aid, 'appartient', 'bridges.json');
    else unresolvedBridgeRefs.push(`${b.id} → compte « ${b.accountId} » absent de la carte`);
  }
  // l'application dont ce pont atteint la donnée (résolution TARDIVE, cf. D2)
  if (b.app) L(REF(b.app, ['project', 'ea_asset', 'workload', 'database']), bid, 'utilise', 'bridges.json');
}

/* ============ skills (compétences Claude — data/skills_inventory.json) ============ */
// Matérialise chaque skill en entité pour que le graphe sache « quel agent utilise quel skill »
// (edges créés dans le bloc agents ci-dessous, via actions[].name / chains[].desc).
const sk = load('skills_inventory.json') || {};
for (const s of (sk.skills || [])) {
  E('skill:' + slug(s.name), 'skill', s.name, {
    path: s.path, source: 'skills_inventory.json', owner, doc: [s.summary, s.trigger].filter(Boolean).join(' '),
    attrs: { summary: s.summary, trigger: s.trigger }
  });
}

/* ============ agents (architecture agentique — data/agents.json) ============ */
const ag = load('agents.json') || {};
for (const a of (ag.agents || [])) {
  const id = E('agent:' + slug(a.id), 'agent', a.name, {
    // D8 — plus de table de correspondance ici : `actif`, `dormant` et `arrêté` sont TOUS
    // déjà dans `normalise` de data/karto_vocabulary.json. Ce ternaire était une seconde
    // vérité, exactement ce que D1 avait pour but de supprimer — et il laissait passer
    // `arrêté` tel quel, qui n'était rattrapé qu'en aval, par chance.
    statut: a.status || null,
    source: 'agents.json', owner, doc: a.summary,
    attrs: {
      summary: a.summary, origin: a.source, manifest: a.manifest || null,
      // D8 — le manifeste porte sa VERSION de format et sa DATE : sans elles, impossible de
      // dire si la fiche d'un agent décrit encore ce qu'il fait. Le collecteur les jetait.
      schema: a.schema || null, updated: a.updated || null,
      host: a.host, capabilities: a.capabilities, connects_to: a.connects_to,
      actions: a.actions, chains: a.chains, guardrails: a.guardrails
    }
  });
  // agent -> projet porteur
  if (a.project) { const pid = ref(a.project); if (pid) L(id, pid, 'porté par', 'agents.json'); }
  // agent -> ce à quoi il se connecte (datastore/mcp/api/… résolus par nom quand c'est possible).
  // Le TYPE de connexion dit quel KIND on attend : `ref(name)` seul prend le premier homonyme
  // venu, ce qui est un tirage au sort dès que deux entités partagent un nom. Constaté au
  // renommage myapp → moncompta : `project:moncompta` et `connector:moncompta` sont devenus
  // homonymes, et le lien `se connecte·mcp` de l'agent est parti sur le PROJET au lieu du
  // serveur MCP — silencieusement. Même règle qu'en D2/D3 : on choisit par kind, et on ne
  // dégrade sur le premier venu qu'à défaut.
  const KIND_ATTENDU = {
    mcp: ['connector'], datastore: ['database', 'bridge'], host: ['host'],
    repo: ['repo'], runtime: ['cli'], channel: ['account', 'workload'],
    api: ['account', 'workload', 'project'], service: ['account', 'project', 'workload'],
  };
  for (const c of (a.connects_to || [])) {
    let tid = null;
    if (c.ref) { if (ents.has('database:' + c.ref)) tid = 'database:' + c.ref; else if (ents.has(c.ref)) tid = c.ref; }
    if (!tid) for (const k of (KIND_ATTENDU[c.type] || [])) { const hit = resolveParKind(c.name, k); if (hit) { tid = hit; break; } }
    if (!tid) tid = ref(c.name) || (c.ref ? ref(c.ref) : null);
    if (tid) L(id, tid, 'se connecte·' + (c.type || ''), 'agents.json');
  }
  // agent -> chaîne d'automatisation live (résolue vers une automation/scenario si le nom matche)
  for (const ch of (a.chains || [])) {
    const cid = ref(ch.id) || ref(ch.desc);
    if (cid) L(id, cid, 'chaîne', 'agents.json');
  }
  // agent -> skills utilisés : les actions des manifestes portent le NOM du skill (m.skills[].name),
  // et les crons live le référencent aussi (chains[].desc « · <skill> »).
  const agentSkills = new Set();
  for (const act of (a.actions || [])) { const sid = 'skill:' + slug(act.name); if (ents.has(sid)) agentSkills.add(sid); }
  for (const ch of (a.chains || [])) for (const m of String(ch.desc || '').matchAll(/·\s*([a-z0-9][a-z0-9-]+)/gi)) {
    const sid = 'skill:' + slug(m[1]); if (ents.has(sid)) agentSkills.add(sid);
  }
  for (const sid of agentSkills) L(id, sid, 'utilise', 'agents.json');
}

/* ============ sources (répertoire des sources à sourcer — data/sources.json) ============ */
const srcReg = load('sources.json') || {};
for (const s of (srcReg.sources || [])) {
  db.prepare('INSERT OR REPLACE INTO source(id,name,method,collector,requires,cadence_days,status,last_synced,howto,note) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(s.id, s.name || null, s.method || null, s.collector || null, s.requires || null, s.cadence_days ?? null, normSourceStatus(s.status, 'sources.json'), s.last_synced || null, s.howto || null, s.note || null);
}

/* ============ E1 — action_types (la règle d'autorisation, comme donnée) ============ */
const actReg = load('action_types.json') || {};
const actAgents = new Set((actReg.agents || []).map(a => a.id));
const actInconnus = [];
for (const a of (actReg.actions || [])) {
  // Un agent autorisé qui n'existe pas dans le registre est une autorisation qui ne mordra
  // sur rien — on le NOMME au build plutôt que de le laisser rassurer à tort (leçon B5).
  for (const ag of (a.agents_autorises || [])) if (!actAgents.has(ag)) actInconnus.push(`${a.id} → « ${ag} »`);
  db.prepare('INSERT OR REPLACE INTO action_type(id,kind,action,outils,preconditions,effet,agents_autorises) VALUES(?,?,?,?,?,?,?)')
    .run(a.id, a.kind || null, a.action || null, JSON.stringify(a.outils || []),
         JSON.stringify(a.preconditions || []), a.effet || null, JSON.stringify(a.agents_autorises || []));
}

/* ============ runs (dernier passage des automatisations — data/runs_summary.json) ============ */
// Alimenté par runs-collect.mjs (GHA + launchd Mac + crons VPS) et par karto_ingest source=runs.
// Rattachement à l'automatisation dont le nom canonique contient la clé (même convention que
// automation_plain / gouvernance). On écrit TROIS champs :
//   attrs.lastRun    = le détail (date, statut, durée, note, journal)
//   attrs.lastStatus = le statut à plat, pour interroger la couverture en une requête
//   attrs.log        = le journal d'où vient l'observation, pour aller voir soi-même
const runsSum = load('runs_summary.json') || {};
{
  // D1 — plus de liste recopiée ici : `isExecutable` est LA définition, dans karto-vocab.mjs,
  // partagée avec karto-scenarios, karto-diagnostics et gouvernance. Les quatre divergeaient,
  // et les 41 crons du VPS étaient absents de trois d'entre elles.
  const autoEnts = [...ents.values()].filter(e => isExecutable(e.kind));
  let matched = 0, touched = 0;
  for (const r of (runsSum.runs || [])) {
    const k = canon(r.key);
    // TOUTES les entités qui portent la clé, pas seulement la première : une même
    // automatisation existe souvent en double (automation + launchagent du même label).
    // N'en marquer qu'une laissait la jumelle affichée « Actif » alors qu'elle est en panne.
    const hits = autoEnts.filter(e => e.canonical.includes(k));
    if (!hits.length) continue;
    matched++;
    for (const hit of hits) {
      hit.attrs.lastRun = { at: r.last_run || null, status: r.status, duration_s: r.duration_s, note: r.note, source: r.source, log: r.log };
      hit.attrs.lastStatus = r.status;
      if (r.log) hit.attrs.log = r.log;
      touched++;
    }
  }
  if ((runsSum.runs || []).length) console.log(`  runs: ${matched}/${runsSum.runs.length} clé(s) de run rattachée(s) → ${touched} entité(s)`);
}

/* ============ dependencies (rayon d'impact : "X dépend de Y") ============ */
const deps = load('dependencies.json') || {};
for (const dp of (deps.deps || [])) {
  const s = ref(dp.from), t = ref(dp.to);
  if (s && t) L(s, t, dp.rel || 'dépend de', 'dependencies.json');
  else unresolvedDeps.push(`${dp.from} → ${dp.to}`);
}

/* ---------- résolution des liens "int:*" — data-driven (P0+P1) ----------
 * Aucun mapping en dur. Chaque intégration (chaîne libre slugifiée) est résolue vers :
 *  (1) un COMPTE si un alias spécifique (aka/identity) ou un provider MONO-compte matche ;
 *  (2) sinon un nœud SERVICE matérialisé depuis le registre vendeurs (app_catalog ∪ vendorDomains) ;
 *  (3) sinon non résolu (loggé en fin de build).
 * Les providers MULTI-comptes (Google, Supabase, GitHub) ne sont JAMAIS devinés : on retombe sur le
 * service générique plutôt que de rattacher au mauvais compte (corrige les collisions canoniques). */
const catalog = load('app_catalog.json') || { apps: [] };
const vendorReg = new Map();   // slug -> {name, domain, category}  (registre vendeurs unifié)
const addVendor = (name, domain, category) => {
  for (const raw of [name, String(name || '').split(/[ .\/(]/)[0]]) { const ck = slug(raw); if (ck && ck.length >= 3 && !vendorReg.has(ck)) vendorReg.set(ck, { name, domain: domain || null, category: category || null }); }
};
for (const [n, d] of Object.entries(cloud.vendorDomains || {})) if (n !== '_doc') addVendor(n, d, null);  // génériques courts d'abord (Google, Make…)
for (const a of (catalog.apps || [])) addVendor(a.name, a.domain, a.category);                            // puis le catalog (catégories, noms longs)
const provCount = {};
for (const a of (cloud.accounts || [])) provCount[canon(a.provider)] = (provCount[canon(a.provider)] || 0) + 1;
const acctEntries = [];   // {key, id}  alias -> compte (plus spécifique d'abord)
for (const a of (cloud.accounts || [])) {
  const id = 'account:' + slug(a.id);
  const keys = new Set([...(a.aka || []), a.identity].filter(Boolean).map(slug));
  if (provCount[canon(a.provider)] === 1) { keys.add(slug(a.provider)); keys.add(slug(String(a.provider).split(/[ .\/]/)[0])); }
  for (const k of keys) if (k && k.length >= 3) acctEntries.push({ key: k, id });
}
acctEntries.sort((x, y) => y.key.length - x.key.length);
const tokHit = (intKey, key) => ('-' + intKey + '-').includes('-' + key + '-');   // match à la frontière de token
function resolveIntegration(intId) {
  const k = slug(intId.replace(/^(int|vendor):/, ''));
  for (const e of acctEntries) if (tokHit(k, e.key)) return e.id;                  // (1) compte
  let best = null;
  for (const [vk, v] of vendorReg) if (tokHit(k, vk) && (!best || vk.length > best.k.length)) best = { k: vk, v };
  if (best) { const sid = 'service:' + slug(best.v.name); E(sid, 'service', best.v.name, { vendor: best.v.name, domaine: best.v.domain, source: 'app_catalog.json', attrs: { category: best.v.category, materialized: true } }); return sid; }
  return null;                                                                     // (3) non résolu
}
// PRE-PASS : résout les dst "int:*" et "vendor:*" AVANT l'écriture des entités (pour matérialiser les services dans `ents`)
for (const l of edges) {
  if (typeof l.dst === 'string' && /^(int|vendor):/.test(l.dst)) {
    const r = resolveIntegration(l.dst);
    if (r) l.dst = r; else { l._drop = true; unresolvedInts.add(l.dst.replace(/^(int|vendor):/, '')); }
  }
}

/* ============ business_units (ombrelle + lignes d'activité) ============ */
const buData = load('business_units.json') || {};
// L'ombrelle n'est pas une constante de code : c'est l'unité de rôle « structure » déclarée dans
// les données. Un tiers nomme la sienne dans business_units.json, sans toucher au code.
const UMBRELLA = (buData.units || []).find(u => u.role === 'structure')?.name || '';
const buSnapshot = [...ents.values()];   // fige la liste AVANT d'ajouter les BU (pour l'auto-attache par domaine)
// D5 — le SIREN est la SEULE clé métier partagée entre les serveurs MCP (côté compta :
// moncompta_list_societes → 'siren'). Une clé de jointure malformée ne joint pas, et ne
// joint PAS EN SILENCE : on la garde telle quelle (masquer une donnée fausse la rendrait
// indiscernable d'une donnée absente — leçon C2/B3) et on la NOMME en fin de build.
const sirensMalformes = [];
const normSiren = (v) => { const s = String(v ?? '').replace(/[\s.\-]/g, ''); return s || null; };
for (const b of (buData.units || [])) {
  const siren = normSiren(b.siren);
  if (siren && !/^\d{9}$/.test(siren)) sirensMalformes.push(`${b.id || b.name} → « ${b.siren} »`);
  const id = E('bu:' + slug(b.id || b.name), 'business_unit', b.name, {
    vendor: UMBRELLA, statut: b.statut, criticite: b.criticite, owner: b.owner, source: 'business_units.json',
    attrs: { role: b.role, siren, tagline: b.tagline, revenue: b.revenue, domaines: b.domaines, members: b.members,
             parent: b.parent, holding: b.holding, equity: b.equity, fusionnee_dans: b.fusionnee_dans, successeur: b.successeur, remplace: b.remplace, note: b.note }
  });
  if (b.parent) { const pid = ref(b.parent); if (pid && pid !== id) L(id, pid, 'appartient', 'business_units.json'); }
  if (b.holding) { const hid = ref(b.holding); if (hid && hid !== id) L(hid, id, 'participation', 'business_units.json'); }   // holding détient une participation (equity, ex. minoritaire) dans cette BU
  const attached = new Set();   // évite le double edge (membre explicite + auto-attache par domaine)
  for (const m of (b.members || [])) { const mid = ref(m); if (mid && mid !== id) { L(mid, id, 'appartient', 'business_units.json'); attached.add(mid); } }
  for (const dm of (b.domaines || [])) for (const e of buSnapshot) { if (e.id !== id && !attached.has(e.id) && canon(e.domaine) === canon(dm)) { L(e.id, id, 'appartient', 'business_units.json'); attached.add(e.id); } }
  if (b.fusionnee_dans) L(id, 'bu:' + slug(b.fusionnee_dans), 'fusionnée-dans', 'business_units.json');   // cycle de vie : historisé
  if (b.successeur) L(id, 'bu:' + slug(b.successeur), 'remplacée-par', 'business_units.json');
}

/* ============ D6 — `site` : une propriété web, pas un fragment de nom ============
 * « MonProjet » apparaissait dans le nom de 53 entités de 13 kinds sans être un identifiant :
 * la question « qu'est-ce qui touche le site MonProjet ? » n'avait structurellement pas de
 * réponse. Les 4 skills SEO le citent 7 à 13 fois chacun — mais jamais un identifiant, donc
 * la règle de D4 (« on n'extrait que des identifiants, jamais des noms ») refusait à juste
 * titre de les rattacher. D6 ne relâche pas cette règle : il DÉCLARE le site, ce qui fait de
 * son `token` un identifiant, et la valeur de ce token est exactement celle de la colonne
 * `site` des tables comm_* de polar — c'est là qu'est le pont (même geste que le SIREN, D5).
 *
 * Deux rels distinctes pour deux faits distincts : un domaine APPARTIENT au site, un skill
 * ou une charge l'UTILISE (il publie dessus ou le mesure — il ne le possède pas). Le site
 * n'est PAS rattaché à une business_unit : MonProjet.fr est le site du CLIENT, Owner n'en est
 * que le prestataire — l'écrire serait un fait faux. */
const siteData = load('sites.json') || {};
const sitesTokensVus = new Map();
const sitesRefsSansSuite = [];
let sitesLiens = 0;
for (const s of (siteData.sites || [])) {
  const token = String(s.token ?? '').trim().toLowerCase();
  if (!token) { sitesRefsSansSuite.push(`${s.id || s.name} → token manquant (le site ne joindra RIEN côté polar)`); }
  if (token && sitesTokensVus.has(token)) sitesRefsSansSuite.push(`token « ${token} » déclaré par ${sitesTokensVus.get(token)} ET ${s.id} — la jointure deviendrait un tirage au sort`);
  else if (token) sitesTokensVus.set(token, s.id);
  const id = E('site:' + slug(s.id || s.token || s.name), 'site', s.name, {
    vendor: s.plateforme, statut: s.statut, criticite: s.criticite, owner: s.owner,
    url: s.domaines?.[0] ? 'https://' + s.domaines[0] : undefined, source: 'sites.json',
    attrs: { token, plateforme: s.plateforme, domaines: s.domaines, members: s.members, note: s.note },
  });
  // Un domaine déclaré mais absent de la carte est NOMMÉ, jamais créé : un site ne fabrique
  // pas d'entité DNS (monshop.fr est dans ce cas au 26/07).
  for (const d of (s.domaines || [])) { L(REF(d, ['domain']), id, 'appartient', 'sites.json'); sitesLiens++; }
  // Résolution TARDIVE (D2) et par kind : plusieurs entités portent le même nom qu'un skill.
  for (const m of (s.members || [])) { L(REF(m, ['skill', 'workload', 'project', 'automation', 'repo', 'agent', 'ea_asset']), id, 'utilise', 'sites.json'); sitesLiens++; }
}

/* ============ D4 — les collecteurs muets : ce qui est CITÉ devient une arête ============
 * Trois sources produisaient des entités et ZÉRO arête (skills 31/37 orphelins, ponts 5/5,
 * binaires 13/13), pendant que la référence utile dormait dans leur propre donnée : le corps
 * du SKILL.md, le chemin du script d'une automatisation curatée. On la lit.
 *
 * Ce bloc s'exécute ICI, après TOUS les collecteurs : résoudre plus tôt reviendrait à
 * interroger un annuaire incomplet — la faute exacte que D2 a corrigée.
 *
 * Deux natures d'arête, deux niveaux de preuve, jamais mélangés :
 *   • `code`    — le dépôt git qui porte réellement le skill, MESURÉ par `git rev-parse` à la
 *                 collecte (principe A1). Un skill qu'aucun dépôt ne porte n'a pas d'arête,
 *                 et c'est l'information utile.
 *   • `utilise` — une entité dont le texte CITE l'identifiant (chemin, dépôt, serveur MCP,
 *                 domaine). Un identifiant est un fait ; une ressemblance de nom serait une
 *                 supposition (D3) — on ne joint donc JAMAIS par le nom.
 * Règles d'échec, héritées de D2 : ce qui ne résout pas n'écrit rien, ce qui est ambigu est
 * signalé au lieu d'être tranché. */
const skillsRefsSansSuite = new Set(), skillsRefsAmbigues = new Set();
{
  const idx = indexReferences(ents.values(), { home: homedir(), canon, slug });
  // ne pas redéclarer le même fait : plusieurs chemins cités retombent souvent sur la même
  // entité (le fichier, puis son dossier). Sinon le compte rendu de doublons du build se
  // remplit de notre propre bruit et n'alerte plus sur rien.
  const relier = (src, refs, source) => {
    const vus = new Set();
    const add = dst => { if (!dst || vus.has(dst)) return; vus.add(dst); L(src, dst, 'utilise', source); };
    for (const c of (refs.paths || [])) add(idx.chemin(c));
    for (const c of (refs.repos || [])) add(idx.repo(c));
    for (const c of (refs.mcp || [])) add(idx.mcp(c));
    for (const c of (refs.domains || [])) add(idx.domaine(c));
  };
  for (const s of (sk.skills || [])) {
    const sid = 'skill:' + slug(s.name);
    if (!ents.has(sid)) continue;
    if (s.repo) {
      const rid = idx.repo(s.repo);
      if (rid) L(sid, rid, 'code', 'skills_inventory.json');
      else skillsRefsSansSuite.add(`${s.name} : dépôt « ${s.repo} » absent de la carte`);
    }
    relier(sid, s.refs || {}, 'skills_inventory.json');
  }
  /* Les automatisations curatées portent un champ `path` qui est de la PROSE — souvent le
   * script, son plist, son journal et sa configuration dans la même phrase. Le champ `project`
   * (explicite) ne couvre que 20 d'entre elles ; le chemin, lui, dit sans ambiguïté DANS QUEL
   * projet vit le code. On l'extrait avec le même extracteur que les skills : une automatisation
   * dont le script est sur le VPS ne résout rien ici, et c'est correct — la carte ne porte pas
   * les chemins distants comme des entités. */
  for (const a of (disk.systemAutomation || [])) {
    const aid = 'automation:' + slug(a.name);
    if (!ents.has(aid)) continue;
    relier(aid, extraireReferences(a.path, homedir()), 'disk_inventory.json');
  }
  for (const x of idx.ambigus) skillsRefsAmbigues.add(x);
  for (const x of idx.sansSuite) skillsRefsSansSuite.add(x);
}

/* ---------- D1 : normalisation du vocabulaire, en UN seul point de passage ----------
 * Tout ce qui a été construit plus haut — quel que soit le collecteur, quel que soit le
 * chemin (E(), Object.assign direct, enrichissement tardif) — repasse ici avant d'entrer
 * en base. Un seul endroit à relire pour savoir ce que karto accepte.
 *
 * L'ancienne colonne `status` est RELOCALISÉE, pas jetée : chaque collecteur y écrivait un
 * vocabulaire différent (indexation d'un pont, auth d'un CLI, santé côté fournisseur,
 * « en service »), donc chacun retrouve un champ qui dit vraiment ce qu'il mesure. */
const STATUS_VERS_ATTR = { cli: 'auth', database: 'providerHealth' };
const statusRelocations = [];
function finalize(e) {
  // 1. l'état observé quitte la colonne de cycle de vie
  if (e.status != null && e.status !== '') {
    const cible = STATUS_VERS_ATTR[e.kind];
    if (cible) { e.attrs[cible] = e.status; statusRelocations.push(`${e.kind} → attrs.${cible}`); }
    else {
      // account / domain / ex-webhook : c'était un doublon de `statut`. On ne promeut que si
      // `statut` est vide — sinon on ne remplace pas une intention déclarée par une recopie.
      const promu = normStatut(e.status, e.source);
      if (!e.statut && promu) { e.statut = promu; statusRelocations.push(`${e.kind} → statut`); }
      else { e.attrs.statusHerite = e.status; statusRelocations.push(`${e.kind} → attrs.statusHerite`); }
    }
  }
  delete e.status;
  // 2. les valeurs contrôlées
  const sp = splitStatut(e.statut, e.source);
  e.statut = sp.statut;
  if (sp.note) e.attrs.note = [e.attrs.note, sp.note].filter(Boolean).join(' · ');   // la prose sort de l'enum
  e.criticite = normCriticite(e.criticite, e.source);
  e.cycle = normCycle(e.cycle, e.source);
  e.owner = normOwner(e.owner, e.source);
  const dom = normDomaine(e.domaine, e.source);
  if (dom === null && e.domaine) { e.url = e.url || ('https://' + e.domaine); }   // le nom DNS rejoint `url`, il n'est pas perdu
  e.domaine = dom;
  return e;
}

/* ---------- D2 : résolution TARDIVE des extrémités déclarées par nom ----------
 * Ici, et seulement ici, toutes les entités existent. Résoudre plus tôt (ce que faisait
 * l'idiome `ref(x) || 'prefix:'+slug(x)`) revient à interroger un annuaire incomplet et à
 * inventer l'entrée manquante. On choisit par KIND parmi les homonymes — tant que D3 n'a
 * pas fusionné les doublons, un même nom porte plusieurs nœuds de types différents. */
const unresolvedRefs = new Set();
function resolveByName(name, kinds) {
  const ids = byCanonAll.get(canon(name)) || [];
  for (const k of kinds) { const hit = ids.find(id => ents.get(id)?.kind === k); if (hit) return hit; }
  return null;
}
for (const l of edges) {
  if (l._drop) continue;
  for (const end of ['src', 'dst']) {
    const v = l[end];
    if (typeof v !== 'string') continue;
    let r = null, name = null, attendu = null;
    if (v.startsWith('ref:')) {
      const s = v.slice(4), i = s.indexOf(':');
      const kinds = s.slice(0, i).split(',');
      name = s.slice(i + 1); attendu = kinds.join('/');
      // alternatives essayées DANS L'ORDRE : le libellé complet d'abord (plusieurs entités
      // s'appellent réellement « MonProjet-newsletter (chaine VPS) », parenthèses comprises),
      // sa version sans glose ensuite. On ne dégrade qu'à défaut.
      for (const n of name.split(ALT)) { r = resolveByName(n, kinds); if (r) { name = n; break; } }
    } else if (v.startsWith('refint:')) {
      name = v.slice(7); attendu = 'entité ou fournisseur';
      r = resolveByName(name, REFI_KINDS) || resolveIntegration(name);
    } else continue;
    if (r) l[end] = r;
    else { l._drop = true; unresolvedRefs.add(`${name} → aucun ${attendu} de ce nom (${l.source})`); }
  }
  if (l.src === l.dst) l._drop = true;   // la résolution peut refermer une arête sur elle-même
}

/* ---------- écriture des entités + doc (recherche) ---------- */
const insE = db.prepare('INSERT OR REPLACE INTO entity(id,kind,name,canonical,vendor,hosting,url,path,criticite,cycle,statut,cout,domaine,owner,source,doc,attrs) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const nn = v => (v === undefined ? null : v);   // node:sqlite refuse undefined
db.exec('BEGIN');
for (const e0 of ents.values()) {
  const e = finalize(e0);
  const attrsStr = JSON.stringify(e.attrs || {});
  const doc = [e.name, e.kind, e.vendor, e.hosting, e.domaine, e.statut, e.criticite, e.path, e.url, attrsStr].filter(Boolean).join(' ').toLowerCase();
  // Une contrainte CHECK de SQLite dit « constraint failed » et rien d'autre : ni la ligne,
  // ni la valeur. Sans ce contexte, un vocabulaire fermé devient un mur opaque au prochain
  // collecteur qui dérape — donc on nomme l'entité et les valeurs contrôlées.
  try {
    insE.run(nn(e.id), nn(e.kind), nn(e.name), nn(e.canonical), nn(e.vendor), nn(e.hosting), nn(e.url), nn(e.path), nn(e.criticite), nn(e.cycle), nn(e.statut), nn(e.cout), nn(e.domaine), nn(e.owner), nn(e.source), nn(doc), nn(attrsStr));
  } catch (err) {
    console.error(`\n✗ entité refusée par le vocabulaire : ${e.id}  (source : ${e.source})`);
    console.error(`   kind=${JSON.stringify(e.kind)} statut=${JSON.stringify(e.statut)} criticite=${JSON.stringify(e.criticite)} cycle=${JSON.stringify(e.cycle)}`);
    console.error(`   → ajoute la valeur à data/karto_vocabulary.json, ou corrige la source.`);
    throw err;
  }
}
// D2 — `INSERT OR IGNORE` s'appuie sur UNIQUE(src,dst,rel) : le même fait déclaré par deux
// collecteurs entre en base UNE fois. Ce n'est pas une perte — on compte et on nomme les
// doublons écartés, sinon dédupliquer redevient un silence de plus.
const insL = db.prepare('INSERT OR IGNORE INTO edge(src,dst,rel,source) VALUES(?,?,?,?)');
let relRetypes = 0, relOmis = 0;
const doublons = [], miroirs = [], pendantes = [];
const ecrites = new Set();   // "src\0dst\0rel" — sert à repérer la déclaration en miroir
for (const l of edges) {
  if (l._drop) continue;   // int:*/ref:* non résolu (pré-passes)
  const nr = normRel(l.rel, l.source);
  if (!nr) { relOmis++; continue; }              // relation inexploitable (type vide) — signalée, pas inventée
  if (nr.rel !== l.rel) relRetypes++;
  // Filet : la FK refuserait de toute façon, mais elle dirait « FOREIGN KEY constraint
  // failed » sans nommer personne. On veut savoir QUI pend, comme pour le vocabulaire (D1).
  if (!ents.has(l.src) || !ents.has(l.dst)) { pendantes.push(`${l.src} —${nr.rel}→ ${l.dst}  (${l.source})`); continue; }
  // AUCUNE relation du vocabulaire n'est symétrique : `utilise`, `tourne-sur`, `hébergé-chez`
  // sont orientées. Une paire réciproque de MÊME rel n'est donc pas deux faits, c'est un fait
  // déclaré des deux bouts (ea_inventory : l'actif cite l'hôte ET l'hôte cite l'actif). On
  // garde la première déclaration et on dit laquelle a été écartée — un inverse volontaire
  // (rel DIFFÉRENT, ex. `appartient`/`participation`) passe, lui, sans être touché.
  const cle = `${l.src} ${l.dst} ${nr.rel}`;
  if (ecrites.has(`${l.dst} ${l.src} ${nr.rel}`)) { miroirs.push(`${l.dst} ↔ ${l.src} (${nr.rel}, ${l.source})`); continue; }
  // Le doublon est repéré ICI, pas via le `changes` de l'INSERT : le moteur de repli CLI
  // bufferise ses écritures et renvoie toujours `changes: 0` — s'y fier aurait déclaré les
  // 330 arêtes en doublon sur Node < 22. UNIQUE(src,dst,rel) reste la ceinture (elle protège
  // aussi tout écrivain futur) ; ce Set est ce qui permet de NOMMER ce qui a été écarté.
  if (ecrites.has(cle)) { doublons.push(`${l.src} —${nr.rel}→ ${l.dst}  (2ᵉ déclaration : ${l.source})`); continue; }
  insL.run(nn(l.src), nn(l.dst), nn(nr.rel), nn(l.source));
  ecrites.add(cle);
}
db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('builtAt', new Date().toISOString());
db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('owner', owner);
db.exec('COMMIT');
db.flush();   // repli CLI : matérialise les écritures bufferisées (no-op avec node:sqlite)

// `edges.length` compte AUSSI les arêtes écartées (int:* non résolu, relation inexploitable) :
// le log annonçait 345 quand la base en portait 343. On rapporte ce qui est réellement écrit.
const n = ents.size, ne = db.prepare('SELECT COUNT(*) n FROM edge').get().n;
const counts = {};
for (const e of ents.values()) counts[e.kind] = (counts[e.kind] || 0) + 1;
console.log(`✓ karto.db construit — ${n} entités · ${ne} liens`);
console.log('  ' + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(' · '));
if (unresolvedInts.size) console.warn(`  ⚠ ${unresolvedInts.size} intégration(s) non résolue(s) (edge omis) — ajoute un mapping dans resolveInt() ou un compte/connecteur : ${[...unresolvedInts].sort().join(', ')}`);
if (unresolvedProjects.size) console.warn(`  ⚠ ${unresolvedProjects.size} projet(s) d'automatisation non résolu(s) (champ "project" libre) : ${[...unresolvedProjects].join(' | ')}`);
if (unresolvedDeps.length) console.warn(`  ⚠ ${unresolvedDeps.length} dépendance(s) non résolue(s) (nom inconnu) : ${unresolvedDeps.join(' | ')}`);
if (orphanSshAliases.length) console.warn(`  ⚠ ${orphanSshAliases.length} alias SSH sans hôte correspondant : ${orphanSshAliases.join(' | ')}`);
if (ecrasementsRefuses.length) console.warn(`  ⛔ ${ecrasementsRefuses.length} écrasement(s) REFUSÉ(S) — un collecteur voulait remplacer une valeur déjà connue (règle « on remplit les trous, on n'écrase jamais ») :\n      ${ecrasementsRefuses.slice(0, 20).join('\n      ')}${ecrasementsRefuses.length > 20 ? `\n      … et ${ecrasementsRefuses.length - 20} autre(s)` : ''}`);
else console.log('  ingestion : 0 écrasement refusé (aucun collecteur n\'a tenté de remplacer une valeur connue).');
if (curations.length) console.log(`  ✎ ${curations.length} valeur(s) remplacée(s) par une couche d'AUTORITÉ (curation assumée, pas un collecteur) :\n      ${curations.join('\n      ')}`);
if (unresolvedBridgeRefs.length) console.warn(`  ⚠ ${unresolvedBridgeRefs.length} pont(s) sans compte résolu : ${unresolvedBridgeRefs.join(' | ')}`);
if (unresolvedGhaRepos.size) console.warn(`  ⚠ ${unresolvedGhaRepos.size} workflow(s) GHA sans dépôt unique (ambiguïté NON tranchée) : ${[...unresolvedGhaRepos].join(' | ')}`);
if (skillsRefsSansSuite.size) console.warn(`  ⚠ ${skillsRefsSansSuite.size} référence(s) de skill sans entité correspondante (arête non écrite) :\n      ${[...skillsRefsSansSuite].join('\n      ')}`);
if (skillsRefsAmbigues.size) console.warn(`  ⚠ ${skillsRefsAmbigues.size} référence(s) de skill AMBIGUË(S), non tranchée(s) :\n      ${[...skillsRefsAmbigues].join('\n      ')}`);

/* ---------- D1 : compte rendu du vocabulaire ----------
 * Une normalisation silencieuse est une perte d'information déguisée en propreté. On dit ce
 * qu'on a re-typé, ce qu'on a déplacé, et surtout ce qu'on n'a PAS su classer. */
const relocs = statusRelocations.reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {});
console.log(`  vocabulaire : ${relRetypes} relation(s) re-typée(s)${relOmis ? `, ${relOmis} omise(s)` : ''} · status relocalisé : ${Object.entries(relocs).map(([k, v]) => `${v} ${k}`).join(' · ') || 'aucun'}`);
const traitees = vocabReport('traite');
if (traitees.length) for (const u of traitees) console.log(`      ↳ ${u.champ} : « ${u.valeur} » ×${u.n}  (${u.source})`);
const inconnues = vocabReport('inconnu');
if (inconnues.length) {
  console.warn(`  ⚠ ${inconnues.length} valeur(s) HORS VOCABULAIRE — la contrainte CHECK les rejettera ; ajoute-les à data/karto_vocabulary.json ou corrige la source :`);
  for (const u of inconnues) console.warn(`      ${u.champ} = « ${u.valeur} » ×${u.n}  (source : ${u.source})`);
} else console.log('  vocabulaire : aucune valeur hors référentiel.');
/* ---------- D2 : compte rendu d'intégrité référentielle ----------
 * Le contrôle d'origine ne regardait que `dst`. Sur les 5 arêtes pendantes de la base, 3
 * avaient une SOURCE manquante — invisibles par construction. On contrôle les deux bouts. */
if (unresolvedRefs.size) console.warn(`  ⚠ ${unresolvedRefs.size} extrémité(s) d'arête non résolue(s) (arête NON écrite, rien n'est inventé) :\n      ${[...unresolvedRefs].join('\n      ')}`);
if (pendantes.length) console.warn(`  ⚠ ${pendantes.length} arête(s) pendante(s) écartée(s) — une extrémité n'existe pas :\n      ${pendantes.join('\n      ')}`);
if (doublons.length) console.log(`  ⧉ ${doublons.length} arête(s) en doublon exact, écrite(s) une seule fois :\n      ${doublons.join('\n      ')}`);
if (miroirs.length) console.log(`  ⇄ ${miroirs.length} déclaration(s) en miroir écartée(s) (même relation dans les deux sens) :\n      ${miroirs.join('\n      ')}`);
if (eaFusionnes.length) console.log(`  ⚭ ${eaFusionnes.length} actif(s) EA réconcilié(s) par IDENTIFIANT (le nom seul ne suffisait pas) :\n      ${eaFusionnes.join('\n      ')}`);
const pend = db.prepare('SELECT COUNT(*) n FROM edge e LEFT JOIN entity s ON s.id=e.src LEFT JOIN entity d ON d.id=e.dst WHERE s.id IS NULL OR d.id IS NULL').get().n;
/* D3 — deux entités de MÊME kind et même `canonical` sont un doublon : `canonical` est la clé
 * de jointure, donc résoudre ce nom revient à tirer au sort. Deux entités de kinds DIFFÉRENTS
 * qui partagent un nom ne le sont pas — un projet, son agent et son skill sont trois objets à
 * cycles de vie distincts. C'est pourquoi l'invariant contrôlé porte sur (kind, canonical) et
 * pas sur `canonical` seul : viser « 0 collision » tout court aurait fusionné des objets
 * différents ou maquillé leurs noms. */
const collKind = db.prepare("SELECT kind, canonical, COUNT(*) n FROM entity WHERE canonical<>'' GROUP BY kind, canonical HAVING n>1").all();
const collTous = db.prepare("SELECT COUNT(*) n FROM (SELECT canonical FROM entity WHERE canonical<>'' GROUP BY canonical HAVING COUNT(*)>1)").get().n;
console.log(`  intégrité du graphe : ${pend} arête(s) pendante(s) · ${collKind.length} doublon(s) (même kind + même nom) · ${collTous} homonyme(s) inter-kinds (légitimes) · FK + UNIQUE(src,dst,rel) actives`);
if (collKind.length) console.warn(`  ⚠ doublon(s) à fusionner : ${collKind.map(c => `${c.n}× ${c.kind} « ${c.canonical} »`).join(' · ')}`);
/* D5 — le SIREN est une clé de JOINTURE inter-MCP : elle ne vaut que si elle est bien formée
 * et unique. Une personne morale = un SIREN ; deux unités qui portent le même désignent le
 * même immatriculé, donc joindre par ce champ deviendrait un tirage au sort (même raisonnement
 * que l'invariant (kind, canonical) de D3). moncompta l'impose déjà à la création côté compta. */
const sirens = db.prepare("SELECT id, json_extract(attrs,'$.siren') s FROM entity WHERE json_extract(attrs,'$.siren') IS NOT NULL").all();
const sirenDup = Object.entries(sirens.reduce((a, r) => ((a[r.s] = (a[r.s] || []).concat(r.id)), a), {})).filter(([, v]) => v.length > 1);
console.log(`  clé métier SIREN : ${sirens.length} unité(s) immatriculée(s) · ${sirensMalformes.length} malformé(s) · ${sirenDup.length} en doublon`);
if (sirensMalformes.length) console.warn(`  ⚠ SIREN malformé (9 chiffres attendus) — ne joindra PAS avec la compta : ${sirensMalformes.join(' · ')}`);
if (sirenDup.length) console.warn(`  ⚠ SIREN partagé par plusieurs unités : ${sirenDup.map(([s, ids]) => `${s} → ${ids.join(', ')}`).join(' · ')}`);
/* D6 — même exigence que le SIREN sur l'autre clé de jointure : le `token` d'un site est la
 * valeur de la colonne `site` des tables comm_* de polar. Deux sites qui le partageraient
 * rendraient toute mesure SEO inattribuable. Les liens déclarés et non résolus sont comptés
 * ici plutôt que noyés dans le total : un site qui ne rattache rien est un site inutile. */
const siteEnts = db.prepare("SELECT id, json_extract(attrs,'$.token') t FROM entity WHERE kind='site'").all();
const siteLiensEcrits = db.prepare("SELECT COUNT(*) n FROM edge WHERE source='sites.json'").get().n;
console.log(`  dimension SITE : ${siteEnts.length} site(s) · ${siteLiensEcrits}/${sitesLiens} lien(s) déclaré(s) résolu(s) · tokens ${siteEnts.map(s => s.t).join(', ') || '—'}`);
if (sitesRefsSansSuite.length) console.warn(`  ⚠ déclaration de site à corriger : ${sitesRefsSansSuite.join(' · ')}`);

/* ---------- F2 : les invariants du build DEVIENNENT une donnée de la base ----------
 * Tout ce qui précède était imprimé sur stdout, une fois, puis perdu. Or ce sont exactement
 * les défauts que personne ne revoit : une référence déclarée qui ne résout pas, un écrasement
 * refusé, une entrée de liste blanche morte. Un audit qui ne tourne que quand on y pense ne
 * protège de rien — `karto_diagnostics` doit pouvoir les REMONTER, à la demande, longtemps après.
 *
 * Pourquoi les PERSISTER plutôt que les recalculer dans le diagnostic : ce sont des faits sur ce
 * qui n'a PAS été écrit. Une arête refusée parce qu'une extrémité n'existe pas n'est, par
 * construction, dans aucune table — la base ne peut pas la montrer, seul le build l'a vue.
 * (Ce qui EST dans la base — pendantes, doublons, vocabulaire — reste mesuré en direct par le
 * diagnostic : deux vérités calculées séparément divergent au premier renommage.) */
const invariants = {
  builtAt: new Date().toISOString(),
  refsNonResolues: [...unresolvedRefs],
  projetsNonResolus: [...unresolvedProjects],
  dependancesNonResolues: unresolvedDeps,
  integrationsNonResolues: [...unresolvedInts],
  skillsRefsSansSuite: [...skillsRefsSansSuite],
  skillsRefsAmbigues: [...skillsRefsAmbigues],
  pontsSansCompte: unresolvedBridgeRefs,
  ghaSansDepot: [...unresolvedGhaRepos],
  aliasSshOrphelins: orphanSshAliases,
  ecrasementsRefuses,
  curations,
  vocabulaireInconnu: inconnues,
  aretesDoublonExact: doublons.length,
  aretesMiroirEcartees: miroirs.length,
  aretesPendantesEcartees: pendantes,
  site: { declares: sitesLiens, resolus: siteLiensEcrits, aCorriger: sitesRefsSansSuite },
  siren: { porteurs: sirens.length, malformes: sirensMalformes, doublons: sirenDup.map(([s, ids]) => `${s} → ${ids.join(', ')}`) },
};
db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('invariants', JSON.stringify(invariants));
db.flush();

/* ---------- snapshot & DÉTECTION DE DÉRIVE (nouveautés depuis le dernier build) ---------- */
const snapPath = join(__dir, 'data', '.karto-snapshot.json');
const expo = (disk.exposures || []);
const cur = { ts: new Date().toISOString(), ids: {}, exposures: expo.length, exposuresOpen: expo.filter(e => (e.status || 'open') !== 'closed').length };
// `status` n'existe plus : le journal de dérive suit `statut`, la seule colonne de cycle de vie.
// (Il lisait déjà `e.status || e.statut` — le code traitait donc les deux comme une seule notion.)
for (const e of ents.values()) cur.ids[e.id] = { kind: e.kind, name: e.name, status: e.statut || null };
let prev = null; try { prev = JSON.parse(readFileSync(snapPath, 'utf8')); } catch {}
if (prev) {
  const fresh = Object.keys(cur.ids).filter(id => !prev.ids[id]);
  const gone = Object.keys(prev.ids).filter(id => !cur.ids[id]);
  const chg = Object.keys(cur.ids).filter(id => prev.ids[id] && (prev.ids[id].status || '') !== (cur.ids[id].status || ''));
  const lines = [];
  const show = (ids, src) => ids.map(id => (src[id] || {}).name || id).slice(0, 14).join(', ') + (ids.length > 14 ? '…' : '');
  if (fresh.length) lines.push(`  ＋ ${fresh.length} nouveauté(s) : ${show(fresh, cur.ids)}`);
  if (gone.length) lines.push(`  － ${gone.length} disparue(s) : ${show(gone, prev.ids)}`);
  for (const id of chg) lines.push(`  ~ statut : ${cur.ids[id].name} « ${prev.ids[id].status || '∅'} » → « ${cur.ids[id].status || '∅'} »`);
  const expoDelta = cur.exposures - prev.exposures;
  if (expoDelta > 0) lines.push(`  ⚠ ${expoDelta} exposition(s) sécurité en plus (total ${cur.exposures}, dont ${cur.exposuresOpen} ouverte(s))`);
  if (lines.length) { console.log('\n🔔 Dérive depuis le dernier build :'); lines.forEach(l => console.log(l)); }
  else console.log('\n🔔 Aucune dérive depuis le dernier build.');
}
writeFileSync(snapPath, JSON.stringify(cur, null, 2));
