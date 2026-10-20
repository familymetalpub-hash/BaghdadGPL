'use strict';

const crypto = require('node:crypto');
const {
  AppError,
  assertPermission,
  forbidden,
  validationError,
  notFound,
} = require('./authorization');
const { appendAudit } = require('./audit');
const { getSetting, setInternalSetting } = require('./settings');

const SCRYPT_N = Math.max(16384, Number(process.env.SUIVI_SCRYPT_N) || 32768);
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64');
}

/**
 * scrypt avec sel aléatoire et paramètres encodés dans l'empreinte.
 * Format : scrypt$N$r$p$sel_base64$hash_base64
 */
function hashPassword(password, options = {}) {
  const N = options.N || SCRYPT_N;
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, {
    N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$${N}$${SCRYPT_R}$${SCRYPT_P}$${base64url(salt)}$${base64url(hash)}`;
}

function parseHash(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') throw new Error('Empreinte de mot de passe invalide');
  const [, N, r, p, salt, hash] = parts;
  return {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt, 'base64'),
    hash: Buffer.from(hash, 'base64'),
  };
}

function verifyPassword(password, stored) {
  try {
    const parsed = parseHash(stored);
    if (!parsed.salt.length || !parsed.hash.length) return false;
    const candidate = crypto.scryptSync(String(password), parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: 256 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(candidate, parsed.hash);
  } catch {
    return false;
  }
}

let dummyHash = null;
function burnPasswordTime(password) {
  if (!dummyHash) dummyHash = hashPassword('mot-de-passe-inexistant', { N: Math.min(16384, SCRYPT_N) });
  verifyPassword(String(password || 'x'), dummyHash);
}

function validatePassword(password, minLength = 12) {
  const pwd = String(password || '');
  if (pwd.length < minLength) throw validationError(`Le mot de passe doit contenir au moins ${minLength} caractères`);
  if (pwd.length > 200) throw validationError('Mot de passe trop long');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pwd)).length;
  if (classes < 3) {
    throw validationError('Le mot de passe doit combiner au moins trois catégories : minuscules, majuscules, chiffres, caractères spéciaux');
  }
  const common = ['password', 'motdepasse', 'azerty', '123456', 'admin123', 'cheque2026'];
  if (common.some((c) => pwd.toLowerCase().includes(c))) throw validationError('Mot de passe trop courant');
  return pwd;
}

function generateTemporaryPassword() {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const special = '!@#$%*-_+=?';
  const pick = (set) => set[crypto.randomInt(0, set.length)];
  const chars = [pick(lower), pick(lower), pick(upper), pick(upper), pick(digits), pick(digits), pick(special), pick(special)];
  for (let i = 0; i < 10; i += 1) chars.push(pick(lower + upper + digits));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function roleByName(db, roleCode) {
  const role = db.prepare('SELECT id, code, name FROM roles WHERE code = ?').get(String(roleCode).toUpperCase());
  if (!role) throw validationError('Rôle inconnu');
  return role;
}

function permissionsFor(db, roleId) {
  return new Set(
    db
      .prepare(
        `SELECT p.code FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         WHERE rp.role_id = ?`
      )
      .all(roleId)
      .map((r) => r.code)
  );
}

function companiesFor(db, user) {
  const all = db
    .prepare('SELECT id, code, name, color, is_active FROM companies ORDER BY name')
    .all()
    .map((c) => ({ id: c.id, code: c.code, name: c.name, color: c.color, isActive: Boolean(c.is_active) }));
  if (user.role === 'DG' || user.role === 'ADMIN') return all;
  return db
    .prepare(
      `SELECT c.id, c.code, c.name, c.color, c.is_active
       FROM companies c JOIN company_assignments ca ON ca.company_id = c.id
       WHERE ca.user_id = ? ORDER BY c.name`
    )
    .all(user.id)
    .map((c) => ({ id: c.id, code: c.code, name: c.name, color: c.color, isActive: Boolean(c.is_active) }));
}

function loadUserById(db, userId) {
  const row = db
    .prepare(
      `SELECT u.*, r.code AS role_code, r.name AS role_name
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`
    )
    .get(userId);
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    email: row.email,
    role: row.role_code,
    roleName: row.role_name,
    roleId: row.role_id,
    isActive: Boolean(row.is_active),
    mustChangePassword: Boolean(row.must_change_password),
    lastLoginAt: row.last_login_at,
    passwordHash: row.password_hash,
  };
}

function buildContext(db, userId, sessionRow) {
  const user = loadUserById(db, userId);
  if (!user || !user.isActive) throw new AppError('UNAUTHORIZED', 'Compte inactif ou inexistant');
  const permissions = permissionsFor(db, user.roleId);
  const companies = companiesFor(db, user);
  return {
    user: {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      roleName: user.roleName,
      mustChangePassword: user.mustChangePassword,
    },
    permissions,
    companies,
    companyIds: companies.map((c) => c.id),
    assignedCompanyIds: db
      .prepare('SELECT company_id FROM company_assignments WHERE user_id = ?')
      .all(user.id)
      .map((r) => r.company_id),
    session: {
      id: sessionRow.id,
      idleTimeoutMinutes: sessionRow.idle_timeout_minutes,
      expiresAt: sessionRow.expires_at,
      lastSeenAt: sessionRow.last_seen_at,
    },
  };
}

function publicContext(ctx) {
  return {
    user: ctx.user,
    permissions: [...ctx.permissions].sort(),
    companies: ctx.companies,
    companyIds: ctx.companyIds,
    sessionId: ctx.session.id,
    session: {
      idleTimeoutMinutes: ctx.session.idleTimeoutMinutes,
      expiresAt: ctx.session.expiresAt,
      lastSeenAt: ctx.session.lastSeenAt,
    },
  };
}

function isSetupRequired(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  return count === 0;
}

function bootstrap(db) {
  return {
    needsSetup: isSetupRequired(db),
    appName: getSetting(db, 'app.name', 'Suivi des Chèques'),
    orgName: getSetting(db, 'app.org_name', 'Groupe'),
    locale: getSetting(db, 'app.locale', 'fr'),
    version: '2.0.0',
  };
}

function setup(db, input = {}) {
  if (!isSetupRequired(db)) throw forbidden('L’application est déjà initialisée');
  const dg = input.dg || {};
  const admin = input.admin || {};
  const orgName = String(input.orgName || 'Groupe').trim();
  if (orgName.length < 2 || orgName.length > 120) throw validationError('Nom de l’organisation invalide');
  for (const [key, account] of [['DG', dg], ['ADMIN', admin]]) {
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(String(account.username || ''))) {
      throw validationError(`Identifiant ${key} invalide (3 à 40 caractères : lettres, chiffres, . _ -)`);
    }
    if (!String(account.fullName || '').trim()) throw validationError(`Nom complet ${key} requis`);
    validatePassword(account.password, Number(getSetting(db, 'password.min_length', 12)));
  }
  if (String(dg.username).toLowerCase() === String(admin.username).toLowerCase()) {
    throw validationError('Les identifiants du DG et de l’administrateur doivent être différents');
  }
  const minLength = Number(getSetting(db, 'password.min_length', 12));
  validatePassword(admin.password, minLength);
  const dgRole = roleByName(db, 'DG');
  const adminRole = roleByName(db, 'ADMIN');
  const dgHash = hashPassword(dg.password);
  const adminHash = hashPassword(admin.password);

  return db.transaction(() => {
    if (!isSetupRequired(db)) throw forbidden('L’application est déjà initialisée');
    const insertUser = db.prepare(
      `INSERT INTO users(username, full_name, email, password_hash, role_id, must_change_password, created_by)
       VALUES (?, ?, ?, ?, ?, 0, NULL)`
    );
    const dgId = Number(
      insertUser.run(String(dg.username).trim(), String(dg.fullName).trim(), dg.email || null, dgHash, dgRole.id).lastInsertRowid
    );
    const adminId = Number(
      insertUser.run(
        String(admin.username).trim(),
        String(admin.fullName).trim(),
        admin.email || null,
        adminHash,
        adminRole.id
      ).lastInsertRowid
    );
    let companyId = null;
    if (input.company && input.company.name) {
      const code = String(input.company.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9-]{2,20}$/.test(code)) throw validationError('Code société invalide (2 à 20 caractères A-Z, 0-9, -)');
      companyId = Number(
        db
          .prepare('INSERT INTO companies(code,name,legal_form,nif,color) VALUES (?,?,?,?,?)')
          .run(
            code,
            String(input.company.name).trim(),
            input.company.legalForm || null,
            input.company.nif || null,
            input.company.color || '#0f766e'
          ).lastInsertRowid
      );
    }
    setInternalSetting(db, 'app.org_name', orgName, dgId);
    setInternalSetting(db, 'first_run_completed', true, dgId);
    appendAudit(db, null, {
      userId: dgId,
      entityType: 'AUTH',
      entityId: 'SETUP',
      action: 'APP_SETUP',
      after: { dgUsername: dg.username, adminUsername: admin.username, orgName, companyId },
      reason: 'Initialisation de l’application',
      source: 'DESKTOP',
    });
    appendAudit(db, null, {
      userId: adminId,
      entityType: 'USER',
      entityId: adminId,
      action: 'USER_CREATE',
      after: { username: admin.username, role: 'ADMIN' },
      reason: 'Création du compte administrateur initial',
    });
    return { ok: true, companyId };
  }).immediate();
}

function login(db, username, password) {
  if (isSetupRequired(db)) throw new AppError('SETUP_REQUIRED', 'L’application doit être initialisée');
  const clean = String(username || '').trim();
  if (!clean || !password) throw new AppError('VALIDATION', 'Identifiant et mot de passe requis');
  const maxAttempts = Number(getSetting(db, 'security.max_login_attempts', 5));
  const lockMinutes = Number(getSetting(db, 'security.lock_minutes', 15));
  const row = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(clean);
  if (!row) {
    burnPasswordTime(password);
    appendAudit(db, null, {
      entityType: 'AUTH',
      entityId: clean.slice(0, 40),
      action: 'LOGIN_FAILED',
      reason: 'Identifiant inconnu',
      metadata: { username: clean.slice(0, 40) },
    });
    throw new AppError('AUTH_FAILED', 'Identifiant ou mot de passe incorrect');
  }
  if (!row.is_active) {
    burnPasswordTime(password);
    appendAudit(db, null, {
      userId: row.id,
      entityType: 'AUTH',
      entityId: row.id,
      action: 'LOGIN_FAILED',
      reason: 'Compte désactivé',
    });
    throw new AppError('AUTH_FAILED', 'Identifiant ou mot de passe incorrect');
  }
  if (row.locked_until && Date.parse(row.locked_until) > Date.now()) {
    throw new AppError('ACCOUNT_LOCKED', 'Compte temporairement verrouillé après plusieurs échecs. Réessayez plus tard.');
  }

  const valid = verifyPassword(password, row.password_hash);
  if (!valid) {
    const attempts = row.failed_attempts + 1;
    const lockUntil = attempts >= maxAttempts ? new Date(Date.now() + lockMinutes * 60_000).toISOString() : null;
    db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?').run(
      attempts,
      lockUntil,
      new Date().toISOString(),
      row.id
    );
    appendAudit(db, null, {
      userId: row.id,
      entityType: 'AUTH',
      entityId: row.id,
      action: 'LOGIN_FAILED',
      reason: 'Mot de passe incorrect',
      metadata: { attempts, locked: Boolean(lockUntil) },
    });
    throw new AppError('AUTH_FAILED', 'Identifiant ou mot de passe incorrect');
  }

  const idleMinutes = Number(getSetting(db, 'session.idle_timeout_minutes', 15));
  const absoluteMinutes = Number(getSetting(db, 'session.absolute_timeout_minutes', 480));
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + absoluteMinutes * 60_000).toISOString();
  db.transaction(() => {
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?').run(
      now.toISOString(),
      now.toISOString(),
      row.id
    );
    db.prepare(
      `INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,idle_timeout_minutes)
       VALUES (?,?,?,?,?,?)`
    ).run(sessionId, row.id, now.toISOString(), now.toISOString(), expiresAt, idleMinutes);
    appendAudit(
      db,
      { user: { id: row.id }, session: { id: sessionId } },
      {
        userId: row.id,
        entityType: 'AUTH',
        entityId: row.id,
        action: 'LOGIN_SUCCESS',
        reason: 'Connexion',
        sessionId,
      }
    );
  }).immediate();

  const sessionRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  const ctx = buildContext(db, row.id, sessionRow);

  // Mise à niveau transparente des paramètres scrypt si nécessaire.
  try {
    const parsed = parseHash(row.password_hash);
    if (parsed.N < SCRYPT_N) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), row.id);
    }
  } catch {
    /* empreinte invalide : le login a déjà échoué plus haut */
  }

  return publicContext(ctx);
}

function expireStaleSessions(db) {
  const now = new Date();
  const rows = db.prepare("SELECT * FROM sessions WHERE revoked_at IS NULL").all();
  let expired = 0;
  const update = db.prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ?");
  for (const s of rows) {
    const lastSeen = Date.parse(s.last_seen_at);
    const absolute = Date.parse(s.expires_at);
    const idleMs = Number(s.idle_timeout_minutes) * 60_000;
    if (now.getTime() > absolute) {
      update.run(now.toISOString(), 'EXPIRED_ABSOLUTE', s.id);
      expired += 1;
    } else if (now.getTime() - lastSeen > idleMs) {
      update.run(now.toISOString(), 'EXPIRED_IDLE', s.id);
      expired += 1;
    }
  }
  return expired;
}

/** Valide une session, met à jour son activité et retourne le contexte complet. */
function sessionContextNoTouch(db, sessionId) {
  if (!sessionId) throw new AppError('UNAUTHORIZED', 'Session requise');
  const row = db
    .prepare(
      `SELECT s.*, u.is_active, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .get(sessionId);
  if (!row) throw new AppError('UNAUTHORIZED', 'Session inexistante ou expirée');
  if (row.revoked_at) throw new AppError('UNAUTHORIZED', 'Session révoquée');
  if (!row.is_active) throw new AppError('UNAUTHORIZED', 'Compte désactivé');
  const now = Date.now();
  if (now > Date.parse(row.expires_at)) {
    db.prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = 'EXPIRED_ABSOLUTE' WHERE id = ?").run(
      new Date().toISOString(),
      sessionId
    );
    throw new AppError('SESSION_EXPIRED', 'Session expirée. Reconnectez-vous.');
  }
  if (now - Date.parse(row.last_seen_at) > Number(row.idle_timeout_minutes) * 60_000) {
    db.prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = 'EXPIRED_IDLE' WHERE id = ?").run(
      new Date().toISOString(),
      sessionId
    );
    throw new AppError('SESSION_EXPIRED', 'Session verrouillée pour inactivité. Reconnectez-vous.');
  }
  return buildContext(db, row.user_id, row);
}

