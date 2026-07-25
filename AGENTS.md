# AGENTS.md — karto, pour une IA

**karto est la base de connaissances du système d'information (SI).** Avant de raisonner, coder ou
débuguer quoi que ce soit qui touche à l'infra de l'utilisateur (un projet, une base, un compte, un
secret, une automatisation, un hébergeur), **interroge karto d'abord** : tout y est déjà cartographié
et croisé. Tu gagnes du temps et tu évites d'inventer.

## Comment interroger (3 surfaces, même base `karto.db`)

1. **Outils MCP** (si le serveur `karto` est connecté) — le plus direct :
   `karto_schema` (À APPELER EN PREMIER) · `karto_search` · `karto_entity` · `karto_impact` · `karto_sql`.
2. **CLI** : `node karto-query.mjs schema|search|entity|related|impact|sql|secrets|exposures|bridges`.
   Commence **toujours** par `node karto-query.mjs schema` (structure + exemples).
3. **SQL direct** (lecture seule) : `node karto-query.mjs sql "SELECT …"` ou l'outil `karto_sql`.

> Pour la vérité **à jour** du modèle, appelle `karto_schema` / `node karto-query.mjs schema` — les
> chiffres ci-dessous sont un instantané indicatif.

## Modèle de données — un graphe `entity` + `edge`

Tables : `entity`, `edge`, `secret_ref`, `exposure`, `bridge`, `vendor_domain`, `meta`.

- **entity** : `id` (ex. `project:myapp`), `kind`, `name`, `canonical`, `vendor`, `hosting`, `url`,
  `path`, `criticite`, `cycle`, `statut`, `cout`, `domaine`, `owner`, `doc` (texte plein, recherche
  LIKE), `attrs` (**JSON** — `json_extract(attrs,'$.stack')`).
- **edge** : `src`, `dst`, `rel` — graphe orienté. Convention : `src` **dépend de / pointe vers** `dst`.
- **secret_ref** : emplacements de secrets (`name`, `service`, `path`, `category`) — **jamais de VALEUR**.
- **exposure** : findings sécurité (`severity`, `what`, `location`, `recommendation`, + `status`).
- **bridge** : bases connectées + comment les requêter (`reach`, `schema_json`).

**kinds d'entité** (instantané) : automation, service, account, bridge, ea_asset, repo, project,
database, launchagent, runtime, data_asset, connector, cli, domain, scenario, workload, host, webhook,
device.

**relations** (`edge.rel`, instantané) : appartient, code, dns, domaine, dépend de, déployé, email,
fourni par, héberge, lié, planifie, repo, scénario, stocké-sur, sur, tourne-sur, utilise.

## Recettes (question → requête)

| Question | Comment |
|---|---|
| Où vit la clé X / un secret ? | `karto_search("X")` puis `karto_entity` ; ou `sql` sur `secret_ref` |
| Qu'est-ce qui casse si Y tombe ? | `karto_impact("Y")` (transitif, arêtes entrantes) |
| Fiche d'un projet + ses dépendances | `karto_entity("myapp")` (voisins du graphe) |
| Actifs critiques | `sql "SELECT name,vendor FROM entity WHERE criticite='Critique'"` |
| Secrets critiques en clair | `sql "SELECT name,service,path FROM secret_ref WHERE category='critical'"` |
| Qui utilise Supabase | `sql "SELECT src FROM edge WHERE rel='utilise' AND dst LIKE '%supabase%'"` |
| Stack d'un projet | `sql "SELECT name,json_extract(attrs,'$.stack') FROM entity WHERE kind='project'"` |
| Où requêter une base réelle | `node karto-query.mjs bridges` |

## Règles

- **Lecture seule.** `karto_sql` n'accepte que `SELECT`/`WITH` ; la base est ouverte en read-only.
- **Aucune valeur de secret** n'est dans karto — seulement noms/emplacements. Ne tente pas d'en extraire.
- **Rafraîchir** après un changement du SI : `node karto-index.mjs` (collect + bridges + build), ou au
  minimum `node karto-db.mjs build`. Le build affiche la **dérive** depuis le dernier build.
- **Moteur** : Node ≥ 22 (`node:sqlite`) ou repli binaire `sqlite3` (Node 18/20) — transparent.

