#!/usr/bin/env node
// Build de la cartographie IT — fusionne data/*.json, construit le graphe,
// chiffre (AES-256-GCM / PBKDF2) ou non, et produit index.html autonome.
//
// Usage :
//   node build.mjs --plain                       -> index.html en clair (topologie rédigée, preview local)
//   node build.mjs --passphrase "ma phrase"      -> index.html chiffré (valeurs <redacted>)
//   node build.mjs --passphrase "ma phrase" --with-secrets   -> chiffré + valeurs lues en mémoire depuis les .env locaux
//
// Les valeurs de secrets ne sont JAMAIS écrites en clair sur le disque :
// elles sont lues en RAM puis directement chiffrées dans index.html.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const PLAIN = has('--plain');
const WITH_SECRETS = has('--with-secrets');
const PASS = val('--passphrase') || process.env.CARTO_PASS;
if (!PLAIN && !PASS) { console.error('✗ Fournis --passphrase "…" (ou CARTO_PASS), ou --plain.'); process.exit(1); }
if (PLAIN && WITH_SECRETS) { console.error('✗ --plain est INCOMPATIBLE avec --with-secrets : cela écrirait les valeurs de secrets EN CLAIR sur le disque. Abandon.'); process.exit(1); }

const disk = JSON.parse(readFileSync(join(__dir, 'data/disk_inventory.json'), 'utf8'));
const cloud = JSON.parse(readFileSync(join(__dir, 'data/cloud_inventory.json'), 'utf8'));
// Défense cause-racine (audit 22/06) : le token de chemin d'un webhook Make EST un secret déclencheur.
// On le masque TOUJOURS dans l'artefact baké (jamais exposé, même --with-secrets) — il vit dans Make.
for (const w of ((cloud.make && cloud.make.webhooks) || []))
  if (w && typeof w.url === 'string') w.url = w.url.replace(/(hook\.[a-z0-9.]*\/)[^"'\s]+/i, '$1<redacted>');
const cfg = (() => { try { return JSON.parse(readFileSync(join(__dir, 'karto.config.json'), 'utf8')); } catch { return {}; } })();
const ownerSet = !!(cfg.owner && cfg.owner.name);   // owner configuré → on rend les blocs owner (Système, hosted, arêtes manuelles)
const gh = cfg.github || {};

/* ---------- secrets (à plat) + lecture optionnelle des valeurs ---------- */
function readEnvValues(path) {
  // renvoie une map KEY->valeur depuis un .env ou un .json local. {} si illisible.
  if (!existsSync(path)) return {};
  let raw; try { raw = readFileSync(path, 'utf8'); } catch { return {}; }
  const map = {};
  if (path.endsWith('.json')) {
    try { const o = JSON.parse(raw); const flat = (p, ob) => { for (const k in ob) { const v = ob[k]; if (v && typeof v === 'object') flat(k, v); else map[k] = String(v); } }; flat('', o); } catch {}
  } else {
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return map;
}

let filled = 0;
const secrets = [];
for (const p of disk.projects) {
  for (const ef of (p.envFiles || [])) {
    let vmap = {};
    if (WITH_SECRETS) vmap = readEnvValues(ef.path);
    for (const v of ef.vars) {
      const key = v.name.split(/[\s(]/)[0];               // jeton de clé avant espace/parenthèse
      let value = '<redacted>';
      if (WITH_SECRETS && vmap[key] != null) { value = vmap[key]; filled++; }
      secrets.push({ name: v.name, service: v.service, project: p.name, path: ef.path, value });
    }
  }
}

/* ---------- automatisations fusionnées ---------- */
const automations = [];
// project = champ explicite des données (plus d'inférence regex sur le nom — voir data/*.json)
for (const a of disk.systemAutomation) automations.push({ name: a.name, kind: a.type.split('(')[0].trim(), schedule: a.schedule, enabled: a.enabled, does: a.does, project: a.project || '', claudeTier: a.claudeTier || null, chain: a.chain || [], edges: a.edges || [], tags: a.tags || [], triggers: a.triggers || [], host: a.host || '', stakeholders: a.stakeholders || [] });
for (const g of cloud.github.actions) automations.push({ name: `${g.repo} · ${g.workflow}`, kind: 'GitHub Actions', schedule: g.trigger, enabled: g.status === 'active', does: g.does, project: g.repo, claudeTier: g.claudeTier || null, chain: g.chain || [] });
for (const s of cloud.make.scenarios) automations.push({ name: `Make · ${s.name}`, kind: 'Make.com', schedule: s.trigger, enabled: s.active, does: s.does, project: s.project || '', claudeTier: s.claudeTier || null, chain: s.chain || [] });
// résumé « en clair » (novice) attaché par nom — softcode, éditable dans data/automation_plain.json
let plainMap = {}; try { plainMap = JSON.parse(readFileSync(join(__dir, 'data/automation_plain.json'), 'utf8')).plain || {}; } catch {}
let autoTax = {}; try { autoTax = JSON.parse(readFileSync(join(__dir, 'data/automation_taxonomy.json'), 'utf8')); } catch {}
let brandIcons = {}; try { brandIcons = JSON.parse(readFileSync(join(__dir, 'data/brand_icons.json'), 'utf8')); } catch {}
for (const a of automations) { for (const k in plainMap) { if (k !== '_doc' && a.name.toLowerCase().includes(k.toLowerCase())) { a.plain = plainMap[k]; break; } } }

/* ---------- modèle EA (style Boldo : actifs + capacités) ---------- */
// type ∈ Application | Base | Infrastructure | Connecteur | Automatisation
// criticite ∈ Critique | Élevée | Moyenne | Faible
// cycle (TIME) ∈ Investir | Tolérer | Migrer | Éliminer
// statut ∈ Actif | Dev | En pause | Partiel
const A = (o) => ({ cout: 0, owner: 'Owner', links: [], rel: [], ...o });
// Source de vérité UNIQUE et versionnée : data/ea_inventory.json (plus de seed hardcodé → zéro drift).
const eaPath = join(__dir, 'data/ea_inventory.json');
if (!existsSync(eaPath)) { console.error('✗ data/ea_inventory.json manquant — c\'est la source de vérité de l\'inventaire EA.'); process.exit(1); }
const eaAssets = JSON.parse(readFileSync(eaPath, 'utf8')).assets.map(A);
const eaDomaines = [...new Set(eaAssets.map(a => a.domaine))];
const ea = {
  assets: eaAssets,
  capabilities: eaDomaines.map(d => ({ domaine: d, assets: eaAssets.filter(a => a.domaine === d).map(a => a.name) })),
  costNote: 'Coûts mensuels = estimations éditables (€/mois). 0 = gratuit ou à renseigner.'
};

/* ---------- graphe ---------- */
const nodes = [], edges = [];
const N = (id, label, cat, meta) => { if (!nodes.find(n => n.id === id)) nodes.push({ id, label, cat, meta }); return id; };
const E = (s, t, kind) => { if (s && t && s !== t) edges.push({ s, t, kind }); };

// comptes
for (const a of cloud.accounts) N('acc:' + a.id, a.provider, 'account', `${a.identity}${a.note ? ' — ' + a.note : ''}`);
// hosts
N('host:netlify', 'Netlify', 'host', 'Hébergement statique');
N('host:hetzner', 'Hetzner VPS', 'host', cloud.hetzner.vps);
E('host:netlify', 'acc:netlify', 'compte');
E('host:hetzner', 'acc:hetzner', 'compte');
// domaines (DNS / hébergement / email) — softcode depuis cloud.domains.list
const domSlug = s => 'dom:' + String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const nodeByLabel = name => { const c = String(name || '').toLowerCase(); const n = nodes.find(x => (x.cat === 'account' || x.cat === 'host') && String(x.label).toLowerCase() === c); return n ? n.id : null; };
for (const d of ((cloud.domains && cloud.domains.list) || [])) {
  const id = N(domSlug(d.name), d.name, 'domain', [d.dns && ('DNS ' + d.dns), d.host && ('→ ' + d.host), d.email && ('✉ ' + d.email)].filter(Boolean).join(' · '));
  E(id, nodeByLabel(d.dns), 'dns');
  E(id, nodeByLabel(d.host), 'héberge');
  E(id, nodeByLabel(d.email), 'email');
  if (d.project) E('proj:' + d.project, id, 'domaine');
}

// bases supabase
for (const db of cloud.supabase.projects) { N('db:' + db.ref, 'SB ' + db.name, 'db', `${db.region} · ${db.status}`); E('db:' + db.ref, 'acc:sb-bcapital', 'héberge'); }
for (const db of (cloud.supabase.offAccount || [])) { N('db:' + db.name, 'SB ' + db.name, 'db', db.note); E('db:' + db.name, 'acc:sb-autre', 'héberge'); }

// projets + liens intégrations -> comptes/services (résolution data-driven, parité avec karto-db.mjs) :
// une intégration résout vers (1) un compte si alias unique / provider mono-compte, sinon (2) un nœud
// "service" matérialisé depuis le registre vendeurs (app_catalog ∪ vendorDomains), sinon (3) ignorée.
// Les providers multi-comptes (Google, Supabase, GitHub) ne sont jamais devinés -> service générique.
const gslug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const gcanon = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
let _cat = []; try { _cat = JSON.parse(readFileSync(join(__dir, 'data/app_catalog.json'), 'utf8')).apps || []; } catch {}
const vendorReg = new Map();
const addVendor = (name, domain, category) => { for (const raw of [name, String(name || '').split(/[ .\/(]/)[0]]) { const ck = gslug(raw); if (ck && ck.length >= 3 && !vendorReg.has(ck)) vendorReg.set(ck, { name, domain: domain || null, category: category || null }); } };
for (const [n, d] of Object.entries(cloud.vendorDomains || {})) if (n !== '_doc') addVendor(n, d, null);
for (const a of _cat) addVendor(a.name, a.domain, a.category);
const provCount = {}; for (const a of cloud.accounts) provCount[gcanon(a.provider)] = (provCount[gcanon(a.provider)] || 0) + 1;
const acctEntries = [];
for (const a of cloud.accounts) { const id = 'acc:' + a.id; const keys = new Set([...(a.aka || []), a.identity].filter(Boolean).map(gslug)); if (provCount[gcanon(a.provider)] === 1) { keys.add(gslug(a.provider)); keys.add(gslug(String(a.provider).split(/[ .\/]/)[0])); } for (const k of keys) if (k && k.length >= 3) acctEntries.push({ key: k, id }); }
acctEntries.sort((x, y) => y.key.length - x.key.length);
const tokHit = (ik, k) => ('-' + ik + '-').includes('-' + k + '-');
const resolveIntUI = raw => {
  const k = gslug(raw);
  for (const e of acctEntries) if (tokHit(k, e.key)) return e.id;
  let best = null; for (const [vk, v] of vendorReg) if (tokHit(k, vk) && (!best || vk.length > best.k.length)) best = { k: vk, v };
  if (best) return N('svc:' + gslug(best.v.name), best.v.name, 'connector', best.v.category || 'service tiers');
  return null;
};
for (const p of disk.projects) {
  const pid = N('proj:' + p.name, p.name, 'project', `${p.hosting} · ${(p.stack || []).slice(0, 3).join(', ')}`);
  if (/Netlify/i.test(p.hosting || '')) E(pid, 'host:netlify', 'déployé');
  if (/Hetzner/i.test(p.hosting || '')) E(pid, 'host:hetzner', 'déployé');
  for (const i of (p.integrations || [])) { const t = resolveIntUI(i); if (t) E(pid, t, i); }
  if (gh.user && (p.gitRemotes || []).some(r => r.includes('github.com/' + gh.user))) E(pid, 'acc:gh-perso', 'repo');
  if (gh.altUser && (p.gitRemotes || []).some(r => r.includes(gh.altUser))) E(pid, 'acc:gh-jbct', 'repo');
}
// projets -> bases (via app : nom d'application consommatrice)
for (const db of cloud.supabase.projects) for (const p of disk.projects) if ((db.app || '').toLowerCase().includes(p.name.toLowerCase().split(' ')[0])) E('proj:' + p.name, 'db:' + db.ref, 'utilise');
for (const e of (cfg.seedEdges || [])) E(e.s, e.t, e.kind);   // arêtes manuelles owner (softcode karto.config)

// automatisations infra (launchd + cron VPS + GitHub Actions) -> projet
for (const a of disk.systemAutomation) { const id = N('auto:' + a.name, a.name.replace(/^com\.\w+\./, ''), 'auto', `${a.schedule}${a.enabled ? '' : ' (off)'}`); if (a.project) E(id, 'proj:' + a.project, 'planifie'); }
for (const g of cloud.github.actions) { const id = N('auto:gha:' + g.repo, 'GHA ' + g.workflow, 'auto', g.trigger); E(id, 'proj:' + g.repo, 'CI'); }

// scénarios make + connexions + webhooks
for (const s of cloud.make.scenarios) { const id = N('scn:' + s.id, s.name, 'scenario', `${s.active ? 'actif' : 'inactif'} · ${s.trigger}`); E(id, 'acc:make', 'scénario'); }
for (const c of cloud.make.connections) {
  const id = N('conn:' + c.id, c.app, 'connector', `${c.type} · ${c.account}`);
  if (gh.googleAccountPattern && gh.googleAccountId && c.account && c.account.includes(gh.googleAccountPattern)) E(id, gh.googleAccountId, 'compte');
  if (/Anthropic/i.test(c.app)) E(id, 'acc:anthropic', 'api');
  for (const u of (c.usedBy || [])) { const sc = cloud.make.scenarios.find(s => u.includes(s.name) || s.name.includes(u.replace(/[()]/g, '').trim())); if (sc) E(id, 'scn:' + sc.id, 'utilisée'); }
}
for (const w of cloud.make.webhooks) { const id = N('wh:' + w.id, w.name, 'webhook', w.type); const sc = cloud.make.scenarios.find(s => w.scenario.includes(s.name)); if (sc) E(id, 'scn:' + sc.id, 'déclenche'); }

/* ---------- modèle final ---------- */
const model = {
  meta: { owner: disk._meta.owner, generated: disk._meta.generated, policy: disk._meta.policy, builtAt: new Date().toISOString() },
  kpis: {
    projects: disk.projects.length, accounts: cloud.accounts.length,
    databases: cloud.supabase.projects.length + (cloud.supabase.offAccount || []).length,
    automations: automations.length, connectors: cloud.make.connections.length,
    domains: ((cloud.domains && cloud.domains.list) || []).length,
    secrets: secrets.length, exposures: disk.exposures.length,
    critical: disk.exposures.filter(e => e.severity === 'critical').length
  },
  projects: disk.projects, cloud, automations, autoTax, brandIcons, secrets, exposures: disk.exposures,
  ea, logins: [], deviceArchive: [],
  graph: { nodes, edges }
};
model.kpis.assets = ea.assets.length;
model.kpis.capabilities = ea.capabilities.length;
let appCatalog = []; try { appCatalog = JSON.parse(readFileSync(join(__dir, 'data/app_catalog.json'), 'utf8')).apps || []; } catch {}
model.appCatalog = appCatalog;

// Données stratégiques + canaux (softcode de la couche « où vivent mes données »)
let dataAssets = { canaux: {}, assets: [] };
try { const da = JSON.parse(readFileSync(join(__dir, 'data/data_assets.json'), 'utf8')); dataAssets = { canaux: da.canaux || {}, assets: da.assets || [] }; } catch {}
model.dataAssets = dataAssets;
model.kpis.dataAssets = dataAssets.assets.length;

// Bridges (registre des bases connectées) + inventaire machine auto-collecté.
// Backend requêtable : data/bridges.json (karto-bridge.mjs) + data/machine_inventory.json (karto-collect.mjs).
let bridges = []; try { bridges = JSON.parse(readFileSync(join(__dir, 'data/bridges.json'), 'utf8')).bridges || []; } catch {}
model.bridges = bridges;
let dependencies = []; try { dependencies = JSON.parse(readFileSync(join(__dir, 'data/dependencies.json'), 'utf8')).deps || []; } catch {}
model.dependencies = dependencies;
model.kpis.bridges = bridges.length;
let machine = null; try { machine = JSON.parse(readFileSync(join(__dir, 'data/machine_inventory.json'), 'utf8')); } catch {}
if (machine) { model.machine = machine; model.kpis.runtimes = (machine.runtimes || []).length; }

// Annuaire des comptes synchronisé depuis Bitwarden (gitignoré, sans mots de passe).
// Baké UNIQUEMENT dans le coffre chiffré ; jamais dans data/*.json poussés sur GitHub.
let accountRegistry = null;
try { accountRegistry = JSON.parse(readFileSync(join(__dir, 'data/account_registry.local.json'), 'utf8')); } catch {}
if (accountRegistry) { model.accountRegistry = accountRegistry; model.kpis.externalAccounts = accountRegistry.total || (accountRegistry.accounts || []).length; }
let vaultConnection = null;
try { vaultConnection = JSON.parse(readFileSync(join(__dir, 'data/vault_connection.json'), 'utf8')); } catch {}
if (vaultConnection) model.vaultConnection = vaultConnection;   // coffre connecté (provider/total/byCategory) via vault-connect.mjs

/* ---------- ops : mode d'emploi opérationnel (sauvegarde / restauration / sync) ---------- */
let lastSync = null;
try { lastSync = JSON.parse(readFileSync(join(__dir, 'data/sync_log.json'), 'utf8')).lastSync || null; } catch {}
// Bloc « Système » (restauration/backup/deploy) = owner-spécifique → softcodé dans karto.config.
// Vierge (owner non configuré) → model.ops = null → l'onglet Système se masque (renderOps : if(!o)return).
model.ops = ownerSet && cfg.ops ? { ...cfg.ops, lastSync } : null;
model.hosted = ownerSet ? (cfg.hosted || null) : null;

/* ---------- merge : report de la couche MANUELLE du coffre precedent ----------
 * Regle : data/*.json fait foi pour la topologie ; on reporte depuis l'ancien
 * index.html chiffre uniquement (a) les VALEURS de secrets que le build n'a pas
 * remplies, et (b) les lignes d'ID de compte ajoutees a la main (cle absente de
 * la topologie regeneree). Defaut ON en mode chiffre ; desactivable via --no-merge.
 * Si la passphrase ne dechiffre pas l'ancien coffre, on continue SANS merge. */
const MERGE = !PLAIN && !has('--no-merge') && PASS && existsSync(join(__dir, 'index.html'));
if (MERGE) {
  let wasEncrypted = false;
  try {
    const prevHtml = readFileSync(join(__dir, 'index.html'), 'utf8');
    const pm = prevHtml.match(/<script id="payload"[^>]*>([\s\S]*?)<\/script>/);
    if (!pm) throw new Error('payload introuvable');
    const pp = JSON.parse(pm[1]);
    if (!pp || !pp.ct || !pp.salt) throw new Error('index.html precedent non chiffre (rien a reporter)');
    wasEncrypted = true;
    const b64d = s => new Uint8Array(Buffer.from(s, 'base64'));
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASS), 'PBKDF2', false, ['deriveKey']);
    const dkey = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64d(pp.salt), iterations: pp.iter, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(pp.iv) }, dkey, b64d(pp.ct));
    const prev = JSON.parse(new TextDecoder().decode(pt));
    // (a) valeurs de secrets : le coffre gagne quand le build laisse <redacted>
    const pv = new Map();
    for (const s of (prev.secrets || [])) if (s.value && s.value !== '<redacted>') pv.set(s.path + ' ' + s.name, s.value);
    let carried = 0;
    for (const s of model.secrets) { const k = s.path + ' ' + s.name; if ((!s.value || s.value === '<redacted>') && pv.has(k)) { s.value = pv.get(k); carried++; } }
    // (b) comptes & ids — le MANUEL (coffre navigateur) fait foi : les valeurs d'ID
    //     editees gagnent, les lignes ajoutees sont reportees, et un compte entier
    //     ajoute au navigateur survit. data/*.json ne sert que de socle/seed.
    const pa = new Map(); for (const a of ((prev.cloud && prev.cloud.accounts) || [])) pa.set(a.id, a);
    let idsCarried = 0, accCarried = 0;
    for (const a of model.cloud.accounts) {
      const o = pa.get(a.id); if (!o) continue;
      if (o.email && !a.email) a.email = o.email;                                   // email manuel reporte
      if (!Array.isArray(o.ids)) continue;
      a.ids ||= [];
      const vByK = new Map(o.ids.filter(x => x && x.k).map(x => [x.k, x]));
      for (const id of a.ids) { const v = vByK.get(id.k); if (v) { if ((v.v ?? '') !== (id.v ?? '') || (v.url ?? '') !== (id.url ?? '') || (v.store ?? '') !== (id.store ?? '') || (v.cat ?? '') !== (id.cat ?? '')) { id.v = v.v; id.url = v.url; if (v.store !== undefined) id.store = v.store; if (v.cat !== undefined) id.cat = v.cat; idsCarried++; } vByK.delete(id.k); } }
      for (const v of vByK.values()) { a.ids.push(v); idsCarried++; }            // lignes ajoutees main
    }
    const haveAcc = new Set(model.cloud.accounts.map(a => a.id));
    for (const o of pa.values()) if (!haveAcc.has(o.id)) {                        // compte ajoute au navigateur
      model.cloud.accounts.push(o); accCarried++;
      N('acc:' + o.id, o.provider || o.id, 'account', `${o.identity || ''}${o.note ? ' — ' + o.note : ''}`);
    }
    if (accCarried) model.kpis.accounts = model.cloud.accounts.length;
    if (Array.isArray(prev.logins) && prev.logins.length) model.logins = prev.logins;   // coffre identifiants = manuel
    if (Array.isArray(prev.deviceArchive)) model.deviceArchive = prev.deviceArchive;     // appareils archivés = manuel
    if (!model.accountRegistry && prev.accountRegistry) { model.accountRegistry = prev.accountRegistry; model.kpis.externalAccounts = prev.accountRegistry.total || (prev.accountRegistry.accounts || []).length; }  // annuaire Bitwarden reporté si fichier local absent
    if (!model.vaultConnection && prev.vaultConnection) model.vaultConnection = prev.vaultConnection;   // état coffre connecté reporté si fichier local absent
    const logCarried = (model.logins || []).length;
    console.log(`  merge coffre : ${carried} secret(s) + ${idsCarried} id(s) edite/ajoute + ${accCarried} compte(s) + ${logCarried} identifiant(s) reportes`);
  } catch (e) {
    console.error(`✗ ÉCHEC du merge du coffre précédent : ${e.message}`);
    if (wasEncrypted) {
      console.error('  Le coffre précédent est CHIFFRÉ mais indéchiffrable (passphrase erronée ?).');
    } else {
      console.error('  L\'index.html présent n\'est PAS un coffre chiffré exploitable (issu d\'un build --plain ?).');
      console.error('  La couche manuelle (logins, comptes, IDs, valeurs navigateur) vit dans le coffre CHIFFRÉ —');
      console.error('  régénérer par-dessus un index.html en clair l\'écraserait silencieusement.');
      console.error('  → Récupère d\'abord le coffre serveur : ./pull-karto.sh, puis relance.');
    }
    console.error('  ABANDON pour ne PAS écraser la couche manuelle. (--no-merge pour forcer, perte assumée.)');
    process.exit(1);
  }
}

/* ---------- rendu ---------- */
const tpl = readFileSync(join(__dir, 'template.html'), 'utf8');
let payload, mode;
if (PLAIN) {
  payload = JSON.stringify(model); mode = 'plain';
} else {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iter = 600000;
  const km = await crypto.subtle.importKey('raw', enc.encode(PASS), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(model))));
  const b64 = u => Buffer.from(u).toString('base64');
  payload = JSON.stringify({ salt: b64(salt), iv: b64(iv), ct: b64(ct), iter }); mode = 'enc';
}
// core = template avec le mode résolu, mais marqueurs __PAYLOAD__ / __SELF__ intacts.
// On encode core en base64 (selfB64) pour que la page puisse se ré-écrire elle-même
// (saisie de clés -> re-chiffrement -> téléchargement d'un index.html neuf), sans serveur.
const core = tpl.replace(/__MODE__/g, mode);
const selfB64 = Buffer.from(core, 'utf8').toString('base64');
const out = core.split('__PAYLOAD__').join(payload).split('__SELF__').join(selfB64);
writeFileSync(join(__dir, 'index.html'), out);

const kb = (out.length / 1024).toFixed(0);
console.log(`✓ index.html écrit (${kb} Ko, mode ${mode})`);
console.log(`  ${model.kpis.projects} projets · ${nodes.length} nœuds / ${edges.length} liens · ${secrets.length} secrets recensés · ${disk.exposures.length} exposures`);
if (WITH_SECRETS) console.log(`  ${filled}/${secrets.length} valeurs intégrées (lues en RAM depuis les .env locaux, chiffrées au repos)`);
