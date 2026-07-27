// karto-refs.mjs — D4. Extraire d'un TEXTE les identifiants qu'il cite, et les résoudre vers
// des entités qui existent déjà. Un seul endroit, importé par skills-collect.mjs (extraction)
// et karto-db.mjs (résolution), pour la même raison qu'`EXECUTABLE_KINDS` en D1 : deux
// extracteurs écrits séparément divergent au premier ajustement, et personne ne le voit.
//
// DOCTRINE — c'est ce qui distingue ce module d'une heuristique de nom :
//  • on n'extrait que des IDENTIFIANTS (chemin, chemin de dépôt, serveur MCP, domaine),
//    jamais des noms d'objets. Joindre sur un identifiant est un fait ; joindre sur une
//    ressemblance de nom serait une supposition (D3).
//  • un candidat qui ne correspond à aucune entité n'écrit RIEN. L'échec produit une arête
//    absente — visible —, jamais une entité fabriquée (D2).
//  • une ambiguïté (deux entités au même chemin) n'est pas tranchée : elle est SIGNALÉE.
//    Choisir au hasard entre deux homonymes est exactement ce qui a produit les 5 arêtes
//    pendantes d'avant D2.

/* ---------------- extraction ----------------
 * Deux tokenisations de chemin, et TOUS les préfixes de chacune :
 *  - stricte (aucune espace) : attrape `~/linkedin` au milieu d'une phrase française ;
 *  - permissive (espaces internes) : attrape `~/Library/Application Support/MonApp`.
 * Un candidat aberrant né de la prose ne coûte rien puisqu'il ne résout pas. Le risque est de
 * MANQUER une référence, jamais d'en inventer une — c'est le sens dans lequel on veut échouer. */
const PATH_STRICT = /(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+|\/opt|\/srv|\/etc|\/var)(?:\/[^\s"'`,;)\]}<>]+)+/g;
const PATH_ESPACES = /(?:~|\/Users\/[^/\s]+)(?:\/[A-Za-z0-9._@+-]+(?: [A-Za-z0-9._@+-]+)*)+/g;
const RE_REPO = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[)\s`'",;\]]|$)/g;
const RE_MCP = /mcp__([a-zA-Z0-9_-]+)__/g;
const RE_DOMAINE = /\b((?:[a-z0-9-]+\.)+(?:fr|com|app|io|dev|net|eu|ai))\b/g;

// tous les préfixes d'un chemin, du plus long au plus court (`a/b/c` → a/b/c, a/b, a)
function prefixes(p) {
  const out = [];
  let cur = String(p).replace(/[.,;:)\]]+$/, '').replace(/\/+$/, '');
  while (cur.includes('/')) { out.push(cur); cur = cur.slice(0, cur.lastIndexOf('/')); }
  return out;
}

export function extraireReferences(texte, home) {
  const md = String(texte || '');
  const chemins = new Set();
  for (const re of [PATH_STRICT, PATH_ESPACES])
    for (const m of md.matchAll(re))
      for (const p of prefixes(m[0])) chemins.add(home && p.startsWith('~') ? home + p.slice(1) : p);
  const uniq = re => [...new Set([...md.matchAll(re)].map(m => m[1]))];
  return { paths: [...chemins].sort(), repos: uniq(RE_REPO), mcp: uniq(RE_MCP), domains: uniq(RE_DOMAINE) };
}

/* ---------------- résolution ----------------
 * `entites` = itérable d'objets {id, kind, name, canonical, path}. `home` sert à ramener les
 * `~` des fiches et des textes à la même écriture — sans quoi la moitié des chemins de la
 * carte ne s'apparieraient jamais à ceux d'un document, sans que rien ne le dise. */
export function indexReferences(entites, { home = '', canon = s => String(s || '').toLowerCase().trim(), slug = s => s } = {}) {
  const abs = p => String(p || '').replace(/^~/, home).replace(/\/+$/, '');
  const parChemin = new Map(), parRepo = new Map();
  const domaines = [], connecteurs = [];
  for (const e of entites) {
    // un chemin trop court (« /Users/Owner ») engloberait tout : on exige un chemin discriminant
    const p = abs(e.path);
    if (p && p.length >= 12 && p.split('/').length >= 4) { if (!parChemin.has(p)) parChemin.set(p, []); parChemin.get(p).push(e.id); }
    if (e.kind === 'repo') { const k = canon(e.name); if (!parRepo.has(k)) parRepo.set(k, []); parRepo.get(k).push(e.id); }
    if (e.kind === 'domain') domaines.push(e);
    if (e.kind === 'connector') connecteurs.push(e);
  }
  const ambigus = new Set(), sansSuite = new Set();
  // 0 candidat → null · 1 → l'id · >1 → ambiguïté SIGNALÉE, jamais tranchée
  const un = (ids, quoi) => {
    if (!ids || !ids.length) return null;
    if (ids.length > 1) { ambigus.add(`${quoi} → ${ids.length} entités (${ids.join(', ')})`); return null; }
    return ids[0];
  };
  return {
    ambigus, sansSuite,
    // le fichier cité appartient à l'entité dont le chemin est le PLUS LONG à le préfixer
    chemin(c) {
      const t = abs(c); let best = null;
      for (const [p, ids] of parChemin) if (t === p || t.startsWith(p + '/')) { if (!best || p.length > best.p.length) best = { p, ids }; }
      return best ? un(best.ids, `chemin « ${best.p} »`) : null;
    },
    repo(c) { return un(parRepo.get(canon(c)), `dépôt « ${c} »`); },
    mcp(c) {
      const k = canon(c);
      const hit = connecteurs.filter(e => e.canonical === k || e.id === 'connector:' + slug(c) || e.canonical === k + ' mcp');
      if (!hit.length) { sansSuite.add(`serveur MCP « ${c} » absent de la carte`); return null; }
      return un(hit.map(e => e.id), `serveur MCP « ${c} »`);
    },
    domaine(c) {
      const k = canon(c);
      const hit = domaines.filter(e => canon(e.name) === k || k.endsWith('.' + canon(e.name)));
      return un(hit.map(e => e.id), `domaine « ${c} »`);
    },
  };
}