## Pour aller plus loin
- `BACKEND.md` — spec détaillée du backend requêtable.
- `KARTO.md` — guide opérateur (rebuild/deploy, sync réalité, passphrase).
- `README.md` — vues du dashboard + installation du serveur MCP (`node install-mcp.mjs`).
- `agent.schema.json` — format d'un manifeste d'agent (`agent.json`) que karto cartographie.

## Écriture / curation (opt-in)

Par défaut le MCP est **lecture seule**. Si le serveur tourne avec `KARTO_MCP_WRITE=1`
(`node install-mcp.mjs --write`), 7 outils d'**édition** s'ajoutent — ils mutent **uniquement
`data/*.json`** (jamais le code), avec validation + backup + merge idempotent :

- `karto_add_account` {provider, identity?, email?, url?, plan?, category?, note?} — `category:"IA"` ⇒ onglet IA.
- `karto_set_attribut` {name, key, value} — key ∈ criticite|cycle|cout|statut|domaine|type|vendor|hosting (crée l'actif si absent).
- `karto_add_dependance` {from, to, note?} — rayon d'impact.
- `karto_add_exposure` {what, severity?, where?, recommendation?, status?}.
- `karto_add_data_asset` {label, sensibilite?, …}.
- `karto_add_project` {name, hosting?, stack?, …}.
- `karto_rebuild` — reconstruit `karto.db` après écritures.

Règles d'écriture : **jamais de valeur de secret** (refus si motif token) ; enums validés ;
après une série d'écritures, appeler `karto_rebuild`. Le **visuel chiffré** n'est mis à jour
qu'au rebuild du coffre (passphrase) — barrière humaine volontaire. Sert à **onboarder ce que le
sync ne voit pas** : comptes SaaS, criticité, coût, dépendances, expositions.

## Construire une carte depuis zéro — onboarding piloté par TOI, l'IA

Quand l'utilisateur vient d'installer karto (carte quasi vide) ou te dit *« aide-moi à compléter
ma carte »*, tu ne te contentes pas de répondre à des requêtes : **tu construis la carte avec lui**,
en l'interviewant. La popup du dashboard affiche une **jauge de complétude** (0→100 %) tant que la
colonne vertébrale n'est pas posée ; ton travail est de la faire monter jusqu'à 100 %.

**La boucle (répète-la jusqu'à 100 %) :**

1. **Lis l'état.** Appelle `karto_setup_status` (ou `node karto-query.mjs setup`). Tu obtiens
   `{score, missing[], nextActions[]}` — exactement ce que voit la jauge (même source de vérité).
2. **Interviewe**, un sujet manquant à la fois (ne noie pas l'utilisateur). Pour chaque `missing` :
   pose une question simple en langage naturel, écoute, reformule pour confirmer **avant d'écrire**.
   N'invente jamais une donnée ; si l'utilisateur ne sait pas, passe et note-le.
3. **Écris** ce qu'il te donne :
   - **Ton identité** → édite `karto.config.json` (`owner.name`). C'est un fichier, pas un outil MCP.
   - **Comptes** → `karto_add_account`, ou guide-le vers `node vault-connect.mjs detect` (le coffre
     renseigne comptes **et** emplacements de secrets d'un coup, sans jamais lire les valeurs).
   - **Projet** → `karto_add_project` (name, hosting, stack…).
   - **Hébergement** → via `karto_add_project {hosting}` / `karto_set_attribut {key:"hosting"}`, ou
     un scan machine (`node karto-index.mjs`).
   - **Emplacement de secret** → surtout via `vault-connect` ; jamais la **valeur**, seulement l'*où*.
   - **Dépendance** → `karto_add_dependance {from, to}` : ce qui donne le « si ça tombe, quoi casse ».
4. **Reconstruis** : `karto_rebuild` (met à jour `karto.db` ; le coffre chiffré, lui, se rebuild à
   part avec la passphrase — barrière humaine).
5. **Reboucle** : rappelle `karto_setup_status`. Le score a monté. Continue jusqu'à `complete:true`.

Une fois à 100 %, invite à la **revue sécurité** (onglet « Sécurité & données » / `karto_exposures`) :
secrets en clair, bases sans sauvegarde, comptes morts remontent là. La carte est vivante — on
l'enrichit ensuite au fil de l'eau, jamais en une fois.
