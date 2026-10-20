'use strict';

(function () {
  const Suivi = window.Suivi;
  const { api, fmt, ui, state } = Suivi;

  function can(permission) {
    return state.permissions.has(permission);
  }

  function companyForm(company = null) {
    return `<form id="company-form" class="stack">
      <div class="form-grid">
        <label>Code société<input name="code" required maxlength="20" value="${fmt.esc(company ? company.code : '')}" ${company ? 'readonly' : ''} /></label>
        <label>Raison sociale<input name="name" required maxlength="160" value="${fmt.esc(company ? company.name : '')}" /></label>
        <label>Forme juridique<input name="legalForm" maxlength="40" value="${fmt.esc(company && company.legalForm ? company.legalForm : '')}" /></label>
        <label>NIF<input name="nif" maxlength="40" value="${fmt.esc(company && company.nif ? company.nif : '')}" /></label>
        <label>NIS<input name="nis" maxlength="40" value="${fmt.esc(company && company.nis ? company.nis : '')}" /></label>
        <label>Registre de commerce<input name="rc" maxlength="60" value="${fmt.esc(company && company.rc ? company.rc : '')}" /></label>
        <label>Article d’imposition<input name="ai" maxlength="60" value="${fmt.esc(company && company.ai ? company.ai : '')}" /></label>
        <label>Gérant<input name="managerName" maxlength="120" value="${fmt.esc(company && company.managerName ? company.managerName : '')}" /></label>
        <label>Capital (DA)<input name="capital" type="number" min="0" step="0.01" value="${company && company.capitalCents ? (company.capitalCents / 100).toFixed(2) : ''}" /></label>
        <label>Wilaya<input name="wilaya" maxlength="80" value="${fmt.esc(company && company.wilaya ? company.wilaya : '')}" /></label>
        <label>Téléphone<input name="phone" maxlength="40" value="${fmt.esc(company && company.phone ? company.phone : '')}" /></label>
        <label>E-mail<input name="email" type="email" maxlength="160" value="${fmt.esc(company && company.email ? company.email : '')}" /></label>
        <label class="full">Adresse<input name="address" maxlength="300" value="${fmt.esc(company && company.address ? company.address : '')}" /></label>
        <label>Couleur<input name="color" type="color" value="${fmt.esc(company && company.color ? company.color : '#0f766e')}" /></label>
      </div>
      <div id="company-form-error" class="form-error" hidden></div>
    </form>`;
  }

  function readCompanyForm(modal) {
    const data = new FormData(modal.querySelector('#company-form'));
    const capital = String(data.get('capital') || '').trim();
    return {
      code: String(data.get('code') || '').trim().toUpperCase(),
      name: String(data.get('name') || '').trim(),
      legalForm: String(data.get('legalForm') || '').trim() || null,
      nif: String(data.get('nif') || '').trim() || null,
      nis: String(data.get('nis') || '').trim() || null,
      rc: String(data.get('rc') || '').trim() || null,
      ai: String(data.get('ai') || '').trim() || null,
      managerName: String(data.get('managerName') || '').trim() || null,
      capitalCents: capital ? fmt.parseMoneyToCents(capital) : 0,
      address: String(data.get('address') || '').trim() || null,
      wilaya: String(data.get('wilaya') || '').trim() || null,
      phone: String(data.get('phone') || '').trim() || null,
      email: String(data.get('email') || '').trim() || null,
      color: String(data.get('color') || '#0f766e'),
    };
  }

  function openCompanyModal(company, reload) {
    const editing = Boolean(company);
    ui.openModal({
      title: editing ? `Modifier ${company.name}` : 'Nouvelle société',
      content: companyForm(company),
      wide: true,
      actions: [
        { label: 'Annuler', className: 'btn-ghost' },
        {
          label: editing ? 'Enregistrer' : 'Créer la société',
          className: 'btn-primary',
          onClick: async (close, modal) => {
            const payload = readCompanyForm(modal);
            if (!payload.code || !payload.name) {
              const box = modal.querySelector('#company-form-error');
              box.textContent = 'Le code et la raison sociale sont obligatoires.';
              box.hidden = false;
              return false;
            }
            if (payload.capitalCents === null) {
              const box = modal.querySelector('#company-form-error');
              box.textContent = 'Le capital est invalide.';
              box.hidden = false;
              return false;
            }
            if (editing) await api.call('companies.update', { id: company.id, ...payload });
            else await api.call('companies.create', payload);
            close();
            ui.toast(editing ? 'Société mise à jour.' : 'Société créée.', 'success');
            await reload();
            return true;
          },
        },
      ],
    });
  }

  function bankForm(bank = null) {
    return `<form id="bank-form" class="stack">
      <div class="form-grid">
        <label>Nom de la banque<input name="name" required maxlength="120" value="${fmt.esc(bank ? bank.name : '')}" /></label>
        <label>Nom court<input name="shortName" maxlength="60" value="${fmt.esc(bank && bank.shortName ? bank.shortName : '')}" /></label>
      </div>
      ${bank ? `<label class="checkline"><input type="checkbox" name="isActive" ${bank.isActive ? 'checked' : ''} /> Banque active</label>` : ''}
    </form>`;
  }

  function openBankModal(bank, reload) {
    ui.openModal({
      title: bank ? `Modifier ${bank.name}` : 'Nouvelle banque',
      content: bankForm(bank),
      actions: [
        { label: 'Annuler', className: 'btn-ghost' },
        {
          label: bank ? 'Enregistrer' : 'Créer la banque',
          className: 'btn-primary',
          onClick: async (close, modal) => {
            const data = new FormData(modal.querySelector('#bank-form'));
            const payload = {
              name: String(data.get('name') || '').trim(),
              shortName: String(data.get('shortName') || '').trim() || null,
            };
            if (!payload.name) throw new Error('Le nom de la banque est obligatoire.');
            if (bank) {
              payload.id = bank.id;
              payload.isActive = data.get('isActive') === 'on';
              await api.call('banks.update', payload);
            } else {
              await api.call('banks.create', payload);
            }
            close();
            ui.toast(bank ? 'Banque mise à jour.' : 'Banque créée.', 'success');
            await reload();
          },
        },
      ],
    });
  }

  function accountForm(account, banks, companies) {
    const editing = Boolean(account);
    return `<form id="account-form" class="stack">
      <div class="form-grid">
        <label>Société<select name="companyId" required ${editing ? 'disabled' : ''}>${ui.companyOptions(companies, account ? account.companyId : '', 'Sélectionner…')}</select></label>
        <label>Banque<select name="bankId" required ${editing ? 'disabled' : ''}>${ui.options(banks.filter((b) => b.isActive), account ? account.bankId : '', { labelKey: (b) => b.name, includeEmpty: 'Sélectionner…' })}</select></label>
        <label>Libellé du compte<input name="label" required maxlength="120" value="${fmt.esc(account ? account.label : '')}" /></label>
        <label>Numéro de compte<input name="accountNumber" required maxlength="60" value="${fmt.esc(account ? account.accountNumber || '' : '')}" ${editing ? 'readonly' : ''} /></label>
        <label>RIB<input name="rib" maxlength="60" value="${fmt.esc(account && account.rib ? account.rib : '')}" /></label>
        <label>Solde d’ouverture (DA)<input name="openingBalance" type="number" step="0.01" value="${account ? (account.openingBalanceCents / 100).toFixed(2) : '0.00'}" ${editing ? 'disabled' : ''} /></label>
        <label>Date d’ouverture<input name="openingDate" type="date" required max="${fmt.todayISO()}" value="${fmt.esc(account ? account.openingDate : fmt.todayISO())}" ${editing ? 'disabled' : ''} /></label>
        ${editing ? `<label class="checkline" style="align-self:end"><input type="checkbox" name="isActive" ${account.isActive ? 'checked' : ''} /> Compte actif</label>` : ''}
      </div>
      ${!editing ? '<p class="definition">Le solde d’ouverture et sa date sont figés dès qu’une opération existe. Ils servent de base au solde comptable et ne représentent pas nécessairement le solde bancaire réel.</p>' : ''}
      <div id="account-form-error" class="form-error" hidden></div>
    </form>`;
  }

  function openAccountModal(account, banks, companies, reload) {
    ui.openModal({
      title: account ? `Modifier ${account.label}` : 'Nouveau compte bancaire',
      content: accountForm(account, banks, companies),
      wide: true,
      actions: [
        { label: 'Annuler', className: 'btn-ghost' },
        {
          label: account ? 'Enregistrer' : 'Créer le compte',
          className: 'btn-primary',
          onClick: async (close, modal) => {
            const data = new FormData(modal.querySelector('#account-form'));
            const box = modal.querySelector('#account-form-error');
            const payload = {
              companyId: Number(data.get('companyId')),
              bankId: Number(data.get('bankId')),
              label: String(data.get('label') || '').trim(),
              accountNumber: String(data.get('accountNumber') || '').trim(),
              rib: String(data.get('rib') || '').trim() || null,
            };
            if (!payload.companyId || !payload.bankId || !payload.label || !payload.accountNumber) {
              box.textContent = 'Société, banque, libellé et numéro de compte sont obligatoires.';
              box.hidden = false;
              return false;
            }
            if (account) {
              payload.id = account.id;
              payload.isActive = data.get('isActive') === 'on';
              await api.call('accounts.update', payload);
            } else {
              const opening = fmt.parseMoneyToCents(String(data.get('openingBalance') || '0'));
              if (opening === null) {
                box.textContent = 'Le solde d’ouverture est invalide.';
                box.hidden = false;
                return false;
              }
              payload.openingBalanceCents = opening;
              payload.openingDate = String(data.get('openingDate') || '');
              await api.call('accounts.create', payload);
            }
            close();
            ui.toast(account ? 'Compte mis à jour.' : 'Compte créé.', 'success');
            await reload();
          },
        },
      ],
    });
  }

  function renderCompanies(root) {
    const container = root.querySelector('#tab-content');
    const companies = state.me.companies || [];
    const [rows, all] = [null, null];
    void rows; void all;
    return api.call('companies.list', { includeInactive: true }).then((list) => {
      container.innerHTML = `
        <div class="toolbar">
          <div class="muted">${list.length} société(s) enregistrée(s)</div>
          ${can('companies.manage') ? '<button type="button" class="btn btn-primary" id="new-company">Nouvelle société</button>' : ''}
        </div>
        <div class="card">
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Code</th><th>Raison sociale</th><th>NIF</th><th>Gérant</th><th class="right">Comptes</th><th class="right">Chèques</th><th>Statut</th><th></th></tr></thead>
              <tbody>
                ${list.length ? list.map((c) => `<tr>
                  <td><span class="badge" style="background:${fmt.esc(c.color)}22;color:${fmt.esc(c.color)}">${fmt.esc(c.code)}</span></td>
                  <td><strong>${fmt.esc(c.name)}</strong><div class="muted small">${fmt.esc(c.legalForm || '')}</div></td>
                  <td>${fmt.esc(c.nif || '—')}</td>
                  <td>${fmt.esc(c.managerName || '—')}</td>
                  <td class="right">${fmt.integer(c.accountCount || 0)}</td>
                  <td class="right">${fmt.integer(c.chequeCount || 0)}</td>
                  <td>${c.isActive ? '<span class="badge green">Active</span>' : '<span class="badge gray">Inactive</span>'}</td>
                  <td class="actions">${can('companies.manage') ? `<button type="button" class="btn btn-ghost btn-small" data-edit="${c.id}">Modifier</button>` : ''}</td>
                </tr>`).join('') : `<tr><td colspan="8">${ui.emptyState('Aucune société', 'Créez une société pour commencer.')}</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>`;
      const reload = () => renderCompanies(root);
      const newButton = container.querySelector('#new-company');
      if (newButton) newButton.addEventListener('click', () => openCompanyModal(null, reload));
      for (const button of container.querySelectorAll('[data-edit]')) {
        button.addEventListener('click', () => {
          const company = list.find((c) => c.id === Number(button.dataset.edit));
          openCompanyModal(company, reload);
        });
      }
      if (companies.length === 0 && list.length) {
        container.insertAdjacentHTML('afterbegin', '<div class="alert info">Votre profil n’est affecté à aucune société. Contactez l’administrateur.</div>');
      }
    });
  }

  function renderBanks(root) {
    const container = root.querySelector('#tab-content');
    return api.call('banks.list').then((banks) => {
      container.innerHTML = `
        <div class="toolbar">
          <div class="muted">${banks.length} banque(s)</div>
          ${can('banks.manage') ? '<button type="button" class="btn btn-primary" id="new-bank">Nouvelle banque</button>' : ''}
        </div>
        <div class="card">
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Banque</th><th>Nom court</th><th class="right">Comptes</th><th>Statut</th><th></th></tr></thead>
              <tbody>
                ${banks.length ? banks.map((b) => `<tr>
                  <td><strong>${fmt.esc(b.name)}</strong></td>
                  <td>${fmt.esc(b.shortName || '—')}</td>
                  <td class="right">${fmt.integer(b.accountCount || 0)}</td>
                  <td>${b.isActive ? '<span class="badge green">Active</span>' : '<span class="badge gray">Inactive</span>'}</td>
                  <td class="actions">${can('banks.manage') ? `<button type="button" class="btn btn-ghost btn-small" data-edit="${b.id}">Modifier</button>` : ''}</td>
                </tr>`).join('') : `<tr><td colspan="5">${ui.emptyState('Aucune banque')}</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>`;
      const reload = () => renderBanks(root);
      const newButton = container.querySelector('#new-bank');
      if (newButton) newButton.addEventListener('click', () => openBankModal(null, reload));
      for (const button of container.querySelectorAll('[data-edit]')) {
        button.addEventListener('click', () => openBankModal(banks.find((b) => b.id === Number(button.dataset.edit)), reload));
      }
    });
  }

  function renderAccounts(root) {
    const container = root.querySelector('#tab-content');
    const companies = state.me.companies || [];
    return Promise.all([api.call('banks.list'), api.call('accounts.list', { includeInactive: true })]).then(([banks, accounts]) => {
      container.innerHTML = `
        <div class="toolbar">
          <div class="muted">${accounts.length} compte(s) bancaire(s) · les numéros complets sont réservés aux profils habilités</div>
          ${can('accounts.manage') ? '<button type="button" class="btn btn-primary" id="new-account">Nouveau compte</button>' : ''}
        </div>
        <div class="card">
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Société</th><th>Banque</th><th>Compte</th><th>Numéro</th><th>Ouverture</th><th class="money">Solde d’ouverture</th><th>Statut</th><th></th></tr></thead>
              <tbody>
                ${accounts.length ? accounts.map((a) => `<tr>
                  <td>${fmt.esc(a.companyName || a.companyCode || '')}</td>
                  <td>${fmt.esc(a.bankName || '')}</td>
                  <td><strong>${fmt.esc(a.label)}</strong><div class="muted small">${fmt.esc(a.currency)}</div></td>
                  <td class="mono">${fmt.esc(a.accountNumberMasked || a.accountNumber || '••••')}</td>
                  <td>${fmt.date(a.openingDate)}</td>
                  <td class="money">${fmt.money(a.openingBalanceCents)}</td>
                  <td>${a.isActive ? '<span class="badge green">Actif</span>' : '<span class="badge gray">Inactif</span>'}</td>
                  <td class="actions">${can('accounts.manage') ? `<button type="button" class="btn btn-ghost btn-small" data-edit="${a.id}">Modifier</button>` : ''}</td>
                </tr>`).join('') : `<tr><td colspan="8">${ui.emptyState('Aucun compte bancaire', 'Créez une banque puis un compte rattaché à une société.')}</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
        <p class="definition" style="margin-top:12px">Un compte appartient à une seule société. Le solde d’ouverture est une donnée comptable interne : il ne remplace pas un relevé bancaire importé.</p>`;
      const reload = () => renderAccounts(root);
      const newButton = container.querySelector('#new-account');
      if (newButton) {
        newButton.addEventListener('click', () => {
          if (!banks.filter((b) => b.isActive).length) return ui.toast('Créez d’abord une banque active.', 'error');
          openAccountModal(null, banks, companies, reload);
        });
      }
      for (const button of container.querySelectorAll('[data-edit]')) {
        const account = accounts.find((a) => a.id === Number(button.dataset.edit));
        button.addEventListener('click', () => openAccountModal(account, banks, companies, reload));
      }
    });
  }

  Suivi.pages.companies = {
    title: 'Sociétés',
    subtitle: 'Référentiel des sociétés et périmètres d’affectation',
    permissions: ['companies.view'],
    async render(root, query) {
      const tabs = [
        { code: 'companies', label: 'Sociétés' },
        { code: 'banks', label: 'Banques' },
        { code: 'accounts', label: 'Comptes bancaires' },
      ];
      const active = tabs.some((t) => t.code === query.tab) ? query.tab : 'companies';
      root.innerHTML = `<div class="tabs">${tabs
        .map((t) => `<button type="button" class="tab ${t.code === active ? 'active' : ''}" data-tab="${t.code}">${t.label}</button>`)
        .join('')}</div><div id="tab-content"></div>`;
      const renderTab = (code) => {
        for (const button of root.querySelectorAll('[data-tab]')) button.classList.toggle('active', button.dataset.tab === code);
        const container = root.querySelector('#tab-content');
        if (code === 'companies') return renderCompanies(root);
        if (code === 'banks') return renderBanks(root);
        return renderAccounts(root);
      };
      for (const button of root.querySelectorAll('[data-tab]')) {
        button.addEventListener('click', () => {
          const code = button.dataset.tab;
          const url = new URL(window.location.href);
          url.hash = `#/companies?tab=${code}`;
          window.history.replaceState(null, '', url);
          renderTab(code).catch(ui.showError);
        });
      }
      await renderTab(active);
    },
  };
})();
