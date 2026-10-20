'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
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
const { transaction } = require('../db');
const { getAccount } = require('./common');
const { decodeBuffer, parseCsv } = require('../../shared/csv');
const { isValidISODate, todayISO, parseDateWithFormat } = require('../../shared/dates');
const { parseAmountToCents, formatCents } = require('../../shared/money');

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_ROWS = 20000;
const STAGE_TTL_MS = 60 * 60 * 1000;
const staged = new Map();
const batches = new Map();

function cleanupStores() {
  const now = Date.now();
  for (const [token, entry] of staged) if (now - entry.createdAt > STAGE_TTL_MS) staged.delete(token);
  for (const [id, entry] of batches) if (now - entry.createdAt > STAGE_TTL_MS * 2) batches.delete(id);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assertFileFormat(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.csv') return 'CSV';
  if (ext === '.xlsx') return 'XLSX';
  if (ext === '.xls') throw validationError('Le format XLS ancien n’est pas pris en charge. Enregistrez le fichier en XLSX ou CSV.');
  throw validationError('Format de fichier non pris en charge (CSV ou XLSX attendu)');
}

function formatDateValue(value) {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  return value;
}

function cellValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatDateValue(value);
  if (typeof value === 'object') {
    if (value.result !== undefined) return cellValue(value.result);
    if (value.text !== undefined) return value.text;
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
    if (value.hyperlink && value.text) return value.text;
    return String(value);
  }
  return value;
}

async function loadWorkbook(buffer) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

async function parseFileRows(stage, options = {}) {
  const format = stage.format;
  if (format === 'CSV') {
    const text = decodeBuffer(stage.buffer, options.encoding || 'auto');
    const parsed = parseCsv(text, { delimiter: options.delimiter && options.delimiter !== 'auto' ? options.delimiter === 'tab' ? '\t' : options.delimiter : undefined, maxRows: MAX_ROWS + 500 });
    return {
      rows: parsed.rows.map((cells, index) => ({ rowNumber: index + 1, cells })),
      delimiter: parsed.delimiter,
      encoding: options.encoding || 'auto',
      sheets: null,
    };
  }
  const workbook = await loadWorkbook(stage.buffer);
  const sheetName = options.sheetName || workbook.worksheets[0]?.name;
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw validationError('Feuille de calcul introuvable');
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    const count = Math.max(row.cellCount, 1);
    for (let i = 1; i <= count; i += 1) cells.push(cellValue(row.getCell(i).value));
    rows.push({ rowNumber: row.number, cells });
  });
  return { rows, delimiter: null, encoding: null, sheets: workbook.worksheets.map((w) => w.name) };
}

function buildColumns(rows, headerRow, hasHeader) {
  const headerIndex = hasHeader ? Math.max(0, (Number(headerRow) || 1) - 1) : -1;
  const header = headerIndex >= 0 ? rows[headerIndex]?.cells || [] : [];
  const maxCols = Math.max(
    1,
    ...rows.slice(Math.max(0, headerIndex + 1)).map((r) => r.cells.length),
    header.length
  );
  const columns = [];
  for (let i = 0; i < maxCols; i += 1) {
    const label = hasHeader && header[i] !== undefined && String(header[i]).trim() !== '' ? String(header[i]).trim() : `Colonne ${i + 1}`;
    columns.push({ index: i, label });
  }
  let dataRows;
  if (hasHeader) dataRows = rows.slice(headerIndex + 1);
  else dataRows = rows;
  return { columns, dataRows };
}

function guessMapping(columns) {
  const find = (patterns, exclude = []) => {
    for (const col of columns) {
      const label = col.label.toLowerCase();
      if (exclude.some((ex) => ex.test(label))) continue;
      if (patterns.some((p) => p.test(label))) return col.index;
    }
    return null;
  };
  const valueDate = find([/valeur/i]);
  const date = find([/date\s*(op|compta|transaction|mouvement|écriture|ecriture)?/i, /^date$/i], [/valeur/i, /échéance|echeance/i]);
  const description = find([/libell/i, /description/i, /motif/i, /narrat/i, /détail|detail/i, /opération|operation/i], [/date/i]);
  const debit = find([/débit|debit/i, /sortie/i, /retrait/i], [/date/i]);
  const credit = find([/crédit|credit/i, /entrée|entree/i, /versement/i], [/date/i]);
  const amount = find([/montant/i, /amount/i], [/date/i]);
  const balance = find([/solde/i, /balance/i], [/date/i]);
  const reference = find([/réf|ref/i, /pièce|piece/i, /chèque|cheque/i, /num/i], [/date/i, /solde/i]);
  const currency = find([/devise/i, /currency/i]);
  return {
    date,
    valueDate,
    description,
    debit,
    credit,
    amount: debit === null && credit === null ? amount : null,
    balance,
    reference,
    currency,
  };
}

