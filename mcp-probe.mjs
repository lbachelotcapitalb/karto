#!/usr/bin/env node
// mcp-probe.mjs — MESURE le contrat réel de chaque serveur MCP, par vrai handshake JSON-RPC.
//
// Pourquoi ce collecteur existe (F2) : la carte DÉCLARAIT le contrat de ses connecteurs
// (`attrs.readonly`, `attrs.tools`) et personne ne le confrontait jamais au serveur. Résultat
// mesuré le 27/07/2026 : la fiche « karto MCP » annonçait 4 outils là où le serveur en expose 9,
// et les fiches moncompta / polar n'en déclaraient aucun. Une déclaration que rien ne contredit
// finit toujours par mentir — c'est la même famille de défaut que le « 0 worker Cloudflare » (C2)
// et les 4 orphelins de B3 : un chiffre écrit comme s'il était mesuré.
//
// DOCTRINE (skill mcp-dev) :
//   · vrai handshake, JAMAIS un import — importer un serveur de prod exécute son top-level ;
//   · lecture seule par construction : on n'envoie que `initialize` + `tools/list`,
//     AUCUN appel d'outil, donc aucun effet de bord possible même sur un serveur mutateur ;
//   · `timeout` n'existe pas sur macOS (3 handshakes perdus le 27/07 pour cette raison) —
//     le délai est tenu par un setTimeout Node qui tue le process.
//
// SOFTCODÉ : la liste des serveurs vient de la config du client MCP (~/.claude.json par défaut,
// --config pour une autre), jamais d'une liste en dur qui divergerait au premier serveur ajouté.
//
// Sortie : data/mcp_probe.json. Un serveur injoignable sort « non mesuré » AVEC SON MOTIF —
// jamais 0 outil : « je n'ai pas pu mesurer » et « il n'expose rien » sont deux faits opposés.
//
//   node mcp-probe.mjs [--config <path>] [--timeout 25000] [--only karto,polar]

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const CONFIG = arg('--config', join(homedir(), '.claude.json'));
const TIMEOUT = Number(arg('--timeout', 25000));
const ONLY = arg('--only', '') ? arg('--only', '').split(',').map(s => s.trim()) : null;

