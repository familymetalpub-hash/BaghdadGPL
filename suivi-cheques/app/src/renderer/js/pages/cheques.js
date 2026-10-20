'use strict';

(function () {
  const Suivi = window.Suivi;
  const { api, fmt, ui, state } = Suivi;

  const STATUSES = [
    ['RECU', 'Reçu'], ['DEPOSE', 'Déposé'], ['ENCAISSE', 'Encaissé'], ['ENDOSSE', 'Endossé'],
    ['IMPAYE', 'Impayé'], ['RETOURNE', 'Retourné'], ['LITIGE', 'Litige'], ['A_REGULARISER', 'À régulariser'],
    ['EMIS', 'Émis'], ['REMIS', 'Remis'], ['PAYE', 'Payé'], ['REJETE', 'Rejeté'], ['ANNULE', 'Annulé'],
  ];

  function can(permission) {
    return state.permissions.has(permission);
  }

  async function optionsData(companyId) {
    const [accounts, counterparties, managers] = await Promise.all([
      api.call('accounts.options', companyId ? { companyIds: [companyId] } : {}),
      api.call('counterparties.list', companyId ? { companyId } : {}),
      companyId ? api.call('cheques.managers', { companyId }) : Promise.resolve([]),
    ]);
    return { accounts, counterparties, managers };
  }

  function chequeForm({ companies, accounts, managers, counterparties, cheque = null, direction = 'RECU' }) {
    const editing = Boolean(cheque);
    const dir = editing ? cheque.direction : direction;
    return `<form id="cheque-form" class="stack">
      <div class="form-grid three">
        <label>Sens
          <select name="direction" ${editing ? 'disabled' : ''}>
            <option value="RECU" ${dir === 'RECU' ? 'selected' : ''}>Reçu (encaissement)</option>
            <option value="EMIS" ${dir === 'EMIS' ? 'selected' : ''}>Émis (paiement)</option>
          </select>
        </label>
        <label>Société<select name="companyId" required ${editing ? 'disabled' : ''}>${ui.companyOptions(companies, editing ? cheque.companyId : '', 'Sélectionner…')}</select></label>
        <label>Compte bancaire<select name="accountId" required ${editing ? 'disabled' : ''}>${ui.options(accounts, editing ? cheque.accountId : '', { labelKey: (a) => `${a.label} — ${a.bankName} (${a.currency})`, includeEmpty: 'Sélectionner…' })}</select></label>
      </div>
      <div class="form-grid three">
        <label>Numéro de chèque<input name="chequeNumber" required maxlength="60" value="${fmt.esc(cheque ? cheque.chequeNumber : '')}" ${editing ? 'readonly' : ''} /></label>
        <label>Type
          <select name="chequeType">
            ${['ORDINAIRE', 'CERTIFIE', 'BANCAIRE', 'GARANTIE'].map((t) => `<option value="${t}" ${cheque && cheque.chequeType === t ? 'selected' : ''}>${t === 'ORDINAIRE' ? 'Ordinaire' : t === 'CERTIFIE' ? 'Certifié' : t === 'BANCAIRE' ? 'Chèque bancaire' : 'Garantie'}</option>`).join('')}
          </select>
        </label>
        <label>Montant (DA)<input name="amount" required inputmode="decimal" value="${cheque ? (cheque.amountCents / 100).toFixed(2) : ''}" ${editing ? '' : ''} /></label>
      </div>
      <div class="form-grid">
        <label>${dir === 'RECU' ? 'Émetteur / client' : 'Bénéficiaire'}<input name="partyName" required maxlength="160" value="${fmt.esc(cheque ? cheque.partyName : '')}" /></label>
        <label>Contrepartie (facultatif)<select name="counterpartyId">${ui.options(counterparties, cheque ? cheque.counterpartyId : '', { labelKey: (c) => `${c.name} (${c.type})`, includeEmpty: 'Aucune / saisie libre' })}</select></label>
        <label>Date d’émission<input name="issueDate" type="date" required max="${fmt.todayISO()}" value="${fmt.esc(cheque ? cheque.issueDate : fmt.todayISO())}" ${editing ? 'disabled' : ''} /></label>
        <label>Date de réception<input name="receiptDate" type="date" max="${fmt.todayISO()}" value="${fmt.esc(cheque && cheque.receiptDate ? cheque.receiptDate : '')}" ${editing ? 'disabled' : ''} /></label>
        <label>Date d’échéance<input name="dueDate" type="date" required value="${fmt.esc(cheque ? cheque.dueDate : '')}" /></label>
        <label>Date de dépôt<input name="depositDate" type="date" max="${fmt.todayISO()}" value="${fmt.esc(cheque && cheque.depositDate ? cheque.depositDate : '')}" ${editing ? 'disabled' : ''} /></label>
        <label>Gestionnaire<select name="managerId">${ui.options(managers, cheque ? cheque.managerId : (state.me.user.id), { labelKey: (m) => m.fullName, includeEmpty: 'Non affecté' })}</select></label>
        <label class="full">Notes<textarea name="notes" maxlength="2000">${fmt.esc(cheque && cheque.notes ? cheque.notes : '')}</textarea></label>
      </div>
      ${!editing && can('approvals.decide') ? `<label>Motif de dérogation en cas de doublon (10 caractères minimum)<input name="duplicateOverrideReason" maxlength="300" /></label>` : ''}
      <div id="cheque-form-error" class="form-error" hidden></div>
    </form>`;
  }

  function readChequeForm(modal) {
    const data = new FormData(modal.querySelector('#cheque-form'));
    const amountCents = fmt.parseMoneyToCents(String(data.get('amount') || ''));
    return {
      direction: String(data.get('direction')),
      companyId: Number(data.get('companyId')),
      accountId: Number(data.get('accountId')),
      chequeNumber: String(data.get('chequeNumber') || '').trim(),
      chequeType: String(data.get('chequeType') || 'ORDINAIRE'),
      partyName: String(data.get('partyName') || '').trim(),
      counterpartyId: data.get('counterpartyId') ? Number(data.get('counterpartyId')) : null,
      amountCents,
      issueDate: String(data.get('issueDate') || ''),
      receiptDate: String(data.get('receiptDate') || '') || null,
      dueDate: String(data.get('dueDate') || ''),
      depositDate: String(data.get('depositDate') || '') || null,
      managerId: data.get('managerId') ? Number(data.get('managerId')) : null,
      notes: String(data.get('notes') || '').trim() || null,
      duplicateOverrideReason: String(data.get('duplicateOverrideReason') || '').trim() || null,
    };
  }

  async function openChequeForm(companyId, reload, cheque = null, presetDirection = 'RECU') {
    const companies = state.me.companies || [];
    const selectedCompany = companyId || (companies[0] && companies[0].id) || '';
    const data = await optionsData(selectedCompany);
    ui.openModal({
      title: cheque ? `Modifier ${cheque.reference}` : 'Nouveau chèque',
      content: chequeForm({ companies, ...data, cheque, direction: presetDirection }),
      wide: true,
      onMount: (modal) => {
        const companySelect = modal.querySelector('select[name="companyId"]');
        const directionSelect = modal.querySelector('select[name="direction"]');
        if (!companySelect || cheque) return;
        const refresh = async () => {
          const opts = await optionsData(Number(companySelect.value));
          const accountSelect = modal.querySelector('select[name="accountId"]');
          const managerSelect = modal.querySelector('select[name="managerId"]');
          const cpSelect = modal.querySelector('select[name="counterpartyId"]');
          accountSelect.innerHTML = ui.options(opts.accounts, '', { labelKey: (a) => `${a.label} — ${a.bankName}`, includeEmpty: 'Sélectionner…' });
          managerSelect.innerHTML = ui.options(opts.managers, '', { labelKey: (m) => m.fullName, includeEmpty: 'Non affecté' });
          cpSelect.innerHTML = ui.options(opts.counterparties, '', { labelKey: (c) => `${c.name} (${c.type})`, includeEmpty: 'Aucune / saisie libre' });
          const receipt = modal.querySelector('input[name="receiptDate"]');
          receipt.required = directionSelect.value === 'RECU';
        };
        companySelect.addEventListener('change', () => refresh().catch(ui.showError));
        directionSelect.addEventListener('change', () => {
          const isReceived = directionSelect.value === 'RECU';
          modal.querySelector('input[name="receiptDate"]').required = isReceived;
          modal.querySelector('input[name="depositDate"]').closest('label').style.opacity = isReceived ? '1' : '.5';
        });
        void refresh();
      },
      actions: [
        { label: 'Annuler', className: 'btn-ghost' },
        {
          label: cheque ? 'Enregistrer' : 'Créer le chèque',
          className: 'btn-primary',
          onClick: async (close, modal) => {
            const payload = readChequeForm(modal);
            const box = modal.querySelector('#cheque-form-error');
            if (!payload.accountId || !payload.companyId || !payload.chequeNumber || !payload.partyName || !payload.issueDate || !payload.dueDate) {
              box.textContent = 'Société, compte, numéro, partie, date d’émission et échéance sont obligatoires.';
              box.hidden = false;
              return false;
            }
            if (!payload.amountCents || payload.amountCents <= 0) {
              box.textContent = 'Le montant doit être positif et correctement saisi.';
              box.hidden = false;
              return false;
            }
            try {
              if (cheque) {
                const changes = {
                  partyName: payload.partyName,
                  counterpartyId: payload.counterpartyId,
                  amountCents: payload.amountCents,
                  dueDate: payload.dueDate,
                  managerId: payload.managerId,
                  notes: payload.notes,
                  chequeType: payload.chequeType,
                };
                const result = await api.call('cheques.update', {
                  id: cheque.id,
                  version: cheque.version,
                  changes,
                  reason: 'Modification depuis la fiche chèque',
                });
                if (result && result.pendingApproval) {
                  ui.toast('Modification soumise à l’approbation du Directeur Général.', 'success', 6000);
                } else {
                  ui.toast('Chèque mis à jour.', 'success');
                }
              } else {
                const result = await api.call('cheques.create', payload);
                if (result && result.pendingApproval) {
                  ui.toast('Enregistrement soumis à l’approbation du Directeur Général (montant élevé).', 'success', 7000);
                } else {
                  ui.toast(`Chèque créé : ${result.reference}`, 'success');
                }
              }
              close();
              await reload();
            } catch (err) {
              if (err.code === 'DUPLICATE_CHEQUE' || (err.details && err.details.duplicates)) {
                box.textContent = `${err.message} Vérifiez le numéro ou saisissez un motif de dérogation (DG).`;
                box.hidden = false;
                return false;
              }
              throw err;
            }
            return true;
          },
        },
      ],
    });
  }

  function statusAction(cheque, transition, reload) {
    const content = `<form id="status-form" class="stack">
      <div class="alert info">
        <strong>${fmt.esc(cheque.reference)}</strong> · ${fmt.esc(cheque.partyName)} · ${fmt.money(cheque.amountCents)}<br />
        Statut actuel : ${fmt.statusBadge(cheque.status, fmt.statusLabel(cheque.status))} → ${fmt.statusBadge(transition.to, transition.label)}
      </div>
      ${transition.requiresDate ? `<label>Date réelle de l’événement (obligatoire)<input type="date" name="eventDate" required max="${fmt.todayISO()}" value="${fmt.todayISO()}" /></label>` : `<label>Date de l’événement<input type="date" name="eventDate" max="${fmt.todayISO()}" value="${fmt.todayISO()}" /></label>`}
      ${transition.to === 'ENDOSSE' ? '<label>Endossataire<input name="endorsee" required maxlength="160" /></label>' : ''}
      <label>Motif ${transition.requiresReason || transition.requiresDate ? '(obligatoire)' : '(facultatif)'}<textarea name="reason" maxlength="500" ${transition.requiresReason ? 'required' : ''}></textarea></label>
      ${transition.requiresApproval ? '<div class="alert warning">Cette transition nécessite l’approbation du Directeur Général. Aucune écriture ne sera appliquée avant sa décision.</div>' : ''}
      <div id="status-form-error" class="form-error" hidden></div>
    </form>`;
    ui.openModal({
      title: `Changer le statut — ${transition.label}`,
      content,
      actions: [
        { label: 'Annuler', className: 'btn-ghost' },
        {
          label: 'Enregistrer l’événement',
          className: transition.to === 'ANNULE' ? 'btn-danger' : 'btn-primary',
          onClick: async (close, modal) => {
            const data = new FormData(modal.querySelector('#status-form'));
            try {
              const result = await api.call('cheques.changeStatus', {
                id: cheque.id,
                to: transition.to,
                eventDate: String(data.get('eventDate') || '') || undefined,
                reason: String(data.get('reason') || '').trim() || undefined,
                endorsee: String(data.get('endorsee') || '').trim() || undefined,
                version: cheque.version,
              });
              close();
              if (result && result.pendingApproval) {
                ui.toast('Demande d’approbation créée. Le statut reste inchangé jusqu’à la décision du DG.', 'success', 7000);
              } else {
                ui.toast('Statut mis à jour.', 'success');
              }
              await reload();
            } catch (err) {
              const box = modal.querySelector('#status-form-error');
              box.textContent = err.message;
              box.hidden = false;
              return false;
            }
            return true;
          },
        },
      ],
    });
  }

  async function openChequeDetail(id, companyId, reload) {
    const cheque = await api.call('cheques.get', { id });
    const documents = can('documents.view')
      ? await api.call('documents.list', { entityType: 'CHEQUE', entityId: id })
      : [];
    const content = document.createElement('div');
    content.innerHTML = `
      <div class="row" style="justify-content:space-between;margin-bottom:14px">
        <div>
          <h3>${fmt.esc(cheque.reference)}</h3>
          <div class="muted">${fmt.esc(cheque.companyName)} · ${fmt.esc(cheque.accountLabel)} · ${fmt.esc(cheque.bankName)}</div>
        </div>
        <div>${fmt.statusBadge(cheque.status, cheque.statusLabel)}</div>
      </div>
      ${cheque.dataQualityFlag ? `<div class="alert warning" style="margin-bottom:14px"><strong>Donnée issue de la migration :</strong> ${fmt.esc(cheque.dataQualityFlag)}. Les chèques « À régulariser » n’ont aucun effet de trésorerie avant correction de la date réelle.</div>` : ''}
      <div class="grid two">
        <dl class="detail-grid">
          <dt>Sens</dt><dd><span class="direction ${cheque.direction === 'RECU' ? 'recu' : 'emis'}">${cheque.direction === 'RECU' ? 'Reçu' : 'Émis'}</span></dd>
          <dt>Numéro</dt><dd class="mono">${fmt.esc(cheque.chequeNumber)}</dd>
          <dt>Type</dt><dd>${fmt.esc(cheque.chequeType)}</dd>
          <dt>${cheque.direction === 'RECU' ? 'Émetteur / client' : 'Bénéficiaire'}</dt><dd>${fmt.esc(cheque.partyName)}</dd>
          <dt>Montant</dt><dd><strong>${fmt.money(cheque.amountCents)}</strong></dd>
          <dt>Devise</dt><dd>${fmt.esc(cheque.currency)}</dd>
          <dt>Gestionnaire</dt><dd>${fmt.esc(cheque.managerName || 'Non affecté')}</dd>
        </dl>
        <dl class="detail-grid">
          <dt>Émission</dt><dd>${fmt.date(cheque.issueDate)}</dd>
          <dt>Réception</dt><dd>${fmt.date(cheque.receiptDate)}</dd>
          <dt>Échéance</dt><dd>${fmt.date(cheque.dueDate)}</dd>
          <dt>Dépôt</dt><dd>${fmt.date(cheque.depositDate)}</dd>
          <dt>Encaissement</dt><dd>${fmt.date(cheque.collectionDate)}</dd>
          <dt>Paiement</dt><dd>${fmt.date(cheque.paymentDate)}</dd>
          <dt>Créé le</dt><dd>${fmt.dateTime(cheque.createdAt)}</dd>
        </dl>
      </div>
      ${cheque.notes ? `<div class="alert" style="margin-top:14px"><strong>Notes :</strong> ${fmt.esc(cheque.notes)}</div>` : ''}
      <div class="section-title"><h2>Historique des statuts</h2><span class="muted">${cheque.events.length} événement(s)</span></div>
      <div class="timeline">
        ${cheque.events
          .map(
            (e) => `<div class="timeline-item">
              <strong>${fmt.esc(e.toStatusLabel || e.eventType)} ${e.fromStatusLabel ? `— depuis ${fmt.esc(e.fromStatusLabel)}` : ''}</strong>
              <span>${fmt.date(e.eventDate)} · ${fmt.esc(e.actorName || 'Système')}${e.approvalReference ? ` · approbation ${fmt.esc(e.approvalReference)}` : ''}</span>
              ${e.reason ? `<div class="muted small" style="margin-top:4px">${fmt.esc(e.reason)}</div>` : ''}
            </div>`
          )
          .join('') || '<p class="muted">Aucun événement enregistré.</p>'}
      </div>
      <div class="section-title"><h2>Documents justificatifs</h2>${can('documents.manage') ? '<button type="button" class="btn btn-ghost btn-small" id="add-doc">Ajouter un document</button>' : ''}</div>
      ${
        documents.length
          ? `<div class="stack">${documents
              .map(
                (d) => `<div class="row" style="justify-content:space-between;border:1px solid var(--line);padding:9px 11px;border-radius:8px">
                  <div><strong>${fmt.esc(d.originalName)}</strong><div class="muted small">${fmt.integer(Math.round(d.sizeBytes / 1024))} Ko · ${fmt.dateTime(d.createdAt)}</div></div>
                  ${can('documents.view') ? `<button type="button" class="btn btn-ghost btn-small" data-open-doc="${d.id}">Ouvrir</button>` : ''}
                </div>`
              )
              .join('')}</div>`
          : '<p class="muted">Aucun document.</p>'
      }
      <div id="detail-error" class="form-error" style="margin-top:12px" hidden></div>`;

    const actions = [];
    if (can('cheques.status')) {
      for (const transition of cheque.allowedTransitions) {
        actions.push({
          label: transition.label,
          className: transition.to === 'ANNULE' ? 'btn-danger' : transition.requiresApproval ? 'btn-warning' : 'btn-secondary',
          onClick: (close, modal) => {
            close();
            statusAction(cheque, transition, async () => {
              await reload();
              UIrefreshDetail(id, companyId, reload).catch(ui.showError);
            });
            return true;
          },
        });
      }
    }
    if (can('cheques.edit')) {
      actions.push({
        label: 'Modifier',
        className: 'btn-ghost',
        onClick: (close) => {
          close();
          openChequeForm(cheque.companyId, reload, cheque).catch(ui.showError);
        },
      });
    }
    actions.push({ label: 'Fermer', className: 'btn-ghost' });
    ui.openModal({ title: `Chèque ${cheque.reference}`, content, wide: true, actions, onMount: (modal) => {
      const add = modal.querySelector('#add-doc');
      if (add) {
        add.addEventListener('click', async () => {
          try {
            const result = await api.call('documents.add', {
              companyId: cheque.companyId,
              entityType: 'CHEQUE',
              entityId: cheque.id,
            });
            if (!result.canceled) {
              ui.toast('Document ajouté.', 'success');
              modal.querySelector('.modal-close').click();
              openChequeDetail(id, companyId, reload).catch(ui.showError);
            }
          } catch (err) {
            const box = modal.querySelector('#detail-error');
            box.textContent = err.message;
            box.hidden = false;
          }
        });
      }
      for (const button of modal.querySelectorAll('[data-open-doc]')) {
        button.addEventListener('click', async () => {
          try {
            await api.call('documents.open', { id: Number(button.dataset.openDoc) });
          } catch (err) {
            ui.showError(err);
          }
        });
      }
    } });
  }

  function UIrefreshDetail(id, companyId, reload) {
    return openChequeDetail(id, companyId, reload);
  }

  Suivi.pages.cheques = {
    title: 'Chèques',
    subtitle: 'Chèques émis et reçus — cycle de vie contrôlé, historique et pièces jointes',
    permissions: ['cheques.view'],
    async render(root, query) {
      const companies = state.me.companies || [];
      const filters = state.filters.cheques || {};
      const initialCompany = query.companyId || filters.companyId || '';
      root.innerHTML = `
        <div class="filters">
          <label>Société<select id="f-company">${ui.companyOptions(companies, initialCompany, 'Toutes les sociétés')}</select></label>
          <label>Sens<select id="f-direction">
            <option value="">Tous</option>
            <option value="RECU" ${filters.direction === 'RECU' ? 'selected' : ''}>Reçus</option>
            <option value="EMIS" ${filters.direction === 'EMIS' ? 'selected' : ''}>Émis</option>
          </select></label>
          <label>Statut<select id="f-status"><option value="">Tous</option>${STATUSES.map(([code, label]) => `<option value="${code}" ${filters.status === code ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
          <label>Recherche<input id="f-search" placeholder="Référence, numéro, partie…" value="${fmt.esc(filters.search || '')}" /></label>
          <label>Échéance du<input id="f-due-from" type="date" value="${fmt.esc(filters.dueFrom || '')}" /></label>
          <label>au<input id="f-due-to" type="date" value="${fmt.esc(filters.dueTo || '')}" /></label>
          <button type="button" class="btn btn-primary" id="f-apply">Filtrer</button>
          <button type="button" class="btn btn-ghost" id="f-reset">Réinitialiser</button>
        </div>
        <div class="toolbar">
          <div id="cheque-summary" class="muted"></div>
          <div class="row">
            ${can('cheques.create') ? '<button type="button" class="btn btn-primary" id="new-cheque">Nouveau chèque</button>' : ''}
            ${can('cheques.export') ? '<button type="button" class="btn btn-ghost" id="export-cheques">Exporter la sélection</button>' : ''}
          </div>
        </div>
        <div class="card" id="cheque-table"></div>`;

      const tableCard = root.querySelector('#cheque-table');
      const companySelect = root.querySelector('#f-company');
      const directionSelect = root.querySelector('#f-direction');
      const statusSelect = root.querySelector('#f-status');
      const searchInput = root.querySelector('#f-search');
      const dueFrom = root.querySelector('#f-due-from');
      const dueTo = root.querySelector('#f-due-to');
      let page = 1;

      function params() {
        const value = {
          page,
          pageSize: 50,
          sortBy: 'dueDate',
          sortDir: 'asc',
        };
        if (companySelect.value) value.companyId = Number(companySelect.value);
        if (directionSelect.value) value.direction = directionSelect.value;
        if (statusSelect.value) value.statuses = [statusSelect.value];
        if (searchInput.value.trim()) value.search = searchInput.value.trim();
        if (dueFrom.value) value.dueFrom = dueFrom.value;
        if (dueTo.value) value.dueTo = dueTo.value;
        return value;
      }

      async function load() {
        ui.setLoading(tableCard, 'Chargement des chèques…');
        const result = await api.call('cheques.list', params());
        const items = result.items;
        const totals = items.reduce(
          (acc, c) => {
            if (c.direction === 'RECU') acc.recu += c.amountCents;
            else acc.emis += c.amountCents;
            return acc;
          },
          { recu: 0, emis: 0 }
        );
        root.querySelector('#cheque-summary').textContent =
          `${fmt.integer(result.total)} chèque(s) · page ${result.page}/${result.pageCount} · Reçus ${fmt.money(totals.recu)} · Émis ${fmt.money(totals.emis)} (page courante)`;
        tableCard.innerHTML = `
          <div class="table-wrap">
            <table class="data">
              <thead><tr>
                <th>Référence</th><th>Sens</th><th>N°</th><th>Société / compte</th><th>Partie</th>
                <th class="money">Montant</th><th>Échéance</th><th>Statut</th><th>Gestionnaire</th><th></th>
              </tr></thead>
              <tbody>
                ${
                  items.length
                    ? items
                        .map(
                          (c) => `<tr>
                            <td><button type="button" class="btn-link" data-open="${c.id}">${fmt.esc(c.reference)}</button>
                              <div class="muted small">${fmt.esc(c.chequeType)}</div></td>
                            <td><span class="direction ${c.direction === 'RECU' ? 'recu' : 'emis'}">${c.direction === 'RECU' ? 'Reçu' : 'Émis'}</span></td>
                            <td class="mono">${fmt.esc(c.chequeNumber)}</td>
                            <td>${fmt.esc(c.companyCode)}<div class="muted small">${fmt.esc(c.accountLabel)}</div></td>
                            <td>${fmt.esc(c.partyName)}</td>
                            <td class="money">${fmt.money(c.amountCents)}</td>
                            <td class="${c.dueDate < fmt.todayISO() && ['RECU', 'DEPOSE', 'EMIS', 'REMIS'].includes(c.status) ? 'danger-text' : ''}">${fmt.date(c.dueDate)}</td>
                            <td>${fmt.statusBadge(c.status, c.statusLabel)}${c.pendingApprovals ? '<div class="chip" style="margin-top:4px">Approbation en attente</div>' : ''}</td>
                            <td>${fmt.esc(c.managerName || '—')}</td>
                            <td class="actions"><button type="button" class="btn btn-ghost btn-small" data-open="${c.id}">Ouvrir</button></td>
                          </tr>`
                        )
                        .join('')
                    : `<tr><td colspan="10">${ui.emptyState('Aucun chèque', 'Ajustez les filtres ou créez un chèque.')}</td></tr>`
                }
              </tbody>
            </table>
          </div>
          <div class="pagination">
            <span>${fmt.integer(result.total)} résultat(s)</span>
            <div class="row">
              <button type="button" class="btn btn-ghost btn-small" id="prev-page" ${result.page <= 1 ? 'disabled' : ''}>Précédent</button>
              <span>Page ${result.page} / ${result.pageCount}</span>
              <button type="button" class="btn btn-ghost btn-small" id="next-page" ${result.page >= result.pageCount ? 'disabled' : ''}>Suivant</button>
            </div>
          </div>`;
        for (const button of tableCard.querySelectorAll('[data-open]')) {
          button.addEventListener('click', () => {
            openChequeDetail(Number(button.dataset.open), companySelect.value, load).catch(ui.showError);
          });
        }
        const prev = tableCard.querySelector('#prev-page');
        const next = tableCard.querySelector('#next-page');
        if (prev) prev.addEventListener('click', () => { page -= 1; load().catch(ui.showError); });
        if (next) next.addEventListener('click', () => { page += 1; load().catch(ui.showError); });
      }

      const apply = () => {
        page = 1;
        state.filters.cheques = {
          companyId: companySelect.value,
          direction: directionSelect.value,
          status: statusSelect.value,
          search: searchInput.value,
          dueFrom: dueFrom.value,
          dueTo: dueTo.value,
        };
        load().catch(ui.showError);
      };
      root.querySelector('#f-apply').addEventListener('click', apply);
      root.querySelector('#f-reset').addEventListener('click', () => {
        companySelect.value = '';
        directionSelect.value = '';
        statusSelect.value = '';
        searchInput.value = '';
        dueFrom.value = '';
        dueTo.value = '';
        apply();
      });
      searchInput.addEventListener('input', ui.debounce(apply, 350));
      companySelect.addEventListener('change', apply);
      directionSelect.addEventListener('change', apply);
      statusSelect.addEventListener('change', apply);

      const newButton = root.querySelector('#new-cheque');
      if (newButton) {
        newButton.addEventListener('click', () => {
          openChequeForm(companySelect.value ? Number(companySelect.value) : '', load).catch(ui.showError);
        });
      }
      const exportButton = root.querySelector('#export-cheques');
      if (exportButton) {
        exportButton.addEventListener('click', async () => {
          try {
            const selection = params();
            const result = await api.call('reports.export', {
              type: selection.direction === 'EMIS' ? 'cheques_issued' : selection.direction === 'RECU' ? 'cheques_received' : 'cheques_pending',
              format: 'XLSX',
              filters: { companyId: selection.companyId, statuses: selection.statuses, dateFrom: selection.dueFrom, dateTo: selection.dueTo },
            });
            if (!result.canceled) ui.toast(`Export enregistré : ${result.path}`, 'success', 7000);
          } catch (err) {
            ui.showError(err);
          }
        });
      }
      await load();
      if (query.open) {
        openChequeDetail(Number(query.open), companySelect.value, load).catch(ui.showError);
      }
    },
  };
})();
