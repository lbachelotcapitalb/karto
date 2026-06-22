# BACKEND.md — la base de connaissances requêtable de karto

> 🤖 IA : commence par **AGENTS.md** (point d’entrée) ou l’outil MCP `karto_schema`.

> karto n'est plus seulement un dashboard chiffré : c'est un **backend que l'IA interroge**
> pour sourcer et croiser tout ton SI sans relire 10 fichiers. Ce doc décrit ce backend.
> Manifeste topologie/dashboard : `KARTO.md`. Suggestions de développement : `SUGGESTIONS.md`.

## Idée
Les `data/*.json` (topologie rédigée, sans secrets) sont **matérialisés** dans une base
SQLite locale **`karto.db`** : un graphe de connaissances `entity` + `edge`. Une session
Claude (ou toi) l'interroge en CLI (`karto-query.mjs`) — recherche plein-texte, fiche d'un
actif + ses voisins, ou **SQL libre en lecture seule** pour croiser n'importe quoi.

Le « **bridge des bases connectées** » (`data/bridges.json`) recense *toutes* les bases où
vit ta donnée (Supabase ×N, Postgres local, IndexedDB des apps, Bitwarden, Drive…) **avec la
commande pour les requêter** et un **instantané de schéma** (tables/colonnes, jamais de lignes)
pour celles atteignables localement.

Tout est **softcode** : rien de spécifique au propriétaire n'est codé en dur. L'identité et le périmètre
vivent dans `karto.config.json`. Pour transmettre karto vierge → voir « Transmettre » plus bas.

## Zéro dépendance
`node:sqlite` (intégré à Node ≥ 22) + le CLI `sqlite3` système. Pas de `package.json`,
pas de `npm install`. Cohérent avec le reste de karto.

## Les outils (tous à la racine du projet)
| Commande | Rôle |
|---|---|
| `node karto-collect.mjs` | Scanne le Mac (périmètre = `karto.config.json`) → `data/machine_inventory.json`. Présence/noms/topologie uniquement, **jamais de valeur de secret**. Repos, runtimes, CLIs (état d'auth), launchd, bases locales, hôtes SSH, serveurs MCP. |
| `node karto-bridge.mjs gen` | Dérive `data/bridges.json` depuis `cloud_inventory` + `machine_inventory` (Supabase, Postgres local, IndexedDB, Bitwarden, Drive…). |
| `node karto-bridge.mjs probe` | Sonde le **schéma** des bridges atteignables ici (fichiers SQLite ; Postgres si `DATABASE_URL` en env). Les bases distantes restent « registered » (sondage via MCP/PAT en session). |
| `node karto-db.mjs build` | (Re)construit `karto.db` depuis tous les `data/*.json` + `bridges.json`. |
| `node karto-query.mjs …` | **L'interface IA.** Voir ci-dessous. |
| `node karto-index.mjs` | Pipeline complet : collect → bridge gen → probe → db build. |

`karto.db` est un **artefact régénérable** (gitignoré, comme `index.html`). On le reconstruit, on ne le versionne pas.

## Interroger (pour l'IA — commence toujours par `schema`)
```bash
node karto-query.mjs schema                 # structure des tables + KINDS + relations + exemples
node karto-query.mjs stats                  # compteurs
node karto-query.mjs search supabase resend # recherche plein-texte (toutes entités)
node karto-query.mjs entity myapp       # fiche complète + voisins du graphe
node karto-query.mjs related "Hetzner VPS" 2# voisinage graphe (profondeur 2)
node karto-query.mjs secrets --critical     # emplacements de secrets critiques (sans valeurs)
node karto-query.mjs exposures              # expositions de sécurité
node karto-query.mjs bridges                # bases connectées + comment les requêter
node karto-query.mjs sql "SELECT name,criticite,cout FROM entity WHERE criticite='Critique'"
```
La sous-commande `sql` est **lecture seule** (SELECT/WITH/EXPLAIN, une seule requête). Sortie JSON.

## Schéma de `karto.db`
- **`entity`** — un nœud par chose. `id` (`project:myapp`…), `kind`
  (`project|account|database|repo|host|automation|scenario|connector|webhook|ea_asset|data_asset|device|runtime|cli|launchagent|ssh_host|bridge`),
  `name`, `canonical`, `vendor`, `hosting`, `url`, `path`, `status`, `criticite`, `cycle`,
  `statut`, `cout`, `domaine`, `owner`, `source` (fichier d'origine), `doc` (texte recherche),
  `attrs` (JSON détaillé — interroge avec `json_extract(attrs,'$.stack')`).
- **`edge`** — `src`, `dst` (ids d'entité), `rel` (`utilise|déployé|héberge|repo|planifie|lié|tourne-sur…`), `source`.
- **`secret_ref`** — emplacements de secrets (nom, service, propriétaire, chemin, `store`, `category`). **Aucune valeur.**
- **`exposure`** — `severity`, `what`, `location`, `recommendation`.
- **`bridge`** — bases connectées : `kind`, `target`, `reach` (JSON : comment y accéder), `status`, `schema_json`.
- **`vendor_domain`**, **`meta`** — résolution de logos + horodatage de build.

L'enrichissement EA (criticité/cycle/coût curatés dans `ea_inventory.json`) est **fusionné** sur
l'entité de même nom : un `project` porte donc sa criticité issue de l'EA. Les liens cross-source
sont résolus par nom canonique (`byCanon`).

## Confidentialité
`karto.db` contient la **topologie** (même sensibilité que `data/*.json`) — **aucune valeur de
secret**, jamais de ligne de donnée métier (les bridges ne stockent que des **schémas**). Les
valeurs de secrets ne vivent que chiffrées dans `index.html` (cf. `build.mjs --with-secrets`).

## Rafraîchir
```bash
node karto-index.mjs                         # tout le backend (collect + bridges + db)
# puis, pour répercuter dans le dashboard chiffré (garde-fou passphrase) :
node karto-sync.mjs rebuild --passphrase "…"
```

## Transmettre karto vierge à quelqu'un
1. Vider `data/*.json` (garder les `_meta`/`_doc` comme gabarits) ; remettre `owner` à `""` dans `karto.config.json`.
2. Ajuster `scan.projectRoots` à SES dossiers.
3. `node karto-index.mjs` → il obtient SON inventaire machine + SES bridges, et `karto.db` se
   peuple tout seul. Aucune ligne de code à toucher : tout dérive de la config et des data.
