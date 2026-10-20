'use strict';

const {
  assertPermission,
  assertCompanyAccess,
  resolveCompanyScope,
  validationError,
  forbidden,
  notFound,
  AppError,
} = require('./authorization');
const { appendAudit } = require('./audit');
const { getSetting } = require('./settings');
const { getAccount, maskAccountNumber } = require('./common');
const { nextSequence, makeReference, parseJson } = require('../db');
const {
  DIRECTIONS,
  CHEQUE_TYPES,
  PROTECTED_FROM,
  getTransition,
  allowedTransitions,
  requiresApprovalForTransition,
  transitionNeedsReason,
  normalizeChequeNumber,
  statusFor,
  statusLabel,
  isSettled,
  isPending,
  settlementDateOf,
} = require('../../shared/status');
const { parseAmountToCents, formatCents } = require('../../shared/money');
const { todayISO, assertISODate, isValidISODate } = require('../../shared/dates');

const MATERIAL_FIELDS = new Set([
  'accountId', 'chequeNumber', 'chequeType', 'counterpartyId', 'partyName', 'amountCents',
  'issueDate', 'receiptDate', 'dueDate', 'depositDate', 'collectionDate', 'paymentDate',
  'endorssee', 'endorsee',
]);

function cleanText(value, field, { required = false, max = 500 } = {}) {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === '') {
    if (required) throw validationError(`${field} requis`);
    return null;
  }
  const s = String(value).trim();
  if (s.length > max) throw validationError(`${field} trop long (${max} caractères maximum)`);
  return s;
}

function cleanDate(value, field, { required = false, allowFuture = true } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') {
    if (required) throw validationError(`${field} requise`);
    return null;
  }
  assertISODate(String(value), field);
  if (!allowFuture && String(value) > todayISO()) throw validationError(`${field} ne peut pas être dans le futur`);
  return String(value);
}

function getChequeRow(db, chequeId) {
  return db
    .prepare(
      `SELECT ch.*, c.name AS company_name, c.code AS company_code, c.color AS company_color,
              a.label AS account_label, a.account_number, b.name AS bank_name,
              m.full_name AS manager_name, p.name AS counterparty_name
       FROM cheques ch
       JOIN companies c ON c.id = ch.company_id
       JOIN bank_accounts a ON a.id = ch.account_id
       JOIN banks b ON b.id = a.bank_id
       LEFT JOIN users m ON m.id = ch.manager_id
       LEFT JOIN counterparties p ON p.id = ch.counterparty_id
       WHERE ch.id = ?`
    )
    .get(Number(chequeId));
}

function mapCheque(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    companyId: row.company_id,
    companyName: row.company_name,
    companyCode: row.company_code,
    companyColor: row.company_color,
    accountId: row.account_id,
    accountLabel: row.account_label,
    accountNumberMasked: maskAccountNumber(row.account_number),
    bankName: row.bank_name,
    direction: row.direction,
    directionLabel: DIRECTIONS[row.direction] ? DIRECTIONS[row.direction].label : row.direction,
    chequeType: row.cheque_type,
    chequeTypeLabel: CHEQUE_TYPES[row.cheque_type] || row.cheque_type,
    chequeNumber: row.cheque_number,
    chequeNumberNormalized: row.cheque_number_normalized,
    counterpartyId: row.counterparty_id,
    counterpartyName: row.counterparty_name,
    partyName: row.party_name,
    amountCents: row.amount_cents,
    amountFormatted: formatCents(row.amount_cents),
    currency: row.currency,
    issueDate: row.issue_date,
    receiptDate: row.receipt_date,
    dueDate: row.due_date,
    depositDate: row.deposit_date,
    collectionDate: row.collection_date,
    paymentDate: row.payment_date,
    returnDate: row.return_date,
    cancellationDate: row.cancellation_date,
    settlementDate: settlementDateOf(row),
    status: row.status,
    statusLabel: statusLabel(row.status, row.direction),
    statusCategory: statusFor(row.status, row.direction)?.category || 'UNKNOWN',
    isPending: isPending(row),
    isSettled: isSettled(row),
    statusChangedAt: row.status_changed_at,
    managerId: row.manager_id,
    managerName: row.manager_name,
    notes: row.notes,
    endorsee: row.endorsee,
    lastReason: row.last_reason,
    duplicateOverrideReason: row.duplicate_override_reason,
    dataQualityFlag: row.data_quality_flag,
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    legacyId: row.legacy_id,
    allowedTransitions: allowedTransitions(row.direction, row.status).map((t) => ({
      to: t.to,
      label: t.label || statusLabel(t.to, row.direction),
      requiresReason: Boolean(t.reasonRequired) || ['REJETE', 'IMPAYE', 'RETOURNE', 'LITIGE'].includes(t.to),
      requiresDate: Boolean(t.dateRequired),
      dateField: t.dateField || null,
      requiresApproval: requiresApprovalForTransition(row.direction, row.status, t.to),
    })),
  };
}

function checkDuplicates(db, ctx, input) {
  assertPermission(ctx, 'cheques.view');
  const companyId = assertCompanyAccess(ctx, input.companyId);
  const direction = String(input.direction || '').toUpperCase();
  if (!['RECU', 'EMIS'].includes(direction)) throw validationError('Sens invalide');
  const number = normalizeChequeNumber(input.chequeNumber || input.normalized || '');
  if (!number) throw validationError('Numéro de chèque invalide');
  return findDuplicates(db, {
    companyId,
    accountId: Number(input.accountId),
    direction,
    normalized: number,
    excludeId: input.excludeId ? Number(input.excludeId) : null,
  });
}

function canSelfApprove(db, ctx) {
  return (
    ctx.user.role === 'DG' &&
    ctx.permissions.has('approvals.decide') &&
    getSetting(db, 'approval.self_approval_allowed', false) === true
  );
}

function needsCreateApproval(db, ctx, amountCents) {
  if (!getSetting(db, 'approval.high_value_enabled', true)) return false;
  const threshold = Number(getSetting(db, 'approval.high_value_threshold_cents', 50000000));
  if (amountCents < threshold) return false;
  if (canSelfApprove(db, ctx)) return false;
  return true;
}

