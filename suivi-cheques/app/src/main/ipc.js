'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validatePayload, METHODS } = require('../shared/ipc-schema');
const { AppError } = require('./services/authorization');
const { getSetting, getAllSettings, updateSettings, DEFINITIONS } = require('./services/settings');
const { dbHealth } = require('./db');
const auth = require('./services/auth');
const companies = require('./services/companies');
const accounts = require('./services/accounts');
const counterparties = require('./services/counterparties');
const books = require('./services/books');
const cheques = require('./services/cheques');
const approvals = require('./services/approvals');
const transactions = require('./services/transactions');
const finance = require('./services/finance');
const imports = require('./services/imports');
const reconciliation = require('./services/reconciliation');
const attachments = require('./services/attachments');
const backups = require('./services/backups');
const reports = require('./services/reports');
const audit = require('./services/audit');
const notifications = require('./services/notifications');
const migration = require('./services/migration');
const { ROLE_PERMISSIONS, ROLES, PERMISSIONS } = require('../shared/permissions');
const { buildCsv } = require('../shared/csv');

const APP_VERSION = require('../../package.json').version;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function senderKey(event) {
  return String((event && event.sender && event.sender.id) || 'test-sender');
}

function toErrorPayload(err) {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, details: err.details || null };
  }
  const code = err && err.code && String(err.code).startsWith('SQLITE') ? 'DATABASE' : 'INTERNAL';
  return {
    code,
    message:
      code === 'DATABASE'
        ? 'Erreur de base de données. L’opération a été annulée ; consultez le journal.'
        : 'Erreur interne. L’opération a été annulée.',
    details: null,
  };
}

