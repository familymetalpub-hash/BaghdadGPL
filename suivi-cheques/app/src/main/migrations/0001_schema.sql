-- ============================================================================
-- Suivi des Chèques — schéma normalisé v1
-- Montants : entiers en centimes de DZD. Dates : AAAA-MM-JJ. Horodatages : UTC.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Référentiels
-- ---------------------------------------------------------------------------
CREATE TABLE companies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  legal_form      TEXT,
  nif             TEXT,
  nis             TEXT,
  rc              TEXT,
  ai              TEXT,
  manager_name    TEXT,
  capital_cents   INTEGER NOT NULL DEFAULT 0 CHECK (capital_cents >= 0),
  address         TEXT,
  wilaya          TEXT,
  phone           TEXT,
  email           TEXT,
  color           TEXT NOT NULL DEFAULT '#0f766e',
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  legacy_id       TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_companies_active ON companies(is_active);
CREATE UNIQUE INDEX idx_companies_nif ON companies(nif) WHERE nif IS NOT NULL AND nif <> '';
CREATE UNIQUE INDEX idx_companies_legacy ON companies(legacy_id) WHERE legacy_id IS NOT NULL;

CREATE TABLE banks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  short_name  TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_banks_name ON banks(name COLLATE NOCASE);

CREATE TABLE roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL
);

CREATE TABLE permissions (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  code  TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

CREATE TABLE role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE RESTRICT,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  username              TEXT NOT NULL,
  full_name             TEXT NOT NULL,
  email                 TEXT,
  password_hash         TEXT NOT NULL,
  role_id               INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  must_change_password  INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  failed_attempts       INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until          TEXT,
  last_login_at         TEXT,
  created_by            INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_users_username ON users(username COLLATE NOCASE);
CREATE INDEX idx_users_role ON users(role_id);

CREATE TABLE company_assignments (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, company_id)
);
CREATE INDEX idx_assignments_company ON company_assignments(company_id);

CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at           TEXT NOT NULL,
  idle_timeout_minutes INTEGER NOT NULL,
  revoked_at           TEXT,
  revoked_reason       TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE bank_accounts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  bank_id               INTEGER NOT NULL REFERENCES banks(id) ON DELETE RESTRICT,
  label                 TEXT NOT NULL,
  account_number        TEXT NOT NULL,
  rib                   TEXT,
  currency              TEXT NOT NULL DEFAULT 'DZD' CHECK (length(currency) = 3),
  opening_balance_cents INTEGER NOT NULL DEFAULT 0,
  opening_date          TEXT NOT NULL CHECK (length(opening_date) = 10),
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  legacy_id             TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, company_id),
  UNIQUE (company_id, bank_id, account_number)
);
CREATE INDEX idx_accounts_company ON bank_accounts(company_id);
CREATE INDEX idx_accounts_bank ON bank_accounts(bank_id);
CREATE UNIQUE INDEX idx_accounts_legacy ON bank_accounts(legacy_id) WHERE legacy_id IS NOT NULL;

