'use strict';

const path = require('node:path');
const fs = require('node:fs');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { assertPermission, resolveCompanyScope, validationError, forbidden } = require('./authorization');
const { getSetting } = require('./settings');
const { todayISO, formatFR, assertISODate, addDays } = require('../../shared/dates');
const { formatCents } = require('../../shared/money');
const { buildCsv, escapeCsvCell, sanitizeSpreadsheetText } = require('../../shared/csv');
const { statusLabel, DIRECTIONS } = require('../../shared/status');

const REPORTS = {
  company_summary: { title: 'Rapport par société', category: 'Synthèse' },
  bank_accounts: { title: 'Rapport banques et comptes', category: 'Trésorerie' },
  cheques_issued: { title: 'Chèques émis', category: 'Chèques' },
  cheques_received: { title: 'Chèques reçus', category: 'Chèques' },
  cheques_pending: { title: 'Chèques en cours', category: 'Chèques' },
  cheques_due: { title: 'Échéances et retards', category: 'Chèques' },
  cheques_rejected: { title: 'Chèques rejetés et impayés', category: 'Chèques' },
  approvals: { title: 'Rapport des approbations', category: 'Contrôle' },
  reconciliation: { title: 'Rapport de rapprochement bancaire', category: 'Trésorerie' },
  manager_activity: { title: 'Activité des responsables de suivi', category: 'Contrôle' },
  company_comparison: { title: 'Comparaison multi-sociétés', category: 'Synthèse' },
  audit: { title: 'Rapport d’audit', category: 'Contrôle' },
};

const DATE_COLUMNS = new Set(['date', 'money', 'integer']);

function catalogue() {
  return Object.entries(REPORTS).map(([code, r]) => ({ code, ...r }));
}

function cols(list) {
  return list.map(([key, label, type = 'text', width = 16]) => ({ key, label, type, width }));
}

function formatReportDate(value) {
  return value ? formatFR(String(value).slice(0, 10)) : '';
}

function sumMoney(rows, key) {
  return rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
}

function resolveFilterScope(db, ctx, filters) {
  const ids = resolveCompanyScope(ctx, filters.companyIds);
  if (!ids.length) return { ids, label: 'Aucune société autorisée' };
  const names = db
    .prepare(`SELECT name FROM companies WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name`)
    .all(...ids)
    .map((r) => r.name);
  return { ids, label: names.join(', ') };
}

function dateRangeLabel(from, to) {
  if (!from && !to) return 'Toutes dates';
  return `${from ? formatFR(from) : '…'} → ${to ? formatFR(to) : '…'}`;
}

