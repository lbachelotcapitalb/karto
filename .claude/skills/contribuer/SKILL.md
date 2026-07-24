---
name: contribuer
description: >-
  Préparer une contribution propre et adoptable à karto, de bout en bout : fork à jour, branche
  courte, respect des 5 principes, garde de build, puis PR petite et prête à relire. Utilise ce
  skill quand tu commences à coder une feature ou un fix sur karto. Version exécutable de
  CONTRIBUTING.md.
---

# contribuer — faire une PR karto adoptée vite

Tu contribues à **karto** (outil open-source, zéro dépendance, local-first). `main` est protégé :
tu proposes via une **PR** depuis ta branche, un mainteneur relit et merge. Ce skill te met (toi et
ton IA) sur les bons rails. Lis aussi `CONTRIBUTING.md` (les **5 principes** y sont non négociables)
et `AGENTS.md` (le modèle de données). Pour l'architecture interne, vois le skill `/architecture-karto`.

## 0. Avant de coder — base à jour

```bash
git remote add upstream https://github.com/lbachelotcapitalb/karto.git   # une seule fois
git fetch upstream
git checkout -b feat/<sujet> upstream/main      # branche COURTE
```

**Prérequis :** Node ≥ 22 recommandé. **Aucun `npm install`** : karto s'appuie sur Node natif
(`node:sqlite`, WebCrypto) et du HTML/CSS/JS vanilla.

## 1. Les 5 principes (une PR qui les ignore est refusée)

1. **Local-first & souverain** — aucune valeur de secret ne quitte la machine, aucun appel réseau au runtime.
2. **Zéro dépendance** — pas de `package.json`. Toute dépendance ajoutée doit être très fortement justifiée (défaut : non).
3. **Softcode total** — rien de spécifique à un utilisateur en dur ; identité dans `karto.config.json`, donnée dans `data/*.json`.
4. **Données ≠ code** — l'écriture ne mute que `data/*.json`, jamais le code, et **refuse toute valeur ressemblant à un secret**.
5. **Lecture seule par défaut** — le MCP n'écrit que si `--write` explicite.

## 2. La garde — avant la PR

```bash
node karto-db.mjs build      # construit karto.db depuis data/*.json — doit passer
node build.mjs --plain       # construit un dashboard de test (topologie EN CLAIR, AUCUN secret)
```

> ⚠️ Ne lance **jamais** `karto-init.mjs` ni `build.mjs --with-secrets` sur le dossier live pendant
> le dev : ça re-chiffre `index.html` avec une nouvelle passphrase. Pour tester l'init, copie le
> dossier ailleurs (`cp -r karto /tmp/karto-test`). **Contribuer n'exige aucun secret.**

## 3. Auto-audit — avant de déranger un mainteneur

- [ ] `node karto-db.mjs build` et `node build.mjs --plain` passent.
- [ ] **Aucune valeur de secret** ni identifiant personnel dans le code, les data, les tests, les commits.
- [ ] Aucune dépendance externe ajoutée (ou justifiée dans la PR).
- [ ] Diff petit et ciblé ; style cohérent (JS pur ESM, imports `node:`).

## 4. Ouvre la PR

```bash
git push -u origin feat/<sujet>
gh pr create --repo lbachelotcapitalb/karto --base main
```

Remplis le template (quoi & pourquoi, comment tester, checklist des 5 principes). Petit + vert +
respectueux des principes = mergé vite.