function touchSession(db, sessionId) {
  const ctx = sessionContextNoTouch(db, sessionId);
  const now = new Date().toISOString();
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, sessionId);
  ctx.session.lastSeenAt = now;
  return ctx;
}

function logout(db, ctx) {
  if (!ctx || !ctx.session) return { ok: true };
  db.prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = 'LOGOUT' WHERE id = ? AND revoked_at IS NULL").run(
    new Date().toISOString(),
    ctx.session.id
  );
  appendAudit(db, ctx, {
    entityType: 'AUTH',
    entityId: ctx.user.id,
    action: 'LOGOUT',
    reason: 'Déconnexion volontaire',
  });
  return { ok: true };
}

function changePassword(db, ctx, input) {
  if (!ctx || !ctx.user) throw new AppError('UNAUTHORIZED', 'Session requise');
  const current = String(input.currentPassword || '');
  const next = String(input.newPassword || '');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
  if (!user || !verifyPassword(current, user.password_hash)) {
    throw new AppError('AUTH_FAILED', 'Mot de passe actuel incorrect');
  }
  validatePassword(next, Number(getSetting(db, 'password.min_length', 12)));
  if (next === current) throw validationError('Le nouveau mot de passe doit être différent');
  const hash = hashPassword(next);
  db.transaction(() => {
    db.prepare(
      'UPDATE users SET password_hash = ?, must_change_password = 0, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?'
    ).run(hash, new Date().toISOString(), user.id);
    db.prepare(
      "UPDATE sessions SET revoked_at = ?, revoked_reason = 'PASSWORD_CHANGED' WHERE user_id = ? AND id <> ? AND revoked_at IS NULL"
    ).run(new Date().toISOString(), user.id, ctx.session.id);
    appendAudit(db, ctx, {
      entityType: 'USER',
      entityId: user.id,
      action: 'PASSWORD_CHANGE',
      reason: 'Changement de mot de passe par l’utilisateur',
    });
  }).immediate();
  return { ok: true };
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    email: row.email,
    role: row.role_code,
    roleName: row.role_name,
    isActive: Boolean(row.is_active),
    mustChangePassword: Boolean(row.must_change_password),
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    companies: row.company_ids
      ? String(row.company_ids)
          .split(',')
          .filter(Boolean)
          .map(Number)
      : [],
  };
}

