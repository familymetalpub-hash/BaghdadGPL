'use strict';

const { can, ROLES } = require('../../shared/permissions');

class AppError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

function validationError(message, details = null) {
  return new AppError('VALIDATION', message, details);
}

function notFound(entity = 'Enregistrement') {
  return new AppError('NOT_FOUND', `${entity} introuvable`);
}

function forbidden(message = 'Accès refusé') {
  return new AppError('FORBIDDEN', message);
}

const GLOBAL_COMPANY_ROLES = new Set(['DG', 'ADMIN']);

function hasPermission(ctx, permission) {
  if (!ctx || !ctx.user) return false;
  if (ctx.permissions instanceof Set) return ctx.permissions.has(permission);
  if (Array.isArray(ctx.permissions)) return ctx.permissions.includes(permission);
  return can(ctx.user.role, permission);
}

function assertPermission(ctx, permission) {
  if (!ctx || !ctx.user) throw new AppError('UNAUTHORIZED', 'Session requise');
  if (!hasPermission(ctx, permission)) {
    throw forbidden(`Permission manquante : ${permission}`);
  }
}

function assertAnyPermission(ctx, permissions) {
  if (!ctx || !ctx.user) throw new AppError('UNAUTHORIZED', 'Session requise');
  if (!permissions.some((p) => hasPermission(ctx, p))) {
    throw forbidden('Permission manquante');
  }
}

function hasGlobalCompanyAccess(ctx) {
  return Boolean(ctx && ctx.user && GLOBAL_COMPANY_ROLES.has(ctx.user.role));
}

function companyIdSet(ctx) {
  if (!ctx || !ctx.user) return new Set();
  if (hasGlobalCompanyAccess(ctx)) {
    return new Set(ctx.companyIds || []); // rempli au login avec toutes les sociétés actives
  }
  return new Set(ctx.assignedCompanyIds || []);
}

function assertCompanyAccess(ctx, companyId) {
  if (!ctx || !ctx.user) throw new AppError('UNAUTHORIZED', 'Session requise');
  const id = Number(companyId);
  if (!Number.isInteger(id) || id <= 0) throw validationError('Société invalide');
  const allowed = companyIdSet(ctx);
  if (!allowed.has(id)) throw forbidden('Cette société n’est pas autorisée pour votre compte');
  return id;
}

/**
 * Valide une liste de sociétés demandée par le client.
 * Aucune société hors périmètre ne peut être demandée, même par manipulation
 * directe de l'IPC.
 */
function resolveCompanyScope(ctx, requested) {
  const allowed = [...companyIdSet(ctx)];
  if (requested === null || requested === undefined || (Array.isArray(requested) && requested.length === 0)) {
    return allowed;
  }
  const list = Array.isArray(requested) ? requested : [requested];
  const ids = [...new Set(list.map(Number))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw validationError('Filtre société invalide');
  const outside = ids.filter((id) => !allowed.includes(id));
  if (outside.length) throw forbidden('Filtre société hors de votre périmètre');
  return ids;
}

function assertSelfOrPermission(ctx, userId, permission) {
  if (Number(userId) === Number(ctx.user.id)) return;
  assertPermission(ctx, permission);
}

function assertNotSelfApproval(ctx, requesterId) {
  if (Number(ctx.user.id) === Number(requesterId)) {
    throw forbidden('Auto-approbation interdite : la demande doit être examinée par un autre utilisateur habilité');
  }
}

function assertApproverRole(ctx) {
  assertPermission(ctx, 'approvals.decide');
  if (!['DG'].includes(ctx.user.role)) {
    throw forbidden('Seul le Directeur Général peut décider une approbation financière');
  }
}

function assertNotAdminForFinance(ctx) {
  if (ctx.user.role === ROLES.ADMIN.code) {
    throw forbidden('Le rôle Administrateur ne dispose pas des droits financiers');
  }
}

function errorPayload(error) {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { code: 'INTERNAL', message: 'Erreur interne. Consultez le journal applicatif.' };
}

module.exports = {
  AppError,
  validationError,
  notFound,
  forbidden,
  hasPermission,
  assertPermission,
  assertAnyPermission,
  hasGlobalCompanyAccess,
  companyIdSet,
  assertCompanyAccess,
  resolveCompanyScope,
  assertSelfOrPermission,
  assertNotSelfApproval,
  assertApproverRole,
  assertNotAdminForFinance,
  errorPayload,
  GLOBAL_COMPANY_ROLES,
};
