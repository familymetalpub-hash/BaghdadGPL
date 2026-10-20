'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { assertPermission, validationError, forbidden, AppError } = require('./authorization');
const { appendAudit } = require('./audit');
const { nextSequence, makeReference, transaction } = require('../db');
const { isValidISODate, todayISO, addDays } = require('../../shared/dates');
const { normalizeChequeNumber } = require('../../shared/status');
const { parseAmountToCents } = require('../../shared/money');

const analyses = new Map();
const TTL = 2 * 60 * 60 * 1000;

const LEGACY_STATUS = {
  RECU: { received: 'RECU', deposited: 'DEPOSE', cashed: 'A_REGULARISER', returned: 'IMPAYE', endorsed: 'ENDOSSE' },
  EMIS: { issued: 'EMIS', delivered: 'REMIS', paid: 'A_REGULARISER', returned: 'REJETE', cancelled: 'ANNULE' },
};

const LEGACY_TX = { deposit: 'DEPOT', withdraw: 'RETRAIT', fee: 'FRAIS', interest: 'INTERETS', loan: 'REMBOURSEMENT_PRET' };

function hashCode(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function cents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function issue(list, severity, code, message, meta = {}) {
  list.push({ severity, code, message, ...meta });
}

function duplicateIds(items) {
  const counts = new Map();
  for (const item of items) {
    if (item && typeof item === 'object' && item.id !== undefined) {
      const key = String(item.id);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id));
}

function validId(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function demoSignature(data) {
  const knownCompanies = ['الأمل للتجارة', 'النور للبناء'];
  const knownNumbers = ['7845120', '3301457', '9902211', '5521908', '1203344', '6610098', '5521900'];
  const reasons = [];
  const names = (Array.isArray(data.companies) ? data.companies : []).map((c) => String(c.name || '').trim());
  if (knownCompanies.some((n) => names.includes(n))) reasons.push('noms des sociétés du jeu de démonstration d’origine');
  const numbers = (Array.isArray(data.cheques) ? data.cheques : []).map((c) => String(c.no || '').trim());
  if (knownNumbers.filter((n) => numbers.includes(n)).length >= 3) reasons.push('numéros de chèques du jeu de démonstration d’origine');
  return { suspect: reasons.length > 0, reasons };
}

function analyse(db, ctx, input) {
  assertPermission(ctx, 'migration.run');
  if (!input || typeof input.rawText !== 'string') throw validationError('Contenu source manquant');
  const sha256 = hashCode(input.rawText);
  let data;
  try {
    data = JSON.parse(input.rawText);
  } catch (err) {
    throw new AppError('INVALID_LEGACY', `JSON invalide : ${err.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppError('INVALID_LEGACY', 'Structure racine invalide');
  const issues = [];
  const fatal = [];
  const warnings = [];
  const raw = {
    companies: Array.isArray(data.companies) ? data.companies : [],
    accounts: Array.isArray(data.accounts) ? data.accounts : [],
    cheques: Array.isArray(data.cheques) ? data.cheques : [],
    tx: Array.isArray(data.tx) ? data.tx : [],
    books: Array.isArray(data.books) ? data.books : [],
    log: Array.isArray(data.log) ? data.log : [],
  };
  for (const key of ['companies', 'accounts', 'cheques']) {
    if (!Array.isArray(data[key])) fatal.push({ code: 'STRUCTURE', message: `Tableau « ${key} » absent`, severity: 'FATAL' });
  }
  if (fatal.length) {
    throw new AppError('INVALID_LEGACY', 'Le fichier ne ressemble pas à une sauvegarde de l’application d’origine', { fatal });
  }
  const existingImport = db.prepare('SELECT id, imported_at FROM legacy_imports WHERE source_sha256 = ?').get(sha256);
  if (data.pw !== undefined) warnings.push({ code: 'MOT_DE_PASSE_IGNORE', message: 'Le mot de passe global d’origine n’est pas migré (sécurité).', severity: 'WARNING' });

  // --- Sociétés ---
  const companyDup = duplicateIds(raw.companies);
  const companies = [];
  const companyMap = new Map();
  const usedCodes = new Set(db.prepare('SELECT code FROM companies').all().map((r) => r.code.toUpperCase()));
  const usedNifs = new Set(db.prepare('SELECT nif FROM companies WHERE nif IS NOT NULL').all().map((r) => r.nif));
  let companyIndex = 0;
  for (const c of raw.companies) {
    if (!c || typeof c !== 'object') {
      issue(issues, 'ERROR', 'SOCIETE_INVALIDE', 'Entrée société non objet');
      continue;
    }
    if (!validId(c.id)) {
      issue(issues, 'ERROR', 'SOCIETE_SANS_ID', 'Société sans identifiant');
      continue;
    }
    if (companyDup.has(String(c.id))) {
      issue(issues, 'ERROR', 'ID_DUPLIQUE', `Identifiant société dupliqué : ${c.id}`, { legacyId: c.id });
      continue;
    }
    const name = String(c.name || '').trim();
    if (!name) {
      issue(issues, 'ERROR', 'SOCIETE_SANS_NOM', `Société ${c.id} sans nom`, { legacyId: c.id });
      continue;
    }
    companyIndex += 1;
    let code;
    do {
      code = `LEG-${String(companyIndex).padStart(3, '0')}`;
      companyIndex += 1;
    } while (usedCodes.has(code));
    usedCodes.add(code);
    let nif = c.nif ? String(c.nif).trim() : null;
    if (nif && usedNifs.has(nif)) {
      issue(issues, 'WARNING', 'NIF_DUPLIQUE', `NIF déjà présent, conservé à null pour ${name}`, { legacyId: c.id });
      nif = null;
    }
    if (nif) usedNifs.add(nif);
    const company = {
      legacyId: String(c.id),
      code,
      name,
      legalForm: c.form ? String(c.form).slice(0, 40) : null,
      nif,
      nis: c.nis ? String(c.nis).slice(0, 40) : null,
      rc: c.rc ? String(c.rc).slice(0, 60) : null,
      ai: c.ai ? String(c.ai).slice(0, 60) : null,
      managerName: c.mgr ? String(c.mgr).slice(0, 120) : null,
      capitalCents: Number.isFinite(Number(c.cap)) ? Math.round(Number(c.cap) * 100) : 0,
      address: c.addr ? String(c.addr).slice(0, 300) : null,
      wilaya: c.wilaya ? String(c.wilaya).slice(0, 80) : null,
      phone: c.tel ? String(c.tel).slice(0, 40) : null,
      email: c.mail ? String(c.mail).slice(0, 160) : null,
      color: /^#[0-9a-fA-F]{6}$/.test(String(c.color || '')) ? c.color : '#0f766e',
      raw: { name: c.name, form: c.form, nif: c.nif },
    };
    companies.push(company);
    companyMap.set(String(c.id), company);
  }

  // --- Comptes ---
  const accountDup = duplicateIds(raw.accounts);
  const accounts = [];
  const accountMap = new Map();
  const bankSet = new Map();
  const accountUniqueKeys = new Set();
  const accountDates = new Map();
  const collectDate = (accountId, value) => {
    if (!isValidISODate(String(value))) return;
    const list = accountDates.get(accountId) || [];
    list.push(String(value));
    accountDates.set(accountId, list);
  };
  for (const c of raw.cheques) {
    if (c && c.acc && isValidISODate(String(c.due))) collectDate(String(c.acc), c.due);
    if (c && c.acc && isValidISODate(String(c.rd))) collectDate(String(c.acc), c.rd);
    if (c && c.acc && isValidISODate(String(c.rs))) collectDate(String(c.acc), c.rs);
  }
  for (const t of raw.tx) {
    if (t && t.acc && isValidISODate(String(t.date))) collectDate(String(t.acc), t.date);
  }
  for (const a of raw.accounts) {
    if (!a || typeof a !== 'object') {
      issue(issues, 'ERROR', 'COMPTE_INVALIDE', 'Entrée compte non objet');
      continue;
    }
    if (!validId(a.id)) {
      issue(issues, 'ERROR', 'COMPTE_SANS_ID', 'Compte sans identifiant');
      continue;
    }
    if (accountDup.has(String(a.id))) {
      issue(issues, 'ERROR', 'ID_DUPLIQUE', `Identifiant compte dupliqué : ${a.id}`, { legacyId: a.id });
      continue;
    }
    const company = companyMap.get(String(a.co));
    if (!company) {
      issue(issues, 'ERROR', 'COMPTE_ORPHELIN', `Compte ${a.id} rattaché à une société inexistante`, { legacyId: a.id });
      continue;
    }
    const label = String(a.name || '').trim() || `Compte importé ${a.id}`;
    const bankName = String(a.bank || a.name || 'Banque (migration)').trim().slice(0, 120) || 'Banque (migration)';
    let number = String(a.no || '').trim() || `LEGACY-${a.id}`;
    if (!a.no) issue(issues, 'WARNING', 'NUMERO_COMPTE_GENERE', `Compte ${label} sans numéro : numéro technique généré`, { legacyId: a.id });
    const bankKey = bankName.toLowerCase();
    if (!bankSet.has(bankKey)) bankSet.set(bankKey, bankName);
    let uniqueKey = `${company.legacyId}|${bankKey}|${number.toLowerCase()}`;
    if (accountUniqueKeys.has(uniqueKey)) {
      number = `${number}-LEG${String(a.id).slice(-6)}`;
      uniqueKey = `${company.legacyId}|${bankKey}|${number.toLowerCase()}`;
      issue(issues, 'WARNING', 'NUMERO_COMPTE_DUPLIQUE', `Numéro dupliqué pour ${label} : suffixe historique ajouté`, { legacyId: a.id });
    }
    accountUniqueKeys.add(uniqueKey);
    const openingCents = cents(a.open) ?? 0;
    if (cents(a.open) === null) issue(issues, 'WARNING', 'SOLDE_INVALIDE', `Solde d’ouverture invalide pour ${label} : 0 utilisé`, { legacyId: a.id });
    const dates = (accountDates.get(String(a.id)) || []).filter(isValidISODate).sort();
    let openingDate = dates.length ? dates[0] : todayISO();
    if (dates.length) openingDate = addDays(openingDate, -1);
    if (!isValidISODate(openingDate)) openingDate = todayISO();
    const account = {
      legacyId: String(a.id),
      companyLegacyId: company.legacyId,
      company,
      bankName,
      label,
      number,
      openingCents,
      openingDate,
      raw: { name: a.name, no: a.no, open: a.open },
    };
    accounts.push(account);
    accountMap.set(String(a.id), account);
  }

  // --- Contreparties ---
  const counterparties = [];
  const cpMap = new Map();
  const cpByCompany = new Map();
  const cpFor = (company, nameRaw, legacyId) => {
    let name = String(nameRaw || '').trim();
    if (!name) {
      name = `Partie inconnue (${legacyId})`;
      issue(issues, 'WARNING', 'PARTIE_INCONNUE', `Partie absente pour un chèque : libellé technique créé`, { legacyId });
    }
    const key = `${company.legacyId}|${name.toLowerCase()}`;
    if (cpMap.has(key)) return cpMap.get(key);
    const type = /زبون|client/i.test(name) ? 'CLIENT' : /مورّد|fournisseur/i.test(name) ? 'FOURNISSEUR' : 'AUTRE';
    const cp = {
      key,
      company,
      name,
      type,
      rawName: name,
    };
    const list = cpByCompany.get(company.legacyId) || [];
    list.push(cp);
    cpByCompany.set(company.legacyId, list);
    counterparties.push(cp);
    cpMap.set(key, cp);
    return cp;
  };

  // --- Chèques ---
  const chequeDup = duplicateIds(raw.cheques);
  const cheques = [];
  const chequeNumberKeys = new Map();
  for (const c of raw.cheques) {
    if (!c || typeof c !== 'object') {
      issue(issues, 'ERROR', 'CHEQUE_INVALIDE', 'Entrée chèque non objet');
      continue;
    }
    if (!validId(c.id)) {
      issue(issues, 'ERROR', 'CHEQUE_SANS_ID', 'Chèque sans identifiant');
      continue;
    }
    if (chequeDup.has(String(c.id))) {
      issue(issues, 'ERROR', 'ID_DUPLIQUE', `Identifiant chèque dupliqué : ${c.id}`, { legacyId: c.id });
      continue;
    }
    const company = companyMap.get(String(c.co));
    const account = accountMap.get(String(c.acc));
    if (!company || !account) {
      issue(issues, 'ERROR', 'CHEQUE_ORPHELIN', `Chèque ${c.no || c.id} : société ou compte inexistant`, { legacyId: c.id });
      continue;
    }
    if (account.company.legacyId !== company.legacyId) {
      issue(issues, 'ERROR', 'CHEQUE_COMPTE_INCOHERENT', `Chèque ${c.no || c.id} : le compte n’appartient pas à la société`, { legacyId: c.id });
      continue;
    }
    const direction = c.dir === 'in' ? 'RECU' : c.dir === 'out' ? 'EMIS' : null;
    if (!direction) {
      issue(issues, 'ERROR', 'SENS_INVALIDE', `Chèque ${c.no || c.id} : sens « ${c.dir} » invalide`, { legacyId: c.id });
      continue;
    }
    const amountCents = cents(c.amt);
    if (amountCents === null || amountCents <= 0) {
      issue(issues, 'ERROR', 'MONTANT_INVALIDE', `Chèque ${c.no || c.id} : montant invalide`, { legacyId: c.id });
      continue;
    }
    if (!isValidISODate(String(c.due))) {
      issue(issues, 'ERROR', 'ECHEANCE_INVALIDE', `Chèque ${c.no || c.id} : échéance invalide ou absente`, { legacyId: c.id });
      continue;
    }
    const flags = ['LEGACY_IMPORT', 'ISSUE_DATE_INFERRED'];
    const legacyStatus = String(c.status || '');
    let status = LEGACY_STATUS[direction][legacyStatus];
    if (!status) {
      status = 'A_REGULARISER';
      flags.push('UNKNOWN_LEGACY_STATUS');
      issue(issues, 'WARNING', 'STATUT_INCONNU', `Chèque ${c.no || c.id} : statut d’origine « ${legacyStatus} » inconnu, à régulariser`, { legacyId: c.id });
    }
    if (status === 'A_REGULARISER') {
      flags.push('SETTLEMENT_DATE_MISSING');
      issue(
        issues,
        'WARNING',
        'DATE_REGLEMENT_MANQUANTE',
        `Chèque ${c.no || c.id} : le statut d’origine « ${legacyStatus} » supposait un règlement, mais aucune date réelle n’est disponible. Importé « À régulariser », sans effet de trésorerie.`,
        { legacyId: c.id }
      );
    }
    const issueDate = String(c.due);
    let receiptDate = null;
    let depositDate = null;
    let cancellationDate = null;
    let returnDate = null;
    if (direction === 'RECU' && status !== 'A_REGULARISER') {
      flags.push('RECEIPT_DATE_MISSING');
    }
    if (status === 'DEPOSE') {
      depositDate = String(c.due);
      flags.push('DEPOSIT_DATE_INFERRED');
    }
    if (status === 'ANNULE') {
      cancellationDate = todayISO();
      flags.push('CANCELLATION_DATE_INFERRED');
    }
    if (['REJETE', 'IMPAYE', 'RETOURNE'].includes(status)) {
      if (isValidISODate(String(c.rd))) returnDate = String(c.rd);
      else flags.push('RETURN_DATE_MISSING');
    }
    let number = String(c.no || '').trim();
    if (!number) {
      number = `LEGACY-${String(c.id)}`;
      flags.push('NUMBER_GENERATED');
      issue(issues, 'WARNING', 'NUMERO_GENERE', `Chèque ${c.id} sans numéro : numéro technique généré`, { legacyId: c.id });
    }
    const normalized = normalizeChequeNumber(number);
    const duplicateKey = `${company.legacyId}|${account.legacyId}|${direction}|${normalized}`;
    let duplicate = false;
    if (chequeNumberKeys.has(duplicateKey)) {
      duplicate = true;
      flags.push('LEGACY_DUPLICATE');
      issue(issues, 'WARNING', 'DOUBLON_CHEQUE', `Chèque ${number} : numéro déjà présent dans les données d’origine (conservé et signalé)`, { legacyId: c.id });
    } else chequeNumberKeys.set(duplicateKey, String(c.id));
    const counterparty = cpFor(company, c.party, c.id);
    const noteParts = [];
    if (c.note) noteParts.push(String(c.note));
    const legacyDetails = [];
    if (c.rd) legacyDetails.push(`rd=${c.rd}`);
    if (c.rr) legacyDetails.push(`rr=${c.rr}`);
    if (c.rs) legacyDetails.push(`rs=${c.rs}`);
    if (c.endTo) legacyDetails.push(`endTo=${c.endTo}`);
    if (legacyDetails.length) noteParts.push(`[Hérité] ${legacyDetails.join(' ; ')}`);
    const cheque = {
      legacyId: String(c.id),
      company,
      account,
      counterparty,
      direction,
      number,
      normalized,
      partyName: counterparty.name,
      amountCents,
      issueDate,
      receiptDate,
      dueDate: String(c.due),
      depositDate,
      cancellationDate,
      returnDate,
      status,
      type: ['عادي', 'ضمان', 'مصدَّق', 'شيك بنكي', 'CCP'].includes(c.type) ? 'ORDINAIRE' : 'ORDINAIRE',
      legacyType: c.type || null,
      notes: noteParts.join(' | ') || null,
      endorsee: status === 'ENDOSSE' ? String(c.endTo || 'Endossataire inconnu') : null,
      duplicate,
      duplicateOverride: duplicate ? 'Import historique : doublon préexistant conservé' : null,
      flags: [...new Set(flags)].join(','),
      raw: { dir: c.dir, no: c.no, party: c.party, amt: c.amt, due: c.due, status: c.status, type: c.type, note: c.note },
    };
    if (status === 'ENDOSSE' && !c.endTo) {
      issue(issues, 'WARNING', 'ENDOSSEMENT_INCOMPLET', `Chèque ${number} : endossataire absent dans les données d’origine`, { legacyId: c.id });
    }
    cheques.push(cheque);
  }

  // --- Transactions ---
  const txDup = duplicateIds(raw.tx);
  const transactions = [];
  const transfers = [];
  for (const t of raw.tx) {
    if (!t || typeof t !== 'object') {
      issue(issues, 'ERROR', 'TRANSACTION_INVALIDE', 'Entrée transaction non objet');
      continue;
    }
    if (!validId(t.id)) {
      issue(issues, 'ERROR', 'TRANSACTION_SANS_ID', 'Transaction sans identifiant');
      continue;
    }
    if (txDup.has(String(t.id))) {
      issue(issues, 'ERROR', 'ID_DUPLIQUE', `Identifiant transaction dupliqué : ${t.id}`, { legacyId: t.id });
      continue;
    }
    const account = accountMap.get(String(t.acc));
    if (!account) {
      issue(issues, 'ERROR', 'TRANSACTION_ORPHELINE', `Transaction ${t.id} : compte inexistant`, { legacyId: t.id });
      continue;
    }
    if (!isValidISODate(String(t.date))) {
      issue(issues, 'ERROR', 'DATE_TRANSACTION_INVALIDE', `Transaction ${t.id} : date invalide`, { legacyId: t.id });
      continue;
    }
    const amountCents = cents(t.amt);
    if (amountCents === null || amountCents <= 0) {
      issue(issues, 'ERROR', 'MONTANT_TRANSACTION_INVALIDE', `Transaction ${t.id} : montant invalide`, { legacyId: t.id });
      continue;
    }
    if (t.type === 'transfer') {
      const dest = accountMap.get(String(t.to));
      if (!dest || dest.legacyId === account.legacyId) {
        issue(issues, 'ERROR', 'TRANSFERT_INVALIDE', `Transfert ${t.id} : compte destinataire invalide`, { legacyId: t.id });
        continue;
      }
      transfers.push({ legacyId: String(t.id), from: account, to: dest, amountCents, date: String(t.date), description: t.note || null });
      continue;
    }
    const type = LEGACY_TX[t.type];
    if (!type) {
      issue(issues, 'ERROR', 'TYPE_TRANSACTION_INCONNU', `Transaction ${t.id} : type « ${t.type} » inconnu`, { legacyId: t.id });
      continue;
    }
    transactions.push({
      legacyId: String(t.id),
      account,
      type,
      amountCents,
      date: String(t.date),
      description: t.note || null,
    });
  }

  // --- Chéquiers ---
  const bookDup = duplicateIds(raw.books);
  const books = [];
  for (const b of raw.books) {
    if (!b || typeof b !== 'object') continue;
    if (!validId(b.id) || bookDup.has(String(b.id))) {
      issue(issues, 'ERROR', bookDup.has(String(b.id)) ? 'ID_DUPLIQUE' : 'CHEQUIER_SANS_ID', `Chéquier invalide (${b.id})`, { legacyId: b.id });
      continue;
    }
    const account = accountMap.get(String(b.acc));
    if (!account) {
      issue(issues, 'ERROR', 'CHEQUIER_ORPHELIN', `Chéquier ${b.id} : compte inexistant`, { legacyId: b.id });
      continue;
    }
    const from = Number(b.from);
    const to = Number(b.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to < from) {
      issue(issues, 'ERROR', 'PLAGE_CHEQUIER_INVALIDE', `Chéquier ${b.id} : plage invalide`, { legacyId: b.id });
      continue;
    }
    books.push({ legacyId: String(b.id), account, from, to, label: 'Import legacy' });
  }

  // --- Journal hérité ---
  const logs = [];
  for (const l of raw.log) {
    if (l && typeof l === 'object' && l.t) logs.push({ d: String(l.d || ''), t: String(l.t).slice(0, 2000) });
  }

  // --- Totaux et soldes projetés ---
  const rawTotals = {
    companyCount: raw.companies.length,
    accountCount: raw.accounts.length,
    chequeCount: raw.cheques.length,
    chequeAmountCents: raw.cheques.reduce((s, c) => s + (cents(c && c.amt) || 0), 0),
    transactionCount: raw.tx.length,
    transactionAmountCents: raw.tx.reduce((s, t) => s + (cents(t && t.amt) || 0), 0),
    openingBalanceCents: raw.accounts.reduce((s, a) => s + (cents(a && a.open) || 0), 0),
    bookCount: raw.books.length,
    logCount: raw.log.length,
  };
  const importedTotals = {
    companyCount: companies.length,
    accountCount: accounts.length,
    chequeCount: cheques.length,
    chequeAmountCents: cheques.reduce((s, c) => s + c.amountCents, 0),
    transactionCount: transactions.length + transfers.length,
    transactionLineCount: transactions.length + transfers.length * 2,
    transactionAmountCents: transactions.reduce((s, t) => s + t.amountCents, 0) + transfers.reduce((s, t) => s + t.amountCents, 0),
    openingBalanceCents: accounts.reduce((s, a) => s + a.openingCents, 0),
    bookCount: books.length,
    logCount: logs.length,
  };
  if (importedTotals.chequeAmountCents !== rawTotals.chequeAmountCents) {
    issue(issues, 'WARNING', 'TOTAL_CHEQUES_DIFFERENT', 'Le total des chèques importés diffère du total source (lignes invalides).', {
      raw: rawTotals.chequeAmountCents,
      imported: importedTotals.chequeAmountCents,
    });
  }
  const balanceComparison = [];
  for (const account of accounts) {
    const rawAccount = raw.accounts.find((a) => String(a.id) === account.legacyId);
    const settled = raw.cheques.filter(
      (c) => c && String(c.acc) === account.legacyId && ((c.dir === 'in' && c.status === 'cashed') || (c.dir === 'out' && c.status === 'paid'))
    );
    const legacySettled = settled.reduce((s, c) => {
      const sign = c.dir === 'in' ? 1 : -1;
      return s + sign * (cents(c.amt) || 0);
    }, 0);
    const txNet = raw.tx.reduce((s, t) => {
      if (!t) return s;
      let effect = 0;
      if (String(t.acc) === account.legacyId) {
        if (t.type === 'deposit') effect += cents(t.amt) || 0;
        else if (t.type === 'interest') effect += cents(t.amt) || 0;
        else if (['withdraw', 'fee', 'loan'].includes(t.type)) effect -= cents(t.amt) || 0;
        else if (t.type === 'transfer') effect -= cents(t.amt) || 0;
      }
      if (t.type === 'transfer' && String(t.to) === account.legacyId) effect += cents(t.amt) || 0;
      return s + effect;
    }, 0);
    const legacyBalance = (cents(rawAccount ? rawAccount.open : 0) || 0) + legacySettled + txNet;
    const importedBalance = account.openingCents + txNet;
    if (legacyBalance !== importedBalance) {
      balanceComparison.push({
        legacyAccountId: account.legacyId,
        label: account.label,
        legacyComputedCents: legacyBalance,
        importedBookCents: importedBalance,
        differenceCents: legacyBalance - importedBalance,
        reason: 'Chèques réglés dans l’ancienne application sans date réelle : importés « À régulariser » et exclus de la trésorerie.',
      });
    }
  }

  const demo = demoSignature(data);
  if (demo.suspect) {
    issue(issues, 'WARNING', 'DONNEES_DEMO', `Le fichier ressemble au jeu de démonstration d’origine (${demo.reasons.join(', ')}). Import interdit sans confirmation explicite.`);
  }
  const errors = issues.filter((i) => i.severity === 'ERROR').length;
  const summary = {
    sourceName: String(input.sourceName || 'legacy-chq.json').slice(0, 200),
    sha256,
    rawTotals,
    importedTotals,
    companies: companies.map((c) => ({ legacyId: c.legacyId, name: c.name, code: c.code })),
    bankCount: bankSet.size,
    counterpartyCount: counterparties.length,
    statusMap: cheques.reduce((acc, c) => {
      const k = `${c.direction}:${c.status}`;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    balances: balanceComparison,
    demo,
    alreadyImported: existingImport
      ? { id: existingImport.id, importedAt: existingImport.imported_at }
      : null,
  };
  const token = crypto.randomUUID();
  analyses.set(token, {
    token,
    userId: ctx.user.id,
    createdAt: Date.now(),
    rawText: input.rawText,
    sha256,
    data,
    companies,
    accounts,
    counterparties,
    cheques,
    transactions,
    transfers,
    books,
    logs,
    issues,
    summary,
    demo,
    existingImport,
  });
  const ids = [...analyses.values()].filter((a) => a.userId === ctx.user.id).sort((a, b) => a.createdAt - b.createdAt);
  while (ids.length > 3) analyses.delete(ids.shift().token);
  return {
    token,
    summary,
    issues: issues.slice(0, 300),
    errorCount: errors,
    warningCount: issues.filter((i) => i.severity === 'WARNING').length,
    canCommit: !existingImport && (!demo.suspect || true),
    requiresSkipInvalid: errors > 0,
    requiresDemoConfirmation: demo.suspect,
    importedPreview: {
      companies: companies.slice(0, 20),
      accountCount: accounts.length,
      chequeCount: cheques.length,
      transactionCount: transactions.length,
      transferCount: transfers.length,
    },
  };
}

function assertConfirmation(input) {
  if (String(input.confirmation || '') !== 'MIGRER') {
    throw validationError('Saisissez exactement « MIGRER » pour confirmer l’import');
  }
}

function commitLegacy(db, ctx, input, paths) {
  assertPermission(ctx, 'migration.run');
  assertConfirmation(input);
  const analysis = analyses.get(String(input.token || ''));
  if (!analysis || analysis.userId !== ctx.user.id) throw validationError('Analyse expirée ou inconnue. Relancez l’analyse.');
  if (Date.now() - analysis.createdAt > TTL) {
    analyses.delete(analysis.token);
    throw validationError('Analyse expirée. Relancez l’analyse.');
  }
  if (analysis.existingImport) throw new AppError('CONFLICT', `Cette source a déjà été importée le ${analysis.existingImport.importedAt}`);
  if (db.prepare('SELECT id FROM legacy_imports WHERE source_sha256 = ?').get(analysis.sha256)) {
    throw new AppError('CONFLICT', 'Cette source a déjà été importée');
  }
  const errors = analysis.issues.filter((i) => i.severity === 'ERROR');
  if (errors.length && !input.skipInvalid) {
    throw new AppError('INVALID_LEGACY', 'Des enregistrements sont invalides. Corrigez-les ou confirmez explicitement leur exclusion.', {
      errorCount: errors.length,
      errors: errors.slice(0, 200),
    });
  }
  if (analysis.demo.suspect && !input.allowDemoData) {
    throw new AppError('DEMO_DATA', `Données de démonstration probables (${analysis.demo.reasons.join(', ')}) : confirmez explicitement pour importer.`);
  }
  if (!fs.existsSync(paths.legacyDir)) fs.mkdirSync(paths.legacyDir, { recursive: true, mode: 0o700 });
  const preservedName = `legacy-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${analysis.sha256.slice(0, 8)}.json`;
  const preservedPath = path.join(paths.legacyDir, preservedName);
  if (!fs.existsSync(preservedPath)) fs.writeFileSync(preservedPath, analysis.rawText, { mode: 0o600, flag: 'wx' });

  const result = transaction(db, () => {
    const before = {
      companies: db.prepare('SELECT COUNT(*) AS n FROM companies WHERE legacy_id IS NOT NULL').get().n,
      accounts: db.prepare('SELECT COUNT(*) AS n FROM bank_accounts WHERE legacy_id IS NOT NULL').get().n,
      cheques: db.prepare('SELECT COUNT(*) AS n FROM cheques WHERE legacy_id IS NOT NULL').get().n,
      chequeSum: db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS n FROM cheques WHERE legacy_id IS NOT NULL').get().n,
      txSum: db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS n FROM transactions WHERE legacy_id IS NOT NULL').get().n,
    };
    const importId = Number(
      db
        .prepare('INSERT INTO legacy_imports(source_name, source_sha256, imported_by, summary_json) VALUES (?,?,?,?)')
        .run(analysis.summary.sourceName, analysis.sha256, ctx.user.id, '{}').lastInsertRowid
    );
    const companyIds = new Map();
    const insertCompany = db.prepare(
      `INSERT INTO companies(code,name,legal_form,nif,nis,rc,ai,manager_name,capital_cents,address,wilaya,phone,email,color,legacy_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const c of analysis.companies) {
      const id = Number(
        insertCompany.run(
          c.code, c.name, c.legalForm, c.nif, c.nis, c.rc, c.ai, c.managerName, c.capitalCents,
          c.address, c.wilaya, c.phone, c.email, c.color, c.legacyId
        ).lastInsertRowid
      );
      companyIds.set(c.legacyId, id);
    }
    const bankIds = new Map();
    const findBank = db.prepare('SELECT id FROM banks WHERE name = ? COLLATE NOCASE');
    const insertBank = db.prepare('INSERT INTO banks(name) VALUES (?)');
    for (const account of analysis.accounts) {
      const key = account.bankName.toLowerCase();
      if (bankIds.has(key)) continue;
      const existing = findBank.get(account.bankName);
      bankIds.set(key, existing ? existing.id : Number(insertBank.run(account.bankName).lastInsertRowid));
    }
    const accountIds = new Map();
    const insertAccount = db.prepare(
      `INSERT INTO bank_accounts(company_id,bank_id,label,account_number,currency,opening_balance_cents,opening_date,legacy_id)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    for (const a of analysis.accounts) {
      const id = Number(
        insertAccount.run(
          companyIds.get(a.company.legacyId),
          bankIds.get(a.bankName.toLowerCase()),
          a.label,
          a.number,
          'DZD',
          a.openingCents,
          a.openingDate,
          a.legacyId
        ).lastInsertRowid
      );
      accountIds.set(a.legacyId, id);
    }
    const cpIds = new Map();
    const insertCp = db.prepare('INSERT INTO counterparties(company_id,name,type) VALUES (?,?,?)');
    for (const cp of analysis.counterparties) {
      cpIds.set(cp.key, Number(insertCp.run(companyIds.get(cp.company.legacyId), cp.name, cp.type).lastInsertRowid));
    }
    const chequeIds = new Map();
    const insertCheque = db.prepare(
      `INSERT INTO cheques(
        reference,company_id,account_id,direction,cheque_type,cheque_number,cheque_number_normalized,
        counterparty_id,party_name,amount_cents,currency,issue_date,receipt_date,due_date,deposit_date,
        cancellation_date,return_date,status,status_changed_at,notes,endorsee,last_reason,duplicate_override_reason,
        data_quality_flag,created_by,legacy_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const insertEvent = db.prepare(
      `INSERT INTO cheque_events(cheque_id,event_type,from_status,to_status,event_date,reason,actor_id,metadata_json)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    let chequeSum = 0;
    for (const c of analysis.cheques) {
      const year = Number(c.dueDate.slice(0, 4)) || new Date().getFullYear();
      const reference = makeReference('CHQ', year, nextSequence(db, 'CHEQUE', year));
      const now = new Date().toISOString();
      const id = Number(
        insertCheque.run(
          reference,
          companyIds.get(c.company.legacyId),
          accountIds.get(c.account.legacyId),
          c.direction,
          c.type,
          c.number,
          c.normalized,
          cpIds.get(c.counterparty.key),
          c.partyName,
          c.amountCents,
          'DZD',
          c.issueDate,
          c.receiptDate,
          c.dueDate,
          c.depositDate,
          c.cancellationDate,
          c.returnDate,
          c.status,
          now,
          c.notes,
          c.endorsee,
          `Import hérité : statut d’origine « ${c.raw.status} »`,
          c.duplicateOverride,
          c.flags,
          ctx.user.id,
          c.legacyId
        ).lastInsertRowid
      );
      chequeIds.set(c.legacyId, id);
      chequeSum += c.amountCents;
      insertEvent.run(
        id,
        'IMPORT',
        null,
        c.status,
        todayISO(),
        `Import depuis l’application HTML d’origine. Statut source : ${c.raw.status || 'inconnu'}.`,
        ctx.user.id,
        JSON.stringify({ legacy: c.raw, flags: c.flags })
      );
    }
    const insertTx = db.prepare(
      `INSERT INTO transactions(reference,company_id,account_id,type,amount_cents,currency,effective_date,description,transfer_group_id,created_by,legacy_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    let txSum = 0;
    for (const t of analysis.transactions) {
      const year = Number(t.date.slice(0, 4)) || new Date().getFullYear();
      const reference = makeReference('TRX', year, nextSequence(db, 'TRANSACTION', year));
      insertTx.run(
        reference,
        companyIds.get(t.account.company.legacyId),
        accountIds.get(t.account.legacyId),
        t.type,
        t.amountCents,
        'DZD',
        t.date,
        t.description,
        null,
        ctx.user.id,
        t.legacyId
      );
      txSum += t.amountCents;
    }
    for (const t of analysis.transfers) {
      const year = Number(t.date.slice(0, 4)) || new Date().getFullYear();
      const outRef = makeReference('TRX', year, nextSequence(db, 'TRANSACTION', year));
      const inRef = makeReference('TRX', year, nextSequence(db, 'TRANSACTION', year));
      const group = `LEGACY-${t.legacyId}`;
      insertTx.run(
        outRef, companyIds.get(t.from.company.legacyId), accountIds.get(t.from.legacyId), 'TRANSFERT_SORTIE',
        t.amountCents, 'DZD', t.date, t.description || 'Transfert importé', group, ctx.user.id, `LEGACY-${t.legacyId}-OUT`
      );
      insertTx.run(
        inRef, companyIds.get(t.to.company.legacyId), accountIds.get(t.to.legacyId), 'TRANSFERT_ENTREE',
        t.amountCents, 'DZD', t.date, t.description || 'Transfert importé', group, ctx.user.id, `LEGACY-${t.legacyId}-IN`
      );
      txSum += t.amountCents * 2;
    }
    const insertBook = db.prepare(
      'INSERT INTO cheque_books(company_id,account_id,label,from_number,to_number,created_by) VALUES (?,?,?,?,?,?)'
    );
    for (const b of analysis.books) {
      insertBook.run(
        companyIds.get(b.account.company.legacyId),
        accountIds.get(b.account.legacyId),
        b.label,
        String(b.from),
        String(b.to),
        ctx.user.id
      );
    }
    const insertLog = db.prepare(
      `INSERT INTO audit_logs(at,user_id,company_id,entity_type,entity_id,action,reason,source,metadata_json)
       VALUES (?,NULL,NULL,'LEGACY_LOG',?, 'LEGACY_LOG', ?, 'LEGACY_IMPORT', ?)`
    );
    for (const l of analysis.logs) {
      const date = l.d && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(l.d) ? l.d.replace(' ', 'T') : new Date().toISOString();
      insertLog.run(
        date,
        `legacy-${crypto.createHash('sha1').update(l.t).digest('hex').slice(0, 12)}`,
        l.t,
        JSON.stringify({ legacyTimestamp: l.d })
      );
    }

    // Vérification transactionnelle des comptages et des totaux.
    const check = {
      companies: db.prepare('SELECT COUNT(*) AS n FROM companies WHERE legacy_id IS NOT NULL').get().n,
      accounts: db.prepare('SELECT COUNT(*) AS n FROM bank_accounts WHERE legacy_id IS NOT NULL').get().n,
      cheques: db.prepare('SELECT COUNT(*) AS n FROM cheques WHERE legacy_id IS NOT NULL').get().n,
      chequeSum: db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS n FROM cheques WHERE legacy_id IS NOT NULL').get().n,
      txSum: db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS n FROM transactions WHERE legacy_id IS NOT NULL').get().n,
    };
    if (
      check.companies - before.companies !== analysis.companies.length ||
      check.accounts - before.accounts !== analysis.accounts.length ||
      check.cheques - before.cheques !== analysis.cheques.length
    ) {
      throw new Error('Vérification des comptages échouée : import annulé');
    }
    if (check.chequeSum - before.chequeSum !== chequeSum) throw new Error('Vérification du total des chèques échouée : import annulé');
    if (check.txSum - before.txSum !== txSum) throw new Error('Vérification du total des transactions échouée : import annulé');
    const summary = {
      ...analysis.summary,
      importedAt: new Date().toISOString(),
      importedBy: ctx.user.id,
      skipped: errors.length,
      imported: {
        companies: analysis.companies.length,
        accounts: analysis.accounts.length,
        counterparties: analysis.counterparties.length,
        cheques: analysis.cheques.length,
        transactions: analysis.transactions.length,
        transfers: analysis.transfers.length,
        books: analysis.books.length,
        logs: analysis.logs.length,
      },
      verification: { ...check, chequeSum, txSum },
      sourcePreserved: preservedPath,
    };
    db.prepare('UPDATE legacy_imports SET summary_json = ? WHERE id = ?').run(JSON.stringify(summary), importId);
    appendAudit(db, ctx, {
      entityType: 'MIGRATION',
      entityId: importId,
      action: 'MIGRATION_RUN',
      after: summary,
      reason: 'Migration contrôlée depuis l’application HTML d’origine',
      metadata: { sourcePreserved: preservedPath, skippedErrors: errors.length, demo: analysis.demo },
    });
    return { importId, summary };
  });

  analyses.delete(analysis.token);
  return {
    ok: true,
    importId: result.importId,
    sourcePreserved: preservedPath,
    summary: result.summary,
    message:
      'Import terminé et vérifié. Les chèques réglés sans date réelle sont marqués « À régulariser » et n’affectent pas la trésorerie tant qu’ils ne sont pas corrigés.',
  };
}

function getImportHistory(db, ctx) {
  assertPermission(ctx, 'migration.run');
  return db
    .prepare('SELECT id, source_name, source_sha256, imported_at, imported_by, summary_json FROM legacy_imports ORDER BY id DESC LIMIT 50')
    .all()
    .map((r) => {
      let summary = {};
      try {
        summary = JSON.parse(r.summary_json || '{}');
      } catch {
        summary = { parseError: true };
      }
      return {
        id: r.id,
        sourceName: r.source_name,
        sourceSha256: r.source_sha256,
        importedAt: r.imported_at,
        summary,
      };
    });
}

module.exports = { analyse, commitLegacy, getImportHistory, LEGACY_STATUS, LEGACY_TX };