function canOverrideDuplicate(ctx) {
  return ctx.permissions.has('approvals.decide') && ctx.user.role === 'DG';
}

function findDuplicates(db, { companyId, accountId, direction, normalized, excludeId = null }) {
  return db
    .prepare(
      `SELECT ch.id, ch.reference, ch.cheque_number, ch.status, ch.direction, ch.due_date,
              ch.account_id, a.label AS account_label, ch.party_name
       FROM cheques ch JOIN bank_accounts a ON a.id = ch.account_id
       WHERE ch.company_id = ? AND ch.direction = ? AND ch.cheque_number_normalized = ?
         AND ch.is_archived = 0
         AND ch.account_id = ?
         AND (? IS NULL OR ch.id <> ?)`
    )
    .all(companyId, direction, normalized, accountId, excludeId, excludeId);
}

function validateManager(db, managerId, companyId) {
  if (managerId === null || managerId === undefined || managerId === '') return null;
  const user = db
    .prepare(
      `SELECT u.id, u.is_active, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`
    )
    .get(Number(managerId));
  if (!user || !user.is_active) throw validationError('Gestionnaire inconnu ou inactif');
  if (!['DG', 'RESPONSABLE'].includes(user.role)) throw validationError('Ce compte ne peut pas être gestionnaire de chèques');
  if (user.role === 'RESPONSABLE') {
    const assigned = db
      .prepare('SELECT 1 AS x FROM company_assignments WHERE user_id = ? AND company_id = ?')
      .get(user.id, companyId);
    if (!assigned) throw validationError('Le gestionnaire n’est pas affecté à cette société');
  }
  return user.id;
}

function validateCounterparty(db, counterpartyId, companyId) {
  if (counterpartyId === null || counterpartyId === undefined || counterpartyId === '') return null;
  const cp = db.prepare('SELECT * FROM counterparties WHERE id = ?').get(Number(counterpartyId));
  if (!cp || cp.company_id !== Number(companyId)) throw validationError('Contrepartie invalide pour cette société');
  if (!cp.is_active) throw validationError('Contrepartie désactivée');
  return cp;
}

/**
 * Normalise et valide une création ou une modification.
 * `existing` est la ligne actuelle pour une modification.
 */
function validateChequeState(db, ctx, input, existing = null) {
  const direction = existing ? existing.direction : String(input.direction || '').toUpperCase();
  if (!['EMIS', 'RECU'].includes(direction)) throw validationError('Sens du chèque invalide');
  if (existing && input.direction && String(input.direction).toUpperCase() !== existing.direction) {
    throw forbidden('Le sens d’un chèque est immuable');
  }
  const accountId = input.accountId === undefined ? existing?.account_id : Number(input.accountId);
  if (!accountId) throw validationError('Compte bancaire requis');
  const account = getAccount(db, accountId);
  assertCompanyAccess(ctx, account.company_id);
  if (!account.is_active && (!existing || existing.account_id !== account.id)) {
    throw validationError('Compte bancaire désactivé');
  }
  if (input.companyId !== undefined && Number(input.companyId) !== account.company_id) {
    throw validationError('Le compte bancaire n’appartient pas à la société indiquée');
  }
  if (existing && existing.account_id !== account.id) {
    assertCompanyAccess(ctx, existing.company_id);
  }

  const chequeNumber = input.chequeNumber === undefined ? existing?.cheque_number : cleanText(input.chequeNumber, 'Numéro de chèque', { required: true, max: 60 });
  if (!chequeNumber) throw validationError('Numéro de chèque requis');
  const normalized = normalizeChequeNumber(chequeNumber);
  if (!normalized) throw validationError('Numéro de chèque invalide');

  const chequeType = String(
    input.chequeType === undefined ? existing?.cheque_type || 'ORDINAIRE' : input.chequeType
  ).toUpperCase();
  if (!CHEQUE_TYPES[chequeType]) throw validationError('Type de chèque invalide');

  const amountCents =
    input.amountCents !== undefined
      ? Number(input.amountCents)
      : input.amount !== undefined
        ? parseAmountToCents(input.amount, { field: 'Montant' })
        : existing?.amount_cents;
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw validationError('Montant invalide');

  const currency = String(input.currency || existing?.currency || getSetting(db, 'app.base_currency', 'DZD')).toUpperCase();
  if (currency !== getSetting(db, 'app.base_currency', 'DZD')) throw validationError('Devise non prise en charge');

  const issueDate = cleanDate(input.issueDate === undefined ? existing?.issue_date : input.issueDate, 'Date d’émission', {
    required: true,
    allowFuture: false,
  });
  const receiptDate = cleanDate(input.receiptDate === undefined ? existing?.receipt_date : input.receiptDate, 'Date de réception', {
    allowFuture: false,
  });
  const dueDate = cleanDate(input.dueDate === undefined ? existing?.due_date : input.dueDate, 'Date d’échéance', {
    required: true,
  });
  if (receiptDate && receiptDate < issueDate) throw validationError('La date de réception ne peut pas précéder la date d’émission');
  if (direction === 'RECU' && !receiptDate) throw validationError('La date de réception est requise pour un chèque reçu');
  if (direction === 'EMIS' && receiptDate) throw validationError('Un chèque émis ne comporte pas de date de réception');
  if (dueDate < issueDate) throw validationError('La date d’échéance ne peut pas précéder la date d’émission');
  if (direction === 'RECU' && receiptDate && dueDate < receiptDate) {
    throw validationError('La date d’échéance prévue ne peut pas précéder la date de réception');
  }

  const depositDate = cleanDate(input.depositDate === undefined ? existing?.deposit_date : input.depositDate, 'Date de dépôt', {
    allowFuture: false,
  });
  const collectionDate = cleanDate(
    input.collectionDate === undefined ? existing?.collection_date : input.collectionDate,
    'Date d’encaissement',
    { allowFuture: false }
  );
  const paymentDate = cleanDate(input.paymentDate === undefined ? existing?.payment_date : input.paymentDate, 'Date de paiement', {
    allowFuture: false,
  });
  if (depositDate && depositDate < issueDate) throw validationError('La date de dépôt ne peut pas précéder la date d’émission');
  if (collectionDate) {
    if (direction !== 'RECU') throw validationError('Un chèque émis ne peut pas avoir de date d’encaissement');
    if (collectionDate < issueDate) throw validationError('La date d’encaissement ne peut pas précéder la date d’émission');
    if (depositDate && collectionDate < depositDate) throw validationError('La date d’encaissement ne peut pas précéder le dépôt');
  }
  if (paymentDate) {
    if (direction !== 'EMIS') throw validationError('Un chèque reçu ne peut pas avoir de date de paiement');
    if (paymentDate < issueDate) throw validationError('La date de paiement ne peut pas précéder la date d’émission');
  }

  let counterpartyId = input.counterpartyId === undefined ? existing?.counterparty_id ?? null : input.counterpartyId;
  if (counterpartyId === '' || counterpartyId === undefined) counterpartyId = null;
  const counterparty = counterpartyId ? validateCounterparty(db, counterpartyId, account.company_id) : null;
  let partyName =
    input.partyName !== undefined
      ? cleanText(input.partyName, DIRECTIONS[direction].partyLabel, { max: 160 })
      : existing?.party_name;
  if (!partyName && counterparty) partyName = counterparty.name;
  if (
    input.partyName === undefined &&
    counterparty &&
    existing &&
    Number(existing.counterparty_id) !== Number(counterparty.id)
  ) {
    partyName = counterparty.name;
  }
  if (!partyName) throw validationError(`${DIRECTIONS[direction].partyLabel} requis`);

  const managerId = input.managerId === undefined ? existing?.manager_id ?? null : validateManager(db, input.managerId, account.company_id);
  const notes = input.notes === undefined ? existing?.notes ?? null : cleanText(input.notes, 'Notes', { max: 2000 });
  const endorsee = input.endorsee === undefined ? existing?.endorsee ?? null : cleanText(input.endorsee, 'Endossataire', { max: 160 });

  return {
    accountId: account.id,
    companyId: account.company_id,
    direction,
    chequeType,
    chequeNumber,
    chequeNumberNormalized: normalized,
    counterpartyId: counterparty ? counterparty.id : null,
    partyName,
    amountCents,
    currency,
    issueDate,
    receiptDate,
    dueDate,
    depositDate,
    collectionDate,
    paymentDate,
    managerId,
    notes,
    endorsee,
  };
}

