'use strict';

(function () {
  const Suivi = window.Suivi;
  const { api, fmt, ui, state } = Suivi;

  const OPERATIONS = {
    CHEQUE_CREATE: 'Création de chèque',
    CHEQUE_UPDATE: 'Modification de chèque',
    CHEQUE_STATUS: 'Correction de statut',
    RECONCILIATION_CONFIRM: 'Finalisation de rapprochement',
  };

  function canDecide() {
    return state.permissions.has('approvals.decide');
  }

  async function openDecision(id, reload, decision) {
    const request = await api.call('approvals.get', { id });
    const values = (obj) => {
      if (!obj || typeof obj !== 'object') return '<span class="muted">—</span>';
      return `<div class="stack" style="gap:4px">${Object.entries(obj)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `<div class="row" style="gap:6px"><span class="chip">${fmt.esc(k)}</span><span>${fmt.esc(typeof v === 'object' ? JSON.stringify(v) : v)}</span></div>`)
        .join('')}</div>`;
    };
    const content = `<div class="stack">
      <div class="alert ${request.status === 'PENDING' ? 'warning' : request.status === 'APPROVED' ? 'success' : 'danger'}">
        <strong>${fmt.esc(request.reference)}</strong> · ${fmt.esc(OPERATIONS[request.operation] || request.operation)} ·
        ${fmt.statusBadge(request.status, fmt.statusLabel(request.status))}<br />
        ${fmt.esc(request.title || '')}
      </div>
      <div class="detail-grid">
        <dt>Société</dt><dd>${fmt.esc(request.companyName || 'Groupe')}</dd>
        <dt>Demandeur</dt><dd>${fmt.esc(request.requesterName || '—')}${request.requesterRole ? ` (${fmt.esc(request.requesterRole)})` : ''}</dd>
        <dt>Créée le</dt><dd>${fmt.dateTime(request.createdAt)}</dd>
        <dt>Élément</dt><dd>${fmt.esc(request.entityType)} #${fmt.esc(request.entityId)}</dd>
        ${request.decidedAt ? `<dt>Décision</dt><dd>${fmt.dateTime(request.decidedAt)} par ${fmt.esc(request.deciderName || '')}</dd>` : ''}
        ${request.decisionReason ? `<dt>Motif décision</dt><dd>${fmt.esc(request.decisionReason)}</dd>` : ''}
        <dt>Motif demande</dt><dd>${fmt.esc(request.reason || '—')}</dd>
      </div>
      <div class="grid two">
        <div><h3>Valeurs avant</h3>${values(request.before)}</div>
        <div><h3>Valeurs proposées</h3>${values(request.after)}</div>
      </div>
      ${request.previousHash || request.integrityHash ? `<p class="definition mono small">Empreinte : ${fmt.esc(request.previousHash || request.integrityHash)}</p>` : ''}
      <div class="section-title"><h2>Journal de la demande</h2></div>
      <div class="timeline">
        ${(request.events || [])
          .map(
            (e) => `<div class="timeline-item"><strong>${fmt.esc(e.action)}</strong>
              <span>${fmt.dateTime(e.at)} · ${fmt.esc(e.actorName || 'Système')}</span>
              ${e.reason ? `<div class="muted small">${fmt.esc(e.reason)}</div>` : ''}</div>`
          )
          .join('') || '<p class="muted">Aucun événement.</p>'}
      </div>
      <div id="decision-error" class="form-error" hidden></div>
    </div>`;

    const actions = [{ label: 'Fermer', className: 'btn-ghost' }];
    if (request.status === 'PENDING' && canDecide()) {
      actions.unshift({
        label: 'Rejeter',
        className: 'btn-danger',
        onClick: async (close) => {
          close();
          openDecideReason(request, 'REJECTED', reload);
          return true;
        },
      });
      actions.unshift({
        label: 'Approuver',
        className: 'btn-primary',
        onClick: async (close) => {
          close();
          openDecideReason(request, 'APPROVED', reload);
          return true;
        },
      });
    }
    ui.openModal({ title: `Demande ${request.reference}`, content, wide: true, actions });
  }

  function openDecideReason(request, decision, reload) {
    ui.openModal({
      title: decision === 'APPROVED' ? 'Approuver la demande' : 'Rejeter la demande',
      content: `<form id="decide-form" class="stack">
        <div class="alert ${decision === 'APPROVED' ? 'info' : 'danger'}">
          ${decision === 'APPROVED'
            ? 'L’opération sera appliquée immédiatement dans une transaction atomique, après vérification de la version de l’élément.'
            : 'Aucune modification ne sera appliquée. Le demandeur sera notifié.'}
        </div>
        <label>Motif ${decision === 'REJECTED' ? '(obligatoire)' : '(facultatif)'}<textarea name="reason" maxlength="500" ${decision === 'REJECTED' ? 'required' : ''}></textarea></label>
        <div id="decide-error" class="form-error" hidden></div>
      </form>`,
      actions: [
        { label: 'Annuler', className: 'btn-ghost' },
        {
          label: decision === 'APPROVED' ? 'Approuver définitivement' : 'Rejeter définitivement',
          className: decision === 'APPROVED' ? 'btn-primary' : 'btn-danger',
          onClick: async (close, modal) => {
            const data = new FormData(modal.querySelector('#decide-form'));
            try {
              await api.call('approvals.decide', {
                id: request.id,
                decision,
                reason: String(data.get('reason') || '').trim() || undefined,
              });
              close();
              ui.toast(decision === 'APPROVED' ? 'Demande approuvée et opération appliquée.' : 'Demande rejetée.', 'success');
              await reload();
            } catch (err) {
              const box = modal.querySelector('#decide-error');
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

  Suivi.pages.approvals = {
    title: 'Approbations',
    subtitle: 'Contrôle des opérations sensibles — aucune modification n’est appliquée avant décision du Directeur Général',
    permissions: ['approvals.request', 'approvals.decide'],
    async render(root) {
      const companies = state.me.companies || [];
      root.innerHTML = `
        <div class="filters">
          <label>Société<select id="a-company">${ui.companyOptions(companies, '', 'Toutes les sociétés')}</select></label>
          <label>Statut<select id="a-status">
            <option value="PENDING">En attente</option>
            <option value="ALL">Tous</option>
            <option value="APPROVED">Approuvées</option>
            <option value="REJECTED">Rejetées</option>
            <option value="CANCELLED">Annulées</option>
          </select></label>
          <label>Recherche<input id="a-search" placeholder="Référence, intitulé…" /></label>
          <button type="button" class="btn btn-primary" id="a-apply">Filtrer</button>
        </div>
        <div class="card" id="approvals-table"></div>`;

      const container = root.querySelector('#approvals-table');
      const companySelect = root.querySelector('#a-company');
      const statusSelect = root.querySelector('#a-status');
      const searchInput = root.querySelector('#a-search');
      let page = 1;

      async function load() {
        ui.setLoading(container, 'Chargement des demandes…');
        const params = { page, pageSize: 30, status: statusSelect.value };
        if (companySelect.value) params.companyIds = [Number(companySelect.value)];
        if (searchInput.value.trim()) params.search = searchInput.value.trim();
        const result = await api.call('approvals.list', params);
        container.innerHTML = `
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Référence</th><th>Opération</th><th>Société</th><th>Demandeur</th><th>Objet</th><th>Date</th><th>Statut</th><th></th></tr></thead>
              <tbody>
                ${result.items.length ? result.items.map((r) => `<tr>
                  <td><button type="button" class="btn-link" data-open="${r.id}">${fmt.esc(r.reference)}</button></td>
                  <td>${fmt.esc(OPERATIONS[r.operation] || r.operation)}</td>
                  <td>${fmt.esc(r.companyName || 'Groupe')}</td>
                  <td>${fmt.esc(r.requesterName || '—')}<div class="muted small">${fmt.esc(r.requesterRole || '')}</div></td>
                  <td>${fmt.esc(r.title || '')}</td>
                  <td>${fmt.dateTime(r.createdAt)}</td>
                  <td>${fmt.statusBadge(r.status, fmt.statusLabel(r.status))}</td>
                  <td class="actions"><button type="button" class="btn btn-ghost btn-small" data-open="${r.id}">Examiner</button></td>
                </tr>`).join('') : `<tr><td colspan="8">${ui.emptyState('Aucune demande', 'Les opérations protégées créeront une demande ici.')}</td></tr>`}
              </tbody>
            </table>
          </div>
          <div class="pagination">
            <span>${fmt.integer(result.total)} demande(s)${canDecide() ? '' : ' — vous ne voyez que vos demandes'}</span>
            <div class="row">
              <button type="button" class="btn btn-ghost btn-small" id="a-prev" ${result.page <= 1 ? 'disabled' : ''}>Précédent</button>
              <span>Page ${result.page} / ${result.pageCount}</span>
              <button type="button" class="btn btn-ghost btn-small" id="a-next" ${result.page >= result.pageCount ? 'disabled' : ''}>Suivant</button>
            </div>
          </div>`;
        for (const button of container.querySelectorAll('[data-open]')) {
          button.addEventListener('click', () => openDecision(Number(button.dataset.open), load).catch(ui.showError));
        }
        const prev = container.querySelector('#a-prev');
        const next = container.querySelector('#a-next');
        if (prev) prev.addEventListener('click', () => { page -= 1; load().catch(ui.showError); });
        if (next) next.addEventListener('click', () => { page += 1; load().catch(ui.showError); });
      }

      root.querySelector('#a-apply').addEventListener('click', () => { page = 1; load().catch(ui.showError); });
      searchInput.addEventListener('input', ui.debounce(() => { page = 1; load().catch(ui.showError); }, 350));
      await load();
    },
  };
})();
