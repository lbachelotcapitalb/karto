#!/usr/bin/env node
// karto-diagnostics.mjs — diagnostic automatique de la SANTÉ de la carte (score qualité).
//
// N'INVENTE pas du bruit (chaque kind n'a pas vocation à porter criticité/owner) :
// agrège les signaux qui EXISTENT déjà (exposures de sécurité, rangement des secrets,
// sauvegarde des données, cycle de vie, couverture du modèle, fraîcheur) en un
// SCORE global + des DIMENSIONS notées, avec la liste actionnable des trous.
//
// Pensé pour être appelé de 3 endroits avec la même logique (fonction pure) :
//   - CLI  : node karto-diagnostics.mjs [--summary]
//   - MCP  : karto_diagnostics (karto-mcp.mjs)
//   - build: model.diagnostics baké pour le widget dashboard (build.mjs)
//
// Règle d'or : LECTURE SEULE, aucune valeur de secret, conservateur (signal > volume).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './karto-sqlite.mjs';

/* ---------- fonction PURE : entrées = tableaux simples, sortie = scorecard ---------- */
export function computeDiagnostics(inp = {}) {
  const entities = inp.entities || [];
  const edges = inp.edges || [];
  const secretRefs = inp.secretRefs || [];
  const exposures = inp.exposures || [];
  const dataAssets = inp.dataAssets || [];
  const bridges = inp.bridges || [];
  const now = inp.now ? new Date(inp.now) : new Date(inp.nowFallback || '2026-06-30T00:00:00Z');
  const lastSync = inp.lastSync ? new Date(inp.lastSync) : null;

  const clamp = (v, a = 0, b = 100) => v < a ? a : v > b ? b : v;
  const cut = (s, n = 90) => { s = String(s || '').replace(/^\[[^\]]+\]\s*/, ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const statusOf = s => s >= 80 ? 'green' : s >= 50 ? 'orange' : 'red';
  const dims = [];

  // 1. SÉCURITÉ — expositions ouvertes (status=open) ; mitigated = demi-poids. (Source curée.)
  {
    const open = exposures.filter(e => (e.status || 'open') === 'open');
    const mit = exposures.filter(e => e.status === 'mitigated');
    const sev = s => open.filter(e => e.severity === s).length;
    const penalty = sev('critical') * 28 + sev('high') * 16 + sev('medium') * 8 + sev('low') * 3
      + mit.length * 3;
    const score = clamp(100 - penalty);
    dims.push({
      key: 'securite', label: 'Sécurité', weight: 3, score,
      status: sev('critical') ? 'red' : statusOf(score),
      count: open.length,
      note: open.length ? `${open.length} exposition(s) ouverte(s)${mit.length ? ` · ${mit.length} atténuée(s)` : ''}` : 'aucune exposition ouverte',
      items: [...open].sort((a, b) => sevRank(a.severity) - sevRank(b.severity))
        .map(e => ({ severity: e.severity, label: cut(e.what), where: cut(e.where || e.location, 70), fix: cut(e.recommendation, 110) })),
      recommendation: open.length ? 'Traiter les expositions ouvertes par sévérité (onglet Sécurité — reste à faire).' : null
    });
  }

  // 2. SECRETS — rangement tracé ? store renseigné (bw/here/none-assumé) vs inconnu (null).
  {
    const total = secretRefs.length || 1;
    const tracked = secretRefs.filter(s => s.store != null && String(s.store).trim() !== '').length;
    const untracked = secretRefs.length - tracked;
    const score = Math.round(tracked / total * 100);
    dims.push({
      key: 'secrets', label: 'Rangement des secrets', weight: 2, score, status: statusOf(score),
      count: untracked,
      note: `${tracked}/${secretRefs.length} secret(s) au rangement tracé`,
      items: untracked ? [{ severity: 'medium', label: `${untracked} secret(s) référencé(s) sans rangement connu (ni Bitwarden ni coffre)`, fix: 'Importer dans Bitwarden et renseigner store (bw/here/none).' }] : [],
      recommendation: untracked ? 'Migrer les secrets non tracés vers Bitwarden, puis purger les .env.' : null
    });
  }

  // 3. RÉSILIENCE — données stratégiques avec un chemin de restauration documenté.
  {
    const total = dataAssets.length || 1;
    const prot = dataAssets.filter(a => Array.isArray(a.restauration) ? a.restauration.length > 0 : !!a.restauration).length;
    const score = dataAssets.length ? Math.round(prot / total * 100) : 100;
    dims.push({
      key: 'resilience', label: 'Sauvegarde / résilience', weight: 3, score, status: statusOf(score),
      count: dataAssets.length - prot,
      note: `${prot}/${dataAssets.length} donnée(s) stratégique(s) avec restauration documentée`,
      items: dataAssets.filter(a => !(Array.isArray(a.restauration) ? a.restauration.length : a.restauration))
        .map(a => ({ severity: 'high', label: `${a.label} — aucun chemin de restauration`, fix: 'Documenter un backup/restore (cron pg_dump, export, copie hors-site).' })),
      recommendation: (dataAssets.length - prot) ? 'Documenter une restauration pour chaque donnée critique (point de défaillance unique sinon).' : null
    });
  }

  // 3bis. OBSERVABILITÉ IA — automatisations pilotées par un LLM (agents, crons claude -p,
  // scénarios avec module IA). Chacune devrait déclarer dans attrs.obs les 4 pratiques
  // génériques (consolidées des standards LLM-observability, ex. Datadog) :
  //   traces  = journal par run (JSONL, plateforme LLM-obs…) : étapes, durée, tokens, erreurs
  //   alertes = alerte de panne SILENCIEUSE par un canal indépendant des crédentiels du LLM
  //   gate    = contrôle de sortie AVANT action externe (quality gate / anti-injection)
  //   cout    = suivi de conso (tokens/€) ou coût structurellement plafonné (abonnement)
  // Opt-in, zéro bruit : détection par attrs.llm === true OU attrs.claudeTier non vide ;
  // la dimension est ABSENTE si aucune automatisation IA n'est déclarée dans la carte.
  {
    const attrsOf = e => {
      const a = e && e.attrs;
      if (!a) return {};
      if (typeof a === 'string') { try { return JSON.parse(a); } catch { return {}; } }
      return a;
    };
    const PRACTICES = [
      ['traces', 'traces par run (journal JSONL / plateforme LLM-obs)'],
      ['alertes', 'alerte de panne silencieuse (canal indépendant du LLM)'],
      ['gate', 'gate de sortie (qualité + anti-injection) avant action externe'],
      ['cout', 'suivi ou plafond de coût (tokens / abonnement / budget)'],
    ];
    const KINDS = new Set(['automation', 'agent', 'scenario', 'workload']);
    const ai = entities.filter(e => {
      if (!KINDS.has(e.kind)) return false;
      const a = attrsOf(e);
      return a.llm === true || a.ia === true || (a.claudeTier != null && String(a.claudeTier) !== '');
    });
    if (ai.length) {
      let covered = 0; const items = [];
      for (const e of ai) {
        const obs = attrsOf(e).obs || {};
        const done = PRACTICES.filter(([k]) => !!obs[k]);
        covered += done.length / PRACTICES.length;
        const missing = PRACTICES.filter(([k]) => !obs[k]);
        if (missing.length) items.push({
          severity: done.length === 0 ? 'medium' : 'low',
          label: `${e.name} — ${done.length}/${PRACTICES.length} pratique(s) d'observabilité déclarée(s)`,
          fix: `Manque : ${missing.map(([, l]) => l).join(' · ')}. Mettre la pratique en place puis la déclarer (attrs.obs.{${missing.map(([k]) => k).join(',')}}).`,
        });
      }
      const score = Math.round(covered / ai.length * 100);
      dims.push({
        key: 'observabilite_ia', label: 'Observabilité IA', weight: 2, score, status: statusOf(score),
        count: items.length,
        note: `${ai.length} automatisation(s) IA · couverture des 4 pratiques : ${score} %`,
        items: items.sort((a, b) => sevRank(a.severity) - sevRank(b.severity)),
        recommendation: items.length ? 'Équiper chaque automatisation IA : traces par run, alerte de panne silencieuse, gate de sortie, suivi de coût (voir docs/OBSERVABILITE-IA.md).' : null
      });
    }
  }

  // 4. CYCLE DE VIE — actif marqué « Éliminer » mais encore en service.
  {
    const bad = entities.filter(e => /[ée]limin/i.test(e.cycle || '') && /(ctif|servic)/i.test(e.statut || e.status || ''));
    const score = bad.length ? clamp(100 - bad.length * 20) : 100;
    dims.push({
      key: 'cycle', label: 'Cycle de vie', weight: 1, score, status: bad.length ? 'orange' : 'green',
      count: bad.length,
      note: bad.length ? `${bad.length} actif(s) « Éliminer » encore en service` : 'aucun actif obsolète en service',
      items: bad.map(e => ({ severity: 'low', label: `${e.name} — cycle « ${e.cycle} » mais encore actif`, fix: 'Décommissionner ou requalifier le cycle de vie.' })),
      recommendation: bad.length ? 'Décommissionner les actifs en fin de vie encore actifs.' : null
    });
  }

  // 5. COUVERTURE — projet/base sans aucune connexion = trou de modélisation.
  // (Les comptes secondaires non reliés sont NORMAUX → exclus pour éviter le bruit.)
  {
    const MEAN = new Set(['project', 'database']);
    const linked = new Set();
    for (const e of edges) { linked.add(e.src); linked.add(e.dst); }
    const mean = entities.filter(e => MEAN.has(e.kind));
    const orphans = mean.filter(e => !linked.has(e.id));
    const total = mean.length || 1;
    const score = Math.round((mean.length - orphans.length) / total * 100);
    dims.push({
      key: 'couverture', label: 'Couverture du modèle', weight: 1, score, status: statusOf(score),
      count: orphans.length,
      note: `${orphans.length} nœud(s) important(s) isolé(s) (projet/base sans lien)`,
      items: orphans.map(e => ({ severity: 'low', label: `${e.name} (${e.kind}) — relié à rien`, fix: 'Rattacher au projet/host/compte concerné (arête manquante).' })),
      recommendation: orphans.length ? 'Relier les nœuds isolés (souvent une intégration ou un host manquant).' : null
    });
  }

  // 6. FRAÎCHEUR — âge de la dernière synchro de la carte + fraîcheur PAR SOURCE
  // (répertoire data/sources.json : chaque source de la stack porte cadence_days + last_synced,
  // estampillé par son collecteur via karto-sources.mjs). Les sources `planned`/`probe` sont
  // des trous de couverture signalés (pas comptés dans le score de fraîcheur).
  {
    const ageD = lastSync ? Math.max(0, Math.floor((now - lastSync) / 86400000)) : null;
    const neverIdx = bridges.filter(b => !b.last_indexed).length;
    const cardScore = ageD == null ? 60 : ageD <= 7 ? 100 : ageD <= 30 ? 70 : 35;
    const sources = inp.sources || [];
    const srcAge = s => s.last_synced ? Math.floor((now - new Date(s.last_synced)) / 86400000) : null;
    const tracked = sources.filter(s => s.cadence_days != null && ['ok', 'manual', 'snapshot'].includes(s.status));
    const stale = tracked.filter(s => { const a = srcAge(s); return a == null || a > s.cadence_days; });
    const gaps = sources.filter(s => s.status === 'planned' || s.status === 'probe');
    const score = tracked.length
      ? Math.round(cardScore * 0.5 + (tracked.length - stale.length) / tracked.length * 100 * 0.5)
      : cardScore;
    const items = [
      ...stale.map(s => ({
        severity: srcAge(s) == null ? 'medium' : 'low',
        label: `source « ${s.id} » ${srcAge(s) == null ? 'jamais synchronisée' : `périmée (${srcAge(s)} j > cadence ${s.cadence_days} j)`}`,
        fix: s.collector ? `Relancer : ${s.collector}` : (s.howto || 'Documenter un collecteur.')
      })),
      ...gaps.map(s => ({ severity: 'low', label: `source « ${s.id} » sans collecteur (${s.status === 'probe' ? 'existence à sonder' : 'prévu phase 2'})`, fix: s.collector || s.note || '' })),
      ...(neverIdx ? [{ severity: 'low', label: `${neverIdx} bridge(s) jamais sondé(s) (schéma non rafraîchi)`, fix: 'Lancer karto-bridge probe / supabase-refresh.' }] : []),
    ];
    dims.push({
      key: 'fraicheur', label: 'Fraîcheur', weight: 1, score, status: statusOf(score),
      count: tracked.length ? stale.length : (ageD == null ? null : ageD),
      note: (ageD == null ? 'date de synchro inconnue' : `dernière synchro il y a ${ageD} jour(s)`)
        + (tracked.length ? ` · ${tracked.length - stale.length}/${tracked.length} source(s) fraîche(s)` : ''),
      items,
      recommendation: stale.length ? 'Relancer les collecteurs des sources périmées (node karto-sources.mjs pour l\'état).'
        : (ageD != null && ageD > 30) ? 'Relancer karto-sync audit/apply — la carte date.' : null
    });
  }

  // ---- score global pondéré ----
  const wsum = dims.reduce((s, d) => s + d.weight, 0);
  const score = Math.round(dims.reduce((s, d) => s + d.score * d.weight, 0) / wsum);
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'E';
  const reds = dims.filter(d => d.status === 'red');
  const totalFindings = dims.reduce((s, d) => s + (d.items ? d.items.length : 0), 0);

  return {
    score, grade,
    status: score >= 80 ? 'green' : score >= 55 ? 'orange' : 'red',
    summary: `Santé de la carte : ${score}/100 (${grade})` + (reds.length ? ` — ${reds.length} dimension(s) critique(s) : ${reds.map(d => d.label).join(', ')}` : ' — aucun point critique'),
    totalFindings,
    dimensions: dims,
    generatedAt: now.toISOString()
  };
}
function sevRank(s) { return { critical: 0, high: 1, medium: 2, low: 3 }[s] ?? 4; }

/* ---------- chargement depuis karto.db + data/*.json (CLI & MCP) ---------- */
export function runDiagnostics(dir) {
  const DB = join(dir, 'karto.db');
  const db = openDb(DB, { readOnly: true });
  const q = s => db.prepare(s).all();
  const readJson = (f, d) => { try { return JSON.parse(readFileSync(join(dir, 'data', f), 'utf8')); } catch { return d; } };
  const disk = readJson('disk_inventory.json', {});
  const da = readJson('data_assets.json', {});
  const sync = readJson('sync_log.json', {});
  const srcReg = readJson('sources.json', {});
  return computeDiagnostics({
    sources: srcReg.sources || [],
    entities: q('SELECT id,kind,name,criticite,cycle,statut,status,attrs FROM entity'),
    edges: q('SELECT src,dst FROM edge'),
    secretRefs: q('SELECT name,store,category FROM secret_ref'),
    bridges: q('SELECT name,last_indexed FROM bridge'),
    exposures: disk.exposures || [],
    dataAssets: da.assets || [],
    lastSync: sync.lastSync || null,
    now: new Date().toISOString()
  });
}

/* ---------- CLI ---------- */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dir = dirname(fileURLToPath(import.meta.url));
  if (!existsSync(join(dir, 'karto.db'))) { console.error('✗ karto.db absent — lance `node karto-db.mjs build`.'); process.exit(1); }
  const d = await runDiagnostics(dir);
  if (process.argv.includes('--summary')) {
    const ic = { green: '🟢', orange: '🟠', red: '🔴' };
    console.log(`\n  ${ic[d.status]} ${d.summary}\n`);
    for (const dim of d.dimensions) console.log(`  ${ic[dim.status]} ${String(dim.score).padStart(3)} · ${dim.label} — ${dim.note}`);
    const open = d.dimensions.flatMap(dim => (dim.items || []).map(it => ({ ...it, dim: dim.label })));
    if (open.length) { console.log(`\n  À corriger (${open.length}) :`); for (const it of open.slice(0, 20)) console.log(`   · [${it.severity}] ${it.label}`); }
    console.log('');
  } else {
    console.log(JSON.stringify(d, null, 2));
  }
}
