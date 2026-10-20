'use strict';

/** Analyse et production CSV robustes (guillemets, multilignes, délimiteurs). */

function decodeBuffer(buffer, encoding = 'auto') {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let enc = String(encoding || 'auto').toLowerCase();
  if (enc === 'auto') {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) enc = 'utf-8';
    else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) enc = 'utf-16le';
    else {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        enc = 'utf-8';
      } catch {
        enc = 'windows-1252';
      }
    }
  }
  if (enc === 'utf8') enc = 'utf-8';
  if (enc === 'latin1' || enc === 'iso-8859-1') enc = 'windows-1252';
  try {
    return new TextDecoder(enc, { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    throw new Error(`Encodage non pris en charge : ${encoding}`);
  }
}

function countOutsideQuotes(line, char) {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') i += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && c === char) count += 1;
  }
  return count;
}

function detectDelimiter(text) {
  const candidates = [';', ',', '\t', '|'];
  const lines = String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(0, 8);
  let best = ';';
  let bestScore = -1;
  for (const delimiter of candidates) {
    const counts = lines.map((l) => countOutsideQuotes(l, delimiter));
    const nonZero = counts.filter((n) => n > 0);
    if (!nonZero.length) continue;
    const consistency = counts.filter((n) => n === counts[0]).length;
    const score = consistency * 10 + Math.min(counts[0], 20);
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

function parseCsv(text, options = {}) {
  const delimiter = options.delimiter || detectDelimiter(text);
  const input = String(text ?? '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const maxRows = options.maxRows || 100000;
  while (i < input.length) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (field.length === 0) {
        inQuotes = true;
        i += 1;
        continue;
      }
      // Guillemet dans un champ non échappé : conservé littéralement.
      field += c;
      i += 1;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      row.push(field);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      field = '';
      if (c === '\r' && input[i + 1] === '\n') i += 1;
      i += 1;
      if (rows.length > maxRows) throw new Error(`Fichier trop volumineux : plus de ${maxRows} lignes`);
      continue;
    }
    field += c;
    i += 1;
  }
  if (inQuotes) throw new Error('Fichier CSV invalide : guillemet non fermé');
  if (field.length || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return { rows, delimiter };
}

/** Neutralise les formules dans les cellules texte exportées vers Excel. */
function sanitizeSpreadsheetText(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) return `'${s}`;
  return s;
}

function escapeCsvCell(value, { protectFormula = true, delimiter = ';' } = {}) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' || typeof value === 'bigint' ? String(value) : protectFormula ? sanitizeSpreadsheetText(value) : String(value);
  s = String(s);
  if (s.includes('"') || s.includes(delimiter) || /[\r\n]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCsv(headers, rows, options = {}) {
  const delimiter = options.delimiter || ';';
  const protectFormula = options.protectFormula !== false;
  const lines = [];
  if (options.includeHeader !== false) {
    lines.push(headers.map((h) => escapeCsvCell(h, { protectFormula, delimiter })).join(delimiter));
  }
  for (const row of rows) {
    lines.push(row.map((cell) => escapeCsvCell(cell, { protectFormula, delimiter })).join(delimiter));
  }
  const bom = options.bom === false ? '' : '\uFEFF';
  return bom + lines.join('\r\n') + '\r\n';
}

module.exports = { decodeBuffer, detectDelimiter, parseCsv, buildCsv, escapeCsvCell, sanitizeSpreadsheetText };
