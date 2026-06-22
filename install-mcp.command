#!/bin/bash
# install-mcp.command — double-clique pour brancher karto à ton IA (serveur MCP).
# Détecte le moteur SQLite, construit karto.db si besoin, enregistre le serveur dans
# Claude Code / Claude Desktop, puis affiche la config manuelle pour les autres clients.
# Aucun secret. Pense à REDÉMARRER ton client Claude ensuite.
cd "$(dirname "$0")" || exit 1
clear
echo "🔌  Installation du serveur MCP karto"
echo ""
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node introuvable. Installe Node ≥ 22 (recommandé) : https://nodejs.org"
  echo "Appuie sur Entrée pour fermer."; read -r; exit 1
fi
node install-mcp.mjs
echo ""
echo "Tu peux fermer cette fenêtre. (Redémarre Claude pour charger les outils karto_*.)"
read -r