function dataForAudit(data) {
  return { ...data };
}

function insertChequeDirect(db, actorCtx, data, options = {}) {
  const duplicates = findDuplicates(db, {
    companyId: data.companyId,
    accountId: data.accountId,
    direction: data.direction,
    normalized: data.chequeNumberNormalized,
  });
  if (duplicates.length && !options.duplicateOverrideReason) {
    throw new AppError('DUPLICATE_CHEQUE', 'Un chèque identique existe déjà (même société, sens et numéro).', {
      duplicates: duplicates.map((d) => ({ id: d.id, reference: d.reference, payable: d.party_name, account: d.account_label, status: d.status })),
    });
  }
  if (duplicates.length && options.duplicateOverrideReason && !canOverrideDuplicate(actorCtx)) {
    throw forbidden('Seul le Directeur Général peut autoriser un doublon de numéro');
  }
  const status = data.direction === 'RECU' ? 'RECU' : 'EMIS';
  const reference = makeReference('CHQ', new Date().getFullYear(), nextSequence(db, 'CHEQUE', new Date().getFullYear()));
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO cheques(
        reference, company_id, account_id, direction, cheque_type, cheque_number, cheque_number_normalized,
        counterparty_id, party_name, amount_cents, currency, issue_date, receipt_date, due_date,
        deposit_date, collection_date, payment_date, status, status_changed_at, manager_id, notes,
        duplicate_override_reason, created_by, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      reference,
      data.companyId,
      data.accountId,
      data.direction,
      data.chequeType,
      data.chequeNumber,
      data.chequeNumberNormalized,
      data.counterpartyId,
      data.partyName,
      data.amountCents,
      data.currency,
      data.issueDate,
      data.receiptDate,
      data.dueDate,
      data.depositDate,
      data.collectionDate,
      data.paymentDate,
      status,
      now,
      data.managerId,
      data.notes,
      options.duplicateOverrideReason || null,
      options.createdBy || actorCtx.user.id,
      now,
      now
    );
  const id = Number(result.lastInsertRowid);
  db.prepare(
    `INSERT INTO cheque_events(cheque_id, event_type, from_status, to_status, event_date, reason, actor_id, approval_request_id, metadata_json)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    'CREATION',
    null,
    status,
    todayISO(),
    options.reason || 'Création du chèque',
    actorCtx.user.id,
    options.approvalRequestId || null,
    JSON.stringify({
      amountCents: data.amountCents,
      dueDate: data.dueDate,
      duplicateOverride: Boolean(options.duplicateOverrideReason),
    })
  );
  appendAudit(db, actorCtx, {
    companyId: data.companyId,
    entityType: 'CHEQUE',
    entityId: id,
    action: 'CHEQUE_CREATE',
    after: { ...dataForAudit(data), reference, status },
    reason: options.reason || 'Création d’un chèque',
    approvalRequestId: options.approvalRequestId || null,
    metadata: { duplicateOverrideReason: options.duplicateOverrideReason || null },
  });
  return mapCheque(getChequeRow(db, id));
}

function createCheque(db, ctx, input) {
  assertPermission(ctx, 'cheques.create');
  const data = validateChequeState(db, ctx, input);
  const duplicates = findDuplicates(db, {
    companyId: data.companyId,
    accountId: data.accountId,
    direction: data.direction,
    normalized: data.chequeNumberNormalized,
  });
  const overrideReason = input.overrideDuplicate ? cleanText(input.duplicateOverrideReason, 'Motif de dérogation', { required: true, max: 500 }) : null;
  if (duplicates.length && !overrideReason) {
    throw new AppError('DUPLICATE_CHEQUE', 'Un chèque identique existe déjà (même société, sens et numéro).', {
      duplicates: duplicates.map((d) => ({
        id: d.id,
        reference: d.reference,
        partyName: d.party_name,
        accountLabel: d.account_label,
        status: d.status,
      })),
    });
  }
  if (overrideReason) {
    if (!canOverrideDuplicate(ctx)) throw forbidden('Seul le Directeur Général peut autoriser un doublon de numéro');
    if (overrideReason.length < 10) throw validationError('Le motif de dérogation doit être explicite (10 caractères minimum)');
  }

  if (needsCreateApproval(db, ctx, data.amountCents)) {
    const approvals = require('./approvals');
    const request = approvals.createRequest(db, ctx, {
      companyId: data.companyId,
      entityType: 'CHEQUE',
      entityId: null,
      operation: 'CHEQUE_CREATE',
      title: `Création d’un chèque ${DIRECTIONS[data.direction].label.toLowerCase()} de ${formatCents(data.amountCents)}`,
      before: null,
      after: { fields: data, duplicateOverrideReason: overrideReason, reason: 'Enregistrement à valeur élevée' },
      dedupeKey: `CHEQUE_CREATE|${data.companyId}|${data.accountId}|${data.direction}|${data.chequeNumberNormalized}`,
    });
    return { pendingApproval: true, approval: request, message: 'Chèque de valeur élevée : enregistrement soumis à l’approbation du Directeur Général.' };
  }

  return db
    .transaction(() =>
      insertChequeDirect(db, ctx, data, {
        duplicateOverrideReason: overrideReason,
        createdBy: ctx.user.id,
        reason: overrideReason ? `Création avec dérogation de doublon : ${overrideReason}` : 'Création du chèque',
      })
    )
    .immediate();
}

function computeChanges(current, next) {
  const mapping = {
    accountId: 'account_id',
    chequeType: 'cheque_type',
    chequeNumber: 'cheque_number',
    counterpartyId: 'counterparty_id',
    partyName: 'party_name',
    amountCents: 'amount_cents',
    issueDate: 'issue_date',
    receiptDate: 'receipt_date',
    dueDate: 'due_date',
    depositDate: 'deposit_date',
    collectionDate: 'collection_date',
    paymentDate: 'payment_date',
    managerId: 'manager_id',
    notes: 'notes',
    endorsee: 'endorsee',
  };
  const changes = {};
  for (const [key, column] of Object.entries(mapping)) {
    const before = current[column] === undefined ? null : current[column];
    const after = next[key] === undefined ? before : next[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) changes[key] = after;
  }
  return changes;
}

function updateNeedsApproval(db, ctx, current, changes) {
  const keys = Object.keys(changes);
  if (!keys.length) return false;
  if (canSelfApprove(db, ctx)) return false;
  const setting = (k, d) => getSetting(db, k, d);
  if (changes.amountCents !== undefined && setting('approval.require_amount_change', true)) return true;
  if (changes.accountId !== undefined && setting('approval.require_association_change', true)) return true;
  const material = keys.filter((k) => MATERIAL_FIELDS.has(k));
  if (!material.length) return false;
  // Toute correction matérielle d'un chèque déjà finalisé est protégée.
  if (PROTECTED_FROM.has(current.status)) return true;
  return false;
}

function applyUpdateDirect(db, actorCtx, current, changes, options = {}) {
  if (options.expectedVersion !== undefined && Number(options.expectedVersion) !== current.version) {
    throw new AppError('CONFLICT', 'Le chèque a été modifié depuis la demande. Rechargez les données.');
  }
  const candidate = {
    accountId: changes.accountId === undefined ? current.account_id : changes.accountId,
    chequeType: changes.chequeType === undefined ? current.cheque_type : changes.chequeType,
    chequeNumber: changes.chequeNumber === undefined ? current.cheque_number : changes.chequeNumber,
    counterpartyId: changes.counterpartyId === undefined ? current.counterparty_id : changes.counterpartyId,
    partyName: changes.partyName === undefined ? current.party_name : changes.partyName,
    amountCents: changes.amountCents === undefined ? current.amount_cents : changes.amountCents,
    issueDate: changes.issueDate === undefined ? current.issue_date : changes.issueDate,
    receiptDate: changes.receiptDate === undefined ? current.receipt_date : changes.receiptDate,
    dueDate: changes.dueDate === undefined ? current.due_date : changes.dueDate,
    depositDate: changes.depositDate === undefined ? current.deposit_date : changes.depositDate,
    collectionDate: changes.collectionDate === undefined ? current.collection_date : changes.collectionDate,
    paymentDate: changes.paymentDate === undefined ? current.payment_date : changes.paymentDate,
    managerId: changes.managerId === undefined ? current.manager_id : changes.managerId,
    notes: changes.notes === undefined ? current.notes : changes.notes,
    endorsee: changes.endorsee === undefined ? current.endorsee : changes.endorsee,
    currency: current.currency,
    direction: current.direction,
    companyId: current.company_id,
  };
  const validated = validateChequeState(db, actorCtx, candidate, current);
  if (validated.companyId !== current.company_id) {
    assertCompanyAccess(actorCtx, validated.companyId);
  }
  const duplicates = findDuplicates(db, {
    companyId: validated.companyId,
    accountId: validated.accountId,
    direction: validated.direction,
    normalized: validated.chequeNumberNormalized,
    excludeId: current.id,
  });
  if (duplicates.length && !options.duplicateOverrideReason) {
    throw new AppError('DUPLICATE_CHEQUE', 'Le numéro mis à jour entre en collision avec un autre chèque.', {
      duplicates: duplicates.map((d) => ({ id: d.id, reference: d.reference, partyName: d.party_name, status: d.status })),
    });
  }
  const now = new Date().toISOString();
  const reason = options.reason || 'Modification du chèque';
  db.prepare(
    `UPDATE cheques SET account_id=?, company_id=?, cheque_type=?, cheque_number=?, cheque_number_normalized=?,
      counterparty_id=?, party_name=?, amount_cents=?, issue_date=?, receipt_date=?, due_date=?, deposit_date=?,
      collection_date=?, payment_date=?, manager_id=?, notes=?, endorsee=?, version=version+1, updated_at=?
     WHERE id=?`
  ).run(
    validated.accountId,
    validated.companyId,
    validated.chequeType,
    validated.chequeNumber,
    validated.chequeNumberNormalized,
    validated.counterpartyId,
    validated.partyName,
    validated.amountCents,
    validated.issueDate,
    validated.receiptDate,
    validated.dueDate,
    validated.depositDate,
    validated.collectionDate,
    validated.paymentDate,
    validated.managerId,
    validated.notes,
    validated.endorsee,
    now,
    current.id
  );
  db.prepare(
    `INSERT INTO cheque_events(cheque_id, event_type, from_status, to_status, event_date, reason, actor_id, approval_request_id, metadata_json)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    current.id,
    'MODIFICATION',
    current.status,
    current.status,
    todayISO(),
    reason,
    actorCtx.user.id,
    options.approvalRequestId || null,
    JSON.stringify({ changes })
  );
  appendAudit(db, actorCtx, {
    companyId: validated.companyId,
    entityType: 'CHEQUE',
    entityId: current.id,
    action: 'CHEQUE_UPDATE',
    before: {
      accountId: current.account_id,
      chequeNumber: current.cheque_number,
      partyName: current.party_name,
      amountCents: current.amount_cents,
      dates: {
        issue: current.issue_date, due: current.due_date, collection: current.collection_date, payment: current.payment_date,
      },
      version: current.version,
    },
    after: { ...changes, version: current.version + 1 },
    reason,
    approvalRequestId: options.approvalRequestId || null,
  });
  return mapCheque(getChequeRow(db, current.id));
}