function listUsers(db, ctx) {
  assertPermission(ctx, 'users.view');
  const rows = db
    .prepare(
      `SELECT u.*, r.code AS role_code, r.name AS role_name,
        (SELECT group_concat(ca.company_id) FROM company_assignments ca WHERE ca.user_id = u.id) AS company_ids
       FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.is_active DESC, u.full_name`
    )
    .all();
  return rows.map(publicUser);
}

function countActiveDG(db, excludeUserId = null) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.code = 'DG' AND u.is_active = 1 AND (? IS NULL OR u.id <> ?)`
    )
    .get(excludeUserId, excludeUserId).n;
}

function assertCanManageRole(ctx, targetRoleCode, isTargetDG = false) {
  if (ctx.user.role === 'ADMIN') {
    if (targetRoleCode === 'DG' || isTargetDG) {
      throw forbidden('Un administrateur ne peut pas créer, modifier ou réinitialiser un compte Directeur Général');
    }
  }
}

function validateUsername(db, username) {
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(String(username || ''))) {
    throw validationError('Identifiant invalide (3 à 40 caractères : lettres, chiffres, . _ -)');
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (exists) throw new AppError('CONFLICT', 'Cet identifiant existe déjà');
}

function replaceAssignments(db, ctx, userId, companyIds) {
  const ids = [...new Set((companyIds || []).map(Number))];
  for (const id of ids) {
    const company = db.prepare('SELECT id FROM companies WHERE id = ? AND is_active = 1').get(id);
    if (!company) throw validationError('Société d’affectation invalide ou inactive');
  }
  db.prepare('DELETE FROM company_assignments WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT INTO company_assignments(user_id, company_id, assigned_by) VALUES (?,?,?)');
  for (const id of ids) insert.run(userId, id, ctx.user.id);
  return ids;
}

function createUser(db, ctx, input) {
  assertPermission(ctx, 'users.manage');
  const role = roleByName(db, input.role);
  assertCanManageRole(ctx, role.code);
  validateUsername(db, input.username);
  if (!String(input.fullName || '').trim()) throw validationError('Nom complet requis');
  validatePassword(input.password, Number(getSetting(db, 'password.min_length', 12)));
  const assignments = (input.companyIds || []).map(Number);
  if (role.code === 'RESPONSABLE' && assignments.length === 0) {
    throw validationError('Un Responsable de Suivi doit être affecté à au moins une société');
  }
  const hash = hashPassword(input.password);
  return db.transaction(() => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO users(username, full_name, email, password_hash, role_id, must_change_password, created_by)
           VALUES (?,?,?,?,?,?,?)`
        )
        .run(
          String(input.username).trim(),
          String(input.fullName).trim(),
          input.email || null,
          hash,
          role.id,
          input.mustChangePassword ? 1 : 0,
          ctx.user.id
        ).lastInsertRowid
    );
    const assigned = replaceAssignments(db, ctx, id, role.code === 'RESPONSABLE' ? assignments : []);
    appendAudit(db, ctx, {
      entityType: 'USER',
      entityId: id,
      action: 'USER_CREATE',
      after: { username: input.username, fullName: input.fullName, role: role.code, companyIds: assigned },
      reason: 'Création d’un compte utilisateur',
    });
    return publicUser(
      db
        .prepare(
          `SELECT u.*, r.code AS role_code, r.name AS role_name,
             (SELECT group_concat(company_id) FROM company_assignments WHERE user_id = u.id) AS company_ids
           FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`
        )
        .get(id)
    );
  }).immediate();
}

