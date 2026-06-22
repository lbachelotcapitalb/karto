# Contribuer à karto

Merci de t'intéresser à karto ! Ce projet est jeune, open source, et utile à tout le monde —
du non-technicien qui veut ranger sa vie numérique au dev qui veut cartographier son infra.
Toute aide est la bienvenue : code, doc, traduction, retours d'usage.

> Avant de coder, lis les **cinq principes de conception** ci-dessous. Une PR qui les respecte
> est acceptée vite ; une PR qui les ignore, même excellente techniquement, sera refusée.

## Les cinq principes (non négociables)

1. **Local-first & souverain.** Aucune valeur de secret ne quitte la machine. Aucun appel réseau
   au runtime du dashboard. Aucune télémétrie, aucun tracker.
2. **Zéro dépendance.** Pas de `package.json`, pas de `npm install`. On s'appuie sur Node natif
   (`node:sqlite`, `WebCrypto`) et du HTML/CSS/JS vanilla. Toute PR ajoutant une dépendance doit
   la justifier très fortement — la réponse par défaut est non.
3. **Softcode total.** Rien de spécifique à un utilisateur n'est codé en dur. L'identité et le
   périmètre vivent dans `karto.config.json` ; la donnée dans `data/*.json`.
4. **Données ≠ code.** L'écriture (y compris par une IA via le MCP) ne mute **que** `data/*.json`,
   jamais le code — et **refuse toute valeur ressemblant à un secret**.
5. **Lecture seule par défaut.** Le MCP n'écrit que si explicitement activé (`--write`).

## Mettre en place l'environnement

**Prérequis :** [Node.js](https://nodejs.org) ≥ 22 recommandé. Sur Node 18/20, karto bascule
automatiquement sur le binaire `sqlite3` (présent d'origine sur macOS ; sinon `brew install sqlite`
/ `apt install sqlite3`). Aucune autre installation.

```bash
git clone https://github.com/lbachelotcapitalb/karto.git
cd karto
node karto-db.mjs build        # construit la base de connaissances karto.db depuis data/*.json
node karto-query.mjs schema    # COMMENCE ICI : structure + KINDS + relations + exemples
node build.mjs --plain         # construit un dashboard de test (topologie en clair, AUCUN secret)
node karto-serve.mjs           # ouvre le dashboard en local (http://127.0.0.1)
```

> ⚠️ **Ne lance jamais `karto-init.mjs` ni `build.mjs --with-secrets` sur le dossier live** pendant
> le dev : ça re-chiffre `index.html` avec une nouvelle passphrase. Pour tester l'init, copie le
> dossier ailleurs (`cp -r karto /tmp/karto-test`).

## Architecture en 30 secondes

```
data/*.json ──┬──► build.mjs ──► index.html   (dashboard chiffré, jamais versionné)
 (vérité,     │
  zéro secret)└──► karto-db.mjs ──► karto.db ──┬──► CLI (karto-query.mjs)
                                               └──► MCP (karto-mcp.mjs)
```

| Tu veux toucher à… | Va voir… |
|---|---|
| Le contenu de la carte | `data/*.json` (la source de vérité) |
| L'UI du dashboard | `template.html` (vues, graphe, déchiffrement WebCrypto) |
| Le build / chiffrement | `build.mjs` |
| Le graphe requêtable | `karto-db.mjs`, `karto-query.mjs` |
| L'accès IA | `karto-mcp.mjs`, `AGENTS.md` |
| Le moteur SQLite portable | `karto-sqlite.mjs` |
| Le scan d'inventaire machine | `karto-collect.mjs` |

Docs de référence : [`AGENTS.md`](AGENTS.md) (point d'entrée IA) · [`BACKEND.md`](BACKEND.md)
(la base requêtable) · [`KARTO.md`](KARTO.md) (guide opérateur).

## Le flux de contribution

1. **Ouvre une issue d'abord** pour les changements non triviaux — qu'on aligne l'approche avant
   que tu écrives du code. Pour un petit fix évident, une PR directe suffit.
2. **Fork**, puis crée une branche : `git checkout -b feat/ma-fonctionnalite`.
3. **Code** en respectant les cinq principes et le style existant (voir ci-dessous).
4. **Teste** : `node karto-db.mjs build` doit passer, et `node build.mjs --plain` doit produire un
   dashboard. Si tu touches au MCP, vérifie `node karto-mcp.mjs` (liste des outils).
5. **Commit** avec un message clair (impératif, en français ou anglais).
6. **Ouvre une PR** : décris le quoi et le pourquoi, garde le diff petit et ciblé.

## Style de code

- **JavaScript pur, modules ES** (`.mjs`). Pas de TypeScript, pas de transpilation.
- Imports natifs `node:` (`node:fs`, `node:crypto`, `node:sqlite`…), jamais de paquet externe.
- Reste cohérent avec le fichier que tu modifies (nommage, indentation, densité de commentaires).
- Pas de framework front : `template.html` est du HTML/CSS/JS vanilla assumé.
- **Aucune valeur de secret** dans le code, les data, les tests, les commits. Jamais.

## Bons premiers tickets

Cherche le label **`good first issue`**. Quelques pistes ouvertes :

- 🌐 Une **API HTTP locale** (accès distant hors-MCP, avec token + OpenAPI).
- 🔍 De **nouveaux scanners** d'inventaire (services, conteneurs, navigateurs installés…).
- 🗝️ Des **connecteurs de coffres** : 1Password (`op`), KeePassXC (`keepassxc-cli`) —
  l'abstraction `provider` existe déjà dans `vault-connect.mjs`.
- 🪄 Un **assistant de premier lancement** (wizard) pour les non-techniciens.
- 🌍 **Internationalisation** : l'UI est aujourd'hui en français.

## Signaler une faille de sécurité

**N'ouvre pas d'issue publique pour une vulnérabilité.** karto manipule de la topologie sensible.
Contacte les mainteneurs en privé (voir `SECURITY.md` quand il existera, sinon par message direct).

## Licence

À définir (cible : licence permissive type MIT). En contribuant, tu acceptes que ton apport soit
publié sous la licence retenue par le projet.

---

Merci 🙏 — chaque carte rendue lisible, c'est un monde numérique de moins perdu dans une tête.
