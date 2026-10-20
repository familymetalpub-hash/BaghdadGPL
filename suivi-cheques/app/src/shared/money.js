'use strict';

/**
 * Manipulation monétaire stricte.
 * Tous les montants sont stockés en DZD mineurs (« centimes ») sous forme
 * d'entiers JavaScript sûrs. Aucun calcul financier ne doit utiliser de flottant.
 */

const MAX_AMOUNT_CENTS = 9_000_000_000_000; // 90 milliards DZD, sous Number.MAX_SAFE_INTEGER

function emptyToZero(value) {
  if (value === null || value === undefined) return '0';
  return String(value).trim();
}

/**
 * Convertit une saisie utilisateur en centimes.
 * Accepte : "1 234,56", "1234.56", "1.234.567,89", "1234", "1 234".
 * Refuse : plus de 2 décimales, séparateurs ambigus, notation exponentielle,
 * valeurs non finies, montants hors limites.
 */
function parseAmountToCents(input, options = {}) {
  const { allowNegative = false, maxCents = MAX_AMOUNT_CENTS, field = 'montant' } = options;
  let text = emptyToZero(input);
  if (text === '') throw new Error(`${field} requis`);
  text = text.replace(/[\s\u00a0\u202f']/g, '');

  let negative = false;
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  if (negative && !allowNegative) throw new Error(`${field} ne peut pas être négatif`);

  // Refuser les notations scientifiques et tout caractère non monétaire.
  if (!/^\d[\d.,]*$/.test(text)) throw new Error(`${field} invalide : « ${input} »`);

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  let integerPart;
  let decimalPart = '';

  if (lastComma >= 0 && lastDot >= 0) {
    // Le dernier séparateur est le séparateur décimal.
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const groupSep = decimalSep === ',' ? '.' : ',';
    const idx = text.lastIndexOf(decimalSep);
    integerPart = text.slice(0, idx);
    decimalPart = text.slice(idx + 1);
    if (decimalPart.includes(decimalSep) || decimalPart.includes(groupSep)) {
      throw new Error(`${field} invalide : séparateurs incohérents`);
    }
    if (integerPart.includes(decimalSep)) throw new Error(`${field} invalide : séparateurs incohérents`);
    if (integerPart.includes(groupSep)) {
      const groups = integerPart.split(groupSep);
      if (!/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some((g) => !/^\d{3}$/.test(g))) {
        throw new Error(`${field} invalide : groupement de milliers incorrect`);
      }
      integerPart = groups.join('');
    }
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const parts = text.split(sep);
    if (parts.length === 2) {
      integerPart = parts[0];
      decimalPart = parts[1];
      // "1.234" ou "1,234" : ambigu. En français on privilégie la décimale
      // seulement si le groupe final ne fait pas exactement 3 chiffres.
      if (decimalPart.length === 3 && integerPart.length <= 3 && /^\d+$/.test(integerPart)) {
        // "1.234" est interprété comme 1234 (groupement) ;
        // "12.345" également. Une saisie décimale à 3 chiffres est refusée de
        // toute façon par la règle des 2 décimales.
        integerPart = integerPart + decimalPart;
        decimalPart = '';
      }
    } else {
      // Plusieurs séparateurs identiques = groupement de milliers.
      const groups = text.split(sep);
      if (!/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some((g) => !/^\d{3}$/.test(g))) {
        throw new Error(`${field} invalide : séparateurs de milliers incorrects`);
      }
      integerPart = groups.join('');
    }
  } else {
    integerPart = text;
  }

  if (!/^\d+$/.test(integerPart)) throw new Error(`${field} invalide`);
  if (decimalPart && !/^\d{1,2}$/.test(decimalPart)) {
    throw new Error(`${field} : deux décimales maximum`);
  }
  const centsText = integerPart + decimalPart.padEnd(2, '0');
  if (centsText.length > 15) throw new Error(`${field} trop élevé`);
  const cents = Number(centsText);
  if (!Number.isSafeInteger(cents)) throw new Error(`${field} trop élevé`);
  if (cents > maxCents) throw new Error(`${field} dépasse le plafond autorisé`);
  return negative ? -cents : cents;
}

function formatCents(cents, options = {}) {
  const { withCurrency = true, currency = 'DZD', signed = false, decimals = 2 } = options;
  if (cents === null || cents === undefined || cents === '') return '';
  const value = Number(cents);
  if (!Number.isFinite(value)) return '';
  const rounded = Math.round(value);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  const units = Math.floor(abs / 100);
  let rest = abs % 100;
  if (decimals === 0) {
    rest = 0;
  }
  const unitText = String(units).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const decimalText = decimals === 0 ? '' : ',' + String(rest).padStart(2, '0');
  let sign = negative ? '-' : signed && rounded > 0 ? '+' : '';
  const number = `${sign}${unitText}${decimalText}`;
  return withCurrency ? `${number} ${currency}` : number;
}

function addCents(a, b) {
  const result = Number(a) + Number(b);
  if (!Number.isSafeInteger(result)) throw new Error('Dépassement de capacité monétaire');
  return result;
}

function sumCents(values) {
  let total = 0;
  for (const value of values) total = addCents(total, value || 0);
  return total;
}

function absCents(value) {
  return Math.abs(Number(value));
}

/** Arrondi bancaire simple au centime (les entrées sont déjà en centimes). */
function percentOfCents(cents, percent) {
  const raw = (Number(cents) * Number(percent)) / 100;
  return Math.round(raw);
}

module.exports = {
  MAX_AMOUNT_CENTS,
  parseAmountToCents,
  formatCents,
  addCents,
  sumCents,
  absCents,
  percentOfCents,
};