function getReportData(db, ctx, input = {}) {
  assertPermission(ctx, 'reports.view');
  const type = String(input.type || '');
  if (!REPORTS[type]) throw validationError('Type de rapport inconnu');
  const f = input.filters || {};
  if (f.dateFrom) assertISODate(String(f.dateFrom), 'Date de début');
  if (f.dateTo) assertISODate(String(f.dateTo), 'Date de fin');
  if (f.dateFrom && f.dateTo && f.dateFrom > f.dateTo) throw validationError('Période invalide');
  const asOf = String(f.asOf || todayISO());
  assertISODate(asOf, 'Date d’arrêté');
  const scope = resolveFilterScope(db, ctx, f);
  const generatedAt = new Date().toISOString();
  const base = {
    type,
    title: REPORTS[type].title,
    category: REPORTS[type].category,
    asOf,
    generatedAt,
    orgName: getSetting(db, 'app.org_name', 'Groupe'),
    reportHeader: getSetting(db, 'reports.header', 'Groupe — Direction Générale'),
    generatedBy: ctx.user.fullName,
    filtersLabel: `Sociétés : ${scope.label} · Période : ${dateRangeLabel(f.dateFrom, f.dateTo)}`,
    columns: [],
    rows: [],
    totals: {},
    warnings: [],
  };

  if (type === 'company_summary' || type === 'company_comparison') {
    const finance = require('./finance');
    const comparison = finance.companyComparison(db, ctx, { companyIds: scope.ids, asOf });
    base.columns = cols([
      ['company', 'Société', 'text', 24],
      ['code', 'Code', 'text', 10],
      ['accounts', 'Comptes', 'integer', 8],
      ['cheques', 'Chèques', 'integer', 8],
      ['bookBalanceCents', 'Solde comptable', 'money', 16],
      ['pendingIncomingCents', 'Encaissements en cours', 'money', 16],
      ['pendingOutgoingCents', 'Paiements en cours', 'money', 16],
      ['forecastBalanceCents', 'Prévisionnel', 'money', 16],
      ['statementBalanceCents', 'Soldes relevés (comptes couverts)', 'money', 20],
      ['accountsWithoutStatement', 'Comptes sans relevé', 'integer', 10],
      ['rejectedCount', 'Rejetés/impayés', 'integer', 10],
      ['overdueCount', 'En retard', 'integer', 8],
    ]);
    base.rows = comparison.rows.map((r) => ({
      ...r,
      company: r.name,
      accounts: r.accountsCount,
      cheques: r.chequeCount,
      overdueCount: undefined,
    }));
    // Nombre de retards par société pour le rapport de synthèse.
    for (const row of base.rows) {
      row.overdueCount = db
        .prepare(
          `SELECT COUNT(*) AS n FROM cheques WHERE company_id=? AND is_archived=0
           AND status IN ('RECU','DEPOSE','EMIS','REMIS') AND due_date < ?`
        )
        .get(row.companyId, asOf).n;
    }
    base.totals = {
      bookBalanceCents: sumMoney(base.rows, 'bookBalanceCents'),
      pendingIncomingCents: sumMoney(base.rows, 'pendingIncomingCents'),
      pendingOutgoingCents: sumMoney(base.rows, 'pendingOutgoingCents'),
      forecastBalanceCents: sumMoney(base.rows, 'forecastBalanceCents'),
      statementBalanceCents: sumMoney(base.rows, 'statementBalanceCents'),
      accounts: sumMoney(base.rows, 'accounts'),
      cheques: sumMoney(base.rows, 'cheques'),
      rejectedCount: sumMoney(base.rows, 'rejectedCount'),
      overdueCount: sumMoney(base.rows, 'overdueCount'),
      accountsWithoutStatement: sumMoney(base.rows, 'accountsWithoutStatement'),
    };
    base.warnings.push('Le solde des relevés ne couvre que les comptes ayant un relevé importé ; il ne s’additionne pas au solde comptable.');
    return base;
  }

  if (type === 'bank_accounts') {
    const finance = require('./finance');
    const data = finance.getAccountBalances(db, ctx, { companyIds: scope.ids, asOf, includeInactive: true });
    base.columns = cols([
      ['company', 'Société', 'text', 22],
      ['bank', 'Banque', 'text', 16],
      ['account', 'Compte', 'text', 22],
      ['number', 'Numéro masqué', 'text', 14],
      ['openingDate', 'Ouverture', 'date', 12],
      ['openingCents', 'Solde d’ouverture', 'money', 16],
      ['bookCents', 'Solde comptable', 'money', 16],
      ['statementDate', 'Date relevé', 'date', 12],
      ['statementCents', 'Solde relevé', 'money', 16],
      ['varianceCents', 'Écart relevé − comptable', 'money', 18],
      ['pendingInCents', 'Encaissements en cours', 'money', 16],
      ['pendingOutCents', 'Paiements en cours', 'money', 16],
      ['forecastCents', 'Prévisionnel', 'money', 16],
      ['unmatched', 'Lignes non rapprochées', 'integer', 12],
    ]);
    // Les numéros complets ne sont jamais exportés.
    base.rows = data.accounts.map((a) => ({
      company: a.companyName,
      bank: a.bankName,
      account: a.accountLabel,
      number: a.accountNumberMasked || '',
      openingDate: a.openingDate,
      openingCents: a.openingBalanceCents,
      bookCents: a.bookBalanceCents,
      statementDate: a.statement ? a.statement.statementDate : '',
      statementCents: a.statement ? a.statement.closingBalanceCents : null,
      varianceCents: a.statement ? a.statement.differenceCents : null,
      pendingInCents: a.pendingIncomingCents,
      pendingOutCents: a.pendingOutgoingCents,
      forecastCents: a.forecastBalanceCents,
      unmatched: a.unmatchedBankTransactions,
    }));
    base.totals = {
      openingCents: sumMoney(base.rows, 'openingCents'),
      bookCents: sumMoney(base.rows, 'bookCents'),
      statementCents: sumMoney(base.rows, 'statementCents'),
      varianceCents: sumMoney(base.rows, 'varianceCents'),
      pendingInCents: sumMoney(base.rows, 'pendingInCents'),
      pendingOutCents: sumMoney(base.rows, 'pendingOutCents'),
      forecastCents: sumMoney(base.rows, 'forecastCents'),
      unmatched: sumMoney(base.rows, 'unmatched'),
    };
    base.warnings.push('Le solde relevé est daté ; l’écart est calculé contre le solde comptable à la même date de relevé.');
    return base;
  }

  if (type.startsWith('cheques_')) {
    assertPermission(ctx, 'cheques.view');
    const cheques = require('./cheques');
    const options = {
      companyIds: scope.ids,
      accountId: f.accountId || undefined,
      managerId: f.managerId || undefined,
      search: f.search || undefined,
      pageSize: 200,
    };
    let columns;
    if (type === 'cheques_issued') {
      options.direction = 'EMIS';
      options.issueFrom = f.dateFrom || undefined;
      options.issueTo = f.dateTo || undefined;
    } else if (type === 'cheques_received') {
      options.direction = 'RECU';
      options.issueFrom = f.dateFrom || undefined;
      options.issueTo = f.dateTo || undefined;
    } else if (type === 'cheques_pending') {
      options.pendingOnly = true;
      options.dueFrom = f.dateFrom || undefined;
      options.dueTo = f.dateTo || undefined;
    } else if (type === 'cheques_due') {
      options.pendingOnly = true;
      options.dueTo = f.dateTo || addDays(asOf, 30);
      options.dueFrom = f.dateFrom || undefined;
      if (f.onlyOverdue) options.overdueAsOf = asOf;
    } else {
      options.statuses = ['REJETE', 'IMPAYE', 'RETOURNE'];
      options.issueFrom = f.dateFrom || undefined;
      options.issueTo = f.dateTo || undefined;
    }
    const rows = cheques.allCheques(db, ctx, options);
    base.columns = cols([
      ['reference', 'Référence', 'text', 15],
      ['company', 'Société', 'text', 20],
      ['direction', 'Sens', 'text', 8],
      ['account', 'Compte', 'text', 18],
      ['number', 'N° chèque', 'text', 11],
      ['party', 'Bénéficiaire / Émetteur', 'text', 22],
      ['amountCents', 'Montant', 'money', 15],
      ['issueDate', 'Émission', 'date', 11],
      ['dueDate', 'Échéance', 'date', 11],
      ['settlementDate', 'Règlement réel', 'date', 12],
      ['status', 'Statut', 'text', 14],
      ['manager', 'Gestionnaire', 'text', 18],
      ['overdueDays', 'Jours de retard', 'integer', 9],
    ]);
    const today = asOf;
    base.rows = rows.map((r) => ({
      id: r.id,
      reference: r.reference,
      company: r.companyName,
      direction: r.directionLabel,
      account: `${r.bankName} — ${r.accountLabel}`,
      number: r.chequeNumber,
      party: r.partyName,
      amountCents: r.amountCents,
      issueDate: r.issueDate,
      dueDate: r.dueDate,
      settlementDate: r.settlementDate || '',
      status: r.statusLabel,
      manager: r.managerName || '',
      overdueDays:
        ['RECU', 'DEPOSE', 'EMIS', 'REMIS'].includes(r.status) && r.dueDate < today
          ? Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${r.dueDate}T00:00:00Z`)) / 86400000)
          : 0,
    }));
    base.totals = { amountCents: sumMoney(base.rows, 'amountCents'), count: base.rows.length };
    if (type === 'cheques_due') base.warnings.push('Les jours de retard sont calculés à la date d’arrêté. Les dates d’échéance ne valent pas dates de règlement.');
    return base;
  }

  if (type === 'approvals') {
    const approvals = require('./approvals');
    const all = [];
    let page = 1;
    for (;;) {
      const chunk = approvals.listRequests(db, ctx, {
        companyIds: scope.ids,
        status: f.status || 'ALL',
        search: f.search || undefined,
        page,
        pageSize: 100,
      });
      all.push(...chunk.items);
      if (page >= chunk.pageCount || page >= 100) break;
      page += 1;
    }
    const filtered = all.filter((r) => {
      const day = String(r.requestedAt).slice(0, 10);
      if (f.dateFrom && day < f.dateFrom) return false;
      if (f.dateTo && day > f.dateTo) return false;
      return true;
    });
    base.columns = cols([
      ['reference', 'Référence', 'text', 15],
      ['requestedAt', 'Soumise le', 'date', 12],
      ['company', 'Société', 'text', 20],
      ['operation', 'Opération', 'text', 22],
      ['title', 'Objet', 'text', 34],
      ['requester', 'Demandeur', 'text', 18],
      ['status', 'Statut', 'text', 12],
      ['decidedAt', 'Décidée le', 'date', 12],
      ['decider', 'Décideur', 'text', 18],
      ['reason', 'Motif', 'text', 30],
    ]);
    base.rows = filtered.map((r) => ({
      reference: r.reference,
      requestedAt: String(r.requestedAt).slice(0, 10),
      company: r.companyName || '—',
      operation: r.operationLabel,
      title: r.title,
      requester: r.requesterName,
      status: r.status === 'PENDING' ? 'En attente' : r.status === 'APPROVED' ? 'Approuvée' : r.status === 'REJECTED' ? 'Rejetée' : 'Annulée',
      decidedAt: r.decidedAt ? String(r.decidedAt).slice(0, 10) : '',
      decider: r.deciderName || '',
      reason: r.decisionReason || '',
    }));
    base.totals = { count: base.rows.length };
    return base;
  }

  if (type === 'reconciliation') {
    assertPermission(ctx, 'reconciliation.view');
    const finance = require('./finance');
    const data = finance.getAccountBalances(db, ctx, {
      companyIds: scope.ids,
      asOf,
      accountId: f.accountId || undefined,
      includeInactive: true,
    });
    base.columns = cols([
      ['company', 'Société', 'text', 22],
      ['bank', 'Banque', 'text', 16],
      ['account', 'Compte', 'text', 22],
      ['statementDate', 'Date relevé', 'date', 12],
      ['statementCents', 'Solde relevé', 'money', 16],
      ['bookCents', 'Solde comptable à la date', 'money', 20],
      ['differenceCents', 'Écart', 'money', 14],
      ['unmatched', 'Lignes non rapprochées', 'integer', 12],
      ['unmatchedDebitsCents', 'Débits non rapprochés', 'money', 18],
      ['unmatchedCreditsCents', 'Crédits non rapprochés', 'money', 18],
      ['pendingCount', 'Chèques en cours', 'integer', 10],
      ['pendingInCents', 'Encaissements en cours', 'money', 16],
      ['pendingOutCents', 'Paiements en cours', 'money', 16],
    ]);
    base.rows = data.accounts.map((a) => ({
      company: a.companyName,
      bank: a.bankName,
      account: a.accountLabel,
      statementDate: a.statement ? a.statement.statementDate : '',
      statementCents: a.statement ? a.statement.closingBalanceCents : null,
      bookCents: a.statement ? a.statement.bookAtStatementDateCents : null,
      differenceCents: a.statement ? a.statement.differenceCents : null,
      unmatched: a.unmatchedBankTransactions,
      unmatchedDebitsCents: a.unmatchedDebitsCents,
      unmatchedCreditsCents: a.unmatchedCreditsCents,
      pendingCount: a.pendingCount,
      pendingInCents: a.pendingIncomingCents,
      pendingOutCents: a.pendingOutgoingCents,
    }));
    base.totals = {
      statementCents: sumMoney(base.rows, 'statementCents'),
      bookCents: sumMoney(base.rows, 'bookCents'),
      differenceCents: sumMoney(base.rows, 'differenceCents'),
      unmatched: sumMoney(base.rows, 'unmatched'),
      pendingCount: sumMoney(base.rows, 'pendingCount'),
    };
    base.warnings.push('Un écart nul ne prouve pas l’absence d’anomalies : vérifiez les lignes non rapprochées et les chèques en cours.');
    return base;
  }

  if (type === 'manager_activity') {
    assertPermission(ctx, 'cheques.view');
    const users = db
      .prepare(
        `SELECT u.id, u.full_name, r.code AS role
         FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.is_active = 1 AND r.code IN ('DG','RESPONSABLE')
         ORDER BY u.full_name`
      )
      .all();
    const from = f.dateFrom || null;
    const to = f.dateTo || asOf;
    const ph = scope.ids.map(() => '?').join(',') || 'NULL';
    base.columns = cols([
      ['manager', 'Responsable', 'text', 24],
      ['role', 'Rôle', 'text', 16],
      ['assignedCheques', 'Chèques affectés', 'integer', 10],
      ['createdCheques', 'Chèques créés', 'integer', 10],
      ['statusEvents', 'Événements de statut', 'integer', 12],
      ['settledCount', 'Chèques réglés', 'integer', 10],
      ['settledAmountCents', 'Montant réglé', 'money', 16],
      ['imports', 'Imports bancaires', 'integer', 10],
      ['transactions', 'Transactions', 'integer', 10],
      ['lastActivity', 'Dernière activité', 'date', 12],
    ]);
    base.rows = users.map((u) => {
      const assigned = db
        .prepare(`SELECT COUNT(*) AS n FROM cheques WHERE company_id IN (${ph}) AND manager_id=? AND is_archived=0`)
        .get(...scope.ids, u.id).n;
      const created = db
        .prepare(
          `SELECT COUNT(*) AS n FROM cheques WHERE company_id IN (${ph}) AND created_by=? AND is_archived=0
           AND substr(created_at,1,10) BETWEEN ? AND ?`
        )
        .get(...scope.ids, u.id, from || '0000-01-01', to).n;
      const events = db
        .prepare(
          `SELECT COUNT(*) AS n FROM cheque_events e JOIN cheques ch ON ch.id = e.cheque_id
           WHERE ch.company_id IN (${ph}) AND e.actor_id=? AND e.event_date BETWEEN ? AND ?`
        )
        .get(...scope.ids, u.id, from || '0000-01-01', to).n;
      const settled = db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS total FROM cheques
           WHERE company_id IN (${ph}) AND manager_id=? AND is_archived=0
             AND ((direction='RECU' AND status='ENCAISSE' AND collection_date BETWEEN ? AND ?)
               OR (direction='EMIS' AND status='PAYE' AND payment_date BETWEEN ? AND ?))`
        )
        .get(...scope.ids, u.id, from || '0000-01-01', to, from || '0000-01-01', to);
      const imports = db
        .prepare(
          `SELECT COUNT(*) AS n FROM bank_imports WHERE company_id IN (${ph}) AND imported_by=?
           AND substr(created_at,1,10) BETWEEN ? AND ?`
        )
        .get(...scope.ids, u.id, from || '0000-01-01', to).n;
      const transactions = db
        .prepare(
          `SELECT COUNT(*) AS n FROM transactions WHERE company_id IN (${ph}) AND created_by=?
           AND effective_date BETWEEN ? AND ?`
        )
        .get(...scope.ids, u.id, from || '0000-01-01', to).n;
      const last = db
        .prepare(
          `SELECT MAX(d) AS d FROM (
             SELECT MAX(at) AS d FROM audit_logs WHERE user_id = ?
             UNION ALL SELECT MAX(e.created_at) FROM cheque_events e JOIN cheques ch ON ch.id=e.cheque_id
               WHERE ch.company_id IN (${ph}) AND e.actor_id = ?
             UNION ALL SELECT MAX(created_at) FROM bank_imports WHERE company_id IN (${ph}) AND imported_by = ?
           )`
        )
        .get(u.id, ...scope.ids, u.id, ...scope.ids, u.id);
      return {
        manager: u.full_name,
        role: u.role === 'DG' ? 'Directeur Général' : 'Responsable de Suivi',
        assignedCheques: assigned,
        createdCheques: created,
        statusEvents: events,
        settledCount: settled.n,
        settledAmountCents: settled.total,
        imports,
        transactions,
        lastActivity: last && last.d ? String(last.d).slice(0, 10) : '',
      };
    });
    base.totals = {
      assignedCheques: sumMoney(base.rows, 'assignedCheques'),
      createdCheques: sumMoney(base.rows, 'createdCheques'),
      statusEvents: sumMoney(base.rows, 'statusEvents'),
      settledCount: sumMoney(base.rows, 'settledCount'),
      settledAmountCents: sumMoney(base.rows, 'settledAmountCents'),
      imports: sumMoney(base.rows, 'imports'),
      transactions: sumMoney(base.rows, 'transactions'),
    };
    return base;
  }

  if (type === 'audit') {
    assertPermission(ctx, 'audit.view');
    const audit = require('./audit');
    const rows = audit.auditForExport(db, ctx, {
      companyIds: f.companyIds,
      dateFrom: f.dateFrom,
      dateTo: f.dateTo,
      entityType: f.entityType,
      search: f.search,
    });
    base.columns = cols([
      ['at', 'Horodatage', 'date', 18],
      ['user', 'Utilisateur', 'text', 18],
      ['company', 'Société', 'text', 18],
      ['entityType', 'Type', 'text', 12],
      ['entityId', 'Identifiant', 'text', 10],
      ['action', 'Action', 'text', 22],
      ['reason', 'Motif', 'text', 30],
      ['before', 'Avant', 'text', 40],
      ['after', 'Après', 'text', 40],
    ]);
    base.rows = rows.map((r) => ({
      at: String(r.at).slice(0, 19).replace('T', ' '),
      user: r.userFullName || r.username || 'Système',
      company: r.companyName || '—',
      entityType: r.entityType,
      entityId: r.entityId || '',
      action: r.action,
      reason: r.reason || '',
      before: r.before ? JSON.stringify(r.before).slice(0, 500) : '',
      after: r.after ? JSON.stringify(r.after).slice(0, 500) : '',
    }));
    base.totals = { count: base.rows.length };
    return base;
  }

  throw validationError('Rapport non implémenté');
}

