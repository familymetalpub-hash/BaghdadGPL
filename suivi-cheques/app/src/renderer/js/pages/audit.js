'use strict';

(function () {
  const Suivi = window.Suivi;
  const { api, fmt, ui, state } = Suivi;

  function detailContent(log) {
    const render = (object) => {
      if (!object) return '<span class="muted">—</span>';
      if (typeof object !== 'object') return fmt.esc(object);
      return `<pre class="mono small" style="white-space:pre-wrap;margin:0;background:#f7f9fa;padding:10px;border-radius:7px;max-height:240px;overflow:auto">${fmt.esc(JSON.stringify(object, null, 2))}</pre>`;
    };
    return `<div class="stack">
      <div class="detail-grid">
        <dt>Date</dt><dd>${fmt.dateTime(log.at)}</dd>
        <dt>Utilisateur</dt><dd>${fmt.esc(log.userFullName || log.username || 'Système')}</dd>
        <dt>Société</dt><dd>${fmt.esc(log.companyName || 'Groupe / système')}</dd>
        <dt>Action</dt><dd><strong>${fmt.esc(log.action)}</strong></dd>
        <dt>Élément</dt><dd>${fmt.esc(log.entityType)} #${fmt.esc(log.entityId)}</dd>
        <dt>Motif</dt><dd>${fmt.esc(log.reason || '—')}</dd>
        <dt>Source</dt><dd>${fmt.esc(log.source || '—')}</dd>
        <dt>Approbation</dt><dd>${log.approvalRequestId ? `#${log.approvalRequestId}` : '—'}</dd>
      </div>
      <div class="grid two">
        <div><h3>Avant</h3>${render(log.before)}</div>
        <div><h3>Après</h3>${render(log.after)}</div>
      </div>
      <div><h3>Métadonnées</h3>${render(log.metadata)}</div>
      <p class="definition">Cette entrée est immuable. Le journal ne peut être modifié ni supprimé depuis l’application.</p>
    </div>`;
  }

  Suivi.pages.audit = {
    title: 'Piste d’audit',
    subtitle: 'Journal structuré et non modifiable des opérations — distinct de l’historique des chèques',
    permissions: ['audit.view'],
    async render(root) {
      const companies = state.me.companies || [];
      root.innerHTML = `
        <div class="filters">
          <label>Société<select id="au-company">${ui.companyOptions(companies, '', 'Toutes les sociétés autorisées')}</select></label>
          <label>Type d’élément<select id="au-entity">
            <option value="">Tous</option>
            <option value="CHEQUE">Chèque</option><option value="SOCIETE">Société</option>
            <option value="COMPTE">Compte</option><option value="BANQUE">Banque</option>
            <option value="APPROBATION">Approbation</option><option value="IMPORT">Import bancaire</option>
            <option value="UTILISATEUR">Utilisateur</option><option value="USER">Utilisateur</option>
            <option value="BACKUP">Sauvegarde</option><option value="MIGRATION">Migration</option>
            <option value="AUTH">Authentification</option><option value="SETTINGS">Paramètres</option>
          </select></label>
          <label>Du<input id="au-from" type="date" /></label>
          <label>Au<input id="au-to" type="date" /></label>
          <label>Recherche<input id="au-search" placeholder="Action, motif, identifiant…" /></label>
          <button type="button" class="btn btn-primary" id="au-apply">Filtrer</button>
          <button type="button" class="btn btn-ghost" id="au-export">Exporter</button>
        </div>
        <div class="card" id="au-table"></div>`;

      const container = root.querySelector('#au-table');
      const companySelect = root.querySelector('#au-company');
      const entitySelect = root.querySelector('#au-entity');
      const fromInput = root.querySelector('#au-from');
      const toInput = root.querySelector('#au-to');
      const searchInput = root.querySelector('#au-search');
      let page = 1;

      function params() {
        const value = { page, pageSize: 50 };
        if (companySelect.value) value.companyIds = [Number(companySelect.value)];
        if (entitySelect.value) value.entityType = entitySelect.value;
        if (fromInput.value) value.dateFrom = fromInput.value;
        if (toInput.value) value.dateTo = toInput.value;
        if (searchInput.value.trim()) value.search = searchInput.value.trim();
        return value;
      }

      async function load() {
        ui.setLoading(container, 'Chargement du journal…');
        const result = await api.call('audit.list', params());
        container.innerHTML = `
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Horodatage</th><th>Utilisateur</th><th>Société</th><th>Action</th><th>Élément</th><th>Motif</th><th></th></tr></thead>
              <tbody>
                ${result.rows.length ? result.rows.map((r) => `<tr>
                  <td class="nowrap">${fmt.dateTime(r.at)}</td>
                  <td>${fmt.esc(r.userFullName || r.username || 'Système')}</td>
                  <td>${fmt.esc(r.companyCode || r.companyName || '—')}</td>
                  <td><span class="chip">${fmt.esc(r.action)}</span></td>
                  <td>${fmt.esc(r.entityType)} #${fmt.esc(r.entityId)}</td>
                  <td>${fmt.esc(r.reason || '—')}</td>
                  <td class="actions"><button type="button" class="btn btn-ghost btn-small" data-audit="${r.id}">Détail</button></td>
                </tr>`).join('') : `<tr><td colspan="7">${ui.emptyState('Aucune entrée', 'Aucune opération enregistrée sur les filtres sélectionnés.')}</td></tr>`}
              </tbody>
            </table>
          </div>
          <div class="pagination">
            <span>${fmt.integer(result.total)} entrée(s)</span>
            <div class="row">
              <button type="button" class="btn btn-ghost btn-small" id="au-prev" ${result.page <= 1 ? 'disabled' : ''}>Précédent</button>
              <span>Page ${result.page} / ${result.pageCount}</span>
              <button type="button" class="btn btn-ghost btn-small" id="au-next" ${result.page >= result.pageCount ? 'disabled' : ''}>Suivant</button>
            </div>
          </div>`;
        for (const button of container.querySelectorAll('[data-audit]')) {
          button.addEventListener('click', () => {
            const log = result.rows.find((r) => r.id === Number(button.dataset.audit));
            ui.openModal({ title: `Audit #${log.id}`, content: detailContent(log), wide: true, actions: [{ label: 'Fermer', className: 'btn-ghost' }] });
          });
        }
        const prev = container.querySelector('#au-prev');
        const next = container.querySelector('#au-next');
        if (prev) prev.addEventListener('click', () => { page -= 1; load().catch(ui.showError); });
        if (next) next.addEventListener('click', () => { page += 1; load().catch(ui.showError); });
      }

      root.querySelector('#au-apply').addEventListener('click', () => { page = 1; load().catch(ui.showError); });
      searchInput.addEventListener('input', ui.debounce(() => { page = 1; load().catch(ui.showError); }, 350));
      root.querySelector('#au-export').addEventListener('click', async () => {
        try {
          const f = params();
          delete f.page;
          delete f.pageSize;
          const result = await api.call('audit.export', { format: 'CSV', filters: f });
          if (!result.canceled) ui.toast(`Piste d’audit exportée : ${result.path}`, 'success', 7000);
        } catch (err) {
          ui.showError(err);
        }
      });
      await load();
    },
  };
})();
