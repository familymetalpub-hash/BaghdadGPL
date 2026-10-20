'use strict';

const {
  assertPermission,
  assertCompanyAccess,
  resolveCompanyScope,
  validationError,
  forbidden,
  notFound,
  AppError,
} = require('./authorization');
const { appendAudit } = require('./audit');
const { getSetting } = require('./settings');
const { transaction, parseJson } = require('../db');
const { getAccount } = require('./common');
const { todayISO, assertISODate, diffDays } = require('../../shared/dates');
const { formatCents } = require('../../shared/money');
const { statusLabel, DIRECTIONS } = require('../../shared/status');

function mapBankTransaction(row, matches) {
  return {
    id: row.id,
    importId: row.import_id,
    companyId: row.company_id,
    companyName: row.company_name,
    accountId: row.account_id,
    accountLabel: row.account_label,
    bankName: row.bank_name,
    bankRef: row.bank_ref,
    transactionDate: row.transaction_date,
    valueDate: row.value_date,
    description: row.description,
    debitCents: row.debit_cents,
    creditCents: row.credit_cents,
    amountCents: row.credit_cents || row.debit_cents,
    direction: row.credit_cents > 0 ? 'CREDIT' : 'DEBIT',
    balanceCents: row.balance_cents,
    currency: row.currency,
    rowNumber: row.row_number,
    matchStatus: row.match_status,
    import: row.source_type
      ? { sourceType: row.source_type, filename: row.source_filename, statementDate: row.statement_date }
      : null,
    matches: matches || [],
  };
}

function matchesForTransaction(db, txId) {
  return db
    .prepare(
      `SELECT rm.*, ch.reference AS cheque_reference, ch.cheque_number, ch.party_name, ch.status AS cheque_status,
              ch.amount_cents AS cheque_amount_cents, ch.direction AS cheque_direction, ch.company_id AS cheque_company_id
       FROM reconciliation_matches rm JOIN cheques ch ON ch.id = rm.cheque_id
       WHERE rm.bank_transaction_id = ? ORDER BY rm.id DESC`
    )
    .all(txId)
    .map((m) => ({
      id: m.id,
      chequeId: m.cheque_id,
      chequeReference: m.cheque_reference,
      chequeNumber: m.cheque_number,
      chequeParty: m.party_name,
      chequeStatus: m.cheque_status,
      chequeStatusLabel: statusLabel(m.cheque_status, m.cheque_direction),
      chequeAmountCents: m.cheque_amount_cents,
      amountCents: m.amount_cents,
      matchType: m.match_type,
      status: m.status,
      score: m.score,
      reason: m.reason,
      settlementApplied: Boolean(m.settlement_applied),
      proposedAt: m.proposed_at,
      decidedAt: m.decided_at,
    }));
}

