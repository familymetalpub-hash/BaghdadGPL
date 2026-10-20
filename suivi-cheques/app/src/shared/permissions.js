'use strict';

/** Catalogue des permissions et matrice des rôles livrés. */

const PERMISSIONS = {
  'dashboard.view': 'Consulter le tableau de bord',
  'companies.view': 'Consulter les sociétés',
  'companies.manage': 'Créer et modifier les sociétés',
  'banks.manage': 'Gérer les banques',
  'accounts.view': 'Consulter les comptes bancaires',
  'accounts.manage': 'Créer et modifier les comptes bancaires',
  'accounts.sensitive': 'Voir les numéros de compte complets',
  'counterparties.view': 'Consulter les contreparties',
  'counterparties.manage': 'Gérer les contreparties',
  'cheques.view': 'Consulter les chèques',
  'cheques.create': 'Créer des chèques',
  'cheques.edit': 'Modifier les champs non protégés des chèques',
  'cheques.status': 'Enregistrer les événements de statut des chèques',
  'cheques.export': 'Exporter les chèques',
  'transactions.view': 'Consulter les transactions',
  'transactions.manage': 'Enregistrer les transactions',
  'books.view': 'Consulter les chéquiers',
  'books.manage': 'Gérer les chéquiers',
  'approvals.request': 'Soumettre une demande d’approbation',
  'approvals.decide': 'Approuver ou rejeter les opérations protégées',
  'approvals.configure': 'Configurer les règles d’approbation',
  'reconciliation.view': 'Consulter le rapprochement bancaire',
  'reconciliation.import': 'Importer des relevés bancaires',
  'reconciliation.match': 'Proposer des rapprochements',
  'reconciliation.confirm': 'Finaliser les rapprochements',
  'reports.view': 'Consulter les rapports',
  'reports.export': 'Exporter des rapports',
  'audit.view': 'Consulter la piste d’audit',
  'documents.view': 'Consulter les documents',
  'documents.manage': 'Ajouter et retirer des documents',
  'users.view': 'Consulter les utilisateurs',
  'users.manage': 'Gérer les utilisateurs, rôles et affectations',
  'settings.view': 'Consulter les paramètres',
  'settings.manage': 'Modifier les paramètres généraux',
  'backup.manage': 'Créer et vérifier les sauvegardes',
  'backup.restore': 'Restaurer une sauvegarde',
  'migration.run': 'Exécuter la migration de données héritées',
  'notifications.view': 'Consulter les notifications',
};

const ROLES = {
  DG: { code: 'DG', name: 'Directeur Général' },
  RESPONSABLE: { code: 'RESPONSABLE', name: 'Responsable de Suivi' },
  ADMIN: { code: 'ADMIN', name: 'Administrateur' },
};

const ROLE_PERMISSIONS = {
  DG: [
    'dashboard.view',
    'companies.view',
    'accounts.view', 'accounts.sensitive',
    'counterparties.view',
    'cheques.view', 'cheques.create', 'cheques.edit', 'cheques.status', 'cheques.export',
    'transactions.view', 'transactions.manage', 'books.view',
    'approvals.request', 'approvals.decide', 'approvals.configure',
    'reconciliation.view', 'reconciliation.import', 'reconciliation.match', 'reconciliation.confirm',
    'reports.view', 'reports.export',
    'audit.view',
    'documents.view', 'documents.manage',
    'users.view', 'users.manage',
    'settings.view',
    'notifications.view',
  ],
  RESPONSABLE: [
    'dashboard.view',
    'companies.view',
    'accounts.view',
    'counterparties.view', 'counterparties.manage',
    'cheques.view', 'cheques.create', 'cheques.edit', 'cheques.status', 'cheques.export',
    'transactions.view', 'transactions.manage',
    'books.view', 'books.manage',
    'approvals.request',
    'reconciliation.view', 'reconciliation.import', 'reconciliation.match',
    'reports.view', 'reports.export',
    'documents.view', 'documents.manage',
    'notifications.view',
  ],
  ADMIN: [
    'companies.view', 'companies.manage',
    'banks.manage',
    'accounts.view', 'accounts.manage',
    'counterparties.view', 'counterparties.manage',
    'books.view', 'books.manage',
    'users.view', 'users.manage',
    'settings.view', 'settings.manage',
    'backup.manage', 'backup.restore',
    'migration.run',
    'audit.view',
    'documents.view', 'documents.manage',
    'notifications.view',
  ],
};

/** Rôles autorisés à décider une approbation financière. */
const APPROVER_ROLES = ['DG'];

function permissionsForRole(roleCode) {
  return new Set(ROLE_PERMISSIONS[roleCode] || []);
}

function can(roleCode, permission) {
  return permissionsForRole(roleCode).has(permission);
}

module.exports = { PERMISSIONS, ROLES, ROLE_PERMISSIONS, APPROVER_ROLES, permissionsForRole, can };