function renderCell(data, column, value) {
  if (value === null || value === undefined || value === '') return '';
  if (column.type === 'money') return formatCents(Number(value));
  if (column.type === 'date') {
    if (column.key === 'at' || column.key === 'lastActivity') return String(value).length > 10 ? String(value).slice(0, 16) : formatFR(value);
    return formatReportDate(value);
  }
  if (column.type === 'integer') return Number(value).toLocaleString('fr-FR');
  return String(value);
}

function totalsRow(data) {
  const first = data.columns[0];
  const row = {};
  for (const column of data.columns) {
    if (column.type === 'money' || column.type === 'integer') {
      const total = data.totals[column.key];
      row[column.key] = total === undefined ? '' : total;
    } else {
      row[column.key] = '';
    }
  }
  row[first.key] = 'TOTAL';
  return row;
}

function exportCsv(data) {
  const headers = data.columns.map((c) => escapeCsvCell(c.label, { protectFormula: true, delimiter: ';' }));
  const cellFor = (column, value) => {
    if (value === null || value === undefined || value === '') return '';
    if (column.type === 'money') return (Number(value) / 100).toFixed(2).replace('.', ',');
    if (column.type === 'integer') return String(Number(value));
    if (column.type === 'date') return escapeCsvCell(renderCell(data, column, value), { protectFormula: true, delimiter: ';' });
    return escapeCsvCell(String(value), { protectFormula: true, delimiter: ';' });
  };
  const lines = [headers.join(';')];
  for (const row of data.rows) {
    lines.push(data.columns.map((column) => cellFor(column, row[column.key])).join(';'));
  }
  if (Object.keys(data.totals).length) {
    const total = totalsRow(data);
    lines.push(data.columns.map((column, index) => (index === 0 ? 'TOTAL' : cellFor(column, total[column.key]))).join(';'));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

async function exportXlsx(data) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Suivi des Chèques';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Rapport', { views: [{ state: 'frozen', ySplit: 6 }] });
  const columnCount = Math.max(1, data.columns.length);
  sheet.mergeCells(1, 1, 1, columnCount);
  sheet.getCell(1, 1).value = data.title;
  sheet.getCell(1, 1).font = { bold: true, size: 16, color: { argb: 'FF0F5132' } };
  sheet.mergeCells(2, 1, 2, columnCount);
  sheet.getCell(2, 1).value = data.reportHeader;
  sheet.getCell(2, 1).font = { bold: true, size: 11 };
  sheet.mergeCells(3, 1, 3, columnCount);
  sheet.getCell(3, 1).value = `Généré le ${formatFR(data.generatedAt.slice(0, 10))} à ${data.generatedAt.slice(11, 16)} par ${data.generatedBy} · ${data.filtersLabel}`;
  sheet.getCell(3, 1).font = { size: 9, italic: true, color: { argb: 'FF555555' } };
  sheet.getCell(4, 1).value = `Arrêté au ${formatFR(data.asOf)}`;
  sheet.getCell(4, 1).font = { size: 9, italic: true };
  const headerRow = 6;
  data.columns.forEach((column, index) => {
    const cell = sheet.getCell(headerRow, index + 1);
    cell.value = column.label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F5132' } };
    cell.alignment = { vertical: 'middle', horizontal: column.type === 'money' || column.type === 'integer' ? 'right' : 'left', wrapText: true };
    sheet.getColumn(index + 1).width = Math.max(9, Math.min(45, column.width || 14));
  });
  sheet.getRow(headerRow).height = 30;
  let rowIndex = headerRow + 1;
  for (const row of data.rows) {
    data.columns.forEach((column, index) => {
      const cell = sheet.getCell(rowIndex, index + 1);
      const value = row[column.key];
      if (value === null || value === undefined || value === '') {
        cell.value = '';
      } else if (column.type === 'money') {
        cell.value = Number(value) / 100;
        cell.numFmt = '#,##0.00';
        cell.alignment = { horizontal: 'right' };
      } else if (column.type === 'integer') {
        cell.value = Number(value);
        cell.alignment = { horizontal: 'right' };
      } else if (column.type === 'date') {
        cell.value = renderCell(data, column, value);
      } else {
        cell.value = sanitizeSpreadsheetText(value);
      }
      cell.font = { size: 9 };
    });
    rowIndex += 1;
  }
  if (Object.keys(data.totals).length) {
    const total = totalsRow(data);
    sheet.getRow(rowIndex).font = { bold: true, size: 9 };
    sheet.getRow(rowIndex).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F1EC' } };
    data.columns.forEach((column, index) => {
      const cell = sheet.getCell(rowIndex, index + 1);
      const value = total[column.key];
      if (column.type === 'money' && value !== '') {
        cell.value = Number(value) / 100;
        cell.numFmt = '#,##0.00';
        cell.alignment = { horizontal: 'right' };
      } else if (column.type === 'integer' && value !== '') {
        cell.value = Number(value);
        cell.alignment = { horizontal: 'right' };
      } else {
        cell.value = value === '' ? '' : String(value);
      }
    });
    rowIndex += 1;
  }
  rowIndex += 1;
  for (const warning of data.warnings || []) {
    sheet.mergeCells(rowIndex, 1, rowIndex, columnCount);
    sheet.getCell(rowIndex, 1).value = `⚠ ${warning}`;
    sheet.getCell(rowIndex, 1).font = { size: 9, italic: true, color: { argb: 'FF8A5A00' } };
    rowIndex += 1;
  }
  if (data.rows.length) {
    sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow + data.rows.length, column: columnCount } };
  }
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };
  sheet.headerFooter.oddFooter = '&LSuivi des Chèques — document interne&C&P / &N&R' + data.title;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function truncatePdfText(doc, text, font, size, width) {
  const value = String(text ?? '');
  doc.font(font).fontSize(size);
  if (doc.widthOfString(value) <= width) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (doc.widthOfString(value.slice(0, mid) + '…') <= width) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, Math.max(0, low)) + '…';
}

