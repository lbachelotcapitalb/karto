#!/bin/bash
# karto-open.command — double-clique pour OUVRIR karto sans aucun hébergement.
# Sert le dashboard chiffré sur http://127.0.0.1 (localhost), ce qui donne le
# "secure context" exigé par Web Crypto dans TOUS les navigateurs (le double-clic
# file:// échoue parfois sous Safari). Rien ne sort de la machine ; le serveur ne
# fait que poser le fichier — il ne déchiffre rien, ne voit jamais ta passphrase.
cd "$(dirname "$0")" || exit 1
clear
if [ ! -f index.html ]; then
  echo "✗ index.html introuvable. Génère d'abord le coffre :"
  echo "    node karto-sync.mjs rebuild --passphrase \"…\""
  echo ""; read -r -p "Entrée pour fermer."; exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js requis (https://nodejs.org). Installe-le puis relance."
  echo ""; read -r -p "Entrée pour fermer."; exit 1
fi
echo "🔓  Ouverture de karto en local (aucun hébergement)…"
exec node karto-serve.mjs
