'use strict';

/**
 * Référentiel unique des statuts de chèques.
 * Le sens (ÉMIS / REÇU) détermine les statuts et les transitions autorisées.
 */

const DIRECTIONS = {
  EMIS: { code: 'EMIS', label: 'Émis', short: 'Émis', sign: -1, partyLabel: 'Bénéficiaire' },
  RECU: { code: 'RECU', label: 'Reçu', short: 'Reçu', sign: 1, partyLabel: 'Émetteur' },
};

const STATUS = {
  // Reçus
  RECU: {
    code: 'RECU', direction: 'RECU', label: 'Reçu', category: 'PENDING',
    description: "Chèque reçu d'un client ou d'un tiers, non encore déposé.",
  },
  DEPOSE: {
    code: 'DEPOSE', direction: 'RECU', label: 'Déposé', category: 'PENDING',
    description: 'Chèque remis en banque, en attente de compensation.',
  },
  ENCAISSE: {
    code: 'ENCAISSE', direction: 'RECU', label: 'Encaissé', category: 'SETTLED',
    description: 'Chèque effectivement crédité. Date d’encaissement réelle obligatoire.',
  },
  ENDOSSE: {
    code: 'ENDOSSE', direction: 'RECU', label: 'Endossé', category: 'CLOSED',
    description: 'Chèque transmis à un tiers par endossement ; aucun encaissement pour la société.',
  },
  IMPAYE: {
    code: 'IMPAYE', direction: 'RECU', label: 'Impayé', category: 'EXCEPTION',
    description: 'Chèque non honoré par la banque ; motif obligatoire.',
  },
  RETOURNE: {
    code: 'RETOURNE', direction: 'RECU', label: 'Retourné', category: 'EXCEPTION',
    description: 'Chèque physiquement restitué après rejet ; motif obligatoire.',
  },
  LITIGE: {
    code: 'LITIGE', direction: 'RECU', label: 'En litige', category: 'DISPUTED',
    description: 'Contestation en cours ; aucun effet de trésorerie.',
  },
  // Émis
  EMIS: {
    code: 'EMIS', direction: 'EMIS', label: 'Émis', category: 'PENDING',
    description: 'Chèque signé et remis au bénéficiaire, non encore débité.',
  },
  REMIS: {
    code: 'REMIS', direction: 'EMIS', label: 'Remis', category: 'PENDING',
    description: 'Chèque remis au bénéficiaire, en attente de présentation.',
  },
  PAYE: {
    code: 'PAYE', direction: 'EMIS', label: 'Payé', category: 'SETTLED',
    description: 'Chèque effectivement débité. Date de paiement réelle obligatoire.',
  },
  REJETE: {
    code: 'REJETE', direction: 'EMIS', label: 'Rejeté', category: 'EXCEPTION',
    description: 'Chèque refusé par la banque ; motif obligatoire.',
  },
  A_REGULARISER_RECU: {
    code: 'A_REGULARISER', direction: 'RECU', label: 'À régulariser (import)', category: 'EXCEPTION',
    description: 'Chèque importé dont la date réelle d’encaissement manque. Aucun effet de trésorerie tant que la date n’est pas établie.',
  },
  A_REGULARISER_EMIS: {
    code: 'A_REGULARISER', direction: 'EMIS', label: 'À régulariser (import)', category: 'EXCEPTION',
    description: 'Chèque importé dont la date réelle de paiement manque. Aucun effet de trésorerie tant que la date n’est pas établie.',
  },
  ANNULE_RECU: {
    code: 'ANNULE', direction: 'RECU', label: 'Annulé', category: 'CLOSED',
    description: 'Chèque annulé avant encaissement ; motif obligatoire.',
  },
  ANNULE_EMIS: {
    code: 'ANNULE', direction: 'EMIS', label: 'Annulé', category: 'CLOSED',
    description: 'Chèque annulé ; motif obligatoire et approbation si déjà en circulation.',
  },
};

function statusFor(code, direction) {
  if (!code) return null;
  if (code === 'ANNULE') return direction === 'EMIS' ? STATUS.ANNULE_EMIS : STATUS.ANNULE_RECU;
  if (code === 'A_REGULARISER') return direction === 'EMIS' ? STATUS.A_REGULARISER_EMIS : STATUS.A_REGULARISER_RECU;
  const found = STATUS[code];
  if (!found) return null;
  if (direction && found.direction !== direction) return null;
  return found;
}

function statusLabel(code, direction) {
  const status = statusFor(code, direction);
  return status ? status.label : String(code || '');
}

function statusCategory(code, direction) {
  const status = statusFor(code, direction);
  return status ? status.category : 'UNKNOWN';
}

function isSettled(cheque) {
  return (
    (cheque.direction === 'RECU' && cheque.status === 'ENCAISSE') ||
    (cheque.direction === 'EMIS' && cheque.status === 'PAYE')
  );
}

