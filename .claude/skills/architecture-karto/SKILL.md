---
name: architecture-karto
description: >-
  Comprendre l'architecture interne de karto pour la faire évoluer : le pipeline data→db→dashboard,
  le modèle de graphe entity/edge, et OÙ ajouter chaque chose (un scanner d'inventaire, un connecteur
  de coffre, une vue UI, une requête, un bridge). À lire avant de coder une feature de fond sur karto.
  Complète AGENTS.md (qui, lui, explique comment INTERROGER karto).
---

# architecture-karto — la carte du code pour le faire évoluer

`AGENTS.md` explique comment **interroger** karto. Ce skill explique comment le **construire**.

## Le pipeline en une image

```
data/*.json ──┬──► build.mjs     ──► index.html   (dashboard chiffré ; jamais versionné)
 (la vérité,  │
  zéro secret)└──► karto-db.mjs  ──► karto.db ──┬──► CLI  (karto-query.mjs)
                                                └──► MCP  (karto-mcp.mjs)
```

Règle d'or qui découle des 5 principes : **on enrichit `data/*.json` (la vérité), et le code lit
cette donnée — on ne code jamais un fait en dur.** Les fichiers `data/` portent la taxonomie et
l'inventaire (`account_taxonomy`, `app_catalog`, `automation_taxonomy`, `cloud_inventory`,
`disk_inventory`, `ea_inventory`, `brand_icons`…).

## Le modèle de données — un graphe `entity` + `edge`

(Source de vérité à jour : `node karto-query.mjs schema`.)

- **entity** : `id` (ex. `project:myapp`), `kind`, `name`, `vendor`, `hosting`, `criticite`, `doc`
  (texte plein), `attrs` (**JSON** — `json_extract(attrs,'$.stack')`).
- **edge** : `src`, `dst`, `rel` — graphe orienté ; convention : `src` **dépend de / pointe vers** `dst`.
- **secret_ref** : *emplacements* de secrets (`name`, `service`, `path`, `category`) — **jamais de VALEUR**.
- **exposure** : findings sécurité. **bridge** : bases connectées + comment les requêter.

## « Je veux ajouter… » → « Va voir… »

| Tu veux… | Va voir… |
|---|---|
| Du contenu sur la carte (un projet, un compte, une auto) | `data/*.json` (la source de vérité) |
| Un **scanner d'inventaire** (services, conteneurs, navigateurs…) | `karto-collect.mjs` |
| Un **connecteur de coffre** (1Password `op`, KeePassXC…) | l'abstraction `provider` de `vault-connect.mjs` |
| Une **vue / le graphe** du dashboard | `template.html` (HTML/CSS/JS vanilla, déchiffrement WebCrypto) |
| Le **build / chiffrement** | `build.mjs` (`--plain` = test sans secret, `--with-secrets` = live) |
| Le **graphe requêtable** (nouvelle requête, nouveau KIND/rel) | `karto-db.mjs`, `karto-query.mjs` |
| L'**accès IA** (un outil MCP) | `karto-mcp.mjs` (+ `AGENTS.md` pour le contrat) |
| Le **moteur SQLite portable** | `karto-sqlite.mjs` |

## Tester ta feature (sans aucun secret)

```bash
node karto-db.mjs build && node build.mjs --plain && node karto-serve.mjs
node karto-query.mjs schema      # vérifie que ton ajout au modèle est bien pris en compte
```

Si tu ajoutes un KIND d'entité ou une relation, documente-le et vérifie qu'il remonte dans
`node karto-query.mjs schema`. Si tu touches au MCP, vérifie `node karto-mcp.mjs` (liste des outils).