function createDispatcher({ getDb, paths, runtime = {} }) {
  const sessions = new Map();
  const idleLimit = () => {
    try {
      return Number(getSetting(getDb(), 'session.idle_timeout_minutes', 15));
    } catch {
      return 15;
    }
  };

  function idleSeconds() {
    if (typeof runtime.getIdleSeconds !== 'function') return 0;
    try {
      const value = Number(runtime.getIdleSeconds());
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  function revoke(event, reason) {
    const key = senderKey(event);
    const sessionId = sessions.get(key);
    sessions.delete(key);
    if (!sessionId) return;
    try {
      getDb()
        .prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL")
        .run(new Date().toISOString(), reason, sessionId);
    } catch {
      /* base peut être fermée pendant une restauration */
    }
  }

  function sessionContext(event, { touch = true } = {}) {
    const sessionId = sessions.get(senderKey(event));
    if (!sessionId) throw new AppError('UNAUTHORIZED', 'Connexion requise');
    const db = getDb();
    const row = db.prepare('SELECT idle_timeout_minutes FROM sessions WHERE id = ?').get(sessionId);
    if (!row) throw new AppError('UNAUTHORIZED', 'Session expirée');
    const limit = Number(row.idle_timeout_minutes) > 0 ? Number(row.idle_timeout_minutes) : idleLimit();
    if (idleSeconds() > limit * 60) {
      revoke(event, 'EXPIRED_SYSTEM_IDLE');
      throw new AppError('SESSION_EXPIRED', 'Session verrouillée après inactivité de l’ordinateur. Reconnectez-vous.');
    }
    const ctx = touch ? auth.touchSession(db, sessionId) : auth.sessionContextNoTouch(db, sessionId);
    return ctx;
  }

  function publicCtx(ctx) {
    const pub = auth.publicContext(ctx);
    delete pub.sessionId;
    return pub;
  }

  const handlers = {};

  handlers['app.bootstrap'] = () => {
    const db = getDb();
    return {
      ...auth.bootstrap(db),
      version: APP_VERSION,
      baseCurrency: getSetting(db, 'app.base_currency', 'DZD'),
      serverTime: new Date().toISOString(),
    };
  };

  handlers['app.about'] = () => ({
    name: 'Suivi des Chèques',
    version: APP_VERSION,
    storage: 'SQLite local chiffré par les droits du système de fichiers',
    electron: process.versions.electron || null,
    node: process.versions.node,
    chrome: process.versions.chrome || null,
  });

  handlers['app.health'] = (env) => {
    const ctx = sessionContext(env.event);
    if (!['DG', 'ADMIN'].includes(ctx.user.role)) throw new AppError('FORBIDDEN', 'Réservé à la direction et à l’administration');
    const db = getDb();
    const health = dbHealth(db);
    return {
      ...health,
      schemaVersion: db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v,
      journalMode: db.pragma('journal_mode', { simple: true }),
      foreignKeys: db.pragma('foreign_keys', { simple: true }),
    };
  };

  handlers['auth.setup'] = (env) => {
    const result = auth.setup(getDb(), env.params);
    return { ok: true, ...result };
  };

  handlers['auth.login'] = (env) => {
    const db = getDb();
    const result = auth.login(db, env.params.username, env.params.password);
    sessions.set(senderKey(env.event), result.sessionId);
    const ctx = auth.touchSession(db, result.sessionId);
    const pub = publicCtx(ctx);
    if (result.user && result.user.mustChangePassword) {
      pub.mustChangePassword = true;
    }
    return pub;
  };

  handlers['auth.me'] = (env) => {
    if (!sessions.has(senderKey(env.event))) return { authenticated: false };
    try {
      const ctx = sessionContext(env.event, { touch: false });
      return { authenticated: true, ...publicCtx(ctx) };
    } catch (err) {
      if (err.code === 'SESSION_EXPIRED' || err.code === 'UNAUTHORIZED') {
        revoke(env.event, 'EXPIRED');
        return { authenticated: false, reason: err.message };
      }
      throw err;
    }
  };

  handlers['auth.logout'] = (env) => {
    const key = senderKey(env.event);
    if (sessions.has(key)) {
      try {
        const ctx = sessionContext(env.event);
        auth.logout(getDb(), ctx);
      } catch {
        /* session déjà invalide */
      }
    }
    sessions.delete(key);
    return { ok: true };
  };

  handlers['auth.lock'] = (env) => {
    revoke(env.event, 'LOCKED_BY_USER');
    return { ok: true };
  };

  handlers['auth.changePassword'] = (env) =>
    auth.changePassword(getDb(), sessionContext(env.event), env.params);

  handlers['users.list'] = (env) => auth.listUsers(getDb(), sessionContext(env.event));
  handlers['users.create'] = (env) =>
    auth.createUser(getDb(), sessionContext(env.event), {
      ...env.params,
      mustChangePassword: env.params.mustChangePassword !== false,
    });
  handlers['users.update'] = (env) => auth.updateUser(getDb(), sessionContext(env.event), env.params);
  handlers['users.resetPassword'] = (env) => auth.resetPassword(getDb(), sessionContext(env.event), env.params);
  handlers['users.unlock'] = (env) => auth.unlockUser(getDb(), sessionContext(env.event), env.params);
  handlers['roles.catalog'] = () => ({
    roles: Object.values(ROLES).map((r) => ({ ...r, permissions: [...ROLE_PERMISSIONS[r.code]] })),
    permissions: PERMISSIONS,
  });

  handlers['companies.list'] = (env) => companies.listCompanies(getDb(), sessionContext(env.event), env.params);
  handlers['companies.get'] = (env) => companies.getCompanyDetail(getDb(), sessionContext(env.event), env.params.id);
  handlers['companies.options'] = (env) => companies.companyOptions(getDb(), sessionContext(env.event));
  handlers['companies.create'] = (env) => companies.createCompany(getDb(), sessionContext(env.event), env.params);
  handlers['companies.update'] = (env) => companies.updateCompany(getDb(), sessionContext(env.event), env.params);
  handlers['companies.deactivate'] = (env) =>
    companies.deactivateCompany(getDb(), sessionContext(env.event), env.params.id, env.params.reason);

  handlers['banks.list'] = (env) => accounts.listBanks(getDb(), sessionContext(env.event), env.params);
  handlers['banks.create'] = (env) => accounts.createBank(getDb(), sessionContext(env.event), env.params);
  handlers['banks.update'] = (env) => accounts.updateBank(getDb(), sessionContext(env.event), env.params);
  handlers['accounts.list'] = (env) => accounts.listAccounts(getDb(), sessionContext(env.event), env.params);
  handlers['accounts.options'] = (env) => accounts.accountOptions(getDb(), sessionContext(env.event), env.params);
  handlers['accounts.create'] = (env) => accounts.createAccount(getDb(), sessionContext(env.event), env.params);
  handlers['accounts.update'] = (env) => accounts.updateAccount(getDb(), sessionContext(env.event), env.params);

  handlers['counterparties.list'] = (env) =>
    counterparties.listCounterparties(getDb(), sessionContext(env.event), env.params);
  handlers['counterparties.create'] = (env) =>
    counterparties.createCounterparty(getDb(), sessionContext(env.event), env.params);
  handlers['counterparties.update'] = (env) =>
    counterparties.updateCounterparty(getDb(), sessionContext(env.event), env.params);

  handlers['books.list'] = (env) => books.listBooks(getDb(), sessionContext(env.event), env.params);
  handlers['books.create'] = (env) => books.createBook(getDb(), sessionContext(env.event), env.params);
  handlers['books.update'] = (env) => books.updateBook(getDb(), sessionContext(env.event), env.params);
  handlers['books.lowStock'] = (env) => books.lowStockBooks(getDb(), sessionContext(env.event));

  handlers['cheques.list'] = (env) => cheques.listCheques(getDb(), sessionContext(env.event), env.params);
  handlers['cheques.get'] = (env) => cheques.getCheque(getDb(), sessionContext(env.event), env.params.id);
  handlers['cheques.create'] = (env) => cheques.createCheque(getDb(), sessionContext(env.event), env.params);
  handlers['cheques.update'] = (env) => cheques.updateCheque(getDb(), sessionContext(env.event), env.params);
  handlers['cheques.changeStatus'] = (env) => cheques.changeStatus(getDb(), sessionContext(env.event), env.params);
  handlers['cheques.cancel'] = (env) => cheques.cancelCheque(getDb(), sessionContext(env.event), env.params);
  handlers['cheques.duplicates'] = (env) => cheques.checkDuplicates(getDb(), sessionContext(env.event), env.params);
  handlers['cheques.managers'] = (env) => cheques.listManagers(getDb(), sessionContext(env.event), env.params.companyId);
  handlers['cheques.filters'] = (env) =>
    cheques.chequeFilterOptions(getDb(), sessionContext(env.event), env.params.companyId);
  handlers['cheques.history'] = (env) =>
    cheques.listChequeEvents(getDb(), sessionContext(env.event), env.params.id);

  handlers['approvals.list'] = (env) => approvals.listRequests(getDb(), sessionContext(env.event), env.params);
  handlers['approvals.get'] = (env) => approvals.getRequest(getDb(), sessionContext(env.event), env.params.id);
  handlers['approvals.pendingCount'] = (env) => approvals.pendingCount(getDb(), sessionContext(env.event));
  handlers['approvals.decide'] = (env) => approvals.decide(getDb(), sessionContext(env.event), env.params);
  handlers['approvals.cancel'] = (env) => approvals.cancelRequest(getDb(), sessionContext(env.event), env.params);

  handlers['transactions.list'] = (env) => transactions.listTransactions(getDb(), sessionContext(env.event), env.params);
  handlers['transactions.create'] = (env) =>
    transactions.createTransaction(getDb(), sessionContext(env.event), env.params);
  handlers['transactions.transfer'] = (env) =>
    transactions.createTransfer(getDb(), sessionContext(env.event), env.params);
  handlers['transactions.peers'] = (env) =>
    transactions.listTransferPeers(getDb(), sessionContext(env.event), env.params.accountId);
  handlers['transactions.options'] = (env) => transactions.transactionOptions(getDb(), sessionContext(env.event));

  handlers['finance.dashboard'] = (env) => finance.getDashboard(getDb(), sessionContext(env.event), env.params);
  handlers['finance.accounts'] = (env) => finance.getAccountBalances(getDb(), sessionContext(env.event), env.params);
  handlers['finance.comparison'] = (env) => finance.companyComparison(getDb(), sessionContext(env.event), env.params);
  handlers['finance.cashflow'] = (env) => finance.cashFlow(getDb(), sessionContext(env.event), env.params);
  handlers['finance.transfers'] = (env) => finance.transferSummary(getDb(), sessionContext(env.event), env.params);

  handlers['imports.stage'] = async (env) => {
    const ctx = sessionContext(env.event);
    const picked = await runtime.pickOpenFile({
      title: 'Sélectionner un relevé bancaire',
      filters: [{ name: 'Relevés bancaires', extensions: ['csv', 'xlsx'] }],
    });
    if (!picked) return { canceled: true };
    if (picked.size > imports.MAX_FILE_BYTES) {
      throw new AppError('VALIDATION', 'Fichier trop volumineux (15 Mo maximum)');
    }
    const buffer = fs.readFileSync(picked.path);
    return imports.stageUploadedFile(ctx, { filename: path.basename(picked.path), buffer });
  };
  handlers['imports.preview'] = (env) => imports.previewImport(getDb(), sessionContext(env.event), env.params);
  handlers['imports.analyze'] = (env) => imports.analyzeImport(getDb(), sessionContext(env.event), env.params);
  handlers['imports.commit'] = (env) => imports.commitImport(getDb(), sessionContext(env.event), env.params);
  handlers['imports.manualBalance'] = (env) =>
    imports.setManualBalance(getDb(), sessionContext(env.event), env.params);
  handlers['imports.list'] = (env) => imports.listImports(getDb(), sessionContext(env.event), env.params);
  handlers['imports.detail'] = (env) => imports.getImportDetail(getDb(), sessionContext(env.event), env.params.id);

  handlers['reconciliation.list'] = (env) =>
    reconciliation.listBankTransactions(getDb(), sessionContext(env.event), env.params);
  handlers['reconciliation.auto'] = (env) =>
    reconciliation.autoProposeForTransactions(getDb(), sessionContext(env.event), env.params.transactionIds);
  handlers['reconciliation.get'] = (env) =>
    reconciliation.getBankTransaction(getDb(), sessionContext(env.event), env.params.transactionId);
  handlers['reconciliation.candidates'] = (env) =>
    reconciliation.listMatchCandidates(getDb(), sessionContext(env.event), env.params.transactionId);
  handlers['reconciliation.propose'] = (env) =>
    reconciliation.proposeMatch(getDb(), sessionContext(env.event), env.params);
  handlers['reconciliation.reject'] = (env) =>
    reconciliation.rejectMatch(getDb(), sessionContext(env.event), env.params);
  handlers['reconciliation.confirm'] = (env) =>
    reconciliation.confirmMatch(getDb(), sessionContext(env.event), env.params);
  handlers['reconciliation.report'] = (env) =>
    reconciliation.reconciliationReport(getDb(), sessionContext(env.event), env.params);
  handlers['reconciliation.recompute'] = (env) => {
    const ctx = sessionContext(env.event);
    if (!ctx.permissions.has('reconciliation.match')) {
      throw new AppError('FORBIDDEN', 'Permission requise : reconciliation.match');
    }
    return reconciliation.recomputeTransactionStatus(getDb(), env.params.transactionId);
  };

  handlers['documents.list'] = (env) => attachments.listAttachments(getDb(), sessionContext(env.event), env.params);
  handlers['documents.add'] = async (env) => {
    const ctx = sessionContext(env.event);
    const picked = await runtime.pickOpenFile({
      title: 'Ajouter un document justificatif',
      filters: [{ name: 'Documents', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'xlsx', 'csv', 'txt'] }],
    });
    if (!picked) return { canceled: true };
    return attachments.addAttachment(getDb(), ctx, {
      companyId: env.params.companyId,
      entityType: env.params.entityType,
      entityId: env.params.entityId,
      sourcePath: picked.path,
      originalName: path.basename(picked.path),
      attachmentsDir: paths.attachmentsDir,
      reason: env.params.reason,
    });
  };
  handlers['documents.delete'] = (env) =>
    attachments.deleteAttachment(getDb(), sessionContext(env.event), env.params.id, env.params.reason);
  handlers['documents.open'] = async (env) => {
    const db = getDb();
    const file = attachments.attachmentPath(db, sessionContext(env.event), env.params.id, paths.attachmentsDir);
    const result = await runtime.openPath(file);
    if (result) throw new AppError('OPEN_FAILED', `Ouverture impossible : ${result}`);
    return { ok: true };
  };
  handlers['documents.saveAs'] = async (env) => {
    const db = getDb();
    const ctx = sessionContext(env.event);
    const row = db.prepare('SELECT original_name FROM attachments WHERE id = ?').get(Number(env.params.id));
    if (!row) throw new AppError('NOT_FOUND', 'Document introuvable');
    const destination = await runtime.pickSavePath({
      title: 'Enregistrer le document',
      defaultPath: row.original_name,
    });
    if (!destination) return { canceled: true };
    attachments.copyAttachmentTo(db, ctx, env.params.id, paths.attachmentsDir, destination);
    return { ok: true, path: destination };
  };

  handlers['backups.list'] = (env) => backups.listBackups(getDb(), sessionContext(env.event));
  handlers['backups.create'] = async (env) => {
    const ctx = sessionContext(env.event);
    const result = await backups.createBackup(getDb(), paths, { kind: 'MANUAL', ctx });
    return { ...result, buffer: undefined };
  };
  handlers['backups.verify'] = (env) => backups.verifyBackup(getDb(), sessionContext(env.event), paths, env.params);
  handlers['backups.previewRestore'] = (env) =>
    backups.previewRestore(getDb(), sessionContext(env.event), paths, env.params);
  handlers['backups.restore'] = async (env) => {
    const ctx = sessionContext(env.event);
    const result = await backups.restoreBackup(getDb(), ctx, paths, env.params, runtime);
    sessions.clear();
    return result;
  };
  handlers['backups.autoStatus'] = (env) => {
    const db = getDb();
    const ctx = sessionContext(env.event);
    if (!ctx.permissions.has('backup.manage')) throw new AppError('FORBIDDEN', 'Permission requise : backup.manage');
    const last = db.prepare("SELECT * FROM backup_history WHERE kind='AUTO' ORDER BY id DESC LIMIT 1").get();
    const setting = getSetting(db, 'backup.auto_enabled', true);
    const hours = Number(getSetting(db, 'backup.auto_interval_hours', 24));
    return {
      enabled: Boolean(setting),
      intervalHours: hours,
      lastAuto: last ? { id: last.id, filename: last.filename, createdAt: last.created_at, verified: Boolean(last.verified) } : null,
    };
  };

  handlers['reports.catalogue'] = () => reports.catalogue();
  handlers['reports.data'] = (env) => reports.getReportData(getDb(), sessionContext(env.event), env.params);
  handlers['reports.export'] = async (env) => {
    const ctx = sessionContext(env.event);
    const result = await reports.exportReport(getDb(), ctx, env.params);
    const destination = await runtime.pickSavePath({
      title: 'Enregistrer le rapport',
      defaultPath: result.filename,
      filters: [{ name: result.filename.split('.').pop().toUpperCase(), extensions: [result.filename.split('.').pop()] }],
    });
    if (!destination) return { canceled: true };
    fs.writeFileSync(destination, result.buffer, { mode: 0o600 });
    const stat = fs.statSync(destination);
    if (stat.size !== result.sizeBytes) throw new AppError('EXPORT_FAILED', 'Le fichier écrit ne correspond pas au contenu généré');
    return {
      ok: true,
      path: destination,
      filename: path.basename(destination),
      sizeBytes: stat.size,
      rowCount: result.rowCount,
      format: env.params.format,
      warnings: result.warnings,
    };
  };

  handlers['audit.list'] = (env) => audit.listAudit(getDb(), sessionContext(env.event), env.params);
  handlers['audit.export'] = async (env) => {
    const db = getDb();
    const ctx = sessionContext(env.event);
    if (!ctx.permissions.has('audit.view')) throw new AppError('FORBIDDEN', 'Permission requise : audit.view');
    const rows = audit.auditForExport(db, ctx, env.params.filters || {});
    const csv = buildCsv(
      ['Horodatage', 'Utilisateur', 'Société', 'Type', 'Identifiant', 'Action', 'Motif', 'Avant', 'Après', 'Source'],
      rows.map((r) => [
        r.at,
        r.userFullName || r.username || 'Système',
        r.companyName || '',
        r.entityType,
        r.entityId,
        r.action,
        r.reason || '',
        r.before ? JSON.stringify(r.before) : '',
        r.after ? JSON.stringify(r.after) : '',
        r.source || '',
      ]),
      { delimiter: ';' }
    );
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const destination = await runtime.pickSavePath({
      title: 'Enregistrer la piste d’audit',
      defaultPath: `Audit-${stamp}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (!destination) return { canceled: true };
    const buffer = Buffer.from(csv, 'utf8');
    fs.writeFileSync(destination, buffer, { mode: 0o600 });
    if (fs.statSync(destination).size !== buffer.length) {
      throw new AppError('EXPORT_FAILED', 'Le fichier d’audit écrit est incomplet');
    }
    return { ok: true, path: destination, filename: path.basename(destination), sizeBytes: buffer.length, rowCount: rows.length };
  };

  handlers['settings.get'] = (env) => {
    const db = getDb();
    const ctx = sessionContext(env.event);
    if (!ctx.permissions.has('settings.view')) throw new AppError('FORBIDDEN', 'Permission requise : settings.view');
    const values = getAllSettings(db);
    if (ctx.user.role !== 'DG') {
      const definitions = {};
      for (const [key, def] of Object.entries(DEFINITIONS)) {
        if (!key.startsWith('approval.')) definitions[key] = def;
      }
      const visible = {};
      for (const [key, value] of Object.entries(values)) {
        if (!key.startsWith('approval.')) visible[key] = value;
      }
      return { values: visible, definitions };
    }
    return { values, definitions: DEFINITIONS };
  };
  handlers['settings.update'] = (env) =>
    updateSettings(getDb(), sessionContext(env.event), env.params.changes, { reason: env.params.reason });

  handlers['notifications.list'] = (env) => notifications.listNotifications(getDb(), sessionContext(env.event), env.params);
  handlers['notifications.unreadCount'] = (env) => notifications.unreadCount(getDb(), sessionContext(env.event));
  handlers['notifications.markRead'] = (env) => notifications.markRead(getDb(), sessionContext(env.event), env.params);

  handlers['migration.analyze'] = (env) => {
    const ctx = sessionContext(env.event);
    if (!ctx.permissions.has('migration.run')) throw new AppError('FORBIDDEN', 'Permission requise : migration.run');
    return migration.analyse(getDb(), ctx, env.params);
  };
  handlers['migration.analyzeFile'] = async (env) => {
    const ctx = sessionContext(env.event);
    const picked = await runtime.pickOpenFile({
      title: 'Sélectionner une sauvegarde JSON de l’application d’origine',
      filters: [{ name: 'Sauvegarde JSON', extensions: ['json'] }],
    });
    if (!picked) return { canceled: true };
    if (picked.size > 20 * 1024 * 1024) throw new AppError('VALIDATION', 'Fichier trop volumineux (20 Mo maximum)');
    const rawText = fs.readFileSync(picked.path, 'utf8');
    return migration.analyse(getDb(), ctx, { rawText, sourceName: path.basename(picked.path) });
  };
  handlers['migration.analyse'] = handlers['migration.analyze'];
  handlers['migration.commit'] = (env) => {
    const ctx = sessionContext(env.event);
    return migration.commitLegacy(getDb(), ctx, env.params, paths);
  };
  handlers['migration.history'] = (env) => migration.getImportHistory(getDb(), sessionContext(env.event));

  async function dispatch(event, payload) {
    const validation = validatePayload(payload);
    if (!validation.ok) {
      return { ok: false, error: { code: 'IPC_INVALID', message: validation.message, details: validation.details || null } };
    }
    const handler = handlers[validation.method];
    if (!handler) {
      return { ok: false, error: { code: 'IPC_UNKNOWN', message: 'Méthode non implémentée' } };
    }
    const publicMethods = new Set([
      'app.bootstrap',
      'app.about',
      'auth.setup',
      'auth.login',
      'auth.me',
      'auth.logout',
      'auth.lock',
      'roles.catalog',
    ]);
    try {
      if (!publicMethods.has(validation.method)) {
        const ctx = sessionContext(event);
        if (ctx.user.mustChangePassword && !['auth.changePassword', 'auth.logout', 'auth.me'].includes(validation.method)) {
          throw new AppError('PASSWORD_CHANGE_REQUIRED', 'Vous devez changer votre mot de passe avant de continuer');
        }
      }
      const result = await handler({ event, params: validation.params, requestId: validation.requestId });
      return { ok: true, data: plain(result === undefined ? null : result) };
    } catch (err) {
      if (!(err instanceof AppError)) {
        // Ne jamais exposer la pile ou le SQL au rendu.
        console.error(`[IPC ${validation.method}]`, err);
      }
      return { ok: false, error: toErrorPayload(err) };
    }
  }

  return { dispatch, handlers, sessions, methods: METHODS };
}

module.exports = { createDispatcher };
