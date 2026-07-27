#!/usr/bin/env node
// runs-collect.mjs — collecte l'ÉTAT RÉEL D'EXÉCUTION des automatisations (la « physiologie »).
//
// Principe : on ne change RIEN au fonctionnement des automatisations, on lit ce qu'elles
// écrivent déjà. Trois gisements, tous présents sur le système avant ce collecteur :
//
//   gha       GitHub Actions — dernier run par workflow (gh api).
//   launchd   agents Mac — `launchctl list <label>` expose LastExitStatus ; le plist donne le
//             journal (StandardOutPath) dont la date de modification = dernier passage.
//             Un plist présent que launchd ne connaît pas (« Could not find service ») est
//             une PANNE : l'agent est réputé actif et ne tourne pas.
//   vps-cron  crons du VPS qui REDIRIGENT déjà leur sortie (« >> fichier ») — la date de
//             modification du journal donne le dernier passage, et l'écart au planning
//             attendu donne « stale » (le cron ne passe plus, personne ne le voit).
//             Les crons SANS redirection envoient leur sortie au courrier cron, c'est-à-dire
//             nulle part : ils sont hors de portée tant qu'on ne leur en ajoute pas une.
//
// Sortie : merge dans data/runs_summary.json via karto-ingest (clé = nom de l'entité karto)
// → attrs.lastRun / lastStatus / log au prochain `node karto-db.mjs build`.
//
//   node runs-collect.mjs                 → collecte les 3 gisements + merge + estampille
//   node runs-collect.mjs --print         → montre ce qui serait mergé, n'écrit rien
//   node runs-collect.mjs --only=launchd  → un seul gisement (gha|launchd|vps-cron, séparés par ,)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { ingest } from './karto-ingest.mjs';
import { touchSource } from './karto-sources.mjs';
import { cronEntityName } from './karto-naming.mjs';
import { lastFires } from './cron-schedule.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PRINT = process.argv.includes('--print');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || '';
const want = g => !ONLY || ONLY.split(',').map(s => s.trim()).includes(g);
const load = f => { try { return JSON.parse(readFileSync(join(__dir, 'data', f), 'utf8')); } catch { return null; } };
const iso = ms => new Date(ms).toISOString();
const warn = m => console.warn('  ⚠ ' + m);

const runs = [];

/* ══════════════════ 1. GitHub Actions ══════════════════ */
function collectGha() {
  const cgh = (load('cloud_inventory.json') || {}).github || {};
  const fullOf = new Map((cgh.repos || []).map(r => [r.name.split('/').pop().toLowerCase(), r.name]));
  const repos = [...new Set((cgh.actions || []).map(a => a.repo))];
  let n = 0;
  for (const short of repos) {
    const full = fullOf.get(String(short).toLowerCase());
    if (!full) { warn(`repo introuvable dans cloud.github.repos : ${short}`); continue; }
    let data;
    try { data = JSON.parse(execFileSync('gh', ['api', `repos/${full}/actions/runs?per_page=40`], { encoding: 'utf8', timeout: 30000 })); }
    catch (e) { warn(`gh api ${full} : ${String(e.message || e).slice(0, 80)}`); continue; }
    const latest = new Map();   // workflow name -> run le plus récent
    for (const r of (data.workflow_runs || [])) if (!latest.has(r.name)) latest.set(r.name, r);
    for (const [wf, r] of latest) {
      const dur = r.run_started_at && r.updated_at ? Math.round((new Date(r.updated_at) - new Date(r.run_started_at)) / 1000) : undefined;
      runs.push({
        key: `gha ${short} · ${wf}`,
        last_run: r.updated_at,
        status: r.conclusion === 'success' ? 'ok' : (r.status === 'in_progress' || r.status === 'queued') ? 'ok' : 'fail',
        ...(dur != null ? { duration_s: dur } : {}),
        note: r.conclusion || r.status,
        source: 'gha'
      });
      n++;
    }
  }
  console.log(`▸ gha      : ${n} workflow(s)`);
}

/* ══════════════════ 2. LaunchAgents Mac ══════════════════ */
// mtime d'un fichier, ou null s'il n'existe pas / n'est pas lisible.
const mtime = p => { try { return statSync(p).mtimeMs; } catch { return null; } };

