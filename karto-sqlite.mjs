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
