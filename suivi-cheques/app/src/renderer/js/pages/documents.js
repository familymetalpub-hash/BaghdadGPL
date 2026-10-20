'use strict';

(function () {
  const Suivi = window.Suivi;
  const { api, fmt, ui, state } = Suivi;

  function can(permission) {
    return state.permissions.has(permission);
  }

  async function openAddDocument(reload) {
    const companies = state.me.companies || [];
    ui.openModal({
      title: 'Ajouter un document justificatif',
      content: `<form id="doc-form" class="stack">
        <div class="form-grid">
          <label>Société<select name="companyId" required>${ui.companyOptions(companies, '', 'Sélectionner…')}</select></label>
          <label>Type d’élément<select name="entityType">
            <option value="CHEQUE">Chèque</option><option value="COMPTE">Compte bancaire</option>
            <option value="SOCIETE">Société</option><option value="TRANSACTION">Transaction</option>
            <option value="RAPPROCHEMENT">Rapprochement</option><option value="IMPORT">Import bancaire</option>
          </select></label>
          <label>Identifiant de l’élément<input name="entityId" required inputmode="numeric" placeholder="Ex. 12" /></label>
          <label>Motif (facultatif)<input name="reason" maxlength="300" /></label>
        </div>
        <div class="alert info">Formats acceptés : PDF, PNG, JPG, XLSX, CSV, TXT. Taille maximale : 20 Mo. Le fichier est copié dans le dossier de documents de l’application ; aucun chemin système n’est exposé à l’interface.</div>
        <div id="doc-error" class="form-error" hidden></div>
      </form>`,
      actions: [
        { label: 'Annuler', className: 'btn-ghost' },
        {
          label: 'Choisir un fichier et ajouter',
          className: 'btn-primary',
          onClick: async (close, modal) => {
            const data = new FormData(modal.querySelector('#doc-form'));
            const payload = {
              companyId: Number(data.get('companyId')),
              entityType: String(data.get('entityType')),
              entityId: Number(data.get('entityId')),
              reason: String(data.get('reason') || '').trim() || undefined,
            };
            if (!payload.companyId || !payload.entityId) {
              const box = modal.querySelector('#doc-error');
              box.textContent = 'Société et identifiant de l’élément sont obligatoires.';
              box.hidden = false;
              return false;
            }
            try {
              const result = await api.call('documents.add', payload);
              if (result.canceled) return false;
              close();
              ui.toast('Document ajouté et empreinte SHA-256 enregistrée.', 'success');
              await reload();
            } catch (err) {
              const box = modal.querySelector('#doc-error');
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

  Suivi.pages.documents = {
    title: 'Documents',
    subtitle: 'Pièces justificatives stockées hors base, avec empreinte d’intégrité et journal d’audit',
    permissions: ['documents.view'],
    async render(root) {
      const companies = state.me.companies || [];
      root.innerHTML = `
        <div class="filters">
          <label>Société<select id="d-company">${ui.companyOptions(companies, '', 'Toutes les sociétés')}</select></label>
          <label>Type d’élément<select id="d-entity">
            <option value="">Tous</option><option value="CHEQUE">Chèque</option><option value="COMPTE">Compte</option>
            <option value="SOCIETE">Société</option><option value="TRANSACTION">Transaction</option>
            <option value="RAPPROCHEMENT">Rapprochement</option><option value="IMPORT">Import</option>
          </select></label>
          <label>Identifiant<input id="d-id" inputmode="numeric" placeholder="Ex. 12" /></label>
          <button type="button" class="btn btn-primary" id="d-filter">Filtrer</button>
        </div>
        <div class="toolbar">
          <div class="muted small">Les documents supprimés sont conservés avec une date de suppression (pas d’effacement silencieux).</div>
          ${can('documents.manage') ? '<button type="button" class="btn btn-primary" id="d-add">Ajouter un document</button>' : ''}
        </div>
        <div class="card" id="d-table"></div>`;
      const container = root.querySelector('#d-table');
      const companySelect = root.querySelector('#d-company');
      const entitySelect = root.querySelector('#d-entity');
      const idInput = root.querySelector('#d-id');

      async function load() {
        ui.setLoading(container, 'Chargement des documents…');
        const params = {};
        if (companySelect.value) params.companyId = Number(companySelect.value);
        if (entitySelect.value) params.entityType = entitySelect.value;
        if (idInput.value.trim()) params.entityId = idInput.value.trim();
        const list = await api.call('documents.list', params);
        container.innerHTML = `
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Fichier</th><th>Société</th><th>Élément</th><th class="right">Taille</th><th>Ajouté par</th><th>Date</th><th></th></tr></thead>
              <tbody>
                ${list.length ? list.map((d) => `<tr>
                  <td><strong>${fmt.esc(d.originalName)}</strong><div class="muted small mono">${fmt.esc((d.sha256 || '').slice(0, 16))}…</div></td>
                  <td>${fmt.esc(d.companyName)}</td>
                  <td>${fmt.esc(d.entityType)} #${fmt.esc(d.entityId)}</td>
                  <td class="right">${fmt.integer(Math.max(1, Math.round(d.sizeBytes / 1024)))} Ko</td>
                  <td>${fmt.esc(d.uploaderName || '—')}</td>
                  <td>${fmt.dateTime(d.createdAt)}</td>
                  <td class="actions">
                    <button type="button" class="btn btn-ghost btn-small" data-open="${d.id}">Ouvrir</button>
                    <button type="button" class="btn btn-ghost btn-small" data-save="${d.id}">Enregistrer sous</button>
                    ${can('documents.manage') ? `<button type="button" class="btn btn-ghost btn-small danger-text" data-delete="${d.id}">Retirer</button>` : ''}
                  </td>
                </tr>`).join('') : `<tr><td colspan="7">${ui.emptyState('Aucun document', 'Ajoutez une pièce justificative à un chèque ou à un compte.')}</td></tr>`}
              </tbody>
            </table>
          </div>`;
        for (const button of container.querySelectorAll('[data-open]')) {
          button.addEventListener('click', async () => {
            try {
              await api.call('documents.open', { id: Number(button.dataset.open) });
            } catch (err) {
              ui.showError(err);
            }
          });
        }
        for (const button of container.querySelectorAll('[data-save]')) {
          button.addEventListener('click', async () => {
            try {
              const result = await api.call('documents.saveAs', { id: Number(button.dataset.save) });
              if (!result.canceled) ui.toast(`Document copié : ${result.path}`, 'success', 6000);
            } catch (err) {
              ui.showError(err);
            }
          });
        }
        for (const button of container.querySelectorAll('[data-delete]')) {
          button.addEventListener('click', async () => {
            const reason = await ui.promptDialog({
              title: 'Retirer le document',
              label: 'Motif du retrait (3 caractères minimum)',
              required: true,
            });
            if (!reason) return;
            try {
              await api.call('documents.delete', { id: Number(button.dataset.delete), reason });
              ui.toast('Document retiré (suppression logique tracée).', 'success');
              await load();
            } catch (err) {
              ui.showError(err);
            }
          });
        }
      }

      const add = root.querySelector('#d-add');
      if (add) add.addEventListener('click', () => openAddDocument(load));
      root.querySelector('#d-filter').addEventListener('click', () => load().catch(ui.showError));
      entitySelect.addEventListener('change', () => load().catch(ui.showError));
      companySelect.addEventListener('change', () => load().catch(ui.showError));
      await load();
    },
  };
})();
