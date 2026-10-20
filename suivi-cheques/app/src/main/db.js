'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Ouvre une base SQLite et applique les migrations manquantes.
 * Les migrations sont immuables : toute modification d'un fichier déjà appliqué
 * est détectée par empreinte et bloque le démarrage.
 */
function openDatabase(filename, options = {}) {
  const { readonly = false, migrationsDir = MIGRATIONS_DIR, verbose = false } = options;
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  }
  const db = new Database(filename, {
    readonly,
    fileMustExist: readonly,
    timeout: 5000,
  });
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
  }
  if (verbose) db.pragma('verbose = 1');

  if (!readonly) runMigrations(db, migrationsDir);

  const fk = db.pragma('foreign_key_check');
  if (Array.isArray(fk) && fk.length) {
    db.close();
    throw new Error(`Intégrité référentielle invalide : ${JSON.stringify(fk.slice(0, 5))}`);
  }
  return db;
}

function runMigrations(db, migrationsDir = MIGRATIONS_DIR) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{3,4}_.+\.sql$/.test(f))
    .sort();

  const applied = new Map(
    db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all().map((r) => [r.version, r])
  );

  for (const file of files) {
    const match = file.match(/^(\d{3,4})_/);
    const version = Number(match[1]);
    const full = path.join(migrationsDir, file);
    const checksum = sha256File(full);
    const existing = applied.get(version);
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error(
          `Migration ${file} modifiée après application (empreinte différente). Refus de démarrer : créez une nouvelle migration.`
        );
      }
      continue;
    }
    const sql = fs.readFileSync(full, 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version,name,checksum) VALUES (?,?,?)').run(version, file, checksum);
    });
    apply.immediate();
  }
}

/** Exécute une fonction dans une transaction IMMEDIATE (verrou d'écriture immédiat). */
function transaction(db, fn) {
  return db.transaction(fn).immediate();
}

/** Compteur atomique pour les références lisibles. */
function nextSequence(db, scope, period) {
  const row = db
    .prepare(
      `INSERT INTO sequence_counters(scope, period, last_value) VALUES (?, ?, 1)
       ON CONFLICT(scope, period) DO UPDATE SET last_value = last_value + 1
       RETURNING last_value`
    )
    .get(scope, String(period));
  return row.last_value;
}

function makeReference(prefix, period, seq, width = 6) {
  return `${prefix}-${period}-${String(seq).padStart(width, '0')}`;
}

function nowUtc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function json(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function redactSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clone = Array.isArray(obj) ? obj.map(redactSensitive) : { ...obj };
  for (const key of Object.keys(clone)) {
    if (/password|hash|token|secret/i.test(key)) {
      clone[key] = '[masqué]';
    } else if (typeof clone[key] === 'object') {
      clone[key] = redactSensitive(clone[key]);
    }
  }
  return clone;
}

function dbHealth(db) {
  const integrity = db.pragma('integrity_check', { simple: true });
  const fk = db.pragma('foreign_key_check');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  return { integrity, foreignKeyErrors: fk.length, tables };
}

module.exports = {
  openDatabase,
  runMigrations,
  transaction,
  nextSequence,
  makeReference,
  nowUtc,
  json,
  parseJson,
  redactSensitive,
  dbHealth,
  sha256File,
  MIGRATIONS_DIR,
};
