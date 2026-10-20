'use strict';

const {
  assertPermission,
  assertCompanyAccess,
  resolveCompanyScope,
  validationError,
} = require('./authorization');
const { getSetting } = require('./settings');
const { assertISODate, todayISO, addDays, startOfWeek, diffDays, compareISO } = require('../../shared/dates');
const { isPending, settlementDateOf } = require('../../shared/status');
const { getAccount, maskAccountNumber } = require('./common');

/**
 * Trois notions distinctes, jamais confondues :
 *
 * 1. bookBalanceCents      — solde comptable calculé : ouverture + chèques
 *                            réellement réglés (date d'encaissement/paiement
 *                            réelle) + transactions internes datées.
 * 2. statementBalanceCents — solde déclaré par la banque à la date du dernier
 *                            relevé importé (ou saisi manuellement), par compte.
 * 3. forecastBalanceCents  — solde comptable + chèques en cours (hors rejetés,
 *                            impayés, annulés, endossés, en litige) à leur date
 *                            d'échéance prévue. Ce n'est PAS un solde bancaire.
 */

const TX_SIGNS = {
  DEPOT: 1,
  RETRAIT: -1,
  FRAIS: -1,
  INTERETS: 1,
  REMBOURSEMENT_PRET: -1,
  TRANSFERT_SORTIE: -1,
  TRANSFERT_ENTREE: 1,
};

const PENDING_STATUSES = ['RECU', 'DEPOSE', 'EMIS', 'REMIS'];
const EXCEPTION_STATUSES = ['REJETE', 'IMPAYE', 'RETOURNE'];

function assertFinanceAccess(ctx) {
  assertPermission(ctx, 'accounts.view');
  assertPermission(ctx, 'cheques.view');
}

function asOfDate(value) {
  if (value === undefined || value === null || value === '') return todayISO();
  assertISODate(String(value), 'Date d’arrêté');
  return String(value);
}

function accountOpeningCents(account, asOf) {
  if (compareISO(account.opening_date, asOf) > 0) return 0;
  return account.opening_balance_cents;
}

function settledChequeSum(db, accountId, asOf) {
  const rows = db
    .prepare(
      `SELECT direction, amount_cents FROM cheques
       WHERE account_id = ? AND is_archived = 0 AND (
         (direction = 'RECU' AND status = 'ENCAISSE' AND collection_date IS NOT NULL AND collection_date <= ?)
         OR
         (direction = 'EMIS' AND status = 'PAYE' AND payment_date IS NOT NULL AND payment_date <= ?)
       )`
    )
    .all(accountId, asOf, asOf);
  let incoming = 0;
  let outgoing = 0;
  for (const row of rows) {
    if (row.direction === 'RECU') incoming += row.amount_cents;
    else outgoing += row.amount_cents;
  }
  return { incoming, outgoing };
}

