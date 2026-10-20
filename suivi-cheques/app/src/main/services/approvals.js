'use strict';

const {
  assertPermission,
  assertCompanyAccess,
  assertApproverRole,
  assertNotSelfApproval,
  resolveCompanyScope,
  validationError,
  forbidden,
  notFound,
  AppError,
} = require('./authorization');
const { appendAudit } = require('./audit');
const { getSetting } = require('./settings');
const { nextSequence, makeReference, parseJson, transaction } = require('../db');
const { createNotification, notifyRole } = require('./notifications');

const OPERATION_LABELS = {
  CHEQUE_CREATE: 'Création de chèque',
  CHEQUE_UPDATE: 'Modification de chèque',
  CHEQUE_STATUS: 'Correction de statut de chèque',
  RECONCILIATION_CONFIRM: 'Finalisation de rapprochement bancaire',
};

const ALLOWED_OPERATIONS = new Set(Object.keys(OPERATION_LABELS));
const ALLOWED_ENTITY_TYPES = new Set(['CHEQUE', 'COMPTE', 'SOCIETE', 'RAPPROCHEMENT', 'PARAMETRE']);

function mapRequest(row, ctx = null, selfApprovalAllowed = false) {
  const isOwnRequest = ctx ? Number(row.requested_by) === Number(ctx.user.id) : false;
  const canDecide = Boolean(
    ctx &&
      ctx.permissions.has('approvals.decide') &&
      ctx.user.role === 'DG' &&
      row.status === 'PENDING' &&
      (!isOwnRequest || selfApprovalAllowed)
  );
  return {
    id: row.id,
    reference: row.reference,
    companyId: row.company_id,
    companyName: row.company_name,
    companyCode: row.company_code,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    operationLabel: OPERATION_LABELS[row.operation] || row.operation,
    title: row.title,
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    status: row.status,
    requestedBy: row.requested_by,
    requesterName: row.requester_name,
    requesterRole: row.requester_role,
    requestedAt: row.requested_at,
    decidedBy: row.decided_by,
    deciderName: row.decider_name,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
    appliedAt: row.applied_at,
    applyError: row.apply_error,
    version: row.version,
    isOwnRequest,
    canDecide,
    createdAt: row.requested_at,
  };
}

function assertHasApprover(db, ctx) {
  const selfAllowed = getSetting(db, 'approval.self_approval_allowed', false);
  if (ctx.user.role === 'DG' && !selfAllowed) {
    const others = db
      .prepare(
        `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id
         WHERE r.code = 'DG' AND u.is_active = 1 AND u.id <> ?`
      )
      .get(ctx.user.id).n;
    if (others === 0) {
      throw forbidden(
        'Aucun autre Directeur Général actif ne peut approuver cette demande. Créez un second compte DG, ou autorisez explicitement l’auto-approbation dans les paramètres d’approbation.'
      );
    }
  } else {
    const approvers = db
      .prepare(
        `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'DG' AND u.is_active = 1`
      )
      .get().n;
    if (approvers === 0) throw forbidden('Aucun Directeur Général actif ne peut approuver cette demande');
  }
}

