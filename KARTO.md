# KARTO.md — manifeste de synchronisation

> Lis ce fichier avant de modifier karto. Il dit **quoi** karto recense, **où** sont les données,
> et **comment** garder la carte alignée avec la réalité. Pensé pour être lu par n'importe quelle
> conversation Claude Code, pas seulement celle qui a créé karto.

## Qu'est-ce que karto
Tableau de bord **autonome et chiffré** de tout le SI de Owner (architecture d'entreprise, style Boldo) :
projets, comptes, bases, hébergements, automatisations, connecteurs, secrets, expositions de sécurité,
+ un inventaire d'actifs EA (criticité, cycle de vie TIME, coûts). Un seul `index.html` chiffré (AES-256,
passphrase). Emplacement : **`/Users/Owner/Documents/Claude/Projects/cartographie-it/`**.

## Source de vérité = les `data/*.json` (texte clair, sans valeurs de secrets)
| Fichier | Contenu | Qui le met à jour |
|---|---|---|
| `data/disk_inventory.json` | Projets locaux, env (NOMS only), CI, automatisations, **exposures** sécurité | agents (édition) + `apply` |
| `data/cloud_inventory.json` | Comptes/identités, Supabase, GitHub, Make, Netlify, Hetzner, Cloudflare, Drive, **domaines** (`domains.list` : DNS/héberg/email, dérivés du DNS réel) | agents + `apply` (gh/Supabase) |
| `data/ea_inventory.json` | Actifs EA (type, domaine, éditeur, criticité, cycle TIME, statut, coût) | agents (édition) |
| `data/business_units.json` | **Business Units** sous ombrelle Mon Organisation (statut/cycle de vie, membres, domaines) → kind `business_unit`. Ajouter/fusionner/réformer une BU = éditer ici puis rebuild | agents (édition) |
| `data/gouvernance_agentique.json` | **Gouvernance agentique** : palier d'autonomie (lecture/draft/write-back/publie-auto/outil/infra) + risque dominant (correctness/control-plane/human-system) + relecture + trace, par automatisation (clé = bout unique du nom, convention automation_plain). Rendu : `node gouvernance.mjs` | agents (édition) |
| `data/sync_log.json` | Journal des syncs + empreinte | `karto-sync.mjs` |
| `data/sources.json` | **Répertoire des sources à sourcer** (méthode de collecte, cadence, fraîcheur par source). État : `node karto-sources.mjs` | collecteurs (`touchSource`) |
| `data/skills_inventory.json` | Skills Claude auto-extraits → entités `kind:skill` + edges agent→skill dans karto.db | `skills-collect.mjs` |

`index.html` est un **artefact rendu** depuis ces JSON. Les éditer ne suffit pas : il faut **rebuild**.

## Le front est SOFTCODE — deux fichiers, pas du code (lot G, 29/07/2026)
Constat du 28/07 : le backend avait appris à mesurer (12 dimensions de diagnostic, handshake MCP,
crontab des machines) sans que le front n'en montre rien, parce que chaque vue était une fonction
écrite à la main et chaque source un `readFileSync` en dur. Corrigé par deux fichiers :

| Fichier | Rôle | Règle |
|---|---|---|
| `data/payload_manifest.json` | **registre complet** des `data/*.json` : `payload` (embarqué tel quel sous une clé) · `builtin` (transformé par build.mjs) · `out` (hors carte, avec motif) | ajouter une source générique = **une ligne**, aucun code |
| `data/ui_sections.json` | le **rail**, les sous-onglets, et les vues génériques (`blocks` → primitives `table` · `kv` · `kvEach` · `findings`) | ajouter une vue = **une entrée**, aucun JS |

Primitives dans `template.html` : `genTable` (colonnes déclarées ou union des clés), `genKv` /
`genKvEach` (forme **déduite** : liste → compteur + chips, `"non mesuré"` en gris, objet → dépliable),
`genFindings` (`{severity,label,where,fix}`). Une vue générique **sans donnée disparaît du rail** :
c'est ce qui rend le descripteur réutilisable par un tiers qui n'a pas les mêmes sources.
Garde-fou : `node front-audit.mjs` (bloquant en CI/cron). Rail câblé de repli (`GROUPS_FALLBACK`)
si le descripteur manque. **Ne recode jamais une vue en dur** : si une donnée ne s'affiche pas,
la réponse est une entrée de descripteur, ou une primitive de plus — jamais un `renderXxx()`.

