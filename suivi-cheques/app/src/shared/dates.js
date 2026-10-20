'use strict';

/** Dates métier : chaînes ISO « AAAA-MM-JJ », sans heure, sans fuseau implicite. */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n) {
  return String(n).padStart(2, '0');
}

function isValidISODate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const [, y, m, d] = value.match(ISO_DATE_RE).map(Number);
  if (y < 1900 || y > 2200) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function assertISODate(value, field = 'date') {
  if (!isValidISODate(value)) throw new Error(`${field} invalide (format AAAA-MM-JJ attendu)`);
  return value;
}

/** Date locale du poste (et non UTC), pour éviter le décalage de minuit. */
function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function nowISO(now = new Date()) {
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(offset) / 60));
  const om = pad(Math.abs(offset) % 60);
  return `${todayISO(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${oh}:${om}`;
}

function parseISOToUTC(value) {
  assertISODate(value);
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUTC(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function addDays(value, days) {
  const date = parseISOToUTC(value);
  date.setUTCDate(date.getUTCDate() + Number(days));
  return fromUTC(date);
}

function diffDays(from, to) {
  return Math.round((parseISOToUTC(to) - parseISOToUTC(from)) / 86_400_000);
}

function compareISO(a, b) {
  return String(a).localeCompare(String(b));
}

function minISO(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

function maxISO(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function startOfMonth(value) {
  return value.slice(0, 8) + '01';
}

function endOfMonth(value) {
  const date = parseISOToUTC(value);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return fromUTC(last);
}

function startOfWeek(value) {
  const date = parseISOToUTC(value);
  const day = date.getUTCDay() || 7; // lundi = 1
  date.setUTCDate(date.getUTCDate() - (day - 1));
  return fromUTC(date);
}

function formatFR(value) {
  if (!value) return '';
  const datePart = String(value).slice(0, 10);
  if (!isValidISODate(datePart)) return String(value);
  const [y, m, d] = datePart.split('-');
  return `${d}/${m}/${y}`;
}

function formatFRDateTime(value) {
  if (!value) return '';
  const text = String(value);
  if (text.length < 16) return formatFR(text);
  return `${formatFR(text.slice(0, 10))} ${text.slice(11, 16)}`;
}

/**
 * Analyse une date de relevé selon un format explicite.
 * Formats supportés : AAAA-MM-JJ, JJ/MM/AAAA, MM/JJ/AAAA, JJ-MM-AAAA,
 * AAAA/MM/JJ, JJ.MM.AAAA. Retourne null si invalide.
 */
function parseDateWithFormat(raw, format) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (text instanceof Date) return null;

  // Dates Excel sérialisées : gérées en amont par ExcelJS.
  const clean = text.replace(/[ T].*$/, '');
  let y;
  let m;
  let d;
  const patterns = {
    'YYYY-MM-DD': /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
    'DD/MM/YYYY': /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    'MM/DD/YYYY': /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    'DD-MM-YYYY': /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
    'YYYY/MM/DD': /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
    'DD.MM.YYYY': /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/,
  };
  const re = patterns[format];
  if (!re) throw new Error(`Format de date non pris en charge : ${format}`);
  const match = clean.match(re);
  if (!match) return null;
  if (format === 'YYYY-MM-DD' || format === 'YYYY/MM/DD') {
    [, y, m, d] = match.map(Number);
  } else if (format === 'MM/DD/YYYY') {
    [, m, d, y] = match.map(Number);
  } else {
    [, d, m, y] = match.map(Number);
  }
  const iso = `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
  return isValidISODate(iso) ? iso : null;
}

function startOfQuarter(value) {
  const date = parseISOToUTC(value);
  const quarterMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return `${date.getUTCFullYear()}-${pad(quarterMonth + 1)}-01`;
}

function endOfQuarter(value) {
  const date = parseISOToUTC(value);
  const quarterMonth = Math.floor(date.getUTCMonth() / 3) * 3 + 3;
  const end = new Date(Date.UTC(date.getUTCFullYear(), quarterMonth, 0));
  return fromUTC(end);
}

function startOfYear(value) {
  return value.slice(0, 5) + '01-01';
}

function endOfYear(value) {
  return value.slice(0, 5) + '12-31';
}

module.exports = {
  isValidISODate,
  assertISODate,
  todayISO,
  nowISO,
  addDays,
  diffDays,
  compareISO,
  minISO,
  maxISO,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  formatFR,
  formatFRDateTime,
  parseDateWithFormat,
  startOfQuarter,
  endOfQuarter,
  startOfYear,
  endOfYear,
};
