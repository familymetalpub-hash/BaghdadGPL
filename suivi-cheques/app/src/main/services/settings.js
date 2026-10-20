'use strict';

const { assertPermission, forbidden, validationError } = require('./authorization');
const { appendAudit } = require('./audit');

const DEFINITIONS = {
  'app.name': { type: 'string', max: 80 },
  'app.locale': { type: 'enum', values: ['fr', 'ar'], default: 'fr' },
  'app.base_currency': { type: 'enum', values: ['DZD'], default: 'DZD' },
  'app.org_name': { type: 'string', max: 120 },
  'first_run_completed': { type: 'boolean', default: false },
  'session.idle_timeout_minutes': { type: 'number', min: 5, max: 240, default: 15 },
  'session.absolute_timeout_minutes': { type: 'number', min: 30, max: 1440, default: 480 },
  'security.max_login_attempts': { type: 'number', min: 3, max: 10, default: 5 },
  'security.lock_minutes': { type: 'number', min: 1, max: 120, default: 15 },
  'password.min_length': { type: 'number', min: 12, max: 64, default: 12 },
  'approval.high_value_enabled': { type: 'boolean', default: true },
  'approval.high_value_threshold_cents': { type: 'number', min: 100, max: 9000000000000, default: 50000000 },
  'approval.require_cancel_finalized': { type: 'boolean', default: true },
  'approval.require_amount_change': { type: 'boolean', default: true },
  'approval.require_association_change': { type: 'boolean', default: true },
  'approval.require_reconciliation_finalize': { type: 'boolean', default: true },
  'approval.self_approval_allowed': { type: 'boolean', default: false },
  'backup.auto_enabled': { type: 'boolean', default: true },
  'backup.auto_interval_hours': { type: 'number', min: 1, max: 168, default: 24 },
  'backup.retention': { type: 'number', min: 3, max: 100, default: 10 },
  'reconciliation.auto_propose': { type: 'boolean', default: true },
  'reconciliation.date_window_days': { type: 'number', min: 1, max: 45, default: 10 },
  'cheque.presentation_deadline_days': { type: 'number', min: 1, max: 365, default: 20 },
  'notifications.overdue_days': { type: 'number', min: 1, max: 90, default: 7 },
  'reports.header': { type: 'string', max: 200 },
  'migration.legacy_bank_default': { type: 'string', max: 80, default: 'Banque (migration)' },
};

function parseTypedValue(key, raw) {
  const def = DEFINITIONS[key];
  if (!def) throw validationError(`Paramètre inconnu : ${key}`);
  if (raw === null || raw === undefined) throw validationError(`Valeur requise pour ${key}`);
  switch (def.type) {
    case 'boolean': {
      if (raw === true || raw === 'true' || raw === 1 || raw === '1') return 'true';
      if (raw === false || raw === 'false' || raw === 0 || raw === '0') return 'false';
      throw validationError(`Valeur booléenne invalide pour ${key}`);
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw validationError(`Valeur numérique invalide pour ${key}`);
      const int = Math.round(n);
      if (int < def.min || int > def.max) {
        throw validationError(`${key} doit être compris entre ${def.min} et ${def.max}`);
      }
      return String(int);
    }
    case 'enum': {
      if (!def.values.includes(String(raw))) throw validationError(`Valeur non autorisée pour ${key}`);
      return String(raw);
    }
    default: {
      const text = String(raw).trim();
      if (text.length > (def.max || 255)) throw validationError(`${key} est trop long`);
      return text;
    }
  }
}

function decodeSetting(key, raw) {
  const def = DEFINITIONS[key];
  if (!def) return raw;
  if (def.type === 'boolean') return raw === 'true' || raw === '1';
  if (def.type === 'number') return Number(raw);
  if (typeof raw === 'string' && raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function getSetting(db, key, fallback = undefined) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  if (!row) {
    if (fallback !== undefined) return fallback;
    const def = DEFINITIONS[key];
    return def ? def.default : undefined;
  }
  return decodeSetting(key, row.value);
}

function getAllSettings(db) {
  const raw = {};
  for (const row of db.prepare('SELECT key, value FROM app_settings').all()) raw[row.key] = row.value;
  const out = {};
  for (const key of Object.keys(DEFINITIONS)) {
    out[key] = raw[key] === undefined ? DEFINITIONS[key].default : decodeSetting(key, raw[key]);
  }
  return out;
}

function isApprovalKey(key) {
  return key.startsWith('approval.');
}

function updateSettings(db, ctx, changes, options = {}) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw validationError('Paramètres invalides');
  const keys = Object.keys(changes);
  if (!keys.length) throw validationError('Aucun paramètre à modifier');
  for (const key of keys) {
    if (!DEFINITIONS[key]) throw validationError(`Paramètre inconnu : ${key}`);
    if (key === 'first_run_completed') throw forbidden('Paramètre système non modifiable');
    if (key === 'app.base_currency') {
      const accounts = db.prepare('SELECT COUNT(*) AS n FROM bank_accounts').get().n;
      if (accounts > 0) throw forbidden('La devise de base ne peut plus être modifiée après création de comptes');
    }
  }
  const approvalOnly = keys.every(isApprovalKey);
  if (approvalOnly) {
    assertPermission(ctx, 'approvals.configure');
  } else {
    assertPermission(ctx, 'settings.manage');
    if (keys.some(isApprovalKey)) {
      // Les règles d'approbation ne peuvent pas être modifiées via l'écran
      // Paramètres général par un administrateur non DG.
      assertPermission(ctx, 'approvals.configure');
    }
  }

  const before = {};
  for (const key of keys) before[key] = getSetting(db, key);
  const normalized = keys.map((key) => [key, parseTypedValue(key, changes[key])]);
  const update = db.prepare(
    'INSERT INTO app_settings(key,value,updated_by,updated_at) VALUES (?,?,?,?) ' +
      'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at'
  );
  return db.transaction(() => {
    for (const [key, value] of normalized) update.run(key, value, ctx.user.id, new Date().toISOString());
    const after = {};
    for (const key of keys) after[key] = getSetting(db, key);
    appendAudit(db, ctx, {
      companyId: null,
      entityType: 'SETTINGS',
      entityId: keys.join(','),
      action: 'SETTINGS_UPDATE',
      before,
      after,
      reason: options.reason || 'Modification des paramètres',
    });
    return getAllSettings(db);
  }).immediate();
}

function setInternalSetting(db, key, rawValue, userId = null) {
  const value = parseTypedValue(key, rawValue);
  db.prepare(
    'INSERT INTO app_settings(key,value,updated_by,updated_at) VALUES (?,?,?,?) ' +
      'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at'
  ).run(key, value, userId, new Date().toISOString());
}

module.exports = { DEFINITIONS, getSetting, getAllSettings, updateSettings, setInternalSetting, parseTypedValue };