function updateCheque(db, ctx, input) {
  assertPermission(ctx, 'cheques.edit');
  const current = getChequeRow(db, input.id);
  if (!current) throw notFound('Chèque');
  assertCompanyAccess(ctx, current.company_id);
  if (Number(input.version) !== current.version) {
    throw new AppError('CONFLICT', 'Version obsolète : rechargez le chèque avant de le modifier');
  }
  const validated = validateChequeState(db, ctx, input, current);
  const changes = computeChanges(current, validated);
  if (!Object.keys(changes).length) throw validationError('Aucune modification détectée');
  const reason = cleanText(input.reason, 'Motif', { max: 500 });
  if ((MATERIAL_FIELDS.size && Object.keys(changes).some((k) => MATERIAL_FIELDS.has(k))) && !reason) {
    throw validationError('Un motif est obligatoire pour modifier un champ matériel du chèque');
  }
  const protectedChange = updateNeedsApproval(db, ctx, current, changes);
  if (protectedChange) {
    const approvals = require('./approvals');
    const request = approvals.createRequest(db, ctx, {
      companyId: current.company_id,
      entityType: 'CHEQUE',
      entityId: current.id,
      operation: 'CHEQUE_UPDATE',
      title: `Modification protégée du chèque ${current.reference}`,
      before: {
        accountId: current.account_id,
        chequeNumber: current.cheque_number,
        partyName: current.party_name,
        amountCents: current.amount_cents,
        issueDate: current.issue_date,
        dueDate: current.due_date,
        collectionDate: current.collection_date,
        paymentDate: current.payment_date,
        status: current.status,
        version: current.version,
      },
      after: { changes, baseVersion: current.version, reason },
      dedupeKey: `CHEQUE_UPDATE|${current.id}`,
    });
    return { pendingApproval: true, approval: request, message: 'Modification soumise à l’approbation du Directeur Général.' };
  }
  return db
    .transaction(() =>
      applyUpdateDirect(db, ctx, current, changes, {
        expectedVersion: current.version,
        reason: reason || 'Mise à jour du chèque',
      })
    )
    .immediate();
}

