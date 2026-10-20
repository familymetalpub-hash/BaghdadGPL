'use strict';

const crypto = require('node:crypto');
const { assertPermission, assertCompanyAccess, resolveCompanyScope, validationError, forbidden, notFound } = require('./authorization');
const { appendAudit } = require('./audit');
const { nextSequence, makeReference, transaction } = require('../db');
const { getAccount } = require('./common');
const { todayISO, assertISODate } = require('../../shared/dates');
const { parseAmountToCents, formatCents } = require('../../shared/money');

const TX_TYPES = {
  DEPOT: { label: 'Dépôt', sign: 1, group: 'CREDIT' },
  RETRAIT: { label: 'Retrait', sign: -1, group: 'DEBIT' },
  FRAIS: { label: 'Frais bancaires', sign: -1, group: 'DEBIT' },
  INTERETS: { label: 'Intérêts créditeurs', sign: 1, group: 'CREDIT' },
  REMBOURSEMENT_PRET: { label: 'Remboursement de prêt', sign: -1, group: 'DEBIT' },
  TRANSFERT_SORTIE: { label: 'Transfert sortant', sign: -1, group: 'TRANSFER' },
  TRANSFERT_ENTREE: { label: 'Transfert entrant', sign: 1, group: 'TRANSFER' },
};

const TX_SIGNS = Object.fromEntries(Object.entries(TX_TYPES).map(([k, v]) => [k, v.sign]));

function mapTransaction(row) {
  return {
    id: row.id,
    reference: row.reference,
    companyId: row.company_id,
    companyName: row.company_name,
    accountId: row.account_id,
    accountLabel: row.account_label,
    bankName: row.bank_name,
    type: row.type,
    typeLabel: TX_TYPES[row.type]?.label || row.type,
    sign: TX_SIGNS[row.type] || 0,
    amountCents: row.amount_cents,
    amountFormatted: formatCents(row.amount_cents),
    currency: row.currency,
    effectiveDate: row.effective_date,
    description: row.description,
    counterpartyId: row.counterparty_id,
    counterpartyName: row.counterparty_name,
    transferGroupId: row.transfer_group_id,
    transferPeerAccountId: row.transfer_peer_account_id,
    transferPeerAccountLabel: row.transfer_peer_label,
    transferPeerCompanyName: row.transfer_peer_company,
    createdBy: row.created_by,
    creatorName: row.creator_name,
    createdAt: row.created_at,
    isArchived: Boolean(row.is_archived),
    legacyId: row.legacy_id,
  };
}

