'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertPermission, assertCompanyAccess, resolveCompanyScope, validationError, forbidden, notFound } = require('./authorization');
const { appendAudit } = require('./audit');
const { getAccount } = require('./common');

const MAX_SIZE = 20 * 1024 * 1024;
const ALLOWED = new Map([
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.csv', 'text/csv'],
  ['.txt', 'text/plain'],
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function assertEntityCompany(db, entityType, entityId, companyId) {
  const type = String(entityType).toUpperCase();
  if (!['CHEQUE', 'APPROBATION', 'IMPORT', 'SOCIETE'].includes(type)) throw validationError('Type de document invalide');
  if (type === 'SOCIETE') {
    if (Number(entityId) !== Number(companyId)) throw validationError('Société incohérente');
    return;
  }
  if (type === 'CHEQUE') {
    const row = db.prepare('SELECT company_id FROM cheques WHERE id = ?').get(Number(entityId));
    if (!row) throw notFound('Chèque');
    if (row.company_id !== Number(companyId)) throw forbidden('Ce chèque n’appartient pas à la société indiquée');
    return;
  }
  if (type === 'APPROBATION') {
    const row = db.prepare('SELECT company_id FROM approval_requests WHERE id = ?').get(Number(entityId));
    if (!row) throw notFound('Demande d’approbation');
    if (row.company_id !== null && row.company_id !== Number(companyId)) throw forbidden('Demande hors société');
    return;
  }
  if (type === 'IMPORT') {
    const row = db.prepare('SELECT company_id FROM bank_imports WHERE id = ?').get(Number(entityId));
    if (!row) throw notFound('Import');
    if (row.company_id !== Number(companyId)) throw forbidden('Import hors société');
  }
}

function addAttachment(db, ctx, input) {
  assertPermission(ctx, 'documents.manage');
  assertCompanyAccess(ctx, input.companyId);
  const sourcePath = String(input.sourcePath || '');
  if (!sourcePath) throw validationError('Fichier source manquant');
  const originalName = path.basename(String(input.originalName || sourcePath)).replace(/[\u0000-\u001f]/g, '').slice(0, 200);
  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED.has(ext)) throw validationError('Type de document non autorisé (PDF, PNG, JPG, XLSX, CSV, TXT)');
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) throw validationError('Le document sélectionné n’est pas un fichier');
  if (stat.size <= 0) throw validationError('Fichier vide');
  if (stat.size > MAX_SIZE) throw validationError('Document trop volumineux (20 Mo maximum)');
  assertEntityCompany(db, input.entityType, input.entityId, input.companyId);
  const buffer = fs.readFileSync(sourcePath);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const storedName = `${crypto.randomUUID()}${ext}`;
  const dir = path.join(input.attachmentsDir, String(input.companyId));
  ensureDir(dir);
  const dest = path.join(dir, storedName);
  fs.writeFileSync(dest, buffer, { mode: 0o600 });
  try {
    const id = db.transaction(() => {
      const newId = Number(
        db
          .prepare(
            `INSERT INTO attachments(company_id, entity_type, entity_id, original_name, stored_name, mime_type, size_bytes, sha256, uploaded_by)
             VALUES (?,?,?,?,?,?,?,?,?)`
          )
          .run(
            Number(input.companyId),
            String(input.entityType).toUpperCase(),
            String(input.entityId),
            originalName,
            storedName,
            ALLOWED.get(ext),
            stat.size,
            sha256,
            ctx.user.id
          ).lastInsertRowid
      );
      appendAudit(db, ctx, {
        companyId: Number(input.companyId),
        entityType: 'DOCUMENT',
        entityId: newId,
        action: 'ATTACHMENT_ADD',
        after: { entityType: input.entityType, entityId: input.entityId, originalName, size: stat.size, sha256 },
        reason: input.reason || 'Ajout d’un document justificatif',
      });
      return newId;
    }).immediate();
    return {
      id,
      originalName,
      mimeType: ALLOWED.get(ext),
      sizeBytes: stat.size,
      sha256,
      createdAt: new Date().toISOString(),
    };
  } catch (err) {
    try {
      fs.unlinkSync(dest);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function listAttachments(db, ctx, filters = {}) {
  assertPermission(ctx, 'documents.view');
  const companyIds = resolveCompanyScope(ctx, filters.companyIds);
  if (!companyIds.length) return [];
  const params = [...companyIds];
  let where = `at.company_id IN (${companyIds.map(() => '?').join(',')}) AND at.deleted_at IS NULL`;
  if (filters.companyId) {
    assertCompanyAccess(ctx, filters.companyId);
    where += ' AND at.company_id = ?';
    params.push(Number(filters.companyId));
  }
  if (filters.entityType) {
    where += ' AND at.entity_type = ?';
    params.push(String(filters.entityType).toUpperCase());
  }
  if (filters.entityId) {
    where += ' AND at.entity_id = ?';
    params.push(String(filters.entityId));
  }
  return db
    .prepare(
      `SELECT at.*, c.name AS company_name, u.full_name AS uploader_name
       FROM attachments at JOIN companies c ON c.id = at.company_id
       LEFT JOIN users u ON u.id = at.uploaded_by
       WHERE ${where} ORDER BY at.id DESC LIMIT 500`
    )
    .all(...params)
    .map((a) => ({
      id: a.id,
      companyId: a.company_id,
      companyName: a.company_name,
      entityType: a.entity_type,
      entityId: a.entity_id,
      originalName: a.original_name,
      mimeType: a.mime_type,
      sizeBytes: a.size_bytes,
      sha256: a.sha256,
      uploaderName: a.uploader_name,
      createdAt: a.created_at,
    }));
}

function getAttachmentRow(db, ctx, id) {
  assertPermission(ctx, 'documents.view');
  const row = db.prepare('SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) throw notFound('Document');
  assertCompanyAccess(ctx, row.company_id);
  return row;
}

function resolveAttachmentPath(row, attachmentsDir) {
  const base = path.resolve(attachmentsDir);
  const file = path.resolve(base, String(row.company_id), row.stored_name);
  if (!file.startsWith(base + path.sep)) throw forbidden('Chemin de document invalide');
  if (!fs.existsSync(file)) throw notFound('Fichier joint');
  return file;
}

function attachmentPath(db, ctx, id, attachmentsDir) {
  const row = getAttachmentRow(db, ctx, id);
  return { path: resolveAttachmentPath(row, attachmentsDir), name: row.original_name, mimeType: row.mime_type };
}

function copyAttachmentTo(db, ctx, id, attachmentsDir, destination) {
  const row = getAttachmentRow(db, ctx, id);
  assertPermission(ctx, 'documents.view');
  const file = resolveAttachmentPath(row, attachmentsDir);
  fs.copyFileSync(file, destination);
  return { name: row.original_name, size: row.size_bytes };
}

function deleteAttachment(db, ctx, id, reason) {
  assertPermission(ctx, 'documents.manage');
  const row = getAttachmentRow(db, ctx, id);
  db.transaction(() => {
    db.prepare('UPDATE attachments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(new Date().toISOString(), row.id);
    appendAudit(db, ctx, {
      companyId: row.company_id,
      entityType: 'DOCUMENT',
      entityId: row.id,
      action: 'ATTACHMENT_DELETE',
      before: { originalName: row.original_name },
      after: { deletedAt: new Date().toISOString() },
      reason: reason || 'Retrait d’un document justificatif (fichier conservé)',
    });
  }).immediate();
  return { ok: true };
}

module.exports = {
  MAX_SIZE,
  ALLOWED,
  addAttachment,
  listAttachments,
  attachmentPath,
  copyAttachmentTo,
  deleteAttachment,
  resolveAttachmentPath,
};
