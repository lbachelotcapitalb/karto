#!/bin/bash
# Double-clic : change la passphrase du coffre sans rien perdre.
cd "$(dirname "$0")" || exit 1
clear
echo "────────────────────────────────────────────"
echo "  Cartographie IT — changer la passphrase"
echo "────────────────────────────────────────────"
echo
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js introuvable dans le PATH. Ouvre un terminal et lance : node rekey.mjs"
  echo
  echo "Appuie sur Entrée pour fermer."; read _; exit 1
fi
node rekey.mjs
echo
echo "Tu peux fermer cette fenêtre (Cmd+W). Pense à redéployer index.html."
echo "Appuie sur Entrée pour terminer."
read _