CREATE TABLE counterparties (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'AUTRE' CHECK (type IN ('CLIENT','FOURNISSEUR','SALARIE','BANQUE','ORGANISME','AUTRE')),
  contact_name TEXT,
  phone        TEXT,
  email        TEXT,
  account_info TEXT,
  notes        TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_counterparties_name ON counterparties(company_id, name COLLATE NOCASE);
CREATE INDEX idx_counterparties_company ON counterparties(company_id);

-- ---------------------------------------------------------------------------
-- Chèques
-- ---------------------------------------------------------------------------
CREATE TABLE cheques (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  reference                TEXT NOT NULL UNIQUE,
  company_id               INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  account_id               INTEGER NOT NULL,
  direction                TEXT NOT NULL CHECK (direction IN ('EMIS','RECU')),
  cheque_type              TEXT NOT NULL DEFAULT 'ORDINAIRE'
                             CHECK (cheque_type IN ('ORDINAIRE','GARANTIE','CERTIFIE','BANCAIRE','CCP','AUTRE')),
  cheque_number            TEXT NOT NULL,
  cheque_number_normalized TEXT NOT NULL,
  counterparty_id          INTEGER REFERENCES counterparties(id) ON DELETE SET NULL,
  party_name               TEXT NOT NULL,
  amount_cents             INTEGER NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 9000000000000),
  currency                 TEXT NOT NULL DEFAULT 'DZD' CHECK (length(currency) = 3),
  issue_date               TEXT NOT NULL CHECK (length(issue_date) = 10),
  receipt_date             TEXT CHECK (receipt_date IS NULL OR length(receipt_date) = 10),
  due_date                 TEXT NOT NULL CHECK (length(due_date) = 10),
  deposit_date             TEXT CHECK (deposit_date IS NULL OR length(deposit_date) = 10),
  collection_date          TEXT CHECK (collection_date IS NULL OR length(collection_date) = 10),
  payment_date             TEXT CHECK (payment_date IS NULL OR length(payment_date) = 10),
  return_date              TEXT CHECK (return_date IS NULL OR length(return_date) = 10),
  cancellation_date        TEXT CHECK (cancellation_date IS NULL OR length(cancellation_date) = 10),
  status                   TEXT NOT NULL,
  status_changed_at        TEXT,
  manager_id               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes                    TEXT,
  endorsee                 TEXT,
  last_reason              TEXT,
  duplicate_override_reason TEXT,
  data_quality_flag        TEXT,
  is_archived              INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
  version                  INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  legacy_id                TEXT,
  FOREIGN KEY (account_id, company_id) REFERENCES bank_accounts(id, company_id) ON DELETE RESTRICT,
  UNIQUE (id, account_id, company_id),
  CHECK (
    (direction = 'RECU' AND status IN ('RECU','DEPOSE','ENCAISSE','ENDOSSE','IMPAYE','RETOURNE','LITIGE','ANNULE','A_REGULARISER'))
    OR
    (direction = 'EMIS' AND status IN ('EMIS','REMIS','PAYE','REJETE','IMPAYE','ANNULE','LITIGE','A_REGULARISER'))
  ),
  CHECK (status <> 'ENCAISSE' OR (direction = 'RECU' AND collection_date IS NOT NULL)),
  CHECK (status <> 'PAYE' OR (direction = 'EMIS' AND payment_date IS NOT NULL)),
  CHECK (status <> 'DEPOSE' OR deposit_date IS NOT NULL),
  CHECK (status <> 'ANNULE' OR cancellation_date IS NOT NULL),
  CHECK (status <> 'ENDOSSE' OR (endorsee IS NOT NULL AND length(trim(endorsee)) > 0))
);
CREATE INDEX idx_cheques_company ON cheques(company_id);
CREATE INDEX idx_cheques_account ON cheques(account_id);
CREATE INDEX idx_cheques_status ON cheques(status);
CREATE INDEX idx_cheques_due ON cheques(due_date);
CREATE INDEX idx_cheques_direction ON cheques(direction);
CREATE INDEX idx_cheques_manager ON cheques(manager_id);
CREATE INDEX idx_cheques_duplicate_key ON cheques(account_id, direction, cheque_number_normalized);
CREATE UNIQUE INDEX idx_cheques_legacy ON cheques(legacy_id) WHERE legacy_id IS NOT NULL;

CREATE TABLE cheque_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  cheque_id           INTEGER NOT NULL REFERENCES cheques(id) ON DELETE RESTRICT,
  event_type          TEXT NOT NULL CHECK (event_type IN ('CREATION','STATUS','MODIFICATION','IMPORT','RECONCILIATION','APPROBATION')),
  from_status         TEXT,
  to_status           TEXT,
  event_date          TEXT NOT NULL CHECK (length(event_date) = 10),
  reason              TEXT,
  actor_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approval_request_id INTEGER,
  metadata_json       TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_events_cheque ON cheque_events(cheque_id, created_at);
CREATE INDEX idx_events_date ON cheque_events(event_date);

CREATE TABLE cheque_books (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  account_id   INTEGER NOT NULL,
  label        TEXT,
  from_number  TEXT NOT NULL,
  to_number    TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (account_id, company_id) REFERENCES bank_accounts(id, company_id) ON DELETE RESTRICT,
  CHECK (CAST(to_number AS INTEGER) >= CAST(from_number AS INTEGER))
);
CREATE INDEX idx_books_account ON cheque_books(account_id);

