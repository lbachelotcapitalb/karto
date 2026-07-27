// cron-schedule.mjs — évaluation d'un planning cron, partagée par les DEUX consommateurs :
//   • runs-collect.mjs (Mac)             → alimente karto en lastRun / lastStatus
//   • veille/vps/cron_beats_check.mjs    → ta veille de sécurité, exécuté SUR le VPS
//
// Pourquoi un module et pas deux copies : B1 a montré qu'une même vérité calculée à deux
// endroits diverge au premier ajustement. Le verdict « ce cron ne part plus » doit être le
// même dans le tableau de bord et dans l'alerte, sinon l'un des deux ment.
//
// Choix de conception (repris de B1, mesuré) : on évalue le planning POUR DE VRAI — les
// derniers instants de déclenchement — au lieu d'estimer une période moyenne. Un job du mardi
// dont le dernier passage date de dimanche est en panne ; une période moyenne de 7 jours le
// déclare normal.

// Un champ cron accepte-t-il cette valeur ? (listes, plages, pas — « */10 », « 5-13 », « 1,15 »)
export function fieldMatch(v, fld, min, max) {
  if (fld === '*') return true;
  for (const part of String(fld).split(',')) {
    const st = part.match(/\/(\d+)$/);
    const step = st ? Number(st[1]) : 1;
    const base = part.replace(/\/\d+$/, '');
    let lo, hi;
    if (base === '*') { lo = min; hi = max; }
    else {
      const r = base.match(/^(\d+)-(\d+)$/);
      if (r) { lo = Number(r[1]); hi = Number(r[2]); }
      else { const n = Number(base); if (Number.isNaN(n)) continue; lo = hi = n; }
    }
    if (v < lo || v > hi) continue;
    if ((v - lo) % step === 0) return true;
  }
  return false;
}

const ALIAS = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
const LOOKBACK_MIN = 100 * 24 * 60;   // au-delà de 100 jours, on renonce à juger

// Les N derniers instants où ce cron aurait dû partir, en ms epoch (les plus récents d'abord).
// `tzOffsetMin` = décalage local de la MACHINE QUI EXÉCUTE le cron (cron lit son heure locale).
// Renvoie [] pour @reboot et pour tout planning non périodique : on ne juge pas ce qu'on ne
// sait pas prédire — c'est un silence assumé, pas un « tout va bien ».
export function lastFires(sch, nowMs, tzOffsetMin, want = 2) {
  const s = ALIAS[String(sch || '').trim()] || String(sch || '').trim();
  if (s.startsWith('@')) return [];
  const f = s.split(/\s+/);
  if (f.length < 5) return [];
  const [mi, h, dom, mon, dow] = f;
  const domSet = dom !== '*', dowSet = dow !== '*';
  const out = [];
  // On remonte minute par minute depuis la minute précédente : simple, exact, et borné.
  let t = Math.floor(nowMs / 60000) * 60000 - 60000;
  for (let i = 0; i < LOOKBACK_MIN && out.length < want; i++, t -= 60000) {
    const d = new Date(t + tzOffsetMin * 60000);           // bascule en heure locale de la machine
    if (!fieldMatch(d.getUTCMinutes(), mi, 0, 59)) continue;
    if (!fieldMatch(d.getUTCHours(), h, 0, 23)) continue;
    if (!fieldMatch(d.getUTCMonth() + 1, mon, 1, 12)) continue;
    const mDom = fieldMatch(d.getUTCDate(), dom, 1, 31);
    const wd = d.getUTCDay();
    const mDow = fieldMatch(wd, dow, 0, 7) || fieldMatch(wd + 7, dow, 0, 7);   // dimanche = 0 ou 7
    // Quirk cron historique : si jour-du-mois ET jour-de-semaine sont posés, c'est un OU.
    if (!(domSet && dowSet ? (mDom || mDow) : (mDom && mDow))) continue;
    out.push(t);
  }
  return out;
}