function isPending(cheque) {
  return ['RECU', 'DEPOSE', 'EMIS', 'REMIS'].includes(cheque.status);
}

function isTerminal(cheque) {
  return ['ANNULE', 'ENDOSSE', 'ENCAISSE', 'PAYE'].includes(cheque.status);
}

const T = (to, opts = {}) => ({ to, ...opts });

/** Transitions de base (une correction protégée peut être demandée séparément). */
const TRANSITIONS = {
  RECU: {
    RECU: [T('DEPOSE', { dateField: 'deposit_date', dateRequired: true, label: 'Déposer' }), T('ENDOSSE', { reasonRequired: true, extraField: 'endorsee', label: 'Endosser' }), T('ANNULE', { reasonRequired: true, label: 'Annuler' }), T('LITIGE', { reasonRequired: true, label: 'Mettre en litige' })],
    DEPOSE: [T('ENCAISSE', { dateField: 'collection_date', dateRequired: true, label: 'Encaisser' }), T('IMPAYE', { reasonRequired: true, dateField: 'return_date', dateRequired: true, label: 'Marquer impayé' }), T('RETOURNE', { reasonRequired: true, dateField: 'return_date', dateRequired: true, label: 'Retourner' }), T('LITIGE', { reasonRequired: true, label: 'Mettre en litige' })],
    IMPAYE: [T('DEPOSE', { dateField: 'deposit_date', dateRequired: true, reasonRequired: true, label: 'Représenter' }), T('RETOURNE', { reasonRequired: true, label: 'Retourner' }), T('LITIGE', { reasonRequired: true, label: 'Mettre en litige' }), T('ANNULE', { reasonRequired: true, label: 'Annuler' })],
    RETOURNE: [T('DEPOSE', { dateField: 'deposit_date', dateRequired: true, reasonRequired: true, label: 'Représenter' }), T('LITIGE', { reasonRequired: true, label: 'Mettre en litige' }), T('ANNULE', { reasonRequired: true, label: 'Annuler' })],
    ENDOSSE: [T('LITIGE', { reasonRequired: true, label: 'Mettre en litige' })],
    ENCAISSE: [T('LITIGE', { reasonRequired: true, label: 'Mettre en litige' }), T('ANNULE', { reasonRequired: true, label: 'Annuler (correction)' })],
    LITIGE: [T('ENCAISSE', { dateField: 'collection_date', dateRequired: true, label: 'Encaisser' }), T('IMPAYE', { reasonRequired: true, label: 'Marquer impayé' }), T('RETOURNE', { reasonRequired: true, label: 'Retourner' }), T('ANNULE', { reasonRequired: true, label: 'Annuler' })],
    A_REGULARISER: [T('ENCAISSE', { dateField: 'collection_date', dateRequired: true, reasonRequired: true, label: 'Régulariser l’encaissement' }), T('IMPAYE', { reasonRequired: true, label: 'Marquer impayé' }), T('LITIGE', { reasonRequired: true, label: 'Mettre en litige' }), T('ANNULE', { reasonRequired: true, label: 'Annuler' })],
    ANNULE: [],
  },
  EMIS: {
    EMIS: [T('REMIS', { label: 'Marquer remis' }), T('PAYE', { dateField: 'payment_date', dateRequired: true, label: 'Payer' }), T('REJETE', { reasonRequired: true, dateField: 'return_date', dateRequired: true, label: 'Rejeter' }), T('IMPAYE', { reasonRequired: true, dateField: 'return_date', dateRequired: true, label: 'Marquer impayé' }), T('ANNULE', { reasonRequired: true, label: 'Annuler' }), T('LITIGE', { reasonRequired: true, label: 'Mettre en litige' })],
    REMIS: [T('PAYE', { dateField: 'payment_date', dateRequired: true, label: 'Payer' }), T('REJETE', { reasonRequired: true, dateField: 'return_date', dateRequired: true, label: 'Rejeter' }), T('IMPAYE', { reasonRequired: true, dateField: 'return_date', dateRequired: true, label: 'Marquer impayé' }), T('ANNULE', { reasonRequired: true, label: 'Annuler' }), T('LITIGE', { reasonRequired: true, label: 'Mettre en litige' })],
    REJETE: [T('PAYE', { dateField: 'payment_date', dateRequired: true, label: 'Régulariser (payé)' }), T('IMPAYE', { reasonRequired: true, label: 'Marquer impayé' }), T('ANNULE', { reasonRequired: true, label: 'Annuler' }), T('LITIGE', { reasonRequired: true, label: 'Mettre en litige' })],
    IMPAYE: [T('PAYE', { dateField: 'payment_date', dateRequired: true, label: 'Régulariser (payé)' }), T('REJETE', { reasonRequired: true, label: 'Rejeter' }), T('ANNULE', { reasonRequired: true, label: 'Annuler' }), T('LITIGE', { reasonRequired: true, label: 'Mettre en litige' })],
    LITIGE: [T('PAYE', { dateField: 'payment_date', dateRequired: true, label: 'Régulariser (payé)' }), T('REJETE', { reasonRequired: true, label: 'Rejeter' }), T('IMPAYE', { reasonRequired: true, label: 'Marquer impayé' }), T('ANNULE', { reasonRequired: true, label: 'Annuler' })],
    PAYE: [T('LITIGE', { reasonRequired: true, label: 'Mettre en litige (correction)' }), T('ANNULE', { reasonRequired: true, label: 'Annuler (correction)' })],
    A_REGULARISER: [T('PAYE', { dateField: 'payment_date', dateRequired: true, reasonRequired: true, label: 'Régulariser le paiement' }), T('REJETE', { reasonRequired: true, label: 'Rejeter' }), T('LITIGE', { reasonRequired: true, label: 'Mettre en litige' }), T('ANNULE', { reasonRequired: true, label: 'Annuler' })],
    ANNULE: [],
  },
};