function createRequest(db, ctx, payload) {
  assertPermission(ctx, 'approvals.request');
  if (!payload || !ALLOWED_OPERATIONS.has(payload.operation)) throw validationError('Type d’opération protégée inconnu');
  if (!ALLOWED_ENTITY_TYPES.has(payload.entityType)) throw validationError('Type d’entité inconnu');
  const title = String(payload.title || '').trim();
  if (!title || title.length > 300) throw validationError('Titre de demande invalide');
  if (payload.after === undefined || payload.after === null) throw validationError('Valeurs proposées requises');
  if (payload.companyId !== null && payload.companyId !== undefined) {
    assertCompanyAccess(ctx, payload.companyId);
  }
  const afterJson = JSON.stringify(payload.after);
  const beforeJson = payload.before === undefined || payload.before === null ? null : JSON.stringify(payload.before);
  if (afterJson.length > 100_000 || (beforeJson && beforeJson.length > 100_000)) {
    throw validationError('Contenu de demande trop volumineux');
  }
  assertHasApprover(db, ctx);
  const year = new Date().getFullYear();
  try {
    return transaction(db, () => {
      const reference = makeReference('APR', year, nextSequence(db, 'APPROVAL', year));
      const id = Number(
        db
          .prepare(
            `INSERT INTO approval_requests(
              reference, company_id, entity_type, entity_id, operation, title, before_json, after_json,
              dedupe_key, status, requested_by
            ) VALUES (?,?,?,?,?,?,?,?,?,'PENDING',?)`
          )
          .run(
            reference,
            payload.companyId || null,
            payload.entityType,
            payload.entityId === undefined || payload.entityId === null ? null : String(payload.entityId),
            payload.operation,
            title,
            beforeJson,
            afterJson,
            payload.dedupeKey || null,
            ctx.user.id
          ).lastInsertRowid
      );
      db.prepare('INSERT INTO approval_events(request_id, action, actor_id, reason) VALUES (?,?,?,?)').run(
        id,
        'SUBMIT',
        ctx.user.id,
        'Demande soumise'
      );
      appendAudit(db, ctx, {
        companyId: payload.companyId || null,
        entityType: 'APPROBATION',
        entityId: id,
        action: 'APPROVAL_SUBMIT',
        before: payload.before || null,
        after: { operation: payload.operation, entityType: payload.entityType, entityId: payload.entityId, values: payload.after },
        reason: title,
      });
      notifyRole(db, {
        roleCode: 'DG',
        companyId: payload.companyId || null,
        type: 'APPROVAL_REQUESTED',
        title: `Approbation requise : ${title}`,
        body: `Demande ${reference} soumise par ${ctx.user.fullName}`,
        entityType: 'APPROBATION',
        entityId: id,
        excludeUserId: ctx.user.id,
      });
      return loadRequest(db, id, ctx);
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE') && String(err.message).includes('dedupe')) {
      throw new AppError('CONFLICT', 'Une demande identique est déjà en attente d’approbation');
    }
    if (String(err.message).includes('UNIQUE')) {
      throw new AppError('CONFLICT', 'Une demande identique est déjà en attente d’approbation');
    }
    throw err;
  }
}

function loadRequest(db, id, ctx = null) {
  const row = db
    .prepare(
      `SELECT ar.*, c.name AS company_name, c.code AS company_code,
              req.full_name AS requester_name, rr.code AS requester_role,
              dec.full_name AS decider_name
       FROM approval_requests ar
       LEFT JOIN companies c ON c.id = ar.company_id
       LEFT JOIN users req ON req.id = ar.requested_by
       LEFT JOIN roles rr ON rr.id = req.role_id
       LEFT JOIN users dec ON dec.id = ar.decided_by
       WHERE ar.id = ?`
    )
    .get(Number(id));
  if (!row) throw notFound('Demande d’approbation');
  return mapRequest(row, ctx, getSetting(db, 'approval.self_approval_allowed', false));
}

function assertCanView(ctx) {
  if (!ctx.permissions.has('approvals.decide') && !ctx.permissions.has('approvals.request')) {
    throw forbidden('Permission d’approbation requise');
  }
}

function listRequests(db, ctx, filters = {}) {
  assertCanView(ctx);
  const companyIds = resolveCompanyScope(ctx, filters.companyIds);
  const params = [];
  const where = [];
  if (!companyIds.length) where.push('0=1');
  else if (filters.companyIds !== undefined || !ctx.permissions.has('approvals.decide')) {
    where.push(`(ar.company_id IS NULL OR ar.company_id IN (${companyIds.map(() => '?').join(',')}))`);
    params.push(...companyIds);
  }
  if (!ctx.permissions.has('approvals.decide')) {
    where.push('ar.requested_by = ?');
    params.push(ctx.user.id);
  } else if (filters.mineOnly) {
    where.push('ar.requested_by = ?');
    params.push(ctx.user.id);
  }
  if (filters.status && filters.status !== 'ALL') {
    where.push('ar.status = ?');
    params.push(String(filters.status).toUpperCase());
  }
  if (filters.operation) {
    where.push('ar.operation = ?');
    params.push(String(filters.operation));
  }
  if (filters.search) {
    where.push('(ar.reference LIKE ? OR ar.title LIKE ?)');
    const like = `%${String(filters.search).slice(0, 80)}%`;
    params.push(like, like);
  }
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(filters.pageSize) || 30));
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM approval_requests ar ${whereSql}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT ar.*, c.name AS company_name, c.code AS company_code,
              req.full_name AS requester_name, rr.code AS requester_role,
              dec.full_name AS decider_name
       FROM approval_requests ar
       LEFT JOIN companies c ON c.id = ar.company_id
       LEFT JOIN users req ON req.id = ar.requested_by
       LEFT JOIN roles rr ON rr.id = req.role_id
       LEFT JOIN users dec ON dec.id = ar.decided_by
       ${whereSql}
       ORDER BY CASE ar.status WHEN 'PENDING' THEN 0 ELSE 1 END, ar.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return {
    items: rows.map((r) => mapRequest(r, ctx, getSetting(db, 'approval.self_approval_allowed', false))),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function getRequest(db, ctx, id) {
  assertCanView(ctx);
  const request = loadRequest(db, id, ctx);
  if (request.companyId) assertCompanyAccess(ctx, request.companyId);
  if (!ctx.permissions.has('approvals.decide') && Number(request.requestedBy) !== Number(ctx.user.id)) {
    throw forbidden('Cette demande ne vous appartient pas');
  }
  request.events = db
    .prepare(
      `SELECT ae.*, u.full_name AS actor_name FROM approval_events ae
       LEFT JOIN users u ON u.id = ae.actor_id WHERE ae.request_id = ? ORDER BY ae.id ASC`
    )
    .all(id)
    .map((e) => ({
      id: e.id,
      action: e.action,
      actorId: e.actor_id,
      actorName: e.actor_name,
      at: e.at,
      reason: e.reason,
      metadata: parseJson(e.metadata_json),
    }));
  request.attachments = db
    .prepare(
      `SELECT id, original_name, mime_type, size_bytes, created_at FROM attachments
       WHERE entity_type='APPROBATION' AND entity_id = ? AND deleted_at IS NULL`
    )
    .all(String(id))
    .map((a) => ({ id: a.id, originalName: a.original_name, mimeType: a.mime_type, sizeBytes: a.size_bytes, createdAt: a.created_at }));
  return request;
}

function applyOperation(db, ctx, request) {
  if (request.operation.startsWith('CHEQUE_')) {
    const cheques = require('./cheques');
    return cheques.applyApprovedOperation(db, ctx, request);
  }
  if (request.operation === 'RECONCILIATION_CONFIRM') {
    const reconciliation = require('./reconciliation');
    return reconciliation.applyApprovedConfirmation(db, ctx, request);
  }
  throw validationError(`Aucun gestionnaire pour l’opération ${request.operation}`);
}

function decide(db, ctx, input) {
  assertPermission(ctx, 'approvals.decide');
  assertApproverRole(ctx);
  const decision = String(input.decision || '').toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(decision)) throw validationError('Décision invalide');
  const reason = String(input.reason || '').trim();
  if (decision === 'REJECTED' && reason.length < 3) throw validationError('Un motif de rejet est obligatoire');
  if (reason.length > 1000) throw validationError('Motif trop long');
  const selfAllowed = getSetting(db, 'approval.self_approval_allowed', false);

  let result;
  try {
    result = transaction(db, () => {
      const raw = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(Number(input.id));
      if (!raw) throw notFound('Demande d’approbation');
      if (raw.status !== 'PENDING') {
        throw new AppError('CONFLICT', 'Cette demande a déjà été traitée (protection contre le double traitement)');
      }
      if (raw.company_id) assertCompanyAccess(ctx, raw.company_id);
      if (Number(raw.requested_by) === Number(ctx.user.id) && !selfAllowed) {
        assertNotSelfApproval(ctx, raw.requested_by);
      }
      const now = new Date().toISOString();
      const update = db
        .prepare(
          `UPDATE approval_requests
           SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ?, version = version + 1
           WHERE id = ? AND status = 'PENDING'`
        )
        .run(decision, ctx.user.id, now, reason || null, raw.id);
      if (update.changes !== 1) {
        throw new AppError('CONFLICT', 'Cette demande a déjà été traitée');
      }
      db.prepare('INSERT INTO approval_events(request_id, action, actor_id, reason) VALUES (?,?,?,?)').run(
        raw.id,
        decision === 'APPROVED' ? 'APPROVE' : 'REJECT',
        ctx.user.id,
        reason || null
      );

      let applied = null;
      if (decision === 'APPROVED') {
        applied = applyOperation(db, ctx, raw);
        db.prepare('UPDATE approval_requests SET applied_at = ? WHERE id = ?').run(now, raw.id);
        db.prepare('INSERT INTO approval_events(request_id, action, actor_id, reason, metadata_json) VALUES (?,?,?,?,?)').run(
          raw.id,
          'APPLY',
          ctx.user.id,
          'Opération appliquée',
          JSON.stringify(applied)
        );
        appendAudit(db, ctx, {
          companyId: raw.company_id,
          entityType: 'APPROBATION',
          entityId: raw.id,
          action: 'APPROVAL_APPROVED',
          before: { status: 'PENDING' },
          after: { status: 'APPROVED', applied },
          reason: reason || 'Demande approuvée',
          approvalRequestId: raw.id,
        });
      } else {
        appendAudit(db, ctx, {
          companyId: raw.company_id,
          entityType: 'APPROBATION',
          entityId: raw.id,
          action: 'APPROVAL_REJECTED',
          before: { status: 'PENDING' },
          after: { status: 'REJECTED' },
          reason,
          approvalRequestId: raw.id,
        });
      }
      createNotification(db, {
        userId: raw.requested_by,
        companyId: raw.company_id,
        type: decision === 'APPROVED' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
        title: `Demande ${raw.reference} ${decision === 'APPROVED' ? 'approuvée' : 'rejetée'}`,
        body: reason || null,
        entityType: 'APPROBATION',
        entityId: raw.id,
      });
      return loadRequest(db, raw.id, ctx);
    });
  } catch (err) {
    if (err && err.code) throw err;
    throw new AppError('INTERNAL', `Échec atomique de l’approbation : ${err.message}`);
  }
  return result;
}

