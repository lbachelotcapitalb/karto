# Changelog karto

Format [semver](https://semver.org/lang/fr/) `X.Y.Z`. Généré/maintenu par `node release.mjs`.

Règle de bump (liée au **risque pour le coffre de l'utilisateur**, pas à la taille du diff) :

- **Z — patch** (`0.0.X`) : correctif, sécurité, perf, libellé. Zéro changement de schéma/workflow. La MAJ = *re-wrap* du coffre existant dans le nouveau template (aucune passphrase, aucune migration). Applicable les yeux fermés.
- **Y — minor** (`0.X.0`) : nouvelle fonctionnalité / collecteur / écran / outil MCP, **rétro-compatible** (schéma additif). Les données existantes se rechargent inchangées. Re-wrap suffit.
- **X — major** (`X.0.0`) : changement **cassant** — migration de schéma, format de chiffrement/clé, format de config, ou étape manuelle requise. La MAJ exécute une migration (passphrase requise) ; sauvegarde d'abord.

`min_from` dans `version.json` = plus ancienne version depuis laquelle une MAJ directe est sûre. En-dessous, l'instance recommande une ré-installation propre plutôt qu'une migration.

---

## 1.4.0 — 2026-07-31 (minor)

- Collecteur claude-usage (usage Claude Code par agent, Mac + VPS) et correctif runs-collect : un PID vivant prime sur le code de sortie de l'instance précédente

## 1.3.0 — 2026-07-28 (minor)

- Front softcode (lot G) : manifeste de payload + descripteur de vues, 4 primitives de rendu, detail des constats de sante, declare vs mesure sur les contrats MCP, couche d'execution reelle, fiches fournisseur generiques, garde front-audit

## 1.2.0 — 2026-07-26 (minor)

- Refonte UI v2 : coquille flottante (barre, rail, volet, panneau en verre gris), tableau de bord fusionné avec la cartographie, palette tenue gris + or, vue Santé du système, responsive et curseur anneau. Aucun changement de format du coffre.

## 1.1.0 — 2026-07-25 (minor)

- Versioning `X.Y.Z` et notification de mise à jour pour les instances auto-hébergées.
- 3 surfaces de notif : bandeau in-app, avis accroché aux réponses du MCP, check au chargement.
- Application en 1 clic via endpoint local, préservant le coffre chiffré (re-wrap patch/minor, migration major).
- Source de vérité `version.json` publiée sur le VPS ; rollout piloté (découplé du push git).
