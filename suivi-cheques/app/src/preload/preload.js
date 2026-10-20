'use strict';

/**
 * Pont minimal. Le rendu ne reçoit ni fs, ni ipcRenderer brut, ni chemin de
 * fichier, ni accès SQL. Toutes les méthodes passent par un canal unique dont
 * la liste blanche est vérifiée dans le processus principal.
 */
const { contextBridge, ipcRenderer } = require('electron');

let counter = 0;

function invoke(method, params = {}) {
  counter += 1;
  const requestId = `${Date.now().toString(36)}-${counter}`;
  return ipcRenderer.invoke('suivi:invoke', { method, params, requestId });
}

contextBridge.exposeInMainWorld('suivi', Object.freeze({
  invoke,
  appName: 'Suivi des Chèques',
  platform: process.platform,
}));