function cancelRequest(db, ctx, input) {
  assertPermission(ctx, 'approvals.request');
  const raw = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(Number(input.id));
  if (!raw) throw notFound('Demande d’approbation');
  if (raw.company_id) assertCompanyAccess(ctx, raw.company_id);
  if (Number(raw.requested_by) !== Number(ctx.user.id) && !ctx.permissions.has('approvals.decide')) {
    throw forbidden('Seul le demandeur peut annuler sa demande');
  }
  if (raw.status !== 'PENDING') throw new AppError('CONFLICT', 'Seule une demande en attente peut être annulée');
  const reason = String(input.reason || 'Annulation par le demandeur').trim();
  return transaction(db, () => {
    db.prepare("UPDATE approval_requests SET status='CANCELLED', decided_by=?, decided_at=?, decision_reason=?, version=version+1 WHERE id=? AND status='PENDING'").run(
      ctx.user.id,
      new Date().toISOString(),
      reason,
      raw.id
    );
    db.prepare('INSERT INTO approval_events(request_id, action, actor_id, reason) VALUES (?,?,?,?)').run(
      raw.id,
      'CANCEL',
      ctx.user.id,
      reason
    );
    appendAudit(db, ctx, {
      companyId: raw.company_id,
      entityType: 'APPROBATION',
      entityId: raw.id,
      action: 'APPROVAL_CANCELLED',
      before: { status: 'PENDING' },
      after: { status: 'CANCELLED' },
      reason,
    });
    return loadRequest(db, raw.id, ctx);
  });
}

function pendingForEntity(db, entityType, entityId) {
  return db
    .prepare(
      `SELECT id, reference, operation, title FROM approval_requests
       WHERE entity_type = ? AND entity_id = ? AND status = 'PENDING' ORDER BY id DESC`
    )
    .all(entityType, String(entityId));
}

function pendingCount(db, ctx) {
  const ids = resolveCompanyScope(ctx);
  if (!ids.length) return 0;
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM approval_requests WHERE status='PENDING'
       AND (company_id IS NULL OR company_id IN (${ids.map(() => '?').join(',')}))`
    )
    .get(...ids).n;
}

module.exports = {
  OPERATION_LABELS,
  createRequest,
  listRequests,
  getRequest,
  decide,
  cancelRequest,
  pendingForEntity,
  pendingCount,
  loadRequest,
  mapRequest,
};
