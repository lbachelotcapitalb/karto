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
import { isExecutable } from './karto-vocab.mjs';

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
  //    ⚠️ « tracé » ≠ « bien rangé » : la note dit donc AUSSI combien de secrets n'ont aucun
  //    rangement au coffre (store='none' = en clair dans un fichier). Sans ça, la dimension
  //    affichait 100/100 pendant que des clés vivaient en clair — le même signal rassurant
  //    que celui corrigé sur les orphelins (B3) et la veille par liste blanche (B5).
  {
    const total = secretRefs.length || 1;
    const tracked = secretRefs.filter(s => s.store != null && String(s.store).trim() !== '').length;
    const untracked = secretRefs.length - tracked;
    const inClear = secretRefs.filter(s => String(s.store || '').toLowerCase() === 'none').length;
    const score = Math.round(tracked / total * 100);
    const items = [];
    if (untracked) items.push({ severity: 'medium', label: `${untracked} secret(s) référencé(s) sans rangement connu (ni Bitwarden ni coffre)`, fix: 'Lancer node bw-to-karto.mjs (apparie le coffre) puis renseigner store (bw/here/none).' });
    if (inClear) items.push({ severity: 'medium', label: `${inClear} secret(s) sans rangement au coffre — en clair dans un fichier (store='none')`, fix: 'Déposer au coffre (node vault-add.mjs) puis purger la valeur du fichier.' });
    dims.push({
      key: 'secrets', label: 'Rangement des secrets', weight: 2, score, status: statusOf(score),
      count: untracked + inClear,
      note: `${tracked}/${secretRefs.length} secret(s) au rangement tracé` + (inClear ? ` · dont ${inClear} en clair, hors coffre` : ''),
      items,
      recommendation: untracked ? 'Migrer les secrets non tracés vers Bitwarden, puis purger les .env.'
        : inClear ? `Rangement connu à 100 %, mais ${inClear} secret(s) restent en clair : les déposer au coffre est le geste suivant (session « rotation des secrets »).` : null
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
    // D1 — quatrième copie de la liste des kinds exécutables, et la seule à oublier
    // `launchagent` en plus de `vps_cron`. Elle vient désormais de karto-vocab.
    const ai = entities.filter(e => {
      if (!isExecutable(e.kind)) return false;
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
    const bad = entities.filter(e => /[ée]limin/i.test(e.cycle || '') && /(ctif|servic)/i.test(e.statut || ''));
    const score = bad.length ? clamp(100 - bad.length * 20) : 100;
    dims.push({
      key: 'cycle', label: 'Cycle de vie', weight: 1, score, status: bad.length ? 'orange' : 'green',
      count: bad.length,
      note: bad.length ? `${bad.length} actif(s) « Éliminer » encore en service` : 'aucun actif obsolète en service',
      items: bad.map(e => ({ severity: 'low', label: `${e.name} — cycle « ${e.cycle} » mais encore actif`, fix: 'Décommissionner ou requalifier le cycle de vie.' })),
      recommendation: bad.length ? 'Décommissionner les actifs en fin de vie encore actifs.' : null
    });
  }

  // 5. COUVERTURE — une entité SANS AUCUNE ARÊTE n'est pas cartographiée : elle est
  // seulement stockée. On sait qu'elle existe, on ignore à quoi elle se rattache.
  //
  // Avant le 25/07/2026 cette dimension ne regardait que les projets et les bases, « pour
  // éviter le bruit » : elle annonçait 4 nœuds isolés là où la base en comptait 125 sur 383,
  // et affichait un rassurant 85/100 sur un graphe déconnecté au tiers. Restreindre le
  // périmètre de mesure ne réduit pas le problème, ça réduit ce qu'on en voit — et un
  // diagnostic qui rassure à tort est pire que pas de diagnostic. On compte donc TOUT.
  //
  // L'agrégat est par `kind` et non par entité : 125 lignes noieraient le panneau, et le
  // vrai signal n'est pas « quelle entité est isolée » mais « quel collecteur ne produit
  // AUCUNE arête » — un kind orphelin à 100 % désigne son collecteur du doigt (cf. D4).
  {
    const out = new Set(), inn = new Set();
    for (const e of edges) { out.add(e.src); inn.add(e.dst); }
    const isolated = entities.filter(e => !out.has(e.id) && !inn.has(e.id));
    // Indicateur SECONDAIRE, non noté : une entité qui n'est que citée (aucune arête
    // sortante) est rattachée au graphe mais ne dit rien de ce dont elle dépend.
    const noOut = entities.filter(e => !out.has(e.id));
    const total = entities.length || 1;
    const score = Math.round((total - isolated.length) / total * 100);

    const byKind = new Map();
    for (const e of isolated) {
      const k = byKind.get(e.kind) || { n: 0, names: [] };
      k.n++; if (k.names.length < 4) k.names.push(e.name);
      byKind.set(e.kind, k);
    }
    const totalOf = k => entities.filter(e => e.kind === k).length;
    const items = [...byKind.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([kind, k]) => {
        const tot = totalOf(kind);
        const whole = k.n === tot;   // kind entièrement déconnecté = son collecteur est muet
        return {
          severity: whole ? 'medium' : 'low',
          label: `${kind} — ${k.n}/${tot} entité(s) sans aucune arête` + (whole ? ' (le kind ENTIER est déconnecté)' : ''),
          where: k.names.join(', ') + (k.n > k.names.length ? `, …(+${k.n - k.names.length})` : ''),
          fix: whole
            ? `Le collecteur qui produit les ${kind} ne crée aucune arête — c'est la cause racine, pas ${k.n} oublis isolés.`
            : 'Rattacher au projet/host/compte concerné (arête manquante).'
        };
      });
    dims.push({
      key: 'couverture', label: 'Couverture du modèle', weight: 1, score, status: statusOf(score),
      count: isolated.length,
      note: `${isolated.length}/${total} entité(s) sans aucune arête · ${noOut.length} sans arête sortante (indicateur secondaire, non noté)`,
      items,
      recommendation: isolated.length
        ? 'Faire produire des arêtes aux collecteurs muets avant de relier à la main (un kind orphelin à 100 % = un collecteur, pas des oublis).'
        : null
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

  /* ════════════════ F2 — les bonnes pratiques de l'audit deviennent une MESURE CONTINUE ════
   * Le skill `audit-si` porte la méthode ; à partir d'ici, karto porte la mesure. Un audit qui
   * ne tourne que quand on y pense ne protège de rien : ces cinq dimensions rejouent, à chaque
   * appel de karto_diagnostics, ce qui n'était jusqu'ici trouvé qu'à la main (ou imprimé une
   * fois sur le stdout d'un build que personne ne relit).
   *
   * LOI APPLIQUÉE PAR LE CODE, pas seulement écrite : une dimension dont l'entrée est absente
   * sort `score: null` + `mesure: 'non mesuré'` AVEC SON MOTIF, et elle est EXCLUE de la
   * moyenne pondérée. Ni 0 (qui accuserait à tort), ni 100 (qui rassurerait à tort). C'est la
   * loi nº1 du skill — « un 0 non vérifiable devient non mesuré » — rendue exécutable. */
  const nonMesuree = (key, label, weight, motif, fix) => ({
    key, label, weight, score: null, status: 'grey', mesure: 'non mesuré', count: null,
    note: `non mesuré — ${motif}`,
    items: [{ severity: 'low', label: `dimension « ${label} » NON MESURÉE — ${motif}`, fix: fix || '' }],
    recommendation: fix || null,
  });

  // 7. VOCABULAIRE FERMÉ — D1 a posé des CHECK sur 6 colonnes. La question que personne ne
  // reposait : et les AUTRES ? Une colonne texte à faible cardinalité sur beaucoup de lignes
  // EST un vocabulaire, déclaré ou non ; si la base ne le fait pas respecter, rien n'empêche
  // un collecteur d'y écrire une n-ième variante et de rendre toute jointure par ce champ
  // aléatoire. (Heuristique et seuils jumeaux de la batterie du skill `audit-si` — là-bas
  // portable sur toute base, ici résidente sur karto.db.)
  {
    const v = inp.vocabulaire;
    if (!v) dims.push(nonMesuree('vocabulaire', 'Vocabulaire fermé', 2,
      'le schéma de karto.db n\'a pas pu être introspecté (base absente ou illisible)',
      'Relancer le diagnostic depuis le dépôt karto (node karto-diagnostics.mjs).'));
    else {
      const libres = v.colonnes.filter(c => !c.contrainte);
      const collisions = v.colonnes.flatMap(c => c.collisions.map(g => ({ col: c.colonne, table: c.table, vals: g })));
      const hors = v.horsReferentiel || [];
      // Deux tiers de la note portent sur la part de vocabulaires réellement contraints ;
      // le reste pénalise ce qui est DÉJÀ sale (collisions, valeurs hors référentiel), car
      // une colonne libre est un risque, une collision est un défaut constaté.
      const partContrainte = v.colonnes.length ? (v.colonnes.length - libres.length) / v.colonnes.length : 1;
      const score = clamp(Math.round(partContrainte * 100) - collisions.length * 10 - hors.length * 10);
      dims.push({
        key: 'vocabulaire', label: 'Vocabulaire fermé', weight: 2, score, status: statusOf(score),
        count: libres.length + collisions.length + hors.length,
        note: `${v.colonnes.length - libres.length}/${v.colonnes.length} colonne(s) de vocabulaire sous contrainte`
          + (collisions.length ? ` · ${collisions.length} collision(s) casse/accent` : '')
          + (hors.length ? ` · ${hors.length} valeur(s) hors référentiel` : ''),
        items: [
          ...libres.map(c => ({
            severity: 'medium',
            label: `${c.table}.${c.colonne} — ${c.distinctes} valeur(s) sur ${c.lignes} ligne(s), AUCUNE contrainte`,
            where: c.exemples.join(' · '),
            fix: `Rien n'empêche un collecteur d'y écrire une ${c.distinctes + 1}ᵉ valeur. Déclarer la colonne dans data/karto_vocabulary.json (D1 génère alors le CHECK), ou assumer qu'elle est libre.`,
          })),
          ...collisions.map(c => ({
            severity: 'high',
            label: `${c.table}.${c.col} — ${c.vals.length} valeurs qui ne diffèrent que par la casse/l'accent : ${c.vals.join(' / ')}`,
            fix: 'Normaliser à l\'ingestion (karto-vocab.mjs) — deux graphies du même mot rendent toute jointure par ce champ aléatoire.',
          })),
          ...hors.map(u => ({
            severity: 'high',
            label: `${u.champ} = « ${u.valeur} » ×${u.n} — hors référentiel, le CHECK la rejettera`,
            where: u.source, fix: 'Ajouter la valeur à data/karto_vocabulary.json ou corriger la source.',
          })),
        ],
        recommendation: libres.length ? 'Fermer les vocabulaires restants, ou déclarer explicitement qu\'ils sont libres (une colonne libre non dite est un piège pour le prochain collecteur).' : null,
      });
    }
  }

  // 8. INTÉGRITÉ DU GRAPHE — D2/D3/D4/D5/D6 ont établi ces invariants et les ont affichés à
  // chaque build. Un invariant qui défile sur stdout n'est pas un garde-fou : il faut être
  // devant l'écran au bon moment. Ils sont désormais REJOUÉS ici.
  // Deux sources, et la distinction est le point important :
  //   · ce qui est DANS la base (pendantes, triplets dupliqués, doublons) → mesuré en direct ;
  //   · ce qui a été REFUSÉ à l'écriture (référence qui ne résout pas, écrasement bloqué,
  //     entrée de liste blanche morte) → invisible en SQL par construction, lu dans les
  //     invariants persistés par le build (meta.invariants).
  {
    const g = inp.integrite;
    if (!g) dims.push(nonMesuree('integrite', 'Intégrité du graphe', 3,
      'les invariants du graphe n\'ont pas pu être lus dans karto.db',
      'Reconstruire la base : node karto-db.mjs build.'));
    else {
      const inv = g.invariants || null;
      const items = [];
      if (g.pendantes) items.push({ severity: 'critical', label: `${g.pendantes} arête(s) pendante(s) — une extrémité n'existe pas`, fix: 'Défaut GRAVE : les FK de D2 auraient dû l\'empêcher. Vérifier que PRAGMA foreign_keys = ON est posé sur CHAQUE connexion.' });
      if (g.tripletsDupliques) items.push({ severity: 'high', label: `${g.tripletsDupliques} triplet(s) (src,dst,rel) en double`, fix: 'L\'index UNIQUE(src,dst,rel) de D2 est absent ou contourné.' });
      for (const d of g.doublons) items.push({ severity: 'high', label: `doublon : ${d.n}× ${d.kind} « ${d.canonical} »`, fix: 'Même kind + même nom = la résolution par nom devient un tirage au sort (invariant D3). Fusionner.' });
      if (!g.fk) items.push({ severity: 'critical', label: 'aucune clé étrangère déclarée sur les arêtes', fix: 'D2 les a posées — leur disparition signifie que la base a été recréée par un autre chemin.' });
      if (!g.unique) items.push({ severity: 'high', label: 'aucun index UNIQUE(src,dst,rel) sur les arêtes', fix: 'Rétablir la contrainte de D2.' });
      // Les clés de jointure inter-systèmes (D5 SIREN, D6 token de site) : une clé malformée
      // ou partagée ne joint pas — et ne le dit pas, sauf ici.
      for (const k of g.clesMetier || []) {
        for (const m of k.malformes) items.push({ severity: 'high', label: `clé « ${k.nom} » malformée : ${m}`, fix: `Elle ne joindra PAS avec le système qui la porte (${k.avec}).` });
        for (const d of k.doublons) items.push({ severity: 'high', label: `clé « ${k.nom} » partagée par plusieurs entités : ${d}`, fix: 'Une clé de jointure partagée rend la jointure aléatoire (même raisonnement que l\'invariant (kind, canonical) de D3).' });
      }
      let refus = 0;
      // ⚠️ Trouvé par contre-épreuve en écrivant cette dimension : sur une base construite AVANT
      // F2, la moitié « refusé » n'existe pas — et la dimension affichait alors un rassurant
      // 100/100 en le mentionnant seulement en fin de note. C'est la loi nº2 exactement (« une
      // dimension à 100 doit dire ce qu'elle ne couvre pas ») : elle le disait, mais après la
      // note, donc personne ne le lisait. Elle le dit maintenant comme un défaut, et ne peut
      // plus passer au vert.
      if (!inv) items.push({
        severity: 'medium',
        label: 'MOITIÉ DE LA DIMENSION NON MESURÉE — les références et écrasements REFUSÉS à l\'écriture ne sont pas persistés',
        fix: 'Ce sont des faits sur ce qui n\'est PAS dans la base : aucune requête ne peut les retrouver. Reconstruire : node karto-db.mjs build.',
      });
      if (inv) {
        const bloc = (arr, sev, quoi, fix) => { for (const x of (arr || [])) { refus++; items.push({ severity: sev, label: `${quoi} : ${typeof x === 'string' ? x : JSON.stringify(x)}`, fix }); } };
        bloc(inv.refsNonResolues, 'medium', 'référence déclarée sans entité correspondante (arête NON écrite)', 'Corriger la donnée source, ou créer l\'entité manquante. Rien n\'est inventé — l\'arête est simplement absente.');
        bloc(inv.site?.aCorriger, 'medium', 'déclaration de site morte (curation sites.json)', 'D6 a assumé une liste blanche de curation ; c\'est ici qu\'elle se dénonce. Corriger l\'entrée ou la retirer.');
        bloc(inv.skillsRefsSansSuite, 'low', 'référence de skill sans entité correspondante', 'Le skill cite un identifiant que la carte ne connaît pas.');
        bloc(inv.skillsRefsAmbigues, 'low', 'référence de skill AMBIGUË, non tranchée', 'Plusieurs entités correspondent — la carte refuse de deviner (règle D4).');
        bloc(inv.ecrasementsRefuses, 'medium', 'écrasement REFUSÉ (un collecteur voulait remplacer une valeur connue)', 'Règle D4 « on remplit les trous, on n\'écrase jamais » : un collecteur dégradé a tenté d\'appauvrir la carte. Vérifier lequel.');
        bloc(inv.projetsNonResolus, 'low', 'projet d\'automatisation non résolu', 'Champ « project » libre qui ne désigne aucune entité.');
        bloc(inv.dependancesNonResolues, 'low', 'dépendance non résolue', 'Nom inconnu de la carte.');
        bloc(inv.pontsSansCompte, 'low', 'pont sans compte résolu', 'Le bridge ne se rattache à aucun compte.');
        bloc(inv.ghaSansDepot, 'low', 'workflow GHA sans dépôt unique (ambiguïté NON tranchée)', 'Plusieurs dépôts candidats — non arbitré par construction.');
        bloc(inv.aliasSshOrphelins, 'low', 'alias SSH sans hôte correspondant', 'Alias déclaré vers une machine absente de la carte.');
      }
      const score = clamp(100 - g.pendantes * 30 - g.tripletsDupliques * 15 - g.doublons.length * 15
        - (g.fk ? 0 : 25) - (g.unique ? 0 : 15)
        - (g.clesMetier || []).reduce((s, k) => s + (k.malformes.length + k.doublons.length) * 12, 0)
        - refus * 3);
      dims.push({
        key: 'integrite', label: 'Intégrité du graphe', weight: 3, score, status: inv ? statusOf(score) : (score >= 50 ? 'orange' : 'red'),
        count: items.length,
        note: (inv ? '' : '⚠ PÉRIMÈTRE PARTIEL (le refusé n\'est pas mesuré) · ')
          + `${g.pendantes} pendante(s) · ${g.tripletsDupliques} triplet(s) dupliqué(s) · ${g.doublons.length} doublon(s) (même kind + même nom) · ${g.homonymes} homonyme(s) inter-kinds (légitimes)`
          + (g.fk && g.unique ? ' · FK + UNIQUE actives' : ' · ⚠ contraintes MANQUANTES')
          + (inv ? ` · ${refus} référence(s)/écrasement(s) refusé(s) au dernier build` : ''),
        items: items.sort((a, b) => sevRank(a.severity) - sevRank(b.severity)),
        recommendation: items.length ? 'Traiter d\'abord les pendantes et les doublons (ils cassent la résolution par nom), puis les références refusées (ce sont des faits que la carte n\'a pas pu écrire).' : null,
      });
    }
  }

  // 9. TRAÇABILITÉ DES EXÉCUTIONS — B1 a rempli lastRun/lastStatus, B5 a branché la veille
  // dessus. Ce que rien ne mesurait : la COUVERTURE. Une automatisation sans lastStatus n'est
  // pas « en bonne santé », elle est hors de portée du regard — et son silence est
  // indiscernable de celui d'un cron mort (la leçon centrale de B1).
  {
    const exe = entities.filter(e => isExecutable(e.kind));
    if (!exe.length) dims.push(nonMesuree('tracabilite', 'Traçabilité des exécutions', 3,
      'aucune entité exécutable dans la carte', null));
    else {
      const at = e => { const a = e.attrs; if (!a) return {}; if (typeof a === 'string') { try { return JSON.parse(a); } catch { return {}; } } return a; };
      const avec = exe.filter(e => at(e).lastStatus != null && String(at(e).lastStatus) !== '');
      // Règle héritée de B1, et elle est le fruit d'une correction publique : un échec n'en est
      // un QUE si la carte déclare que la chose doit tourner. L'intention vit dans `statut`,
      // l'état observé dans `attrs` (règle D1) ; l'écart n'est un défaut que si l'intention dit
      // « ça doit tourner ». Sans ça on ressuscite les faux positifs qui ont fait ignorer le
      // tableau de bord pendant une journée entière.
      const doitTourner = e => !/pause|arr[êe]t|d[ée]sactiv/i.test(String(e.statut || 'Actif'));
      const echecs = exe.filter(e => /fail|error|échec/i.test(String(at(e).lastStatus || '')) && doitTourner(e));
      const echecsAssumes = exe.filter(e => /fail|error|échec/i.test(String(at(e).lastStatus || '')) && !doitTourner(e));
      const sans = exe.filter(e => !(at(e).lastStatus != null && String(at(e).lastStatus) !== ''));
      const parRunner = new Map();
      for (const e of sans) { const r = at(e).runner || e.kind; parRunner.set(r, (parRunner.get(r) || []).concat(e.name)); }
      const score = Math.round(avec.length / exe.length * 100);
      dims.push({
        key: 'tracabilite', label: 'Traçabilité des exécutions', weight: 3, score, status: statusOf(score),
        count: sans.length + echecs.length,
        note: `${avec.length}/${exe.length} exécutable(s) avec un lastStatus connu`
          + (echecs.length ? ` · ${echecs.length} en ÉCHEC au dernier passage` : ' · aucun échec au dernier passage')
          + (echecsAssumes.length ? ` · ${echecsAssumes.length} en échec mais déclaré(s) en pause (non compté(s))` : ''),
        items: [
          ...echecs.map(e => ({
            severity: 'high',
            label: `${e.name} — dernier passage en ÉCHEC (${at(e).lastStatus})`,
            where: at(e).lastRun?.at || null,
            fix: at(e).lastRun?.note || 'Lire le journal de la tâche avant de conclure : un guard qui ne parle qu\'en agissant produit la même signature qu\'un cron mort (leçon B1).',
          })),
          // Agrégé par runner et non par entité : le signal utile n'est pas « laquelle », c'est
          // « quel canal d'exécution échappe entièrement à la mesure » (même raison qu'en B3).
          ...[...parRunner.entries()].sort((a, b) => b[1].length - a[1].length).map(([r, noms]) => ({
            severity: noms.length > 5 ? 'medium' : 'low',
            label: `${r} — ${noms.length} exécutable(s) sans aucun lastStatus`,
            where: noms.slice(0, 4).join(', ') + (noms.length > 4 ? `, …(+${noms.length - 4})` : ''),
            fix: 'Les instrumenter comme les crons de B1 (battement `beat <nom> $?` à chaque passage), sinon leur silence est indiscernable d\'une panne.',
          })),
        ],
        recommendation: sans.length ? 'Instrumenter les canaux d\'exécution non couverts — un périmètre partiel recrée l\'angle mort qu\'on vient de fermer (B5).' : null,
      });
    }
  }

  // 10. CONTRATS MCP — la carte DÉCLARAIT le contrat de ses connecteurs (readonly, liste
  // d'outils) et rien ne le confrontait jamais au serveur. Une déclaration que personne ne
  // contredit finit toujours par mentir. `mcp-probe.mjs` fait un vrai handshake JSON-RPC et
  // dépose la mesure ; cette dimension confronte les deux, et lit au passage le défaut le
  // plus dangereux : un outil annoté lecture seule dont le schéma expose apply/dryRun —
  // c'est-à-dire qui écrit (le défaut A3, `moncompta_scan_inbox`).
  {
    const p = inp.mcpProbe;
    if (!p || !p.servers || !Object.keys(p.servers).length) dims.push(nonMesuree('contrats_mcp', 'Contrats MCP', 2,
      'aucune mesure de contrat MCP (data/mcp_probe.json absent)',
      'Lancer : node mcp-probe.mjs (handshake réel, lecture seule — initialize + tools/list, aucun appel d\'outil).'));
    else {
      const ageJ = p.measuredAt ? Math.floor((now - new Date(p.measuredAt)) / 86400000) : null;
      const srv = Object.entries(p.servers);
      const mesures = srv.filter(([, s]) => s.mesure === 'mesuré');
      const items = [];
      for (const [nom, s] of srv) {
        if (s.mesure !== 'mesuré') {
          items.push({ severity: 'low', label: `${nom} — contrat NON MESURÉ (ce n'est pas « 0 outil »)`, where: s.motif, fix: 'Relancer node mcp-probe.mjs quand le serveur est joignable.' });
          continue;
        }
        for (const i of s.incoherents) items.push({
          severity: 'critical',
          label: `${nom} · ${i.tool} — ANNOTATION MENSONGÈRE : ${i.quoi}`,
          fix: 'Le client auto-approuve la lecture : un mutateur annoté lecture seule s\'exécute SANS confirmation (défaut A3). Corriger l\'annotation ou exposer un apply.',
        });
        if (s.sansAnnotation) items.push({
          severity: 'medium',
          label: `${nom} — ${s.sansAnnotation}/${s.total} outil(s) SANS aucune annotation d'intention`,
          fix: 'Sans readOnlyHint, le client ne peut pas distinguer lecture et écriture : il demande tout, ou pire, il suppose. Annoter (doctrine mcp-dev règle 1).',
        });
        // Confrontation déclaration (carte) ↔ mesure (serveur).
        const d = (inp.mcpDeclare || []).find(x => x.serveur === nom);
        if (d) {
          if (d.outils == null) items.push({
            severity: 'medium',
            label: `${nom} — la carte connaît le connecteur mais ne déclare AUCUN contrat (ni outils, ni readonly)`,
            where: d.id, fix: 'Renseigner tier/transport/readonly/tools dans data/cloud_inventory.json : une fiche muette ne peut être ni confrontée, ni démentie.',
          });
          if (d.outils != null && d.outils !== s.total) items.push({
            severity: 'medium',
            label: `${nom} — la carte déclare ${d.outils} outil(s), le serveur en expose ${s.total}`,
            where: d.id, fix: 'Fiche périmée : mettre à jour le connecteur dans data/cloud_inventory.json depuis la mesure.',
          });
          if (d.readonly === true && s.mutateurs > 0) items.push({
            severity: 'high',
            label: `${nom} — la carte le déclare EN LECTURE SEULE, le serveur expose ${s.mutateurs} outil(s) non annoté(s) lecture seule`,
            where: d.id, fix: 'Soit la fiche ment, soit le serveur n\'annote pas ses outils. Trancher par la mesure, pas par la fiche.',
          });
        } else items.push({
          severity: 'low', label: `${nom} — serveur MCP en service, AUCUN connecteur ne le décrit dans la carte`,
          fix: 'Ajouter la fiche (tier, transport, readonly, outils) pour que la déclaration soit confrontable.',
        });
      }
      const parfaits = mesures.filter(([nom, s]) => {
        const d = (inp.mcpDeclare || []).find(x => x.serveur === nom);
        return !s.incoherents.length && !s.sansAnnotation && d && d.outils === s.total && !(d.readonly === true && s.mutateurs > 0);
      }).length;
      const score = clamp(Math.round(parfaits / srv.length * 100) - (srv.length - mesures.length) * 10 - (ageJ != null && ageJ > 30 ? 15 : 0));
      dims.push({
        key: 'contrats_mcp', label: 'Contrats MCP', weight: 2, score, status: statusOf(score),
        count: items.length,
        note: `${mesures.length}/${srv.length} serveur(s) mesuré(s) par handshake réel · ${parfaits} contrat(s) conforme(s) à la déclaration de la carte`
          + (ageJ != null ? ` · mesure vieille de ${ageJ} j` : ''),
        items: items.sort((a, b) => sevRank(a.severity) - sevRank(b.severity)),
        recommendation: items.length ? 'Une annotation mensongère se corrige en premier : c\'est la seule qui fasse écrire sans confirmation.' : null,
      });
    }
  }

  // 11. SAUVEGARDE DU CODE ET DES SKILLS — A1 a posé le principe (« tous les skills doivent
  // vivre dans des repos git et être à jour dessus »). Son garde-fou existe, mais il ne parle
  // que sur le stdout de backup.sh. Ici il devient résident — et il mesure aussi ce que la
  // carte sait de ses propres skills : un skill dont karto ne sait pas extraire le
  // déclencheur est un skill que la carte porte à moitié.
  {
    const sk = inp.skills;
    if (!sk || !sk.length) dims.push(nonMesuree('sauvegarde_code', 'Sauvegarde du code et des skills', 2,
      'inventaire des skills illisible (data/skills_inventory.json absent)',
      'Relancer : node skills-collect.mjs'));
    else {
      const sansRepo = sk.filter(s => !s.repo);
      const sansTrigger = sk.filter(s => !s.trigger || !String(s.trigger).trim());
      const derive = new Map();
      for (const s of sk) {
        const g = s.git; if (!g || !s.repo) continue;
        if (g.modifies || g.nonPousses || g.sansAmont) {
          const quoi = [g.modifies ? `${g.modifies} fichier(s) modifié(s)` : null,
            g.sansAmont ? 'branche sans amont (ne sera poussée nulle part)' : (g.nonPousses ? `${g.nonPousses} commit(s) non poussé(s)` : null)].filter(Boolean).join(', ');
          derive.set(s.repo, quoi);
        }
      }
      const sansMesureGit = sk.filter(s => s.repo && !s.git).length;
      const score = clamp(100 - sansRepo.length * 20 - derive.size * 10 - sansTrigger.length * 5);
      dims.push({
        key: 'sauvegarde_code', label: 'Sauvegarde du code et des skills', weight: 2, score, status: statusOf(score),
        count: sansRepo.length + derive.size + sansTrigger.length,
        note: `${sk.length - sansRepo.length}/${sk.length} skill(s) versionné(s)`
          + (derive.size ? ` · ${derive.size} dépôt(s) en dérive` : ' · aucun dépôt en dérive')
          + (sansTrigger.length ? ` · ${sansTrigger.length} non parsé(s) par la carte` : '')
          + (sansMesureGit ? ` · ⚠ ${sansMesureGit} sans mesure git (collecteur antérieur à F2)` : ''),
        items: [
          ...sansRepo.map(s => ({ severity: 'high', label: `${s.name} — dans AUCUN dépôt git (principe A1)`, where: s.path, fix: 'Le versionner, ou l\'inclure dans un dépôt de sauvegarde : sans ça, une perte de disque est définitive.' })),
          ...[...derive.entries()].map(([repo, quoi]) => ({ severity: 'medium', label: `${repo} — ${quoi}`, fix: 'Committer et pousser : la sauvegarde copie un contenu que le dépôt d\'origine ne porte pas encore.' })),
          ...sansTrigger.map(s => ({ severity: 'low', label: `${s.name} — déclencheur non extrait par le parseur karto`, where: s.path, fix: 'Sa description ne porte aucun marqueur reconnu : la carte l\'affiche sans savoir QUAND il sert.' })),
        ],
        recommendation: sansRepo.length ? 'Un skill hors dépôt est une perte irréversible en attente (A1).'
          : derive.size ? 'Pousser les dépôts en dérive — le garde-fou d\'A1 mord ici en continu, plus seulement pendant la sauvegarde.' : null,
      });
    }
  }

  // ---- score global pondéré ----
  // Les dimensions « non mesurées » (score null) sont EXCLUES du calcul : les inclure à 0
  // accuserait à tort, à 100 rassurerait à tort. Leur absence est dite dans le résumé.
  const notes = dims.filter(d => d.score != null);
  const wsum = notes.reduce((s, d) => s + d.weight, 0) || 1;
  const score = Math.round(notes.reduce((s, d) => s + d.score * d.weight, 0) / wsum);
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'E';
  const reds = dims.filter(d => d.status === 'red');
  const grises = dims.filter(d => d.score == null);
  const totalFindings = dims.reduce((s, d) => s + (d.items ? d.items.length : 0), 0);

  return {
    score, grade,
    status: score >= 80 ? 'green' : score >= 55 ? 'orange' : 'red',
    // Le résumé DIT ce qu'il ne couvre pas — loi nº2 : une note qui tait son périmètre
    // rassure exactement comme une note qui le couvre.
    summary: `Santé de la carte : ${score}/100 (${grade})`
      + (reds.length ? ` — ${reds.length} dimension(s) critique(s) : ${reds.map(d => d.label).join(', ')}` : ' — aucun point critique')
      + (grises.length ? ` · ⚠ ${grises.length} dimension(s) NON MESURÉE(S), hors note : ${grises.map(d => d.label).join(', ')}` : ''),
    totalFindings,
    dimensionsNotees: notes.length,
    dimensionsNonMesurees: grises.map(d => d.key),
    dimensions: dims,
    generatedAt: now.toISOString()
  };
}
function sevRank(s) { return { critical: 0, high: 1, medium: 2, low: 3 }[s] ?? 4; }

/* ---------- F2 : mesure du VOCABULAIRE réellement en vigueur dans le schéma ----------
 * Heuristique jumelle de celle de la batterie du skill `audit-si` (mêmes seuils) : une colonne
 * texte à faible cardinalité sur beaucoup de lignes EST un vocabulaire, déclaré ou non. On lit
 * ensuite les CHECK RÉELLEMENT posés dans le DDL — pas ceux que le référentiel prétend poser :
 * une base recréée par un autre chemin peut très bien ne plus les porter.
 * (Le skill mesure toute base, karto mesure la sienne. Les seuils vivent aux deux endroits
 * volontairement : le skill doit rester utilisable sans karto, et karto sans le skill.) */
const VOCAB_MAX_DISTINCTES = 30, VOCAB_MIN_LIGNES = 10;
/* \u26a0\ufe0f La cardinalit\u00e9 SEULE sur-d\u00e9tecte, et je l'ai mesur\u00e9 en \u00e9crivant cette dimension : sur les
 * 6 tables de karto elle classait \u00ab vocabulaire \u00bb la prose des expositions (17 valeurs sur 17
 * lignes), les blobs JSON de `bridge.reach`, les horodatages de `last_synced`, les chemins de
 * fichiers et les ids d'entit\u00e9s \u2014 18 faux d\u00e9fauts. Un diagnostic qui invente du bruit s'apprend
 * \u00e0 \u00eatre ignor\u00e9 (c'est le motif que B1 a pay\u00e9 avec ses 26 fausses alertes). Deux discriminants
 * SOFTCOD\u00c9S, aucun nom de colonne en dur :
 *   \u00b7 un vocabulaire se R\u00c9P\u00c8TE \u2014 si presque chaque ligne a sa propre valeur, c'est du texte
 *     libre ou un identifiant, pas un vocabulaire (seuil : distinctes \u2264 60 % des lignes) ;
 *   \u00b7 ses valeurs sont des \u00c9TIQUETTES \u2014 courtes, sans chemin, sans JSON, sans horodatage,
 *     sans forme d'id \u00ab kind:slug \u00bb.
 * Une colonne portant d\u00e9j\u00e0 un CHECK \u2026 IN est un vocabulaire PAR D\u00c9CLARATION : elle \u00e9chappe \u00e0
 * l'heuristique (la base a tranch\u00e9, ce n'est plus \u00e0 une statistique de le faire). */
const VOCAB_RATIO_MAX = 0.6;
const estEtiquette = vals => {
  const moy = vals.reduce((s, v) => s + String(v).length, 0) / (vals.length || 1);
  if (moy > 40) return false;
  // Un chemin, pas « toute barre oblique » : « Gestion opérationnelle (retail/Apple) » est une
  // étiquette légitime, « /Users/Owner/… » n'en est pas une. Premier jet trop large, corrigé sur
  // mesure — il faisait disparaître `domaine`, l'une des colonnes que l'audit avait nommées.
  return !vals.some(v => /^[~/]|:\/\/|\/.*\//.test(String(v)) || /[{}]/.test(String(v))
    || /^\d{4}-\d{2}-\d{2}T/.test(String(v)) || /^[a-z_]+:[\w.-]+$/i.test(String(v)));
};
const normVal = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');

function mesureVocabulaire(db) {
  const q = s => db.prepare(s).all();
  const tables = q("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  // Colonnes citées dans un CHECK ... IN (...) — avec ou sans la forme « X IS NULL OR X IN (…) ».
  const sousCheck = new Set();
  for (const t of tables) for (const m of String(t.sql || '').matchAll(/CHECK\s*\(\s*(?:"?(\w+)"?\s+IS\s+NULL\s+OR\s+)?"?(\w+)"?\s+IN\s*\(/gi)) sousCheck.add(`${t.name}.${m[2]}`);
  const IGNORE = new Set(['id', 'src', 'dst', 'name', 'canonical', 'note', 'attrs', 'value', 'key', 'schema_json', 'recommendation']);
  const colonnes = [];
  for (const t of tables) {
    let cols = []; try { cols = q(`PRAGMA table_info("${t.name}")`); } catch { continue; }
    for (const c of cols) {
      if (!/TEXT|CHAR|CLOB|^$/i.test(c.type || '')) continue;
      if (IGNORE.has(c.name)) continue;
      const declaree = sousCheck.has(`${t.name}.${c.name}`);
      let r; try { r = db.prepare(`SELECT COUNT(*) lignes, COUNT(DISTINCT "${c.name}") distinctes FROM "${t.name}" WHERE "${c.name}" IS NOT NULL AND "${c.name}" <> ''`).get(); } catch { continue; }
      if (!r || !r.lignes) continue;
      const vals = q(`SELECT DISTINCT "${c.name}" v FROM "${t.name}" WHERE "${c.name}" IS NOT NULL AND "${c.name}" <> ''`).map(x => x.v);
      if (!declaree) {   // vocabulaire PRÉSUMÉ : l'heuristique doit alors être stricte
        if (r.lignes < VOCAB_MIN_LIGNES) continue;
        if (r.distinctes < 2 || r.distinctes > VOCAB_MAX_DISTINCTES) continue;
        if (r.distinctes > r.lignes * VOCAB_RATIO_MAX) continue;
        if (!estEtiquette(vals)) continue;
      }
      const paquets = new Map();
      for (const v of vals) { const k = normVal(v); paquets.set(k, [...(paquets.get(k) || []), v]); }
      colonnes.push({
        table: t.name, colonne: c.name, lignes: r.lignes, distinctes: r.distinctes, contrainte: declaree,
        collisions: [...paquets.values()].filter(g => g.length > 1),
        exemples: vals.slice(0, 6).map(v => String(v).slice(0, 60)),
      });
    }
  }
  return colonnes;
}

/* ---------- F2 : invariants d'intégrité, mesurés EN DIRECT sur la base ----------
 * Volontairement recalculés ici et non lus dans meta : ce sont des faits sur ce que la base
 * CONTIENT, et deux vérités calculées séparément divergent au premier renommage. Ce qui vient
 * de meta.invariants, c'est uniquement ce que la base ne peut pas montrer : le refusé. */
function mesureIntegrite(db, invariants) {
  const q = s => db.prepare(s).all();
  const un = s => db.prepare(s).get();
  const pendantes = un('SELECT COUNT(*) n FROM edge e LEFT JOIN entity s ON s.id=e.src LEFT JOIN entity d ON d.id=e.dst WHERE s.id IS NULL OR d.id IS NULL').n;
  const tripletsDupliques = un('SELECT COUNT(*) n FROM (SELECT src,dst,rel FROM edge GROUP BY src,dst,rel HAVING COUNT(*)>1)').n;
  const doublons = q("SELECT kind, canonical, COUNT(*) n FROM entity WHERE canonical<>'' GROUP BY kind, canonical HAVING n>1");
  const homonymes = un("SELECT COUNT(*) n FROM (SELECT canonical FROM entity WHERE canonical<>'' GROUP BY canonical HAVING COUNT(*)>1)").n;
  const ddlEdge = String((q("SELECT sql FROM sqlite_master WHERE type='table' AND name='edge'")[0] || {}).sql || '');
  const fk = /REFERENCES/i.test(ddlEdge);
  const unique = q("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='edge' AND sql LIKE '%UNIQUE%'").length > 0
    || /UNIQUE\s*\(\s*src\s*,\s*dst\s*,\s*rel\s*\)/i.test(ddlEdge);
  // Clés de jointure inter-systèmes : leur validité EST la condition de la jointure (D5/D6).
  const clesMetier = [];
  const inv = invariants || {};
  if (inv.siren) clesMetier.push({ nom: 'SIREN', avec: 'la comptabilité moncompta', porteurs: inv.siren.porteurs, malformes: inv.siren.malformes || [], doublons: inv.siren.doublons || [] });
  const tokens = q("SELECT json_extract(attrs,'$.token') t, COUNT(*) n FROM entity WHERE kind='site' AND json_extract(attrs,'$.token') IS NOT NULL GROUP BY t");
  if (tokens.length) clesMetier.push({
    nom: 'token de site', avec: 'la colonne site des tables comm_* de polar', porteurs: tokens.length,
    malformes: tokens.filter(t => !/^[a-z0-9][a-z0-9-]*$/.test(String(t.t))).map(t => String(t.t)),
    doublons: tokens.filter(t => t.n > 1).map(t => `${t.t} ×${t.n}`),
  });
  return { pendantes, tripletsDupliques, doublons, homonymes, fk, unique, clesMetier, invariants };
}

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
  const skillsInv = readJson('skills_inventory.json', {});
  const probe = readJson('mcp_probe.json', null);

  // Invariants persistés par le dernier build (F2). Absents = build antérieur : la dimension
  // le DIT au lieu de compter 0 refus.
  let invariants = null;
  try { const r = db.prepare("SELECT value FROM meta WHERE key='invariants'").get(); if (r) invariants = JSON.parse(r.value); } catch { /* base d'avant F2 */ }

  let vocabulaire = null, integrite = null;
  try { vocabulaire = { colonnes: mesureVocabulaire(db), horsReferentiel: (invariants && invariants.vocabulaireInconnu) || [] }; } catch { /* schéma illisible → non mesuré */ }
  try { integrite = mesureIntegrite(db, invariants); } catch { /* idem */ }

  /* Ce que la CARTE déclare des serveurs MCP, pour le confronter à la mesure du handshake.
   * Le rapprochement se fait sur le nom du serveur tel qu'il apparaît dans la config du client
   * (`attrs.mcpServer`), sinon sur le nom canonique du connecteur — un identifiant d'abord, un
   * nom ensuite : l'ordre de réconciliation retenu en D3. */
  const mcpDeclare = q("SELECT id, canonical, name, attrs FROM entity WHERE kind='connector'").map(e => {
    let a = {}; try { a = typeof e.attrs === 'string' ? JSON.parse(e.attrs) : (e.attrs || {}); } catch {}
    return { id: e.id, serveur: a.mcpServer || e.canonical, readonly: a.readonly, outils: Array.isArray(a.tools) ? a.tools.length : null };
  });

  return computeDiagnostics({
    sources: srcReg.sources || [],
    entities: q('SELECT id,kind,name,canonical,criticite,cycle,statut,attrs FROM entity'),
    edges: q('SELECT src,dst,rel FROM edge'),
    secretRefs: q('SELECT name,store,category FROM secret_ref'),
    bridges: q('SELECT name,last_indexed FROM bridge'),
    exposures: disk.exposures || [],
    dataAssets: da.assets || [],
    lastSync: sync.lastSync || null,
    vocabulaire, integrite, mcpProbe: probe, mcpDeclare,
    skills: skillsInv.skills || null,
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
    const ic = { green: '🟢', orange: '🟠', red: '🔴', grey: '⚪' };
    console.log(`\n  ${ic[d.status]} ${d.summary}\n`);
    // Une dimension non mesurée s'affiche « — » et pas « null » : le tiret se lit comme une
    // absence, un nombre se lit comme un résultat.
    for (const dim of d.dimensions) console.log(`  ${ic[dim.status] || '⚪'} ${(dim.score == null ? '—' : String(dim.score)).padStart(3)} · ${dim.label} — ${dim.note}`);
    const open = d.dimensions.flatMap(dim => (dim.items || []).map(it => ({ ...it, dim: dim.label })));
    if (open.length) {
      console.log(`\n  À corriger (${open.length}) — les ${Math.min(open.length, 24)} plus graves :`);
      for (const it of open.sort((a, b) => sevRank(a.severity) - sevRank(b.severity)).slice(0, 24)) console.log(`   · [${it.severity}] ${it.dim} — ${it.label}`);
    }
    console.log('');
  } else {
    console.log(JSON.stringify(d, null, 2));
  }
}