function mappingIsUsable(mapping) {
  return (
    mapping &&
    mapping.date !== null &&
    mapping.date !== undefined &&
    ((mapping.debit !== null && mapping.debit !== undefined) ||
      (mapping.credit !== null && mapping.credit !== undefined) ||
      (mapping.amount !== null && mapping.amount !== undefined))
  );
}

function colValue(cells, index) {
  if (index === null || index === undefined || index === '') return '';
  return cells[index] === undefined ? '' : cells[index];
}

function parseStatementDate(raw, format = 'AUTO') {
  if (raw instanceof Date) return formatDateValue(raw);
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  if (typeof raw === 'number' && raw > 20000 && raw < 80000) {
    // Numéro de série Excel (jours depuis 1899-12-30).
    const date = new Date(Date.UTC(1899, 11, 30) + raw * 86400000);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }
  const text = String(raw).trim();
  if (format && format !== 'AUTO') return parseDateWithFormat(text, format);
  if (isValidISODate(text.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const ymd = text.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
  if (ymd) {
    const iso = `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
    return isValidISODate(iso) ? iso : null;
  }
  const dmy = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  if (dmy) {
    let iso = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    if (isValidISODate(iso)) return iso;
    iso = `${dmy[3]}-${dmy[1].padStart(2, '0')}-${dmy[2].padStart(2, '0')}`;
    return isValidISODate(iso) ? iso : null;
  }
  return null;
}

function parseStatementAmount(raw, { decimalSeparator = 'auto', field = 'montant', allowNegative = false } = {}) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw validationError(`${field} invalide`);
    const cents = Math.round(raw * 100);
    if (!Number.isSafeInteger(cents)) throw validationError(`${field} trop élevé`);
    if (Math.abs(raw * 100 - cents) > 1e-6) throw validationError(`${field} : deux décimales maximum`);
    if (cents < 0 && !allowNegative) throw validationError(`${field} ne peut pas être négatif`);
    return cents;
  }
  let text = String(raw).trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (/-\s*$/.test(text)) {
    negative = true;
    text = text.replace(/-\s*$/, '').trim();
  }
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1).trim();
  }
  text = text.replace(/(DZD|DA|DINARS?|EUR|USD|€|\$)\s*$/i, '').trim();
  text = text.replace(/^(DZD|DA|DINARS?|EUR|USD|€|\$)\s*/i, '').trim();
  text = text.replace(/(DB|CR|D|C)$/i, '').trim();
  if (!/\d/.test(text)) throw validationError(`${field} invalide : « ${raw} »`);
  let normalized = text.replace(/[\s\u00a0\u202f']/g, '');
  if (decimalSeparator === ',') {
    normalized = normalized.replace(/\./g, '');
    normalized = normalized.replace(',', '.');
  } else if (decimalSeparator === '.') {
    normalized = normalized.replace(/,/g, '');
  }
  if (negative) normalized = `-${normalized}`;
  return parseAmountToCents(normalized, { allowNegative, field });
}

function sanitizeRaw(cells) {
  return cells.slice(0, 20).map((c) => (typeof c === 'string' ? c.slice(0, 300) : c));
}

async function stageUploadedFile(ctx, { filename, buffer }) {
  assertPermission(ctx, 'reconciliation.import');
  if (!buffer || !buffer.length) throw validationError('Fichier vide');
  if (buffer.length > MAX_FILE_BYTES) throw validationError('Fichier trop volumineux (15 Mo maximum)');
  const format = assertFileFormat(filename);
  const token = crypto.randomUUID();
  const stage = {
    token,
    userId: ctx.user.id,
    filename: path.basename(String(filename)).slice(0, 200),
    format,
    buffer,
    size: buffer.length,
    sha256: sha256(buffer),
    createdAt: Date.now(),
  };
  // Prévisualisation immédiate pour détecter les erreurs de format.
  const parsed = await parseFileRows(stage, {});
  if (!parsed.rows.length) throw validationError('Le fichier ne contient aucune ligne');
  const built = buildColumns(parsed.rows, 1, true);
  stage.previewSheets = parsed.sheets;
  stage.previewDelimiter = parsed.delimiter;
  staged.set(token, stage);
  cleanupStores();
  return {
    token,
    filename: stage.filename,
    format,
    size: stage.size,
    sha256: stage.sha256,
    sheets: parsed.sheets,
    preview: {
      columns: built.columns,
      rows: built.dataRows.slice(0, 15).map((r) => sanitizeRaw(r.cells)),
      delimiter: parsed.delimiter,
      encoding: parsed.encoding,
      totalRows: built.dataRows.length,
    },
    suggestedMapping: guessMapping(built.columns),
    suggestedOptions: {
      hasHeader: true,
      headerRow: 1,
      dateFormat: 'AUTO',
      decimalSeparator: 'auto',
      delimiter: parsed.delimiter || 'auto',
      encoding: 'auto',
      sheetName: parsed.sheets ? parsed.sheets[0] : null,
      amountDirection: 'NEGATIVE_IS_DEBIT',
    },
  };
}

async function previewImport(db, ctx, input) {
  assertPermission(ctx, 'reconciliation.import');
  const account = getAccount(db, input.accountId);
  assertCompanyAccess(ctx, account.company_id);
  const stage = staged.get(String(input.token || ''));
  if (!stage || stage.userId !== ctx.user.id) throw validationError('Fichier expiré ou inconnu. Sélectionnez à nouveau le relevé.');
  if (Date.now() - stage.createdAt > STAGE_TTL_MS) {
    staged.delete(stage.token);
    throw validationError('Fichier expiré. Sélectionnez à nouveau le relevé.');
  }
  const parsed = await parseFileRows(stage, {
    sheetName: input.sheetName,
    delimiter: input.delimiter,
    encoding: input.encoding,
  });
  const built = buildColumns(parsed.rows, input.headerRow || 1, input.hasHeader !== false);
  const suggestedMapping = guessMapping(built.columns);
  return {
    token: stage.token,
    filename: stage.filename,
    format: stage.format,
    sheets: parsed.sheets,
    delimiter: parsed.delimiter,
    encoding: parsed.encoding,
    columns: built.columns,
    sample: built.dataRows.slice(0, 30).map((r) => sanitizeRaw(r.cells)),
    totalRows: built.dataRows.length,
    suggestedMapping,
    mappingUsable: mappingIsUsable(suggestedMapping),
    currency: account.currency,
    account: { id: account.id, label: account.label, companyId: account.company_id, bankName: account.bank_name },
  };
}

function validateMapping(mapping, columns) {
  if (!mapping || typeof mapping !== 'object') throw validationError('Correspondance des colonnes requise');
  const fields = ['date', 'valueDate', 'description', 'debit', 'credit', 'amount', 'balance', 'reference', 'currency'];
  const out = {};
  for (const field of fields) {
    const v = mapping[field];
    if (v === null || v === undefined || v === '') {
      out[field] = null;
      continue;
    }
    const index = Number(v);
    if (!Number.isInteger(index) || index < 0 || index >= columns.length) {
      throw validationError(`Colonne invalide pour le champ « ${field} »`);
    }
    out[field] = index;
  }
  if (out.date === null) throw validationError('La colonne de date est obligatoire');
  const hasDebitCredit = out.debit !== null || out.credit !== null;
  if (!hasDebitCredit && out.amount === null) throw validationError('Indiquez une colonne débit/crédit ou une colonne montant signé');
  if (hasDebitCredit && out.amount !== null) throw validationError('Choisissez soit débit/crédit, soit montant signé, pas les deux');
  const used = Object.values(out).filter((v) => v !== null);
  if (new Set(used).size !== used.length) throw validationError('La même colonne est utilisée pour plusieurs champs');
  return out;
}

function computeFingerprint(accountId, row, occurrence) {
  const base = [
    accountId,
    row.transactionDate,
    row.valueDate || '',
    row.debitCents,
    row.creditCents,
    row.balanceCents === null ? '' : row.balanceCents,
    row.bankRef || '',
    row.description || '',
    occurrence,
  ].join('|');
  return crypto.createHash('sha256').update(base).digest('hex');
}

async function analyzeImport(db, ctx, input) {
  assertPermission(ctx, 'reconciliation.import');
  const account = getAccount(db, input.accountId);
  assertCompanyAccess(ctx, account.company_id);
  const stage = staged.get(String(input.token || ''));
  if (!stage || stage.userId !== ctx.user.id) throw validationError('Fichier expiré ou inconnu. Sélectionnez à nouveau le relevé.');
  const parsed = await parseFileRows(stage, {
    sheetName: input.options?.sheetName,
    delimiter: input.options?.delimiter,
    encoding: input.options?.encoding,
  });
  const built = buildColumns(parsed.rows, input.options?.headerRow || 1, input.options?.hasHeader !== false);
  const mapping = validateMapping(input.mapping, built.columns);
  const options = {
    dateFormat: input.options?.dateFormat || 'AUTO',
    decimalSeparator: input.options?.decimalSeparator || 'auto',
    amountDirection: input.options?.amountDirection || 'NEGATIVE_IS_DEBIT',
  };
  const issues = [];
  const validRows = [];
  const occurrenceCounts = new Map();
  let errorRows = 0;
  let totalDebit = 0;
  let totalCredit = 0;
  let statementDateSuggestion = null;
  let closingSuggestion = null;
  let processed = 0;

  for (const row of built.dataRows) {
    const cells = row.cells;
    if (!cells.some((c) => c !== '' && c !== null && c !== undefined)) continue;
    processed += 1;
    if (processed > MAX_ROWS) throw validationError(`Relevé trop volumineux (${MAX_ROWS} lignes maximum)`);
    const rowIssues = [];
    const raw = sanitizeRaw(cells);
    let transactionDate;
    let valueDate = null;
    let debitCents = 0;
    let creditCents = 0;
    let balanceCents = null;
    let description = null;
    let bankRef = null;
    try {
      const dateRaw = colValue(cells, mapping.date);
      transactionDate = parseStatementDate(dateRaw, options.dateFormat);
      if (!transactionDate) rowIssues.push({ severity: 'ERROR', code: 'DATE_INVALIDE', message: `Date invalide : « ${String(dateRaw).slice(0, 60)} »` });
      else if (transactionDate > todayISO()) rowIssues.push({ severity: 'ERROR', code: 'DATE_FUTURE', message: 'Date postérieure à aujourd’hui' });
      if (mapping.valueDate !== null) {
        const rawValueDate = colValue(cells, mapping.valueDate);
        if (String(rawValueDate).trim() !== '') {
          valueDate = parseStatementDate(rawValueDate, options.dateFormat);
          if (!valueDate) rowIssues.push({ severity: 'ERROR', code: 'DATE_VALEUR_INVALIDE', message: 'Date de valeur invalide' });
        }
      }
      if (mapping.description !== null) {
        const d = String(colValue(cells, mapping.description)).trim();
        description = d ? d.slice(0, 500) : null;
      }
      if (mapping.reference !== null) {
        const r = String(colValue(cells, mapping.reference)).trim();
        bankRef = r ? r.slice(0, 120) : null;
      }
      if (mapping.balance !== null) {
        const rawBalance = colValue(cells, mapping.balance);
        if (String(rawBalance).trim() !== '') {
          balanceCents = parseStatementAmount(rawBalance, {
            decimalSeparator: options.decimalSeparator,
            field: 'solde',
            allowNegative: true,
          });
        }
      }
      if (mapping.currency !== null) {
        const cur = String(colValue(cells, mapping.currency)).trim().toUpperCase();
        if (cur && cur !== account.currency) {
          rowIssues.push({ severity: 'ERROR', code: 'DEVISE', message: `Devise ${cur} différente du compte (${account.currency})` });
        }
      }
      if (mapping.amount !== null) {
        const rawAmount = colValue(cells, mapping.amount);
        const signed = parseStatementAmount(rawAmount, {
          decimalSeparator: options.decimalSeparator,
          field: 'montant',
          allowNegative: true,
        });
        if (signed === null) rowIssues.push({ severity: 'ERROR', code: 'MONTANT_ABSENT', message: 'Montant absent' });
        else if (signed === 0) rowIssues.push({ severity: 'ERROR', code: 'MONTANT_NUL', message: 'Montant nul' });
        else if (options.amountDirection === 'POSITIVE_IS_DEBIT') {
          if (signed > 0) debitCents = signed;
          else creditCents = -signed;
        } else if (signed < 0) debitCents = -signed;
        else creditCents = signed;
      } else {
        if (mapping.debit !== null) {
          const d = parseStatementAmount(colValue(cells, mapping.debit), {
            decimalSeparator: options.decimalSeparator,
            field: 'débit',
          });
          if (d !== null) debitCents = d;
        }
        if (mapping.credit !== null) {
          const c = parseStatementAmount(colValue(cells, mapping.credit), {
            decimalSeparator: options.decimalSeparator,
            field: 'crédit',
          });
          if (c !== null) creditCents = c;
        }
        if (debitCents > 0 && creditCents > 0) {
          rowIssues.push({ severity: 'ERROR', code: 'DEBIT_ET_CREDIT', message: 'Débit et crédit renseignés simultanément' });
        } else if (debitCents === 0 && creditCents === 0) {
          rowIssues.push({ severity: 'ERROR', code: 'MONTANT_ABSENT', message: 'Aucun débit ni crédit' });
        }
      }
      if (!description && !bankRef) {
        rowIssues.push({ severity: 'ERROR', code: 'LIBELLE_ABSENT', message: 'Libellé et référence absents' });
      }
    } catch (err) {
      rowIssues.push({ severity: 'ERROR', code: 'VALEUR_INVALIDE', message: err.message });
    }

    if (transactionDate && !statementDateSuggestion) statementDateSuggestion = transactionDate;
    if (transactionDate && statementDateSuggestion && transactionDate > statementDateSuggestion) statementDateSuggestion = transactionDate;

    if (rowIssues.some((i) => i.severity === 'ERROR')) {
      errorRows += 1;
      for (const issue of rowIssues) issues.push({ ...issue, rowNumber: row.rowNumber, raw });
      continue;
    }
    if (balanceCents !== null) closingSuggestion = balanceCents;
    totalDebit += debitCents;
    totalCredit += creditCents;
    const baseKey = `${transactionDate}|${valueDate || ''}|${debitCents}|${creditCents}|${balanceCents}|${bankRef || ''}|${description || ''}`;
    const occurrence = (occurrenceCounts.get(baseKey) || 0) + 1;
    occurrenceCounts.set(baseKey, occurrence);
    const fingerprint = computeFingerprint(account.id, { transactionDate, valueDate, debitCents, creditCents, balanceCents, bankRef, description }, occurrence);
    const existing = db
      .prepare('SELECT id FROM bank_transactions WHERE account_id = ? AND fingerprint = ?')
      .get(account.id, fingerprint);
    if (existing) {
      issues.push({
        severity: 'WARNING',
        code: 'DOUBLON_EXISTANT',
        message: 'Ligne déjà présente dans un import antérieur : elle sera ignorée.',
        rowNumber: row.rowNumber,
        raw,
      });
    }
    validRows.push({
      rowNumber: row.rowNumber,
      bankRef,
      transactionDate,
      valueDate,
      description,
      debitCents,
      creditCents,
      balanceCents,
      currency: account.currency,
      fingerprint,
      duplicateExisting: Boolean(existing),
    });
    for (const issue of rowIssues) issues.push({ ...issue, rowNumber: row.rowNumber, raw });
  }

  if (!validRows.length) {
    throw new AppError('IMPORT_INVALID', 'Aucune ligne valide dans le relevé', {
      errorRows,
      issues: issues.filter((i) => i.severity === 'ERROR').slice(0, 200),
    });
  }
  const batchId = crypto.randomUUID();
  const batch = {
    id: batchId,
    userId: ctx.user.id,
    accountId: account.id,
    companyId: account.company_id,
    filename: stage.filename,
    sha256: stage.sha256,
    size: stage.size,
    format: stage.format,
    createdAt: Date.now(),
    rows: validRows,
    issues,
    errorRows,
    totalRows: processed,
    options: { ...options, mapping, ...input.options },
    suggestion: { statementDate: statementDateSuggestion, closingBalanceCents: closingSuggestion },
    totals: { debitCents: totalDebit, creditCents: totalCredit, netCents: totalCredit - totalDebit },
  };
  batches.set(batchId, batch);
  // Limiter la mémoire de travail.
  const userBatches = [...batches.values()].filter((b) => b.userId === ctx.user.id).sort((a, b) => a.createdAt - b.createdAt);
  while (userBatches.length > 5) batches.delete(userBatches.shift().id);
  cleanupStores();
  return {
    batchId,
    filename: stage.filename,
    accountId: account.id,
    companyId: account.company_id,
    totalRows: processed,
    validRows: validRows.length,
    invalidRows: errorRows,
    existingDuplicates: validRows.filter((r) => r.duplicateExisting).length,
    issues: issues.slice(0, 200),
    issueCount: issues.length,
    totals: batch.totals,
    suggestion: batch.suggestion,
    preview: validRows.slice(0, 100),
    options: batch.options,
  };
}

function assertBatch(db, ctx, batchId, accountId) {
  const batch = batches.get(String(batchId));
  if (!batch || batch.userId !== ctx.user.id) throw validationError('Analyse expirée ou inconnue. Relancez l’analyse du relevé.');
  if (Date.now() - batch.createdAt > STAGE_TTL_MS * 2) {
    batches.delete(batch.id);
    throw validationError('Analyse expirée. Relancez l’import.');
  }
  const account = getAccount(db, accountId || batch.accountId);
  assertCompanyAccess(ctx, account.company_id);
  if (account.id !== batch.accountId) throw forbidden('Le compte a changé depuis l’analyse');
  return { batch, account };
}

async function commitImport(db, ctx, input) {
  assertPermission(ctx, 'reconciliation.import');
  const { batch, account } = assertBatch(db, ctx, input.batchId, input.accountId);
  if (!account.is_active) throw forbidden('Compte bancaire désactivé');
  if (batch.errorRows > 0 && !input.allowPartial) {
    throw new AppError('IMPORT_INVALID', 'Des lignes sont invalides. Corrigez le fichier ou autorisez un import partiel explicite.', {
      invalidRows: batch.errorRows,
      issues: batch.issues.filter((i) => i.severity === 'ERROR').slice(0, 200),
    });
  }
  const statementDate = String(input.statementDate || batch.suggestion.statementDate || '');
  if (!isValidISODate(statementDate)) throw validationError('Date du relevé invalide');
  if (statementDate > todayISO()) throw validationError('La date du relevé ne peut pas être dans le futur');
  const closingBalanceCents =
    input.closingBalance !== undefined && input.closingBalance !== null && String(input.closingBalance) !== ''
      ? parseAmountToCents(input.closingBalance, { allowNegative: true, field: 'Solde de clôture' })
      : batch.suggestion.closingBalanceCents;
  if (closingBalanceCents === null || closingBalanceCents === undefined) {
    throw validationError('Le solde de clôture du relevé est obligatoire');
  }
  const openingBalanceCents =
    input.openingBalance !== undefined && input.openingBalance !== null && String(input.openingBalance) !== ''
      ? parseAmountToCents(input.openingBalance, { allowNegative: true, field: 'Solde d’ouverture du relevé' })
      : null;
  const duplicateFile = db
    .prepare('SELECT id, created_at FROM bank_imports WHERE account_id = ? AND source_sha256 = ?')
    .get(account.id, batch.sha256);
  if (duplicateFile) {
    throw new AppError('CONFLICT', `Ce fichier a déjà été importé pour ce compte (import #${duplicateFile.id}).`, {
      importId: duplicateFile.id,
      importedAt: duplicateFile.created_at,
    });
  }

  let importId;
  let importedCount = 0;
  let duplicateCount = 0;
  const written = [];
  transaction(db, () => {
    importId = Number(
      db
        .prepare(
          `INSERT INTO bank_imports(
            company_id, account_id, source_type, source_filename, source_sha256, source_size, format_options_json,
            statement_date, opening_balance_cents, closing_balance_cents, currency, row_count, imported_count,
            duplicate_count, rejected_count, status, imported_by, notes
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          account.company_id,
          account.id,
          batch.format,
          batch.filename,
          batch.sha256,
          batch.size,
          JSON.stringify(batch.options),
          statementDate,
          openingBalanceCents,
          closingBalanceCents,
          account.currency,
          batch.totalRows,
          0,
          0,
          batch.errorRows,
          batch.errorRows > 0 ? 'PARTIAL' : 'COMPLETED',
          ctx.user.id,
          input.notes || null
        ).lastInsertRowid
    );
    const insertRow = db.prepare(
      `INSERT INTO bank_transactions(
        import_id, company_id, account_id, bank_ref, transaction_date, value_date, description,
        debit_cents, credit_cents, balance_cents, currency, row_number, fingerprint
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const row of batch.rows) {
      const existing = db
        .prepare('SELECT id FROM bank_transactions WHERE account_id = ? AND fingerprint = ?')
        .get(account.id, row.fingerprint);
      if (existing) {
        duplicateCount += 1;
        continue;
      }
      const id = Number(
        insertRow.run(
          importId,
          account.company_id,
          account.id,
          row.bankRef,
          row.transactionDate,
          row.valueDate,
          row.description,
          row.debitCents,
          row.creditCents,
          row.balanceCents,
          row.currency,
          row.rowNumber,
          row.fingerprint
        ).lastInsertRowid
      );
      written.push(id);
      importedCount += 1;
    }
    const issueInsert = db.prepare(
      `INSERT INTO bank_import_issues(import_id,row_number,severity,code,message,raw_json) VALUES (?,?,?,?,?,?)`
    );
    for (const issue of batch.issues.slice(0, 5000)) {
      issueInsert.run(
        importId,
        issue.rowNumber || null,
        issue.severity,
        issue.code,
        String(issue.message).slice(0, 500),
        JSON.stringify(issue.raw || null)
      );
    }
    db.prepare(
      `UPDATE bank_imports SET imported_count=?, duplicate_count=?, status=? WHERE id=?`
    ).run(importedCount, duplicateCount, batch.errorRows > 0 ? 'PARTIAL' : 'COMPLETED', importId);
    appendAudit(db, ctx, {
      companyId: account.company_id,
      entityType: 'IMPORT',
      entityId: importId,
      action: 'BANK_IMPORT',
      after: {
        accountId: account.id,
        filename: batch.filename,
        sha256: batch.sha256,
        statementDate,
        closingBalanceCents,
        importedCount,
        duplicateCount,
        rejectedCount: batch.errorRows,
        totalRows: batch.totalRows,
      },
      reason: input.reason || 'Import d’un relevé bancaire',
    });
  });

  batches.delete(batch.id);
  let proposals = 0;
  let proposalError = null;
  try {
    if (getSetting(db, 'reconciliation.auto_propose', true) && written.length) {
      const reconciliation = require('./reconciliation');
      proposals = reconciliation.autoProposeForTransactions(db, ctx, written);
    }
  } catch (err) {
    proposalError = err.message;
  }
  return {
    importId,
    importedCount,
    duplicateCount,
    rejectedCount: batch.errorRows,
    totalRows: batch.totalRows,
    statementDate,
    closingBalanceCents,
    closingBalanceFormatted: formatCents(closingBalanceCents),
    proposals,
    proposalError,
    filename: batch.filename,
  };
}

function setManualBalance(db, ctx, input) {
  assertPermission(ctx, 'reconciliation.import');
  const account = getAccount(db, input.accountId);
  assertCompanyAccess(ctx, account.company_id);
  const statementDate = String(input.statementDate || todayISO());
  if (!isValidISODate(statementDate)) throw validationError('Date du relevé invalide');
  if (statementDate > todayISO()) throw validationError('La date du relevé ne peut pas être dans le futur');
  const closing =
    input.closingBalanceCents !== undefined && input.closingBalanceCents !== null
      ? Number(input.closingBalanceCents)
      : parseAmountToCents(input.closingBalance, { allowNegative: true, field: 'Solde du relevé' });
  if (!Number.isInteger(closing)) throw validationError('Solde du relevé invalide (centimes entiers attendus)');
  const opening =
    input.openingBalanceCents !== undefined && input.openingBalanceCents !== null
      ? Number(input.openingBalanceCents)
      : input.openingBalance === undefined || input.openingBalance === null || String(input.openingBalance) === ''
        ? null
        : parseAmountToCents(input.openingBalance, { allowNegative: true, field: 'Solde d’ouverture' });
  if (opening !== null && !Number.isInteger(opening)) throw validationError('Solde d’ouverture invalide');
  return transaction(db, () => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO bank_imports(company_id,account_id,source_type,statement_date,opening_balance_cents,
            closing_balance_cents,currency,row_count,imported_count,status,imported_by,notes)
           VALUES (?,?,'MANUAL',?,?,?,?,0,0,'MANUAL',?,?)`
        )
        .run(account.company_id, account.id, statementDate, opening, closing, account.currency, ctx.user.id, input.notes || 'Solde déclaré manuellement')
        .lastInsertRowid
    );
    appendAudit(db, ctx, {
      companyId: account.company_id,
      entityType: 'IMPORT',
      entityId: id,
      action: 'MANUAL_BALANCE',
      after: { accountId: account.id, statementDate, closingBalanceCents: closing, openingBalanceCents: opening },
      reason: input.reason || 'Saisie manuelle du solde bancaire',
    });
    return { importId: id, statementDate, closingBalanceCents: closing };
  });
}

function listImports(db, ctx, options = {}) {
  assertPermission(ctx, 'reconciliation.view');
  const companyIds = resolveCompanyScope(ctx, options.companyIds);
  if (!companyIds.length) return [];
  const params = [...companyIds];
  let where = `bi.company_id IN (${companyIds.map(() => '?').join(',')})`;
  if (options.accountId) {
    where += ' AND bi.account_id = ?';
    params.push(Number(options.accountId));
  }
  return db
    .prepare(
      `SELECT bi.*, a.label AS account_label, b.name AS bank_name, c.name AS company_name, u.full_name AS importer_name
       FROM bank_imports bi
       JOIN bank_accounts a ON a.id = bi.account_id
       JOIN banks b ON b.id = a.bank_id
       JOIN companies c ON c.id = bi.company_id
       LEFT JOIN users u ON u.id = bi.imported_by
       WHERE ${where} ORDER BY bi.statement_date DESC, bi.id DESC LIMIT 200`
    )
    .all(...params)
    .map((r) => ({
      id: r.id,
      companyId: r.company_id,
      companyName: r.company_name,
      accountId: r.account_id,
      accountLabel: r.account_label,
      bankName: r.bank_name,
      sourceType: r.source_type,
      sourceFilename: r.source_filename,
      statementDate: r.statement_date,
      openingBalanceCents: r.opening_balance_cents,
      closingBalanceCents: r.closing_balance_cents,
      currency: r.currency,
      rowCount: r.row_count,
      importedCount: r.imported_count,
      duplicateCount: r.duplicate_count,
      rejectedCount: r.rejected_count,
      status: r.status,
      importedBy: r.imported_by,
      importerName: r.importer_name,
      createdAt: r.created_at,
      notes: r.notes,
    }));
}

function getImportDetail(db, ctx, importId) {
  assertPermission(ctx, 'reconciliation.view');
  const row = db
    .prepare(
      `SELECT bi.*, a.label AS account_label, b.name AS bank_name, c.name AS company_name
       FROM bank_imports bi JOIN bank_accounts a ON a.id = bi.account_id
       JOIN banks b ON b.id = a.bank_id JOIN companies c ON c.id = bi.company_id WHERE bi.id = ?`
    )
    .get(Number(importId));
  if (!row) throw notFound('Import');
  assertCompanyAccess(ctx, row.company_id);
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    accountId: row.account_id,
    accountLabel: row.account_label,
    bankName: row.bank_name,
    sourceType: row.source_type,
    sourceFilename: row.source_filename,
    sourceSha256: row.source_sha256,
    statementDate: row.statement_date,
    openingBalanceCents: row.opening_balance_cents,
    closingBalanceCents: row.closing_balance_cents,
    rowCount: row.row_count,
    importedCount: row.imported_count,
    duplicateCount: row.duplicate_count,
    rejectedCount: row.rejected_count,
    status: row.status,
    createdAt: row.created_at,
    notes: row.notes,
    issues: db
      .prepare('SELECT row_number, severity, code, message, raw_json FROM bank_import_issues WHERE import_id = ? ORDER BY id LIMIT 1000')
      .all(row.id)
      .map((i) => ({ rowNumber: i.row_number, severity: i.severity, code: i.code, message: i.message, raw: i.raw_json })),
    transactions: db
      .prepare(
        `SELECT id, transaction_date, value_date, description, debit_cents, credit_cents, balance_cents, bank_ref, row_number, match_status
         FROM bank_transactions WHERE import_id = ? ORDER BY row_number LIMIT 5000`
      )
      .all(row.id)
      .map((t) => ({
        id: t.id,
        transactionDate: t.transaction_date,
        valueDate: t.value_date,
        description: t.description,
        debitCents: t.debit_cents,
        creditCents: t.credit_cents,
        balanceCents: t.balance_cents,
        bankRef: t.bank_ref,
        rowNumber: t.row_number,
        matchStatus: t.match_status,
      })),
  };
}

module.exports = {
  stageUploadedFile,
  previewImport,
  analyzeImport,
  commitImport,
  setManualBalance,
  listImports,
  getImportDetail,
  parseStatementDate,
  parseStatementAmount,
  guessMapping,
  MAX_FILE_BYTES,
  _stores: { staged, batches },
};
