#!/usr/bin/env node
// claude-usage.mjs — Qui a tourné, quand, et pour combien de tokens.
//
// POURQUOI CE SCRIPT : `cost_measure.mjs` (VPS, mensuel) ne lit que ~/.claude/projects du VPS
// — 216 transcripts. Le Mac en porte 1000. La moitié de l'usage agentique était donc invisible.
// Ici on lit les DEUX machines. Rien de neuf n'est installé : les transcripts sont déjà écrits
// sur disque par Claude Code à chaque session, avec `usage` (tokens in/out/cache) et `model`
// par message. Aucun collecteur, aucun daemon, aucun exporter à faire tourner en continu.
//
// LECTURE SEULE, zéro dépendance npm, à la demande (ou accroché à la sync hebdo karto).
// Le VPS est agrégé À DISTANCE : ce fichier s'y copie dans /tmp le temps d'un run et repart.
//
// Usage :
//   node claude-usage.mjs                 → tableau des 30 derniers jours (Mac + VPS)
//   node claude-usage.mjs --days=90       → autre fenêtre
//   node claude-usage.mjs --local         → cette machine seulement, JSON sur stdout (mode ssh)
//   node claude-usage.mjs --no-vps        → Mac seulement
//
// Sortie persistée : data/claude_usage.json (lu par build.mjs → model.claudeUsage).

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ARGV = process.argv.slice(2);
const has = f => ARGV.includes(f);
const opt = (n, d) => { const m = ARGV.find(a => a.startsWith(`--${n}=`)); return m ? m.split('=')[1] : d; };
const DAYS = Number(opt('days', 30));
const SINCE = Date.now() - DAYS * 864e5;

// ─── Regroupement des slugs de projet Claude → agent métier ───
// Un agent = plusieurs répertoires de travail (repo, worktree, fork). La table est SOFTCODÉE dans
// karto.config.json > claudeUsage.groups : elle nomme des projets, donc elle appartient à la
// config du propriétaire, pas au code (make-public la vide dans la projection publique).
// Ce qui ne matche rien reste sous son propre slug — jamais rangé de force.
//
// Le regroupement s'applique à la FUSION, jamais au scan : en mode `--local` ce fichier tourne
// seul dans /tmp sur le VPS, sans karto.config.json. Grouper au scan y rendrait les clés
// distantes incompatibles avec celles du Mac, et la fusion recréerait deux entrées par agent.
const GROUPS = (() => {
  try {
    const cfg = JSON.parse(readFileSync(join(__dir, 'karto.config.json'), 'utf8'));
    return (cfg.claudeUsage?.groups || []).map(g => [new RegExp(g.match, 'i'), g.label]);
  } catch { return []; }
})();
const groupOf = slug => (GROUPS.find(([re]) => re.test(slug)) || [null, slug])[1];

/* ══════════════════ agrégation d'une machine ══════════════════ */
// On ne JSON.parse que les lignes qui portent « "usage" » : un transcript est majoritairement
// du texte d'échange, et parser 2 Go pour en extraire des compteurs coûterait une minute pour rien.
async function scanLocal() {
  const root = join(homedir(), '.claude/projects');
  const out = {};
  if (!existsSync(root)) return out;
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    let files;
    try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const p = join(dir, f);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.mtimeMs < SINCE) continue;                 // hors fenêtre : on n'ouvre même pas
      const a = out[slug] || (out[slug] = { sessions: 0, input: 0, output: 0, cache: 0, models: {}, last: 0 });
      a.sessions++;
      if (st.mtimeMs > a.last) a.last = st.mtimeMs;
      const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.includes('"usage"')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const u = j?.message?.usage; if (!u) continue;
        a.input  += u.input_tokens || 0;
        a.output += u.output_tokens || 0;
        a.cache  += (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        const m = j?.message?.model; if (m) a.models[m] = (a.models[m] || 0) + 1;
      }
    }
  }
  return out;
}

/* ══════════════════ la même chose sur le VPS ══════════════════ */
// Le script s'auto-dépose dans /tmp le temps du run : rien de permanent n'est installé là-bas,
// et la version exécutée est TOUJOURS celle d'ici (pas de copie qui dérive en silence).
function scanVps() {
  const self = readFileSync(fileURLToPath(import.meta.url));
  try {
    execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'vps',
      'cat > /tmp/claude-usage.mjs'], { input: self, timeout: 30000 });
    const out = execFileSync('ssh', ['-o', 'BatchMode=yes', 'vps',
      `node /tmp/claude-usage.mjs --local --days=${DAYS}; rm -f /tmp/claude-usage.mjs`],
      { encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(out.slice(out.indexOf('{')));
  } catch (e) {
    console.error(`  ⚠ VPS non agrégé (${String(e.message).split('\n')[0]}) — chiffres Mac seulement`);
    return null;
  }
}

