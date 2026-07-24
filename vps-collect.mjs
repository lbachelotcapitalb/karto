#!/usr/bin/env node
// vps-collect.mjs — collecteur du VPS (le pendant serveur de karto-collect.mjs).
// UNE connexion SSH (alias softcode karto.config.json > vps.sshAlias), commandes LECTURE
// SEULE côté user SSH (softcode vps.user) : crontab, services/timers systemd, /opt, home,
// /srv. Le crontab ROOT n'est pas lisible sans sudo → tenté en sudo -n, sinon marqué
// indisponible (l'export root viendra de l'agent de veille sécurité, s'il y en a un).
//
// Sécurité : chaque ligne collectée passe par redact() — un token embarqué dans une ligne
// de cron est CAVIARDÉ, jamais écrit dans data/. Topologie/noms uniquement.
//
//   node vps-collect.mjs           → data/vps_inventory.json
//   node vps-collect.mjs --print   → stdout seulement

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOKEN, GENERIC } from './karto-write.mjs';
import { touchSource } from './karto-sources.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PRINT = process.argv.includes('--print');
const cfg = (() => { try { return JSON.parse(readFileSync(join(__dir, 'karto.config.json'), 'utf8')); } catch { return {}; } })();
const V = cfg.vps || {};
const ALIAS = V.sshAlias || 'vps';
const IGNORE = new RegExp(V.ignoreServices || '^systemd-');
// Utilisateur SSH du VPS : softcode. Il servait de littéral à trois endroits (marqueur de section,
// libellé du propriétaire de crontab, filtre d'hôte de la veille) — donc la collecte d'un tiers
// se rangeait sous le nom d'utilisateur de l'auteur de karto.
const VUSER = V.user || 'root';
const VEILLE_HOST = V.veilleHost || ('vps-' + VUSER);
const SOURCE_ID = V.sourceId || 'vps';
// Journal d'un agent de veille sécurité tournant sur le VPS (facultatif) : chemin et id de source
// viennent de la config. Sans configuration, la section est simplement vide — pas d'outil imposé.
const VEILLE_LOG = V.veilleLog || '';
const VEILLE_SOURCE = V.veilleSourceId || 'veille';

const redact = s => String(s).replace(new RegExp(TOKEN.source, 'gi'), '<redacted>').replace(new RegExp(GENERIC.source, 'g'), '<redacted>');

// UNE session SSH, sections délimitées — chaque commande est en lecture seule.
const SCRIPT = `
echo @@CRON_USER@@;   crontab -l 2>/dev/null
echo @@CRON_ROOT@@;   sudo -n crontab -l -u root 2>/dev/null || echo "__UNAVAILABLE__"
echo @@SERVICES@@;    systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null | awk '{print $1}'
echo @@TIMERS@@;      systemctl list-timers --all --no-legend --no-pager 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i ~ /\\.timer$/) print $i}'
echo @@OPT@@;         ls -1 /opt 2>/dev/null
echo @@HOME@@;        ls -1d ~/*/ 2>/dev/null
echo @@SRV@@;         ls -1 /srv 2>/dev/null
echo @@CADDY@@;       grep -hE '^[a-z0-9][a-z0-9*.:-]*([, ][a-z0-9*.:-]+)*\\s*\\{\\s*$' /etc/caddy/Caddyfile /etc/caddy/*.caddy 2>/dev/null | sed 's/{.*//'
echo @@HOST@@;        hostname; uname -sr; uptime -p 2>/dev/null
echo @@VEILLE@@;      ${VEILLE_LOG ? `tail -6 ${VEILLE_LOG} 2>/dev/null` : 'true'}
echo @@COSTS@@;       tail -60 ~/.config/cost-measure/reports.log 2>/dev/null
echo @@END@@
`;

let raw;
try { raw = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ALIAS, SCRIPT], { encoding: 'utf8', timeout: 60000 }); }
catch (e) { console.error(`✗ SSH ${ALIAS} inaccessible : ${String(e.message || e).slice(0, 120)}`); process.exit(1); }

// découpe par sections
const sections = {};
let cur = null;
for (const line of raw.split('\n')) {
  const m = line.match(/^@@([A-Z_]+)@@$/);
  if (m) { cur = m[1]; sections[cur] = []; continue; }
  if (cur && line.trim() !== '') sections[cur].push(redact(line));
}
const sec = k => sections[k] || [];

// crontab → entrées structurées {schedule, command, user}
function parseCron(lines, user) {
  const out = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    if (/^[A-Z_]+=/.test(t)) continue;                       // variables d'env (déjà caviardées) — pas des jobs
    const m = t.match(/^(@\w+|(?:\S+\s+){4}\S+)\s+(.*)$/);   // @daily … | 5 champs cron
    if (m) out.push({ schedule: m[1], command: m[2], user });
  }
  return out;
}
const rootUnavailable = sec('CRON_ROOT').some(l => l.includes('__UNAVAILABLE__'));
const crons = [
  ...parseCron(sec('CRON_USER'), VUSER),
  ...(rootUnavailable ? [] : parseCron(sec('CRON_ROOT'), 'root')),
];