function plistOf(file) {
  try { return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8', timeout: 10000 })); }
  catch { return null; }
}

// `launchctl list <label>` — sortie en syntaxe plist ancienne, pas en JSON.
// Échec de la commande = launchd ne connaît pas ce label (agent non chargé).
function launchctlInfo(label) {
  let out;
  try { out = execFileSync('launchctl', ['list', label], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return { loaded: false }; }
  const num = k => { const m = out.match(new RegExp(`"${k}"\\s*=\\s*(-?\\d+)`)); return m ? Number(m[1]) : null; };
  return { loaded: true, exit: num('LastExitStatus'), pid: num('PID') };
}

function collectLaunchd() {
  const dir = join(homedir(), 'Library/LaunchAgents');
  let files;
  try { files = readdirSync(dir); } catch { warn(`${dir} illisible`); return; }
  // Un plist désactivé (« .plist.disabled », « .retired-… ») est une pause VOULUE : l'inclure
  // aurait affiché en rouge des agents que Owner a lui-même arrêtés.
  const active = files.filter(f => f.endsWith('.plist'));
  const parked = files.filter(f => f.includes('.plist.') && !f.endsWith('.plist'));
  // Intention déclarée par la carte : étiquette launchd → enabled. Sert à ne pas crier au feu
  // sur un agent que Owner n'utilise volontairement pas en mode automatique.
  const declared = new Map();
  for (const a of ((load('disk_inventory.json') || {}).systemAutomation || []))
    if (typeof a.enabled === 'boolean') declared.set(a.name, a.enabled);
  let n = 0, ko = 0;
  for (const f of active) {
    const pl = plistOf(join(dir, f));
    const label = (pl && pl.Label) || f.replace(/\.plist$/, '');
    const info = launchctlInfo(label);
    const log = (pl && (pl.StandardOutPath || pl.StandardErrorPath)) || null;
    const at = log ? mtime(log) : null;

    let status, note;
    if (!info.loaded) {
      // Un plist non chargé n'est une panne QUE si la carte le déclare actif. Certains agents
      // existent sans être le mode d'usage : le surveillant de montage vidéo, par exemple, se
      // déclenche à la demande de Owner (précisé le 25/07/2026) — le signaler en rouge à chaque
      // passage aurait été une fausse alerte permanente. L'intention vit dans la carte, l'état
      // vient du système : l'écart n'est un défaut que si l'intention dit « ça doit tourner ».
      if (declared.get(label) === false) {
        status = 'ok';
        note = 'non chargé dans launchd — conforme à la carte, qui déclare cette tâche inactive (déclenchement manuel)';
      } else {
        status = 'fail';
        note = 'plist présent mais launchd ne connaît pas le service (« Could not find service ») — la carte le déclare actif et il ne tourne pas';
      }
    } else if (info.exit == null) {
      if (info.pid != null) { status = 'ok'; note = `en cours (PID ${info.pid})`; }
      else { status = 'stale'; note = 'chargé mais aucun passage enregistré depuis le dernier démarrage'; }
    } else if (info.exit === 0) {
      status = 'ok'; note = 'LastExitStatus=0';
    } else {
      status = 'fail';
      // launchd rapporte le statut wait(2) : 256 = code de sortie 1.
      note = `LastExitStatus=${info.exit}` + (info.exit % 256 === 0 ? ` (code de sortie ${info.exit / 256})` : '');
    }
    if (status !== 'ok') ko++;
    runs.push({ key: label, status, ...(at ? { last_run: iso(at) } : {}), note, ...(log ? { log } : {}), source: 'launchd' });
    n++;
  }
  console.log(`▸ launchd  : ${n} agent(s) actif(s) — ${ko} en défaut · ${parked.length} plist(s) désactivé(s) ignoré(s)`);
}

/* ══════════════════ 3. Crons VPS qui redirigent déjà ══════════════════ */
// Cible de redirection d'une ligne de shell : « >> fic », « > fic », « &> fic ».
// « 2>&1 » n'est pas une cible (on écarte tout ce qui commence par &).
function redirectTarget(cmd, home) {
  const re = /(?:^|\s)(?:\d*&?>>?|&>>?)\s*("[^"]+"|'[^']+'|\S+)/g;
  let m;
  while ((m = re.exec(String(cmd || '')))) {
    let t = m[1].replace(/^["']|["']$/g, '');
    if (t.startsWith('&')) continue;                      // 2>&1
    if (t === '/dev/null') return null;                   // sortie jetée : rien à observer
    t = t.replace(/^\$HOME\b/, home).replace(/^~(?=\/)/, home);
    if (!t.startsWith('/')) continue;                     // chemin relatif : dépend du cd, non résoluble ici
    if (t.includes('<redacted>')) continue;               // caviardé à la collecte : pas de chemin réel
    return t;
  }
  return null;
}

// L'évaluation du planning cron vit dans cron-schedule.mjs : elle est partagée avec la veille
// ta veille de sécurité qui tourne SUR le VPS (ROADMAP B5). Deux implémentations donneraient deux verdicts
// de santé différents pour le même cron — le tableau de bord et l'alerte doivent dire la même
// chose. Voir l'en-tête du module pour le choix « évaluer le planning » vs « période moyenne ».

function collectVpsCron() {
  const vi = load('vps_inventory.json');
  if (!vi || !Array.isArray(vi.crons)) { warn('data/vps_inventory.json absent — lance d\'abord node vps-collect.mjs'); return; }
  const cfg = (() => { try { return JSON.parse(readFileSync(join(__dir, 'karto.config.json'), 'utf8')); } catch { return {}; } })();
  const ALIAS = (cfg.vps || {}).sshAlias || 'vps';
  const homeOf = u => u === 'root' ? '/root' : `/home/${u}`;

  // Répertoire des battements par utilisateur — miroir de CRON_BEAT_DIR posé en tête de chaque
  // crontab (root n'écrit pas dans /home, ton-user n'écrit pas dans /var/log).
  const beatDirOf = u => u === 'root' ? '/var/log/cron-beats' : `${homeOf(u)}/.cron-beats`;

  const targets = [];
  let noRedirect = 0;
  for (const c of vi.crons) {
    const log = redirectTarget(c.command, homeOf(c.user));
    // Le nom du battement est lu DANS la ligne de cron (« ; /usr/local/bin/beat <nom> $? »)
    // plutôt que recalculé : recalculer un slug des deux côtés, c'est deux vérités qui
    // divergent au premier renommage.
    const bm = String(c.command || '').match(/\/usr\/local\/bin\/beat\s+(\S+)/);
    const beat = bm ? `${beatDirOf(c.user)}/${bm[1]}.beat` : null;
    if (!log && !beat) { noRedirect++; continue; }
    targets.push({ key: cronEntityName(c), log, beat, schedule: c.schedule, user: c.user });
  }
  if (!targets.length) { console.log('▸ vps-cron : aucun cron avec redirection'); return; }

  // UNE session SSH, lecture seule : horloge + fuseau du serveur, mtime de chaque journal, et
  // date de CRÉATION du dossier qui l'accueille. Ce dernier point n'est pas un détail : quand on
  // vient d'ajouter la redirection à un cron hebdomadaire, son journal est légitimement absent
  // jusqu'au prochain passage. Sans cette borne, la mise en place de l'observabilité déclenche
  // elle-même une volée de fausses alertes — et on apprend à ignorer le tableau de bord.
  const q = s => JSON.stringify(s);
  const dirs = [...new Set(targets.flatMap(t => [t.log, t.beat].filter(Boolean).map(p => p.replace(/\/[^/]+$/, ''))))];
  const script = 'date +%s\ndate +%z\n'
    + dirs.map(d => `printf 'D\\t%s\\t' ${q(d)}; stat -c '%W %Y' ${q(d)} 2>/dev/null || echo '0 0'`).join('\n') + '\n'
    + targets.filter(t => t.log).map(t => `printf 'L\\t%s\\t' ${q(t.log)}; stat -c %Y ${q(t.log)} 2>/dev/null || echo MISSING`).join('\n') + '\n'
    // Le battement porte sa propre horodate et son code de retour : on lit la DERNIÈRE ligne,
    // pas la date du fichier. Une ligne vaut un passage, quoi que le script ait fait.
    + targets.filter(t => t.beat).map(t => `printf 'B\\t%s\\t' ${q(t.beat)}; tail -1 ${q(t.beat)} 2>/dev/null || echo MISSING`).join('\n');
  let out;
  try { out = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ALIAS, script], { encoding: 'utf8', timeout: 60000 }); }
  catch (e) { warn(`SSH ${ALIAS} inaccessible : ${String(e.message || e).slice(0, 120)} — gisement vps-cron sauté`); return; }

  const lines = out.trim().split('\n');
  const nowRemote = Number(lines.shift()) * 1000;         // horloge du VPS, pas celle du Mac
  const zRaw = String(lines.shift() || '+0000').trim();   // ex. « +0200 » — cron lit l'heure LOCALE
  const zm = zRaw.match(/^([+-])(\d{2})(\d{2})$/);
  const tzOff = zm ? (zm[1] === '-' ? -1 : 1) * (Number(zm[2]) * 60 + Number(zm[3])) : 0;
  const seen = new Map(), beats = new Map(), dirSince = new Map();
  for (const l of lines) {
    const [kind, path, val] = l.split('\t');
    if (kind === 'L') seen.set(path, val);
    else if (kind === 'B') beats.set(path, val);
    else if (kind === 'D') {
      const [w, m] = String(val || '0 0').trim().split(/\s+/).map(Number);
      dirSince.set(path, (w || m || 0) * 1000);           // %W = création ; repli sur mtime
    }
  }

  let ko = 0, pending = 0;
  for (const t of targets) {
    // ── 1. Le BATTEMENT d'abord : c'est la seule source qui dit vraiment « ça a tourné ».
    // Il est écrit à chaque passage, quel que soit le comportement du script — contrairement
    // au journal métier, dont le silence peut être parfaitement normal.
    const braw = t.beat ? beats.get(t.beat) : null;
    if (braw && braw !== 'MISSING') {
      const bm = String(braw).match(/^(\S+)\s+rc=(\S+)/);
      if (bm) {
        const at = Date.parse(bm[1]);
        const rc = bm[2];
        const fires = lastFires(t.schedule, nowRemote, tzOff);
        let status = 'ok', note = `passage à ${bm[1]} (code de retour ${rc})`;
        if (rc !== '0') { status = 'fail'; note = `dernier passage à ${bm[1]} terminé en ÉCHEC (code de retour ${rc})`; }
        // Fiable désormais : deux déclenchements prévus sans un seul battement = ça ne tourne
        // plus. Le script n'a pas besoin d'être bavard pour que ce verdict tienne.
        else if (fires.length === 2 && at < fires[1]) {
          status = 'stale';
          note = `aucun battement depuis ${((nowRemote - at) / 3600000).toFixed(1)} h alors que « ${t.schedule} » prévoyait 2 déclenchements de plus (dernier attendu le ${iso(fires[0]).replace('T', ' ').slice(0, 16)} UTC)`;
        }
        if (status !== 'ok') ko++;
        runs.push({ key: t.key, last_run: iso(at), status, note, ...(t.log ? { log: t.log } : {}), source: 'vps-cron' });
        continue;
      }
    }
    if (t.beat) {
      // Battement instrumenté mais pas encore écrit : normal tant qu'aucun déclenchement n'a
      // eu lieu depuis la pose. On le dit sans crier au feu.
      const since = dirSince.get(t.beat.replace(/\/[^/]+$/, '')) || 0;
      const fires = lastFires(t.schedule, nowRemote, tzOff);
      if (!since || !fires.length || fires[0] < since) {
        runs.push({ key: t.key, status: 'ok', note: 'battement posé, en attente du premier déclenchement', ...(t.log ? { log: t.log } : {}), source: 'vps-cron' });
        pending++; continue;
      }
      runs.push({ key: t.key, status: 'fail', note: 'aucun battement alors qu\'un déclenchement était prévu depuis la pose — le cron ne part pas', ...(t.log ? { log: t.log } : {}), source: 'vps-cron' });
      ko++; continue;
    }

    // ── 2. Repli : pas de battement instrumenté, on ne dispose que du journal métier.
    const raw = seen.get(t.log);
    if (raw == null || raw === 'MISSING') {
      const since = dirSince.get(t.log.replace(/\/[^/]+$/, '')) || 0;
      const fires = lastFires(t.schedule, nowRemote, tzOff);
      // Aucun passage prévu depuis que l'observabilité existe → ce n'est pas une panne,
      // c'est une attente. On le dit, et on ne le compte pas comme un défaut.
      if (since && (!fires.length || fires[0] < since)) {
        runs.push({ key: t.key, status: 'ok', note: `en attente du premier passage observé (redirection posée le ${iso(since).replace('T', ' ').slice(0, 16)} UTC, planning « ${t.schedule} »)`, log: t.log, source: 'vps-cron' });
        pending++; continue;
      }
      runs.push({ key: t.key, status: 'fail', note: 'journal absent alors qu\'un passage était prévu : la redirection est déclarée dans le crontab mais rien n\'a été écrit', log: t.log, source: 'vps-cron' });
      ko++; continue;
    }
    const at = Number(raw) * 1000;
    const ageH = Math.max(0, (nowRemote - at) / 3600000);
    // ⛔ VERDICT « FIGÉ » DÉSARMÉ (25/07/2026) — décision prise sur mesure, pas par prudence.
    //
    // L'idée d'origine : « le planning du cron dit quand une sortie est attendue ; si deux
    // passages prévus n'ont rien écrit, c'est mort ». Confronté au parc réel, ce postulat est
    // FAUX, et pas à la marge — 5 verdicts sur 9 étaient des faux positifs :
    //   • publish_guard : cron */5 toute la journée, mais le script sort en silence hors de
    //     sa fenêtre 07:45–09:45 Paris (l. 16). Journal identique hier et aujourd'hui : 3/12/9.
    //   • poll_commands : cron */2 confirmé par journalctl (60 lancements en 2 h), mais le
    //     script ne contient AUCUN print → journal 0 octet dont la mtime ne bouge jamais.
    //   • gen_guard, quality_guard, guard.sh décryptage : même famille de causes.
    //
    // Le planning du cron dit quand le script est LANCÉ, jamais quand il est censé PARLER.
    // Seul le script le sait. Aucun seuil ne rattrape ça : l'information n'existe pas dans le
    // journal. Tant que les guards n'émettent pas de battement (ROADMAP B1 étape 1, reste à
    // faire), on rapporte donc ce qu'on observe — la date de dernière écriture — sans en
    // tirer de verdict de santé. Un tableau de bord qui crie faux 5 fois sur 9 s'apprend à
    // être ignoré, et il vaut alors moins que pas de tableau de bord du tout.
    const note = `dernière écriture il y a ${ageH < 1 ? Math.round(ageH * 60) + ' min' : ageH.toFixed(1) + ' h'}`
      + ' — ce cron n\'émet pas de battement, son silence ne prouve rien';
    runs.push({ key: t.key, last_run: iso(at), status: 'ok', note, log: t.log, source: 'vps-cron' });
  }
  console.log(`▸ vps-cron : ${targets.length} cron(s) à redirection exploitable — ${ko} en défaut · ${pending} en attente du 1er passage · ${noRedirect} hors de portée (pas de redirection, ou cible caviardée)`);
}

/* ══════════════════ orchestration ══════════════════ */
if (want('gha')) collectGha();
if (want('launchd')) collectLaunchd();
if (want('vps-cron')) collectVpsCron();

if (PRINT) { console.log(JSON.stringify(runs, null, 2)); process.exit(0); }
if (!runs.length) { console.log('∅ aucun run collecté'); process.exit(0); }

const r = ingest('runs', { runs });
if (r.error) { console.error('✗ ' + r.error); process.exit(1); }
touchSource(__dir, 'gha-runs', { status: 'ok', collector: 'node runs-collect.mjs --only=gha' });
touchSource(__dir, 'runs-local', {
  status: 'ok',
  collector: 'node runs-collect.mjs',
  note: 'launchd Mac (LastExitStatus + mtime du journal) et crons VPS. Depuis B1, les 41 lignes de cron (24 ton-user + 17 root) portent un battement « ; beat <nom> $? » : le passage et son code de retour sont observés sans dépendre de la bavardise du script. ta veille de sécurité lit le même gisement (ROADMAP B5).'
});
const ko = runs.filter(x => x.status !== 'ok');
console.log(`✓ ${runs.length} run(s) → runs_summary.json (created ${r.created} · updated ${r.updated})`);
if (ko.length) { console.log(`  ${ko.length} en défaut :`); for (const x of ko) console.log(`   ✗ ${x.status.padEnd(5)} ${x.key} — ${x.note}`); }
console.log('  Rebuild : node karto-db.mjs build');