function listTransactions(db, ctx, options = {}) {
  assertPermission(ctx, 'transactions.view');
  const companyIds = resolveCompanyScope(ctx, options.companyIds);
  if (!companyIds.length) return { items: [], total: 0, page: 1, pageSize: 50, pageCount: 1 };
  const params = [...companyIds];
  const where = [`t.company_id IN (${companyIds.map(() => '?').join(',')})`];
  if (options.companyId) {
    assertCompanyAccess(ctx, options.companyId);
    where.push('t.company_id = ?');
    params.push(Number(options.companyId));
  }
  if (options.accountId) {
    where.push('t.account_id = ?');
    params.push(Number(options.accountId));
  }
  if (options.type) {
    where.push('t.type = ?');
    params.push(String(options.type));
  }
  if (options.dateFrom) {
    where.push('t.effective_date >= ?');
    params.push(String(options.dateFrom));
  }
  if (options.dateTo) {
    where.push('t.effective_date <= ?');
    params.push(String(options.dateTo));
  }
  if (options.search) {
    const like = `%${String(options.search).slice(0, 100)}%`;
    where.push('(t.description LIKE ? OR t.reference LIKE ?)');
    params.push(like, like);
  }
  if (options.includeArchived !== true) where.push('t.is_archived = 0');
  const whereSql = where.join(' AND ');
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.min(200, Math.max(10, Number(options.pageSize) || 50));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM transactions t WHERE ${whereSql}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT t.*, a.label AS account_label, b.name AS bank_name, c.name AS company_name,
              p.name AS counterparty_name, u.full_name AS creator_name,
              peer.account_id AS transfer_peer_account_id, peer.label AS transfer_peer_label,
              peer_company.name AS transfer_peer_company
       FROM transactions t
       JOIN bank_accounts a ON a.id = t.account_id
       JOIN banks b ON b.id = a.bank_id
       JOIN companies c ON c.id = t.company_id
       LEFT JOIN counterparties p ON p.id = t.counterparty_id
       LEFT JOIN users u ON u.id = t.created_by
       LEFT JOIN transactions tp ON tp.transfer_group_id = t.transfer_group_id AND tp.id <> t.id
       LEFT JOIN bank_accounts peer ON peer.id = tp.account_id
       LEFT JOIN companies peer_company ON peer_company.id = peer.company_id
       WHERE ${whereSql}
       ORDER BY t.effective_date DESC, t.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return {
    items: rows.map(mapTransaction),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function validateCommon(db, ctx, input) {
  const account = getAccount(db, input.accountId);
  assertCompanyAccess(ctx, account.company_id);
  if (!account.is_active) throw forbidden('Compte bancaire désactivé');
  assertPermission(ctx, 'transactions.manage');
  const type = String(input.type || '').toUpperCase();
  if (!TX_TYPES[type] || type.startsWith('TRANSFERT')) throw validationError('Type de transaction invalide');
  const amountCents = input.amountCents !== undefined ? Number(input.amountCents) : parseAmountToCents(input.amount, { field: 'Montant' });
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw validationError('Montant invalide');
  const effectiveDate = String(input.effectiveDate || todayISO());
  assertISODate(effectiveDate, 'Date d’effet');
  if (effectiveDate > todayISO()) throw validationError('La date d’effet ne peut pas être dans le futur');
  if (effectiveDate < account.opening_date) throw validationError('La date d’effet ne peut pas précéder l’ouverture du compte');
  const description = input.description === undefined || input.description === null || input.description === '' ? null : String(input.description).trim();
  if (description && description.length > 500) throw validationError('Description trop longue');
  let counterpartyId = input.counterpartyId || null;
  if (counterpartyId) {
    const cp = db.prepare('SELECT * FROM counterparties WHERE id = ?').get(Number(counterpartyId));
    if (!cp || cp.company_id !== account.company_id) throw validationError('Contrepartie invalide pour cette société');
    counterpartyId = cp.id;
  }
  return { account, type, amountCents, effectiveDate, description, counterpartyId, currency: account.currency };
}

function insertSingle(db, ctx, data) {
  const year = new Date().getFullYear();
  const reference = makeReference('TRX', year, nextSequence(db, 'TRANSACTION', year));
  const id = Number(
    db
      .prepare(
        `INSERT INTO transactions(reference,company_id,account_id,type,amount_cents,currency,effective_date,description,counterparty_id,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        reference,
        data.account.company_id,
        data.account.id,
        data.type,
        data.amountCents,
        data.currency,
        data.effectiveDate,
        data.description,
        data.counterpartyId,
        ctx.user.id
      ).lastInsertRowid
  );
  return { id, reference };
}

function createTransaction(db, ctx, input) {
  assertPermission(ctx, 'transactions.manage');
  if (String(input.type || '').toUpperCase().startsWith('TRANSFERT')) return createTransfer(db, ctx, input);
  const data = validateCommon(db, ctx, input);
  return transaction(db, () => {
    const created = insertSingle(db, ctx, data);
    appendAudit(db, ctx, {
      companyId: data.account.company_id,
      entityType: 'TRANSACTION',
      entityId: created.id,
      action: 'TRANSACTION_CREATE',
      after: {
        reference: created.reference,
        accountId: data.account.id,
        type: data.type,
        amountCents: data.amountCents,
        effectiveDate: data.effectiveDate,
        description: data.description,
      },
      reason: input.reason || 'Enregistrement d’une transaction',
    });
    return { id: created.id, reference: created.reference };
  });
}

function createTransfer(db, ctx, input) {
  const fromAccount = getAccount(db, input.accountId);
  assertCompanyAccess(ctx, fromAccount.company_id);
  if (!fromAccount.is_active) throw forbidden('Compte source désactivé');
  if (!input.toAccountId) throw validationError('Compte destinataire requis');
  const toAccount = getAccount(db, input.toAccountId);
  assertCompanyAccess(ctx, toAccount.company_id);
  if (!toAccount.is_active) throw forbidden('Compte destinataire désactivé');
  if (fromAccount.id === toAccount.id) throw validationError('Les comptes source et destinataire doivent être différents');
  if (fromAccount.currency !== toAccount.currency) throw validationError('Les comptes n’ont pas la même devise');
  const amountCents = input.amountCents !== undefined ? Number(input.amountCents) : parseAmountToCents(input.amount, { field: 'Montant' });
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw validationError('Montant invalide');
  const effectiveDate = String(input.effectiveDate || todayISO());
  assertISODate(effectiveDate, 'Date d’effet');
  if (effectiveDate > todayISO()) throw validationError('La date d’effet ne peut pas être dans le futur');
  if (effectiveDate < fromAccount.opening_date || effectiveDate < toAccount.opening_date) {
    throw validationError('La date d’effet ne peut pas précéder l’ouverture d’un des comptes');
  }
  const description =
    input.description === undefined || input.description === null || String(input.description).trim() === ''
      ? `Transfert ${fromAccount.label} → ${toAccount.label}`
      : String(input.description).trim();
  if (description.length > 500) throw validationError('Description trop longue');
  const groupId = crypto.randomUUID();
  const year = new Date().getFullYear();
  return transaction(db, () => {
    const referenceOut = makeReference('TRX', year, nextSequence(db, 'TRANSACTION', year));
    const referenceIn = makeReference('TRX', year, nextSequence(db, 'TRANSACTION', year));
    const insert = db.prepare(
      `INSERT INTO transactions(reference,company_id,account_id,type,amount_cents,currency,effective_date,description,transfer_group_id,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    const outId = Number(
      insert.run(
        referenceOut,
        fromAccount.company_id,
        fromAccount.id,
        'TRANSFERT_SORTIE',
        amountCents,
        fromAccount.currency,
        effectiveDate,
        description,
        groupId,
        ctx.user.id
      ).lastInsertRowid
    );
    const inId = Number(
      insert.run(
        referenceIn,
        toAccount.company_id,
        toAccount.id,
        'TRANSFERT_ENTREE',
        amountCents,
        toAccount.currency,
        effectiveDate,
        description,
        groupId,
        ctx.user.id
      ).lastInsertRowid
    );
    appendAudit(db, ctx, {
      companyId: fromAccount.company_id,
      entityType: 'TRANSFERT',
      entityId: groupId,
      action: 'TRANSFER_CREATE',
      after: {
        fromAccountId: fromAccount.id,
        fromCompanyId: fromAccount.company_id,
        toAccountId: toAccount.id,
        toCompanyId: toAccount.company_id,
        amountCents,
        effectiveDate,
        description,
      },
      reason: input.reason || 'Transfert entre comptes',
      metadata: { referenceOut, referenceIn, outId, inId },
    });
    return {
      transferGroupId: groupId,
      referenceOut,
      referenceIn,
      amountFormatted: formatCents(amountCents),
      intercompany: fromAccount.company_id !== toAccount.company_id,
    };
  });
}

function listTransferPeers(db, ctx, accountId) {
  assertPermission(ctx, 'transactions.view');
  const account = getAccount(db, accountId);
  assertCompanyAccess(ctx, account.company_id);
  const ids = resolveCompanyScope(ctx);
  if (!ids.length) return [];
  return db
    .prepare(
      `SELECT a.id, a.label, c.name AS company_name, b.name AS bank_name, a.company_id
       FROM bank_accounts a JOIN companies c ON c.id = a.company_id JOIN banks b ON b.id = a.bank_id
       WHERE a.is_active = 1 AND a.id <> ? AND c.id IN (${ids.map(() => '?').join(',')})
       ORDER BY c.name, a.label`
    )
    .all(account.id, ...ids)
    .map((a) => ({ id: a.id, label: a.label, companyName: a.company_name, bankName: a.bank_name, companyId: a.company_id }));
}

function transactionOptions(db, ctx) {
  assertPermission(ctx, 'transactions.view');
  return Object.entries(TX_TYPES)
    .filter(([k]) => !k.startsWith('TRANSFERT'))
    .map(([code, v]) => ({ code, label: v.label, sign: v.sign }));
}

module.exports = {
  TX_TYPES,
  TX_SIGNS,
  listTransactions,
  createTransaction,
  createTransfer,
  listTransferPeers,
  transactionOptions,
};
