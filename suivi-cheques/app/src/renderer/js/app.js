'use strict';

(function () {
  const Suivi = window.Suivi;
  const { api, fmt, ui, state } = Suivi;

  const NAV_ITEMS = [
    { page: 'dashboard', label: 'Tableau de bord', icon: '◫', permissions: ['dashboard.view'] },
    { page: 'companies', label: 'Sociétés', icon: '▦', permissions: ['companies.view'] },
    { page: 'accounts', label: 'Banques & comptes', icon: '▤', permissions: ['accounts.view'] },
    { page: 'cheques', label: 'Chèques', icon: '◧', permissions: ['cheques.view'] },
    { page: 'approvals', label: 'Approbations', icon: '✓', permissions: ['approvals.request', 'approvals.decide'] },
    { page: 'reconciliation', label: 'Rapprochement', icon: '⇄', permissions: ['reconciliation.view'] },
    { page: 'reports', label: 'Rapports', icon: '▥', permissions: ['reports.view'] },
    { page: 'audit', label: 'Audit', icon: '◉', permissions: ['audit.view'] },
    { page: 'documents', label: 'Documents', icon: '▣', permissions: ['documents.view'] },
    { page: 'backup', label: 'Sauvegarde', icon: '⛁', permissions: ['backup.manage', 'backup.restore'] },
    { page: 'settings', label: 'Paramètres', icon: '⚙', permissions: ['settings.view', 'users.view'] },
  ];

  let idleTimer = null;
  let lastActivity = Date.now();
  let currentCleanup = null;

  function hasAny(permissions) {
    return permissions.some((p) => state.permissions.has(p));
  }

  function showAuth() {
    document.getElementById('auth-view').hidden = false;
    document.getElementById('shell').hidden = true;
    document.getElementById('page').innerHTML = '';
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
  }

  function showShell() {
    document.getElementById('auth-view').hidden = true;
    document.getElementById('shell').hidden = false;
  }

  function setAuthError(id, message) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }

  function resetAuthForms() {
    for (const id of ['login-form', 'setup-form', 'password-form']) {
      const form = document.getElementById(id);
      if (form) form.reset();
    }
    setAuthError('login-error', '');
    setAuthError('setup-error', '');
    setAuthError('password-error', '');
  }

  async function boot() {
    try {
      const info = await api.call('app.bootstrap');
      state.bootstrap = info;
      document.getElementById('org-name').textContent = info.orgName || 'Groupe';
      document.getElementById('auth-version').textContent = `Version ${info.version} · ${info.baseCurrency || 'DZD'} · Données locales`;
      document.getElementById('boot').hidden = true;
      if (info.needsSetup) {
        document.getElementById('login-panel').hidden = true;
        document.getElementById('setup-panel').hidden = false;
        document.getElementById('password-panel').hidden = true;
        document.getElementById('auth-view').hidden = false;
        document.querySelector('#setup-form input[name="orgName"]').value = info.orgName || 'Groupe';
      } else {
        const session = await api.call('auth.me');
        if (session && session.authenticated) {
          await enterApp(session);
        } else {
          showLogin();
        }
      }
    } catch (err) {
      document.getElementById('boot').innerHTML = `<div class="alert danger">Impossible de démarrer : ${fmt.esc(err.message)}</div>`;
    }
  }

  function showLogin(message = '') {
    document.getElementById('login-panel').hidden = false;
    document.getElementById('setup-panel').hidden = true;
    document.getElementById('password-panel').hidden = true;
    document.getElementById('auth-view').hidden = false;
    setAuthError('login-error', message);
    setTimeout(() => {
      const input = document.querySelector('#login-form input[name="username"]');
      if (input) input.focus();
    }, 50);
  }

  async function enterApp(me) {
    state.me = me;
    state.permissions = new Set(me.permissions || []);
    if (me.mustChangePassword) {
      showPasswordChange();
      return;
    }
    showShell();
    document.getElementById('org-name').textContent = state.bootstrap.orgName || 'Groupe';
    document.getElementById('user-name').textContent = me.user.fullName;
    document.getElementById('user-role').textContent = me.user.roleName;
    const initials = String(me.user.fullName)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase();
    document.getElementById('user-initials').textContent = initials || '?';
    buildNav();
    startIdleWatch();
    loadNotifications();
    const hash = window.location.hash || '#/dashboard';
    await route(hash);
  }

  function showPasswordChange() {
    document.getElementById('auth-view').hidden = false;
    document.getElementById('login-panel').hidden = true;
    document.getElementById('setup-panel').hidden = true;
    document.getElementById('password-panel').hidden = false;
    document.getElementById('shell').hidden = true;
  }

  async function logout(reason = '') {
    try {
      await api.call('auth.logout');
    } catch {
      /* ignore */
    }
    state.me = null;
    state.permissions = new Set();
    resetAuthForms();
    showLogin(reason);
  }

  async function lockApp() {
    try {
      await api.call('auth.lock');
    } catch {
      /* ignore */
    }
    state.me = null;
    state.permissions = new Set();
    resetAuthForms();
    showLogin('Session verrouillée. Reconnectez-vous pour continuer.');
  }

  function startIdleWatch() {
    if (idleTimer) clearInterval(idleTimer);
    lastActivity = Date.now();
    const mark = () => {
      lastActivity = Date.now();
    };
    for (const evt of ['mousedown', 'keydown', 'touchstart', 'wheel']) {
      document.addEventListener(evt, mark, { passive: true });
    }
    const idleMinutes = Number(state.me && state.me.session && state.me.session.idleTimeoutMinutes) || 15;
    idleTimer = setInterval(() => {
      if (!state.me) return;
      if (Date.now() - lastActivity > idleMinutes * 60 * 1000) {
        lockApp();
      }
    }, 30_000);
  }

  function buildNav() {
    const nav = document.getElementById('nav');
    nav.innerHTML = "";
    for (const item of NAV_ITEMS) {
      if (!hasAny(item.permissions)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nav-link';
      button.dataset.page = item.page;
      button.innerHTML = `<span class="nav-icon">${item.icon}</span><span>${item.label}</span>`;
      button.addEventListener('click', () => {
        window.location.hash = `#/${item.page}`;
      });
      nav.appendChild(button);
    }
  }

  function parseHash(hash) {
    const raw = String(hash || '#/dashboard').replace(/^#\/?/, '');
    const [page, queryString] = raw.split('?');
    const query = {};
    if (queryString) {
      for (const part of queryString.split('&')) {
        const [key, value] = part.split('=');
        if (key) query[decodeURIComponent(key)] = decodeURIComponent(value || '');
      }
    }
    return { page: page || 'dashboard', query };
  }

  function activeNav(page) {
    for (const button of document.querySelectorAll('.nav-link')) {
      button.classList.toggle('active', button.dataset.page === page);
    }
  }

  async function route(hash) {
    if (!state.me) return;
    const { page, query } = parseHash(hash);
    const definition = Suivi.pages[page];
    if (!definition) {
      window.location.hash = '#/dashboard';
      return;
    }
    if (definition.permissions && !hasAny(definition.permissions)) {
      ui.toast('Accès non autorisé à cette section.', 'error');
      window.location.hash = '#/dashboard';
      return;
    }
    state.page = page;
    activeNav(page);
    document.getElementById('page-title').textContent = definition.title;
    document.getElementById('page-subtitle').textContent = definition.subtitle || '';
    const root = document.getElementById('page');
    ui.setLoading(root);
    if (typeof currentCleanup === 'function') {
      try {
        currentCleanup();
      } catch {
        /* ignore */
      }
      currentCleanup = null;
    }
    try {
      const cleanup = await definition.render(root, query);
      if (typeof cleanup === 'function') currentCleanup = cleanup;
    } catch (err) {
      if (err.code === 'SESSION_EXPIRED' || err.code === 'UNAUTHORIZED') {
        await forceLogin(err.message);
        return;
      }
      root.innerHTML = `<div class="alert danger"><strong>Chargement impossible.</strong><br>${fmt.esc(err.message)}</div>
        <button type="button" class="btn btn-ghost" id="retry-page">Réessayer</button>`;
      const retry = document.getElementById('retry-page');
      if (retry) retry.addEventListener('click', () => route(hash));
      ui.showError(err);
    }
  }

  async function forceLogin(message) {
    state.me = null;
    state.permissions = new Set();
    resetAuthForms();
    showLogin(message || 'Votre session a expiré. Reconnectez-vous.');
  }

  async function loadNotifications() {
    if (!state.permissions.has('notifications.view')) return;
    try {
      const count = await api.call('notifications.unreadCount');
      const badge = document.getElementById('notification-count');
      const value = Number(count) || 0;
      badge.textContent = value > 99 ? '99+' : String(value);
      badge.hidden = value === 0;
    } catch {
      /* silencieux */
    }
  }

  async function showNotifications() {
    try {
      const list = await api.call('notifications.list', { limit: 40 });
      const items = Array.isArray(list) ? list : list.items || [];
      const content = items.length
        ? `<div class="stack">${items
            .map(
              (n) => `<div class="notification-item ${n.isRead ? '' : 'unread'}">
                <strong>${fmt.esc(n.title)}</strong>
                <div>${fmt.esc(n.body || '')}</div>
                <time>${fmt.dateTime(n.createdAt)}</time>
              </div>`
            )
            .join('')}</div>`
        : ui.emptyState('Aucune notification', 'Les alertes d’échéance et les demandes d’approbation apparaîtront ici.');
      ui.openModal({
        title: 'Notifications',
        content,
        actions: [
          { label: 'Fermer', className: 'btn-ghost' },
          {
            label: 'Tout marquer comme lu',
            className: 'btn-primary',
            onClick: async (close) => {
              await api.call('notifications.markRead', { all: true });
              close();
              loadNotifications();
            },
          },
        ],
      });
    } catch (err) {
      ui.showError(err);
    }
  }

  function wireAuthForms() {
    document.getElementById('login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      setAuthError('login-error', '');
      try {
        const data = new FormData(form);
        const me = await api.call('auth.login', {
          username: String(data.get('username') || '').trim(),
          password: String(data.get('password') || ''),
        });
        form.reset();
        await enterApp(me);
      } catch (err) {
        setAuthError('login-error', err.message);
      } finally {
        submit.disabled = false;
      }
    });

    document.getElementById('setup-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const submit = form.querySelector('button[type="submit"]');
      const dgPassword = String(data.get('dgPassword') || '');
      const adminPassword = String(data.get('adminPassword') || '');
      if (dgPassword !== String(data.get('dgConfirm') || '')) return setAuthError('setup-error', 'La confirmation du mot de passe DG ne correspond pas.');
      if (adminPassword !== String(data.get('adminConfirm') || '')) return setAuthError('setup-error', 'La confirmation du mot de passe administrateur ne correspond pas.');
      if (dgPassword === adminPassword) return setAuthError('setup-error', 'Les mots de passe du DG et de l’administrateur doivent être différents.');
      const companyName = String(data.get('companyName') || '').trim();
      const companyCode = String(data.get('companyCode') || '').trim();
      if (companyName && !companyCode) return setAuthError('setup-error', 'Indiquez un code pour la société.');
      submit.disabled = true;
      setAuthError('setup-error', '');
      try {
        await api.call('auth.setup', {
          orgName: String(data.get('orgName') || '').trim(),
          dg: {
            username: String(data.get('dgUsername') || '').trim(),
            fullName: String(data.get('dgFullName') || '').trim(),
            password: dgPassword,
          },
          admin: {
            username: String(data.get('adminUsername') || '').trim(),
            fullName: String(data.get('adminFullName') || '').trim(),
            password: adminPassword,
          },
          company: companyName ? { code: companyCode, name: companyName } : undefined,
        });
        const me = await api.call('auth.login', {
          username: String(data.get('dgUsername') || '').trim(),
          password: dgPassword,
        });
        form.reset();
        ui.toast('Initialisation terminée. Aucune donnée de démonstration n’a été créée.', 'success', 6000);
        await enterApp(me);
      } catch (err) {
        setAuthError('setup-error', err.message);
      } finally {
        submit.disabled = false;
      }
    });

    document.getElementById('password-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      if (String(data.get('newPassword') || '') !== String(data.get('confirmPassword') || '')) {
        return setAuthError('password-error', 'La confirmation ne correspond pas.');
      }
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      setAuthError('password-error', '');
      try {
        await api.call('auth.changePassword', {
          currentPassword: String(data.get('currentPassword') || ''),
          newPassword: String(data.get('newPassword') || ''),
        });
        form.reset();
        ui.toast('Mot de passe modifié.', 'success');
        const me = await api.call('auth.me');
        if (me && me.authenticated) await enterApp(me);
        else showLogin();
      } catch (err) {
        setAuthError('password-error', err.message);
      } finally {
        submit.disabled = false;
      }
    });

    document.getElementById('password-logout').addEventListener('click', () => logout());
  }

  function wireShell() {
    document.getElementById('lock-button').addEventListener('click', lockApp);
    document.getElementById('refresh-button').addEventListener('click', () => route(window.location.hash || '#/dashboard'));
    document.getElementById('notifications-button').addEventListener('click', showNotifications);
    window.addEventListener('hashchange', () => route(window.location.hash));
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireAuthForms();
    wireShell();
    document.addEventListener('suivi:session-expired', (event) => {
      forceLogin(event.detail && event.detail.message);
    });
    boot();
  });

  Suivi.app = { route, logout, lockApp, loadNotifications, forceLogin };
})();
