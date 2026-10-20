'use strict';

const { validationError, forbidden, notFound } = require('./authorization');
const { assertISODate, todayISO } = require('../../shared/dates');
const { parseAmountToCents } = require('../../shared/money');

function text(value, field, { required = false, max = 500, min = 0 } = {}) {
  if (value === null || value === undefined) {
    if (required) throw validationError(`${field} requis`);
    return null;
  }
  const s = String(value).trim();
  if (!s) {
    if (required) throw validationError(`${field} requis`);
    return null;
  }
  if (s.length < min) throw validationError(`${field} trop court`);
  if (s.length > max) throw validationError(`${field} trop long (${max} caractères maximum)`);
  return s;
}

function requiredText(value, field, max = 500) {
  return text(value, field, { required: true, max });
}

function code(value, field = 'Code', max = 20) {
  const s = requiredText(value, field, max).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(s)) {
    throw validationError(`${field} invalide : lettres majuscules, chiffres, tiret et souligné uniquement`);
  }
  return s;
}

function email(value, field = 'E-mail') {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw validationError(`${field} invalide`);
  return s;
}

function date(value, field = 'Date', { required = false, allowFuture = true, allowPast = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw validationError(`${field} requise`);
    return null;
  }
  assertISODate(String(value), field);
  const iso = String(value);
  const today = todayISO();
  if (!allowFuture && iso > today) throw validationError(`${field} ne peut pas être dans le futur`);
  if (!allowPast && iso < today) throw validationError(`${field} ne peut pas être dans le passé`);
  return iso;
}

function cents(value, field = 'Montant', { allowNegative = false, max = 9000000000000 } = {}) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n)) throw validationError(`${field} doit être exprimé en centimes entiers`);
  if (!allowNegative && n < 0) throw validationError(`${field} ne peut pas être négatif`);
  if (Math.abs(n) > max) throw validationError(`${field} dépasse le maximum autorisé`);
  return n;
}

function amount(value, field = 'Montant', options = {}) {
  try {
    return parseAmountToCents(value, { field, ...options });
  } catch (err) {
    throw validationError(err.message);
  }
}

function id(value, field = 'Identifiant') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw validationError(`${field} invalide`);
  return n;
}

function optionalId(value, field = 'Identifiant') {
  if (value === null || value === undefined || value === '') return null;
  return id(value, field);
}

function boolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function getCompany(db, idValue) {
  const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(Number(idValue));
  if (!row) throw notFound('Société');
  return row;
}

function assertActiveCompany(db, idValue, ctx, assertCompanyAccess) {
  const company = getCompany(db, idValue);
  assertCompanyAccess(ctx, company.id);
  if (!company.is_active) throw forbidden('Cette société est désactivée');
  return company;
}

function getAccount(db, idValue) {
  const row = db
    .prepare(
      `SELECT a.*, b.name AS bank_name, b.short_name AS bank_short_name, c.name AS company_name, c.code AS company_code
       FROM bank_accounts a
       JOIN banks b ON b.id = a.bank_id
       JOIN companies c ON c.id = a.company_id
       WHERE a.id = ?`
    )
    .get(Number(idValue));
  if (!row) throw notFound('Compte bancaire');
  return row;
}

function accountHasActivity(db, accountId) {
  const cheque = db.prepare('SELECT COUNT(*) AS n FROM cheques WHERE account_id = ?').get(accountId).n;
  const tx = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').get(accountId).n;
  const imports = db.prepare('SELECT COUNT(*) AS n FROM bank_imports WHERE account_id = ?').get(accountId).n;
  return cheque + tx + imports > 0;
}

function maskAccountNumber(value) {
  if (!value) return '';
  const clean = String(value).trim();
  const digits = clean.replace(/\s+/g, '');
  if (digits.length <= 4) return '••••';
  return `•••• ${digits.slice(-4)}`;
}

function escLike(value) {
  return String(value).replace(/[\\%_]/g, (c) => `\\${c}`);
}

function paginate(page, pageSize) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.min(200, Math.max(10, Number(pageSize) || 50));
  return { page: p, pageSize: size, offset: (p - 1) * size };
}

function companyInClause(ids, column = 'company_id') {
  if (!ids.length) return { sql: '0=1', params: [] };
  return { sql: `${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

function logMaskedAccount(account) {
  return {
    id: account.id,
    companyId: account.company_id,
    bankId: account.bank_id,
    label: account.label,
    accountNumber: maskAccountNumber(account.account_number),
    rib: account.rib ? maskAccountNumber(account.rib) : null,
    openingBalanceCents: account.opening_balance_cents,
    openingDate: account.opening_date,
    isActive: Boolean(account.is_active),
  };
}

module.exports = {
  text,
  requiredText,
  code,
  email,
  date,
  amount,
  cents,
  id,
  optionalId,
  boolean,
  getCompany,
  assertActiveCompany,
  getAccount,
  accountHasActivity,
  maskAccountNumber,
  escLike,
  paginate,
  companyInClause,
  logMaskedAccount,
};
