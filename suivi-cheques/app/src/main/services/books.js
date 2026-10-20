'use strict';

const { assertPermission, assertCompanyAccess, resolveCompanyScope, validationError, forbidden, notFound, AppError } = require('./authorization');
const { appendAudit } = require('./audit');
const { text, requiredText, getAccount } = require('./common');
const { chequeNumberDigits } = require('../../shared/status');

function numericRange(value, field) {
  const cleaned = String(value ?? '').trim();
  if (!/^\d{1,12}$/.test(cleaned)) throw validationError(`${field} doit être un numéro numérique`);
  return {
    display: cleaned,
    value: Number(cleaned),
  };
}

function usageForBook(db, book) {
  const from = Number(book.from_number);
  const to = Number(book.to_number);
  const numbers = db
    .prepare(
      `SELECT cheque_number_normalized, cheque_number FROM cheques
       WHERE account_id = ? AND direction = 'EMIS' AND is_archived = 0`
    )
    .all(book.account_id);
  const usedSet = new Set();
  for (const row of numbers) {
    const n = chequeNumberDigits(row.cheque_number_normalized);
    if (n !== null && n >= from && n <= to) usedSet.add(n);
  }
  const capacity = to - from + 1;
  const used = usedSet.size;
  return { capacity, used, remaining: Math.max(0, capacity - used) };
}

function mapBook(row, usage) {
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    accountId: row.account_id,
    accountLabel: row.label,
    bankName: row.bank_name,
    bookLabel: row.book_label,
    fromNumber: row.from_number,
    toNumber: row.to_number,
    capacity: usage.capacity,
    used: usage.used,
    remaining: usage.remaining,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
  };
}

function listBooks(db, ctx, options = {}) {
  assertPermission(ctx, 'books.view');
  const ids = resolveCompanyScope(ctx, options.companyIds);
  if (!ids.length) return [];
  const params = [...ids];
  let where = `a.company_id IN (${ids.map(() => '?').join(',')})`;
  if (options.accountId) {
    where += ' AND cb.account_id = ?';
    params.push(Number(options.accountId));
  }
  if (options.includeInactive === false) where += ' AND cb.is_active = 1';
  const rows = db
    .prepare(
      `SELECT cb.id, cb.company_id, cb.account_id, cb.from_number, cb.to_number, cb.is_active, cb.created_at,
              cb.label AS book_label, a.label AS label, b.name AS bank_name, c.name AS company_name
       FROM cheque_books cb
       JOIN bank_accounts a ON a.id = cb.account_id
       JOIN banks b ON b.id = a.bank_id
       JOIN companies c ON c.id = a.company_id
       WHERE ${where} ORDER BY c.name, a.label, CAST(cb.from_number AS INTEGER)`
    )
    .all(...params);
  return rows.map((row) => mapBook(row, usageForBook(db, row)));
}

function createBook(db, ctx, input) {
  assertPermission(ctx, 'books.manage');
  const account = getAccount(db, input.accountId);
  assertCompanyAccess(ctx, account.company_id);
  if (!account.is_active) throw forbidden('Compte bancaire désactivé');
  const from = numericRange(input.fromNumber, 'Numéro de début');
  const to = numericRange(input.toNumber, 'Numéro de fin');
  if (to.value < from.value) throw validationError('Le numéro de fin doit être supérieur ou égal au numéro de début');
  const capacity = to.value - from.value + 1;
  if (capacity > 50000) throw validationError('Plage de chéquier trop grande (50 000 numéros maximum)');
  const overlap = db
    .prepare(
      `SELECT id, from_number, to_number FROM cheque_books
       WHERE account_id = ? AND is_active = 1
         AND CAST(from_number AS INTEGER) <= ? AND CAST(to_number AS INTEGER) >= ?`
    )
    .all(account.id, to.value, from.value);
  if (overlap.length) {
    throw new AppError('CONFLICT', 'Cette plage chevauche un chéquier existant pour ce compte');
  }
  return db.transaction(() => {
    const createdBy = ctx.user.id;
    const id = Number(
      db
        .prepare(
          `INSERT INTO cheque_books(company_id, account_id, label, from_number, to_number, created_by)
           VALUES (?,?,?,?,?,?)`
        )
        .run(
          account.company_id,
          account.id,
          text(input.label, 'Libellé du chéquier', { max: 80 }),
          from.display,
          to.display,
          createdBy
        ).lastInsertRowid
    );
    appendAudit(db, ctx, {
      companyId: account.company_id,
      entityType: 'CHEQUIER',
      entityId: id,
      action: 'BOOK_CREATE',
      after: { accountId: account.id, from: from.display, to: to.display, label: input.label || null },
      reason: 'Création d’un chéquier',
    });
    const row = db
      .prepare(
        `SELECT cb.id, cb.company_id, cb.account_id, cb.from_number, cb.to_number, cb.is_active, cb.created_at,
                cb.label AS book_label, a.label AS label, b.name AS bank_name, c.name AS company_name
         FROM cheque_books cb JOIN bank_accounts a ON a.id = cb.account_id
         JOIN banks b ON b.id = a.bank_id JOIN companies c ON c.id = a.company_id WHERE cb.id = ?`
      )
      .get(id);
    return mapBook(row, usageForBook(db, row));
  }).immediate();
}

function updateBook(db, ctx, input) {
  assertPermission(ctx, 'books.manage');
  const current = db
    .prepare(
      `SELECT cb.id, cb.company_id, cb.account_id, cb.from_number, cb.to_number, cb.is_active, cb.created_at,
              cb.label AS book_label, a.label AS label, b.name AS bank_name, c.name AS company_name
       FROM cheque_books cb JOIN bank_accounts a ON a.id = cb.account_id
       JOIN banks b ON b.id = a.bank_id JOIN companies c ON c.id = a.company_id WHERE cb.id = ?`
    )
    .get(Number(input.id));
  if (!current) throw notFound('Chéquier');
  assertCompanyAccess(ctx, current.company_id);
  if (
    (input.fromNumber !== undefined && String(input.fromNumber).trim() !== current.from_number) ||
    (input.toNumber !== undefined && String(input.toNumber).trim() !== current.to_number)
  ) {
    throw forbidden('La plage de numéros d’un chéquier est immuable. Désactivez-le et créez-en un nouveau.');
  }
  const label = input.label === undefined ? current.book_label : text(input.label, 'Libellé', { max: 80 });
  const isActive = input.isActive === undefined ? Boolean(current.is_active) : Boolean(input.isActive);
  db.transaction(() => {
    db.prepare('UPDATE cheque_books SET label=?, is_active=? WHERE id=?').run(label, isActive ? 1 : 0, current.id);
    appendAudit(db, ctx, {
      companyId: current.company_id,
      entityType: 'CHEQUIER',
      entityId: current.id,
      action: 'BOOK_UPDATE',
      before: { label: current.book_label, isActive: Boolean(current.is_active) },
      after: { label, isActive },
      reason: input.reason || 'Modification d’un chéquier',
    });
  }).immediate();
  return { ok: true };
}

function lowStockBooks(db, ctx) {
  const books = listBooks(db, ctx, { includeInactive: false });
  return books.filter((b) => b.remaining <= 3).map((b) => ({
    bookId: b.id,
    companyId: b.companyId,
    accountId: b.accountId,
    label: b.accountLabel,
    remaining: b.remaining,
  }));
}

module.exports = { listBooks, createBook, updateBook, lowStockBooks, usageForBook };
