// karto-write.mjs — couche d'ÉCRITURE de karto (curation par l'IA, sans toucher au code).
// Mute UNIQUEMENT les data/*.json (la donnée), jamais le code. Validation + backup + merge
// idempotent. JAMAIS de valeur de secret (refus si motif token). Zéro dépendance.
//
// Après écriture : `node karto-db.mjs build` pour rafraîchir la base requêtable (le visuel
// chiffré reste derrière la passphrase — barrière humaine).
//
// Usage CLI : node karto-write.mjs <op> '<json>'   (op = add-account|set-attribut|add-dependance|add-exposure|add-data-asset|add-project)
// Ou importé par karto-mcp.mjs (outils opt-in KARTO_MCP_WRITE=1).

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const dp = f => join(__dir, 'data', f);
const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const canon = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
// Motifs de credential connus (défense en profondeur — la vraie barrière reste le coffre chiffré + la revue de diff).
const TOKEN = /(sk-[a-z0-9]{8}|sk_(live|test)_[a-z0-9]{8}|sbp_[a-z0-9]{8}|whsec_[a-z0-9]{8}|re_[a-z0-9]{8}|rk_(live|test)_[a-z0-9]{8}|ghp_[a-z0-9]{8}|gho_[a-z0-9]{8}|ghs_[a-z0-9]{8}|github_pat_[a-z0-9_]{20}|glpat-[a-z0-9_-]{16}|xox[baprs]-[a-z0-9-]{10}|AKIA[0-9A-Z]{12}|AIza[0-9A-Za-z_-]{30}|ya29\.[a-z0-9_-]{20}|npm_[a-z0-9]{30}|dop_v1_[a-f0-9]{32}|shpat_[a-f0-9]{32}|eyJ[A-Za-z0-9_-]{20}|-----BEGIN[A-Z ]*PRIVATE KEY-----|hook\.[a-z0-9.]*make\.com\/[a-z0-9]{20}|[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@)/i;
// Blob opaque long (heuristique credential pour champs texte humains : 32+ caractères sans espace, classes mêlées).
const GENERIC = /(?=[A-Za-z0-9+/_=-]*[A-Z])(?=[A-Za-z0-9+/_=-]*[a-z])(?=[A-Za-z0-9+/_=-]*[0-9])[A-Za-z0-9+/_=-]{32,}/;

function load(f) { try { return JSON.parse(readFileSync(dp(f), 'utf8')); } catch { return null; } }
function save(f, obj) {
  const bd = join(__dir, 'data', '.bak'); try { mkdirSync(bd, { recursive: true }); } catch {}
  if (existsSync(dp(f))) { try { copyFileSync(dp(f), join(bd, f + '.' + Date.now())); } catch {} }
  writeFileSync(dp(f), JSON.stringify(obj, null, 2) + '\n');
}
const enums = () => { const m = (load('ea_inventory.json') || {})._meta || {}; return { type: m.types || [], criticite: m.criticite || [], cycle: m.cycle || [] }; };
// Aplatit récursivement (objets/arrays) en chaînes pour scanner TOUS les champs libres.
function flatStrings(v, out = []) {
  if (v == null) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) flatStrings(x, out);
  else if (typeof v === 'object') for (const x of Object.values(v)) flatStrings(x, out);
  return out;
}
const looksSecret = s => TOKEN.test(s) || GENERIC.test(s);
const noSecret = (...vals) => flatStrings(vals).some(looksSecret);
const SECRET_ERR = { error: 'refus : ce qui ressemble à un secret/credential ne va pas dans karto (seulement noms/emplacements)' };
// Réutilisés par karto-ingest.mjs (ingestion en masse par source) — même garde, même backup.
export { load as loadData, save as saveData, noSecret, SECRET_ERR, slug as slugify, canon as canonize };
// Motifs exportés pour REDACTION (vps-collect : caviarder un token embarqué dans une ligne de cron
// plutôt que refuser toute la collecte).
export { TOKEN, GENERIC };