async function exportPdf(data, options = {}) {
  const fontRegular = path.join(__dirname, '../../../assets/fonts/DejaVuSans.ttf');
  const fontBold = path.join(__dirname, '../../../assets/fonts/DejaVuSans-Bold.ttf');
  if (!fs.existsSync(fontRegular)) throw new Error('Police PDF locale absente');
  const pdfMaxRows = options.maxRows || 5000;
  const rows = data.rows.slice(0, pdfMaxRows);
  const truncated = data.rows.length > rows.length;
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margin: 28,
        bufferPages: true,
        info: { Title: data.title, Author: 'Suivi des Chèques', Subject: 'Rapport interne' },
      });
      doc.registerFont('DejaVu', fontRegular);
      doc.registerFont('DejaVu-Bold', fontBold);
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const pageWidth = doc.page.width - 56;
      const pageHeight = doc.page.height;
      const totalWeight = data.columns.reduce((s, c) => s + (c.width || 14), 0);
      const widths = data.columns.map((c) => Math.max(34, ((c.width || 14) / totalWeight) * pageWidth));
      const scale = pageWidth / widths.reduce((s, w) => s + w, 0);
      const colWidths = widths.map((w) => w * scale);
      const fontSize = 7.2;
      const rowHeight = 15;

      const drawHeader = (isFirst) => {
        if (isFirst) {
          doc.font('DejaVu-Bold').fontSize(16).fillColor('#0f5132').text(data.title, 28, 26, { width: pageWidth });
          doc.font('DejaVu').fontSize(9).fillColor('#333333').text(data.reportHeader, 28, 48);
          doc.fontSize(8).fillColor('#555555').text(
            `Généré le ${formatFR(data.generatedAt.slice(0, 10))} à ${data.generatedAt.slice(11, 16)} par ${data.generatedBy} · Arrêté au ${formatFR(data.asOf)}`,
            28,
            63
          );
          doc.text(data.filtersLabel, 28, 75, { width: pageWidth });
          doc.moveTo(28, 90).lineTo(doc.page.width - 28, 90).strokeColor('#0f5132').lineWidth(0.8).stroke();
        }
        const y = isFirst ? 100 : 40;
        doc.font('DejaVu-Bold').fontSize(7.2).fillColor('#ffffff');
        doc.rect(28, y, pageWidth, 18).fill('#0f5132');
        let x = 28;
        data.columns.forEach((column, index) => {
          doc.fillColor('#ffffff').text(
            truncatePdfText(doc, column.label, 'DejaVu-Bold', 7.2, colWidths[index] - 6),
            x + 3,
            y + 5,
            { width: colWidths[index] - 6, align: column.type === 'money' || column.type === 'integer' ? 'right' : 'left', lineBreak: false }
          );
          x += colWidths[index];
        });
        return y + 18;
      };

      if (data.rows.length === 0) {
        doc.font('DejaVu').fontSize(10).fillColor('#333333').text('Aucune donnée pour les filtres sélectionnés.', 28, 120);
      }
      let y = drawHeader(true);
      let index = 0;
      for (const row of rows) {
        if (y + rowHeight > pageHeight - 44) {
          doc.addPage();
          y = drawHeader(false);
        }
        if (index % 2 === 1) {
          doc.rect(28, y, pageWidth, rowHeight).fill('#f4f7f5');
        }
        let x = 28;
        data.columns.forEach((column, cIndex) => {
          const raw = row[column.key];
          let text;
          if (column.type === 'money') text = raw === null || raw === undefined || raw === '' ? '' : formatCents(Number(raw));
          else if (column.type === 'integer') text = raw === null || raw === undefined || raw === '' ? '' : String(raw);
          else if (column.type === 'date') text = renderCell(data, column, raw);
          else text = raw === null || raw === undefined ? '' : String(raw);
          text = truncatePdfText(doc, text, 'DejaVu', fontSize, colWidths[cIndex] - 6);
          doc.font('DejaVu').fontSize(fontSize).fillColor('#222222').text(text, x + 3, y + 4, {
            width: colWidths[cIndex] - 6,
            align: column.type === 'money' || column.type === 'integer' ? 'right' : 'left',
            lineBreak: false,
          });
          x += colWidths[cIndex];
        });
        doc.moveTo(28, y + rowHeight).lineTo(doc.page.width - 28, y + rowHeight).strokeColor('#e1e6e3').lineWidth(0.3).stroke();
        y += rowHeight;
        index += 1;
      }
      if (Object.keys(data.totals).length && rows.length) {
        if (y + 22 > pageHeight - 44) {
          doc.addPage();
          y = drawHeader(false);
        }
        doc.rect(28, y, pageWidth, 20).fill('#e8f1ec');
        const total = totalsRow(data);
        let x = 28;
        data.columns.forEach((column, cIndex) => {
          const raw = total[column.key];
          const text =
            column.type === 'money' && raw !== ''
              ? formatCents(Number(raw))
              : column.type === 'integer' && raw !== ''
                ? String(raw)
                : raw === '' || raw === null || raw === undefined
                  ? ''
                  : String(raw);
          doc.font('DejaVu-Bold').fontSize(fontSize).fillColor('#111111').text(
            truncatePdfText(doc, text, 'DejaVu-Bold', fontSize, colWidths[cIndex] - 6),
            x + 3,
            y + 6,
            { width: colWidths[cIndex] - 6, align: column.type === 'money' || column.type === 'integer' ? 'right' : 'left', lineBreak: false }
          );
          x += colWidths[cIndex];
        });
        y += 24;
      }
      if (truncated) {
        doc.font('DejaVu').fontSize(7.5).fillColor('#8a5a00').text(
          `PDF limité aux ${pdfMaxRows} premières lignes. Utilisez CSV ou XLSX pour l’intégralité (${data.rows.length} lignes).`,
          28,
          y + 4,
          { width: pageWidth }
        );
      }
      const warnings = [...(data.warnings || [])];
      if (warnings.length) {
        if (y > pageHeight - 120) {
          doc.addPage();
          y = 40;
        }
        doc.font('DejaVu').fontSize(7.2).fillColor('#6b5a00');
        for (const warning of warnings) {
          doc.text(`Note : ${warning}`, 28, y + 10, { width: pageWidth });
          y += 12;
        }
      }
      const range = doc.bufferedPageRange();
      for (let p = range.start; p < range.start + range.count; p += 1) {
        doc.switchToPage(p);
        doc.font('DejaVu').fontSize(7).fillColor('#666666').text(
          `Suivi des Chèques — document interne · ${data.title} · Page ${p - range.start + 1}/${range.count}`,
          28,
          pageHeight - 26,
          { width: pageWidth, align: 'center', lineBreak: false }
        );
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function safeFilename(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function exportReport(db, ctx, input = {}) {
  assertPermission(ctx, 'reports.export');
  const format = String(input.format || '').toUpperCase();
  if (!['CSV', 'XLSX', 'PDF'].includes(format)) throw validationError('Format d’export non pris en charge');
  const data = getReportData(db, ctx, input);
  if (input.type === 'audit') assertPermission(ctx, 'audit.view');
  let buffer;
  let mime;
  if (format === 'CSV') {
    buffer = Buffer.from(exportCsv(data), 'utf8');
    mime = 'text/csv; charset=utf-8';
  } else if (format === 'XLSX') {
    buffer = await exportXlsx(data);
    mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else {
    buffer = await exportPdf(data, { maxRows: Number(input.pdfMaxRows) || 5000 });
    mime = 'application/pdf';
  }
  if (!buffer || !buffer.length) throw new Error('Export vide : opération annulée');
  if (format === 'PDF' && buffer.slice(0, 4).toString() !== '%PDF') throw new Error('PDF généré invalide');
  if (format === 'XLSX' && buffer.slice(0, 2).toString() !== 'PK') throw new Error('XLSX généré invalide');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const filename = `Rapport-${safeFilename(REPORTS[data.type].title)}-${stamp}.${format.toLowerCase()}`;
  return {
    buffer,
    mime,
    filename,
    sizeBytes: buffer.length,
    rowCount: data.rows.length,
    totals: data.totals,
    filtersLabel: data.filtersLabel,
    title: data.title,
    warnings: data.warnings,
  };
}

module.exports = {
  REPORTS,
  catalogue,
  getReportData,
  exportReport,
  exportCsv,
  exportXlsx,
  exportPdf,
  renderCell,
  totalsRow,
};