function settledChequeTotalsBetween(db, accountIds, from, to) {
  if (!accountIds.length) return { incoming: 0, outgoing: 0 };
  const placeholders = accountIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT direction, amount_cents FROM cheques
       WHERE account_id IN (${placeholders}) AND is_archived = 0 AND (
         (direction = 'RECU' AND status = 'ENCAISSE' AND collection_date IS NOT NULL AND collection_date BETWEEN ? AND ?)
         OR
         (direction = 'EMIS' AND status = 'PAYE' AND payment_date IS NOT NULL AND payment_date BETWEEN ? AND ?)
       )`
    )
    .all(...accountIds, from, to, from, to);
  let incoming = 0;
  let outgoing = 0;
  for (const row of rows) {
    if (row.direction === 'RECU') incoming += row.amount_cents;
    else outgoing += row.amount_cents;
  }
  return { incoming, outgoing };
}

function transactionSum(db, accountId, asOf) {
  const rows = db
    .prepare('SELECT type, amount_cents FROM transactions WHERE account_id = ? AND is_archived = 0 AND effective_date <= ?')
    .all(accountId, asOf);
  let total = 0;
  for (const row of rows) {
    const sign = TX_SIGNS[row.type];
    if (sign === undefined) throw new Error(`Type de transaction inconnu : ${row.type}`);
    total += sign * row.amount_cents;
  }
  return total;
}

function pendingForAccount(db, accountId) {
  const rows = db
    .prepare(
      `SELECT direction, amount_cents, due_date, status FROM cheques
       WHERE account_id = ? AND is_archived = 0 AND status IN (${PENDING_STATUSES.map(() => '?').join(',')})`
    )
    .all(accountId, ...PENDING_STATUSES);
  let incoming = 0;
  let outgoing = 0;
  for (const row of rows) {
    if (row.direction === 'RECU') incoming += row.amount_cents;
    else outgoing += row.amount_cents;
  }
  return { incoming, outgoing, count: rows.length };
}

function bookBalanceAt(db, account, asOf) {
  const opening = accountOpeningCents(account, asOf);
  const settled = settledChequeSum(db, account.id, asOf);
  const tx = transactionSum(db, account.id, asOf);
  return opening + settled.incoming - settled.outgoing + tx;
}

function latestStatement(db, accountId, asOf) {
  return db
    .prepare(
      `SELECT id, statement_date, closing_balance_cents, opening_balance_cents, source_type, source_filename, created_at
       FROM bank_imports WHERE account_id = ? AND statement_date <= ?
       ORDER BY statement_date DESC, id DESC LIMIT 1`
    )
    .get(accountId, asOf);
}

function accountPosition(db, account, asOf, options = {}) {
  const opening = accountOpeningCents(account, asOf);
  const settled = settledChequeSum(db, account.id, asOf);
  const tx = transactionSum(db, account.id, asOf);
  const book = opening + settled.incoming - settled.outgoing + tx;
  const pending = pendingForAccount(db, account.id);
  const statement = latestStatement(db, account.id, asOf);
  let statementInfo = null;
  if (statement) {
    const bookAtStatement = bookBalanceAt(db, account, statement.statement_date);
    statementInfo = {
      importId: statement.id,
      statementDate: statement.statement_date,
      closingBalanceCents: statement.closing_balance_cents,
      openingBalanceCents: statement.opening_balance_cents,
      sourceType: statement.source_type,
      sourceFilename: statement.source_filename,
      importedAt: statement.created_at,
      bookAtStatementDateCents: bookAtStatement,
      differenceCents: statement.closing_balance_cents - bookAtStatement,
    };
  }
  const unmatched = db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(debit_cents),0) AS debits, COALESCE(SUM(credit_cents),0) AS credits FROM bank_transactions WHERE account_id = ? AND match_status = 'UNMATCHED'"
    )
    .get(account.id);
  return {
    accountId: account.id,
    companyId: account.company_id,
    openingBalanceCents: opening,
    bookBalanceCents: book,
    settledIncomingCents: settled.incoming,
    settledOutgoingCents: settled.outgoing,
    transactionNetCents: tx,
    pendingIncomingCents: pending.incoming,
    pendingOutgoingCents: pending.outgoing,
    pendingCount: pending.count,
    forecastBalanceCents: book + pending.incoming - pending.outgoing,
    statement: statementInfo,
    unmatchedBankTransactions: unmatched.n,
    unmatchedDebitsCents: unmatched.debits,
    unmatchedCreditsCents: unmatched.credits,
    asOf,
    ...(options.extra || {}),
  };
}

function getAccountBalances(db, ctx, options = {}) {
  assertFinanceAccess(ctx);
  const companyIds = resolveCompanyScope(ctx, options.companyIds);
  const asOf = asOfDate(options.asOf);
  if (!companyIds.length) return { asOf, accounts: [], totals: emptyTotals(asOf) };
  const params = [...companyIds];
  let where = `a.company_id IN (${companyIds.map(() => '?').join(',')})`;
  if (options.companyId) {
    assertCompanyAccess(ctx, options.companyId);
    where += ' AND a.company_id = ?';
    params.push(Number(options.companyId));
  }
  if (options.accountId) {
    where += ' AND a.id = ?';
    params.push(Number(options.accountId));
  }
  if (options.includeInactive !== true) where += ' AND a.is_active = 1';
  const accounts = db
    .prepare(
      `SELECT a.*, b.name AS bank_name, b.short_name AS bank_short_name, c.name AS company_name, c.code AS company_code, c.color AS company_color
       FROM bank_accounts a JOIN banks b ON b.id = a.bank_id JOIN companies c ON c.id = a.company_id
       WHERE ${where} ORDER BY c.name, a.label`
    )
    .all(...params);
  const positions = accounts.map((account) => {
    const pos = accountPosition(db, account, asOf);
    return {
      ...pos,
      companyName: account.company_name,
      companyCode: account.company_code,
      companyColor: account.company_color,
      accountLabel: account.label,
      bankName: account.bank_name,
      currency: account.currency,
      openingDate: account.opening_date,
      isActive: Boolean(account.is_active),
      accountNumberMasked: maskAccountNumber(account.account_number),
    };
  });
  return { asOf, accounts: positions, totals: aggregatePositions(positions, asOf) };
}

function emptyTotals(asOf) {
  return {
    asOf,
    openingBalanceCents: 0,
    bookBalanceCents: 0,
    settledIncomingCents: 0,
    settledOutgoingCents: 0,
    transactionNetCents: 0,
    pendingIncomingCents: 0,
    pendingOutgoingCents: 0,
    forecastBalanceCents: 0,
    statementBalanceCents: 0,
    statementAccountsCount: 0,
    accountsCount: 0,
    accountsWithoutStatement: 0,
    statementDifferenceCents: 0,
    unmatchedBankTransactions: 0,
  };
}

function aggregatePositions(positions, asOf) {
  const totals = emptyTotals(asOf);
  totals.accountsCount = positions.length;
  for (const p of positions) {
    totals.openingBalanceCents += p.openingBalanceCents;
    totals.bookBalanceCents += p.bookBalanceCents;
    totals.settledIncomingCents += p.settledIncomingCents;
    totals.settledOutgoingCents += p.settledOutgoingCents;
    totals.transactionNetCents += p.transactionNetCents;
    totals.pendingIncomingCents += p.pendingIncomingCents;
    totals.pendingOutgoingCents += p.pendingOutgoingCents;
    totals.unmatchedBankTransactions += p.unmatchedBankTransactions;
    if (p.statement) {
      totals.statementBalanceCents += p.statement.closingBalanceCents;
      totals.statementDifferenceCents += p.statement.differenceCents;
      totals.statementAccountsCount += 1;
    }
  }
  totals.forecastBalanceCents =
    totals.bookBalanceCents + totals.pendingIncomingCents - totals.pendingOutgoingCents;
  totals.accountsWithoutStatement = totals.accountsCount - totals.statementAccountsCount;
  return totals;
}

function countRows(db, table, ids, extraWhere = '') {
  if (!ids.length) return 0;
  return db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE company_id IN (${ids.map(() => '?').join(',')}) ${extraWhere}`)
    .get(...ids).n;
}

