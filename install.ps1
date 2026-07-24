# install.ps1 — installeur karto « une commande » (Windows).
#
#   irm https://get.karto.app/install.ps1 | iex
#
# Récupère karto, garantit un Node >= 20 (en installe un PRIVÉ dans %USERPROFILE%\.karto si absent,
# sans droits admin), puis lance la première configuration (karto-init.mjs). Tout reste local.
$ErrorActionPreference = 'Stop'

$KartoHome   = if ($env:KARTO_HOME) { $env:KARTO_HOME } else { Join-Path $HOME '.karto' }
$App         = Join-Path $KartoHome 'app'
$Rt          = Join-Path $KartoHome 'runtime'
$NodeVersion = if ($env:KARTO_NODE_VERSION) { $env:KARTO_NODE_VERSION } else { '22.11.0' }
# PLACEHOLDER — URL de distribution cablee en Phase 3 (hebergement landing).
$DistUrl     = if ($env:KARTO_DIST_URL) { $env:KARTO_DIST_URL } else { 'https://get.karto.app/karto-dist.zip' }

function Say($m) { Write-Host "  $m" }
function Have($c) { $null -ne (Get-Command $c -ErrorAction SilentlyContinue) }

Write-Host "`n  Installation de karto...`n"

# 1) Node >= 20 — sinon runtime prive, sans admin ----------------------------
$node = $null
if (Have 'node') {
  try { if ([int](node -p 'process.versions.node.split(".")[0]') -ge 20) { $node = 'node'; Say "Node $(node -v) detecte." } } catch {}
}
if (-not $node) {
  Say "Node absent — installation d'un runtime prive (sans admin) dans $Rt..."
  $arch = if ($env:PROCESSOR_ARCHITECTURE -match 'ARM64') { 'arm64' } else { 'x64' }
  $pkg  = "node-v$NodeVersion-win-$arch"
  $url  = "https://nodejs.org/dist/v$NodeVersion/$pkg.zip"
  New-Item -Force -ItemType Directory $Rt | Out-Null
  $zip = Join-Path $env:TEMP 'karto-node.zip'
  Invoke-WebRequest -UseBasicParsing $url -OutFile $zip
  Expand-Archive -Force $zip $Rt
  Remove-Item $zip
  $node = Join-Path $Rt "$pkg\node.exe"
  if (-not (Test-Path $node)) { throw "Runtime Node prive inutilisable." }
  Say "Node prive installe ($(& $node -v))."
}

# 2) Recuperer karto (dist vierge) -------------------------------------------
Say "Telechargement de karto..."
if (Test-Path $App) { Remove-Item -Recurse -Force $App }
New-Item -Force -ItemType Directory $App | Out-Null
$zip = Join-Path $env:TEMP 'karto-dist.zip'
Invoke-WebRequest -UseBasicParsing $DistUrl -OutFile $zip
$tmp = Join-Path $env:TEMP 'karto-dist-x'
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
Expand-Archive -Force $zip $tmp
Remove-Item $zip
# aplatir si l'archive a un dossier racine unique (comme les tarballs GitHub)
$roots = @(Get-ChildItem $tmp)
$srcRoot = if ($roots.Count -eq 1 -and $roots[0].PSIsContainer) { $roots[0].FullName } else { $tmp }
Copy-Item -Recurse -Force (Join-Path $srcRoot '*') $App
Remove-Item -Recurse -Force $tmp
if (-not (Test-Path (Join-Path $App 'karto-init.mjs'))) { throw "Distribution incomplete (karto-init.mjs absent)." }

if ($env:KARTO_SKIP_INIT) { Say "OK installe dans $App (init sautee)."; return }

# 3) Premiere configuration (Read-Host lit la console, OK sous iex) ----------
Say "Lancement de la configuration..."
Set-Location $App
& $node 'karto-init.mjs'