/* ══════════════════ orchestration ══════════════════ */
const local = await scanLocal();

if (has('--local')) { console.log(JSON.stringify(local)); process.exit(0); }

const vps = has('--no-vps') ? null : scanVps();

// Fusion : un même agent tourne des deux côtés (Communication MonProjet est sur le VPS,
// mais ses sessions de mise au point sont sur le Mac). On additionne, en gardant la trace
// de la machine — sinon un agent muet sur le VPS passerait pour vivant grâce au Mac.
const merged = {};
const fold = (src, machine) => {
  for (const [slug, v] of Object.entries(src || {})) {
    const k = groupOf(slug);                            // regroupement ICI : le scan rend des slugs bruts
    const a = merged[k] || (merged[k] = { sessions: 0, input: 0, output: 0, cache: 0, models: {}, last: 0, machines: [] });
    a.sessions += v.sessions; a.input += v.input; a.output += v.output; a.cache += v.cache;
    if (v.last > a.last) a.last = v.last;
    for (const [m, n] of Object.entries(v.models || {})) a.models[m] = (a.models[m] || 0) + n;
    if (!a.machines.includes(machine)) a.machines.push(machine);
  }
};
fold(local, hostname().replace(/\.local$/, ''));
fold(vps, 'vps');

const rows = Object.entries(merged)
  .map(([agent, v]) => ({ agent, ...v, total: v.input + v.output + v.cache }))
  .sort((a, b) => b.total - a.total);

/* ── tableau ── */
const fmt = n => n >= 1e9 ? (n / 1e9).toFixed(1) + ' G' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' k' : String(n);
const age = ms => { const d = (Date.now() - ms) / 864e5; return d < 1 ? "aujourd'hui" : `il y a ${Math.round(d)} j`; };
// Un slug non regroupé (session ssh jetable, /tmp) porte son nom brut, parfois très long :
// on l'écourte à l'affichage seulement — le JSON garde l'identifiant entier.
const short = s => s.length > 34 ? s.slice(0, 31) + '…' : s;
const w = Math.max(24, ...rows.map(r => short(r.agent).length));
console.log(`\n▸ Usage Claude sur ${DAYS} j — ${rows.length} agent(s), ${rows.reduce((s, r) => s + r.sessions, 0)} session(s)\n`);
console.log('  ' + 'AGENT'.padEnd(w) + '  SESS.   IN     OUT    CACHE   DERNIER      MACHINE');
for (const r of rows) {
  console.log('  ' + short(r.agent).padEnd(w)
    + '  ' + String(r.sessions).padStart(5)
    + '  ' + fmt(r.input).padStart(6) + '  ' + fmt(r.output).padStart(6) + '  ' + fmt(r.cache).padStart(6)
    + '  ' + age(r.last).padEnd(12) + ' ' + r.machines.join('+'));
}

/* ── persistance : lu par build.mjs → model.claudeUsage ── */
const payload = {
  _doc: "Usage Claude Code par agent, agrégé depuis les transcripts déjà présents sur disque (Mac + VPS). "
      + "Sur abonnement Max, les tokens sont une PART D'USAGE, pas un prix — aucun tarif n'est appliqué. "
      + "Produit par claude-usage.mjs, lecture seule, à la demande.",
  generated: new Date().toISOString(),
  window_days: DAYS,
  vps_included: vps != null,
  agents: rows.map(r => ({
    agent: r.agent, sessions: r.sessions, input: r.input, output: r.output, cache: r.cache,
    last_run: new Date(r.last).toISOString(),
    models: Object.keys(r.models).sort((a, b) => r.models[b] - r.models[a]),
    machines: r.machines,
  })),
};
writeFileSync(join(__dir, 'data/claude_usage.json'), JSON.stringify(payload, null, 2) + '\n');

// Fraîcheur de la source (karto_discover / dimension « Fraîcheur » du diagnostic).
// Import DYNAMIQUE et non bloquant, à dessein : en mode `--local` ce fichier tourne seul dans
// /tmp sur le VPS, où karto-sources.mjs n'existe pas — un import statique casserait l'agrégation
// distante. Ce chemin n'est atteint que sur la machine du dépôt, mais on ne parie pas dessus.
try {
  const { touchSource } = await import('./karto-sources.mjs');
  touchSource(__dir, 'claude-usage', {
    status: 'ok',
    note: payload._doc + (vps ? '' : ' ⚠ dernier passage sans le VPS (injoignable) : chiffres Mac seulement.'),
  });
} catch { /* hors dépôt : la sortie JSON reste valide, seule la fraîcheur n'est pas marquée */ }

console.log(`\n✓ data/claude_usage.json${vps ? '' : ' (Mac seulement — VPS injoignable)'}`);
