# Politique de sécurité

karto manipule de la **topologie sensible** : emplacements de comptes, d'hébergements, de bases,
et *où* vivent des secrets (jamais leur valeur). Un rapport de faille est pris au sérieux.

## Signaler une vulnérabilité

**N'ouvre pas d'issue publique** pour une faille de sécurité — une issue est visible de tous et
expose le problème avant qu'il ne soit corrigé.

À la place, utilise le canal privé de GitHub :

1. Va dans l'onglet **Security** du dépôt → **Report a vulnerability**
   (*Private vulnerability reporting* — [documentation GitHub](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)).
2. Décris la faille, son impact, et les étapes pour la reproduire.

Le rapport reste privé entre toi et les mainteneurs jusqu'à ce qu'un correctif soit publié.

Réponse visée : **accusé de réception sous 72 h**, évaluation et plan de correctif communiqués
ensuite. Merci de laisser un délai raisonnable de divulgation coordonnée avant toute publication.

## Périmètre

Sont particulièrement dans le périmètre :

- **Fuite d'une valeur de secret** en clair (sur disque, dans un log, dans `karto.db` ou l'UI) —
  karto ne doit stocker que la *topologie*, jamais la *valeur*.
- **Contournement du chiffrement** du coffre (`index.html` : AES-256-GCM, PBKDF2-SHA256 600k) ou
  affaiblissement du garde-fou anti-verrouillage de passphrase (`kid`).
- **Appel réseau sortant** non désiré depuis le dashboard ou le runtime (la promesse est
  *aucune donnée ne quitte la machine*).
- **Écriture hors `data/*.json`** par le chemin d'édition (MCP `--write`, `karto-write.mjs`), ou
  acceptation d'une valeur ressemblant à un secret par ce chemin.
- **Injection** (SQL via `karto_sql`, chemin, commande) dans les collecteurs ou l'interface de requête.

## Bonnes pratiques pour ton instance

- Ta passphrase **est** la clé (*zero-knowledge*) : longue, unique, notée dans un gestionnaire.
  Aucune récupération n'est possible si elle est perdue.
- Si tu héberges `index.html` en ligne, protège l'accès (auth) : le fichier est chiffré, mais
  garder le coffre privé reste la meilleure défense.
- Ne commite jamais tes `.env` ni ton `karto.db` (ils sont déjà gitignorés).