function updateUser(db, ctx, input) {
  assertPermission(ctx, 'users.manage');
  const user = db
    .prepare(`SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`)
    .get(Number(input.id));
  if (!user) throw notFound('Utilisateur');
  assertCanManageRole(ctx, user.role_code, user.role_code === 'DG');
  if (Number(input.id) === Number(ctx.user.id)) {
    if (input.isActive === false) throw forbidden('Vous ne pouvez pas désactiver votre propre compte');
    if (input.role && String(input.role).toUpperCase() !== user.role_code) {
      throw forbidden('Vous ne pouvez pas modifier votre propre rôle');
    }
  }
  const newRole = input.role ? roleByName(db, input.role) : roleByName(db, user.role_code);
  assertCanManageRole(ctx, newRole.code, user.role_code === 'DG');
  if (user.role_code === 'DG' && newRole.code !== 'DG' && countActiveDG(db, user.id) === 0) {
    throw forbidden('Impossible de retirer le dernier Directeur Général actif');
  }
  const willBeActive = input.isActive === undefined ? Boolean(user.is_active) : Boolean(input.isActive);
  if (user.role_code === 'DG' && user.is_active && !willBeActive && countActiveDG(db, user.id) === 0) {
    throw forbidden('Impossible de désactiver le dernier Directeur Général actif');
  }
  const assignments = input.companyIds === undefined ? null : (input.companyIds || []).map(Number);
  if (newRole.code === 'RESPONSABLE') {
    const effective = assignments === null
      ? db.prepare('SELECT company_id FROM company_assignments WHERE user_id = ?').all(user.id).map((r) => r.company_id)
      : assignments;
    if (effective.length === 0) throw validationError('Un Responsable de Suivi doit être affecté à au moins une société');
  }
  return db.transaction(() => {
    db.prepare(
      `UPDATE users SET full_name = ?, email = ?, role_id = ?, is_active = ?, updated_at = ? WHERE id = ?`
    ).run(
      input.fullName === undefined ? user.full_name : String(input.fullName).trim(),
      input.email === undefined ? user.email : input.email || null,
      newRole.id,
      willBeActive ? 1 : 0,
      new Date().toISOString(),
      user.id
    );
    let assigned = null;
    if (newRole.code !== 'RESPONSABLE') {
      db.prepare('DELETE FROM company_assignments WHERE user_id = ?').run(user.id);
      assigned = [];
    } else if (assignments !== null) {
      assigned = replaceAssignments(db, ctx, user.id, assignments);
    }
    if (!willBeActive) {
      db.prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = 'USER_DISABLED' WHERE user_id = ? AND revoked_at IS NULL").run(
        new Date().toISOString(),
        user.id
      );
    }
    appendAudit(db, ctx, {
      entityType: 'USER',
      entityId: user.id,
      action: 'USER_UPDATE',
      before: { fullName: user.full_name, email: user.email, role: user.role_code, isActive: Boolean(user.is_active) },
      after: { fullName: input.fullName, email: input.email, role: newRole.code, isActive: willBeActive, companyIds: assigned },
      reason: 'Modification d’un compte utilisateur',
    });
    return { ok: true };
  }).immediate();
}

