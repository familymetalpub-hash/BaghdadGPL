'use strict';

(function () {
  const Suivi = window.Suivi;
  const { api, fmt, ui, state } = Suivi;

  function can(permission) {
    return state.permissions.has(permission);
  }

  function mappingSelect(name, label, columns, selected) {
    return `<label>${fmt.esc(label)}
      <select name="${name}">
        <option value="">— Non utilisé —</option>
        ${columns.map((c) => `<option value="${c.index}" ${Number(selected) === c.index ? 'selected' : ''}>${fmt.esc(c.label)}</option>`).join('')}
      </select>
    </label>`;
  }

  async function openImportWizard(accountId, reload) {
    if (!accountId) return ui.toast('Sélectionnez d’abord un compte bancaire.', 'error');
    let stage;
    try {
      stage = await api.call('imports.stage');
    } catch (err) {
      return ui.showError(err);
    }
    if (!stage || stage.canceled) return;
    const columns = stage.preview.columns;
    const mapping = stage.suggestedMapping || {};
    const content = document.createElement('div');
    content.innerHTML = `
      <div class="alert info">
        <strong>${fmt.esc(stage.filename)}</strong> · ${fmt.integer(stage.preview.totalRows)} ligne(s) de données ·
        délimiteur ${fmt.esc(stage.preview.delimiter || '—')} · encodage ${fmt.esc(stage.preview.encoding || '—')}
      </div>
      <form id="mapping-form" class="stack" style="margin-top:14px">
        <div class="form-grid three">
          <label>Ligne d’en-tête<input name="headerRow" type="number" min="1" value="1" /></label>
          <label>Format de date<select name="dateFormat">
            <option value="AUTO">Automatique</option><option value="ISO">AAAA-MM-JJ</option>
            <option value="YMD">A/M/J</option><option value="DMY">J/M/A</option><option value="MDY">M/J/A</option>
          </select></label>
          <label>Séparateur décimal<select name="decimalSeparator">
            <option value="auto">Automatique</option><option value=",">Virgule</option><option value=".">Point</option>
          </select></label>
          <label>Sens du montant signé<select name="amountDirection">
            <option value="NEGATIVE_IS_DEBIT">Négatif = débit</option>
            <option value="POSITIVE_IS_DEBIT">Positif = débit</option>
          </select></label>
        </div>
        <div class="form-grid three">
          ${mappingSelect('date', 'Date (obligatoire)', columns, mapping.date)}
          ${mappingSelect('valueDate', 'Date de valeur', columns, mapping.valueDate)}
          ${mappingSelect('description', 'Libellé', columns, mapping.description)}
          ${mappingSelect('debit', 'Débit', columns, mapping.debit)}
          ${mappingSelect('credit', 'Crédit', columns, mapping.credit)}
          ${mappingSelect('amount', 'Montant signé (si pas débit/crédit)', columns, mapping.amount)}
          ${mappingSelect('balance', 'Solde', columns, mapping.balance)}
          ${mappingSelect('reference', 'Référence bancaire', columns, mapping.reference)}
          ${mappingSelect('currency', 'Devise', columns, mapping.currency)}
        </div>
        <div class="table-wrap" style="max-height:200px;overflow:auto;border:1px solid var(--line);border-radius:8px">
          <table class="data"><thead><tr>${columns.map((c) => `<th>${fmt.esc(c.label)}</th>`).join('')}</tr></thead>
          <tbody>${stage.preview.rows.slice(0, 8).map((row) => `<tr>${row.map((cell) => `<td>${fmt.esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>
        </div>
        <div id="mapping-error" class="form-error" hidden></div>
      </form>`;
    ui.openModal({
      title: 'Importer un relevé bancaire',
      content,
      wide: true,
      actions: [
        { label: 'Annuler', className: 'btn-ghost' },
        {
          label: 'Analyser le relevé',
          className: 'btn-primary',
          onClick: async (close, modal) => {
            const form = modal.querySelector('#mapping-form');
            const data = new FormData(form);
            const readCol = (name) => (data.get(name) === '' ? null : Number(data.get(name)));
            const payload = {
              token: stage.token,
              accountId: Number(accountId),
              mapping: {
                date: readCol('date'),
                valueDate: readCol('valueDate'),
                description: readCol('description'),
                debit: readCol('debit'),
                credit: readCol('credit'),
                amount: readCol('amount'),
                balance: readCol('balance'),
                reference: readCol('reference'),
                currency: readCol('currency'),
              },
              options: {
                hasHeader: true,
                headerRow: Number(data.get('headerRow')) || 1,
                dateFormat: String(data.get('dateFormat')),
                decimalSeparator: String(data.get('decimalSeparator')),
                amountDirection: String(data.get('amountDirection')),
                delimiter: stage.preview.delimiter || 'auto',
                encoding: stage.preview.encoding || 'auto',
                sheetName: stage.sheets ? stage.sheets[0] : null,
              },
            };
            if (payload.mapping.date === null) {
              const box = modal.querySelector('#mapping-error');
              box.textContent = 'La colonne de date est obligatoire.';
              box.hidden = false;
              return false;
            }
            try {
              const analysis = await api.call('imports.analyze', payload);
              close();
              openAnalysis(analysis, Number(accountId), reload);
            } catch (err) {
              const box = modal.querySelector('#mapping-error');
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

  function openAnalysis(analysis, accountId, reload) {
    const suggestion = analysis.suggestion || {};
    const content = `<div class="stack">
      <div class="grid three">
        <div class="card card-pad"><div class="kpi-label">Lignes valides</div><div class="kpi-value">${fmt.integer(analysis.validRows)}</div></div>
        <div class="card card-pad"><div class="kpi-label">Lignes en erreur</div><div class="kpi-value ${analysis.invalidRows ? 'danger-text' : ''}">${fmt.integer(analysis.invalidRows)}</div></div>
        <div class="card card-pad"><div class="kpi-label">Doublons déjà importés</div><div class="kpi-value">${fmt.integer(analysis.existingDuplicates)}</div></div>
      </div>
      <div class="alert ${analysis.invalidRows ? 'warning' : 'success'}">
        Débits ${fmt.money(analysis.totals.debitCents)} · Crédits ${fmt.money(analysis.totals.creditCents)} · Net ${fmt.money(analysis.totals.netCents)}.
        ${analysis.invalidRows ? ' Les lignes invalides seront exclues uniquement si vous confirmez un import partiel.' : ''}
      </div>
      ${analysis.issues && analysis.issues.length ? `<div class="table-wrap" style="max-height:180px;overflow:auto;border:1px solid var(--line);border-radius:8px">
        <table class="data"><thead><tr><th>Ligne</th><th>Gravité</th><th>Message</th></tr></thead><tbody>
        ${analysis.issues.slice(0, 80).map((i) => `<tr><td>${fmt.esc(i.rowNumber || '—')}</td><td>${fmt.esc(i.severity)}</td><td>${fmt.esc(i.message)}</td></tr>`).join('')}
        </tbody></table></div>` : ''}
      <form id="commit-form" class="stack">
        <div class="form-grid">
          <label>Date du relevé<input name="statementDate" type="date" required max="${fmt.todayISO()}" value="${fmt.esc(suggestion.statementDate || fmt.todayISO())}" /></label>
          <label>Solde de clôture (DA)<input name="closingBalance" inputmode="decimal" value="${suggestion.closingBalanceCents !== null && suggestion.closingBalanceCents !== undefined ? (suggestion.closingBalanceCents / 100).toFixed(2) : ''}" /></label>
        </div>
        ${analysis.invalidRows ? '<label class="checkline"><input type="checkbox" name="allowPartial" /> J’autorise explicitement l’import partiel en excluant les lignes en erreur</label>' : ''}
        <div class="alert info">Les lignes déjà importées seront ignorées. Le fichier est identifié par son empreinte SHA-256 ; un même fichier ne peut pas être importé deux fois. Aucun rapprochement n’est finalisé automatiquement.</div>
        <div id="commit-error" class="form-error" hidden></div>
      </form>
    </div>`;
    ui.openModal({
      title: `Analyse du relevé — ${analysis.filename}`,
      content,
      wide: true,
      actions: [
        { label: 'Annuler', className: 'btn-ghost' },
        {
          label: 'Importer les lignes valides',
          className: 'btn-primary',
          onClick: async (close, modal) => {
            const data = new FormData(modal.querySelector('#commit-form'));
            const statementDate = String(data.get('statementDate') || '');
            if (!statementDate) {
              const box = modal.querySelector('#commit-error');
              box.textContent = 'La date du relevé est obligatoire.';
              box.hidden = false;
              return false;
            }
            try {
              const result = await api.call('imports.commit', {
                batchId: analysis.batchId,
                accountId,
                statementDate,
                closingBalance: String(data.get('closingBalance') || '') || null,
                allowPartial: data.get('allowPartial') === 'on',
                reason: 'Import depuis l’interface de rapprochement',
              });
              close();
              ui.toast(
                `Import terminé : ${result.importedCount} ligne(s), ${result.duplicateCount} doublon(s) ignoré(s)${result.proposalError ? ' — propositions non générées' : ''}.`,
                'success',
                8000
              );
              await reload();
            } catch (err) {
              const box = modal.querySelector('#commit-error');
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

  function openManualBalance(accountId, reload) {
    ui.openModal({
      title: 'Saisir un solde bancaire',
      content: `<form id="manual-balance" class="stack">
        <div class="alert warning">Cette saisie déclare un solde de relevé sans importer de lignes. Elle ne remplace pas un relevé et ne crée aucun rapprochement.</div>
        <label>Date du relevé<input name="statementDate" type="date" required max="${fmt.todayISO()}" value="${fmt.todayISO()}" /></label>
        <label>Solde de clôture (DA)<input name="closingBalance" inputmode="decimal" required /></label>
        <label>Motif<textarea name="reason" maxlength="300" required>Saisie manuelle du solde constaté</textarea></label>
        <div id="manual-error" class="form-error" hidden></div>
      </form>`,
      actions: [
        { label: 'Annuler', className: 'btn-ghost' },
        {
          label: 'Enregistrer le solde',
          className: 'btn-primary',
          onClick: async (close, modal) => {
            const data = new FormData(modal.querySelector('#manual-balance'));
            const cents = fmt.parseMoneyToCents(String(data.get('closingBalance') || ''));
            if (cents === null || !Number.isInteger(cents)) {
              const box = modal.querySelector('#manual-error');
              box.textContent = 'Solde invalide.';
              box.hidden = false;
              return false;
            }
            try {
              await api.call('imports.manualBalance', {
                accountId,
                statementDate: String(data.get('statementDate')),
                closingBalanceCents: cents,
                reason: String(data.get('reason') || '').trim() || 'Saisie manuelle',
              });
              close();
              ui.toast('Solde de relevé enregistré.', 'success');
              await reload();
            } catch (err) {
              const box = modal.querySelector('#manual-error');
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

  async function openMatch(txId, reload) {
    try {
      await api.call('reconciliation.auto', { transactionIds: [txId] });
    } catch (err) {
      if (err.code !== 'FORBIDDEN') ui.showError(err);
    }
    const [tx, candidates] = await Promise.all([
      api.call('reconciliation.get', { transactionId: txId }),
      api.call('reconciliation.candidates', { transactionId: txId }),
    ]);
    const content = document.createElement('div');
    content.innerHTML = `
      <div class="alert ${tx.direction === 'CREDIT' ? 'success' : 'info'}">
        <strong>${fmt.date(tx.transactionDate)} · ${fmt.esc(tx.description || 'Sans libellé')}</strong><br />
        ${tx.direction === 'CREDIT' ? 'Crédit' : 'Débit'} de <strong>${fmt.money(tx.amountCents)}</strong> ·
        ${fmt.esc(tx.accountLabel)} — ${fmt.esc(tx.bankName)} · Réf. ${fmt.esc(tx.bankRef || '—')}
      </div>
      <div class="section-title"><h2>Propositions enregistrées</h2></div>
      ${
        tx.matches.length
          ? `<div class="stack">${tx.matches
              .map(
                (m) => `<div class="card card-pad">
                  <div class="row" style="justify-content:space-between">
                    <div><strong>${fmt.esc(m.chequeReference)}</strong> · ${fmt.esc(m.chequeParty)}<div class="muted small">${fmt.esc(m.chequeStatusLabel)} · score ${m.score} · ${fmt.esc(m.matchType)}</div></div>
                    <div>${fmt.statusBadge(m.status, fmt.statusLabel(m.status))}</div>
                  </div>
                  ${m.status === 'PROPOSE' ? `<div class="row" style="margin-top:10px">
                    ${can('reconciliation.confirm') ? `<button type="button" class="btn btn-primary btn-small" data-confirm="${m.id}">Confirmer</button>` : '<span class="muted small">Seul le Directeur Général peut finaliser.</span>'}
                    <button type="button" class="btn btn-ghost btn-small" data-reject="${m.id}">Rejeter</button>
                  </div>` : ''}
                </div>`
              )
              .join('')}</div>`
          : '<p class="muted">Aucune proposition. Sélectionnez un chèque ci-dessous ou rejetez la ligne.</p>'
      }
      ${
        candidates.length
          ? `<div class="section-title"><h2>Chèques candidats</h2><span class="muted">Même société, même compte, sens et montant</span></div>
            <div class="table-wrap"><table class="data"><thead><tr><th>Chèque</th><th>Partie</th><th class="money">Montant</th><th>Échéance</th><th>Indice</th><th></th></tr></thead><tbody>
            ${candidates.map((c) => `<tr><td>${fmt.esc(c.reference)}<div class="muted small">${fmt.esc(c.chequeNumber)}</div></td>
              <td>${fmt.esc(c.partyName)}</td><td class="money">${fmt.money(c.amountCents)}</td><td>${fmt.date(c.dueDate)}</td>
              <td>${c.score ? `<span class="badge ${c.score >= 80 ? 'green' : 'amber'}">${c.score}</span>` : '<span class="muted">—</span>'}</td>
              <td class="actions"><button type="button" class="btn btn-ghost btn-small" data-propose="${c.id}">Proposer</button></td></tr>`).join('')}
            </tbody></table></div>`
          : '<div class="alert warning" style="margin-top:14px">Aucun chèque candidat au même montant, sens, société et compte. Le rapprochement manuel avec un montant différent n’est pas autorisé.</div>'
      }
      <div class="field" style="margin-top:14px">
        <label for="deposit-date">Date réelle de dépôt (si le chèque n’a jamais été déposé)</label>
        <input type="date" id="deposit-date" name="depositDate" max="${tx.transactionDate}" />
        <p class="hint">Obligatoire pour un chèque reçu encore au statut « Reçu » : la banque a nécessairement reçu le chèque. L’échéance n’est jamais utilisée comme date de dépôt ni de règlement.</p>
      </div>
      <div id="match-error" class="form-error" style="margin-top:12px" hidden></div>`;
    ui.openModal({
      title: 'Rapprochement bancaire',
      content,
      wide: true,
      onMount: (modal) => {
        const showError = (err) => {
          const box = modal.querySelector('#match-error');
          box.textContent = err.message;
          box.hidden = false;
        };
        for (const button of modal.querySelectorAll('[data-confirm]')) {
          button.addEventListener('click', async () => {
            const ok = await ui.confirmDialog({
              title: 'Finaliser le rapprochement',
              message: 'Le rapprochement sera enregistré et, si demandé, le chèque passera au statut réglé avec sa date réelle. Cette opération peut nécessiter une approbation du DG.',
              confirmLabel: 'Finaliser',
              danger: true,
            });
            if (!ok) return;
            try {
              const depositInput = modal.querySelector('#deposit-date');
              const depositDate = depositInput && depositInput.value ? depositInput.value : undefined;
              const result = await api.call('reconciliation.confirm', {
                matchId: Number(button.dataset.confirm),
                settleCheque: true,
                settlementDate: tx.transactionDate,
                depositDate,
                reason: 'Rapprochement confirmé depuis le relevé bancaire',
              });
              modal.querySelector('.modal-close').click();
              if (result && result.pendingApproval) ui.toast('Rapprochement soumis à approbation du DG.', 'success', 7000);
              else ui.toast('Rapprochement finalisé.', 'success');
              await reload();
            } catch (err) {
              showError(err);
            }
          });
        }
        for (const button of modal.querySelectorAll('[data-reject]')) {
          button.addEventListener('click', async () => {
            const reason = await ui.promptDialog({ title: 'Rejeter la proposition', label: 'Motif du rejet (3 caractères minimum)', value: 'Proposition non retenue', required: true });
            if (!reason) return;
            try {
              await api.call('reconciliation.reject', { matchId: Number(button.dataset.reject), reason });
              modal.querySelector('.modal-close').click();
              ui.toast('Proposition rejetée.', 'success');
              await reload();
            } catch (err) {
              showError(err);
            }
          });
        }
        for (const button of modal.querySelectorAll('[data-propose]')) {
          button.addEventListener('click', async () => {
            try {
              await api.call('reconciliation.propose', {
                transactionId: tx.id,
                chequeId: Number(button.dataset.propose),
                reason: 'Proposition manuelle depuis le rapprochement',
              });
              modal.querySelector('.modal-close').click();
              ui.toast('Proposition enregistrée. Une confirmation est requise.', 'success');
              await openMatch(tx.id, reload);
            } catch (err) {
              showError(err);
            }
          });
        }
      },
      actions: [
        { label: 'Fermer', className: 'btn-ghost' },
        {
          label: 'Marquer la ligne en revue',
          className: 'btn-ghost',
          onClick: async (close) => {
            try {
              await api.call('reconciliation.recompute', { transactionId: tx.id });
              close();
              ui.toast('Statut de la ligne recalculé.', 'success');
              await reload();
            } catch (err) {
              ui.showError(err);
            }
          },
        },
      ],
    });
  }

  Suivi.pages.reconciliation = {
    title: 'Rapprochement bancaire',
    subtitle: 'Import de relevés, contrôle ligne à ligne et finalisation réservée au Directeur Général',
    permissions: ['reconciliation.view'],
    async render(root, query) {
      const companies = state.me.companies || [];
      const tab = query.tab === 'imports' ? 'imports' : 'lines';
      root.innerHTML = `
        <div class="tabs">
          <button type="button" class="tab ${tab === 'lines' ? 'active' : ''}" data-tab="lines">Lignes de relevé</button>
          <button type="button" class="tab ${tab === 'imports' ? 'active' : ''}" data-tab="imports">Historique des imports</button>
        </div>
        <div class="filters">
          <label>Société<select id="r-company">${ui.companyOptions(companies, query.companyId || '', 'Toutes les sociétés')}</select></label>
          <label>Compte<select id="r-account"><option value="">Tous les comptes</option></select></label>
          <label>Rapprochement<select id="r-status">
            <option value="ALL">Tous</option><option value="UNMATCHED">Non rapprochés</option>
            <option value="PROPOSED">Proposés</option><option value="MATCHED">Rapprochés</option>
            <option value="REVIEW">À examiner</option><option value="DUPLICATE">Doublons</option>
          </select></label>
          <label>Recherche<input id="r-search" placeholder="Libellé, référence…" /></label>
          <button type="button" class="btn btn-primary" id="r-apply">Filtrer</button>
        </div>
        <div class="toolbar">
          <div class="muted small">Le montant seul ne suffit jamais à finaliser un rapprochement. Une ligne bancaire ne peut pas être liée à plusieurs chèques (fractionnement non pris en charge).</div>
          ${can('reconciliation.import') ? '<div class="row"><button type="button" class="btn btn-ghost" id="manual-balance">Saisir un solde</button><button type="button" class="btn btn-primary" id="import-statement">Importer un relevé</button></div>' : ''}
        </div>
        <div id="recon-content"></div>`;

      const content = root.querySelector('#recon-content');
      const companySelect = root.querySelector('#r-company');
      const accountSelect = root.querySelector('#r-account');
      const statusSelect = root.querySelector('#r-status');
      const searchInput = root.querySelector('#r-search');
      let activeTab = tab;
      let page = 1;

      async function loadAccounts() {
        const options = await api.call('accounts.options', companySelect.value ? { companyIds: [Number(companySelect.value)] } : {});
        const previous = accountSelect.value;
        accountSelect.innerHTML = `<option value="">Tous les comptes</option>${ui.options(options, previous, { labelKey: (a) => `${a.label} — ${a.bankName}` })}`;
      }

      async function loadLines() {
        ui.setLoading(content, 'Chargement des lignes bancaires…');
        const params = { page, pageSize: 50, matchStatus: statusSelect.value };
        if (companySelect.value) params.companyId = Number(companySelect.value);
        if (accountSelect.value) params.accountId = Number(accountSelect.value);
        if (searchInput.value.trim()) params.search = searchInput.value.trim();
        const result = await api.call('reconciliation.list', params);
        content.innerHTML = `
          <div class="card">
            <div class="table-wrap">
              <table class="data">
                <thead><tr><th>Date</th><th>Référence</th><th>Libellé</th><th>Compte</th><th class="money">Débit</th><th class="money">Crédit</th><th>Rapprochement</th><th></th></tr></thead>
                <tbody>
                  ${result.items.length ? result.items.map((t) => `<tr>
                    <td>${fmt.date(t.transactionDate)}<div class="muted small">valeur ${fmt.date(t.valueDate)}</div></td>
                    <td class="mono">${fmt.esc(t.bankRef || '—')}</td>
                    <td>${fmt.esc(t.description || '')}</td>
                    <td>${fmt.esc(t.accountLabel)}<div class="muted small">${fmt.esc(t.companyName)}</div></td>
                    <td class="money">${t.debitCents ? fmt.money(t.debitCents) : '—'}</td>
                    <td class="money">${t.creditCents ? fmt.money(t.creditCents) : '—'}</td>
                    <td>${fmt.statusBadge(t.matchStatus, fmt.statusLabel(t.matchStatus))}
                      ${t.matches.length ? `<div class="muted small">${t.matches.length} proposition(s)</div>` : ''}</td>
                    <td class="actions"><button type="button" class="btn btn-ghost btn-small" data-match="${t.id}">Examiner</button></td>
                  </tr>`).join('') : `<tr><td colspan="8">${ui.emptyState('Aucune ligne de relevé', 'Importez un relevé bancaire pour commencer.')}</td></tr>`}
                </tbody>
              </table>
            </div>
            <div class="pagination">
              <span>${fmt.integer(result.total)} ligne(s)</span>
              <div class="row">
                <button type="button" class="btn btn-ghost btn-small" id="r-prev" ${result.page <= 1 ? 'disabled' : ''}>Précédent</button>
                <span>Page ${result.page} / ${result.pageCount}</span>
                <button type="button" class="btn btn-ghost btn-small" id="r-next" ${result.page >= result.pageCount ? 'disabled' : ''}>Suivant</button>
              </div>
            </div>
          </div>`;
        for (const button of content.querySelectorAll('[data-match]')) {
          button.addEventListener('click', () => openMatch(Number(button.dataset.match), () => loadLines().catch(ui.showError)).catch(ui.showError));
        }
        const prev = content.querySelector('#r-prev');
        const next = content.querySelector('#r-next');
        if (prev) prev.addEventListener('click', () => { page -= 1; loadLines().catch(ui.showError); });
        if (next) next.addEventListener('click', () => { page += 1; loadLines().catch(ui.showError); });
      }

      async function loadImports() {
        ui.setLoading(content, 'Chargement des imports…');
        const params = {};
        if (companySelect.value) params.companyIds = [Number(companySelect.value)];
        if (accountSelect.value) params.accountId = Number(accountSelect.value);
        const list = await api.call('imports.list', params);
        content.innerHTML = `
          <div class="card">
            <div class="table-wrap">
              <table class="data">
                <thead><tr><th>Relevé</th><th>Compte</th><th>Type</th><th>Date relevé</th><th class="money">Solde de clôture</th><th class="right">Lignes</th><th>Statut</th><th>Importé par</th><th></th></tr></thead>
                <tbody>
                  ${list.length ? list.map((i) => `<tr>
                    <td>${fmt.esc(i.sourceFilename || 'Saisie manuelle')}<div class="muted small">${fmt.dateTime(i.createdAt)}</div></td>
                    <td>${fmt.esc(i.accountLabel)}<div class="muted small">${fmt.esc(i.companyName)}</div></td>
                    <td>${fmt.esc(i.sourceType)}</td>
                    <td>${fmt.date(i.statementDate)}</td>
                    <td class="money">${i.closingBalanceCents === null ? '—' : fmt.money(i.closingBalanceCents)}</td>
                    <td class="right">${fmt.integer(i.importedCount)} / ${fmt.integer(i.rowCount)}</td>
                    <td><span class="badge ${i.status === 'COMPLETED' ? 'green' : i.status === 'PARTIAL' ? 'amber' : 'gray'}">${fmt.esc(i.status)}</span></td>
                    <td>${fmt.esc(i.importerName || '—')}</td>
                    <td class="actions"><button type="button" class="btn btn-ghost btn-small" data-import-detail="${i.id}">Détail</button></td>
                  </tr>`).join('') : `<tr><td colspan="9">${ui.emptyState('Aucun import', 'Aucun relevé importé sur ce périmètre.')}</td></tr>`}
                </tbody>
              </table>
            </div>
          </div>`;
        for (const button of content.querySelectorAll('[data-import-detail]')) {
          button.addEventListener('click', async () => {
            try {
              const detail = await api.call('imports.detail', { id: Number(button.dataset.importDetail) });
              const issues = detail.issues || [];
              ui.openModal({
                title: `Import ${detail.sourceFilename || detail.id}`,
                wide: true,
                content: `<div class="stack">
                  <div class="detail-grid">
                    <dt>Compte</dt><dd>${fmt.esc(detail.accountLabel)} — ${fmt.esc(detail.bankName)}</dd>
                    <dt>Date du relevé</dt><dd>${fmt.date(detail.statementDate)}</dd>
                    <dt>Solde de clôture</dt><dd>${detail.closingBalanceCents === null ? '—' : fmt.money(detail.closingBalanceCents)}</dd>
                    <dt>Lignes</dt><dd>${fmt.integer(detail.importedCount)} importées, ${fmt.integer(detail.duplicateCount)} doublons, ${fmt.integer(detail.rejectedCount)} rejetées</dd>
                    <dt>Empreinte</dt><dd class="mono small">${fmt.esc(detail.sha256 || '—')}</dd>
                  </div>
                  ${issues.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Ligne</th><th>Gravité</th><th>Message</th></tr></thead><tbody>${issues.map((i) => `<tr><td>${fmt.esc(i.rowNumber || '')}</td><td>${fmt.esc(i.severity)}</td><td>${fmt.esc(i.message)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="alert success">Aucune anomalie enregistrée.</div>'}
                </div>`,
                actions: [{ label: 'Fermer', className: 'btn-ghost' }],
              });
            } catch (err) {
              ui.showError(err);
            }
          });
        }
      }

      async function load() {
        if (activeTab === 'imports') await loadImports();
        else await loadLines();
      }

      for (const button of root.querySelectorAll('[data-tab]')) {
        button.addEventListener('click', () => {
          activeTab = button.dataset.tab;
          for (const other of root.querySelectorAll('[data-tab]')) other.classList.toggle('active', other === button);
          load().catch(ui.showError);
        });
      }
      root.querySelector('#r-apply').addEventListener('click', () => { page = 1; load().catch(ui.showError); });
      companySelect.addEventListener('change', async () => {
        await loadAccounts();
        page = 1;
        load().catch(ui.showError);
      });
      accountSelect.addEventListener('change', () => { page = 1; load().catch(ui.showError); });
      searchInput.addEventListener('input', ui.debounce(() => { page = 1; load().catch(ui.showError); }, 350));

      const importButton = root.querySelector('#import-statement');
      if (importButton) {
        importButton.addEventListener('click', () => {
          openImportWizard(accountSelect.value ? Number(accountSelect.value) : null, () => load().catch(ui.showError));
        });
      }
      const manualButton = root.querySelector('#manual-balance');
      if (manualButton) {
        manualButton.addEventListener('click', () => {
          if (!accountSelect.value) return ui.toast('Sélectionnez un compte bancaire.', 'error');
          openManualBalance(Number(accountSelect.value), () => load().catch(ui.showError));
        });
      }
      await loadAccounts();
      await load();
    },
  };
})();
