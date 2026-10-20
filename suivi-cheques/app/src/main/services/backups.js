'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { assertPermission, forbidden, notFound, validationError, AppError } = require('./authorization');
const { appendAudit } = require('./audit');
const { getSetting } = require('./settings');
const { openDatabase, dbHealth } = require('../db');
const { verifyPassword } = require('./auth');

const BACKUP_FORMAT_VERSION = 1;
const REQUIRED_CONFIRMATION = 'RESTAURER';

const COUNTED_TABLES = [
  'companies', 'banks', 'bank_accounts', 'users', 'company_assignments', 'counterparties',
  'cheques', 'cheque_events', 'cheque_books', 'transactions', 'approval_requests', 'approval_events',
  'bank_imports', 'bank_transactions', 'reconciliation_matches', 'attachments', 'audit_logs',
];

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function walkFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(full, base));
    else if (entry.isFile()) {
      const stat = fs.statSync(full);
      result.push({
        full,
        relative: path.relative(base, full).split(path.sep).join('/'),
        size: stat.size,
        sha256: sha256File(full),
      });
    }
  }
  return result;
}

function collectCountsAndTotals(db) {
  const counts = {};
  for (const table of COUNTED_TABLES) {
    counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  }
  const totals = {
    chequeAmountCents: db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS n FROM cheques').get().n,
    transactionAmountCents: db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS n FROM transactions').get().n,
    openingBalanceCents: db.prepare('SELECT COALESCE(SUM(opening_balance_cents),0) AS n FROM bank_accounts').get().n,
    bankImportClosingCents: db.prepare('SELECT COALESCE(SUM(closing_balance_cents),0) AS n FROM bank_imports').get().n,
  };
  const schema = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return { counts, totals, schemaVersion: schema ? schema.v : null };
}

function attachmentReferences(db) {
  return db
    .prepare('SELECT id, company_id, stored_name, sha256 FROM attachments WHERE deleted_at IS NULL')
    .all()
    .map((a) => ({ id: a.id, relative: `${a.company_id}/${a.stored_name}`, sha256: a.sha256 }));
}

function buildManifest(db, paths, kind) {
  const { counts, totals, schemaVersion } = collectCountsAndTotals(db);
  const attachments = walkFiles(paths.attachmentsDir);
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    application: 'suivi-cheques',
    appVersion: '2.0.0',
    kind,
    createdAt: new Date().toISOString(),
    database: { file: 'database.sqlite' },
    counts,
    totals,
    schemaVersion,
    attachments: attachments.map((a) => ({ relative: a.relative, size: a.size, sha256: a.sha256 })),
    attachmentReferences: attachmentReferences(db),
  };
}

