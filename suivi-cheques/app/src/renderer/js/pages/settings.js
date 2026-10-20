'use strict';

(function () {
  const Suivi = window.Suivi;
  const { api, fmt, ui, state } = Suivi;

  const LABELS = {
    'app.name': 'Nom de l’application',
    'app.org_name': 'Nom du groupe / organisation',
    'app.locale': 'Langue de l’interface',
    'app.base_currency': 'Devise de base',
    'session.idle_timeout_minutes': 'Verrouillage après inactivité (minutes)',
    'session.absolute_timeout_minutes': 'Durée maximale d’une session (minutes)',
    'security.max_login_attempts': 'Tentatives de connexion avant verrouillage',
    'security.lock_minutes': 'Durée du verrouillage (minutes)',
    'password.min_length': 'Longueur minimale des mots de passe',
    'approval.high_value_enabled': 'Approbation des chèques à montant élevé',
    'approval.high_value_threshold_cents': 'Seuil de montant élevé (DA)',
    'approval.require_cancel_finalized': 'Approbation pour annulation d’un chèque finalisé',
    'approval.require_amount_change': 'Approbation pour modification de montant',
    'approval.require_association_change': 'Approbation pour changement de société/compte',
    'approval.require_reconciliation_finalize': 'Approbation pour finaliser un rapprochement',
    'approval.self_approval_allowed': 'Autoriser l’auto-approbation du DG (déconseillé)',
    'backup.auto_enabled': 'Sauvegarde automatique activée',
    'backup.auto_interval_hours': 'Intervalle de sauvegarde automatique (heures)',
    'backup.retention': 'Nombre de sauvegardes conservées',
    'reconciliation.auto_propose': 'Proposer automatiquement des rapprochements',
    'reconciliation.date_window_days': 'Fenêtre de dates pour les propositions (jours)',
    'cheque.presentation_deadline_days': 'Délai de présentation (jours)',
    'notifications.overdue_days': 'Délai d’alerte des échéances (jours)',
    'reports.header': 'En-tête des rapports',
    'migration.legacy_bank_default': 'Banque par défaut pour les données migrées',
  };

  const GENERAL_GROUPS = [
    { title: 'Identité', keys: ['app.name', 'app.org_name', 'app.locale', 'app.base_currency'] },
    { title: 'Sécurité et sessions', keys: ['session.idle_timeout_minutes', 'session.absolute_timeout_minutes', 'security.max_login_attempts', 'security.lock_minutes', 'password.min_length'] },
    { title: 'Sauvegardes', keys: ['backup.auto_enabled', 'backup.auto_interval_hours', 'backup.retention'] },
    { title: 'Rapprochement et alertes', keys: ['reconciliation.auto_propose', 'reconciliation.date_window_days', 'cheque.presentation_deadline_days', 'notifications.overdue_days'] },
    { title: 'Rapports et migration', keys: ['reports.header', 'migration.legacy_bank_default'] },
  ];

  const APPROVAL_GROUPS = [
    { title: 'Règles d’approbation', keys: ['approval.high_value_enabled', 'approval.high_value_threshold_cents', 'approval.require_cancel_finalized', 'approval.require_amount_change', 'approval.require_association_change', 'approval.require_reconciliation_finalize', 'approval.self_approval_allowed'] },
  ];

  function can(permission) {
    return state.permissions.has(permission);
  }

  function field(key, definition, value) {
    const label = LABELS[key] || key;
    if (definition.type === 'boolean') {
      return `<label class="checkline"><input type="checkbox" name="${key}" ${value ? 'checked' : ''} /> ${fmt.esc(label)}</label>`;
    }
    if (definition.type === 'enum') {
      return `<label>${fmt.esc(label)}<select name="${key}">${definition.values.map((v) => `<option value="${v}" ${String(value) === String(v) ? 'selected' : ''}>${fmt.esc(v)}</option>`).join('')}</select></label>`;
    }
    if (key === 'approval.high_value_threshold_cents') {
      return `<label>${fmt.esc(label)}<input name="${key}" type="number" min="1" step="0.01" value="${(Number(value) / 100).toFixed(2)}" /></label>`;
    }
    if (definition.type === 'number') {
      return `<label>${fmt.esc(label)}<input name="${key}" type="number" min="${definition.min}" max="${definition.max}" step="1" value="${fmt.esc(value)}" /></label>`;
    }
    return `<label>${fmt.esc(label)}<input name="${key}" maxlength="${definition.max || 255}" value="${fmt.esc(value)}" /></label>`;
  }

  function settingsForm(values, definitions, groups) {
    return `<form id="settings-form" class="stack">${groups
      .map(
        (group) => `<div class="card card-pad"><h3 style="margin-bottom:12px">${fmt.esc(group.title)}</h3>
          <div class="form-grid">${group.keys.filter((k) => definitions[k]).map((k) => field(k, definitions[k], values[k])).join('')}</div></div>`
      )
      .join('')}
      <div id="settings-error" class="form-error" hidden></div>
      <div class="row"><button type="submit" class="btn btn-primary">Enregistrer les paramètres</button><span class="muted small">Les modifications sont auditées et les règles d’approbation sont réservées au DG.</span></div>
    </form>`;
  }

  function readSettings(modal, definitions, initialValues) {
    const form = modal.querySelector('#settings-form');
    const data = new FormData(form);
    const changes = {};
    for (const key of Object.keys(definitions)) {
      if (!form.querySelector(`[name="${key}"]`)) continue;
      const def = definitions[key];
      let next;
      if (def.type === 'boolean') next = data.get(key) === 'on';
      else if (key === 'approval.high_value_threshold_cents') next = fmt.parseMoneyToCents(String(data.get(key) || ''));
      else if (def.type === 'number') next = Number(data.get(key));
      else next = String(data.get(key) || '');
      if (next === null && key === 'approval.high_value_threshold_cents') throw new Error('Seuil de montant invalide.');
      if (typeof next === 'number' && !Number.isFinite(next)) throw new Error(`Valeur invalide pour ${LABELS[key] || key}.`);
      if (initialValues[key] !== next) changes[key] = next;
    }
    return changes;
  }

  async function renderGeneral(root, container) {
    ui.setLoading(container, 'Chargement des paramètres…');
    const settings = await api.call('settings.get');
    const { values, definitions } = settings;
    container.innerHTML = settingsForm(values, definitions, GENERAL_GROUPS);
    const form = container.querySelector('#settings-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const box = form.querySelector('#settings-error');
      try {
        const changes = readSettings(container, definitions, values);
        if (!Object.keys(changes).length) return ui.toast('Aucune modification.', 'info');
        const updated = await api.call('settings.update', { changes, reason: 'Mise à jour depuis les paramètres généraux' });
        ui.toast('Paramètres enregistrés.', 'success');
        await renderGeneral(root, container);
        return updated;
      } catch (err) {
        box.textContent = err.message;
        box.hidden = false;
      }
    });
  }

  async function renderApprovals(root, container) {
    ui.setLoading(container, 'Chargement des règles d’approbation…');
    const settings = await api.call('settings.get');
    const { values, definitions } = settings;
    const filtered = {};
    for (const key of Object.keys(definitions)) if (key.startsWith('approval.')) filtered[key] = definitions[key];
    if (!Object.keys(filtered).length) {
      container.innerHTML = '<div class="alert warning">Les règles d’approbation sont réservées au Directeur Général.</div>';
      return;
    }
    container.innerHTML = settingsForm(values, filtered, APPROVAL_GROUPS);
    const form = container.querySelector('#settings-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const box = form.querySelector('#settings-error');
      try {
        const changes = readSettings(container, filtered, values);
        if (!Object.keys(changes).length) return ui.toast('Aucune modification.', 'info');
        await api.call('settings.update', { changes, reason: 'Modification des règles d’approbation' });
        ui.toast('Règles d’approbation enregistrées.', 'success');
        await renderApprovals(root, container);
      } catch (err) {
        box.textContent = err.message;
        box.hidden = false;
      }
    });
  }

  function randomPassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_+';
    const bytes = new Uint32Array(16);
    crypto.getRandomValues(bytes);
    let out = '';
    for (const byte of bytes) out += alphabet[byte % alphabet.length];
    return `${out.slice(0, 12)}7aZ!`;
  }

  async function renderUsers(container) {
    const companies = state.me.companies || [];
    let users = await api.call('users.list');
    container.innerHTML = `
      <div class="toolbar">
        <div class="muted">${users.length} compte(s) · l’administrateur ne peut pas gérer un compte DG</div>
        ${can('users.manage') ? '<button type="button" class="btn btn-primary" id="u-new">Nouvel utilisateur</button>' : ''}
      </div>
      <div class="card">
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>Nom</th><th>Identifiant</th><th>Rôle</th><th>Sociétés</th><th>Statut</th><th>Dernière connexion</th><th></th></tr></thead>
            <tbody>
              ${users.map((u) => `<tr>
                <td><strong>${fmt.esc(u.fullName)}</strong><div class="muted small">${fmt.esc(u.email || '')}</div></td>
                <td class="mono">${fmt.esc(u.username)}</td>
                <td>${fmt.esc(u.roleName)}</td>
                <td>${u.role === 'RESPONSABLE' ? (u.companies || []).map((id) => {
                  const c = companies.find((x) => x.id === id);
                  return c ? `<span class="chip">${fmt.esc(c.code)}</span>` : '';
                }).join(' ') : '<span class="muted">Toutes</span>'}</td>
                <td>${u.isActive ? '<span class="badge green">Actif</span>' : '<span class="badge gray">Inactif</span>'}
                  ${u.lockedUntil && new Date(u.lockedUntil) > new Date() ? '<div class="badge red" style="margin-top:4px">Verrouillé</div>' : ''}
                  ${u.mustChangePassword ? '<div class="muted small">Mot de passe à changer</div>' : ''}</td>
                <td>${u.lastLoginAt ? fmt.dateTime(u.lastLoginAt) : '—'}</td>
                <td class="actions">
                  ${can('users.manage') ? `<button type="button" class="btn btn-ghost btn-small" data-edit="${u.id}">Modifier</button>
                  <button type="button" class="btn btn-ghost btn-small" data-reset="${u.id}">Réinitialiser</button>
                  ${u.lockedUntil ? `<button type="button" class="btn btn-ghost btn-small" data-unlock="${u.id}">Déverrouiller</button>` : ''}` : ''}
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;

    const reload = async () => {
      users = await api.call('users.list');
      await renderUsers(container);
    };

    const newButton = container.querySelector('#u-new');
    if (newButton) {
      newButton.addEventListener('click', () => {
        ui.openModal({
          title: 'Nouvel utilisateur',
          content: `<form id="user-form" class="stack">
            <div class="form-grid">
              <label>Identifiant<input name="username" required minlength="3" maxlength="40" /></label>
              <label>Nom complet<input name="fullName" required maxlength="120" /></label>
              <label>E-mail<input name="email" type="email" maxlength="160" /></label>
              <label>Rôle<select name="role"><option value="RESPONSABLE">Responsable de Suivi</option><option value="ADMIN">Administrateur</option>${state.me.user.role === 'DG' ? '<option value="DG">Directeur Général</option>' : ''}</select></label>
            </div>
            <label>Sociétés affectées (Responsable de Suivi)<select name="companyIds" multiple size="5">${companies.map((c) => `<option value="${c.id}">${fmt.esc(c.code)} — ${fmt.esc(c.name)}</option>`).join('')}</select></label>
            <div class="form-grid">
              <label>Mot de passe provisoire<input name="password" required minlength="12" value="${fmt.esc(randomPassword())}" /></label>
              <label>&nbsp;<button type="button" class="btn btn-ghost" id="regen-password">Générer un autre mot de passe</button></label>
            </div>
            <div class="alert info">Le mot de passe provisoire devra être changé à la première connexion. Communiquez-le par un canal sûr.</div>
            <div id="user-error" class="form-error" hidden></div>
          </form>`,
          actions: [
            { label: 'Annuler', className: 'btn-ghost' },
            {
              label: 'Créer le compte',
              className: 'btn-primary',
              onClick: async (close, modal) => {
                const form = modal.querySelector('#user-form');
                const data = new FormData(form);
                const role = String(data.get('role'));
                const companyIds = Array.from(form.querySelector('select[name="companyIds"]').selectedOptions).map((o) => Number(o.value));
                try {
                  await api.call('users.create', {
                    username: String(data.get('username') || '').trim(),
                    fullName: String(data.get('fullName') || '').trim(),
                    email: String(data.get('email') || '').trim() || null,
                    role,
                    companyIds,
                    password: String(data.get('password') || ''),
                    mustChangePassword: true,
                  });
                  close();
                  ui.toast('Compte créé. Le mot de passe provisoire doit être changé à la première connexion.', 'success', 7000);
                  await reload();
                } catch (err) {
                  const box = modal.querySelector('#user-error');
                  box.textContent = err.message;
                  box.hidden = false;
                  return false;
                }
                return true;
              },
            },
          ],
          onMount: (modal) => {
            const regen = modal.querySelector('#regen-password');
            regen.addEventListener('click', () => {
              modal.querySelector('input[name="password"]').value = randomPassword();
            });
          },
        });
      });
    }

    for (const button of container.querySelectorAll('[data-edit]')) {
      button.addEventListener('click', () => {
        const user = users.find((u) => u.id === Number(button.dataset.edit));
        ui.openModal({
          title: `Modifier ${user.fullName}`,
          content: `<form id="user-edit-form" class="stack">
            <div class="form-grid">
              <label>Nom complet<input name="fullName" required maxlength="120" value="${fmt.esc(user.fullName)}" /></label>
              <label>E-mail<input name="email" type="email" maxlength="160" value="${fmt.esc(user.email || '')}" /></label>
              <label>Rôle<select name="role" ${state.me.user.role === 'ADMIN' && user.role === 'DG' ? 'disabled' : ''}>
                <option value="RESPONSABLE" ${user.role === 'RESPONSABLE' ? 'selected' : ''}>Responsable de Suivi</option>
                <option value="ADMIN" ${user.role === 'ADMIN' ? 'selected' : ''}>Administrateur</option>
                <option value="DG" ${user.role === 'DG' ? 'selected' : ''}>Directeur Général</option>
              </select></label>
              <label class="checkline" style="align-self:end"><input type="checkbox" name="isActive" ${user.isActive ? 'checked' : ''} ${user.id === state.me.user.id ? 'disabled' : ''} /> Compte actif</label>
            </div>
            <label>Sociétés affectées<select name="companyIds" multiple size="5">${companies.map((c) => `<option value="${c.id}" ${(user.companies || []).includes(c.id) ? 'selected' : ''}>${fmt.esc(c.code)} — ${fmt.esc(c.name)}</option>`).join('')}</select></label>
            <div id="user-edit-error" class="form-error" hidden></div>
          </form>`,
          actions: [
            { label: 'Annuler', className: 'btn-ghost' },
            {
              label: 'Enregistrer',
              className: 'btn-primary',
              onClick: async (close, modal) => {
                const form = modal.querySelector('#user-edit-form');
                const data = new FormData(form);
                const companyIds = Array.from(form.querySelector('select[name="companyIds"]').selectedOptions).map((o) => Number(o.value));
                try {
                  await api.call('users.update', {
                    id: user.id,
                    fullName: String(data.get('fullName') || '').trim(),
                    email: String(data.get('email') || '').trim() || null,
                    role: String(data.get('role')),
                    isActive: data.get('isActive') === 'on',
                    companyIds,
                  });
                  close();
                  ui.toast('Compte mis à jour.', 'success');
                  await reload();
                } catch (err) {
                  const box = modal.querySelector('#user-edit-error');
                  box.textContent = err.message;
                  box.hidden = false;
                  return false;
                }
                return true;
              },
            },
          ],
        });
      });
    }

    for (const button of container.querySelectorAll('[data-reset]')) {
      button.addEventListener('click', async () => {
        const user = users.find((u) => u.id === Number(button.dataset.reset));
        const ok = await ui.confirmDialog({
          title: 'Réinitialiser le mot de passe',
          message: `Un mot de passe provisoire sera généré pour ${user.fullName}. Toutes ses sessions seront fermées.`,
          confirmLabel: 'Réinitialiser',
          danger: true,
        });
        if (!ok) return;
        try {
          const result = await api.call('users.resetPassword', { id: user.id });
          ui.openModal({
            title: 'Mot de passe provisoire',
            content: `<div class="stack"><p>Communiquez ce mot de passe à ${fmt.esc(user.fullName)} par un canal sûr. Il devra être changé à la prochaine connexion.</p>
              <div class="alert info mono" style="font-size:16px">${fmt.esc(result.temporaryPassword)}</div></div>`,
            narrow: true,
            actions: [{ label: 'J’ai noté', className: 'btn-primary' }],
          });
          await reload();
        } catch (err) {
          ui.showError(err);
        }
      });
    }

    for (const button of container.querySelectorAll('[data-unlock]')) {
      button.addEventListener('click', async () => {
        try {
          await api.call('users.unlock', { id: Number(button.dataset.unlock) });
          ui.toast('Compte déverrouillé.', 'success');
          await reload();
        } catch (err) {
          ui.showError(err);
        }
      });
    }
  }

  async function renderMigration(container) {
    container.innerHTML = `
      <div class="stack">
        <div class="alert warning">
          <strong>Migration depuis l’ancienne application HTML.</strong> Sélectionnez le fichier JSON exporté par l’application d’origine.
          L’analyse est effectuée avant tout import ; rien n’est écrit tant que vous n’avez pas saisi « MIGRER ».
          Une copie horodatée et empreintée du fichier source est conservée. Aucune donnée de démonstration n’est importée sans confirmation explicite.
        </div>
        <div class="card card-pad">
          <h3>1. Analyser un fichier</h3>
          <p class="muted small">Les chèques réglés dans l’ancienne application sans date réelle seront importés « À régulariser » : ils restent visibles mais n’affectent pas la trésorerie avant correction. Aucune date de règlement n’est inventée.</p>
          <button type="button" class="btn btn-primary" id="mig-analyze">Choisir un fichier JSON et analyser</button>
          <div id="mig-analysis" style="margin-top:16px"></div>
        </div>
        <div class="card card-pad"><h3>2. Historique des migrations</h3><div id="mig-history" class="muted small">Chargement…</div></div>
      </div>`;
    const analyze = container.querySelector('#mig-analyze');
    const analysisBox = container.querySelector('#mig-analysis');
    const historyBox = container.querySelector('#mig-history');

    async function loadHistory() {
      try {
        const history = await api.call('migration.history');
        historyBox.innerHTML = history.length
          ? `<div class="stack">${history
              .map(
                (h) => `<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:8px 0">
                  <div><strong>${fmt.esc(h.sourceName)}</strong><div class="muted small">${fmt.dateTime(h.importedAt)} · SHA-256 ${fmt.esc((h.sourceSha256 || '').slice(0, 16))}…</div></div>
                  <span class="chip">Import #${h.id}</span>
                </div>`
              )
              .join('')}</div>`
          : '<span>Aucune migration enregistrée.</span>';
      } catch (err) {
        historyBox.textContent = err.message;
      }
    }

    analyze.addEventListener('click', async () => {
      try {
        const result = await api.call('migration.analyzeFile');
        if (!result || result.canceled) return;
        analysisBox.innerHTML = `
          <div class="stack">
            <div class="grid three">
              <div class="card card-pad"><div class="kpi-label">Sociétés</div><div class="kpi-value">${fmt.integer(result.summary.importedTotals.companyCount)}</div><div class="kpi-note">source : ${fmt.integer(result.summary.rawTotals.companyCount)}</div></div>
              <div class="card card-pad"><div class="kpi-label">Chèques importables</div><div class="kpi-value">${fmt.integer(result.summary.importedTotals.chequeCount)}</div><div class="kpi-note">source : ${fmt.integer(result.summary.rawTotals.chequeCount)}</div></div>
              <div class="card card-pad"><div class="kpi-label">Anomalies</div><div class="kpi-value ${result.errorCount ? 'danger-text' : ''}">${fmt.integer(result.errorCount)}</div><div class="kpi-note">${fmt.integer(result.warningCount)} avertissement(s)</div></div>
            </div>
            ${result.requiresDemoConfirmation ? `<div class="alert warning"><strong>Jeu de démonstration détecté.</strong> ${fmt.esc(result.summary.demo.reasons.join(', '))}. L’import exige une confirmation explicite.</div>` : ''}
            ${result.summary.balances.length ? `<div class="alert warning"><strong>Écarts de trésorerie attendus :</strong> ${result.summary.balances.length} compte(s) contiennent des chèques réglés sans date réelle. Ces montants ne seront pas comptabilisés avant régularisation.<div class="table-wrap" style="margin-top:8px"><table class="data"><thead><tr><th>Compte</th><th class="money">Ancien calcul</th><th class="money">Comptable importé</th><th class="money">Écart</th></tr></thead><tbody>${result.summary.balances.map((b) => `<tr><td>${fmt.esc(b.label)}</td><td class="money">${fmt.money(b.legacyComputedCents)}</td><td class="money">${fmt.money(b.importedBookCents)}</td><td class="money">${fmt.money(b.differenceCents)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
            ${result.issues.length ? `<div class="table-wrap" style="max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:8px"><table class="data"><thead><tr><th>Gravité</th><th>Code</th><th>Message</th></tr></thead><tbody>${result.issues.slice(0, 120).map((i) => `<tr><td>${fmt.esc(i.severity)}</td><td>${fmt.esc(i.code)}</td><td>${fmt.esc(i.message)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="alert success">Aucune anomalie de structure détectée.</div>'}
            <form id="mig-form" class="stack">
              ${result.errorCount ? '<label class="checkline"><input type="checkbox" name="skipInvalid" /> J’accepte d’exclure les enregistrements invalides listés ci-dessus (aucune fusion ni réécriture silencieuse)</label>' : ''}
              ${result.requiresDemoConfirmation ? '<label class="checkline"><input type="checkbox" name="allowDemoData" /> Je confirme que ce fichier est un jeu de démonstration et je souhaite l’importer</label>' : ''}
              <label>Saisissez « MIGRER » pour confirmer<input name="confirmation" required autocomplete="off" /></label>
              <div id="mig-error" class="form-error" hidden></div>
              <button type="submit" class="btn btn-danger" ${result.summary.alreadyImported ? 'disabled' : ''}>${result.summary.alreadyImported ? 'Source déjà importée' : 'Exécuter la migration contrôlée'}</button>
            </form>
          </div>`;
        const form = analysisBox.querySelector('#mig-form');
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const data = new FormData(form);
          const box = form.querySelector('#mig-error');
          try {
            const commit = await api.call('migration.commit', {
              token: result.token,
              confirmation: String(data.get('confirmation') || ''),
              skipInvalid: data.get('skipInvalid') === 'on',
              allowDemoData: data.get('allowDemoData') === 'on',
            });
            ui.openModal({
              title: 'Migration terminée et vérifiée',
              content: `<div class="stack">
                <div class="alert success">Import #${commit.importId} terminé. Comptages et totaux vérifiés dans la transaction.</div>
                <div class="detail-grid">
                  <dt>Copie source</dt><dd class="mono small">${fmt.esc(commit.sourcePreserved)}</dd>
                  <dt>Sociétés</dt><dd>${fmt.integer(commit.summary.imported.companies)}</dd>
                  <dt>Chèques</dt><dd>${fmt.integer(commit.summary.imported.cheques)}</dd>
                  <dt>Transactions</dt><dd>${fmt.integer(commit.summary.imported.transactions)} (+ ${fmt.integer(commit.summary.imported.transfers)} transfert(s))</dd>
                </div>
                <div class="alert warning">Les chèques « À régulariser » doivent être corrigés un par un avec leur date réelle. Ils n’ont aucun effet comptable tant que la régularisation n’est pas faite.</div>
              </div>`,
              actions: [{ label: 'Fermer', className: 'btn-primary' }],
            });
            analysisBox.innerHTML = '';
            await loadHistory();
          } catch (err) {
            box.textContent = err.message;
            box.hidden = false;
          }
        });
      } catch (err) {
        ui.showError(err);
      }
    });
    await loadHistory();
  }

  async function renderAbout(container) {
    const about = await api.call('app.about');
    container.innerHTML = `<div class="grid two">
      <div class="card card-pad">
        <h3>Application</h3>
        <div class="detail-grid" style="margin-top:12px">
          <dt>Version</dt><dd>${fmt.esc(about.version)}</dd>
          <dt>Electron</dt><dd>${fmt.esc(about.electron || '—')}</dd>
          <dt>Node.js</dt><dd>${fmt.esc(about.node)}</dd>
          <dt>Stockage</dt><dd>${fmt.esc(about.storage)}</dd>
        </div>
      </div>
      <div class="card card-pad">
        <h3>Limites explicites</h3>
        <ul class="muted small" style="line-height:1.8;padding-left:18px;margin:10px 0 0">
          <li>Les soldes comptables et prévisionnels ne sont pas des soldes bancaires garantis.</li>
          <li>Le rapprochement est confirmé par le Directeur Général ; aucun rapprochement automatique n’est finalisé sur le seul montant.</li>
          <li>Le fractionnement d’une ligne bancaire entre plusieurs chèques n’est pas pris en charge.</li>
          <li>Les données restent locales à ce poste ; la sauvegarde et la restauration sont sous la responsabilité de l’administrateur.</li>
          <li>La détection des doublons ne remplace pas un contrôle manuel du numéro et de la partie.</li>
        </ul>
      </div>
    </div>`;
  }

  Suivi.pages.settings = {
    title: 'Paramètres',
    subtitle: 'Configuration, comptes utilisateurs, règles d’approbation et migration des données héritées',
    permissions: ['settings.view', 'users.view'],
    async render(root, query) {
      const tabs = [];
      if (can('settings.view')) tabs.push({ code: 'general', label: 'Général' });
      if (can('approvals.configure')) tabs.push({ code: 'approvals', label: 'Approbations' });
      if (can('users.view')) tabs.push({ code: 'users', label: 'Utilisateurs' });
      if (can('migration.run')) tabs.push({ code: 'migration', label: 'Migration héritée' });
      tabs.push({ code: 'about', label: 'À propos' });
      const requested = query.tab;
      const active = tabs.some((t) => t.code === requested) ? requested : tabs[0].code;
      root.innerHTML = `<div class="tabs">${tabs.map((t) => `<button type="button" class="tab ${t.code === active ? 'active' : ''}" data-setting-tab="${t.code}">${t.label}</button>`).join('')}</div><div id="settings-content"></div>`;
      const container = root.querySelector('#settings-content');
      const renderTab = async (code) => {
        for (const button of root.querySelectorAll('[data-setting-tab]')) button.classList.toggle('active', button.dataset.settingTab === code);
        const url = new URL(window.location.href);
        url.hash = `#/settings?tab=${code}`;
        window.history.replaceState(null, '', url);
        if (code === 'general') await renderGeneral(root, container);
        else if (code === 'approvals') await renderApprovals(root, container);
        else if (code === 'users') await renderUsers(container);
        else if (code === 'migration') await renderMigration(container);
        else await renderAbout(container);
      };
      for (const button of root.querySelectorAll('[data-setting-tab]')) {
        button.addEventListener('click', () => renderTab(button.dataset.settingTab).catch(ui.showError));
      }
      await renderTab(active);
    },
  };
})();