## Vocabulaire fermé — `data/karto_vocabulary.json` (roadmap D1, 26/07/2026)
**Source de vérité unique** des types d'entités, des relations et des valeurs contrôlées.
Ce n'est pas de la documentation : le fichier est importé par `karto-vocab.mjs`, qui (1) normalise
à l'ingestion, (2) **signale** toute valeur inconnue en fin de build, (3) **génère les contraintes
CHECK** de `karto.db`. Éditer le JSON change le comportement du build — et rien d'autre à toucher.

```bash
node karto-vocab.mjs      # affiche le vocabulaire en vigueur + les CHECK générés
```

| Ce qui est fermé | Où |
|---|---|
| **17 kinds** (25 avant D1) | `entity.kind` — CHECK. `vps_cron`/`launchagent`/`scenario`/`webhook` → `automation` + `attrs.runner` ; `service` → `account` ; `runtime` → `cli` ; `device` → `host` ; les alias SSH → `attrs.sshAliases` de l'hôte |
| **25 rel** | `edge.rel` — CHECK. `héberge`+`repo` → `hébergé-chez` (l'ancien libellé se lisait à l'envers), `domaine` → `sert-sur`, `chaîne` → `déclenche`, `lié`/`déployé`/`sur`/`scénario` re-typés |
| `statut`, `criticite`, `cycle` | CHECK, NULL autorisé |
| `store`, `category`, `severity`, `bridge.status`, `source.status` | CHECK |
| `domaine`, `owner` | **enums ouverts** — pas de CHECK : une nouvelle ligne d'activité est une décision métier, pas un défaut |

⚠️ **La colonne `entity.status` n'existe plus.** Elle empilait quatre vocabulaires (indexation d'un pont,
auth d'un CLI, santé côté fournisseur, « en service ») et faisait doublon pur de `statut`. Règle :
**l'intention vit dans `statut`, l'état observé vit dans `attrs`** (`lastStatus`, `probe`, `auth`,
`providerHealth`). Ne pas réintroduire une colonne d'état à côté de `statut`.

**« Ce qui s'exécute » a UNE définition** : `EXECUTABLE_KINDS` dans `karto-vocab.mjs`, importée par
`karto-db`, `karto-scenarios`, `karto-diagnostics` et `gouvernance`. Avant D1 ces quatre fichiers
portaient chacun sa liste, et trois d'entre elles ignoraient les 41 crons du VPS. Ne recopie jamais
cette liste : importe-la.

## Backend requêtable — `karto.db` (voir `BACKEND.md`)
Au-delà du dashboard, les `data/*.json` sont matérialisés dans une base SQLite **`karto.db`**
(graphe `entity` + `edge`) que **l'IA interroge en CLI** pour sourcer/croiser le SI sans tout relire :
```bash
node karto-index.mjs              # collect (Mac) + bridges + (re)build karto.db
node karto-query.mjs schema       # À LIRE EN 1er : structure + exemples
node karto-query.mjs sql "SELECT name,criticite FROM entity WHERE criticite='Critique'"
```
Le « **bridge des bases connectées** » = `data/bridges.json` (toutes les bases où vit la donnée
+ la commande pour les requêter). Zéro dépendance (`node:sqlite`). `karto.db` est régénérable
(gitignoré). Confidentialité : topologie + emplacements de secrets uniquement, **jamais de valeur
ni de ligne métier**. Détail complet : **`BACKEND.md`**. Backlog/analyse : **`SUGGESTIONS.md`**.

## Sync automatique — cron hebdo (`karto-cron.sh`)
launchd **`com.karto.sync-weekly`** (lundi 09:10) fait tout ce qui ne demande pas la passphrase :
collecte Mac+VPS+runs GHA → `apply` → contrôle gouvernance/sources/coffre → rebuild `karto.db` →
commit/push `data/` → **signale via ton canal de notif** uniquement ce qui demande un humain (rebuild du coffre,
paliers manquants, sources périmées). Silencieux si propre. Le coffre chiffré n'est JAMAIS rebuildé
par le cron (garde-fou passphrase). ta veille de sécurité garde son audit quotidien (09:20).

## Vérifier / mettre à jour (commandes)
```bash
cd /Users/Owner/Documents/Claude/Projects/cartographie-it
node karto-sync.mjs status     # fraîcheur + empreinte (lecture seule)
node karto-sync.mjs audit      # DIFF réalité ↔ karto (gh + disque + Supabase si SUPABASE_ACCESS_TOKEN). N'écrit rien.
node karto-sync.mjs apply      # applique les écarts AUTO-découvrables dans data/*.json (+ backup data/.bak)
node karto-sync.mjs rebuild --passphrase "…"   # regénère index.html chiffré — GARDE-FOU passphrase
```

