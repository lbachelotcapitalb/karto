// karto-sqlite.mjs — moteur SQLite portable, ZÉRO dépendance npm.
// Deux implémentations derrière la MÊME API (sous-ensemble de node:sqlite) :
//   1) node:sqlite (Node ≥ 22)         → passe-plat natif, rapide (chemin par défaut).
//   2) binaire système `sqlite3`        → repli pour Node 18/20 (ou KARTO_FORCE_CLI=1).
// Permet à karto (build + requête + MCP) de tourner partout : Node 22 OU un Node plus
// ancien tant que la commande `sqlite3` est présente (macOS l'a d'origine ; ailleurs :
// apt install sqlite3 / brew install sqlite).
//
// API exposée par openDb(path,{readOnly}) : .exec(sql) · .prepare(sql).{run,get,all} · .flush() · .close() · .engine
// (En mode CLI, les écritures sont bufferisées puis flushées ; une lecture flushe d'abord.)

import { execFileSync } from 'node:child_process';

let DatabaseSync = null;
if (process.env.KARTO_FORCE_CLI !== '1') {
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* Node < 22 : pas de node:sqlite */ }
}

let _sqlite3ok = null;
function hasSqlite3() {
  if (_sqlite3ok !== null) return _sqlite3ok;
  try { execFileSync('sqlite3', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] }); _sqlite3ok = true; }
  catch { _sqlite3ok = false; }
  return _sqlite3ok;
}

function inlineParam(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function inlineSql(sql, params) { let i = 0; return sql.replace(/\?/g, () => inlineParam(params[i++])); }

class CliDb {
  constructor(path, { readOnly = false } = {}) { this.path = path; this.readOnly = readOnly; this.buf = []; this.engine = 'sqlite3-cli'; }
  exec(sql) { if (this.readOnly) throw new Error('base en lecture seule'); this.buf.push(sql); }
  prepare(sql) {
    const self = this;
    return {
      run(...p) { if (self.readOnly) throw new Error('base en lecture seule'); self.buf.push(inlineSql(sql, p)); return { changes: 0 }; },
      get(...p) { return self._query(inlineSql(sql, p))[0]; },
      all(...p) { return self._query(inlineSql(sql, p)); }
    };
  }
  _query(sql) {
    if (this.buf.length) this.flush();                       // cohérence : flushe les écritures avant de lire
    let out = '';
    try { out = execFileSync('sqlite3', ['-json', '-readonly', this.path, sql], { encoding: 'utf8', maxBuffer: 1 << 28 }); }
    catch (e) { throw new Error(((e.stderr || e.message || '') + '').trim() || String(e)); }
    out = out.trim(); if (!out) return [];
    try { return JSON.parse(out); } catch { return []; }
  }
  flush() {
    if (!this.buf.length) return;
    // WAL échoue via le CLI sur un FS synchronisé (iCloud/réseau) → journal rollback classique.
    // (Sans effet sur le contenu ; node:sqlite garde WAL de son côté.)
    const script = this.buf.join(';\n').replace(/journal_mode\s*=\s*WAL/gi, 'journal_mode = DELETE') + ';\n';
    this.buf = [];
    execFileSync('sqlite3', [this.path], { input: script, encoding: 'utf8', maxBuffer: 1 << 28 });
  }
  close() { this.flush(); }
}

// ---------- garde SQL lecture seule (partagé karto-mcp + karto-query) ----------
// N'exclut que les VRAIS mutateurs : INSERT/UPDATE/DELETE/DROP/ATTACH/…, et PRAGMA d'écriture.
// Tout le reste passe : SELECT, WITH, EXPLAIN, VALUES, PRAGMA de lecture (table_info…) —
// y compris précédés de commentaires SQL (-- … ou /* … */) ou d'une parenthèse ((SELECT…) UNION…).
// Défense en profondeur : la base est de toute façon ouverte readOnly (node:sqlite
// {readOnly:true} / sqlite3 -readonly), donc un WITH…INSERT qui passerait le garde
// échoue quand même au niveau SQLite. Le garde sert à donner une erreur claire.
const SQL_MUTATORS = /^(insert|update|delete|replace|drop|create|alter|attach|detach|vacuum|reindex|analyze|begin|commit|end|rollback|savepoint|release)\b/i;

// Vrai s'il reste du SQL après un ';' HORS chaînes/identifiants/commentaires (multi-requête).
function hasExtraStatement(q) {
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (c === "'" || c === '"' || c === '`') { i++; while (i < q.length && q[i] !== c) i++; continue; }   // '' interne : ressort puis re-rentre, sans effet
    if (c === '[') { while (i < q.length && q[i] !== ']') i++; continue; }
    if (c === '-' && q[i + 1] === '-') { const nl = q.indexOf('\n', i); if (nl < 0) return false; i = nl; continue; }
    if (c === '/' && q[i + 1] === '*') { const e = q.indexOf('*/', i); if (e < 0) return false; i = e + 1; continue; }
    if (c === ';') return /\S/.test(q.slice(i + 1));
  }
  return false;
}

export function checkReadOnlySql(query) {
  const q = String(query || '').trim();
  if (!q) return { error: 'requête vide' };
  // premier mot-clé réel : saute espaces, parenthèses ouvrantes et commentaires en tête
  let head = q;
  for (;;) {
    const h = head.replace(/^[\s(]+/, '').replace(/^--[^\n]*\n?/, '').replace(/^\/\*[\s\S]*?\*\//, '');
    if (h === head) break; head = h;
  }
  if (!head) return { error: 'requête vide' };
  const m = head.match(SQL_MUTATORS);
  if (m) return { error: `lecture seule : ${m[1].toUpperCase()} refusé (seuls les SELECT/WITH/EXPLAIN/VALUES/PRAGMA de lecture sont autorisés)` };
  if (/^pragma\s+[\w."'`[\]]+\s*=/i.test(head)) return { error: "lecture seule : PRAGMA d'écriture refusé" };
  if (hasExtraStatement(q)) return { error: 'une seule requête à la fois (pas de ;)' };
  return { ok: true };
}

export function engineName() { return DatabaseSync ? 'node:sqlite' : (hasSqlite3() ? 'sqlite3-cli' : 'none'); }

export function openDb(path, opts = {}) {
  if (DatabaseSync) {
    const db = new DatabaseSync(path, opts);
    if (typeof db.flush !== 'function') db.flush = () => {};   // no-op : API homogène avec le repli CLI
    db.engine = 'node:sqlite';
    return db;
  }
  if (!hasSqlite3())
    throw new Error("Aucun moteur SQLite : il faut Node ≥ 22 (node:sqlite, recommandé) OU le binaire `sqlite3` (macOS l'a ; sinon `brew install sqlite` / `apt install sqlite3`).");
  return new CliDb(path, opts);
}
