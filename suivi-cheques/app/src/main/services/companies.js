'use strict';

const { assertPermission, assertCompanyAccess, resolveCompanyScope, validationError, forbidden, notFound, AppError } = require('./authorization');
const { appendAudit } = require('./audit');
const { text, requiredText, code, email, boolean, getCompany } = require('./common');

function mapCompany(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    legalForm: row.legal_form,
    nif: row.nif,
    nis: row.nis,
    rc: row.rc,
    ai: row.ai,
    managerName: row.manager_name,
    capitalCents: row.capital_cents,
    address: row.address,
    wilaya: row.wilaya,
    phone: row.phone,
    email: row.email,
    color: row.color,
    isActive: Boolean(row.is_active),
    accountCount: row.account_count === undefined ? undefined : Number(row.account_count),
    chequeCount: row.cheque_count === undefined ? undefined : Number(row.cheque_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listCompanies(db, ctx, options = {}) {
  assertPermission(ctx, 'companies.view');
  const ids = resolveCompanyScope(ctx, options.companyIds);
  if (!ids.length) return [];
  const params = [...ids];
  let where = `c.id IN (${ids.map(() => '?').join(',')})`;
  if (options.includeInactive === false) where += ' AND c.is_active = 1';
  if (options.search) {
    where += ' AND (c.name LIKE ? OR c.code LIKE ? OR c.nif LIKE ?)';
    const like = `%${String(options.search).slice(0, 80)}%`;
    params.push(like, like, like);
  }
  return db
    .prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM bank_accounts a WHERE a.company_id = c.id AND a.is_active = 1) AS account_count,
        (SELECT COUNT(*) FROM cheques ch WHERE ch.company_id = c.id AND ch.is_archived = 0) AS cheque_count
       FROM companies c WHERE ${where} ORDER BY c.name`
    )
    .all(...params)
    .map(mapCompany);
}

function getCompanyDetail(db, ctx, companyId) {
  assertPermission(ctx, 'companies.view');
  assertCompanyAccess(ctx, companyId);
  const row = getCompany(db, companyId);
  const accounts = db
    .prepare(
      `SELECT a.id, a.label, a.opening_date, a.is_active, b.name AS bank_name
       FROM bank_accounts a JOIN banks b ON b.id = a.bank_id WHERE a.company_id = ? ORDER BY a.label`
    )
    .all(row.id);
  const result = mapCompany(row);
  result.accounts = accounts.map((a) => ({
    id: a.id,
    label: a.label,
    bankName: a.bank_name,
    isActive: Boolean(a.is_active),
  }));
  result.signatory = null;
  return result;
}

function validateCompanyInput(input, { partial = false } = {}) {
  return {
    code: input.code === undefined && partial ? undefined : code(input.code, 'Code société'),
    name: input.name === undefined && partial ? undefined : requiredText(input.name, 'Nom de la société', 160),
    legalForm: input.legalForm === undefined ? undefined : text(input.legalForm, 'Forme juridique', { max: 40 }),
    nif: input.nif === undefined ? undefined : text(input.nif, 'NIF', { max: 40 }),
    nis: input.nis === undefined ? undefined : text(input.nis, 'NIS', { max: 40 }),
    rc: input.rc === undefined ? undefined : text(input.rc, 'Registre de commerce', { max: 60 }),
    ai: input.ai === undefined ? undefined : text(input.ai, 'Article d’imposition', { max: 60 }),
    managerName: input.managerName === undefined ? undefined : text(input.managerName, 'Gérant', { max: 120 }),
    capitalCents: input.capitalCents === undefined ? undefined : Number(input.capitalCents),
    address: input.address === undefined ? undefined : text(input.address, 'Adresse', { max: 300 }),
    wilaya: input.wilaya === undefined ? undefined : text(input.wilaya, 'Wilaya', { max: 80 }),
    phone: input.phone === undefined ? undefined : text(input.phone, 'Téléphone', { max: 40 }),
    email: input.email === undefined ? undefined : email(input.email, 'E-mail'),
    color: input.color === undefined ? undefined : text(input.color, 'Couleur', { max: 20 }),
    isActive: input.isActive === undefined ? undefined : boolean(input.isActive),
  };
}

function createCompany(db, ctx, input) {
  assertPermission(ctx, 'companies.manage');
  const data = validateCompanyInput(input);
  if (data.capitalCents !== undefined && (!Number.isInteger(data.capitalCents) || data.capitalCents < 0)) {
    throw validationError('Capital invalide');
  }
  try {
    const result = db.transaction(() => {
      const id = Number(
        db
          .prepare(
            `INSERT INTO companies(code,name,legal_form,nif,nis,rc,ai,manager_name,capital_cents,address,wilaya,phone,email,color)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            data.code,
            data.name,
            data.legalForm,
            data.nif,
            data.nis,
            data.rc,
            data.ai,
            data.managerName,
            data.capitalCents || 0,
            data.address,
            data.wilaya,
            data.phone,
            data.email,
            data.color || '#0f766e'
          ).lastInsertRowid
      );
      appendAudit(db, ctx, {
        companyId: id,
        entityType: 'SOCIETE',
        entityId: id,
        action: 'COMPANY_CREATE',
        after: { ...data, capitalCents: data.capitalCents || 0 },
        reason: 'Création d’une société',
      });
      return id;
    }).immediate();
    return mapCompany(getCompany(db, result));
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (String(err.message).includes('UNIQUE')) {
      throw new AppError('CONFLICT', 'Ce code société ou ce NIF existe déjà');
    }
    throw err;
  }
}

