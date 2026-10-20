-- ============================================================================
-- Données de référence (rôles, permissions, devises, paramètres).
-- Aucune société, aucun utilisateur, aucun chèque fictif n'est créé ici.
-- ============================================================================

INSERT INTO permissions(code,label) VALUES ('dashboard.view','Consulter le tableau de bord');
INSERT INTO permissions(code,label) VALUES ('companies.view','Consulter les sociétés');
INSERT INTO permissions(code,label) VALUES ('companies.manage','Créer et modifier les sociétés');
INSERT INTO permissions(code,label) VALUES ('banks.manage','Gérer les banques');
INSERT INTO permissions(code,label) VALUES ('accounts.view','Consulter les comptes bancaires');
INSERT INTO permissions(code,label) VALUES ('accounts.manage','Créer et modifier les comptes bancaires');
INSERT INTO permissions(code,label) VALUES ('accounts.sensitive','Voir les numéros de compte complets');
INSERT INTO permissions(code,label) VALUES ('counterparties.view','Consulter les contreparties');
INSERT INTO permissions(code,label) VALUES ('counterparties.manage','Gérer les contreparties');
INSERT INTO permissions(code,label) VALUES ('cheques.view','Consulter les chèques');
INSERT INTO permissions(code,label) VALUES ('cheques.create','Créer des chèques');
INSERT INTO permissions(code,label) VALUES ('cheques.edit','Modifier les champs non protégés des chèques');
INSERT INTO permissions(code,label) VALUES ('cheques.status','Enregistrer les événements de statut des chèques');
INSERT INTO permissions(code,label) VALUES ('cheques.export','Exporter les chèques');
INSERT INTO permissions(code,label) VALUES ('transactions.view','Consulter les transactions');
INSERT INTO permissions(code,label) VALUES ('transactions.manage','Enregistrer les transactions');
INSERT INTO permissions(code,label) VALUES ('books.view','Consulter les chéquiers');
INSERT INTO permissions(code,label) VALUES ('books.manage','Gérer les chéquiers');
INSERT INTO permissions(code,label) VALUES ('approvals.request','Soumettre une demande d’approbation');
INSERT INTO permissions(code,label) VALUES ('approvals.decide','Approuver ou rejeter les opérations protégées');
INSERT INTO permissions(code,label) VALUES ('approvals.configure','Configurer les règles d’approbation');
INSERT INTO permissions(code,label) VALUES ('reconciliation.view','Consulter le rapprochement bancaire');
INSERT INTO permissions(code,label) VALUES ('reconciliation.import','Importer des relevés bancaires');
INSERT INTO permissions(code,label) VALUES ('reconciliation.match','Proposer des rapprochements');
INSERT INTO permissions(code,label) VALUES ('reconciliation.confirm','Finaliser les rapprochements');
INSERT INTO permissions(code,label) VALUES ('reports.view','Consulter les rapports');
INSERT INTO permissions(code,label) VALUES ('reports.export','Exporter des rapports');
INSERT INTO permissions(code,label) VALUES ('audit.view','Consulter la piste d’audit');
INSERT INTO permissions(code,label) VALUES ('documents.view','Consulter les documents');
INSERT INTO permissions(code,label) VALUES ('documents.manage','Ajouter et retirer des documents');
INSERT INTO permissions(code,label) VALUES ('users.view','Consulter les utilisateurs');
INSERT INTO permissions(code,label) VALUES ('users.manage','Gérer les utilisateurs, rôles et affectations');
INSERT INTO permissions(code,label) VALUES ('settings.view','Consulter les paramètres');
INSERT INTO permissions(code,label) VALUES ('settings.manage','Modifier les paramètres généraux');
INSERT INTO permissions(code,label) VALUES ('backup.manage','Créer et vérifier les sauvegardes');
INSERT INTO permissions(code,label) VALUES ('backup.restore','Restaurer une sauvegarde');
INSERT INTO permissions(code,label) VALUES ('migration.run','Exécuter la migration de données héritées');
INSERT INTO permissions(code,label) VALUES ('notifications.view','Consulter les notifications');

INSERT INTO roles(code,name) VALUES ('DG','Directeur Général');
INSERT INTO roles(code,name) VALUES ('RESPONSABLE','Responsable de Suivi');
INSERT INTO roles(code,name) VALUES ('ADMIN','Administrateur');

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r, permissions p WHERE r.code='DG' AND p.code IN ('accounts.sensitive','accounts.view','approvals.configure','approvals.decide','approvals.request','audit.view','books.view','cheques.create','cheques.edit','cheques.export','cheques.status','cheques.view','companies.view','counterparties.view','dashboard.view','documents.manage','documents.view','notifications.view','reconciliation.confirm','reconciliation.import','reconciliation.match','reconciliation.view','reports.export','reports.view','settings.view','transactions.manage','transactions.view','users.manage','users.view');

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r, permissions p WHERE r.code='RESPONSABLE' AND p.code IN ('accounts.view','approvals.request','books.manage','books.view','cheques.create','cheques.edit','cheques.export','cheques.status','cheques.view','companies.view','counterparties.manage','counterparties.view','dashboard.view','documents.manage','documents.view','notifications.view','reconciliation.import','reconciliation.match','reconciliation.view','reports.export','reports.view','transactions.manage','transactions.view');

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r, permissions p WHERE r.code='ADMIN' AND p.code IN ('accounts.manage','accounts.view','audit.view','backup.manage','backup.restore','banks.manage','books.manage','books.view','companies.manage','companies.view','counterparties.manage','counterparties.view','documents.manage','documents.view','migration.run','notifications.view','settings.manage','settings.view','users.manage','users.view');
INSERT INTO banks(name,short_name) VALUES
('BEA','Banque Extérieure d''Algérie'),
('BNA','Banque Nationale d''Algérie'),
('CPA','Crédit Populaire d''Algérie'),
('BADR','Banque de l''Agriculture et du Développement Rural'),
('BDL','Banque de Développement Local'),
('CNEP-Banque','CNEP'),
('SGA','Société Générale Algérie'),
('AGB','Arab Gulf Bank'),
('Trust Bank Algeria','Trust'),
('Gulf Bank Algeria','Gulf Bank'),
('Al Baraka Bank','Al Baraka'),
('CCP Algérie Poste','CCP'),
('Caisse interne','Caisse');

INSERT INTO app_settings(key,value) VALUES
('app.name','Suivi des Chèques'),
('app.locale','fr'),
('app.base_currency','DZD'),
('app.org_name','Groupe'),
('first_run_completed','false'),
('session.idle_timeout_minutes','15'),
('session.absolute_timeout_minutes','480'),
('security.max_login_attempts','5'),
('security.lock_minutes','15'),
('password.min_length','12'),
('approval.high_value_enabled','true'),
('approval.high_value_threshold_cents','50000000'),
('approval.require_cancel_finalized','true'),
('approval.require_amount_change','true'),
('approval.require_association_change','true'),
('approval.require_reconciliation_finalize','true'),
('approval.self_approval_allowed','false'),
('backup.auto_enabled','true'),
('backup.auto_interval_hours','24'),
('backup.retention','10'),
('reconciliation.auto_propose','true'),
('reconciliation.date_window_days','10'),
('cheque.presentation_deadline_days','20'),
('notifications.overdue_days','7'),
('reports.header','"Groupe — Direction Générale"'),
('migration.legacy_bank_default','"Banque (migration)"');