-- ---------------------------------------------------------------------------
-- Transactions financières internes (hors lignes de relevé importées)
-- ---------------------------------------------------------------------------
CREATE TABLE transactions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  reference            TEXT NOT NULL UNIQUE,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  account_id           INTEGER NOT NULL,
  type                 TEXT NOT NULL CHECK (type IN ('DEPOT','RETRAIT','FRAIS','INTERETS','REMBOURSEMENT_PRET','TRANSFERT_SORTIE','TRANSFERT_ENTREE')),
  amount_cents         INTEGER NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 9000000000000),
  currency             TEXT NOT NULL DEFAULT 'DZD' CHECK (length(currency) = 3),
  effective_date       TEXT NOT NULL CHECK (length(effective_date) = 10),
  description          TEXT,
  counterparty_id      INTEGER REFERENCES counterparties(id) ON DELETE SET NULL,
  transfer_group_id    TEXT,
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  is_archived          INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
  legacy_id            TEXT,
  FOREIGN KEY (account_id, company_id) REFERENCES bank_accounts(id, company_id) ON DELETE RESTRICT,
  CHECK (
    (type IN ('TRANSFERT_SORTIE','TRANSFERT_ENTREE') AND transfer_group_id IS NOT NULL)
    OR (type NOT IN ('TRANSFERT_SORTIE','TRANSFERT_ENTREE') AND transfer_group_id IS NULL)
  )
);
CREATE INDEX idx_transactions_account ON transactions(account_id, effective_date);
CREATE INDEX idx_transactions_company ON transactions(company_id, effective_date);
CREATE INDEX idx_transactions_transfer ON transactions(transfer_group_id);
CREATE UNIQUE INDEX idx_transactions_legacy ON transactions(legacy_id) WHERE legacy_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Approbations
-- ---------------------------------------------------------------------------
CREATE TABLE approval_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reference       TEXT NOT NULL UNIQUE,
  company_id      INTEGER REFERENCES companies(id) ON DELETE RESTRICT,
  entity_type     TEXT NOT NULL CHECK (entity_type IN ('CHEQUE','COMPTE','SOCIETE','RAPPROCHEMENT','PARAMETRE')),
  entity_id       TEXT,
  operation       TEXT NOT NULL,
  title           TEXT NOT NULL,
  before_json     TEXT,
  after_json      TEXT NOT NULL,
  dedupe_key      TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  requested_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_by      INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  decided_at      TEXT,
  decision_reason TEXT,
  applied_at      TEXT,
  apply_error     TEXT,
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (status <> 'APPROVED' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX idx_approvals_status ON approval_requests(status, requested_at);
CREATE INDEX idx_approvals_company ON approval_requests(company_id);
CREATE INDEX idx_approvals_requester ON approval_requests(requested_by);
CREATE UNIQUE INDEX idx_approvals_pending_dedupe ON approval_requests(dedupe_key) WHERE status = 'PENDING' AND dedupe_key IS NOT NULL;

CREATE TABLE approval_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    INTEGER NOT NULL REFERENCES approval_requests(id) ON DELETE RESTRICT,
  action        TEXT NOT NULL CHECK (action IN ('SUBMIT','APPROVE','REJECT','CANCEL','APPLY','APPLY_FAILED')),
  actor_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reason        TEXT,
  metadata_json TEXT
);
CREATE INDEX idx_approval_events_request ON approval_events(request_id, at);

-- ---------------------------------------------------------------------------
-- Relevés bancaires, lignes et rapprochement
-- ---------------------------------------------------------------------------
CREATE TABLE bank_imports (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  account_id             INTEGER NOT NULL,
  source_type            TEXT NOT NULL CHECK (source_type IN ('CSV','XLSX','MANUAL')),
  source_filename        TEXT,
  source_sha256          TEXT,
  source_size            INTEGER,
  format_options_json    TEXT,
  statement_date         TEXT NOT NULL CHECK (length(statement_date) = 10),
  opening_balance_cents  INTEGER,
  closing_balance_cents  INTEGER NOT NULL,
  currency               TEXT NOT NULL DEFAULT 'DZD',
  row_count              INTEGER NOT NULL DEFAULT 0,
  imported_count         INTEGER NOT NULL DEFAULT 0,
  duplicate_count        INTEGER NOT NULL DEFAULT 0,
  rejected_count         INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','PARTIAL','MANUAL','FAILED')),
  imported_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  notes                  TEXT,
  FOREIGN KEY (account_id, company_id) REFERENCES bank_accounts(id, company_id) ON DELETE RESTRICT,
  UNIQUE (id, account_id, company_id)
);
CREATE INDEX idx_imports_account ON bank_imports(account_id, statement_date);
CREATE INDEX idx_imports_company ON bank_imports(company_id);

