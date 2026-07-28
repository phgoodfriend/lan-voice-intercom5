'use strict';

/**
 * preload.js
 * Exposes a minimal, safe API surface to the renderer via contextBridge.
 * The renderer never gets direct access to Node/Electron internals.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // --- Network info ---
  getNetworkInfo: () => ipcRenderer.invoke('network:get-info'),

  // --- Scanning ---
  // opts: { port, isManual } — both optional, used by Advanced Scan.
  startScan: (firstHost, lastHost, opts = {}) =>
    ipcRenderer.invoke('scan:start', { firstHost, lastHost, port: opts.port, isManual: opts.isManual }),
  stopScan: () => ipcRenderer.invoke('scan:stop'),

  onScanProgress: (callback) => {
    ipcRenderer.on('scan:progress', (_event, payload) => callback(payload));
  },
  onDeviceFound: (callback) => {
    ipcRenderer.on('scan:device-found', (_event, payload) => callback(payload));
  },
  onScanLog: (callback) => {
    ipcRenderer.on('scan:log', (_event, payload) => callback(payload));
  },

  // --- Ping tool ---
  pingDevice: (ip, count) => ipcRenderer.invoke('ping:device', { ip, count }),

  // --- Advanced Scan / manual network settings ---
  calculateRange: (ip, subnetMask) => ipcRenderer.invoke('range:calculate', { ip, subnetMask }),

  // --- Manual Add Device dialog ---
  verifyDevice: (ip, hostname, port) => ipcRenderer.invoke('device:verify', { ip, hostname, port }),

  // --- Voice service discovery (Phase 2) ---
  checkServiceDevice: (ip) => ipcRenderer.invoke('service:check-device', { ip }),
  onServiceStatusUpdate: (callback) => {
    ipcRenderer.on('service:status-update', (_event, payload) => callback(payload));
  }
});
