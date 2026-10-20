'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/main/db');
const { createDispatcher } = require('../src/main/ipc');

const PASSWORD_DG = 'V7!kR2mQ9#LzP4xN';
const PASSWORD_ADMIN = 'M3&jT8@wQ6$nY5vB';
const PASSWORD_RESP = 'R8@kL3pW7!zQ2mNf';
const PASSWORD_DG2 = 'T4#nB9xK6!wR3vJd';

function tempRoot(label = 'suivi-test') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

function buildPaths(root) {
  const paths = {
    root,
    dataDir: path.join(root, 'data'),
    dbPath: path.join(root, 'data', 'suivi-cheques.sqlite'),
    attachmentsDir: path.join(root, 'documents'),
    backupsDir: path.join(root, 'backups'),
    tmpDir: path.join(root, 'tmp'),
    legacyDir: path.join(root, 'legacy'),
  };
  for (const key of ['dataDir', 'attachmentsDir', 'backupsDir', 'tmpDir', 'legacyDir']) {
    fs.mkdirSync(paths[key], { recursive: true });
  }
  return paths;
}

/**
 * Crée une application de test complète via le vrai répartiteur IPC.
 * Aucun service n'est contourné : les autorisations sont donc exercées.
 */
async function createTestApp(options = {}) {
  const root = options.root || tempRoot();
  const paths = buildPaths(root);
  let db = openDatabase(paths.dbPath);
  const openQueue = [];
  const saveQueue = [];
  const runtime = {
    getDb: () => db,
    getIdleSeconds: () => 0,
    close: () => db.close(),
    reopen: () => {
      db = openDatabase(paths.dbPath);
      return db;
    },
    queueOpenFile(filePath) {
      openQueue.push(filePath);
    },
    queueSavePath(filePath) {
      saveQueue.push(filePath);
    },
    pickOpenFile: async () => {
      const filePath = openQueue.shift();
      if (!filePath) return null;
      const stat = fs.statSync(filePath);
      return { path: filePath, size: stat.size };
    },
    pickSavePath: async () => saveQueue.shift() || null,
    openPath: async () => '',
  };
  const dispatcher = createDispatcher({ getDb: () => db, paths, runtime });

  const makeClient = (senderId) => {
    const event = { sender: { id: senderId, mainFrame: {} }, senderFrame: null };
    return async function call(method, params = {}) {
      const response = await dispatcher.dispatch(event, { method, params });
      if (!response.ok) {
        const err = new Error(response.error.message);
        err.code = response.error.code;
        err.details = response.error.details;
        throw err;
      }
      return response.data;
    };
  };

  const publicClient = makeClient(1);
  const bootstrap = await publicClient('app.bootstrap');
  if (bootstrap.needsSetup) {
    await publicClient('auth.setup', {
      orgName: options.orgName || 'Groupe Test',
      dg: {
        username: options.dgUsername || 'dg01',
        fullName: 'Directeur Général Test',
        password: options.dgPassword || PASSWORD_DG,
      },
      admin: {
        username: 'adm01',
        fullName: 'Administrateur Test',
        password: PASSWORD_ADMIN,
      },
      company: {
        code: options.companyCode || 'SOC-A',
        name: options.companyName || 'Société Alpha',
      },
    });
  }

  const dg = makeClient(10);
  const admin = makeClient(20);
  const dgSession = await dg('auth.login', { username: options.dgUsername || 'dg01', password: options.dgPassword || PASSWORD_DG });
  const adminSession = await admin('auth.login', { username: 'adm01', password: PASSWORD_ADMIN });

  const companies = await dg('companies.list');
  const companyA = companies[0];
  let companyB = companies[1] || null;
  if (!companyB && options.secondCompany !== false) {
    companyB = await admin('companies.create', {
      code: options.secondCompanyCode || 'SOC-B',
      name: options.secondCompanyName || 'Société Bêta',
    });
  }
  const banks = await admin('banks.list');
  let bank = banks.find((b) => b.name === 'Banque Test');
  if (!bank) bank = await admin('banks.create', { name: 'Banque Test', shortName: 'BT' });

  const createAccount = (companyId, label, openingBalanceCents = 0) =>
    admin('accounts.create', {
      companyId,
      bankId: bank.id,
      label,
      accountNumber: `TEST-${companyId}-${label.replace(/\W+/g, '').slice(0, 8)}`,
      openingBalanceCents,
      openingDate: options.openingDate || '2026-01-01',
    });

  const accountA = options.skipAccounts ? null : await createAccount(companyA.id, 'Compte principal', options.openingBalanceCents ?? 10_000_000);
  const accountB = companyB && !options.skipAccounts ? await createAccount(companyB.id, 'Compte secondaire', 5_000_000) : null;

  let dg2 = null;
  if (options.secondDg) {
    await dg('users.create', {
      username: 'dg02',
      fullName: 'Second Directeur Général',
      role: 'DG',
      password: PASSWORD_DG2,
      mustChangePassword: false,
    });
    dg2 = makeClient(30);
    await dg2('auth.login', { username: 'dg02', password: PASSWORD_DG2 });
  }

  let responsable = null;
  if (options.responsable) {
    await admin('users.create', {
      username: 'resp01',
      fullName: 'Responsable Test',
      role: 'RESPONSABLE',
      companyIds: [companyA.id],
      password: PASSWORD_RESP,
      mustChangePassword: false,
    });
    responsable = makeClient(40);
    await responsable('auth.login', { username: 'resp01', password: PASSWORD_RESP });
  }

  return {
    root,
    paths,
    get db() {
      return db;
    },
    dispatcher,
    runtime,
    clients: { public: publicClient, dg, admin, dg2, responsable },
    sessions: { dg: dgSession, admin: adminSession },
    data: { companyA, companyB, bank, accountA, accountB },
    passwords: { DG: PASSWORD_DG, ADMIN: PASSWORD_ADMIN, RESP: PASSWORD_RESP, DG2: PASSWORD_DG2 },
    async cleanup() {
      try {
        if (db && db.open) db.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function createCsvBuffer(lines, { delimiter = ';', bom = true } = {}) {
  const text = lines.map((line) => line.join(delimiter)).join('\r\n');
  return Buffer.from((bom ? '\uFEFF' : '') + text, 'utf8');
}

module.exports = {
  createTestApp,
  tempRoot,
  buildPaths,
  createCsvBuffer,
  PASSWORD_DG,
  PASSWORD_ADMIN,
  PASSWORD_RESP,
  PASSWORD_DG2,
};