CREATE TABLE bank_import_issues (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id    INTEGER NOT NULL REFERENCES bank_imports(id) ON DELETE RESTRICT,
  row_number   INTEGER,
  severity     TEXT NOT NULL CHECK (severity IN ('ERROR','WARNING','INFO')),
  code         TEXT NOT NULL,
  message      TEXT NOT NULL,
  raw_json     TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_import_issues_import ON bank_import_issues(import_id, severity);

CREATE TABLE bank_transactions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id        INTEGER NOT NULL REFERENCES bank_imports(id) ON DELETE RESTRICT,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  account_id       INTEGER NOT NULL,
  bank_ref         TEXT,
  transaction_date TEXT NOT NULL CHECK (length(transaction_date) = 10),
  value_date       TEXT CHECK (value_date IS NULL OR length(value_date) = 10),
  description      TEXT,
  debit_cents      INTEGER NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents     INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  balance_cents    INTEGER,
  currency         TEXT NOT NULL DEFAULT 'DZD',
  row_number       INTEGER,
  fingerprint      TEXT NOT NULL,
  duplicate_of_id  INTEGER REFERENCES bank_transactions(id) ON DELETE RESTRICT,
  match_status     TEXT NOT NULL DEFAULT 'UNMATCHED' CHECK (match_status IN ('UNMATCHED','PROPOSED','MATCHED','IGNORED')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (account_id, company_id) REFERENCES bank_accounts(id, company_id) ON DELETE RESTRICT,
  UNIQUE (account_id, fingerprint),
  UNIQUE (id, account_id, company_id),
  CHECK (debit_cents = 0 OR credit_cents = 0),
  CHECK (debit_cents > 0 OR credit_cents > 0)
);
CREATE INDEX idx_bank_tx_account ON bank_transactions(account_id, transaction_date);
CREATE INDEX idx_bank_tx_match ON bank_transactions(match_status);
CREATE INDEX idx_bank_tx_import ON bank_transactions(import_id);

CREATE TABLE reconciliation_matches (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_transaction_id  INTEGER NOT NULL,
  cheque_id            INTEGER NOT NULL,
  company_id           INTEGER NOT NULL,
  account_id           INTEGER NOT NULL,
  amount_cents         INTEGER NOT NULL CHECK (amount_cents > 0),
  match_type           TEXT NOT NULL CHECK (match_type IN ('REFERENCE_EXACTE','MONTANT_DATE','PROBABLE','MANUEL')),
  status               TEXT NOT NULL DEFAULT 'PROPOSE' CHECK (status IN ('PROPOSE','CONFIRME','REJETE')),
  score                INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  proposed_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  proposed_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at           TEXT,
  reason               TEXT,
  settlement_applied   INTEGER NOT NULL DEFAULT 0 CHECK (settlement_applied IN (0,1)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (bank_transaction_id, account_id, company_id)
    REFERENCES bank_transactions(id, account_id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (cheque_id, account_id, company_id)
    REFERENCES cheques(id, account_id, company_id) ON DELETE RESTRICT
);
CREATE INDEX idx_matches_tx ON reconciliation_matches(bank_transaction_id);
CREATE INDEX idx_matches_cheque ON reconciliation_matches(cheque_id);
CREATE UNIQUE INDEX idx_matches_confirmed_tx ON reconciliation_matches(bank_transaction_id) WHERE status = 'CONFIRME';
CREATE UNIQUE INDEX idx_matches_confirmed_cheque ON reconciliation_matches(cheque_id) WHERE status = 'CONFIRME';
CREATE UNIQUE INDEX idx_matches_pending_pair ON reconciliation_matches(bank_transaction_id, cheque_id) WHERE status = 'PROPOSE';

-- ---------------------------------------------------------------------------
-- Documents, notifications, audit, paramètres, sauvegardes
-- ---------------------------------------------------------------------------
CREATE TABLE attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('CHEQUE','APPROBATION','IMPORT','SOCIETE')),
  entity_id     TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL UNIQUE,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  sha256        TEXT NOT NULL,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    TEXT
);
CREATE INDEX idx_attachments_entity ON attachments(entity_type, entity_id);
CREATE INDEX idx_attachments_company ON attachments(company_id);

CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  INTEGER REFERENCES companies(id) ON DELETE RESTRICT,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  entity_type TEXT,
  entity_id   TEXT,
  is_read     INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_notifications_user ON notifications(user_id, is_read, created_at);

CREATE TABLE audit_logs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id             INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  company_id          INTEGER REFERENCES companies(id) ON DELETE RESTRICT,
  entity_type         TEXT NOT NULL,
  entity_id           TEXT,
  action              TEXT NOT NULL,
  before_json         TEXT,
  after_json          TEXT,
  reason              TEXT,
  approval_request_id INTEGER REFERENCES approval_requests(id) ON DELETE RESTRICT,
  session_id          TEXT,
  source              TEXT NOT NULL DEFAULT 'DESKTOP',
  metadata_json       TEXT
);
CREATE INDEX idx_audit_at ON audit_logs(at);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_company ON audit_logs(company_id);
CREATE INDEX idx_audit_action ON audit_logs(action);

CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE legacy_imports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name    TEXT NOT NULL,
  source_sha256  TEXT NOT NULL UNIQUE,
  imported_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  imported_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  summary_json   TEXT NOT NULL
);

CREATE TABLE backup_history (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  filename             TEXT NOT NULL,
  path                 TEXT NOT NULL,
  size_bytes           INTEGER NOT NULL,
  sha256               TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('MANUAL','AUTO','PRE_RESTORE','PRE_MIGRATION')),
  verified             INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  verification_message TEXT,
  counts_json          TEXT,
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_backups_created ON backup_history(created_at);

CREATE TABLE sequence_counters (
  scope      TEXT NOT NULL,
  period     TEXT NOT NULL,
  last_value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, period)
);

-- ---------------------------------------------------------------------------
-- Triggers de protection : audit et historique non modifiables / supprimables
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'Piste d''audit immuable : modification interdite'); END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'Piste d''audit immuable : suppression interdite'); END;

CREATE TRIGGER trg_cheque_events_no_update BEFORE UPDATE ON cheque_events
BEGIN SELECT RAISE(ABORT, 'Historique des chèques immuable : modification interdite'); END;
CREATE TRIGGER trg_cheque_events_no_delete BEFORE DELETE ON cheque_events
BEGIN SELECT RAISE(ABORT, 'Historique des chèques immuable : suppression interdite'); END;

CREATE TRIGGER trg_approval_events_no_update BEFORE UPDATE ON approval_events
BEGIN SELECT RAISE(ABORT, 'Événements d''approbation immuables'); END;
CREATE TRIGGER trg_approval_events_no_delete BEFORE DELETE ON approval_events
BEGIN SELECT RAISE(ABORT, 'Événements d''approbation immuables'); END;

CREATE TRIGGER trg_cheques_no_delete BEFORE DELETE ON cheques
BEGIN SELECT RAISE(ABORT, 'Un chèque ne peut pas être supprimé physiquement'); END;
CREATE TRIGGER trg_transactions_no_delete BEFORE DELETE ON transactions
BEGIN SELECT RAISE(ABORT, 'Une transaction ne peut pas être supprimée physiquement'); END;
CREATE TRIGGER trg_bank_tx_no_delete BEFORE DELETE ON bank_transactions
BEGIN SELECT RAISE(ABORT, 'Une ligne de relevé ne peut pas être supprimée'); END;
CREATE TRIGGER trg_imports_no_delete BEFORE DELETE ON bank_imports
BEGIN SELECT RAISE(ABORT, 'Un import bancaire ne peut pas être supprimé'); END;
CREATE TRIGGER trg_matches_no_delete BEFORE DELETE ON reconciliation_matches
BEGIN SELECT RAISE(ABORT, 'Un rapprochement ne peut pas être supprimé'); END;
CREATE TRIGGER trg_companies_no_delete BEFORE DELETE ON companies
BEGIN SELECT RAISE(ABORT, 'Une société ne peut pas être supprimée'); END;
CREATE TRIGGER trg_accounts_no_delete BEFORE DELETE ON bank_accounts
BEGIN SELECT RAISE(ABORT, 'Un compte bancaire ne peut pas être supprimé'); END;
CREATE TRIGGER trg_users_no_delete BEFORE DELETE ON users
BEGIN SELECT RAISE(ABORT, 'Un utilisateur ne peut pas être supprimé'); END;

-- Un chèque déjà réglé ne peut pas redevenir « en attente » sans passer par le
-- service d'approbation, qui journalise et trace la correction.
CREATE TRIGGER trg_cheques_transition_guard
BEFORE UPDATE OF status ON cheques
WHEN OLD.status = 'ANNULE'
BEGIN SELECT RAISE(ABORT, 'Un chèque annulé est définitif'); END;