### 🔐 Garde-fou passphrase — NE PAS CONTOURNER (incident 15/07/2026)

**Ce qui s'est passé** : un coffre chiffré avec une passphrase **mal tapée** (la saisie est
masquée) a été déployé. Le fichier était parfaitement valide… mais ouvrable par **personne** :
Owner s'est retrouvé **verrouillé dehors de son propre dashboard**. Seules les sauvegardes
`/srv/karto/.backups` (une par deploy) ont permis de récupérer.

**La parade** : `.karto-key.json` mémorise le **kid** = empreinte PBKDF2-600k de la passphrase
canonique (irréversible, ne contient pas la passphrase, même coût d'attaque que le coffre).
Le kid est aussi écrit dans le payload du coffre → vérifiable **sans passphrase**.

| Étape | Comportement |
|---|---|
| `build.mjs` (chiffrement) | **REFUSE** de chiffrer si la passphrase ne donne pas le kid canonique — y compris avec `--no-merge` (c'était le trou). Rien n'est écrit. |
| `deploy-karto.sh` | **REFUSE** de publier un coffre dont le kid ≠ canonique, ou sans kid. Aucune passphrase requise. |
| `keycheck.mjs init` | Amorce la clé canonique — **exige** qu'elle ouvre réellement `index.html` (impossible de graver un typo). |
| `keycheck.mjs show` / `verify` | État / test d'une passphrase. |
| `restore-karto.sh` | Récupère depuis les backups VPS la sauvegarde la plus récente **portant le kid canonique**. |

```bash
node keycheck.mjs show                     # état (aucun secret affiché)
CARTO_PASS=… node keycheck.mjs init        # (ré)amorcer la clé canonique
./restore-karto.sh --list                  # quelles sauvegardes sont ouvrables
```

**Changer VOLONTAIREMENT de passphrase** : `node karto-sync.mjs rebuild --passphrase '…' --rekey`
→ actualise le kid canonique. **Sans `--rekey`, toute autre passphrase est un refus** — c'est voulu.

> ⚠️ Si un rebuild dit « PASSPHRASE INATTENDUE » : c'est presque toujours un typo. Retape.
> Ce n'est **pas** un bug, et `--rekey` n'est **pas** le contournement : il change la clé du coffre.

### Auto-découvrable (par `audit`/`apply`)
- **Dépôts & Actions GitHub** via `gh` (doit être authentifié).
- **Dossiers projet** nouveaux/disparus sous `~/Desktop` et `~/Documents/Claude/Projects`.
- **Projets Supabase** de tous les comptes **si** `export SUPABASE_ACCESS_TOKEN=sbp_…` (sinon ignoré).

### À éditer à la main (puis rebuild)
Tout le sémantique non machine-détectable : criticité/cycle/coût d'un actif, notes, nouveau connecteur SaaS,
renommage de service, exposition de sécurité, capacité métier. → édite le bon `data/*.json` puis rebuild.

### Architecture d'attributs des comptes (`accounts[].ids[]`)
Chaque attribut d'un compte porte une **catégorie** `cat` qui pilote son rendu dans l'onglet Comptes :
- `cat:'info'` — **softcode lecture seule** (refs, IDs, URLs, régions, IP, SSH, domaines…). Affiché en ligne d'info,
  jamais une case à remplir. Maintenu ici dans `data/cloud_inventory.json`, pas dans le navigateur.
- `cat:'secret'` — credential, avec **mode de stockage** `store` : `'here'` (valeur chiffrée dans le coffre karto) ·
  `'bw'` (référencé dans Bitwarden, non dupliqué) · `'none'` (**Sans stockage** volontaire — ex. master password
  Bitwarden : la clé qui déverrouille tout n'est jamais écrite dans karto).
- `cat:'id'` — identifiant éditable simple (login, compte). L'email du compte va dans le champ `email` (haut de fiche).

Convention : ne JAMAIS reclasser un secret `'none'`/`'bw'` en `'here'` sans valeur réelle. Les changements de
`cat`/`store`/valeur faits au navigateur sont reportés au rebuild (merge par clé `k`, cf. `build.mjs`). Squelette
par app et normalisation : `tools/migrate-accounts.mjs`.

## Connecteurs (MCP) — rafraîchir à la demande
Les données **Make.com, Cloudflare, Google Drive** ne viennent PAS d'un CLI/API token : elles ont été lues
via des **outils MCP**, qui n'existent que **dans une conversation Claude** (pas dans `karto-sync.mjs`).
Donc `karto-sync audit/apply` ne les touche pas — elles restent un **instantané** jusqu'à un refresh manuel.

Pour les rafraîchir (choix de Owner : **on-demand via Claude+MCP**, pas de token API) :
1. Ouvre/te trouves dans une conversation Claude **qui a les MCP concernés connectés** (Make, Cloudflare…).
2. Appelle **`karto_discover`** : il dit quelles sources sont périmées et donne le **moule** de payload.
3. Re-interroge le MCP source : Make → `scenarios_list` / `connections_list` / `hooks_list` (team 934955) ;
   Cloudflare → `workers_list` / `kv_namespaces_list` etc.
4. Reverse le résultat via **`karto_ingest {source, payload}`** (MCP écriture opt-in) ou
   `node karto-ingest.mjs <source> '<json>'` — merge idempotent, enrichissement manuel préservé,
   garde anti-secret (URLs de webhook auto-caviardées), fraîcheur estampillée dans `data/sources.json`.
5. `karto_rebuild` (ou `node karto-db.mjs build`), puis `node karto-sync.mjs rebuild --passphrase "…"` pour le coffre.

Si la session **n'a pas** ces MCP : ne devine pas, ne réécris pas ces sections — laisse l'instantané tel quel et
dis-le à Owner. Phrase déclencheuse côté Owner : « rafraîchis les connecteurs de karto ».

## Règle pour les autres conversations Claude Code
Si Owner demande « est-ce que karto est à jour ? » → lance `node karto-sync.mjs audit` et résume le diff.
Si **ton** travail dans la session a changé le paysage IT (nouveau repo, projet Supabase, host, automatisation,
renommage, nouvelle clé/connecteur, faille corrigée) → **mets à jour le `data/*.json` concerné** pour le refléter,
ajoute une ligne, puis :
- soit Owner te donne sa **passphrase** → `node karto-sync.mjs rebuild --passphrase "…"` ;
- soit tu t'arrêtes après l'édition JSON et tu lui dis de lancer le rebuild lui-même (le **garde-fou** : modifier
  le coffre déployé exige la passphrase).

Ne JAMAIS écrire de valeur de secret en clair dans les `data/*.json` (seulement noms/emplacements). Les valeurs
ne vivent que chiffrées dans `index.html` (cf. `build.mjs --with-secrets`, lues en RAM depuis les `.env`).

## Sauvegarde cloud
- **GitHub privé `lbachelotcapitalb/karto`** = foyer principal versionné. Pousser manuellement après changement :
  `git add -A && git commit -m "sync karto" && git push`. `index.html` est gitignored (jamais poussé).
- **iCloud** : `~/Desktop` est synchronisé → le dossier (dont `index.html` chiffré) est mirroré passivement.
- Restauration : `git clone` du repo → `node build.mjs --passphrase "…" --with-secrets` (les valeurs viennent des
  `.env` locaux ; le coffre chiffré lui-même est récupérable depuis iCloud).

## Détail des outils
- `karto-collect.mjs` — scanne le Mac (périmètre `karto.config.json`) → `data/machine_inventory.json` (noms/topologie, jamais de secret).
- `karto-bridge.mjs` — `gen` dérive / `probe` sonde le schéma des bases connectées → `data/bridges.json`.
- `karto-db.mjs` — matérialise tous les `data/*.json` en `karto.db` (graphe requêtable). `build` / `stats`.
- `karto-query.mjs` — l'interface IA : `schema|stats|search|entity|related|sql|secrets|exposures|bridges`.
- `karto-mcp.mjs` — **serveur MCP** (stdio, zéro-dép) : 8 outils lecture (karto_search / karto_entity / karto_impact / karto_sql / **karto_diagnostics** / **karto_scenario** / **karto_discover** + karto_schema), 3 **resources** (karto://schema|diagnostics|scenarios) et 4 **prompts** (sante-carte, audit-securite, impact, ou-vit-secret). Enregistré user-scope dans ~/.claude.json. `node karto-mcp.mjs` (lecture seule sur karto.db). Redémarrer Claude après modif.
- `karto-ingest.mjs` — **ingestion en masse par source** (l'aspirateur) : handlers make / cloudflare / gdrive / hetzner-workloads / mcp-tools / runs / hostinger-domains / source-status. Merge idempotent, enrichissement manuel préservé, garde anti-secret, backup, estampille `data/sources.json`. Exposé en MCP (`karto_ingest`, écriture opt-in) et en CLI (`node karto-ingest.mjs list`).
- `karto-sources.mjs` — répertoire des sources (`data/sources.json`) : `touchSource()` appelé par chaque collecteur, état de fraîcheur en CLI (`node karto-sources.mjs`).
- `karto-diagnostics.mjs` — **santé de la carte** (score /100 + dimensions : sécurité, rangement secrets, sauvegarde, cycle de vie, couverture, fraîcheur). Fonction pure `computeDiagnostics()` réutilisée par CLI / MCP / `build.mjs` (baké en `model.diagnostics` → carte dashboard). `node karto-diagnostics.mjs --summary`.
- `karto-scenarios.mjs` — **scénarios de résilience what-if** (si X tombe : rayon d'impact + automatisations cassées + secrets à roter + coût/mois). Softcode `data/scenarios.json`. `node karto-scenarios.mjs [id|nom]`.
- `build.mjs` flags utilitaires : `--emit-graph <path>` (exporte le graphe seul, ne touche pas index.html) · `--out <path>` (écrit le coffre ailleurs qu'index.html — preview sûr, jamais sur le déployé). La **cartographie de l'overview est un diagramme d'architecture « jumeau numérique »** (style Ontologie/Growth) : layout curé softcode dans `data/architecture.json` (boîtes clés : Base unifiée=karto.db, sources, exploitation machine/humaine, MCP, diagnostics, scénarios) + flèches de flux, **contenu data-driven** (chaque boîte porte un `match` → compte réel + liste des vrais nœuds en tooltip au survol). Fond clair pointillé. Rendu dans `buildGraph()` (template.html) depuis `DATA.architecture`+`DATA.graph`. A remplacé le nuage 2D/3D. Pour ajuster : éditer `data/architecture.json` (coords/boîtes/arrows/match) puis rebuild. **Interactif** : clic sur une boîte → panneau (liste des vrais nœuds) ; clic sur un nœud → fiche (catégorie, meta, connexions cliquables/navigables, bouton « Ouvrir l'onglet »). Panneau `.apanel` (thème clair) rendu dans `buildGraph()`.
- **Connexion /app = passphrase AES-256 SEULE** (déchiffrement 100% local). Le `basic_auth` natif a été RETIRÉ de `/app` (il causait popup moche → page blanche si creds périmés → ban fail2ban) ; `basic_auth` ne reste que sur `/save` + `/fs` (édition depuis le Mac). Conf : `redir /app /app/ 308` + `handle /app/* { file_server }` (cf. `deploy/karto.caddy`). Trade-off assumé : le blob chiffré est téléchargeable mais inutile sans la passphrase → garder une passphrase solide.
- `auth_server.py` + `deploy/karto-auth.service` + `deploy/setup-auth.sh` — **mode 2-gardes OPTIONNEL** (page login designée + cookie session HMAC devant la passphrase). Construit puis débranché le 30/06 (Owner a jugé la double auth redondante, la passphrase étant déjà obligatoire). Gardé dans le repo si on veut un jour re-protéger le blob : `./deploy/setup-auth.sh` réactive le `forward_auth` Caddy.
- `install-mcp.mjs` — installeur turnkey du MCP (détecte moteur, build, enregistre Claude Code/Desktop). `node install-mcp.mjs`.
- **Onglet IA** = data-driven : cartes générées depuis `data/cloud_inventory.json → accounts` marqués `category:"IA"` (Claude/Anthropic, Deepseek…). Pour ajouter une IA : ajouter l’entrée compte avec `category:"IA"` (+ favicon dans `vendorDomains`). Le module MCP est une section distincte (pas une IA). Aucun compte en dur dans le code.
- `karto-sqlite.mjs` — moteur SQLite portable : node:sqlite (Node 22+) OU repli binaire `sqlite3` (Node 18/20). Utilisé par karto-db/query/mcp.
- `gouvernance.mjs` — **table de gouvernance agentique** (paliers × risques) : joint karto.db avec l'overlay `data/gouvernance_agentique.json` et signale les automatisations non classées. `node gouvernance.mjs [--json]`. À rejouer/reclasser à chaque ajout d'automatisation — le **cron hebdo karto** (`karto-cron.sh`, launchd `com.karto.sync-weekly`, lundi 09:10) le contrôle automatiquement et signale les non-classées via ton canal de notif.
- `karto-index.mjs` — pipeline complet (collect → bridges → db build).
- `build.mjs` — fusionne data → graphe + EA → `index.html` (chiffré ou `--plain`).
- `front-audit.mjs` — **garde d'alignement front ↔ backend** (lot G, 29/07/2026) : refuse une source hors manifeste, un chemin de vue mort, un onglet qui ne mène nulle part ; avertit sur les colonnes fantômes et les zones mortes du coffre. `node front-audit.mjs [--json]`, lecture seule. Contrôlé par le cron hebdo → ton canal de notif.
- `rekey.mjs` / `rebuild.command` — changer la passphrase sans rien perdre.
- `supabase-refresh.mjs` — interroge l'API Management de chaque PAT collé dans le coffre.
- `serve.mjs` — `node serve.mjs` → http://localhost:8901 pour tester en local.

## Recenser une automatisation agentique (convention — pour que Owner n'ait aucune charge mentale)
Quand on ajoute / ajuste une automatisation (cron, agent Claude, scénario Make, GitHub Action), elle doit être
**lisible par un novice** : il doit pouvoir l'identifier, suivre sa chaîne, voir ses bases et ses fichiers, et
donc savoir quoi demander pour la modifier. Recette systématique :

1. **Un nom reconnaissable** (pas l'ID technique). Ex. `Newsletter quotidienne MonProjet`, pas `run_daily`.
   L'ID/host technique va dans le champ `type`.
2. **Une entrée dans `data/disk_inventory.json → systemAutomation[]`** (ou `cloud.github.actions` / `cloud.make.scenarios`) avec :
   - `claudeTier` : `"code"` (Claude Code), `"cowork"` (Cowork), `"api"` (API) ou `null` (hors Claude) → badge coloré.
   - `chain[]` = **le schéma softcode** affiché en vertical dans « détails ». Chaque étape = `{n, k, note}`.
     `n` = titre lisible (numérote les étapes : `1 ·`, `2 ·`…). `note` = **le fichier OU la base concernée**
     (ex. `fichier: prompt_agent.md`, `base: Supabase schéma newsletter`). Marque le pas-encore-câblé avec `⏳`.
     Kinds `k` disponibles (icône) : `trigger`⏱️ `script`📜 `code`🤖 `ai`✨ `agent`🧠 `api`🔌 `store`🗄️
     `notify`✉️ `publish`📤 `mirror`🪞 `infra`🖥️ `check`🔎.
     - `app` (optionnel, **recommandé**) : nom d'app/éditeur résolvable par `vendorDomains` (ex. `Supabase`,
       `Resend`, `GitHub`, `Google Drive`, `Hetzner`, `Claude`, `Wix`, `Make`, `Apple`…). Affiche le **favicon
       fidèle** dans la tuile de l'étape (popup « schéma de chaîne » façon Make, au survol du nom + dans « détails »).
       Sans `app`, repli sur l'emoji du kind. Ajoute le vendor manquant dans `cloud_inventory.json → vendorDomains`.
   - `manifest` (optionnel) : chemin du `stack.manifest.json` du projet = source de vérité détaillée à resynchroniser.
3. **Une ligne « en clair » dans `data/automation_plain.json`** : clé = un bout **unique** du nom (1er match gagne,
   mets les clés spécifiques en premier), valeur = 2-3 phrases **sans jargon** (où il lit ses consignes, où il
   stocke, qui valide). C'est ce que lit le novice en premier.
4. **Le projet porteur** dans `disk_inventory.json → projects[]` liste `scripts[]`, `envFiles[]` (NOMS de secrets
   only), `integrations[]` → ça alimente la fiche projet + le graphe 360°. Si le nom contient `MonProjet`/`newsletter`/
   `polar`/`Orchester`, `build.mjs` relie auto l'automatisation à son projet (match insensible à la casse).
5. **Rebuild** (garde-fou passphrase). La synchro karto reste **manuelle** : à chaque fois qu'on ajuste la chaîne
   (ou son `stack.manifest.json`), on remet à jour ces champs puis on rebuild.

> ✎ Édition par l’IA (opt-in) : `node install-mcp.mjs --write` ajoute 7 outils MCP d’écriture (comptes, attributs, dépendances, expositions…) — mutent `data/*.json`, jamais le code, jamais de secret. Voir AGENTS.md.
