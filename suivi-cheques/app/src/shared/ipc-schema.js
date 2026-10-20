'use strict';

/**
 * Contrat IPC : liste fermée des méthodes autorisées + validation de l'enveloppe
 * et des charges utiles critiques. Aucune méthode ne prend de SQL, de chemin de
 * fichier, de commande shell ou de fonction : uniquement des données JSON.
 */
const { z } = require('zod');

const METHODS = Object.freeze([
  'app.bootstrap',
  'app.health',
  'app.about',
  'auth.setup',
  'auth.login',
  'auth.logout',
  'auth.me',
  'auth.lock',
  'auth.changePassword',
  'users.list',
  'users.create',
  'users.update',
  'users.resetPassword',
  'users.unlock',
  'roles.catalog',
  'companies.list',
  'companies.get',
  'companies.options',
  'companies.create',
  'companies.update',
  'companies.deactivate',
  'banks.list',
  'banks.create',
  'banks.update',
  'accounts.list',
  'accounts.options',
  'accounts.create',
  'accounts.update',
  'counterparties.list',
  'counterparties.create',
  'counterparties.update',
  'books.list',
  'books.create',
  'books.update',
  'books.lowStock',
  'cheques.list',
  'cheques.get',
  'cheques.create',
  'cheques.update',
  'cheques.changeStatus',
  'cheques.cancel',
  'cheques.duplicates',
  'cheques.managers',
  'cheques.filters',
  'cheques.history',
  'approvals.list',
  'approvals.get',
  'approvals.pendingCount',
  'approvals.decide',
  'approvals.cancel',
  'transactions.list',
  'transactions.create',
  'transactions.transfer',
  'transactions.peers',
  'transactions.options',
  'finance.dashboard',
  'finance.accounts',
  'finance.comparison',
  'finance.cashflow',
  'finance.transfers',
  'imports.stage',
  'imports.preview',
  'imports.analyze',
  'imports.commit',
  'imports.manualBalance',
  'imports.list',
  'imports.detail',
  'reconciliation.list',
  'reconciliation.auto',
  'reconciliation.get',
  'reconciliation.candidates',
  'reconciliation.propose',
  'reconciliation.reject',
  'reconciliation.confirm',
  'reconciliation.report',
  'reconciliation.recompute',
  'documents.list',
  'documents.add',
  'documents.delete',
  'documents.open',
  'documents.saveAs',
  'backups.list',
  'backups.create',
  'backups.verify',
  'backups.previewRestore',
  'backups.restore',
  'backups.autoStatus',
  'reports.catalogue',
  'reports.data',
  'reports.export',
  'audit.list',
  'audit.export',
  'settings.get',
  'settings.update',
  'notifications.list',
  'notifications.unreadCount',
  'notifications.markRead',
  'migration.analyze',
  'migration.analyzeFile',
  'migration.analyse',
  'migration.commit',
  'migration.history',
]);

const METHOD_SET = new Set(METHODS);

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafeValue(value, depth = 0) {
  if (depth > 6) throw new Error('Charge utile trop profonde');
  if (value === null || value === undefined) return;
  const type = typeof value;
  if (type === 'string') {
    if (value.length > 500_000) throw new Error('Chaîne trop longue');
    return;
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new Error('Nombre non fini');
    return;
  }
  if (type === 'boolean') return;
  if (Array.isArray(value)) {
    if (value.length > 20_000) throw new Error('Tableau trop long');
    for (const item of value) assertSafeValue(item, depth + 1);
    return;
  }
  if (type === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error('Objet non autorisé');
    const keys = Object.keys(value);
    if (keys.length > 200) throw new Error('Trop de propriétés');
    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key)) throw new Error('Propriété interdite');
      assertSafeValue(value[key], depth + 1);
    }
    return;
  }
  throw new Error('Type de donnée non autorisé');
}

const envelope = z
  .object({
    method: z.string().min(3).max(80),
    params: z.record(z.string(), z.unknown()).default({}),
    requestId: z.string().max(80).optional(),
  })
  .strict();

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ attendue');
const cents = z.number().int().min(-9_000_000_000_000).max(9_000_000_000_000);
const shortText = z.string().max(300);
const longText = z.string().max(5000);

const nonEmpty = z.string().trim().min(1).max(200);

