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
const {
  text,
  requiredText,
  date,
  amount,
  cents,
  boolean,
  getCompany,
  getAccount,
  accountHasActivity,
  maskAccountNumber,
} = require('./common');

function assertCanViewSensitive(ctx) {
  return Boolean(ctx.permissions.has('accounts.sensitive'));
}

function mapBank(row) {
  return {
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    isActive: Boolean(row.is_active),
    accountCount: row.account_count === undefined ? undefined : Number(row.account_count),
  };
}

function listBanks(db, ctx, options = {}) {
  assertPermission(ctx, 'accounts.view');
  const params = [];
  let where = '1=1';
  if (options.includeInactive === false) where += ' AND b.is_active = 1';
  if (options.search) {
    where += ' AND (b.name LIKE ? OR b.short_name LIKE ?)';
    const like = `%${String(options.search).slice(0, 60)}%`;
    params.push(like, like);
  }
  return db
    .prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM bank_accounts a WHERE a.bank_id = b.id AND a.is_active = 1) AS account_count
       FROM banks b WHERE ${where} ORDER BY b.name`
    )
    .all(...params)
    .map(mapBank);
}

function createBank(db, ctx, input) {
  assertPermission(ctx, 'banks.manage');
  const name = requiredText(input.name, 'Nom de la banque', 120);
  const shortName = text(input.shortName, 'Nom court', { max: 60 });
  try {
    const id = db.transaction(() => {
      const newId = Number(db.prepare('INSERT INTO banks(name, short_name) VALUES (?, ?)').run(name, shortName).lastInsertRowid);
      appendAudit(db, ctx, {
        entityType: 'BANQUE',
        entityId: newId,
        action: 'BANK_CREATE',
        after: { name, shortName },
        reason: 'Création d’une banque',
      });
      return newId;
    }).immediate();
    return mapBank(db.prepare('SELECT * FROM banks WHERE id = ?').get(id));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new AppError('CONFLICT', 'Cette banque existe déjà');
    throw err;
  }
}

function updateBank(db, ctx, input) {
  assertPermission(ctx, 'banks.manage');
  const current = db.prepare('SELECT * FROM banks WHERE id = ?').get(Number(input.id));
  if (!current) throw notFound('Banque');
  const name = input.name === undefined ? current.name : requiredText(input.name, 'Nom de la banque', 120);
  const shortName = input.shortName === undefined ? current.short_name : text(input.shortName, 'Nom court', { max: 60 });
  const isActive = input.isActive === undefined ? Boolean(current.is_active) : boolean(input.isActive);
  if (!isActive) {
    const active = db.prepare('SELECT COUNT(*) AS n FROM bank_accounts WHERE bank_id = ? AND is_active = 1').get(current.id).n;
    if (active > 0) throw forbidden('Des comptes actifs utilisent cette banque');
  }
  try {
    return db.transaction(() => {
      db.prepare('UPDATE banks SET name = ?, short_name = ?, is_active = ? WHERE id = ?').run(
        name,
        shortName,
        isActive ? 1 : 0,
        current.id
      );
      appendAudit(db, ctx, {
        entityType: 'BANQUE',
        entityId: current.id,
        action: 'BANK_UPDATE',
        before: mapBank(current),
        after: { name, shortName, isActive },
        reason: input.reason || 'Modification d’une banque',
      });
      return mapBank(db.prepare('SELECT * FROM banks WHERE id = ?').get(current.id));
    }).immediate();
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new AppError('CONFLICT', 'Cette banque existe déjà');
    throw err;
  }
}

function mapAccount(row, ctx, options = {}) {
  const sensitive = assertCanViewSensitive(ctx);
  const base = {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    companyCode: row.company_code,
    bankId: row.bank_id,
    bankName: row.bank_name,
    bankShortName: row.bank_short_name,
    label: row.label,
    accountNumber: sensitive ? row.account_number : maskAccountNumber(row.account_number),
    accountNumberMasked: maskAccountNumber(row.account_number),
    rib: sensitive ? row.rib : row.rib ? maskAccountNumber(row.rib) : null,
    currency: row.currency,
    openingBalanceCents: row.opening_balance_cents,
    openingDate: row.opening_date,
    isActive: Boolean(row.is_active),
    hasActivity: options.hasActivity,
    latestStatement: row.latest_statement_date
      ? { statementDate: row.latest_statement_date, closingBalanceCents: row.latest_closing_balance_cents, sourceType: row.latest_source_type }
      : null,
  };
  return base;
}

function listAccounts(db, ctx, options = {}) {
  assertPermission(ctx, 'accounts.view');
  const companyIds = resolveCompanyScope(ctx, options.companyIds);
  if (!companyIds.length) return [];
  const params = [...companyIds];
  let where = `a.company_id IN (${companyIds.map(() => '?').join(',')})`;
  if (options.includeInactive === false) where += ' AND a.is_active = 1';
  if (options.companyId) {
    assertCompanyAccess(ctx, options.companyId);
    where += ' AND a.company_id = ?';
    params.push(Number(options.companyId));
  }
  if (options.bankId) {
    where += ' AND a.bank_id = ?';
    params.push(Number(options.bankId));
  }
  const rows = db
    .prepare(
      `SELECT a.*, b.name AS bank_name, b.short_name AS bank_short_name,
        c.name AS company_name, c.code AS company_code,
        li.statement_date AS latest_statement_date,
        li.closing_balance_cents AS latest_closing_balance_cents,
        li.source_type AS latest_source_type
       FROM bank_accounts a
       JOIN banks b ON b.id = a.bank_id
       JOIN companies c ON c.id = a.company_id
       LEFT JOIN bank_imports li ON li.id = (
         SELECT id FROM bank_imports bi WHERE bi.account_id = a.id
         ORDER BY bi.statement_date DESC, bi.id DESC LIMIT 1
       )
       WHERE ${where}
       ORDER BY c.name, a.label`
    )
    .all(...params);
  return rows.map((row) => {
    const accountsActivity = db
      .prepare('SELECT EXISTS(SELECT 1 FROM cheques WHERE account_id = ?) OR EXISTS(SELECT 1 FROM transactions WHERE account_id = ?) AS x')
      .get(row.id, row.id).x;
    return mapAccount(row, ctx, { hasActivity: Boolean(accountsActivity) });
  });
}

function assertBaseCurrency(db, currency) {
  const base = getSetting(db, 'app.base_currency', 'DZD');
  if (String(currency || base).toUpperCase() !== base) {
    throw validationError(`Devise non prise en charge. Devise de base du groupe : ${base}`);
  }
  return base;
}

function createAccount(db, ctx, input) {
  assertPermission(ctx, 'accounts.manage');
  const company = getCompany(db, input.companyId);
  assertCompanyAccess(ctx, company.id);
  if (!company.is_active) throw forbidden('Société désactivée');
  const bank = db.prepare('SELECT * FROM banks WHERE id = ?').get(Number(input.bankId));
  if (!bank) throw validationError('Banque inconnue');
  if (!bank.is_active) throw validationError('Banque désactivée');
  const label = requiredText(input.label, 'Libellé du compte', 120);
  const accountNumber = requiredText(input.accountNumber, 'Numéro de compte', 60).replace(/\s+/g, ' ').trim();
  const rib = text(input.rib, 'RIB', { max: 60 });
  const currency = assertBaseCurrency(db, input.currency);
  const openingDate = date(input.openingDate, 'Date d’ouverture', { required: true, allowFuture: false });
  const openingBalanceCents = cents(input.openingBalanceCents ?? 0, 'Solde d’ouverture', { allowNegative: true });
  try {
    const id = db.transaction(() => {
      const newId = Number(
        db
          .prepare(
            `INSERT INTO bank_accounts(company_id,bank_id,label,account_number,rib,currency,opening_balance_cents,opening_date)
             VALUES (?,?,?,?,?,?,?,?)`
          )
          .run(company.id, bank.id, label, accountNumber, rib, currency, openingBalanceCents, openingDate).lastInsertRowid
      );
      appendAudit(db, ctx, {
        companyId: company.id,
        entityType: 'COMPTE',
        entityId: newId,
        action: 'ACCOUNT_CREATE',
        after: {
          companyId: company.id,
          bankId: bank.id,
          label,
          accountNumber: maskAccountNumber(accountNumber),
          currency,
          openingBalanceCents,
          openingDate,
        },
        reason: 'Création d’un compte bancaire',
      });
      return newId;
    }).immediate();
    return mapAccount(getAccount(db, id), ctx, { hasActivity: false });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new AppError('CONFLICT', 'Ce compte existe déjà pour cette société et cette banque');
    }
    throw err;
  }
}

function updateAccount(db, ctx, input) {
  assertPermission(ctx, 'accounts.manage');
  const current = getAccount(db, input.id);
  assertCompanyAccess(ctx, current.company_id);
  if (input.companyId !== undefined && Number(input.companyId) !== current.company_id) {
    throw forbidden('Le rattachement d’un compte à une société ne peut pas être modifié. Créez un nouveau compte.');
  }
  if (input.bankId !== undefined && Number(input.bankId) !== current.bank_id) {
    throw forbidden('La banque d’un compte ne peut pas être modifiée après création.');
  }
  const hasActivity = accountHasActivity(db, current.id);
  const wantsOpeningChange =
    (input.openingBalanceCents !== undefined && cents(input.openingBalanceCents, 'Solde d’ouverture', { allowNegative: true }) !== current.opening_balance_cents) ||
    (input.openingDate !== undefined && String(input.openingDate) !== current.opening_date);
  if (wantsOpeningChange) {
    if (hasActivity) {
      throw forbidden(
        'Le solde et la date d’ouverture sont figés dès qu’un chèque, une transaction ou un import existe. Enregistrez une transaction de régularisation motivée.'
      );
    }
    assertPermission(ctx, 'accounts.manage');
  }
  const label = input.label === undefined ? current.label : requiredText(input.label, 'Libellé', 120);
  const accountNumber =
    input.accountNumber === undefined ? current.account_number : requiredText(input.accountNumber, 'Numéro de compte', 60).replace(/\s+/g, ' ').trim();
  const rib = input.rib === undefined ? current.rib : text(input.rib, 'RIB', { max: 60 });
  const openingDate = input.openingDate === undefined ? current.opening_date : date(input.openingDate, 'Date d’ouverture', { required: true, allowFuture: false });
  const openingBalanceCents =
    input.openingBalanceCents === undefined ? current.opening_balance_cents : cents(input.openingBalanceCents, 'Solde d’ouverture', { allowNegative: true });
  const isActive = input.isActive === undefined ? Boolean(current.is_active) : boolean(input.isActive);
  if (!isActive) {
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM cheques WHERE account_id = ? AND status IN ('RECU','DEPOSE','EMIS','REMIS') AND is_archived = 0")
      .get(current.id).n;
    if (pending > 0) throw forbidden('Des chèques en cours existent sur ce compte');
  }
  try {
    return db.transaction(() => {
      db.prepare(
        `UPDATE bank_accounts SET label = ?, account_number = ?, rib = ?, opening_balance_cents = ?,
          opening_date = ?, is_active = ?, updated_at = ? WHERE id = ?`
      ).run(
        label,
        accountNumber,
        rib,
        openingBalanceCents,
        openingDate,
        isActive ? 1 : 0,
        new Date().toISOString(),
        current.id
      );
      appendAudit(db, ctx, {
        companyId: current.company_id,
        entityType: 'COMPTE',
        entityId: current.id,
        action: 'ACCOUNT_UPDATE',
        before: {
          label: current.label,
          accountNumber: maskAccountNumber(current.account_number),
          rib: current.rib ? maskAccountNumber(current.rib) : null,
          openingBalanceCents: current.opening_balance_cents,
          openingDate: current.opening_date,
          isActive: Boolean(current.is_active),
        },
        after: {
          label,
          accountNumber: maskAccountNumber(accountNumber),
          rib: rib ? maskAccountNumber(rib) : null,
          openingBalanceCents,
          openingDate,
          isActive,
        },
        reason: input.reason || 'Modification d’un compte bancaire',
      });
      return mapAccount(getAccount(db, current.id), ctx, { hasActivity });
    }).immediate();
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new AppError('CONFLICT', 'Ce numéro de compte existe déjà pour cette société et cette banque');
    throw err;
  }
}

function accountOptions(db, ctx, options = {}) {
  assertPermission(ctx, 'accounts.view');
  const accounts = listAccounts(db, ctx, { companyIds: options.companyIds, includeInactive: false });
  return accounts.map((a) => ({
    id: a.id,
    companyId: a.companyId,
    companyName: a.companyName,
    bankName: a.bankName,
    label: a.label,
    maskedNumber: a.accountNumberMasked,
    accountNumber: a.accountNumber,
    currency: a.currency,
  }));
}

module.exports = {
  listBanks,
  createBank,
  updateBank,
  listAccounts,
  createAccount,
  updateAccount,
  accountOptions,
  mapAccount,
  assertCanViewSensitive,
};