function buildAlerts(db, ctx, companyIds, asOf, positions) {
  const alerts = [];
  const allowed = companyIds.length ? companyIds : [-1];
  const placeholders = allowed.map(() => '?').join(',');
  const overdue = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS total FROM cheques
       WHERE company_id IN (${placeholders}) AND is_archived = 0
         AND status IN ('RECU','DEPOSE','EMIS','REMIS') AND due_date < ?`
    )
    .get(...allowed, asOf);
  if (overdue.n) {
    alerts.push({
      severity: 'WARNING',
      type: 'OVERDUE_CHEQUES',
      count: overdue.n,
      amountCents: overdue.total,
      message: `${overdue.n} chèque(s) en cours dépassent leur échéance.`,
      target: 'cheques',
    });
  }
  const rejected = db
    .prepare(
      `SELECT COUNT(*) AS n FROM cheques WHERE company_id IN (${placeholders}) AND is_archived = 0
       AND status IN ('REJETE','IMPAYE','RETOURNE')`
    )
    .get(...allowed).n;
  if (rejected) {
    alerts.push({
      severity: 'DANGER',
      type: 'REJECTED_CHEQUES',
      count: rejected,
      message: `${rejected} chèque(s) rejeté(s), impayé(s) ou retourné(s) à traiter.`,
      target: 'cheques',
    });
  }
  const toRegularise = db
    .prepare(
      `SELECT COUNT(*) AS n FROM cheques WHERE company_id IN (${placeholders}) AND is_archived = 0 AND status = 'A_REGULARISER'`
    )
    .get(...allowed).n;
  if (toRegularise) {
    alerts.push({
      severity: 'WARNING',
      type: 'SETTLEMENT_DATE_MISSING',
      count: toRegularise,
      message: `${toRegularise} chèque(s) importé(s) sans date réelle de règlement : aucune trésorerie comptabilisée avant régularisation.`,
      target: 'cheques',
    });
  }
  const withoutStatement = positions.filter((p) => !p.statement).length;
  if (withoutStatement) {
    alerts.push({
      severity: 'INFO',
      type: 'ACCOUNT_WITHOUT_STATEMENT',
      count: withoutStatement,
      message: `${withoutStatement} compte(s) sans relevé bancaire importé : le solde banque n’est pas connu.`,
      target: 'reconciliation',
    });
  }
  const unmatched = positions.reduce((sum, p) => sum + p.unmatchedBankTransactions, 0);
  if (unmatched) {
    alerts.push({
      severity: 'WARNING',
      type: 'UNMATCHED_BANK_TRANSACTIONS',
      count: unmatched,
      message: `${unmatched} ligne(s) de relevé non rapprochée(s).`,
      target: 'reconciliation',
    });
  }
  const pendingApprovals = db
    .prepare(
      `SELECT COUNT(*) AS n FROM approval_requests WHERE status = 'PENDING' AND (company_id IS NULL OR company_id IN (${placeholders}))`
    )
    .get(...allowed).n;
  if (pendingApprovals) {
    alerts.push({
      severity: 'INFO',
      type: 'PENDING_APPROVALS',
      count: pendingApprovals,
      message: `${pendingApprovals} demande(s) d’approbation en attente.`,
      target: 'approvals',
    });
  }
  if (ctx.permissions.has('books.view') && companyIds.length) {
    const low = db
      .prepare(
        `SELECT cb.id, cb.from_number, cb.to_number, a.label, a.id AS account_id,
           (SELECT COUNT(DISTINCT CAST(ch.cheque_number_normalized AS INTEGER))
              FROM cheques ch WHERE ch.account_id = a.id AND ch.direction='EMIS'
              AND CAST(ch.cheque_number_normalized AS INTEGER) BETWEEN CAST(cb.from_number AS INTEGER) AND CAST(cb.to_number AS INTEGER)) AS used
         FROM cheque_books cb JOIN bank_accounts a ON a.id = cb.account_id
         WHERE a.company_id IN (${placeholders}) AND cb.is_active = 1`
      )
      .all(...allowed)
      .map((b) => ({
        ...b,
        remaining: Number(b.to_number) - Number(b.from_number) + 1 - Number(b.used),
      }))
      .filter((b) => b.remaining <= 3);
    for (const book of low) {
      alerts.push({
        severity: 'INFO',
        type: 'CHEQUEBOOK_LOW',
        count: 1,
        message: `Chéquier ${book.label} : ${book.remaining} numéro(s) restant(s).`,
        target: 'books',
      });
    }
  }
  // Sauvegardes : visible uniquement par les profils habilités.
  if (ctx.permissions.has('backup.manage')) {
    const last = db.prepare('SELECT created_at, verified FROM backup_history ORDER BY id DESC LIMIT 1').get();
    const days = last ? diffDays(last.created_at.slice(0, 10), asOf) : null;
    if (!last) {
      alerts.push({
        severity: 'WARNING',
        type: 'NO_BACKUP',
        count: 1,
        message: 'Aucune sauvegarde enregistrée. Créez une sauvegarde vérifiée.',
        target: 'backup',
      });
    } else if (days > 7) {
      alerts.push({
        severity: 'WARNING',
        type: 'BACKUP_OLD',
        count: 1,
        message: `Dernière sauvegarde il y a ${days} jour(s).`,
        target: 'backup',
      });
    }
  }
  return alerts;
}

function forecastBuckets(db, companyIds, asOf, weeks = 8) {
  const start = startOfWeek(asOf);
  const buckets = [];
  for (let i = 0; i < weeks; i += 1) {
    const from = addDays(start, i * 7);
    buckets.push({ index: i, from, to: addDays(from, 6), incomingCents: 0, outgoingCents: 0, count: 0 });
  }
  const beyond = { incomingCents: 0, outgoingCents: 0, count: 0 };
  if (!companyIds.length) return { start, buckets, beyond };
  const rows = db
    .prepare(
      `SELECT direction, amount_cents, due_date FROM cheques
       WHERE company_id IN (${companyIds.map(() => '?').join(',')}) AND is_archived = 0
         AND status IN ('RECU','DEPOSE','EMIS','REMIS')`
    )
    .all(...companyIds);
  for (const row of rows) {
    let idx;
    if (row.due_date < start) idx = 0; // échéances dépassées : semaine en cours
    else idx = Math.floor(diffDays(start, row.due_date) / 7);
    if (idx >= weeks) {
      beyond.count += 1;
      if (row.direction === 'RECU') beyond.incomingCents += row.amount_cents;
      else beyond.outgoingCents += row.amount_cents;
      continue;
    }
    buckets[idx].count += 1;
    if (row.direction === 'RECU') buckets[idx].incomingCents += row.amount_cents;
    else buckets[idx].outgoingCents += row.amount_cents;
  }
  return { start, buckets, beyond };
}

function getDashboard(db, ctx, options = {}) {
  assertPermission(ctx, 'dashboard.view');
  assertFinanceAccess(ctx);
  const companyIds = resolveCompanyScope(ctx, options.companyIds);
  const asOf = asOfDate(options.asOf);
  const positions = getAccountBalances(db, ctx, { companyIds, asOf, includeInactive: false });
  const totals = positions.totals;
  const allowed = companyIds.length ? companyIds : [-1];
  const ph = allowed.map(() => '?').join(',');
  const counts = {
    companies: companyIds.length,
    accounts: totals.accountsCount,
    cheques: db.prepare(`SELECT COUNT(*) AS n FROM cheques WHERE company_id IN (${ph}) AND is_archived = 0`).get(...allowed).n,
    pending: db
      .prepare(`SELECT COUNT(*) AS n FROM cheques WHERE company_id IN (${ph}) AND is_archived = 0 AND status IN ('RECU','DEPOSE','EMIS','REMIS')`)
      .get(...allowed).n,
    overdue: db
      .prepare(`SELECT COUNT(*) AS n FROM cheques WHERE company_id IN (${ph}) AND is_archived = 0 AND status IN ('RECU','DEPOSE','EMIS','REMIS') AND due_date < ?`)
      .get(...allowed, asOf).n,
    dueSoon: db
      .prepare(`SELECT COUNT(*) AS n FROM cheques WHERE company_id IN (${ph}) AND is_archived = 0 AND status IN ('RECU','DEPOSE','EMIS','REMIS') AND due_date BETWEEN ? AND ?`)
      .get(...allowed, asOf, addDays(asOf, 7)).n,
    rejected: db
      .prepare(`SELECT COUNT(*) AS n FROM cheques WHERE company_id IN (${ph}) AND is_archived = 0 AND status IN ('REJETE','IMPAYE','RETOURNE')`)
      .get(...allowed).n,
    toRegularise: db
      .prepare(`SELECT COUNT(*) AS n FROM cheques WHERE company_id IN (${ph}) AND is_archived = 0 AND status = 'A_REGULARISER'`)
      .get(...allowed).n,
    pendingApprovals: db
      .prepare(`SELECT COUNT(*) AS n FROM approval_requests WHERE status='PENDING' AND (company_id IS NULL OR company_id IN (${ph}))`)
      .get(...allowed).n,
  };

  const companyRows = companyIds.length
    ? db
        .prepare(
          `SELECT c.id, c.code, c.name, c.color FROM companies c
           WHERE c.id IN (${companyIds.map(() => '?').join(',')}) ORDER BY c.name`
        )
        .all(...companyIds)
    : [];
  const companyBreakdown = companyRows.map((company) => {
    const companyAccounts = positions.accounts.filter((a) => a.companyId === company.id);
    const t = aggregatePositions(companyAccounts, asOf);
    const overdueRow = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS total FROM cheques
         WHERE company_id = ? AND is_archived = 0 AND status IN ('RECU','DEPOSE','EMIS','REMIS') AND due_date < ?`
      )
      .get(company.id, asOf);
    return {
      companyId: company.id,
      code: company.code,
      name: company.name,
      color: company.color,
      bookBalanceCents: t.bookBalanceCents,
      pendingIncomingCents: t.pendingIncomingCents,
      pendingOutgoingCents: t.pendingOutgoingCents,
      forecastBalanceCents: t.forecastBalanceCents,
      statementBalanceCents: t.statementBalanceCents,
      statementAccountsCount: t.statementAccountsCount,
      accountsWithoutStatement: t.accountsWithoutStatement,
      overdueCount: overdueRow.n,
      overdueAmountCents: overdueRow.total,
    };
  });

  const forecast = forecastBuckets(db, companyIds, asOf, 8);
  let running = totals.bookBalanceCents;
  const chart = forecast.buckets.map((b) => {
    running += b.incomingCents - b.outgoingCents;
    return { ...b, runningBalanceCents: running };
  });
  const firstNegative = chart.find((b) => b.runningBalanceCents < 0);

  const alerts = buildAlerts(db, ctx, companyIds, asOf, positions.accounts);
  const upcoming = db
    .prepare(
      `SELECT ch.id, ch.reference, ch.company_id, ch.direction, ch.party_name, ch.amount_cents, ch.due_date, ch.status,
              c.name AS company_name, c.color AS company_color, a.label AS account_label
       FROM cheques ch JOIN companies c ON c.id = ch.company_id JOIN bank_accounts a ON a.id = ch.account_id
       WHERE ch.company_id IN (${ph}) AND ch.is_archived = 0 AND ch.status IN ('RECU','DEPOSE','EMIS','REMIS')
         AND ch.due_date <= ?
       ORDER BY ch.due_date ASC, ch.amount_cents DESC LIMIT 12`
    )
    .all(...allowed, addDays(asOf, 7))
    .map((r) => ({
      id: r.id,
      reference: r.reference,
      companyId: r.company_id,
      companyName: r.company_name,
      companyColor: r.company_color,
      direction: r.direction,
      partyName: r.party_name,
      amountCents: r.amount_cents,
      dueDate: r.due_date,
      status: r.status,
      accountLabel: r.account_label,
      overdue: r.due_date < asOf,
    }));

  const settings = {
    presentationDeadlineDays: getSetting(db, 'cheque.presentation_deadline_days', 20),
    overdueDays: getSetting(db, 'notifications.overdue_days', 7),
  };

  return {
    asOf,
    generatedAt: new Date().toISOString(),
    totals: {
      ...totals,
      pendingIncomingCents: totals.pendingIncomingCents,
      pendingOutgoingCents: totals.pendingOutgoingCents,
    },
    counts,
    companyBreakdown,
    forecast: { start: forecast.start, weeks: chart, beyond: forecast.beyond, firstNegativeWeek: firstNegative ? firstNegative.index : null },
    alerts,
    upcoming,
    settings,
    definitions: {
      bookBalance: 'Solde comptable calculé (ouverture + règlements réels + transactions internes). Ce n’est pas un solde bancaire.',
      statementBalance: 'Somme des soldes de relevés bancaires importés les plus récents, pour les comptes couverts uniquement.',
      forecastBalance: 'Solde comptable + chèques en cours à leur échéance prévue. Prévision, non garantie.',
    },
  };
}

