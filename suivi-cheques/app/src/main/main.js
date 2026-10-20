'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { openDatabase, dbHealth } = require('./db');
const { createDispatcher } = require('./ipc');
const backups = require('./services/backups');
const auth = require('./services/auth');

const APP_ID = 'dz.suivi.cheques';
const isDev = !app.isPackaged;

let mainWindow = null;
let db = null;
let backupTimer = null;
let dataPaths = null;
let dispatcher = null;

app.setAppUserModelId(APP_ID);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  return dir;
}

function buildPaths() {
  const root = app.getPath('userData');
  const dataDir = ensureDir(path.join(root, 'data'));
  const attachmentsDir = ensureDir(path.join(root, 'documents'));
  const backupsDir = ensureDir(path.join(root, 'backups'));
  const tmpDir = ensureDir(path.join(root, 'tmp'));
  const legacyDir = ensureDir(path.join(root, 'legacy-imports'));
  return {
    root,
    dataDir,
    dbPath: path.join(dataDir, 'suivi-cheques.sqlite'),
    attachmentsDir,
    backupsDir,
    tmpDir,
    legacyDir,
    logFile: path.join(root, 'suivi-cheques.log'),
  };
}

function log(message) {
  try {
    if (!dataPaths) return;
    const line = `${new Date().toISOString()} ${message}\n`;
    fs.appendFileSync(dataPaths.logFile, line, { mode: 0o600 });
  } catch {
    /* le journal ne doit jamais bloquer l'application */
  }
}

function openMainDatabase() {
  const connection = openDatabase(dataPaths.dbPath);
  const health = dbHealth(connection);
  if (health.integrity !== 'ok') {
    throw new Error(`Base de données corrompue : ${health.integrity}`);
  }
  return connection;
}

function closeDatabase() {
  if (db) {
    try {
      db.close();
    } catch (err) {
      log(`Erreur fermeture base : ${err.message}`);
    }
    db = null;
  }
}

function reopenDatabase() {
  db = openMainDatabase();
  return db;
}

function isTrustedSender(event) {
  try {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame) return false;
    const url = frame.url;
    if (!url.startsWith('file://')) return false;
    const appRoot = path.resolve(__dirname, '..', '..');
    const filePath = decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
    const resolved = path.resolve(filePath);
    return resolved.startsWith(path.resolve(appRoot, 'src', 'renderer')) || isDev;
  } catch {
    return false;
  }
}

function installSecurityPolicies() {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setDevicePermissionHandler(() => false);

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'none'",
      "media-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(pathToFileURL(path.join(__dirname, '..', 'renderer')).toString())) {
        event.preventDefault();
      }
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('render-process-gone', (_e, details) => {
      log(`Processus de rendu terminé : ${details.reason}`);
    });
  });
}

function buildRuntime() {
  return {
    getDb: () => db,
    getIdleSeconds: () => {
      try {
        return powerMonitor.getSystemIdleTime();
      } catch {
        return 0;
      }
    },
    pickOpenFile: async ({ title, filters }) => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title,
        properties: ['openFile'],
        filters: filters || [],
      });
      if (result.canceled || !result.filePaths.length) return null;
      const filePath = result.filePaths[0];
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return null;
      return { path: filePath, size: stat.size };
    },
    pickSavePath: async ({ title, defaultPath, filters }) => {
      const result = await dialog.showSaveDialog(mainWindow, {
        title,
        defaultPath,
        filters: filters || [],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (result.canceled || !result.filePath) return null;
      return result.filePath;
    },
    openPath: (target) => shell.openPath(target),
    close: closeDatabase,
    reopen: reopenDatabase,
  };
}

function scheduleAutoBackups() {
  const run = async () => {
    try {
      if (!db) return;
      if (!app.isPackaged && process.env.SUIVI_DISABLE_AUTO_BACKUP === '1') return;
      const needsSetup = auth.isSetupRequired(db);
      if (needsSetup) return;
      const result = await backups.autoBackupIfDue(db, dataPaths, { userId: null });
      if (result && result.created) {
        log(`Sauvegarde automatique créée : ${result.filename}`);
        backups.pruneBackups(db, dataPaths);
      }
    } catch (err) {
      log(`Sauvegarde automatique échouée : ${err.message}`);
    }
  };
  setTimeout(run, 20_000);
  backupTimer = setInterval(run, 60 * 60 * 1000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#f4f6f7',
    title: 'Suivi des Chèques',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      webviewTag: false,
      devTools: isDev,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const rendererFile = path.join(__dirname, '..', 'renderer', 'index.html');
  mainWindow.loadFile(rendererFile).catch((err) => {
    log(`Chargement de l'interface impossible : ${err.message}`);
    dialog.showErrorBox('Suivi des Chèques', `Impossible de charger l'interface : ${err.message}`);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log('Interface chargée');
  });
}

async function start() {
  try {
    Menu.setApplicationMenu(null);
    app.enableSandbox();
    dataPaths = buildPaths();
    db = openMainDatabase();
    installSecurityPolicies();
    dispatcher = createDispatcher({ getDb: () => db, paths: dataPaths, runtime: buildRuntime() });

    ipcMain.handle('suivi:invoke', async (event, payload) => {
      if (!isTrustedSender(event)) {
        return { ok: false, error: { code: 'IPC_FORBIDDEN', message: 'Origine non autorisée' } };
      }
      return dispatcher.dispatch(event, payload);
    });

    createWindow();
    scheduleAutoBackups();
    log('Démarrage terminé');
  } catch (err) {
    log(`Démarrage impossible : ${err.stack || err.message}`);
    dialog.showErrorBox(
      'Suivi des Chèques',
      `L'application n'a pas pu démarrer.\n\n${err.message}\n\nLes données n'ont pas été modifiées. Contactez l'administrateur et conservez le dossier de données.`
    );
    app.quit();
  }
}

app.whenReady().then(start);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (backupTimer) clearInterval(backupTimer);
  closeDatabase();
});

process.on('uncaughtException', (err) => {
  log(`Exception non gérée : ${err.stack || err.message}`);
});
process.on('unhandledRejection', (err) => {
  log(`Rejet non géré : ${err && err.stack ? err.stack : String(err)}`);
});
