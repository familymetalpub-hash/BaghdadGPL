'use strict';

const { assertPermission, assertCompanyAccess, resolveCompanyScope, validationError, forbidden, AppError, notFound } = require('./authorization');
const { appendAudit } = require('./audit');
const { text, requiredText } = require('./common');

const TYPES = ['CLIENT', 'FOURNISSEUR', 'SALARIE', 'BANQUE', 'ORGANISME', 'AUTRE'];

function mapCounterparty(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    name: row.name,
    type: row.type,
    contactName: row.contact_name,
    phone: row.phone,
    email: row.email,
    accountInfo: row.account_info,
    notes: row.notes,
    isActive: Boolean(row.is_active),
    chequeCount: row.cheque_count === undefined ? undefined : Number(row.cheque_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listCounterparties(db, ctx, options = {}) {
  assertPermission(ctx, 'counterparties.view');
  const ids = resolveCompanyScope(ctx, options.companyIds);
  if (!ids.length) return [];
  const params = [...ids];
  let where = `p.company_id IN (${ids.map(() => '?').join(',')})`;
  if (options.companyId) {
    assertCompanyAccess(ctx, options.companyId);
    where += ' AND p.company_id = ?';
    params.push(Number(options.companyId));
  }
  if (options.search) {
    where += ' AND (p.name LIKE ? OR p.phone LIKE ? OR p.email LIKE ?)';
    const like = `%${String(options.search).slice(0, 80)}%`;
    params.push(like, like, like);
  }
  if (options.includeInactive === false) where += ' AND p.is_active = 1';
  return db
    .prepare(
      `SELECT p.*, c.name AS company_name,
        (SELECT COUNT(*) FROM cheques ch WHERE ch.counterparty_id = p.id AND ch.is_archived = 0) AS cheque_count
       FROM counterparties p JOIN companies c ON c.id = p.company_id
       WHERE ${where} ORDER BY p.name`
    )
    .all(...params)
    .map(mapCounterparty);
}

function validateType(value) {
  const type = String(value || 'AUTRE').toUpperCase();
  if (!TYPES.includes(type)) throw validationError('Type de contrepartie invalide');
  return type;
}

function createCounterparty(db, ctx, input) {
  assertPermission(ctx, 'counterparties.manage');
  assertCompanyAccess(ctx, input.companyId);
  const name = requiredText(input.name, 'Nom de la contrepartie', 160);
  const type = validateType(input.type);
  try {
    const id = db.transaction(() => {
      const newId = Number(
        db
          .prepare(
            `INSERT INTO counterparties(company_id,name,type,contact_name,phone,email,account_info,notes)
             VALUES (?,?,?,?,?,?,?,?)`
          )
          .run(
            Number(input.companyId),
            name,
            type,
            text(input.contactName, 'Contact', { max: 120 }),
            text(input.phone, 'Téléphone', { max: 40 }),
            text(input.email, 'E-mail', { max: 160 }),
            text(input.accountInfo, 'Informations bancaires', { max: 300 }),
            text(input.notes, 'Notes', { max: 1000 })
          ).lastInsertRowid
      );
      appendAudit(db, ctx, {
        companyId: Number(input.companyId),
        entityType: 'CONTREPARTIE',
        entityId: newId,
        action: 'COUNTERPARTY_CREATE',
        after: { name, type },
        reason: 'Création d’une contrepartie',
      });
      return newId;
    }).immediate();
    return mapCounterparty(
      db
        .prepare('SELECT p.*, c.name AS company_name FROM counterparties p JOIN companies c ON c.id = p.company_id WHERE p.id = ?')
        .get(id)
    );
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new AppError('CONFLICT', 'Une contrepartie porte déjà ce nom dans cette société');
    throw err;
  }
}

function updateCounterparty(db, ctx, input) {
  assertPermission(ctx, 'counterparties.manage');
  const current = db.prepare('SELECT * FROM counterparties WHERE id = ?').get(Number(input.id));
  if (!current) throw notFound('Contrepartie');
  assertCompanyAccess(ctx, current.company_id);
  if (input.companyId !== undefined && Number(input.companyId) !== current.company_id) {
    throw forbidden('Le rattachement d’une contrepartie à une société est immuable');
  }
  const name = input.name === undefined ? current.name : requiredText(input.name, 'Nom', 160);
  const type = input.type === undefined ? current.type : validateType(input.type);
  const isActive = input.isActive === undefined ? Boolean(current.is_active) : Boolean(input.isActive);
  try {
    return db.transaction(() => {
      db.prepare(
        `UPDATE counterparties SET name=?, type=?, contact_name=?, phone=?, email=?, account_info=?, notes=?, is_active=?, updated_at=?
         WHERE id=?`
      ).run(
        name,
        type,
        input.contactName === undefined ? current.contact_name : text(input.contactName, 'Contact', { max: 120 }),
        input.phone === undefined ? current.phone : text(input.phone, 'Téléphone', { max: 40 }),
        input.email === undefined ? current.email : text(input.email, 'E-mail', { max: 160 }),
        input.accountInfo === undefined ? current.account_info : text(input.accountInfo, 'Informations bancaires', { max: 300 }),
        input.notes === undefined ? current.notes : text(input.notes, 'Notes', { max: 1000 }),
        isActive ? 1 : 0,
        new Date().toISOString(),
        current.id
      );
      appendAudit(db, ctx, {
        companyId: current.company_id,
        entityType: 'CONTREPARTIE',
        entityId: current.id,
        action: 'COUNTERPARTY_UPDATE',
        before: mapCounterparty(current),
        after: { name, type, isActive },
        reason: input.reason || 'Modification d’une contrepartie',
      });
      return { ok: true };
    }).immediate();
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new AppError('CONFLICT', 'Une contrepartie porte déjà ce nom dans cette société');
    throw err;
  }
}

module.exports = { listCounterparties, createCounterparty, updateCounterparty, TYPES };
