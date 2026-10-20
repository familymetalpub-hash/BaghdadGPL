'use strict';

(function () {
  const Suivi = (window.Suivi = window.Suivi || {});
  Suivi.pages = Suivi.pages || {};

  const state = (Suivi.state = Suivi.state || {
    me: null,
    page: 'dashboard',
    filters: {},
  });

  const moneyFormatter = new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function money(cents, options = {}) {
    if (cents === null || cents === undefined || Number.isNaN(Number(cents))) return '—';
    const value = Number(cents) / 100;
    const formatted = moneyFormatter.format(value);
    if (options.signed && value > 0) return `+${formatted} DA`;
    return `${formatted} DA`;
  }

  function integer(value) {
    if (value === null || value === undefined) return '—';
    return new Intl.NumberFormat('fr-FR').format(Number(value));
  }

  function date(value) {
    if (!value) return '—';
    const text = String(value).slice(0, 10);
    const [y, m, d] = text.split('-');
    if (!y || !m || !d) return esc(value);
    return `${d}/${m}/${y}`;
  }

  function dateTime(value) {
    if (!value) return '—';
    const text = String(value);
    return `${date(text)} ${text.slice(11, 16)}`;
  }

  function todayISO() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function addDays(iso, days) {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function parseMoneyToCents(text) {
    if (text === null || text === undefined) return null;
    let value = String(text).trim().replace(/\s|\u00a0|\u202f/g, '').replace(/DA$/i, '');
    if (!value) return null;
    const comma = value.lastIndexOf(',');
    const dot = value.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) {
      if (comma > dot) value = value.replace(/\./g, '').replace(',', '.');
      else value = value.replace(/,/g, '');
    } else if (comma >= 0) {
      const parts = value.split(',');
      value = parts.length === 2 && parts[1].length <= 2 ? `${parts[0]}.${parts[1]}` : parts.join('');
    } else if (dot >= 0) {
      const parts = value.split('.');
      if (parts.length > 2 || parts[1].length > 2) value = parts.join('');
    }
    if (!/^\d+(\.\d{0,2})?$/.test(value)) return null;
    return Math.round(Number(value) * 100);
  }

  function num(value) {
    return Number(value) || 0;
  }

  async function call(method, params = {}) {
    if (!window.suivi || typeof window.suivi.invoke !== 'function') {
      throw new Error('Le pont sécurisé de l’application est indisponible.');
    }
    const response = await window.suivi.invoke(method, params);
    if (!response || response.ok !== true) {
      const error = response && response.error ? response.error : { message: 'Réponse invalide du processus principal' };
      const exc = new Error(error.message || 'Erreur inconnue');
      exc.code = error.code || 'UNKNOWN';
      exc.details = error.details || null;
      if (['SESSION_EXPIRED', 'UNAUTHORIZED', 'PASSWORD_CHANGE_REQUIRED'].includes(exc.code)) {
        window.dispatchEvent(new CustomEvent('suivi:session-expired', { detail: { code: exc.code, message: exc.message } }));
      }
      throw exc;
    }
    return response.data;
  }

  function toast(message, type = 'info', duration = 4200) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.textContent = message;
    root.appendChild(item);
    setTimeout(() => {
      item.style.opacity = '0';
      item.style.transition = 'opacity .2s';
      setTimeout(() => item.remove(), 220);
    }, duration);
  }

  function showError(err) {
    const message = err && err.message ? err.message : 'Erreur inconnue';
    toast(message, 'error', 6000);
    if (err && err.details && Array.isArray(err.details)) {
      const detail = err.details.map((d) => (typeof d === 'string' ? d : d.message)).filter(Boolean).join(' · ');
      if (detail) toast(detail, 'error', 7000);
    }
  }

  function openModal({ title, content, actions = [], wide = false, narrow = false, onMount = null }) {
    const root = document.getElementById('modal-root');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = `modal${wide ? ' wide' : ''}${narrow ? ' narrow' : ''}`;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="modal-header">
        <h2>${esc(title)}</h2>
        <button type="button" class="modal-close" aria-label="Fermer">×</button>
      </div>
      <div class="modal-body"></div>
      <div class="modal-footer"></div>`;
    const body = modal.querySelector('.modal-body');
    if (typeof content === 'string') body.innerHTML = content;
    else if (content instanceof Node) body.appendChild(content);
    const footer = modal.querySelector('.modal-footer');

    function close() {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(event) {
      if (event.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    modal.querySelector('.modal-close').addEventListener('click', close);
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) close();
    });

    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `btn ${action.className || 'btn-ghost'}`;
      button.textContent = action.label;
      button.addEventListener('click', async () => {
        if (action.onClick) {
          button.disabled = true;
          try {
            const keep = await action.onClick(close, modal);
            if (keep === false) button.disabled = false;
          } catch (err) {
            button.disabled = false;
            showError(err);
          }
        } else close();
      });
      footer.appendChild(button);
    }
    backdrop.appendChild(modal);
    root.appendChild(backdrop);
    if (onMount) {
      Promise.resolve(onMount(modal, close)).catch(showError);
    }
    return { modal, body, footer, close };
  }

  function confirmDialog({ title = 'Confirmation', message, confirmLabel = 'Confirmer', danger = false, requireText = null }) {
    return new Promise((resolve) => {
      const content = document.createElement('div');
      content.innerHTML = `
        <p>${message}</p>
        ${requireText ? `<label>Saisissez « ${esc(requireText)} » pour confirmer<input name="confirm" autocomplete="off" /></label>` : ''}`;
      openModal({
        title,
        content,
        narrow: true,
        actions: [
          { label: 'Annuler', className: 'btn-ghost', onClick: (close) => { close(); resolve(false); } },
          {
            label: confirmLabel,
            className: danger ? 'btn-danger' : 'btn-primary',
            onClick: (close, modal) => {
              if (requireText) {
                const input = modal.querySelector('input[name="confirm"]');
                if (!input || input.value.trim() !== requireText) {
                  toast(`Saisissez exactement « ${requireText} »`, 'error');
                  return false;
                }
              }
              close();
              resolve(true);
              return true;
            },
          },
        ],
      });
    });
  }

  function promptDialog({ title = 'Saisie', label = 'Valeur', value = '', required = false }) {
    return new Promise((resolve) => {
      const content = document.createElement('div');
      content.innerHTML = `<label>${esc(label)}<input name="value" maxlength="500" value="${esc(value)}" ${required ? 'required' : ''} /></label>
        <div id="prompt-error" class="form-error" style="margin-top:10px" hidden></div>`;
      openModal({
        title,
        content,
        narrow: true,
        actions: [
          { label: 'Annuler', className: 'btn-ghost', onClick: (close) => { close(); resolve(null); } },
          {
            label: 'Valider',
            className: 'btn-primary',
            onClick: (close, modal) => {
              const input = modal.querySelector('input[name="value"]');
              const next = input ? input.value.trim() : '';
              if (required && next.length < 3) {
                const box = modal.querySelector('#prompt-error');
                box.textContent = 'Saisissez au moins 3 caractères.';
                box.hidden = false;
                return false;
              }
              close();
              resolve(next || null);
              return true;
            },
          },
        ],
      });
    });
  }

  function setLoading(container, message = 'Chargement…') {
    container.innerHTML = `<div class="skeleton">${esc(message)}</div>`;
  }

  function emptyState(title, message = '') {
    return `<div class="empty-state"><strong>${esc(title)}</strong>${message ? `<span>${esc(message)}</span>` : ''}</div>`;
  }

  function options(items, selected, { valueKey = 'id', labelKey = 'label', includeEmpty = null } = {}) {
    const parts = [];
    if (includeEmpty) parts.push(`<option value="">${esc(includeEmpty)}</option>`);
    for (const item of items || []) {
      const value = item[valueKey];
      const label = typeof labelKey === 'function' ? labelKey(item) : item[labelKey];
      parts.push(`<option value="${esc(value)}"${String(selected) === String(value) ? ' selected' : ''}>${esc(label)}</option>`);
    }
    return parts.join('');
  }

  function companyOptions(companies, selected, includeEmpty = null) {
    return options(companies, selected, { labelKey: (c) => `${c.code} — ${c.name}`, includeEmpty });
  }

  function statusBadge(status, label, direction = null) {
    const map = {
      RECU: 'teal', DEPOSE: 'blue', ENCAISSE: 'green', ENDOSSE: 'purple',
      IMPAYE: 'red', RETOURNE: 'amber', LITIGE: 'amber', ANNULE: 'gray', A_REGULARISER: 'red',
      EMIS: 'blue', REMIS: 'teal', PAYE: 'green', REJETE: 'red',
      PENDING: 'amber', APPROVED: 'green', REJECTED: 'red', CANCELLED: 'gray',
      MATCHED: 'green', UNMATCHED: 'amber', DUPLICATE: 'red', REVIEW: 'blue',
      MANUAL: 'purple',
    };
    return `<span class="badge ${map[status] || 'gray'}"><span class="status-dot"></span>${esc(label || status)}</span>`;
  }

  function statusLabel(status) {
    const labels = {
      RECU: 'Reçu', DEPOSE: 'Déposé', ENCAISSE: 'Encaissé', ENDOSSE: 'Endossé',
      IMPAYE: 'Impayé', RETOURNE: 'Retourné', LITIGE: 'Litige', ANNULE: 'Annulé',
      A_REGULARISER: 'À régulariser', EMIS: 'Émis', REMIS: 'Remis', PAYE: 'Payé', REJETE: 'Rejeté',
      PENDING: 'En attente', APPROVED: 'Approuvée', REJECTED: 'Rejetée', CANCELLED: 'Annulée',
      MATCHED: 'Rapproché', UNMATCHED: 'Non rapproché', DUPLICATE: 'Doublon probable', REVIEW: 'À examiner',
    };
    return labels[status] || status;
  }

  function debounce(fn, delay = 250) {
    let timer = null;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  function fiscalYear() {
    return new Date().getFullYear();
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  Suivi.api = { call };
  Suivi.fmt = { money, integer, date, dateTime, esc, statusBadge, statusLabel, todayISO, addDays, parseMoneyToCents, num, fiscalYear, downloadText };
  Suivi.ui = { toast, showError, openModal, confirmDialog, promptDialog, setLoading, emptyState, options, companyOptions, debounce };
  Suivi.esc = esc;
  Suivi.num = num;
})();