function validateStatusChange(db, current, input) {
  const to = String(input.to || '').toUpperCase();
  const transition = getTransition(current.direction, current.status, to);
  if (!transition) {
    throw validationError(`Transition non autorisée : ${current.status} → ${to}`);
  }
  const reason = input.reason !== undefined && input.reason !== null ? String(input.reason).trim() : '';
  if ((transitionNeedsReason(current.direction, current.status, to) || transition.reasonRequired) && reason.length < 3) {
    throw validationError('Un motif est obligatoire pour cette transition');
  }
  if (reason.length > 500) throw validationError('Motif trop long');
  const eventDateRaw = input.eventDate || input.date || todayISO();
  assertISODate(String(eventDateRaw), 'Date de l’événement');
  const eventDate = String(eventDateRaw);
  if (eventDate > todayISO()) throw validationError('La date de l’événement ne peut pas être dans le futur');
  if (eventDate < current.issue_date) throw validationError('La date de l’événement ne peut pas précéder la date d’émission');
  if (transition.dateRequired && !input.eventDate && !input.date) {
    throw validationError('La date réelle de l’événement est obligatoire');
  }
  if (to === 'ENCAISSE' && current.deposit_date && eventDate < current.deposit_date) {
    throw validationError('La date d’encaissement ne peut pas précéder la date de dépôt');
  }
  if (to === 'DEPOSE' && current.receipt_date && eventDate < current.receipt_date) {
    throw validationError('La date de dépôt ne peut pas précéder la date de réception');
  }
  let endorsee = current.endorsee;
  if (to === 'ENDOSSE') {
    endorsee = cleanText(input.endorsee, 'Endossataire', { required: true, max: 160 });
  }
  return { to, reason: reason || null, eventDate, transition, endorsee };
}