function companyComparison(db, ctx, options = {}) {
  assertPermission(ctx, 'reports.view');
  assertFinanceAccess(ctx);
  const companyIds = resolveCompanyScope(ctx, options.companyIds);
  const asOf = asOfDate(options.asOf);
  const positions = getAccountBalances(db, ctx, { companyIds, asOf, includeInactive: false }).accounts;
  if (!companyIds.length) return { asOf, rows: [], totals: emptyTotals(asOf) };
  return {
    asOf,
    rows: companyIds.map((id) => {
      const company = db.prepare('SELECT id, code, name, color FROM companies WHERE id = ?').get(id);
      const list = positions.filter((p) => p.companyId === id);
      const t = aggregatePositions(list, asOf);
      const rejectedRow = db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS total FROM cheques
           WHERE company_id = ? AND is_archived = 0 AND status IN ('REJETE','IMPAYE','RETOURNE')`
        )
        .get(id);
      const chequeCount = db.prepare('SELECT COUNT(*) AS n FROM cheques WHERE company_id = ? AND is_archived = 0').get(id).n;
      return {
        companyId: id,
        code: company.code,
        name: company.name,
        color: company.color,
        accountsCount: list.length,
        chequeCount,
        bookBalanceCents: t.bookBalanceCents,
        pendingIncomingCents: t.pendingIncomingCents,
        pendingOutgoingCents: t.pendingOutgoingCents,
        forecastBalanceCents: t.forecastBalanceCents,
        statementBalanceCents: t.statementBalanceCents,
        accountsWithoutStatement: t.accountsWithoutStatement,
        rejectedCount: rejectedRow.n,
        rejectedAmountCents: rejectedRow.total,
      };
    }),
    totals: aggregatePositions(positions, asOf),
  };
}

function cashFlow(db, ctx, options = {}) {
  assertFinanceAccess(ctx);
  const companyIds = resolveCompanyScope(ctx, options.companyIds);
  const asOf = asOfDate(options.asFrom || options.asOf);
  const weeks = Math.min(52, Math.max(1, Number(options.weeks) || 8));
  const positions = getAccountBalances(db, ctx, { companyIds, asOf, includeInactive: false });
  const forecast = forecastBuckets(db, companyIds, asOf, weeks);
  let running = positions.totals.bookBalanceCents;
  const buckets = forecast.buckets.map((b) => {
    running += b.incomingCents - b.outgoingCents;
    return { ...b, runningBalanceCents: running };
  });
  const historical = settledChequeTotalsBetween(db, positions.accounts.map((a) => a.accountId), addDays(asOf, -28), asOf);
  return {
    asOf,
    bookBalanceCents: positions.totals.bookBalanceCents,
    statementBalanceCents: positions.totals.statementBalanceCents,
    buckets,
    beyond: forecast.beyond,
    last28DaysSettled: historical,
  };
}

/** Synthèse des transferts inter-sociétés explicites (jamais qualifiés de dettes). */
function transferSummary(db, ctx, options = {}) {
  assertPermission(ctx, 'transactions.view');
  const companyIds = resolveCompanyScope(ctx, options.companyIds);
  if (!companyIds.length) return { transfers: [], netByPair: [], disclaimer: transferDisclaimer() };
  const ph = companyIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT t_out.transfer_group_id,
              t_out.account_id AS from_account_id, t_in.account_id AS to_account_id,
              t_out.amount_cents, t_out.effective_date, t_out.description,
              fa.company_id AS from_company_id, fc.name AS from_company_name, fc.color AS from_company_color,
              fa.label AS from_account_label, fb.name AS from_bank,
              ta.company_id AS to_company_id, tc.name AS to_company_name, tc.color AS to_company_color,
              ta.label AS to_account_label, tb.name AS to_bank
       FROM transactions t_out
       JOIN transactions t_in ON t_in.transfer_group_id = t_out.transfer_group_id
            AND t_in.type = 'TRANSFERT_ENTREE' AND t_in.is_archived = 0
       JOIN bank_accounts fa ON fa.id = t_out.account_id
       JOIN companies fc ON fc.id = fa.company_id
       JOIN banks fb ON fb.id = fa.bank_id
       JOIN bank_accounts ta ON ta.id = t_in.account_id
       JOIN companies tc ON tc.id = ta.company_id
       JOIN banks tb ON tb.id = ta.bank_id
       WHERE t_out.type = 'TRANSFERT_SORTIE' AND t_out.is_archived = 0
         AND fc.id IN (${ph}) AND tc.id IN (${ph}) AND fc.id <> tc.id
       ORDER BY t_out.effective_date DESC, t_out.id DESC`
    )
    .all(...companyIds, ...companyIds);
  const transfers = rows.map((r) => ({
    transferGroupId: r.transfer_group_id,
    fromCompanyId: r.from_company_id,
    fromCompanyName: r.from_company_name,
    fromCompanyColor: r.from_company_color,
    fromAccountId: r.from_account_id,
    fromAccountLabel: r.from_account_label,
    fromBank: r.from_bank,
    toCompanyId: r.to_company_id,
    toCompanyName: r.to_company_name,
    toCompanyColor: r.to_company_color,
    toAccountId: r.to_account_id,
    toAccountLabel: r.to_account_label,
    toBank: r.to_bank,
    amountCents: r.amount_cents,
    date: r.effective_date,
    description: r.description,
  }));
  const pairs = new Map();
  for (const t of transfers) {
    const key = `${t.fromCompanyId}:${t.toCompanyId}`;
    const entry = pairs.get(key) || {
      fromCompanyId: t.fromCompanyId,
      fromCompanyName: t.fromCompanyName,
      toCompanyId: t.toCompanyId,
      toCompanyName: t.toCompanyName,
      totalCents: 0,
      count: 0,
    };
    entry.totalCents += t.amountCents;
    entry.count += 1;
    pairs.set(key, entry);
  }
  return { transfers, netByPair: [...pairs.values()], disclaimer: transferDisclaimer() };
}

function transferDisclaimer() {
  return 'Synthèse des transferts enregistrés entre comptes de sociétés différentes. Ce n’est ni une reconnaissance de dette ni un état comptable inter-sociétés : seuls des contrats ou conventions signés peuvent établir une créance.';
}

module.exports = {
  TX_SIGNS,
  PENDING_STATUSES,
  EXCEPTION_STATUSES,
  assertFinanceAccess,
  accountPosition,
  bookBalanceAt,
  getAccountBalances,
  getDashboard,
  companyComparison,
  cashFlow,
  transferSummary,
  aggregatePositions,
  settlementDateOf,
};
