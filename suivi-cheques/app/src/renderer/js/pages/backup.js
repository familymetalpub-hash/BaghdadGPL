'use strict';

(function () {
  const Suivi = window.Suivi;
  const { api, fmt, ui, state } = Suivi;

  function can(permission) {
    return state.permissions.has(permission);
  }

  function kindsLabel(kind) {
    return { MANUAL: 'Manuelle', AUTO: 'Automatique', PRE_RESTORE: 'Avant restauration', PRE_MIGRATION: 'Avant migration' }[kind] || kind;
  }

  async function openRestore(row, reload) {
    const preview = await api.call('backups.previewRestore', { id: row.id });
    const content = `<div class="stack">
      <div class="alert ${preview.verified ? 'success' : 'danger'}">
        ${preview.verified ? 'Archive vérifiée : intégrité SQLite, comptages et références de documents.' : `Archive NON valide : ${fmt.esc((preview.issues || []).join(' ; '))}`}
      </div>
      ${preview.warning ? `<div class="alert warning">${fmt.esc(preview.warning)}</div>` : ''}
      <div class="grid two">
        <div class="card card-pad"><div class="kpi-label">Sauvegarde</div>
          <div class="detail-grid" style="margin-top:8px">
            <dt>Fichier</dt><dd>${fmt.esc(preview.filename)}</dd>
            <dt>Créée le</dt><dd>${fmt.dateTime(preview.createdAt)}</dd>
            <dt>Chèques</dt><dd>${fmt.integer((preview.backupCounts || {}).cheques || 0)}</dd>
            <dt>Transactions</dt><dd>${fmt.integer((preview.backupCounts || {}).transactions || 0)}</dd>
            <dt>Pièces jointes</dt><dd>${fmt.integer((preview.backupCounts || {}).attachments || 0)}</dd>
          </div>
        </div>
        <div class="card card-pad"><div class="kpi-label">Base actuelle</div>
          <div class="detail-grid" style="margin-top:8px">
            <dt>Chèques</dt><dd>${fmt.integer((preview.currentCounts || {}).cheques || 0)}</dd>
            <dt>Transactions</dt><dd>${fmt.integer((preview.currentCounts || {}).transactions || 0)}</dd>
            <dt>Pièces jointes</dt><dd>${fmt.integer((preview.currentCounts || {}).attachments || 0)}</dd>
            <dt>Total chèques</dt><dd>${fmt.money((preview.backupTotals || {}).chequeAmountCents || 0)}</dd>
          </div>
        </div>
      </div>
      <form id="restore-form" class="stack">
        <label>Phrase de confirmation<input name="confirmation" required placeholder="${fmt.esc(preview.confirmationPhrase || 'RESTAURER')}" autocomplete="off" /></label>
        <label>Votre mot de passe<input name="password" type="password" required autocomplete="current-password" /></label>
        <div class="alert danger">La base et les documents actuels seront remplacés. Une sauvegarde de sécurité est créée avant l’opération. Toutes les sessions seront fermées.</div>
        <div id="restore-error" class="form-error" hidden></div>
      </form>
    </div>`;
    ui.openModal({
      title: 'Restaurer une sauvegarde',
      content,
      wide: true,
      actions: [
        { label: 'Annuler', className: 'btn-ghost' },
        {
          label: 'Restaurer et vérifier',
          className: 'btn-danger',
          onClick: async (close, modal) => {
            const data = new FormData(modal.querySelector('#restore-form'));
            if (String(data.get('confirmation') || '') !== (preview.confirmationPhrase || 'RESTAURER')) {
              const box = modal.querySelector('#restore-error');
              box.textContent = `Saisissez exactement « ${preview.confirmationPhrase || 'RESTAURER'} ».`;
              box.hidden = false;
              return false;
            }
            try {
              const result = await api.call('backups.restore', {
                id: row.id,
                confirmation: String(data.get('confirmation')),
                password: String(data.get('password') || ''),
              });
              close();
              ui.toast(`Restauration vérifiée depuis ${result.restoredFrom}. Reconnexion nécessaire.`, 'success', 9000);
              setTimeout(() => {
                state.me = null;
                state.permissions = new Set();
                Suivi.app.forceLogin('Restauration terminée. Reconnectez-vous avec les comptes de la sauvegarde restaurée.');
              }, 400);
            } catch (err) {
              const box = modal.querySelector('#restore-error');
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

  Suivi.pages.backup = {
    title: 'Sauvegarde',
    subtitle: 'Copies vérifiées de la base et des documents — restauration contrôlée avec retour arrière',
    permissions: ['backup.manage', 'backup.restore'],
    async render(root) {
      if (!can('backup.manage')) {
        root.innerHTML = '<div class="alert warning">Votre profil peut restaurer mais pas lister les sauvegardes. Contactez l’administrateur.</div>';
        return;
      }
      root.innerHTML = `
        <div class="toolbar">
          <div id="backup-status" class="muted small"></div>
          <div class="row">
            ${can('backup.manage') ? '<button type="button" class="btn btn-primary" id="b-create">Créer une sauvegarde</button>' : ''}
          </div>
        </div>
        <div id="b-alert"></div>
        <div class="card" id="b-table"></div>`;
      const container = root.querySelector('#b-table');

      async function load() {
        ui.setLoading(container, 'Chargement des sauvegardes…');
        const [list, auto] = await Promise.all([api.call('backups.list'), api.call('backups.autoStatus')]);
        root.querySelector('#backup-status').textContent = auto.enabled
          ? `Sauvegarde automatique activée toutes les ${auto.intervalHours} h${auto.lastAuto ? ` · dernière le ${fmt.dateTime(auto.lastAuto.createdAt)}` : ' · aucune encore exécutée'}`
          : 'Sauvegarde automatique désactivée dans les paramètres.';
        root.querySelector('#b-alert').innerHTML =
          auto.enabled && !auto.lastAuto
            ? '<div class="alert warning" style="margin-bottom:14px">Aucune sauvegarde automatique n’a encore été enregistrée. Créez une sauvegarde manuelle vérifiée.</div>'
            : '';
        container.innerHTML = `
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Fichier</th><th>Type</th><th>Créée le</th><th class="right">Taille</th><th>Intégrité</th><th>Par</th><th></th></tr></thead>
              <tbody>
                ${list.length ? list.map((b) => `<tr>
                  <td><strong>${fmt.esc(b.filename)}</strong><div class="muted small mono">${fmt.esc((b.sha256 || '').slice(0, 18))}…</div></td>
                  <td><span class="chip">${fmt.esc(kindsLabel(b.kind))}</span></td>
                  <td>${fmt.dateTime(b.createdAt)}</td>
                  <td class="right">${fmt.integer(Math.round(b.sizeBytes / 1024 / 1024 * 10) / 10)} Mo</td>
                  <td>${b.verified ? '<span class="badge green">Vérifiée</span>' : '<span class="badge red">Non vérifiée</span>'}
                    <div class="muted small">${fmt.esc(b.verificationMessage || '')}</div></td>
                  <td>${fmt.esc(b.creatorName || 'Système')}</td>
                  <td class="actions">
                    ${can('backup.manage') ? `<button type="button" class="btn btn-ghost btn-small" data-verify="${b.id}">Vérifier</button>` : ''}
                    ${can('backup.restore') ? `<button type="button" class="btn btn-danger btn-small" data-restore="${b.id}">Restaurer</button>` : ''}
                  </td>
                </tr>`).join('') : `<tr><td colspan="7">${ui.emptyState('Aucune sauvegarde', 'Créez une sauvegarde pour protéger la base et les documents.')}</td></tr>`}
              </tbody>
            </table>
          </div>
          <div class="card-body"><p class="definition">Une sauvegarde n’est déclarée réussie que si le fichier a été écrit puis vérifié : intégrité SQLite, clés étrangères, comptages, totaux et empreintes des documents. Les archives corrompues ne sont jamais présentées comme valides.</p></div>`;
        const createButton = root.querySelector('#b-create');
        for (const button of container.querySelectorAll('[data-verify]')) {
          button.addEventListener('click', async () => {
            try {
              button.disabled = true;
              const result = await api.call('backups.verify', { id: Number(button.dataset.verify) });
              if (result.ok) ui.toast('Sauvegarde vérifiée avec succès.', 'success');
              else ui.toast(`Vérification échouée : ${(result.issues || []).join(' ; ')}`, 'error', 9000);
              await load();
            } catch (err) {
              ui.showError(err);
            } finally {
              button.disabled = false;
            }
          });
        }
        for (const button of container.querySelectorAll('[data-restore]')) {
          button.addEventListener('click', () => {
            const row = list.find((b) => b.id === Number(button.dataset.restore));
            openRestore(row, load).catch(ui.showError);
          });
        }
        if (createButton) createButton.disabled = false;
      }

      const create = root.querySelector('#b-create');
      if (create) {
        create.addEventListener('click', async () => {
          ui.openModal({
            title: 'Créer une sauvegarde vérifiée',
            content: `<div class="stack">
              <p>La base SQLite est copiée de façon cohérente, les documents sont ajoutés avec leurs empreintes, puis l’archive est immédiatement vérifiée.</p>
              <div class="alert info">L’opération peut prendre quelques secondes. Ne fermez pas l’application pendant ce temps.</div>
            </div>`,
            actions: [
              { label: 'Annuler', className: 'btn-ghost' },
              {
                label: 'Créer et vérifier',
                className: 'btn-primary',
                onClick: async (close) => {
                  try {
                    const result = await api.call('backups.create');
                    close();
                    ui.toast(`Sauvegarde créée et vérifiée : ${result.filename}`, 'success', 8000);
                    await load();
                  } catch (err) {
                    ui.showError(err);
                    return false;
                  }
                  return true;
                },
              },
            ],
          });
        });
      }
      await load();
    },
  };
})();
