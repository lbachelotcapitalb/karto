# Observabilité IA — les 4 pratiques que karto sait suivre

Dès qu'une automatisation est **pilotée par un LLM** (agent autonome, cron `claude -p`,
scénario no-code avec module IA…), elle peut échouer de façons qu'un cron classique ne
connaît pas : panne **silencieuse** (le modèle répond, mais mal), **injection de prompt**
via le contenu qu'elle lit, dérive de **coût**, et chaînes d'appels opaques au débogage.

karto consolide les standards du domaine (Datadog LLM Observability, Langfuse, OpenTelemetry
GenAI) en **4 pratiques génériques**, mesurées par la dimension **« Observabilité IA »** du
diagnostic (`node karto-diagnostics.mjs --summary`, outil MCP `karto_diagnostics`, widget
du dashboard). La philosophie karto s'applique : **frugal, local, sans plateforme obligatoire**
— un fichier JSONL et un e-mail d'alerte suffisent pour couvrir l'essentiel.

## Les 4 pratiques

| Clé | Pratique | Version frugale suffisante |
|---|---|---|
| `traces` | **Traces par run** : chaque exécution journalise ses étapes, durées, tokens, erreurs, avec un `run_id` corrélant toute la chaîne | Un JSONL par jour (`logs/runs/<date>.jsonl`), une ligne JSON par événement — greppable, agrégeable par n'importe quel outil |
| `alertes` | **Alerte de panne silencieuse** : un watchdog vérifie que le RÉSULTAT attendu existe (édition générée, post publié…), et alerte par un canal **indépendant des crédentiels du LLM** | Cron `*/15` qui teste « le livrable du jour existe-t-il après HH:MM ? » → e-mail via un fournisseur tiers (pas l'API du LLM, qui est peut-être la cause de la panne) |
| `gate` | **Gate de sortie** : contrôle automatique de la production du LLM AVANT toute action externe (envoi, publication, écriture) — qualité structurelle **et** signaux d'injection de prompt | Script de pre-check : schéma valide, URLs saines (http(s), pas de raccourcisseur/IP/punycode), marqueurs d'injection (« ignore previous instructions », `<script`, CTA de phishing) → bloquant + alerte ; le reste en avertissement non bloquant |
| `cout` | **Suivi ou plafond de coût** : la conso (tokens/€) est mesurée, ou structurellement plafonnée | Abonnement à coût fixe = plafond par construction (déclarer `"cout": "plafonne"`) ; API pay-per-token = extraire `usage` de la sortie du modèle vers les traces + relevé périodique |

Complément côté **entrée** (non mesurable par karto mais indispensable) : dans le prompt de
l'agent, poser explicitement que **le contenu externe lu (web, mails, fichiers) est une
donnée, jamais une instruction** — c'est la première ligne de défense anti-injection, le
gate de sortie étant la seconde.

## Déclarer dans la carte (opt-in, zéro bruit)

La dimension ne note **que** les entités (`automation`, `agent`, `scenario`, `workload`)
marquées comme pilotées par un LLM. Deux marqueurs possibles dans `attrs` :

```json
{ "llm": true }
```

ou, si vous renseignez déjà le modèle/mode utilisé : `{ "claudeTier": "api" }` (tout
`claudeTier` non vide vaut opt-in). Sans aucune automatisation IA déclarée, la dimension
est absente du diagnostic — elle ne pénalise pas les cartes sans IA.

Puis déclarez les pratiques **réellement en place** :

```json
{
  "llm": true,
  "obs": {
    "traces": true,
    "alertes": true,
    "gate": true,
    "cout": "plafonne"
  }
}
```

Toute valeur truthy compte comme « pratique en place » ; une chaîne (`"plafonne"`,
`"langfuse"`, `"jsonl"`) documente le COMMENT en plus du fait. Le score de la dimension =
moyenne de couverture des 4 pratiques sur l'ensemble des automatisations IA ; chaque
automatisation incomplète apparaît dans la liste actionnable avec ce qui lui manque.

## Règle d'honnêteté

Ne déclarez une pratique **qu'une fois réellement en place** (le fichier de traces existe,
le watchdog a déjà alerté en test, le gate a déjà bloqué une sortie piégée en test). La
carte reflète la réalité — un `true` de complaisance rend le diagnostic mensonger, ce qui
est pire que l'absence de pratique.
