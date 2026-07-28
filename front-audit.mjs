#!/usr/bin/env node
/* front-audit.mjs — GARDE DU FRONT (lot G8, 29/07/2026)
 *
 * Pourquoi : l'audit du 28/07 a montré que le backend peut apprendre à mesurer (diagnostics,
 * handshake MCP, collecte machine) sans que le front n'en montre rien — et que le drift ne se
 * voit nulle part. Ce script rend cette vérification CONTINUE au lieu d'être une session d'audit.
 *
 * Il vérifie, sans rien modifier :
 *   A. tout data/*.json est déclaré dans data/payload_manifest.json (payload | builtin | out)
 *   B. toute source déclarée `payload` arrive vraiment dans le coffre
 *   C. tout chemin `source` du descripteur data/ui_sections.json résout dans le payload
 *   D. toute colonne déclarée est renseignée par au moins une ligne (sinon colonne fantôme)
 *   E. toute clé du payload est consommée par le template ou par le descripteur (zone morte)
 *
 * A/B/C sont BLOQUANTS (sortie 1). D/E sont des avertissements.
 * Usage : node front-audit.mjs [--json]   (build un coffre en clair dans un fichier temporaire)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.includes('--json');
const read = f => JSON.parse(readFileSync(join(__dir, f), 'utf8'));

/* ---------- payload réel (build en clair, jamais sur index.html) ---------- */
const tmp = join(tmpdir(), `karto-front-audit-${process.pid}.html`);
let payload;
try {
  execFileSync(process.execPath, ['build.mjs', '--plain', '--out', tmp], { cwd: __dir, stdio: 'pipe' });
  const html = readFileSync(tmp, 'utf8');
  const i = html.indexOf('id="payload"');
  payload = JSON.parse(html.slice(html.indexOf('>', i) + 1, html.indexOf('</script>', i)));
} catch (e) {
  console.error('✗ build de contrôle impossible :', e.message); process.exit(2);
} finally { try { unlinkSync(tmp); } catch {} }

const manifest = read('data/payload_manifest.json');
const ui = (() => { try { return read('data/ui_sections.json'); } catch { return { groups: [], views: {} }; } })();
const template = readFileSync(join(__dir, 'template.html'), 'utf8');
const pathGet = p => String(p || '').split('.').filter(Boolean).reduce((a, k) => (a == null ? a : a[k]), payload);
const err = [], warn = [];

/* A. sources hors manifeste */
const declared = new Set(manifest.entries.map(e => e.file).filter(Boolean));
const onDisk = readdirSync(join(__dir, 'data')).filter(f => f.endsWith('.json') && !f.startsWith('.'));
const meta = new Set(['payload_manifest.json', 'ui_sections.json']);
for (const f of onDisk) if (!declared.has(f) && !meta.has(f))
  err.push(`A · data/${f} n'est déclaré nulle part (payload | builtin | out) → une source peut rester invisible en silence`);

/* B. sources `payload` réellement embarquées */
for (const e of manifest.entries.filter(x => x.mode === 'payload'))
  if (payload[e.key] == null) err.push(`B · source déclarée « ${e.file} » absente du coffre (clé ${e.key})`);

/* C+D. descripteur de vues */
const blocksOf = sp => sp.blocks || [{ render: sp.render, source: sp.source, columns: sp.columns }];
const rowsOf = src => { const v = pathGet(src); return Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.entries(v).map(([k, o]) => (o && typeof o === 'object' ? { _key: k, ...o } : { _key: k })) : []); };
const declaredViews = new Set();
for (const [vid, sp] of Object.entries(ui.views || {})) {
  declaredViews.add(vid);
  for (const b of blocksOf(sp)) {
    if (!b.source) continue;
    const v = pathGet(b.source);
    if (v === undefined) { err.push(`C · vue « ${vid} » : chemin « ${b.source} » introuvable dans le coffre`); continue; }
    const rows = rowsOf(b.source);
    for (const c of (b.columns || []))
      if (rows.length && !rows.some(r => r && r[c.key] != null && r[c.key] !== ''))
        warn.push(`D · vue « ${vid} » : colonne « ${c.key} » jamais renseignée (${rows.length} lignes) → colonne fantôme`);
  }
}
/* C bis. un onglet déclaré doit mener quelque part : vue générique OU vue dédiée du template */
for (const g of (ui.groups || [])) for (const c of (g.children || []))
  if (!declaredViews.has(c.id) && !template.includes(`data-v="${c.id}"`))
    err.push(`C · onglet « ${c.id} » (${g.id}) ne correspond à aucune vue — ni générique, ni dédiée`);

/* E. zones mortes du payload */
const uiSources = Object.values(ui.views || {}).flatMap(sp => blocksOf(sp).map(b => b.source || ''));
for (const k of Object.keys(payload)) {
  if (k === 'meta' || k === 'ui') continue;
  const byTemplate = template.includes(`DATA.${k}`);                       // vue dédiée
  const byUi = uiSources.some(s => s === k || s.startsWith(k + '.'));      // vue générique
  if (!byTemplate && !byUi)
    warn.push(`E · DATA.${k} est embarqué dans le coffre mais consommé par aucune vue (zone morte)`);
}

/* ---------- sortie ---------- */
if (asJson) { console.log(JSON.stringify({ ok: !err.length, errors: err, warnings: warn }, null, 2)); process.exit(err.length ? 1 : 0); }
const n = Object.keys(payload).length;
console.log(`front-audit — ${n} clés dans le coffre · ${Object.keys(ui.views || {}).length} vue(s) générique(s) · ${onDisk.length} source(s) sur disque`);
for (const e of err) console.log('  ✗ ' + e);
for (const w of warn) console.log('  ⚠ ' + w);
if (!err.length && !warn.length) console.log('  ✓ front aligné avec le backend : aucune source orpheline, aucun chemin mort, aucune zone morte.');
else if (!err.length) console.log(`  ✓ aucun écart bloquant (${warn.length} avertissement(s)).`);
process.exit(err.length ? 1 : 0);