/* ---------- un handshake, et rien d'autre ---------- */
function handshake(name, def) {
  return new Promise(resolve => {
    const transport = def.type || (def.url ? 'http' : 'stdio');
    if (transport !== 'stdio' || !def.command) {
      return resolve({ name, transport, mesure: 'non mesuré', motif: `transport « ${transport} » — ce collecteur ne sait interroger que le stdio local (un connecteur distant s'authentifie côté client)` });
    }
    let out = '', err = '', done = false;
    const child = spawn(def.command, def.args || [], {
      env: { ...process.env, ...(def.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const fin = r => { if (done) return; done = true; clearTimeout(t); try { child.kill('SIGKILL'); } catch {} resolve(r); };
    const t = setTimeout(() => fin({
      name, transport, mesure: 'non mesuré',
      motif: `aucune réponse en ${TIMEOUT} ms (serveur lent, secret non déverrouillé, ou dépendance absente)`,
      stderr: err.trim().split('\n').slice(-3).join(' | ').slice(0, 300) || null,
    }), TIMEOUT);

    child.on('error', e => fin({ name, transport, mesure: 'non mesuré', motif: `lancement impossible : ${e.message}` }));
    child.stderr.on('data', d => { err += d; });
    child.stdout.on('data', d => {
      out += d;
      // Le protocole possède stdout : une ligne = un message JSON-RPC. On s'arrête dès que
      // la réponse d'id 2 (tools/list) est complète, sans attendre la fin du process.
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2) {
          if (msg.error) return fin({ name, transport, mesure: 'non mesuré', motif: `tools/list en erreur : ${msg.error.message || JSON.stringify(msg.error)}` });
          return fin({ name, transport, mesure: 'mesuré', tools: msg.result?.tools || [] });
        }
      }
    });
    child.on('close', () => fin({
      name, transport, mesure: 'non mesuré',
      motif: 'le serveur s\'est arrêté avant de répondre à tools/list',
      stderr: err.trim().split('\n').slice(-3).join(' | ').slice(0, 300) || null,
    }));

    const send = o => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'karto-mcp-probe', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });
}

/* ---------- lecture du contrat exposé ----------
 * Deux signaux INDÉPENDANTS, et c'est tout l'intérêt de les croiser :
 *   · ce que l'outil DÉCLARE  : annotations.readOnlyHint (ce que le client croit)
 *   · ce que son schéma TRAHIT : un `apply`/`dryRun` dans inputSchema = une écriture qui
 *     s'apprête à avoir lieu (c'est la convention de la flotte, cf. moncompta)
 * Quand les deux se contredisent, l'annotation ment — exactement le défaut A3
 * (`moncompta_scan_inbox` annoté lecture seule alors qu'il écrivait l'état). */
function lire(tools) {
  const r = { total: tools.length, readOnly: 0, mutateurs: 0, sansAnnotation: 0, incoherents: [] };
  for (const t of tools) {
    const a = t.annotations || {};
    const ro = a.readOnlyHint === true;
    const props = t.inputSchema?.properties || {};
    const ecritParSchema = 'apply' in props || 'dryRun' in props;
    if (a.readOnlyHint == null) r.sansAnnotation++;
    if (ro) r.readOnly++; else r.mutateurs++;
    if (ro && ecritParSchema) r.incoherents.push({ tool: t.name, quoi: 'annoté readOnlyHint:true alors que son schéma expose apply/dryRun (donc il écrit)' });
  }
  return r;
}

/* ---------- exécution ---------- */
if (!existsSync(CONFIG)) { console.error(`✗ config client MCP introuvable : ${CONFIG} (--config pour la déclarer)`); process.exit(1); }
let servers = {};
try { servers = JSON.parse(readFileSync(CONFIG, 'utf8')).mcpServers || {}; }
catch (e) { console.error(`✗ config illisible (${CONFIG}) : ${e.message}`); process.exit(1); }

const noms = Object.keys(servers).filter(n => !ONLY || ONLY.includes(n));
if (!noms.length) { console.error('✗ aucun serveur MCP dans la config' + (ONLY ? ' pour --only' : '')); process.exit(1); }

const out = { _doc: "Contrat RÉEL de chaque serveur MCP, mesuré par handshake JSON-RPC (initialize + tools/list, AUCUN appel d'outil). Sert à confronter la déclaration de la carte (connector.attrs.readonly / .tools) à ce que le serveur expose vraiment. Un serveur injoignable sort mesure:'non mesuré' AVEC son motif — jamais 0 outil. Régénérer : node mcp-probe.mjs", measuredAt: new Date().toISOString(), config: CONFIG, servers: {} };

for (const n of noms) {
  const r = await handshake(n, servers[n]);
  if (r.mesure === 'mesuré') {
    const l = lire(r.tools);
    out.servers[n] = { mesure: 'mesuré', transport: r.transport, ...l, outils: r.tools.map(t => t.name).sort() };
    const inc = l.incoherents.length;
    console.log(`  ${n.padEnd(12)} ${String(l.total).padStart(3)} outil(s) · ${l.readOnly} lecture · ${l.mutateurs} mutateur(s)` +
      (l.sansAnnotation ? ` · ⚠ ${l.sansAnnotation} sans annotation` : '') +
      (inc ? ` · 🔴 ${inc} annotation(s) qui ment` : ''));
    for (const i of l.incoherents) console.warn(`      🔴 ${i.tool} — ${i.quoi}`);
  } else {
    out.servers[n] = r;
    console.warn(`  ${n.padEnd(12)} non mesuré — ${r.motif}` + (r.stderr ? `\n      stderr: ${r.stderr}` : ''));
  }
}

const dest = join(__dir, 'data', 'mcp_probe.json');
writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
// Estampille la source : sans ça elle resterait éternellement `last_synced: null` et la
// fraîcheur de la mesure serait indiscernable d'une absence de collecteur (défaut C1).
try { (await import('./karto-sources.mjs')).touchSource(__dir, 'mcp-contrats'); } catch { /* source non déclarée */ }
const ok = Object.values(out.servers).filter(s => s.mesure === 'mesuré').length;
console.log(`✓ ${dest} — ${ok}/${noms.length} serveur(s) mesuré(s)${ok < noms.length ? ` · ${noms.length - ok} « non mesuré » (motif consigné, ce n'est PAS un 0)` : ''}`);