async function createBackup(db, paths, options = {}) {
  if (options.ctx) assertPermission(options.ctx, 'backup.manage');
  ensureDir(paths.backupsDir);
  const kind = ['MANUAL', 'AUTO', 'PRE_RESTORE', 'PRE_MIGRATION'].includes(options.kind) ? options.kind : 'MANUAL';
  const tmpRoot = fs.mkdtempSync(path.join(paths.backupsDir, '.tmp-'));
  const tmpDb = path.join(tmpRoot, 'database.sqlite');
  const filename = `Suivi-Cheques-${timestamp()}-${kind}.zip`;
  const finalPath = path.join(paths.backupsDir, filename);
  let verification;
  try {
    await db.backup(tmpDb);
    const manifest = buildManifest(db, paths, kind);
    manifest.database.sha256 = sha256File(tmpDb);
    manifest.database.size = fs.statSync(tmpDb).size;
    const zip = new AdmZip();
    zip.addLocalFile(tmpDb, '', 'database.sqlite');
    const attachments = walkFiles(paths.attachmentsDir);
    if (attachments.length) zip.addLocalFolder(paths.attachmentsDir, 'attachments');
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    zip.writeZip(finalPath);
    const buf = fs.readFileSync(finalPath);
    const digest = crypto.createHash('sha256').update(buf).digest('hex');
    verification = await verifyArchive(finalPath, paths);
    const recordId = db
      .prepare(
        `INSERT INTO backup_history(filename,path,size_bytes,sha256,kind,verified,verification_message,counts_json,created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        filename,
        finalPath,
        buf.length,
        digest,
        kind,
        verification.ok ? 1 : 0,
        verification.ok ? 'Vérifié : intégrité SQLite, comptages et pièces jointes' : verification.issues.join(' ; ').slice(0, 1000),
        JSON.stringify({ counts: manifest.counts, totals: manifest.totals }),
        options.userId || null
      ).lastInsertRowid;
    if (!verification.ok) {
      throw new AppError('BACKUP_FAILED', `Sauvegarde écrite mais non vérifiée : ${verification.issues.join(' ; ')}`, {
        filename,
        path: finalPath,
        recordId,
      });
    }
    appendAudit(db, null, {
      userId: options.userId || null,
      entityType: 'BACKUP',
      entityId: recordId,
      action: 'BACKUP_CREATE',
      after: { filename, size: buf.length, kind, verified: true, counts: manifest.counts },
      reason: options.reason || 'Sauvegarde vérifiée',
      source: 'DESKTOP',
    });
    pruneBackups(db, paths);
    return {
      id: recordId,
      filename,
      path: finalPath,
      sizeBytes: buf.length,
      sha256: digest,
      kind,
      verified: true,
      counts: manifest.counts,
      totals: manifest.totals,
      createdAt: manifest.createdAt,
    };
  } catch (err) {
    // Une sauvegarde non vérifiée ne doit jamais être présentée comme réussie.
    if (err instanceof AppError) throw err;
    throw new AppError('BACKUP_FAILED', `Échec de la sauvegarde : ${err.message}`);
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function verifyArchive(archivePath, paths) {
  const issues = [];
  const warnings = [];
  let manifest = null;
  let counts = null;
  let totals = null;
  let extractedDir = null;
  if (!fs.existsSync(archivePath)) {
    return { ok: false, issues: ['Archive absente'], warnings, manifest, counts, totals };
  }
  try {
    const zip = new AdmZip(archivePath);
    const entries = zip.getEntries().map((e) => e.entryName);
    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry) throw new Error('manifest.json absent');
    manifest = JSON.parse(zip.readAsText('manifest.json'));
    if (manifest.application !== 'suivi-cheques' || manifest.formatVersion > BACKUP_FORMAT_VERSION) {
      throw new Error('Format de sauvegarde non reconnu');
    }
    const dbEntry = zip.getEntry('database.sqlite') || zip.getEntry(manifest.database?.file);
    if (!dbEntry) throw new Error('Base de données absente de l’archive');
    const dbBuffer = zip.readFile(dbEntry);
    const actualDbHash = crypto.createHash('sha256').update(dbBuffer).digest('hex');
    if (manifest.database?.sha256 && actualDbHash !== manifest.database.sha256) {
      issues.push('Empreinte de la base de données incorrecte');
    }
    extractedDir = fs.mkdtempSync(path.join(paths.tmpDir || path.dirname(archivePath), 'verify-'));
    const tempDb = path.join(extractedDir, 'database.sqlite');
    fs.writeFileSync(tempDb, dbBuffer, { mode: 0o600 });
    let db;
    try {
      db = openDatabase(tempDb, { readonly: true });
      const health = dbHealth(db);
      if (health.integrity !== 'ok') issues.push(`Intégrité SQLite : ${health.integrity}`);
      if (health.foreignKeyErrors > 0) issues.push(`${health.foreignKeyErrors} violation(s) de clé étrangère`);
      counts = {};
      for (const table of COUNTED_TABLES) counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      const local = collectCountsAndTotals(db);
      totals = local.totals;
      for (const [table, value] of Object.entries(manifest.counts || {})) {
        if (counts[table] !== value) issues.push(`Comptage ${table} : ${counts[table]} au lieu de ${value}`);
      }
      for (const [key, value] of Object.entries(manifest.totals || {})) {
        if (Number(totals[key]) !== Number(value)) issues.push(`Total ${key} incohérent`);
      }
      // Références de pièces jointes dans la base.
      const refs = attachmentReferences(db);
      const manifestFiles = new Map((manifest.attachments || []).map((a) => [a.relative, a]));
      for (const ref of refs) {
        if (!manifestFiles.has(ref.relative)) issues.push(`Pièce jointe référencée absente de l’archive : ${ref.relative}`);
      }
      const extra = (manifest.attachments || []).filter((a) => !refs.some((r) => r.relative === a.relative));
      if (extra.length) warnings.push(`${extra.length} fichier(s) de pièce jointe non référencé(s) dans la base (conservés)`);
      for (const attachment of manifest.attachments || []) {
        const entry = zip.getEntry(`attachments/${attachment.relative}`);
        if (!entry) {
          issues.push(`Fichier de pièce jointe absent : ${attachment.relative}`);
          continue;
        }
        const buf = zip.readFile(entry);
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        if (hash !== attachment.sha256) issues.push(`Empreinte de pièce jointe incorrecte : ${attachment.relative}`);
      }
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }
    return { ok: issues.length === 0, issues, warnings, manifest, counts, totals };
  } catch (err) {
    return { ok: false, issues: [err.message], warnings, manifest, counts, totals };
  } finally {
    if (extractedDir) {
      try {
        fs.rmSync(extractedDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function assertBackupPath(paths, candidate) {
  const base = path.resolve(paths.backupsDir);
  const file = path.resolve(String(candidate));
  if (!file.startsWith(base + path.sep)) throw forbidden('Chemin de sauvegarde non autorisé');
  if (!file.endsWith('.zip')) throw validationError('Archive de sauvegarde invalide');
  if (!fs.existsSync(file)) throw notFound('Sauvegarde');
  return file;
}

function mapBackup(row) {
  return {
    id: row.id,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    kind: row.kind,
    verified: Boolean(row.verified),
    verificationMessage: row.verification_message,
    counts: row.counts_json ? JSON.parse(row.counts_json) : null,
    createdBy: row.created_by,
    creatorName: row.creator_name || null,
    createdAt: row.created_at,
  };
}

function listBackups(db, ctx) {
  assertPermission(ctx, 'backup.manage');
  return db
    .prepare(
      `SELECT b.*, u.full_name AS creator_name FROM backup_history b
       LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC LIMIT 200`
    )
    .all()
    .map(mapBackup);
}

async function verifyBackup(db, ctx, paths, input) {
  assertPermission(ctx, 'backup.manage');
  const row = db.prepare('SELECT * FROM backup_history WHERE id = ?').get(Number(input.id));
  if (!row) throw notFound('Sauvegarde');
  const file = assertBackupPath(paths, row.path);
  const result = await verifyArchive(file, paths);
  db.prepare('UPDATE backup_history SET verified = ?, verification_message = ? WHERE id = ?').run(
    result.ok ? 1 : 0,
    result.ok ? 'Vérifié à la demande' : result.issues.join(' ; ').slice(0, 1000),
    row.id
  );
  appendAudit(db, ctx, {
    entityType: 'BACKUP',
    entityId: row.id,
    action: 'BACKUP_VERIFY',
    after: { ok: result.ok, issues: result.issues, warnings: result.warnings },
    reason: 'Vérification manuelle d’une sauvegarde',
  });
  return {
    ok: result.ok,
    issues: result.issues,
    warnings: result.warnings,
    counts: result.counts,
    totals: result.totals,
    manifest: result.manifest ? { createdAt: result.manifest.createdAt, kind: result.manifest.kind, counts: result.manifest.counts } : null,
  };
}

async function previewRestore(db, ctx, paths, input) {
  assertPermission(ctx, 'backup.restore');
  const row = db.prepare('SELECT * FROM backup_history WHERE id = ?').get(Number(input.id));
  if (!row) throw notFound('Sauvegarde');
  const file = assertBackupPath(paths, row.path);
  const result = await verifyArchive(file, paths);
  const current = collectCountsAndTotals(db);
  return {
    id: row.id,
    filename: row.filename,
    createdAt: row.created_at,
    verified: result.ok,
    issues: result.issues,
    warnings: result.warnings,
    backupCounts: result.counts,
    currentCounts: current.counts,
    backupTotals: result.totals,
    currentTotals: current.totals,
    confirmationPhrase: REQUIRED_CONFIRMATION,
    requiresPassword: true,
    warning:
      'La restauration remplace intégralement la base et les documents actuels. Une sauvegarde de sécurité sera créée avant l’opération. Toutes les sessions seront fermées.',
  };
}

async function restoreBackup(db, ctx, paths, input, runtime) {
  assertPermission(ctx, 'backup.restore');
  if (String(input.confirmation || '') !== REQUIRED_CONFIRMATION) {
    throw validationError(`Saisissez exactement « ${REQUIRED_CONFIRMATION} » pour confirmer`);
  }
  const user = db.prepare('SELECT password_hash, username FROM users WHERE id = ?').get(ctx.user.id);
  if (!user || !verifyPassword(String(input.password || ''), user.password_hash)) {
    throw new AppError('AUTH_FAILED', 'Mot de passe incorrect : restauration refusée');
  }
  const row = db.prepare('SELECT * FROM backup_history WHERE id = ?').get(Number(input.id));
  if (!row) throw notFound('Sauvegarde');
  const archivePath = assertBackupPath(paths, row.path);
  const pre = await verifyArchive(archivePath, paths);
  if (!pre.ok) throw new AppError('BACKUP_INVALID', `Sauvegarde non valide : ${pre.issues.join(' ; ')}`);

  // 1) Sauvegarde de sécurité AVANT toute modification.
  const safety = await createBackup(db, paths, {
    kind: 'PRE_RESTORE',
    userId: ctx.user.id,
    reason: 'Sauvegarde automatique avant restauration',
  });

  const stamp = timestamp();
  const oldDb = `${paths.dbPath}.pre-restore-${stamp}`;
  const oldWal = `${paths.dbPath}-wal`;
  const oldShm = `${paths.dbPath}-shm`;
  const oldAttachments = `${paths.attachmentsDir}.pre-restore-${stamp}`;
  let newDb = null;
  let closed = false;
  try {
    const zip = new AdmZip(archivePath);
    const extractDir = fs.mkdtempSync(path.join(paths.tmpDir || paths.backupsDir, 'restore-'));
    zip.extractAllTo(extractDir, true);
    const restoredDb = path.join(extractDir, 'database.sqlite');
    if (!fs.existsSync(restoredDb)) throw new Error('Base de données absente de l’archive');
    // Vérification de la base extraite avec integrity_check complet.
    const check = openDatabase(restoredDb, { readonly: true });
    const health = dbHealth(check);
    if (health.integrity !== 'ok') {
      check.close();
      throw new Error(`Base restaurée corrompue : ${health.integrity}`);
    }
    check.close();

    runtime.close();
    closed = true;
    fs.renameSync(paths.dbPath, oldDb);
    if (fs.existsSync(oldWal)) fs.renameSync(oldWal, `${oldDb}-wal`);
    if (fs.existsSync(oldShm)) fs.renameSync(oldShm, `${oldDb}-shm`);
    if (fs.existsSync(paths.attachmentsDir)) fs.renameSync(paths.attachmentsDir, oldAttachments);
    ensureDir(paths.attachmentsDir);
    const restoredAttachments = path.join(extractDir, 'attachments');
    if (fs.existsSync(restoredAttachments)) {
      fs.cpSync(restoredAttachments, paths.attachmentsDir, { recursive: true });
    }
    fs.copyFileSync(restoredDb, paths.dbPath);
    newDb = runtime.reopen();
    const healthAfter = dbHealth(newDb);
    if (healthAfter.integrity !== 'ok') throw new Error(`Intégrité après restauration : ${healthAfter.integrity}`);
    const restoredCounts = collectCountsAndTotals(newDb);
    for (const [table, value] of Object.entries(pre.manifest.counts || {})) {
      if (restoredCounts.counts[table] !== value) throw new Error(`Comptage ${table} incohérent après restauration`);
    }
    for (const ref of attachmentReferences(newDb)) {
      const file = path.join(paths.attachmentsDir, `${ref.relative}`);
      if (!fs.existsSync(file)) throw new Error(`Pièce jointe manquante après restauration : ${ref.relative}`);
    }
    appendAudit(newDb, null, {
      userId: newDb.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(user.username)?.id || null,
      entityType: 'BACKUP',
      entityId: row.id,
      action: 'BACKUP_RESTORE',
      after: {
        restoredFrom: row.filename,
        preRestoreBackup: safety.filename,
        counts: restoredCounts.counts,
        actorUserId: ctx.user.id,
        actorUsername: user.username,
      },
      reason: 'Restauration confirmée par un administrateur',
      metadata: { sessionRevoked: true },
    });
    fs.rmSync(extractDir, { recursive: true, force: true });
    return {
      ok: true,
      requiresRelogin: true,
      restoredFrom: row.filename,
      preRestoreBackup: safety.filename,
      safetyPath: safety.path,
      counts: restoredCounts.counts,
      totals: restoredCounts.totals,
      previousFiles: { database: oldDb, attachments: oldAttachments },
    };
  } catch (err) {
    // 2) Retour arrière contrôlé.
    try {
      if (newDb) {
        try {
          newDb.close();
        } catch {
          /* ignore */
        }
      }
      if (closed) {
        if (fs.existsSync(paths.dbPath)) fs.unlinkSync(paths.dbPath);
        for (const suffix of ['-wal', '-shm']) {
          if (fs.existsSync(`${paths.dbPath}${suffix}`)) fs.unlinkSync(`${paths.dbPath}${suffix}`);
        }
        if (fs.existsSync(oldDb)) fs.renameSync(oldDb, paths.dbPath);
        if (fs.existsSync(`${oldDb}-wal`)) fs.renameSync(`${oldDb}-wal`, `${paths.dbPath}-wal`);
        if (fs.existsSync(`${oldDb}-shm`)) fs.renameSync(`${oldDb}-shm`, `${paths.dbPath}-shm`);
        if (fs.existsSync(paths.attachmentsDir)) fs.rmSync(paths.attachmentsDir, { recursive: true, force: true });
        if (fs.existsSync(oldAttachments)) fs.renameSync(oldAttachments, paths.attachmentsDir);
        runtime.reopen();
      }
    } catch (rollbackError) {
      throw new AppError(
        'RESTORE_ROLLBACK_FAILED',
        `Restauration échouée ET retour arrière incomplet : ${rollbackError.message}. Sauvegarde de sécurité : ${safety.path}. Fichiers précédents : ${oldDb} / ${oldAttachments}`
      );
    }
    throw new AppError('RESTORE_FAILED', `Restauration annulée et données précédentes rétablies : ${err.message}`, {
      safetyPath: safety.path,
    });
  }
}

function pruneBackups(db, paths) {
  const retention = Math.max(3, Number(getSetting(db, 'backup.retention', 10)));
  const rows = db
    .prepare("SELECT * FROM backup_history WHERE verified = 1 AND kind IN ('MANUAL','AUTO') ORDER BY id DESC")
    .all();
  const old = rows.slice(retention);
  for (const row of old) {
    try {
      const file = path.resolve(row.path);
      const base = path.resolve(paths.backupsDir);
      if (file.startsWith(base + path.sep) && fs.existsSync(file)) fs.unlinkSync(file);
      db.prepare("UPDATE backup_history SET verified = 0, verification_message = 'Supprimée par la politique de rétention' WHERE id = ?").run(row.id);
    } catch {
      /* une erreur de purge ne doit pas invalider la sauvegarde courante */
    }
  }
  return old.length;
}

async function autoBackupIfDue(db, paths, options = {}) {
  if (!getSetting(db, 'backup.auto_enabled', true)) return { skipped: 'DISABLED' };
  const hours = Number(getSetting(db, 'backup.auto_interval_hours', 24));
  const last = db
    .prepare("SELECT created_at FROM backup_history WHERE verified = 1 ORDER BY id DESC LIMIT 1")
    .get();
  const due = !last || Date.now() - Date.parse(last.created_at) >= hours * 3600_000;
  if (!due) return { skipped: 'NOT_DUE', lastAt: last.created_at };
  const backup = await createBackup(db, paths, { kind: 'AUTO', userId: null, reason: 'Sauvegarde automatique planifiée' });
  return { created: true, backup };
}

module.exports = {
  REQUIRED_CONFIRMATION,
  createBackup,
  verifyArchive,
  listBackups,
  verifyBackup,
  previewRestore,
  restoreBackup,
  pruneBackups,
  autoBackupIfDue,
  collectCountsAndTotals,
};
