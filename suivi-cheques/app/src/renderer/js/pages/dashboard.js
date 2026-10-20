'use strict';

(function () {
  const Suivi = window.Suivi;
  const { api, fmt, ui, state } = Suivi;

  function kpi(label, value, note, accent, hint) {
    return `<div class="card kpi-card kpi-accent ${accent}">
      <div class="kpi-label">${fmt.esc(label)}${hint ? `<span class="kpi-hint" title="${fmt.esc(hint)}">?</span>` : ''}</div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-note">${fmt.esc(note || '')}</div>
    </div>`;
  }

  function forecastChart(weeks) {
    if (!weeks || !weeks.length) return ui.emptyState('Aucune échéance à venir');
    const max = Math.max(...weeks.map((w) => Math.abs(w.runningBalanceCents)), 1);
    return `<div class="row" style="align-items:flex-end;gap:8px;min-height:150px;padding-top:10px">
      ${weeks
        .map((w) => {
          const height = Math.max(6, Math.round((Math.abs(w.runningBalanceCents) / max) * 120));
          const negative = w.runningBalanceCents < 0;
          return `<div style="flex:1;text-align:center;min-width:52px">
            <div style="font-size:10px;color:${negative ? 'var(--red)' : 'var(--muted)'};margin-bottom:5px">${fmt.money(w.runningBalanceCents)}</div>
            <div title="${fmt.esc(w.label)}" style="height:${height}px;background:${negative ? 'var(--red)' : 'var(--teal-2)'};opacity:.85;border-radius:5px 5px 0 0;margin:0 auto;width:70%"></div>
            <div style="font-size:10.5px;color:var(--muted);margin-top:6px">${fmt.esc(w.label)}</div>
          </div>`;
        })
        .join('')}
    </div>
    <p class="definition" style="margin-top:12px">Prévision calculée à partir du solde comptable et des chèques en cours, à leur date d’échéance. Une échéance n’est pas une date de règlement certaine.</p>`;
  }

  Suivi.pages.dashboard = {
    title: 'Tableau de bord',
    subtitle: 'Vue consolidée de la trésorerie — soldes comptables, relevés et prévisions clairement distingués',
    permissions: ['dashboard.view'],
    async render(root, query) {
      const companies = state.me.companies || [];
      const defaultCompany = query.companyId || '';
      const defaultDate = query.asOf || fmt.todayISO();
      root.innerHTML = `
        <div class="filters">
          <label>Société
            <select id="dash-company">${ui.companyOptions(companies, defaultCompany, 'Toutes les sociétés autorisées')}</select>
          </label>
          <label>Date d’arrêté
            <input id="dash-asof" type="date" value="${fmt.esc(defaultDate)}" max="${fmt.todayISO()}" />
          </label>
          <button type="button" class="btn btn-primary" id="dash-apply">Appliquer</button>
          <span class="spacer"></span>
          <span class="chip">Les montants sont en DZD</span>
        </div>
        <div id="dash-body"></div>`;

      const body = root.querySelector('#dash-body');
      const companySelect = root.querySelector('#dash-company');
      const dateInput = root.querySelector('#dash-asof');
      const apply = root.querySelector('#dash-apply');

      async function load() {
        ui.setLoading(body, 'Calcul des soldes…');
        const params = { asOf: dateInput.value || fmt.todayISO() };
        if (companySelect.value) params.companyIds = [Number(companySelect.value)];
        const data = await api.call('finance.dashboard', params);
        state.filters.dashboard = { companyId: companySelect.value, asOf: dateInput.value };
        body.innerHTML = `
          <div class="grid kpi">
            ${kpi(
              'Solde comptable',
              fmt.money(data.totals.bookBalanceCents),
              'Ouverture + règlements réels. Ce n’est pas un solde bancaire.',
              '',
              data.definitions.bookBalance
            )}
            ${kpi(
              'Solde prévisionnel',
              fmt.money(data.totals.forecastBalanceCents),
              `${fmt.integer(data.counts.pending)} chèque(s) en cours · ${fmt.money(data.totals.pendingIncomingCents)} à encaisser`,
              'blue',
              data.definitions.forecastBalance
            )}
            ${kpi(
              'Soldes des relevés',
              fmt.money(data.totals.statementBalanceCents),
              `${data.totals.statementAccountsCount}/${data.totals.accountsCount} compte(s) couvert(s) par un relevé importé`,
              'green',
              data.definitions.statementBalance
            )}
            ${kpi(
              'Échéances en retard',
              fmt.integer(data.counts.overdue),
              `${fmt.integer(data.counts.rejected)} rejeté(s)/impayé(s) · ${fmt.integer(data.counts.toRegularise)} à régulariser`,
              data.counts.overdue ? 'red' : 'amber'
            )}
          </div>

          <div class="grid two" style="margin-top:16px">
            <div class="card">
              <div class="card-header"><h2>Trésorerie par société</h2><span class="muted small">Arré à ${fmt.date(data.asOf)}</span></div>
              <div class="table-wrap">
                <table class="data">
                  <thead><tr><th>Société</th><th class="money">Comptable</th><th class="money">En cours (net)</th><th class="money">Prévisionnel</th><th class="money">Relevés</th></tr></thead>
                  <tbody>
                    ${
                      data.companyBreakdown.length
                        ? data.companyBreakdown
                            .map(
                              (c) => `<tr>
                                <td><span class="badge" style="background:${fmt.esc(c.color)}22;color:${fmt.esc(c.color)}">${fmt.esc(c.code)}</span> ${fmt.esc(c.name)}</td>
                                <td class="money">${fmt.money(c.bookBalanceCents)}</td>
                                <td class="money">${fmt.money(c.pendingIncomingCents - c.pendingOutgoingCents)}</td>
                                <td class="money">${fmt.money(c.forecastBalanceCents)}</td>
                                <td class="money">${c.statementAccountsCount ? fmt.money(c.statementBalanceCents) : '—'}</td>
                              </tr>`
                            )
                            .join('')
                        : `<tr><td colspan="5">${ui.emptyState('Aucune société accessible')}</td></tr>`
                    }
                  </tbody>
                </table>
              </div>
            </div>
            <div class="card">
              <div class="card-header"><h2>Prévisionnel sur 8 semaines</h2><span class="muted small">Solde projeté</span></div>
              <div class="card-body">${forecastChart(data.forecast.weeks)}</div>
            </div>
          </div>

          <div class="grid two" style="margin-top:16px">
            <div class="card">
              <div class="card-header"><h2>Alertes et contrôles</h2></div>
              <div class="card-body">
                ${
                  data.alerts.length
                    ? `<div class="alert-list">${data.alerts
                        .map(
                          (a) => `<div class="alert ${a.severity === 'DANGER' ? 'danger' : a.severity === 'WARNING' ? 'warning' : 'info'}">
                            <div>${fmt.esc(a.message)}</div>
                            ${a.target ? `<button type="button" class="btn-link" data-target="${fmt.esc(a.target)}">Ouvrir la section</button>` : ''}
                          </div>`
                        )
                        .join('')}</div>`
                    : '<div class="alert success">Aucune alerte sur la période et le périmètre sélectionnés.</div>'
                }
              </div>
            </div>
            <div class="card">
              <div class="card-header"><h2>Échéances à venir</h2><span class="muted small">7 prochains jours</span></div>
              <div class="table-wrap">
                <table class="data">
                  <thead><tr><th>Échéance</th><th>Chèque</th><th>Société</th><th class="money">Montant</th></tr></thead>
                  <tbody>
                    ${
                      data.upcoming.length
                        ? data.upcoming
                            .map(
                              (c) => `<tr>
                                <td class="${c.overdue ? 'danger-text' : ''}">${fmt.date(c.dueDate)}</td>
                                <td><button type="button" class="btn-link" data-cheque="${c.id}">${fmt.esc(c.reference)}</button>
                                  <div class="muted small">${fmt.esc(c.partyName)} · ${c.direction === 'RECU' ? 'Reçu' : 'Émis'}</div></td>
                                <td>${fmt.esc(c.companyName)}</td>
                                <td class="money">${fmt.money(c.amountCents)}</td>
                              </tr>`
                            )
                            .join('')
                        : `<tr><td colspan="4">${ui.emptyState('Aucune échéance proche')}</td></tr>`
                    }
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <p class="definition" style="margin-top:14px">
            <strong>Lecture des soldes :</strong> le solde comptable est calculé à partir des dates réelles de règlement ;
            le solde des relevés est la somme des derniers soldes importés pour les comptes couverts ; le prévisionnel
            ajoute les chèques en cours à leur échéance. Aucun de ces indicateurs n’est présenté comme une garantie bancaire.
          </p>`;

        for (const button of body.querySelectorAll('[data-target]')) {
          button.addEventListener('click', () => {
            window.location.hash = `#/${button.dataset.target}`;
          });
        }
        for (const button of body.querySelectorAll('[data-cheque]')) {
          button.addEventListener('click', () => {
            window.location.hash = `#/cheques?open=${button.dataset.cheque}`;
          });
        }
      }

      apply.addEventListener('click', () => load().catch(ui.showError));
      companySelect.addEventListener('change', () => load().catch(ui.showError));
      await load();
    },
  };
})();
