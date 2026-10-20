'use strict';

(function () {
  const Suivi = window.Suivi;
  const { api, fmt, ui, state } = Suivi;

  function can(permission) {
    return state.permissions.has(permission);
  }

  function renderPreview(data) {
    const columns = data.columns || [];
    const rows = data.rows || [];
    const totals = data.totals || {};
    return `
      <div class="card">
        <div class="card-header">
          <div><h2>${fmt.esc(data.title)}</h2><div class="muted small">${fmt.esc(data.filtersLabel)} · généré par ${fmt.esc(data.generatedBy)} le ${fmt.dateTime(data.generatedAt)}</div></div>
          <span class="chip">${fmt.integer(rows.length)} ligne(s)</span>
        </div>
        ${(data.warnings || []).length ? `<div class="card-body" style="padding-bottom:0"><div class="alert warning">${data.warnings.map((w) => fmt.esc(w)).join('<br>')}</div></div>` : ''}
        <div class="table-wrap">
          <table class="data">
            <thead><tr>${columns.map((c) => `<th class="${c.type === 'money' || c.type === 'integer' ? 'money' : ''}">${fmt.esc(c.label)}</th>`).join('')}</tr></thead>
            <tbody>
              ${rows.length ? rows.slice(0, 300).map((row) => `<tr>${columns.map((c) => `<td class="${c.type === 'money' || c.type === 'integer' ? 'money' : ''}">${fmt.esc(fmtCell(c, row[c.key]))}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${columns.length || 1}">${ui.emptyState('Aucune donnée', 'Aucune ligne ne correspond aux filtres.')}</td></tr>`}
            </tbody>
            ${Object.keys(totals).length ? `<tfoot><tr>${columns.map((c, index) => {
              const value = totals[c.key];
              if (index === 0) return '<td>TOTAL</td>';
              if (value === undefined || value === null) return '<td></td>';
              return `<td class="${c.type === 'money' || c.type === 'integer' ? 'money' : ''}">${fmt.esc(fmtCell(c, value))}</td>`;
            }).join('')}</tr></tfoot>` : ''}
          </table>
        </div>
        ${rows.length > 300 ? `<div class="pagination"><span>Affichage limité à 300 lignes. L’export contient l’intégralité du résultat.</span></div>` : ''}
        <div class="card-body"><p class="definition">En-tête : ${fmt.esc(data.reportHeader)} · Société(s) : ${fmt.esc(data.filtersLabel)} · Document non contractuel, à vérifier avant usage comptable.</p></div>
      </div>`;
  }

  function fmtCell(column, value) {
    if (value === null || value === undefined || value === '') return '—';
    if (column.type === 'money') return fmt.money(value);
    if (column.type === 'integer') return fmt.integer(value);
    if (column.type === 'date') return fmt.date(value);
    return String(value);
  }

  Suivi.pages.reports = {
    title: 'Rapports',
    subtitle: 'Rapports financiers, de contrôle et d’audit — export CSV, XLSX, PDF et impression',
    permissions: ['reports.view'],
    async render(root, query) {
      const companies = state.me.companies || [];
      const catalogue = await api.call('reports.catalogue');
      const initialType = query.type && catalogue.some((r) => r.code === query.type) ? query.type : 'company_summary';
      root.innerHTML = `
        <div class="filters">
          <label>Rapport<select id="rp-type">${catalogue.map((r) => `<option value="${r.code}" ${r.code === initialType ? 'selected' : ''}>${fmt.esc(r.title)}</option>`).join('')}</select></label>
          <label>Société<select id="rp-company">${ui.companyOptions(companies, query.companyId || '', 'Toutes les sociétés')}</select></label>
          <label>Du<input id="rp-from" type="date" value="${fmt.esc(query.from || '')}" /></label>
          <label>Au<input id="rp-to" type="date" value="${fmt.esc(query.to || '')}" /></label>
          <label>Date d’arrêté<input id="rp-asof" type="date" value="${fmt.todayISO()}" /></label>
          <button type="button" class="btn btn-primary" id="rp-run">Générer</button>
        </div>
        <div class="toolbar">
          <div class="muted small" id="rp-label">Sélectionnez un rapport puis générez l’aperçu.</div>
          <div class="row">
            <button type="button" class="btn btn-ghost" id="rp-print">Imprimer</button>
            ${can('reports.export') ? `<button type="button" class="btn btn-ghost" data-export="CSV">Export CSV</button>
            <button type="button" class="btn btn-ghost" data-export="XLSX">Export XLSX</button>
            <button type="button" class="btn btn-primary" data-export="PDF">Export PDF</button>` : ''}
          </div>
        </div>
        <div id="rp-preview"></div>`;

      const preview = root.querySelector('#rp-preview');
      const typeSelect = root.querySelector('#rp-type');
      const companySelect = root.querySelector('#rp-company');
      const fromInput = root.querySelector('#rp-from');
      const toInput = root.querySelector('#rp-to');
      const asOfInput = root.querySelector('#rp-asof');
      let lastData = null;

      function filters() {
        const value = { asOf: asOfInput.value || fmt.todayISO() };
        if (companySelect.value) value.companyId = Number(companySelect.value);
        if (fromInput.value) value.dateFrom = fromInput.value;
        if (toInput.value) value.dateTo = toInput.value;
        return value;
      }

      async function run() {
        ui.setLoading(preview, 'Génération du rapport…');
        lastData = await api.call('reports.data', { type: typeSelect.value, filters: filters() });
        preview.innerHTML = renderPreview(lastData);
        root.querySelector('#rp-label').textContent = `${lastData.title} · ${fmt.integer(lastData.rows.length)} ligne(s) · arrêté au ${fmt.date(lastData.asOf)}`;
      }

      root.querySelector('#rp-run').addEventListener('click', () => run().catch(ui.showError));
      root.querySelector('#rp-print').addEventListener('click', () => {
        if (!lastData) return ui.toast('Générez d’abord un rapport.', 'error');
        window.print();
      });
      for (const button of root.querySelectorAll('[data-export]')) {
        button.addEventListener('click', async () => {
          if (!lastData) return ui.toast('Générez d’abord un rapport.', 'error');
          try {
            button.disabled = true;
            const result = await api.call('reports.export', {
              type: typeSelect.value,
              format: button.dataset.export,
              filters: filters(),
            });
            if (result.canceled) return;
            ui.toast(`Export ${result.format} enregistré : ${result.path} (${fmt.integer(result.rowCount)} ligne(s)).`, 'success', 8000);
            if (result.warnings && result.warnings.length) ui.toast(result.warnings.join(' · '), 'info', 8000);
          } catch (err) {
            ui.showError(err);
          } finally {
            button.disabled = false;
          }
        });
      }
      await run();
    },
  };
})();