/** Statuts « finalisés » : toute sortie exige une approbation du DG. */
const PROTECTED_FROM = new Set([
  'DEPOSE', 'REMIS', 'ENCAISSE', 'PAYE', 'REJETE', 'IMPAYE', 'RETOURNE', 'ENDOSSE', 'LITIGE',
]);

function getTransition(direction, from, to) {
  if (!TRANSITIONS[direction]) return null;
  const candidates = TRANSITIONS[direction][from] || [];
  return candidates.find((t) => t.to === to) || null;
}

function requiresApprovalForTransition(direction, from, to) {
  const transition = getTransition(direction, from, to);
  if (!transition || from === to) return false;
  // Toute annulation d'un chèque déjà en circulation (déposé, remis, réglé,
  // rejeté, impayé, retourné, endossé, en litige).
  if (to === 'ANNULE' && PROTECTED_FROM.has(from)) return true;
  // Sortie d'un statut réglé : correction financière protégée.
  if (['ENCAISSE', 'PAYE'].includes(from)) return true;
  // Régularisation d'un rejet/impayé/retour en règlement effectif.
  if (['REJETE', 'IMPAYE', 'RETOURNE'].includes(from) && ['PAYE', 'ENCAISSE'].includes(to)) return true;
  // Sortie d'un litige vers un règlement effectif.
  if (from === 'LITIGE' && ['PAYE', 'ENCAISSE'].includes(to)) return true;
  // Une régularisation établit une date réelle passée : elle est tracée mais
  // n'a pas à être approuvée par le DG (elle corrige un import incomplet).
  if (from === 'A_REGULARISER') return false;
  return false;
}

function allowedTransitions(direction, from) {
  return (TRANSITIONS[direction] && TRANSITIONS[direction][from]) || [];
}

function transitionNeedsReason(direction, from, to) {
  const transition = getTransition(direction, from, to);
  if (!transition) return true;
  return Boolean(transition.reasonRequired) || to === 'ANNULE' || ['REJETE', 'IMPAYE', 'RETOURNE', 'LITIGE'].includes(to);
}

const CHEQUE_TYPES = {
  ORDINAIRE: 'Chèque ordinaire',
  GARANTIE: 'Chèque de garantie',
  CERTIFIE: 'Chèque certifié',
  BANCAIRE: 'Chèque bancaire',
  CCP: 'Chèque CCP',
  AUTRE: 'Autre',
};

const REJECTION_REASON_SUGGESTIONS = [
  'Provision insuffisante',
  'Compte clôturé',
  'Signature non conforme',
  'Chèque déclaré perdu ou volé',
  'Opposition du tireur',
  'Défaut de forme',
  'Retour pour régularisation',
  'Autre (préciser)',
];

function normalizeChequeNumber(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s\-./\\]/g, '')
    .replace(/^0+(?=\d)/, '');
}

function chequeNumberDigits(value) {
  const normalized = normalizeChequeNumber(value);
  return /^\d+$/.test(normalized) ? Number(normalized) : null;
}

function settlementDateOf(cheque) {
  if (cheque.direction === 'RECU' && cheque.status === 'ENCAISSE') {
    return cheque.collection_date || null;
  }
  if (cheque.direction === 'EMIS' && cheque.status === 'PAYE') {
    return cheque.payment_date || null;
  }
  return null;
}

module.exports = {
  DIRECTIONS,
  STATUS,
  TRANSITIONS,
  PROTECTED_FROM,
  CHEQUE_TYPES,
  REJECTION_REASON_SUGGESTIONS,
  statusFor,
  statusLabel,
  statusCategory,
  isSettled,
  isPending,
  isTerminal,
  getTransition,
  requiresApprovalForTransition,
  allowedTransitions,
  transitionNeedsReason,
  normalizeChequeNumber,
  chequeNumberDigits,
  settlementDateOf,
};
