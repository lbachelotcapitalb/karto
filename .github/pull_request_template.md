<!-- Merci pour ta PR ! Garde le diff petit et ciblé. -->

## Quoi & pourquoi
<!-- Que change cette PR, et quel problème ça résout ? Lie l'issue : "Closes #123". -->


## Comment tester
<!-- Les commandes pour vérifier. Ex. : -->
```bash
node karto-db.mjs build
node build.mjs --plain
```

## Checklist
- [ ] Respecte les **5 principes** (`CONTRIBUTING.md`) : local-first, zéro dépendance, softcode, données≠code, lecture seule par défaut.
- [ ] **Aucune valeur de secret** ni identifiant personnel dans le code, les data, les tests ou les commits.
- [ ] Aucune nouvelle dépendance externe (ou justifiée explicitement ci-dessous).
- [ ] `node karto-db.mjs build` passe et `node build.mjs --plain` produit un dashboard.
- [ ] Style cohérent avec le fichier modifié (JS pur ESM, imports `node:`).

## Notes
<!-- Justification d'une dépendance, captures, points d'attention pour la revue… -->
