'use strict';

const { assertPermission, resolveCompanyScope, validationError } = require('./authorization');
const { parseJson, redactSensitive } = require('../db');

/**
 * Journal d'audit structuré. Les triggers SQL interdisent toute modification ou
 * suppression. Une opération financière échoue si son audit ne peut pas être écrit.
 */
function appendAudit(db, ctx, entry) {
  if (!entry || !entry.action || !entry.entityType) {
    throw validationError('Entrée d’audit incomplète');
  }
  const userId = ctx && ctx.user ? ctx.user.id : entry.userId || null;
  const sessionId = ctx && ctx.session ? ctx.session.id : null;
  const before = entry.before === undefined ? null : JSON.stringify(redactSensitive(entry.before));
  const after = entry.after === undefined ? null : JSON.stringify(redactSensitive(entry.after));
  const metadata = entry.metadata === undefined ? null : JSON.stringify(redactSensitive(entry.metadata));
  const result = db
    .prepare(
      `INSERT INTO audit_logs
        (user_id, company_id, entity_type, entity_id, action, before_json, after_json,
         reason, approval_request_id, session_id, source, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      entry.companyId === undefined ? null : entry.companyId,
      entry.entityType,
      entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
      entry.action,
      before,
      after,
      entry.reason || null,
      entry.approvalRequestId || null,
      sessionId,
      entry.source || 'DESKTOP',
      metadata
    );
  return Number(result.lastInsertRowid);
}

function mapAuditRow(row) {
  return {
    id: row.id,
    at: row.at,
    userId: row.user_id,
    username: row.username || null,
    userFullName: row.full_name || null,
    companyId: row.company_id,
    companyName: row.company_name || null,
    companyCode: row.company_code || null,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    reason: row.reason,
    approvalRequestId: row.approval_request_id,
    sessionId: row.session_id,
    source: row.source,
    metadata: parseJson(row.metadata_json),
  };
}

const NON_FINANCIAL_ENTITIES = ['USER', 'ROLE', 'SETTINGS', 'PARAMETRE', 'BACKUP', 'AUTH', 'MIGRATION', 'SESSION', 'DOCUMENT'];

function listAudit(db, ctx, filters = {}) {
  assertPermission(ctx, 'audit.view');
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(200, Math.max(10, Number(filters.pageSize) || 50));
  const params = [];
  const where = [];

  const companyIds = resolveCompanyScope(ctx, filters.companyIds);
  if (filters.companyIds !== undefined && filters.companyIds !== null && !(Array.isArray(filters.companyIds) && filters.companyIds.length === 0)) {
    where.push(`a.company_id IN (${companyIds.map(() => '?').join(',')})`);
    params.push(...companyIds);
  } else if (ctx.user.role !== 'DG' && ctx.user.role !== 'ADMIN') {
    const scoped = companyIds;
    where.push(`(a.company_id IS NULL OR a.company_id IN (${scoped.map(() => '?').join(',')}))`);
    params.push(...scoped);
  } else if (ctx.user.role === 'ADMIN') {
    where.push(`a.entity_type IN (${NON_FINANCIAL_ENTITIES.map(() => '?').join(',')})`);
    params.push(...NON_FINANCIAL_ENTITIES);
  }

  if (filters.entityType) {
    where.push('a.entity_type = ?');
    params.push(String(filters.entityType));
  }
  if (filters.entityId) {
    where.push('a.entity_id = ?');
    params.push(String(filters.entityId));
  }
  if (filters.userId) {
    where.push('a.user_id = ?');
    params.push(Number(filters.userId));
  }
  if (filters.action) {
    where.push('a.action = ?');
    params.push(String(filters.action));
  }
  if (filters.dateFrom) {
    where.push('substr(a.at,1,10) >= ?');
    params.push(String(filters.dateFrom));
  }
  if (filters.dateTo) {
    where.push('substr(a.at,1,10) <= ?');
    params.push(String(filters.dateTo));
  }
  if (filters.search) {
    where.push('(a.action LIKE ? OR a.reason LIKE ? OR a.entity_id LIKE ?)');
    const like = `%${String(filters.search).slice(0, 100)}%`;
    params.push(like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM audit_logs a ${whereSql}`)
    .get(...params).n;
  const rows = db
    .prepare(
      `SELECT a.*, u.username, u.full_name, c.name AS company_name, c.code AS company_code
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN companies c ON c.id = a.company_id
       ${whereSql}
       ORDER BY a.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return {
    rows: rows.map(mapAuditRow),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function auditForExport(db, ctx, filters = {}) {
  const all = [];
  let page = 1;
  for (;;) {
    const chunk = listAudit(db, ctx, { ...filters, page, pageSize: 200 });
    all.push(...chunk.rows);
    if (page >= chunk.pageCount) break;
    page += 1;
    if (page > 500) break;
  }
  return all;
}

function checkAuditImmutability(db) {
  // Vérification défensive au démarrage : triggers présents.
  const triggers = db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('trg_audit_no_update','trg_audit_no_delete')")
    .all()
    .map((r) => r.name);
  if (triggers.length !== 2) {
    throw new Error('Protection de la piste d’audit absente : démarrage refusé');
  }
  return true;
}

module.exports = { appendAudit, listAudit, auditForExport, checkAuditImmutability, mapAuditRow };