function listBankTransactions(db, ctx, options = {}) {
  assertPermission(ctx, 'reconciliation.view');
  const companyIds = resolveCompanyScope(ctx, options.companyIds);
  if (!companyIds.length) return { items: [], total: 0 };
  const params = [...companyIds];
  const where = [`bt.company_id IN (${companyIds.map(() => '?').join(',')})`];
  if (options.accountId) {
    where.push('bt.account_id = ?');
    params.push(Number(options.accountId));
  }
  if (options.companyId) {
    assertCompanyAccess(ctx, options.companyId);
    where.push('bt.company_id = ?');
    params.push(Number(options.companyId));
  }
  if (options.matchStatus && options.matchStatus !== 'ALL') {
    where.push('bt.match_status = ?');
    params.push(String(options.matchStatus));
  }
  if (options.importId) {
    where.push('bt.import_id = ?');
    params.push(Number(options.importId));
  }
  if (options.dateFrom) {
    where.push('bt.transaction_date >= ?');
    params.push(String(options.dateFrom));
  }
  if (options.dateTo) {
    where.push('bt.transaction_date <= ?');
    params.push(String(options.dateTo));
  }
  if (options.search) {
    const like = `%${String(options.search).slice(0, 100)}%`;
    where.push('(bt.description LIKE ? OR bt.bank_ref LIKE ?)');
    params.push(like, like);
  }
  const whereSql = where.join(' AND ');
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.min(200, Math.max(10, Number(options.pageSize) || 50));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM bank_transactions bt WHERE ${whereSql}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT bt.*, a.label AS account_label, b.name AS bank_name, c.name AS company_name,
              bi.source_type, bi.source_filename, bi.statement_date
       FROM bank_transactions bt
       JOIN bank_accounts a ON a.id = bt.account_id
       JOIN banks b ON b.id = a.bank_id
       JOIN companies c ON c.id = bt.company_id
       JOIN bank_imports bi ON bi.id = bt.import_id
       WHERE ${whereSql}
       ORDER BY bt.transaction_date DESC, bt.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  const items = rows.map((row) => mapBankTransaction(row, matchesForTransaction(db, row.id)));
  return {
    items,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function normaliseForSearch(value) {
  return String(value || '').toUpperCase().replace(/\s+/g, '');
}

function scoreCandidate(tx, cheque, windowDays) {
  const haystack = normaliseForSearch(`${tx.description || ''} ${tx.bank_ref || ''}`);
  const chequeNo = normaliseForSearch(cheque.cheque_number);
  const reference = normaliseForSearch(cheque.reference);
  if (reference && haystack.includes(reference)) return { score: 100, type: 'REFERENCE_EXACTE' };
  if (chequeNo && haystack.includes(chequeNo)) return { score: 95, type: 'REFERENCE_EXACTE' };
  const targetDate =
    (cheque.direction === 'RECU' ? cheque.collection_date : cheque.payment_date) || cheque.due_date;
  const delta = Math.abs(diffDays(tx.transaction_date, targetDate));
  if (delta <= windowDays) return { score: delta === 0 ? 80 : 65, type: 'MONTANT_DATE' };
  return { score: 40, type: 'PROBABLE' };
}

function eligibleCheques(db, tx) {
  const windowDays = Number(getSetting(db, 'reconciliation.date_window_days', 10));
  const direction = tx.credit_cents > 0 ? 'RECU' : 'EMIS';
  const amount = tx.credit_cents > 0 ? tx.credit_cents : tx.debit_cents;
  const rows = db
    .prepare(
      `SELECT ch.* FROM cheques ch
       WHERE ch.company_id = ? AND ch.account_id = ? AND ch.direction = ? AND ch.amount_cents = ?
         AND ch.is_archived = 0
         AND ch.status IN ('RECU','DEPOSE','EMIS','REMIS','ENCAISSE','PAYE','A_REGULARISER')
         AND NOT EXISTS (SELECT 1 FROM reconciliation_matches rm WHERE rm.cheque_id = ch.id AND rm.status = 'CONFIRME')
       ORDER BY abs(julianday(ch.due_date) - julianday(?)) ASC`
    )
    .all(tx.company_id, tx.account_id, direction, amount, tx.transaction_date);
  return rows
    .map((cheque) => ({ cheque, ...scoreCandidate(tx, cheque, windowDays) }))
    .filter((c) => c.score >= 40)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function autoProposeForTransactions(db, ctx, transactionIds) {
  if (!transactionIds || !transactionIds.length) return 0;
  assertPermission(ctx, 'reconciliation.match');
  let created = 0;
  transaction(db, () => {
    for (const txId of transactionIds) {
      const tx = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(Number(txId));
      if (!tx || tx.match_status === 'MATCHED' || tx.match_status === 'IGNORED') continue;
      if (db.prepare("SELECT 1 AS x FROM reconciliation_matches WHERE bank_transaction_id = ? AND status = 'CONFIRME'").get(tx.id)) continue;
      const candidates = eligibleCheques(db, tx);
      for (const candidate of candidates) {
        const exists = db
          .prepare(
            "SELECT 1 AS x FROM reconciliation_matches WHERE bank_transaction_id = ? AND cheque_id = ? AND status = 'PROPOSE'"
          )
          .get(tx.id, candidate.cheque.id);
        if (exists) continue;
        const matchId = Number(
          db
            .prepare(
              `INSERT INTO reconciliation_matches(bank_transaction_id, cheque_id, company_id, account_id, amount_cents,
                 match_type, status, score, proposed_by, reason)
               VALUES (?,?,?,?,?,?, 'PROPOSE', ?,?,?)`
            )
            .run(
              tx.id,
              candidate.cheque.id,
              tx.company_id,
              tx.account_id,
              tx.credit_cents || tx.debit_cents,
              candidate.type,
              candidate.score,
              ctx.user.id,
              'Proposition automatique — confirmation obligatoire'
            ).lastInsertRowid
        );
        created += 1;
        db.prepare("UPDATE bank_transactions SET match_status='PROPOSED' WHERE id = ? AND match_status = 'UNMATCHED'").run(tx.id);
        appendAudit(db, ctx, {
          companyId: tx.company_id,
          entityType: 'RAPPROCHEMENT',
          entityId: matchId,
          action: 'MATCH_PROPOSED',
          after: {
            bankTransactionId: tx.id,
            chequeId: candidate.cheque.id,
            score: candidate.score,
            matchType: candidate.type,
            amountCents: tx.credit_cents || tx.debit_cents,
          },
          reason: 'Proposition de rapprochement',
        });
      }
    }
  });
  return created;
}

function proposeMatch(db, ctx, input) {
  assertPermission(ctx, 'reconciliation.match');
  const tx = db
    .prepare(
      `SELECT bt.*, a.label AS account_label FROM bank_transactions bt JOIN bank_accounts a ON a.id = bt.account_id
       WHERE bt.id = ?`
    )
    .get(Number(input.bankTransactionId));
  if (!tx) throw notFound('Ligne de relevé');
  assertCompanyAccess(ctx, tx.company_id);
  if (tx.match_status === 'MATCHED') throw new AppError('CONFLICT', 'Cette ligne est déjà rapprochée');
  const cheque = db.prepare('SELECT * FROM cheques WHERE id = ?').get(Number(input.chequeId));
  if (!cheque) throw notFound('Chèque');
  assertCompanyAccess(ctx, cheque.company_id);
  if (cheque.company_id !== tx.company_id || cheque.account_id !== tx.account_id) {
    throw forbidden('Le chèque et la ligne bancaire ne relèvent pas du même compte');
  }
  if (cheque.is_archived) throw forbidden('Chèque archivé');
  if (!['RECU', 'DEPOSE', 'EMIS', 'REMIS', 'ENCAISSE', 'PAYE', 'A_REGULARISER'].includes(cheque.status)) {
    throw validationError('Ce chèque ne peut pas être rapproché dans son statut actuel');
  }
  const expectedDirection = tx.credit_cents > 0 ? 'RECU' : 'EMIS';
  if (cheque.direction !== expectedDirection) {
    throw validationError('Le sens du chèque ne correspond pas au sens de la ligne bancaire');
  }
  const amount = tx.credit_cents || tx.debit_cents;
  if (cheque.amount_cents !== amount) {
    throw validationError('Les montants diffèrent. Le rapprochement partiel ou groupé n’est pas pris en charge.');
  }
  if (db.prepare("SELECT 1 AS x FROM reconciliation_matches WHERE cheque_id = ? AND status = 'CONFIRME'").get(cheque.id)) {
    throw new AppError('CONFLICT', 'Ce chèque est déjà rapproché à une autre ligne');
  }
  const existing = db
    .prepare("SELECT id FROM reconciliation_matches WHERE bank_transaction_id = ? AND cheque_id = ? AND status = 'PROPOSE'")
    .get(tx.id, cheque.id);
  if (existing) return { matchId: existing.id, existing: true };
  const matchType = String(input.matchType || 'MANUEL').toUpperCase();
  if (!['REFERENCE_EXACTE', 'MONTANT_DATE', 'PROBABLE', 'MANUEL'].includes(matchType)) throw validationError('Type de rapprochement invalide');
  if (matchType === 'MANUEL' && String(input.reason || '').trim().length < 3) {
    throw validationError('Un motif est obligatoire pour un rapprochement manuel');
  }
  return transaction(db, () => {
    const matchId = Number(
      db
        .prepare(
          `INSERT INTO reconciliation_matches(bank_transaction_id, cheque_id, company_id, account_id, amount_cents,
             match_type, status, score, proposed_by, reason)
           VALUES (?,?,?,?,?,?, 'PROPOSE', ?,?,?)`
        )
        .run(
          tx.id,
          cheque.id,
          tx.company_id,
          tx.account_id,
          amount,
          matchType,
          matchType === 'MANUEL' ? 100 : 70,
          ctx.user.id,
          input.reason || 'Rapprochement manuel'
        ).lastInsertRowid
    );
    db.prepare("UPDATE bank_transactions SET match_status='PROPOSED' WHERE id = ? AND match_status <> 'MATCHED'").run(tx.id);
    appendAudit(db, ctx, {
      companyId: tx.company_id,
      entityType: 'RAPPROCHEMENT',
      entityId: matchId,
      action: 'MATCH_PROPOSED',
      after: { bankTransactionId: tx.id, chequeId: cheque.id, amountCents: amount, matchType },
      reason: input.reason || 'Rapprochement manuel',
    });
    return { matchId, existing: false };
  });
}

function rejectMatch(db, ctx, input) {
  assertPermission(ctx, 'reconciliation.match');
  const match = db.prepare('SELECT * FROM reconciliation_matches WHERE id = ?').get(Number(input.matchId));
  if (!match) throw notFound('Rapprochement');
  assertCompanyAccess(ctx, match.company_id);
  if (match.status !== 'PROPOSE') throw new AppError('CONFLICT', 'Seule une proposition peut être rejetée');
  const reason = String(input.reason || '').trim();
  if (reason.length < 3) throw validationError('Motif de rejet requis');
  return transaction(db, () => {
    db.prepare("UPDATE reconciliation_matches SET status='REJETE', decided_by=?, decided_at=?, reason=? WHERE id=? AND status='PROPOSE'").run(
      ctx.user.id,
      new Date().toISOString(),
      reason,
      match.id
    );
    recomputeTransactionStatus(db, match.bank_transaction_id);
    appendAudit(db, ctx, {
      companyId: match.company_id,
      entityType: 'RAPPROCHEMENT',
      entityId: match.id,
      action: 'MATCH_REJECTED',
      before: { status: 'PROPOSE' },
      after: { status: 'REJETE' },
      reason,
    });
    return { ok: true };
  });
}

function recomputeTransactionStatus(db, txId) {
  const confirmed = db
    .prepare("SELECT 1 AS x FROM reconciliation_matches WHERE bank_transaction_id = ? AND status='CONFIRME'")
    .get(txId);
  if (confirmed) {
    db.prepare("UPDATE bank_transactions SET match_status='MATCHED' WHERE id=?").run(txId);
    return;
  }
  const proposed = db
    .prepare("SELECT 1 AS x FROM reconciliation_matches WHERE bank_transaction_id = ? AND status='PROPOSE'")
    .get(txId);
  db.prepare("UPDATE bank_transactions SET match_status=? WHERE id=?").run(proposed ? 'PROPOSED' : 'UNMATCHED', txId);
}

function confirmMatchInternal(db, ctx, input) {
  const match = db
    .prepare(
      `SELECT rm.*, bt.transaction_date, bt.debit_cents, bt.credit_cents, bt.match_status AS tx_match_status,
              bt.description, bt.bank_ref, ch.status AS cheque_status, ch.direction AS cheque_direction,
              ch.amount_cents AS cheque_amount, ch.is_archived AS cheque_archived, ch.reference AS cheque_reference
       FROM reconciliation_matches rm
       JOIN bank_transactions bt ON bt.id = rm.bank_transaction_id
       JOIN cheques ch ON ch.id = rm.cheque_id
       WHERE rm.id = ?`
    )
    .get(Number(input.matchId));
  if (!match) throw notFound('Rapprochement');
  assertCompanyAccess(ctx, match.company_id);
  if (match.status !== 'PROPOSE') throw new AppError('CONFLICT', 'Ce rapprochement a déjà été traité');
  if (match.tx_match_status === 'MATCHED') throw new AppError('CONFLICT', 'La ligne bancaire est déjà rapprochée');
  if (match.cheque_archived) throw forbidden('Chèque archivé');
  const txAmount = match.credit_cents || match.debit_cents;
  if (txAmount !== match.cheque_amount || txAmount !== match.amount_cents) {
    throw new AppError('CONFLICT', 'Les montants ont changé depuis la proposition. Rejetez et proposez à nouveau.');
  }
  if (db.prepare("SELECT 1 AS x FROM reconciliation_matches WHERE cheque_id = ? AND status='CONFIRME'").get(match.cheque_id)) {
    throw new AppError('CONFLICT', 'Ce chèque est déjà rapproché à une autre ligne');
  }
  const reason = String(input.reason || '').trim() || 'Rapprochement confirmé par le Directeur Général';
  const settlementDate = String(input.settlementDate || match.transaction_date);
  assertISODate(settlementDate, 'Date de règlement');
  if (settlementDate > todayISO()) throw validationError('La date de règlement ne peut pas être dans le futur');
  let settlementApplied = false;
  const cheques = require('./cheques');
  let chequeAfter = null;

  if (input.settleCheque) {
    let current = cheques.getChequeRow(db, match.cheque_id);
    const target = current.direction === 'RECU' ? 'ENCAISSE' : 'PAYE';
    if (current.status !== target) {
      if (!['RECU', 'DEPOSE', 'EMIS', 'REMIS', 'A_REGULARISER'].includes(current.status)) {
        throw validationError('Le chèque ne peut pas être réglé depuis son statut actuel');
      }
      // Un chèque reçu n'a pas pu être encaissé sans avoir été déposé. Si le
      // dépôt n'a pas été saisi, la date réelle doit être fournie explicitement :
      // elle n'est jamais déduite de l'échéance ni inventée.
      if (current.direction === 'RECU' && ['RECU', 'A_REGULARISER'].includes(current.status) && !current.deposit_date) {
        const depositDate = String(input.depositDate || '').trim();
        if (!depositDate) {
          throw validationError(
            'Ce chèque n’a jamais été enregistré comme déposé. Indiquez la date réelle de dépôt avant de finaliser le rapprochement.'
          );
        }
        assertISODate(depositDate, 'Date de dépôt');
        if (depositDate > settlementDate) throw validationError('La date de dépôt ne peut pas être postérieure au règlement');
        const depositChange = cheques.validateStatusChange(db, current, {
          to: 'DEPOSE',
          eventDate: depositDate,
          reason: `Dépôt constaté lors du rapprochement : ${reason}`,
        });
        cheques.applyStatusDirect(db, ctx, current, depositChange, {});
        current = cheques.getChequeRow(db, match.cheque_id);
      }
      if (current.status !== target) {
        const change = cheques.validateStatusChange(db, current, {
          to: target,
          eventDate: settlementDate,
          reason: `Rapprochement bancaire : ${reason}`,
        });
        chequeAfter = cheques.applyStatusDirect(db, ctx, current, change, {});
      } else {
        chequeAfter = current;
      }
      settlementApplied = true;
    }
  }

  db.prepare("UPDATE reconciliation_matches SET status='CONFIRME', decided_by=?, decided_at=?, reason=?, settlement_applied=? WHERE id=?").run(
    ctx.user.id,
    new Date().toISOString(),
    reason,
    settlementApplied ? 1 : 0,
    match.id
  );
  db.prepare("UPDATE bank_transactions SET match_status='MATCHED' WHERE id=?").run(match.bank_transaction_id);
  // Toute autre proposition liée à cette ligne ou à ce chèque devient caduque.
  const others = db
    .prepare(
      "SELECT * FROM reconciliation_matches WHERE status='PROPOSE' AND id <> ? AND (bank_transaction_id = ? OR cheque_id = ?)"
    )
    .all(match.id, match.bank_transaction_id, match.cheque_id);
  for (const other of others) {
    db.prepare(
      "UPDATE reconciliation_matches SET status='REJETE', decided_by=?, decided_at=?, reason=? WHERE id=? AND status='PROPOSE'"
    ).run(ctx.user.id, new Date().toISOString(), 'Autre rapprochement confirmé', other.id);
    recomputeTransactionStatus(db, other.bank_transaction_id);
  }
  appendAudit(db, ctx, {
    companyId: match.company_id,
    entityType: 'RAPPROCHEMENT',
    entityId: match.id,
    action: 'MATCH_CONFIRMED',
    before: { status: 'PROPOSE' },
    after: {
      status: 'CONFIRME',
      bankTransactionId: match.bank_transaction_id,
      chequeId: match.cheque_id,
      amountCents: txAmount,
      settlementApplied,
      settlementDate: settlementApplied ? settlementDate : null,
    },
    reason,
  });
  return { ok: true, settlementApplied, cheque: chequeAfter, matchId: match.id };
}

function confirmMatch(db, ctx, input) {
  const requiresDg = getSetting(db, 'approval.require_reconciliation_finalize', true);
  if (requiresDg) {
    assertPermission(ctx, 'reconciliation.confirm');
    if (ctx.user.role !== 'DG') throw forbidden('Seul le Directeur Général peut finaliser un rapprochement');
  } else {
    assertPermission(ctx, 'reconciliation.match');
  }
  return transaction(db, () => confirmMatchInternal(db, ctx, input));
}

function applyApprovedConfirmation(db, ctx, request) {
  const after = parseJson(request.after_json, {});
  return confirmMatchInternal(db, ctx, {
    matchId: after.matchId,
    settleCheque: Boolean(after.settleCheque),
    settlementDate: after.settlementDate,
    reason: after.reason || `Rapprochement approuvé (${request.reference})`,
  });
}

function latestStatement(db, accountId, asOf) {
  return db
    .prepare(
      `SELECT * FROM bank_imports WHERE account_id = ? AND statement_date <= ?
       ORDER BY statement_date DESC, id DESC LIMIT 1`
    )
    .get(accountId, asOf);
}

function reconciliationReport(db, ctx, input) {
  assertPermission(ctx, 'reconciliation.view');
  const account = getAccount(db, input.accountId);
  assertCompanyAccess(ctx, account.company_id);
  const asOf = String(input.asOf || todayISO());
  assertISODate(asOf, 'Date du rapport');
  const finance = require('./finance');
  const statement = latestStatement(db, account.id, asOf);
  const bookToday = finance.bookBalanceAt(db, account, asOf);
  const bookAtStatement = statement ? finance.bookBalanceAt(db, account, statement.statement_date) : null;
  const pending = db
    .prepare(
      `SELECT * FROM cheques WHERE account_id = ? AND is_archived = 0 AND status IN ('RECU','DEPOSE','EMIS','REMIS')
       ORDER BY due_date`
    )
    .all(account.id);
  const pendingIncoming = pending.filter((c) => c.direction === 'RECU').reduce((s, c) => s + c.amount_cents, 0);
  const pendingOutgoing = pending.filter((c) => c.direction === 'EMIS').reduce((s, c) => s + c.amount_cents, 0);
  const unmatched = db
    .prepare(
      `SELECT * FROM bank_transactions WHERE account_id = ? AND match_status = 'UNMATCHED'
       ORDER BY transaction_date DESC LIMIT 1000`
    )
    .all(account.id);
  const proposed = db
    .prepare(
      `SELECT bt.*, rm.id AS match_id, rm.cheque_id, rm.score, ch.reference AS cheque_reference, ch.cheque_number
       FROM bank_transactions bt
       JOIN reconciliation_matches rm ON rm.bank_transaction_id = bt.id AND rm.status='PROPOSE'
       JOIN cheques ch ON ch.id = rm.cheque_id
       WHERE bt.account_id = ? ORDER BY bt.transaction_date DESC LIMIT 1000`
    )
    .all(account.id);
  const confirmed = db
    .prepare(
      `SELECT rm.*, bt.transaction_date, bt.description, bt.debit_cents, bt.credit_cents,
              ch.reference AS cheque_reference, ch.cheque_number
       FROM reconciliation_matches rm
       JOIN bank_transactions bt ON bt.id = rm.bank_transaction_id
       JOIN cheques ch ON ch.id = rm.cheque_id
       WHERE rm.account_id = ? AND rm.status='CONFIRME'
       ORDER BY rm.decided_at DESC LIMIT 1000`
    )
    .all(account.id);
  const unmatchedDebits = unmatched.filter((t) => t.debit_cents > 0).reduce((s, t) => s + t.debit_cents, 0);
  const unmatchedCredits = unmatched.filter((t) => t.credit_cents > 0).reduce((s, t) => s + t.credit_cents, 0);
  const difference = statement ? statement.closing_balance_cents - bookAtStatement : null;
  return {
    account: {
      id: account.id,
      label: account.label,
      companyId: account.company_id,
      companyName: account.company_name,
      bankName: account.bank_name,
      currency: account.currency,
    },
    asOf,
    statement: statement
      ? {
          importId: statement.id,
          statementDate: statement.statement_date,
          openingBalanceCents: statement.opening_balance_cents,
          closingBalanceCents: statement.closing_balance_cents,
          sourceType: statement.source_type,
          sourceFilename: statement.source_filename,
          importedAt: statement.created_at,
        }
      : null,
    bookBalanceAtAsOfCents: bookToday,
    bookBalanceAtStatementDateCents: bookAtStatement,
    differenceCents: difference,
    pending: {
      count: pending.length,
      incomingCents: pendingIncoming,
      outgoingCents: pendingOutgoing,
      forecastBankImpactCents: pendingIncoming - pendingOutgoing,
    },
    unmatched: {
      count: unmatched.length,
      debitCents: unmatchedDebits,
      creditCents: unmatchedCredits,
      items: unmatched.map((t) => ({
        id: t.id,
        transactionDate: t.transaction_date,
        description: t.description,
        debitCents: t.debit_cents,
        creditCents: t.credit_cents,
        bankRef: t.bank_ref,
      })),
    },
    proposals: proposed.map((p) => ({
      matchId: p.match_id,
      bankTransactionId: p.id,
      chequeId: p.cheque_id,
      chequeReference: p.cheque_reference,
      chequeNumber: p.cheque_number,
      score: p.score,
      transactionDate: p.transaction_date,
      description: p.description,
      debitCents: p.debit_cents,
      creditCents: p.credit_cents,
    })),
    confirmed: confirmed.map((c) => ({
      matchId: c.id,
      bankTransactionId: c.bank_transaction_id,
      chequeId: c.cheque_id,
      chequeReference: c.cheque_reference,
      chequeNumber: c.cheque_number,
      transactionDate: c.transaction_date,
      description: c.description,
      debitCents: c.debit_cents,
      creditCents: c.credit_cents,
      settlementApplied: Boolean(c.settlement_applied),
      decidedAt: c.decided_at,
    })),
    definitions: {
      bookBalance: 'Solde comptable calculé à la date du relevé : ouverture + règlements réels + transactions internes.',
      statementBalance: 'Solde de clôture déclaré par la banque sur le relevé le plus récent à la date choisie.',
      difference:
        'Écart entre le solde du relevé et le solde comptable à la même date. Il doit être expliqué par les opérations non rapprochées.',
      pending:
        'Chèques en cours à la date du jour. Ils ne sont pas inclus dans le solde comptable et ne doivent pas être ajoutés sans contrôle.',
    },
  };
}

function getBankTransaction(db, ctx, transactionId) {
  assertPermission(ctx, 'reconciliation.view');
  const row = db
    .prepare(
      `SELECT bt.*, a.label AS account_label, b.name AS bank_name, c.name AS company_name,
              bi.source_type, bi.source_filename, bi.statement_date
       FROM bank_transactions bt
       JOIN bank_accounts a ON a.id = bt.account_id
       JOIN banks b ON b.id = a.bank_id
       JOIN companies c ON c.id = bt.company_id
       JOIN bank_imports bi ON bi.id = bt.import_id
       WHERE bt.id = ?`
    )
    .get(Number(transactionId));
  if (!row) throw notFound('Ligne de relevé');
  assertCompanyAccess(ctx, row.company_id);
  return mapBankTransaction(row, matchesForTransaction(db, row.id));
}

function listMatchCandidates(db, ctx, transactionId) {
  assertPermission(ctx, 'reconciliation.view');
  const tx = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(Number(transactionId));
  if (!tx) throw notFound('Ligne de relevé');
  assertCompanyAccess(ctx, tx.company_id);
  return eligibleCheques(db, tx).slice(0, 25).map((c) => ({
    id: c.id,
    reference: c.reference,
    chequeNumber: c.cheque_number,
    partyName: c.party_name,
    amountCents: c.amount_cents,
    dueDate: c.due_date,
    status: c.status,
    statusLabel: statusLabel(c.status, c.direction),
    direction: c.direction,
    score: scoreCandidate(tx, c, 10).score,
    reasons: scoreCandidate(tx, c, 10).reasons,
  }));
}

module.exports = {
  listBankTransactions,
  autoProposeForTransactions,
  proposeMatch,
  rejectMatch,
  confirmMatch,
  applyApprovedConfirmation,
  reconciliationReport,
  listMatchCandidates,
  getBankTransaction,
  recomputeTransactionStatus,
};