function updateCompany(db, ctx, input) {
  assertPermission(ctx, 'companies.manage');
  const current = getCompany(db, input.id);
  assertCompanyAccess(ctx, current.id);
  const data = validateCompanyInput(input, { partial: true });
  if (data.capitalCents !== undefined && (!Number.isInteger(data.capitalCents) || data.capitalCents < 0)) {
    throw validationError('Capital invalide');
  }
  const fields = [];
  const params = [];
  const mapping = {
    code: 'code', name: 'name', legalForm: 'legal_form', nif: 'nif', nis: 'nis', rc: 'rc', ai: 'ai',
    managerName: 'manager_name', capitalCents: 'capital_cents', address: 'address', wilaya: 'wilaya',
    phone: 'phone', email: 'email', color: 'color', isActive: 'is_active',
  };
  for (const [key, column] of Object.entries(mapping)) {
    if (data[key] !== undefined) {
      fields.push(`${column} = ?`);
      params.push(key === 'isActive' ? (data[key] ? 1 : 0) : data[key]);
    }
  }
  if (!fields.length) throw validationError('Aucune modification');
  if (data.isActive === false) {
    const activeAccounts = db.prepare('SELECT COUNT(*) AS n FROM bank_accounts WHERE company_id = ? AND is_active = 1').get(current.id).n;
    if (activeAccounts > 0) throw forbidden('Désactivez d’abord les comptes bancaires actifs de cette société');
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM cheques WHERE company_id = ? AND status IN ('RECU','DEPOSE','EMIS','REMIS','A_REGULARISER') AND is_archived = 0")
      .get(current.id).n;
    if (pending > 0) throw forbidden('Des chèques en cours existent : la société ne peut pas être désactivée');
  }
  try {
    return db.transaction(() => {
      db.prepare(`UPDATE companies SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(
        ...params,
        new Date().toISOString(),
        current.id
      );
      appendAudit(db, ctx, {
        companyId: current.id,
        entityType: 'SOCIETE',
        entityId: current.id,
        action: 'COMPANY_UPDATE',
        before: mapCompany(current),
        after: data,
        reason: input.reason || 'Modification de la fiche société',
      });
      return mapCompany(getCompany(db, current.id));
    }).immediate();
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new AppError('CONFLICT', 'Ce code société ou ce NIF existe déjà');
    throw err;
  }
}

function deactivateCompany(db, ctx, companyId, reason) {
  return updateCompany(db, ctx, { id: companyId, isActive: false, reason: reason || 'Désactivation de la société' });
}

function companyOptions(db, ctx) {
  assertPermission(ctx, 'companies.view');
  const ids = resolveCompanyScope(ctx);
  if (!ids.length) return [];
  return db
    .prepare(`SELECT id, code, name, color, is_active FROM companies WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name`)
    .all(...ids)
    .map((c) => ({ id: c.id, code: c.code, name: c.name, color: c.color, isActive: Boolean(c.is_active) }));
}

module.exports = { listCompanies, getCompanyDetail, createCompany, updateCompany, deactivateCompany, companyOptions, mapCompany };
