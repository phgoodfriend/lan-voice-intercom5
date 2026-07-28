'use strict';

/**
 * main.js
 * Electron main process.
 *
 * Phase 1 scope ONLY: LAN discovery / scanning.
 * Voice calling, chat, microphone and WebRTC are intentionally NOT implemented.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const { getActiveNetworkInfo } = require('./src/networkInfo');
const { scanNetwork, detailedPing, verifyDevice } = require('./src/scanner');
const { checkVoiceService, checkVoiceServiceBatch } = require('./src/serviceDiscovery');
const { calculateNetworkRange, netmaskToCidr } = require('./src/ipUtils');

let mainWindow = null;

// Tracks whether a scan is currently in-flight so "Stop Scan" can cancel it.
const scanState = {
  running: false,
  stopRequested: false
};

// Tracks the in-flight voice-service discovery pass tied to the current scan,
// so it can be cancelled the same way (Stop Scan should stop both).
const serviceScanState = {
  stopRequested: false
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'LAN Voice Intercom - Scanner (Phase 1)',
    backgroundColor: '#1e1f26',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Uncomment for debugging:
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

/** Get info about the currently active network adapter. */
ipcMain.handle('network:get-info', async () => {
  try {
    const info = await getActiveNetworkInfo();
    return { success: true, data: info };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Starts a full network scan. Progress/device/log events are pushed to the
 * renderer via webContents.send so the UI never blocks waiting on a
 * synchronous return value.
 */
ipcMain.handle('scan:start', async (event, { firstHost, lastHost, port, isManual }) => {
  if (scanState.running) {
    return { success: false, error: 'A scan is already in progress.' };
  }

  scanState.running = true;
  scanState.stopRequested = false;
  serviceScanState.stopRequested = false;

  const sender = event.sender;
  const startTime = Date.now();
  const parsedPort = port ? parseInt(port, 10) : null;

  // Every IP whose voice-service check we've already kicked off during this
  // scan, so we never probe the same device twice in one pass (onDeviceFound
  // can only fire once per IP per scan anyway, but this stays defensive).
  const serviceChecksStarted = new Set();

  // Fire a voice-service probe the moment a device is discovered by the ping
  // sweep, rather than waiting for the whole sweep to finish. This keeps
  // Phase 1's scanner completely untouched — we just react to its existing
  // onDeviceFound callback.
  function beginServiceCheckFor(device) {
    if (serviceChecksStarted.has(device.ip)) return;
    serviceChecksStarted.add(device.ip);

    if (!sender.isDestroyed()) {
      sender.send('service:status-update', {
        ip: device.ip,
        status: 'checking',
        message: 'Checking Voice Service...',
        appInfo: null,
        checkedAt: Date.now()
      });
    }

    checkVoiceService(device.ip, {
      onLog: (message) => {
        if (!sender.isDestroyed()) sender.send('scan:log', message);
      }
    }).then((result) => {
      if (!sender.isDestroyed() && !serviceScanState.stopRequested) {
        sender.send('service:status-update', result);
      }
    });
  }

  try {
    const devices = await scanNetwork(
      firstHost,
      lastHost,
      {
        onProgress: (done, total) => {
          if (!sender.isDestroyed()) {
            sender.send('scan:progress', { done, total });
          }
        },
        onDeviceFound: (device) => {
          if (!sender.isDestroyed()) {
            sender.send('scan:device-found', device);
          }
          beginServiceCheckFor(device);
        },
        onLog: (message) => {
          if (!sender.isDestroyed()) {
            sender.send('scan:log', message);
          }
        }
      },
      () => scanState.stopRequested,
      { port: parsedPort }
    );

    const elapsedMs = Date.now() - startTime;
    scanState.running = false;

    const scanMethod = parsedPort
      ? `ICMP + ARP + TCP:${parsedPort}`
      : 'ICMP + ARP';

    return {
      success: true,
      data: {
        devices,
        elapsedMs,
        stopped: scanState.stopRequested,
        scanType: isManual ? 'Manual' : 'Automatic',
        scanMethod
      }
    };
  } catch (err) {
    scanState.running = false;
    return { success: false, error: err.message };
  }
});

/** Requests cancellation of an in-progress scan (ping sweep + service checks). */
ipcMain.handle('scan:stop', async () => {
  if (scanState.running) {
    scanState.stopRequested = true;
  }
  serviceScanState.stopRequested = true;
  return { success: true };
});

/**
 * Manually (re)checks the voice service on a single device — used by the
 * renderer to refresh a stale row, or to probe a device that came back
 * online between full scans during Auto Scan.
 */
ipcMain.handle('service:check-device', async (event, { ip }) => {
  try {
    const sender = event.sender;
    const result = await checkVoiceService(ip, {
      onLog: (message) => {
        if (!sender.isDestroyed()) sender.send('scan:log', message);
      }
    });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/** Runs a detailed multi-ping test against a single IP (Ping tool / row action). */
ipcMain.handle('ping:device', async (event, { ip, count }) => {
  try {
    const result = await detailedPing(ip, count || 4);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Pure calculation used by the Advanced Scan panel: given an IP + subnet
 * mask typed in by hand, compute the Start IP / End IP / CIDR to fill the
 * rest of the form in. No network activity, synchronous-fast.
 */
ipcMain.handle('range:calculate', async (event, { ip, subnetMask }) => {
  try {
    const range = calculateNetworkRange(ip, subnetMask);
    const cidr = netmaskToCidr(subnetMask);
    return { success: true, data: { ...range, cidr } };
  } catch (err) {
    return { success: false, error: 'Invalid IP address or subnet mask.' };
  }
});

/**
 * Verifies a manually-entered device (Add Device dialog's "Verify" button).
 * Runs ping + optional TCP port probe + ARP/vendor lookup + hostname for a
 * single IP, independent of any in-progress scan.
 */
ipcMain.handle('device:verify', async (event, { ip, hostname, port }) => {
  try {
    const parsedPort = port ? parseInt(port, 10) : null;
    const result = await verifyDevice(ip, { port: parsedPort, hostnameOverride: hostname || null });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