const services = sec('SERVICES').map(s => s.replace(/\.service$/, '')).filter(s => !IGNORE.test(s));
const timers = sec('TIMERS').map(s => s.replace(/\.timer$/, '')).filter(s => !IGNORE.test(s));
const caddySites = [...new Set(sec('CADDY').flatMap(l => l.split(/[, ]+/)).map(s => s.trim()).filter(s => s && s !== '{'))];

// journal de la veille sécurité (compteurs par run — le détail des findings reste sur son canal)
const veille = sec('VEILLE').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  .map(v => ({ ts: v.ts, host: v.host, findings: v.n, disk: v.disk }));

// coûts stack agentique (dernier rapport cost-measure — texte structuré, on parse le dernier bloc ══)
function parseCosts(lines) {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith('══')) { start = i; break; }
  if (start < 0) return null;
  const block = lines.slice(start);
  const out = { period: (block[0].match(/([0-9]{4}-[0-9]{2}(?:-[0-9]{2}T[0-9:.]+Z)?)/) || [])[1] || null, tokens: [], apis: [], fixed: [] };
  let mode = null;
  for (const l of block.slice(1)) {
    if (/Tokens Claude/i.test(l)) { mode = 'tokens'; continue; }
    if (/APIs à l'usage/i.test(l)) { mode = 'apis'; continue; }
    if (/Fixes mensuels/i.test(l)) { mode = 'fixed'; continue; }
    const m = l.match(/^\s{2,}(.+?)\s*:\s*(.+)$/);
    if (!m || m[1].startsWith('⚠') || /^Total/i.test(m[1])) continue;
    if (mode === 'tokens') {
      const t = m[2].match(/([\d.,\s]+[kM]?)\s*out\s*·\s*([\d.,\s]+[kM]?)\s*in\s*·\s*([\d.,\s]+[kM]?)\s*cache-read\s*·\s*(\d+)\s*sessions/);
      out.tokens.push({ name: m[1], out: t ? t[1].trim() : m[2], in: t ? t[2].trim() : null, cacheRead: t ? t[3].trim() : null, sessions: t ? Number(t[4]) : null });
    } else if (mode === 'apis') out.apis.push({ name: m[1], detail: m[2] });
    else if (mode === 'fixed') out.fixed.push({ name: m[1], detail: m[2] });
  }
  return (out.tokens.length || out.apis.length || out.fixed.length) ? out : null;
}
const costs = parseCosts(sec('COSTS'));

const inv = {
  _meta: {
    title: 'Inventaire VPS (auto-collecté) — vps-collect.mjs',
    host: V.hostEntity || 'VPS',
    generatedAt: new Date().toISOString(),
    policy: `Lecture seule via SSH (user ${VUSER}). Noms/topologie uniquement, tokens caviardés.`,
    rootCrontab: rootUnavailable ? 'indisponible (pas de sudo sans mdp — export via veille en phase 3)' : 'collecté',
  },
  hostInfo: sec('HOST'),
  crons,
  services,
  timers,
  optDirs: sec('OPT'),
  homeDirs: sec('HOME').map(d => d.replace(/\/$/, '').split('/').pop()),
  srvSites: sec('SRV'),
  caddySites,
  veille,
  costs,
};

if (PRINT) { console.log(JSON.stringify(inv, null, 2)); process.exit(0); }
writeFileSync(join(__dir, 'data', 'vps_inventory.json'), JSON.stringify(inv, null, 2) + '\n');
touchSource(__dir, SOURCE_ID, { status: 'ok', collector: 'node vps-collect.mjs', ...(rootUnavailable ? { note: 'crontab root non couvert (export via veille, phase 3)' } : {}) });
// le dernier run de la veille = run réel de l'agent de veille (physiologie)
const lastVeille = veille.filter(v => v.host === VEILLE_HOST).pop();
if (lastVeille) {
  const { ingest } = await import('./karto-ingest.mjs');
  ingest('runs', { runs: [{ key: 'veille agentique', last_run: new Date(lastVeille.ts).toISOString(), status: 'ok', note: `${lastVeille.findings} finding(s) au dernier passage`, source: 'vps-cron' }] });
  touchSource(__dir, VEILLE_SOURCE, { status: 'ok', collector: 'node vps-collect.mjs', note: 'compteurs + runs seulement — le détail des findings reste sur son canal ; une exposition durable se recense via karto_add_exposure' });
}
console.log(`✓ data/vps_inventory.json — ${crons.length} crons (root: ${rootUnavailable ? 'indispo' : 'ok'}) · ${services.length} services · ${timers.length} timers · ${caddySites.length} sites Caddy · ${inv.srvSites.length} /srv`);