/* ── add-account → cloud_inventory.json accounts[] ── */
export function addAccount(o = {}) {
  if (!o.provider) return { error: 'champ requis manquant : provider' };
  if (noSecret(o.note, o.identity, o.email, o.url, o.plan, o.id, o.branchement)) return SECRET_ERR;
  if (o.nature && !['outil-ia', 'saas'].includes(o.nature)) return { error: "nature parmi : outil-ia (branché, invocable en workflow IA : API/MCP/webhook/CLI) | saas (compte utilisé à la main, sans branchement)" };
  const c = load('cloud_inventory.json'); if (!c) return { error: 'cloud_inventory.json illisible' };
  c.accounts = c.accounts || [];
  const id = slug(o.id || o.provider);
  const row = { id, provider: o.provider, identity: o.identity || null, email: o.email || null, url: o.url || null, plan: o.plan || null, category: o.category || null, nature: o.nature || null, branchement: o.branchement || null, bu: o.bu || null, note: o.note || null };
  Object.keys(row).forEach(k => row[k] == null && delete row[k]);
  const i = c.accounts.findIndex(a => slug(a.id || a.provider) === id);
  let action; if (i >= 0) { c.accounts[i] = { ...c.accounts[i], ...row }; action = 'updated'; } else { c.accounts.push(row); action = 'created'; }
  // favicon : ajoute le domaine vendeur s'il manque et qu'une URL est fournie
  if (o.url) { c.vendorDomains = c.vendorDomains || {}; const host = String(o.url).replace(/^https?:\/\//, '').split('/')[0]; if (!c.vendorDomains[o.provider]) c.vendorDomains[o.provider] = host; }
  save('cloud_inventory.json', c);
  return { ok: true, action, file: 'cloud_inventory.json', id };
}

/* ── set-attribut → ea_inventory.json assets[] (criticité/cycle/coût/statut/domaine/type/vendor) ── */
export function setAttribut(o = {}) {
  const { name, key } = o; let { value } = o;
  if (!name || !key) return { error: 'champs requis : name, key, value' };
  const allowed = ['criticite', 'cycle', 'cout', 'statut', 'domaine', 'type', 'vendor', 'hosting'];
  if (!allowed.includes(key)) return { error: `clé non éditable: ${key}. Autorisées: ${allowed.join(', ')}` };
  if (key !== 'cout' && noSecret(value)) return SECRET_ERR;
  const en = enums();
  if (key === 'cout') { value = Number(value); if (Number.isNaN(value)) return { error: 'cout doit être un nombre' }; }
  if (['criticite', 'cycle', 'type'].includes(key) && en[key].length && !en[key].includes(value)) return { error: `${key} doit être parmi: ${en[key].join(', ')}` };
  const e = load('ea_inventory.json'); if (!e) return { error: 'ea_inventory.json illisible' };
  e.assets = e.assets || [];
  let a = e.assets.find(x => canon(x.name) === canon(name));
  let action;
  if (!a) { a = { name, type: key === 'type' ? value : 'Application', domaine: '(à classer)', criticite: 'Moyenne', cycle: 'Tolérer', statut: 'Actif', cout: 0, owner: 'Owner', links: [], rel: [] }; e.assets.push(a); action = 'created'; }
  else action = 'updated';
  a[key] = value;
  save('ea_inventory.json', e);
  return { ok: true, action, file: 'ea_inventory.json', target: a.name, key, value };
}

/* ── add-dependance → dependencies.json deps[] (from dépend de to) ── */
export function addDependance(o = {}) {
  const { from, to } = o; if (!from || !to) return { error: 'champs requis : from, to' };
  if (noSecret(from, to, o.rel, o.note)) return SECRET_ERR;
  const d = load('dependencies.json') || { deps: [] }; d.deps = d.deps || [];
  if (d.deps.some(x => canon(x.from) === canon(from) && canon(x.to) === canon(to))) return { ok: true, action: 'exists', file: 'dependencies.json' };
  d.deps.push({ from, to, ...(o.rel ? { rel: o.rel } : {}), ...(o.note ? { note: o.note } : {}) });
  save('dependencies.json', d);
  return { ok: true, action: 'created', file: 'dependencies.json', from, to };
}

/* ── add-exposure → disk_inventory.json exposures[] ── */
export function addExposure(o = {}) {
  if (!o.what) return { error: 'champ requis : what' };
  if (noSecret(o.what, o.where, o.recommendation, o.owner)) return SECRET_ERR;
  const sev = ['critical', 'high', 'medium', 'low'];
  if (o.severity && !sev.includes(o.severity)) return { error: `severity parmi: ${sev.join(', ')}` };
  const st = ['open', 'mitigated', 'closed'];
  if (o.status && !st.includes(o.status)) return { error: `status parmi: ${st.join(', ')}` };
  const d = load('disk_inventory.json'); if (!d) return { error: 'disk_inventory.json illisible' };
  d.exposures = d.exposures || [];
  d.exposures.push({ severity: o.severity || 'medium', what: o.what, where: o.where || '', recommendation: o.recommendation || '', status: o.status || 'open', owner: o.owner || 'Owner', due: o.due || null });
  save('disk_inventory.json', d);
  return { ok: true, action: 'created', file: 'disk_inventory.json' };
}

/* ── add-data-asset → data_assets.json assets[] ── */
export function addDataAsset(o = {}) {
  if (!o.label) return { error: 'champ requis : label' };
  if (noSecret(o.label, o.sensibilite, o.emplacements, o.restauration)) return SECRET_ERR;
  const d = load('data_assets.json') || { canaux: {}, assets: [] }; d.assets = d.assets || [];
  const id = slug(o.id || o.label);
  if (d.assets.some(a => slug(a.id || a.label) === id)) return { ok: true, action: 'exists', file: 'data_assets.json', id };
  d.assets.push({ id, label: o.label, sensibilite: o.sensibilite || 'interne', emplacements: o.emplacements || [], restauration: o.restauration || [] });
  save('data_assets.json', d);
  return { ok: true, action: 'created', file: 'data_assets.json', id };
}

/* ── add-project → disk_inventory.json projects[] ── */
export function addProject(o = {}) {
  if (!o.name) return { error: 'champ requis : name' };
  if (noSecret(o.name, o.hosting, o.deployUrl, o.path, o.stack, o.integrations, o.notes)) return SECRET_ERR;
  const d = load('disk_inventory.json'); if (!d) return { error: 'disk_inventory.json illisible' };
  d.projects = d.projects || [];
  const i = d.projects.findIndex(p => canon(p.name) === canon(o.name));
  const row = { name: o.name, hosting: o.hosting || '', deployUrl: o.deployUrl || '', path: o.path || '', stack: o.stack || [], integrations: o.integrations || [], notes: o.notes || '' };
  let action; if (i >= 0) { d.projects[i] = { ...d.projects[i], ...row }; action = 'updated'; } else { d.projects.push(row); action = 'created'; }
  save('disk_inventory.json', d);
  return { ok: true, action, file: 'disk_inventory.json', name: o.name };
}

export const OPS = { 'add-account': addAccount, 'set-attribut': setAttribut, 'add-dependance': addDependance, 'add-exposure': addExposure, 'add-data-asset': addDataAsset, 'add-project': addProject };

// CLI : node karto-write.mjs <op> '<json>'
if (process.argv[1] && process.argv[1].endsWith('karto-write.mjs')) {
  const [op, payload] = process.argv.slice(2);
  const fn = OPS[op];
  if (!fn) { console.error('ops : ' + Object.keys(OPS).join(' | ')); process.exit(1); }
  let arg = {}; try { arg = payload ? JSON.parse(payload) : {}; } catch { console.error('JSON invalide'); process.exit(1); }
  const r = fn(arg);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.error ? 1 : 0);
}