function applyStatusDirect(db, actorCtx, current, change, options = {}) {
  if (options.expectedVersion !== undefined && Number(options.expectedVersion) !== current.version) {
    throw new AppError('CONFLICT', 'Le chèque a été modifié depuis la demande d’approbation.');
  }
  const transition = getTransition(current.direction, current.status, change.to);
  if (!transition) throw validationError('Transition devenue invalide');
  const now = new Date().toISOString();
  const updates = {
    status: change.to,
    status_changed_at: now,
    last_reason: change.reason || current.last_reason,
    version: current.version + 1,
    updated_at: now,
  };
  if (change.to === 'DEPOSE') updates.deposit_date = change.eventDate;
  if (change.to === 'ENCAISSE') updates.collection_date = change.eventDate;
  if (change.to === 'PAYE') updates.payment_date = change.eventDate;
  if (['REJETE', 'IMPAYE', 'RETOURNE'].includes(change.to)) updates.return_date = change.eventDate;
  if (change.to === 'ANNULE') updates.cancellation_date = change.eventDate;
  if (change.to === 'ENDOSSE') updates.endorsee = change.endorsee;
  const fields = Object.keys(updates).map((k) => `${k} = ?`);
  db.prepare(`UPDATE cheques SET ${fields.join(', ')} WHERE id = ?`).run(...Object.values(updates), current.id);
  db.prepare(
    `INSERT INTO cheque_events(cheque_id, event_type, from_status, to_status, event_date, reason, actor_id, approval_request_id, metadata_json)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    current.id,
    'STATUS',
    current.status,
    change.to,
    change.eventDate,
    change.reason || transition.label || null,
    actorCtx.user.id,
    options.approvalRequestId || null,
    JSON.stringify({ settlementDate: settlementDateOf({ ...current, ...updates }) })
  );
  appendAudit(db, actorCtx, {
    companyId: current.company_id,
    entityType: 'CHEQUE',
    entityId: current.id,
    action: 'CHEQUE_STATUS',
    before: { status: current.status, collectionDate: current.collection_date, paymentDate: current.payment_date },
    after: {
      status: change.to,
      eventDate: change.eventDate,
      settlementDate: ['ENCAISSE', 'PAYE'].includes(change.to) ? change.eventDate : null,
    },
    reason: change.reason || transition.label,
    approvalRequestId: options.approvalRequestId || null,
  });

  if (['REJETE', 'IMPAYE', 'RETOURNE'].includes(change.to)) {
    const notifications = require('./notifications');
    notifications.notifyRole(db, {
      roleCode: 'DG',
      companyId: current.company_id,
      type: 'CHEQUE_EXCEPTION',
      title: `Chèque ${current.reference} : ${statusLabel(change.to, current.direction)}`,
      body: `${current.party_name} — ${formatCents(current.amount_cents)}. Motif : ${change.reason || 'non précisé'}`,
      entityType: 'CHEQUE',
      entityId: current.id,
      excludeUserId: actorCtx.user.id,
    });
  }
  return mapCheque(getChequeRow(db, current.id));
}

function changeStatus(db, ctx, input) {
  assertPermission(ctx, 'cheques.status');
  const current = getChequeRow(db, input.id);
  if (!current) throw notFound('Chèque');
  assertCompanyAccess(ctx, current.company_id);
  if (input.version !== undefined && Number(input.version) !== current.version) {
    throw new AppError('CONFLICT', 'Version obsolète : rechargez le chèque');
  }
  const change = validateStatusChange(db, current, input);
  let approvalRequired = requiresApprovalForTransition(current.direction, current.status, change.to);
  if (change.to === 'ANNULE' && !getSetting(db, 'approval.require_cancel_finalized', true)) {
    approvalRequired = false;
  }
  if (approvalRequired && !canSelfApprove(db, ctx)) {
    const approvals = require('./approvals');
    const request = approvals.createRequest(db, ctx, {
      companyId: current.company_id,
      entityType: 'CHEQUE',
      entityId: current.id,
      operation: 'CHEQUE_STATUS',
      title: `Correction de statut ${current.reference} : ${statusLabel(current.status, current.direction)} → ${statusLabel(change.to, current.direction)}`,
      before: { status: current.status, collectionDate: current.collection_date, paymentDate: current.payment_date, version: current.version },
      after: {
        to: change.to,
        eventDate: change.eventDate,
        reason: change.reason,
        endorsee: change.endorsee,
        baseVersion: current.version,
      },
      dedupeKey: `CHEQUE_STATUS|${current.id}`,
    });
    return { pendingApproval: true, approval: request, message: 'Cette transition nécessite l’approbation du Directeur Général.' };
  }
  return db.transaction(() => applyStatusDirect(db, ctx, current, change, { expectedVersion: current.version })).immediate();
}

function cancelCheque(db, ctx, input) {
  return changeStatus(db, ctx, { id: input.id, to: 'ANNULE', reason: input.reason, eventDate: input.eventDate, version: input.version });
}

function listManagers(db, ctx, companyIdValue) {
  assertPermission(ctx, 'cheques.view');
  const companyId = assertCompanyAccess(ctx, companyIdValue);
  const rows = db
    .prepare(
      `SELECT DISTINCT u.id, u.full_name, r.code AS role
       FROM users u JOIN roles r ON r.id = u.role_id
       LEFT JOIN company_assignments ca ON ca.user_id = u.id AND ca.company_id = ?
       WHERE u.is_active = 1 AND (
         r.code = 'DG' OR (r.code = 'RESPONSABLE' AND ca.company_id IS NOT NULL)
       )
       ORDER BY u.full_name`
    )
    .all(companyId);
  return rows.map((r) => ({ id: r.id, fullName: r.full_name, role: r.role }));
}

function buildFilters(db, ctx, options) {
  assertPermission(ctx, 'cheques.view');
  const companyIds = resolveCompanyScope(ctx, options.companyIds);
  const params = [];
  const where = [];
  if (!companyIds.length) {
    where.push('0=1');
  } else {
    where.push(`ch.company_id IN (${companyIds.map(() => '?').join(',')})`);
    params.push(...companyIds);
  }
  if (options.companyId) {
    assertCompanyAccess(ctx, options.companyId);
    where.push('ch.company_id = ?');
    params.push(Number(options.companyId));
  }
  if (options.accountId) {
    where.push('ch.account_id = ?');
    params.push(Number(options.accountId));
  }
  if (options.direction) {
    const dir = String(options.direction).toUpperCase();
    if (!['EMIS', 'RECU'].includes(dir)) throw validationError('Sens invalide');
    where.push('ch.direction = ?');
    params.push(dir);
  }
  if (options.statuses && options.statuses.length) {
    const statuses = [...options.statuses].map((s) => String(s).toUpperCase());
    where.push(`ch.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (options.managerId) {
    where.push('ch.manager_id = ?');
    params.push(Number(options.managerId));
  }
  if (options.dueFrom) {
    where.push('ch.due_date >= ?');
    params.push(String(options.dueFrom));
  }
  if (options.dueTo) {
    where.push('ch.due_date <= ?');
    params.push(String(options.dueTo));
  }
  if (options.issueFrom) {
    where.push('ch.issue_date >= ?');
    params.push(String(options.issueFrom));
  }
  if (options.issueTo) {
    where.push('ch.issue_date <= ?');
    params.push(String(options.issueTo));
  }
  if (options.settlementFrom) {
    where.push("COALESCE(ch.collection_date, ch.payment_date) >= ?");
    params.push(String(options.settlementFrom));
  }
  if (options.settlementTo) {
    where.push("COALESCE(ch.collection_date, ch.payment_date) <= ?");
    params.push(String(options.settlementTo));
  }
  if (options.exceptionOnly) where.push("ch.status IN ('REJETE','IMPAYE','RETOURNE','A_REGULARISER')");
  if (options.pendingOnly) where.push("ch.status IN ('RECU','DEPOSE','EMIS','REMIS')");
  if (options.overdueAsOf) {
    where.push("ch.status IN ('RECU','DEPOSE','EMIS','REMIS') AND ch.due_date < ?");
    params.push(String(options.overdueAsOf));
  }
  if (options.includeArchived !== true) where.push('ch.is_archived = 0');
  if (options.search) {
    const like = `%${String(options.search).slice(0, 100)}%`;
    where.push('(ch.reference LIKE ? OR ch.cheque_number LIKE ? OR ch.party_name LIKE ? OR ch.notes LIKE ? OR p.name LIKE ?)');
    params.push(like, like, like, like, like);
  }
  return { where: where.join(' AND '), params, companyIds };
}

const SORTABLE = {
  dueDate: 'ch.due_date',
  issueDate: 'ch.issue_date',
  amount: 'ch.amount_cents',
  reference: 'ch.reference',
  createdAt: 'ch.created_at',
  status: 'ch.status',
};

function searchCheques(db, ctx, options = {}, { all = false } = {}) {
  const { where, params } = buildFilters(db, ctx, options);
  const sort = SORTABLE[options.sortBy] || 'ch.due_date';
  const dir = String(options.sortDir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const baseFrom = `FROM cheques ch
    JOIN companies c ON c.id = ch.company_id
    JOIN bank_accounts a ON a.id = ch.account_id
    JOIN banks b ON b.id = a.bank_id
    LEFT JOIN users m ON m.id = ch.manager_id
    LEFT JOIN counterparties p ON p.id = ch.counterparty_id
    WHERE ${where}`;
  let limitSql = '';
  let queryParams = [...params];
  let page = 1;
  let pageSize = null;
  let total;
  if (all) {
    total = db.prepare(`SELECT COUNT(*) AS n ${baseFrom}`).get(...queryParams).n;
  } else {
    page = Math.max(1, Number(options.page) || 1);
    pageSize = Math.min(200, Math.max(10, Number(options.pageSize) || 50));
    total = db.prepare(`SELECT COUNT(*) AS n ${baseFrom}`).get(...queryParams).n;
    limitSql = 'LIMIT ? OFFSET ?';
    queryParams = [...queryParams, pageSize, (page - 1) * pageSize];
  }
  const rows = db
    .prepare(
      `SELECT ch.*, c.name AS company_name, c.code AS company_code, c.color AS company_color,
              a.label AS account_label, a.account_number, b.name AS bank_name,
              m.full_name AS manager_name, p.name AS counterparty_name,
              (SELECT COUNT(*) FROM cheque_events e WHERE e.cheque_id = ch.id) AS event_count,
              (SELECT COUNT(*) FROM reconciliation_matches rm WHERE rm.cheque_id = ch.id AND rm.status = 'CONFIRME') AS match_count,
              (SELECT COUNT(*) FROM approval_requests ar WHERE ar.entity_type='CHEQUE' AND ar.entity_id = CAST(ch.id AS TEXT) AND ar.status='PENDING') AS pending_approvals
       ${baseFrom} ORDER BY ${sort} ${dir}, ch.id DESC ${limitSql}`
    )
    .all(...queryParams);
  const items = rows.map((row) => ({
    ...mapCheque(row),
    eventCount: row.event_count,
    matchCount: row.match_count,
    pendingApprovals: row.pending_approvals,
  }));
  if (all) return { items, total };
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

function listCheques(db, ctx, options = {}) {
  return searchCheques(db, ctx, options);
}

function allCheques(db, ctx, options = {}) {
  return searchCheques(db, ctx, options, { all: true }).items;
}

function getCheque(db, ctx, chequeId) {
  assertPermission(ctx, 'cheques.view');
  const row = getChequeRow(db, chequeId);
  if (!row) throw notFound('Chèque');
  assertCompanyAccess(ctx, row.company_id);
  const cheque = mapCheque(row);
  cheque.events = db
    .prepare(
      `SELECT e.*, u.full_name AS actor_name, ar.reference AS approval_reference
       FROM cheque_events e
       LEFT JOIN users u ON u.id = e.actor_id
       LEFT JOIN approval_requests ar ON ar.id = e.approval_request_id
       WHERE e.cheque_id = ? ORDER BY e.id ASC`
    )
    .all(row.id)
    .map((e) => ({
      id: e.id,
      eventType: e.event_type,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      fromStatusLabel: e.from_status ? statusLabel(e.from_status, row.direction) : null,
      toStatusLabel: e.to_status ? statusLabel(e.to_status, row.direction) : null,
      eventDate: e.event_date,
      reason: e.reason,
      actorId: e.actor_id,
      actorName: e.actor_name,
      approvalRequestId: e.approval_request_id,
      approvalReference: e.approval_reference,
      createdAt: e.created_at,
      metadata: parseJson(e.metadata_json),
    }));
  cheque.approvals = db
    .prepare(
      `SELECT ar.id, ar.reference, ar.operation, ar.status, ar.requested_at, ar.decided_at,
              req.full_name AS requester_name, dec.full_name AS decider_name
       FROM approval_requests ar
       LEFT JOIN users req ON req.id = ar.requested_by
       LEFT JOIN users dec ON dec.id = ar.decided_by
       WHERE ar.entity_type = 'CHEQUE' AND ar.entity_id = CAST(? AS TEXT)
       ORDER BY ar.id DESC`
    )
    .all(row.id)
    .map((a) => ({
      id: a.id,
      reference: a.reference,
      operation: a.operation,
      status: a.status,
      requestedAt: a.requested_at,
      decidedAt: a.decided_at,
      requesterName: a.requester_name,
      deciderName: a.decider_name,
    }));
  cheque.attachments = db
    .prepare(
      `SELECT id, original_name, mime_type, size_bytes, created_at, uploaded_by
       FROM attachments WHERE entity_type='CHEQUE' AND entity_id = ? AND deleted_at IS NULL ORDER BY id DESC`
    )
    .all(String(row.id))
    .map((a) => ({ id: a.id, originalName: a.original_name, mimeType: a.mime_type, sizeBytes: a.size_bytes, createdAt: a.created_at }));
  cheque.matches = db
    .prepare(
      `SELECT rm.*, bt.transaction_date, bt.description, bt.debit_cents, bt.credit_cents, bt.bank_ref
       FROM reconciliation_matches rm JOIN bank_transactions bt ON bt.id = rm.bank_transaction_id
       WHERE rm.cheque_id = ? ORDER BY rm.id DESC`
    )
    .all(row.id)
    .map((m) => ({
      id: m.id,
      bankTransactionId: m.bank_transaction_id,
      status: m.status,
      matchType: m.match_type,
      amountCents: m.amount_cents,
      transactionDate: m.transaction_date,
      description: m.description,
      debitCents: m.debit_cents,
      creditCents: m.credit_cents,
      bankRef: m.bank_ref,
      decidedAt: m.decided_at,
    }));
  return cheque;
}

/** Application d'une demande approuvée (appelée par approvals.js dans sa transaction). */
function applyApprovedOperation(db, approverCtx, request) {
  const after = parseJson(request.after_json, {});
  if (request.operation === 'CHEQUE_CREATE') {
    // Revalidation complète au moment de l'application : le référentiel a pu
    // changer entre la demande et la décision.
    const data = validateChequeState(db, approverCtx, after.fields);
    const created = insertChequeDirect(db, approverCtx, data, {
      duplicateOverrideReason: after.duplicateOverrideReason || null,
      createdBy: request.requested_by,
      approvalRequestId: request.id,
      reason: `Création approuvée par ${approverCtx.user.fullName} (demande ${request.reference})`,
    });
    return { entityType: 'CHEQUE', entityId: created.id, reference: created.reference, data: created };
  }
  if (request.operation === 'CHEQUE_UPDATE') {
    const current = getChequeRow(db, request.entity_id);
    if (!current) throw notFound('Chèque');
    const updated = applyUpdateDirect(db, approverCtx, current, after.changes, {
      expectedVersion: after.baseVersion,
      approvalRequestId: request.id,
      reason: after.reason || `Modification approuvée (demande ${request.reference})`,
    });
    return { entityType: 'CHEQUE', entityId: current.id, reference: current.reference, data: updated };
  }
  if (request.operation === 'CHEQUE_STATUS') {
    const current = getChequeRow(db, request.entity_id);
    if (!current) throw notFound('Chèque');
    const change = validateStatusChange(db, current, { to: after.to, reason: after.reason, eventDate: after.eventDate });
    const updated = applyStatusDirect(db, approverCtx, current, change, {
      expectedVersion: after.baseVersion,
      approvalRequestId: request.id,
    });
    return { entityType: 'CHEQUE', entityId: current.id, reference: current.reference, data: updated };
  }
  throw validationError(`Opération d’approbation non prise en charge : ${request.operation}`);
}

function chequeFilterOptions(db, ctx, companyId) {
  assertPermission(ctx, 'cheques.view');
  if (companyId) assertCompanyAccess(ctx, companyId);
  const allowed = resolveCompanyScope(ctx);
  if (!allowed.length) return { managers: [], statuses: [] };
  return {
    managers: db
      .prepare(
        `SELECT DISTINCT u.id, u.full_name FROM users u
         JOIN cheques ch ON ch.manager_id = u.id
         WHERE ch.company_id IN (${allowed.map(() => '?').join(',')}) ORDER BY u.full_name`
      )
      .all(...allowed)
      .map((r) => ({ id: r.id, fullName: r.full_name })),
  };
}

function listChequeEvents(db, ctx, chequeId) {
  assertPermission(ctx, 'cheques.view');
  const cheque = getChequeRow(db, chequeId);
  if (!cheque) throw notFound('Chèque');
  assertCompanyAccess(ctx, cheque.company_id);
  return db
    .prepare(
      `SELECT e.*, u.full_name AS actor_name
       FROM cheque_events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.cheque_id = ? ORDER BY e.id ASC`
    )
    .all(cheque.id)
    .map((e) => ({
      id: e.id,
      eventType: e.event_type,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      eventDate: e.event_date,
      reason: e.reason,
      actorName: e.actor_name,
      metadata: (() => {
        try {
          return JSON.parse(e.metadata_json || '{}');
        } catch {
          return {};
        }
      })(),
      createdAt: e.created_at,
    }));
}

module.exports = {
  createCheque,
  updateCheque,
  changeStatus,
  cancelCheque,
  listCheques,
  allCheques,
  getCheque,
  listManagers,
  listChequeEvents,
  applyApprovedOperation,
  applyStatusDirect,
  validateStatusChange,
  getChequeRow,
  mapCheque,
  chequeFilterOptions,
  findDuplicates,
  checkDuplicates,
  canSelfApprove,
};