function resetPassword(db, ctx, input) {
  assertPermission(ctx, 'users.manage');
  const user = db
    .prepare(`SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`)
    .get(Number(input.id));
  if (!user) throw notFound('Utilisateur');
  assertCanManageRole(ctx, user.role_code, user.role_code === 'DG');
  const temporaryPassword = input.newPassword || generateTemporaryPassword();
  validatePassword(temporaryPassword, Number(getSetting(db, 'password.min_length', 12)));
  const hash = hashPassword(temporaryPassword);
  db.transaction(() => {
    db.prepare(
      'UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?'
    ).run(hash, new Date().toISOString(), user.id);
    db.prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = 'PASSWORD_RESET' WHERE user_id = ? AND revoked_at IS NULL").run(
      new Date().toISOString(),
      user.id
    );
    appendAudit(db, ctx, {
      entityType: 'USER',
      entityId: user.id,
      action: 'PASSWORD_RESET',
      reason: 'Réinitialisation par un administrateur',
      metadata: { mustChangePassword: true },
    });
  }).immediate();
  return { temporaryPassword, mustChangePassword: true };
}

function unlockUser(db, ctx, input) {
  assertPermission(ctx, 'users.manage');
  const user = db
    .prepare(`SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`)
    .get(Number(input.id));
  if (!user) throw notFound('Utilisateur');
  assertCanManageRole(ctx, user.role_code, user.role_code === 'DG');
  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    user.id
  );
  appendAudit(db, ctx, {
    entityType: 'USER',
    entityId: user.id,
    action: 'USER_UNLOCK',
    reason: input.reason || 'Déverrouillage du compte',
  });
  return { ok: true };
}

module.exports = {
  SCRYPT_N,
  hashPassword,
  verifyPassword,
  validatePassword,
  generateTemporaryPassword,
  bootstrap,
  setup,
  login,
  touchSession,
  sessionContextNoTouch,
  logout,
  changePassword,
  expireStaleSessions,
  publicContext,
  listUsers,
  createUser,
  updateUser,
  resetPassword,
  unlockUser,
  loadUserById,
  permissionsFor,
  companiesFor,
  isSetupRequired,
  countActiveDG,
};
