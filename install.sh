#!/bin/bash
# install.sh — installeur karto « une commande » (Mac/Linux).
#
#   curl -fsSL https://get.karto.app/install.sh | bash
#
# Récupère karto, garantit un Node ≥ 20 (en installe un PRIVÉ dans ~/.karto si absent, SANS sudo),
# puis lance la première configuration (karto-init.mjs → passphrase → coffre chiffré → ouverture).
# Tout reste en espace utilisateur. Aucune donnée ne quitte la machine.
set -euo pipefail

KARTO_HOME="${KARTO_HOME:-$HOME/.karto}"
APP="$KARTO_HOME/app"
RT="$KARTO_HOME/runtime"
NODE_VERSION="${KARTO_NODE_VERSION:-22.11.0}"
# ⚠️ PLACEHOLDER — l'URL de distribution (dist vierge) sera câblée en Phase 3 (hébergement landing).
DIST_URL="${KARTO_DIST_URL:-https://get.karto.app/karto-dist.tar.gz}"

say(){ printf '  %s\n' "$*"; }
die(){ printf '  ✗ %s\n' "$*" >&2; exit 1; }
have(){ command -v "$1" >/dev/null 2>&1; }

printf '\n  Installation de karto…\n\n'
have curl || die "curl requis."
have tar  || die "tar requis."

# 1) Node ≥ 20 — sinon runtime privé, sans sudo ------------------------------
node_major(){ "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
NODE=""
if have node && [ "$(node_major node)" -ge 20 ]; then NODE="$(command -v node)"; say "Node $($NODE -v) détecté."; fi
if [ -z "$NODE" ]; then
  say "Node absent — installation d'un runtime privé (sans sudo) dans $RT…"
  case "$(uname -s)" in Darwin) plat=darwin; ext=tar.gz;; Linux) plat=linux; ext=tar.xz;; *) die "OS non supporté pour l'auto-install Node.";; esac
  case "$(uname -m)" in arm64|aarch64) a=arm64;; x86_64|amd64) a=x64;; *) die "Architecture non supportée: $(uname -m).";; esac
  pkg="node-v$NODE_VERSION-$plat-$a"
  mkdir -p "$RT"; tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$pkg.$ext" -o "$tmp/node.$ext" || die "Téléchargement de Node échoué."
  tar -xf "$tmp/node.$ext" -C "$RT"; rm -rf "$tmp"
  NODE="$RT/$pkg/bin/node"
  [ -x "$NODE" ] && "$NODE" -v >/dev/null || die "Runtime Node privé inutilisable."
  say "Node privé $($NODE -v) installé."
fi

# 2) Récupérer karto (dist vierge) -------------------------------------------
say "Téléchargement de karto…"
rm -rf "$APP"; mkdir -p "$APP"; tmp="$(mktemp -d)"
curl -fsSL "$DIST_URL" -o "$tmp/karto.tar.gz" || die "Téléchargement de karto échoué ($DIST_URL)."
tar -xf "$tmp/karto.tar.gz" -C "$APP" --strip-components=1 || die "Décompression de karto échouée."
rm -rf "$tmp"
[ -f "$APP/karto-init.mjs" ] || die "Distribution incomplète (karto-init.mjs absent)."

# (crochet de test : valider fetch+unpack sans lancer la config interactive)
[ -n "${KARTO_SKIP_INIT:-}" ] && { say "✓ Installé dans $APP (init sautée — KARTO_SKIP_INIT)."; exit 0; }

# 3) Première configuration --------------------------------------------------
# IMPORTANT : sous `curl … | bash`, stdin = le flux curl, pas le terminal.
# On reconnecte stdin au terminal via /dev/tty pour que le prompt de passphrase fonctionne.
say "Lancement de la configuration…"
cd "$APP"
if [ -r /dev/tty ]; then exec "$NODE" karto-init.mjs < /dev/tty
else exec "$NODE" karto-init.mjs; fi