const schemas = {
  'auth.setup': z
    .object({
      orgName: z.string().trim().min(2).max(120),
      dg: z.object({
        username: z.string().min(3).max(40),
        fullName: z.string().trim().min(2).max(120),
        password: z.string().min(12).max(200),
        email: z.string().max(160).optional(),
      }),
      admin: z.object({
        username: z.string().min(3).max(40),
        fullName: z.string().trim().min(2).max(120),
        password: z.string().min(12).max(200),
        email: z.string().max(160).optional(),
      }),
      company: z
        .object({
          code: z.string().min(2).max(20),
          name: z.string().trim().min(2).max(200),
          legalForm: z.string().max(40).optional(),
          nif: z.string().max(40).optional(),
        })
        .optional(),
    })
    .strict(),
  'auth.login': z.object({ username: z.string().min(1).max(80), password: z.string().min(1).max(200) }).strict(),
  'auth.changePassword': z
    .object({
      currentPassword: z.string().min(1).max(200),
      newPassword: z.string().min(12).max(200),
    })
    .strict(),
  'users.create': z
    .object({
      username: z.string().min(3).max(40),
      fullName: z.string().min(2).max(120),
      email: z.string().max(160).optional().nullable(),
      role: z.enum(['DG', 'RESPONSABLE', 'ADMIN']),
      companyIds: z.array(id).max(100).optional(),
      password: z.string().min(12).max(200),
      mustChangePassword: z.boolean().optional(),
    })
    .strict(),
  'users.update': z
    .object({
      id,
      fullName: z.string().min(2).max(120).optional(),
      email: z.string().max(160).nullable().optional(),
      role: z.enum(['DG', 'RESPONSABLE', 'ADMIN']).optional(),
      isActive: z.boolean().optional(),
      companyIds: z.array(id).max(100).optional(),
    })
    .strict(),
  'users.resetPassword': z.object({ id, newPassword: z.string().min(12).max(200).optional() }).strict(),
  'users.unlock': z.object({ id }).strict(),
  'cheques.create': z
    .object({
      companyId: id,
      accountId: id,
      direction: z.enum(['RECU', 'EMIS']),
      chequeNumber: nonEmpty,
      chequeType: z.string().max(40).optional(),
      counterpartyId: id.optional().nullable(),
      partyName: z.string().max(200).optional(),
      amountCents: cents.refine((v) => v > 0, 'Montant positif requis'),
      issueDate: date,
      receiptDate: date.optional().nullable(),
      dueDate: date,
      depositDate: date.optional().nullable(),
      notes: longText.optional().nullable(),
      duplicateOverrideReason: z.string().min(10).max(300).optional().nullable(),
      bookId: id.optional().nullable(),
    })
    .strict(),
  'cheques.update': z
    .object({
      id,
      version: z.number().int().positive().optional(),
      changes: z.record(z.string(), z.unknown()),
      reason: z.string().max(500).optional(),
    })
    .strict(),
  'cheques.changeStatus': z
    .object({
      id,
      to: z.string().min(2).max(30),
      eventDate: date.optional(),
      date: date.optional(),
      reason: z.string().max(500).optional(),
      endorsee: z.string().max(160).optional(),
      version: z.number().int().positive().optional(),
    })
    .strict(),
  'cheques.cancel': z.object({ id, reason: z.string().min(3).max(500) }).strict(),
  'approvals.decide': z
    .object({ id, decision: z.enum(['APPROVED', 'REJECTED']), reason: z.string().max(500).optional() })
    .strict(),
  'approvals.cancel': z.object({ id, reason: z.string().max(500).optional() }).strict(),
  'transactions.create': z
    .object({
      accountId: id,
      type: z.string().min(2).max(40),
      amountCents: cents.refine((v) => v > 0),
      effectiveDate: date.optional(),
      date: date.optional(),
      description: z.string().max(500).optional(),
      counterpartyId: id.optional().nullable(),
      reason: z.string().max(500).optional(),
    })
    .strict(),
  'transactions.transfer': z
    .object({
      accountId: id,
      toAccountId: id,
      amountCents: cents.refine((v) => v > 0),
      effectiveDate: date.optional(),
      date: date.optional(),
      description: z.string().max(500).optional(),
    })
    .strict(),
  'imports.analyze': z
    .object({
      token: z.string().uuid(),
      accountId: id,
      mapping: z.record(z.string(), z.unknown()),
      options: z.record(z.string(), z.unknown()).optional(),
      statementDate: date.optional(),
      closingBalance: z.union([z.string(), z.number()]).optional(),
    })
    .passthrough(),
  'imports.commit': z
    .object({
      batchId: z.string().uuid(),
      accountId: id,
      statementDate: date,
      closingBalance: z.union([z.string(), z.number(), z.null()]).optional(),
      allowPartial: z.boolean().optional(),
      reason: z.string().max(500).optional(),
    })
    .strict(),
  'imports.manualBalance': z
    .object({ accountId: id, statementDate: date, closingBalanceCents: cents, reason: shortText })
    .strict(),
  'reconciliation.get': z.object({ transactionId: id }).strict(),
  'reconciliation.candidates': z.object({ transactionId: id }).strict(),
  'reconciliation.propose': z
    .object({ transactionId: id, chequeId: id, reason: z.string().max(500).optional() })
    .strict(),
  'reconciliation.reject': z.object({ matchId: id, reason: z.string().min(3).max(500) }).strict(),
  'reconciliation.confirm': z
    .object({
      matchId: id,
      reason: z.string().max(500).optional(),
      settleCheque: z.boolean().optional(),
      settlementDate: date.optional(),
      depositDate: date.optional(),
    })
    .strict(),
  'reconciliation.recompute': z.object({ transactionId: id }).strict(),
  'documents.add': z
    .object({
      companyId: id,
      entityType: z.enum(['CHEQUE', 'COMPTE', 'SOCIETE', 'TRANSACTION', 'RAPPROCHEMENT', 'IMPORT']),
      entityId: z.union([id, z.string().max(80)]),
      reason: z.string().max(300).optional(),
    })
    .strict(),
  'documents.delete': z.object({ id, reason: z.string().min(3).max(300) }).strict(),
  'documents.open': z.object({ id }).strict(),
  'documents.saveAs': z.object({ id }).strict(),
  'backups.verify': z.object({ id }).strict(),
  'backups.previewRestore': z.object({ id }).strict(),
  'backups.restore': z
    .object({
      id,
      confirmation: z.literal('RESTAURER'),
      password: z.string().min(1).max(200),
    })
    .strict(),
  'reports.data': z.object({ type: z.string().min(2).max(60) }).passthrough(),
  'reports.export': z
    .object({
      type: z.string().min(2).max(60),
      format: z.enum(['CSV', 'XLSX', 'PDF']),
      pdfMaxRows: z.number().int().min(10).max(20_000).optional(),
    })
    .passthrough(),
  'migration.analyze': z
    .object({ rawText: z.string().min(2).max(20_000_000), sourceName: z.string().max(200).optional() })
    .strict(),
  'migration.analyzeFile': z.object({}).strict(),
  'migration.commit': z
    .object({
      token: z.string().uuid(),
      confirmation: z.literal('MIGRER'),
      skipInvalid: z.boolean().optional(),
      allowDemoData: z.boolean().optional(),
    })
    .strict(),
  'settings.update': z
    .object({ changes: z.record(z.string(), z.unknown()), reason: z.string().max(300).optional() })
    .strict(),
  'notifications.markRead': z
    .object({ id: id.optional(), ids: z.array(id).max(500).optional(), all: z.boolean().optional() })
    .strict(),

  // --- Référentiel : sociétés, banques, comptes, contreparties, chéquiers ---
  'companies.create': z
    .object({
      code: z.string().trim().min(2).max(20),
      name: z.string().trim().min(2).max(200),
      legalForm: z.string().max(40).optional(),
      nif: z.string().max(40).optional(),
      nis: z.string().max(40).optional(),
      rc: z.string().max(40).optional(),
      ai: z.string().max(40).optional(),
      managerName: z.string().max(120).optional(),
      capitalCents: z.number().int().min(0).optional(),
      address: z.string().max(300).optional(),
      wilaya: z.string().max(80).optional(),
      phone: z.string().max(40).optional(),
      email: z.string().max(160).optional(),
      color: z.string().max(20).optional(),
    })
    .strict(),
  'companies.update': z
    .object({
      id,
      code: z.string().trim().min(2).max(20).optional(),
      name: z.string().trim().min(2).max(200).optional(),
      legalForm: z.string().max(40).optional(),
      nif: z.string().max(40).optional(),
      nis: z.string().max(40).optional(),
      rc: z.string().max(40).optional(),
      ai: z.string().max(40).optional(),
      managerName: z.string().max(120).optional(),
      capitalCents: z.number().int().min(0).optional(),
      address: z.string().max(300).optional(),
      wilaya: z.string().max(80).optional(),
      phone: z.string().max(40).optional(),
      email: z.string().max(160).optional(),
      color: z.string().max(20).optional(),
      isActive: z.boolean().optional(),
      reason: z.string().max(300).optional(),
    })
    .strict(),
  'companies.deactivate': z.object({ id, reason: z.string().max(300).optional() }).strict(),
  'banks.create': z.object({ name: z.string().trim().min(2).max(120), shortName: z.string().max(60).optional() }).strict(),
  'banks.update': z
    .object({
      id,
      name: z.string().trim().min(2).max(120).optional(),
      shortName: z.string().max(60).optional(),
      isActive: z.boolean().optional(),
      reason: z.string().max(300).optional(),
    })
    .strict(),
  'accounts.create': z
    .object({
      companyId: id,
      bankId: id,
      label: z.string().trim().min(2).max(120),
      accountNumber: z.string().trim().min(2).max(60),
      rib: z.string().max(60).optional(),
      currency: z.string().max(8).optional(),
      openingBalanceCents: z.number().int().optional(),
      openingDate: date,
    })
    .strict(),
  'accounts.update': z
    .object({
      id,
      label: z.string().trim().min(2).max(120).optional(),
      accountNumber: z.string().trim().min(2).max(60).optional(),
      rib: z.string().max(60).optional(),
      currency: z.string().max(8).optional(),
      openingBalanceCents: z.number().int().optional(),
      openingDate: date.optional(),
      isActive: z.boolean().optional(),
      reason: z.string().max(300).optional(),
    })
    .strict(),
  'counterparties.create': z
    .object({
      companyId: id,
      name: z.string().trim().min(2).max(160),
      type: z.string().max(30).optional(),
      contactName: z.string().max(120).optional(),
      phone: z.string().max(40).optional(),
      email: z.string().max(160).optional(),
      accountInfo: z.string().max(300).optional(),
      notes: z.string().max(1000).optional(),
    })
    .strict(),
  'counterparties.update': z
    .object({
      id,
      name: z.string().trim().min(2).max(160).optional(),
      type: z.string().max(30).optional(),
      contactName: z.string().max(120).optional(),
      phone: z.string().max(40).optional(),
      email: z.string().max(160).optional(),
      accountInfo: z.string().max(300).optional(),
      notes: z.string().max(1000).optional(),
      isActive: z.boolean().optional(),
      reason: z.string().max(300).optional(),
    })
    .strict(),
  'books.create': z
    .object({
      accountId: id,
      fromNumber: z.union([z.string(), z.number()]),
      toNumber: z.union([z.string(), z.number()]),
      label: z.string().max(80).optional(),
    })
    .strict(),
  'books.update': z
    .object({
      id,
      fromNumber: z.union([z.string(), z.number()]).optional(),
      toNumber: z.union([z.string(), z.number()]).optional(),
      label: z.string().max(80).optional(),
      isActive: z.boolean().optional(),
      reason: z.string().max(300).optional(),
    })
    .strict(),

  // --- Lectures : objets de filtres bornés ---
  'companies.get': z.object({ id }).strict(),
  'cheques.get': z.object({ id }).strict(),
  'cheques.history': z.object({ id }).strict(),
  'cheques.managers': z.object({ companyId: id.optional() }).strict(),
  'cheques.filters': z.object({ companyId: id.optional() }).strict(),
  'cheques.duplicates': z
    .object({
      companyId: id,
      direction: z.enum(['RECU', 'EMIS']),
      chequeNumber: z.string().trim().min(1).max(40),
      accountId: id.optional().nullable(),
      excludeId: id.optional().nullable(),
    })
    .strict(),
  'approvals.get': z.object({ id }).strict(),
  'accounts.options': z.object({ companyId: id.optional() }).passthrough(),
  'imports.detail': z.object({ id }).strict(),
  'documents.list': z.record(z.string(), z.unknown()),
  'audit.list': z.record(z.string(), z.unknown()),
  'audit.export': z.record(z.string(), z.unknown()),
  'finance.dashboard': z.record(z.string(), z.unknown()),
  'finance.accounts': z.record(z.string(), z.unknown()),
  'finance.comparison': z.record(z.string(), z.unknown()),
  'finance.cashflow': z.record(z.string(), z.unknown()),
  'finance.transfers': z.record(z.string(), z.unknown()),
  'reconciliation.list': z.record(z.string(), z.unknown()),
  'reconciliation.report': z.record(z.string(), z.unknown()),
  'transactions.list': z.record(z.string(), z.unknown()),
  'transactions.options': z.record(z.string(), z.unknown()),
  'users.list': z.object({}).strict(),
  'roles.catalog': z.object({}).strict(),
  'settings.get': z.object({}).strict(),
  'reports.catalogue': z.object({}).strict(),
  'backups.list': z.object({}).strict(),
  'backups.autoStatus': z.object({}).strict(),
  'notifications.list': z.record(z.string(), z.unknown()),
  'notifications.unreadCount': z.object({}).strict(),
  'migration.history': z.object({}).strict(),
};

function validatePayload(raw) {
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: 'Requête IPC invalide', details: parsed.error.issues.slice(0, 5) };
  }
  const { method, params, requestId } = parsed.data;
  if (!METHOD_SET.has(method)) return { ok: false, message: `Méthode IPC inconnue : ${method}` };
  try {
    assertSafeValue(params);
  } catch (err) {
    return { ok: false, message: `Paramètres refusés : ${err.message}` };
  }
  const schema = schemas[method];
  if (schema) {
    const check = schema.safeParse(params);
    if (!check.success) {
      return {
        ok: false,
        message: 'Paramètres invalides',
        details: check.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    }
  }
  return { ok: true, method, params, requestId: requestId || null };
}

module.exports = { METHODS, METHOD_SET, validatePayload, assertSafeValue, schemas };
