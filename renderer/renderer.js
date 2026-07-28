'use strict';

/**
 * renderer.js
 * Drives all UI behavior. Communicates with the main process exclusively
 * through the `window.api` bridge exposed by preload.js — no direct Node
 * access here.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let networkInfo = null;          // current adapter/IP/gateway info
let devices = new Map();         // ip -> device object
let scanInProgress = false;
let autoScanTimer = null;
let scanStartTime = null;
let elapsedTimer = null;
let lastScanElapsedMs = 0;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const el = {
  infoHostname: document.getElementById('infoHostname'),
  infoIp: document.getElementById('infoIp'),
  infoSubnet: document.getElementById('infoSubnet'),
  infoGateway: document.getElementById('infoGateway'),
  infoMac: document.getElementById('infoMac'),
  infoAdapter: document.getElementById('infoAdapter'),
  infoRange: document.getElementById('infoRange'),

  btnScan: document.getElementById('btnScan'),
  btnStop: document.getElementById('btnStop'),
  btnRefresh: document.getElementById('btnRefresh'),
  btnClear: document.getElementById('btnClear'),
  btnAddDevice: document.getElementById('btnAddDevice'),
  btnToggleAdvanced: document.getElementById('btnToggleAdvanced'),
  chkAutoScan: document.getElementById('chkAutoScan'),
  searchBox: document.getElementById('searchBox'),

  advancedPanel: document.getElementById('advancedPanel'),
  advIp: document.getElementById('advIp'),
  advSubnet: document.getElementById('advSubnet'),
  advGateway: document.getElementById('advGateway'),
  advStartIp: document.getElementById('advStartIp'),
  advEndIp: document.getElementById('advEndIp'),
  advPort: document.getElementById('advPort'),
  btnAdvDetect: document.getElementById('btnAdvDetect'),
  btnAdvScan: document.getElementById('btnAdvScan'),
  btnAdvReset: document.getElementById('btnAdvReset'),

  tableBody: document.getElementById('deviceTableBody'),
  emptyState: document.getElementById('emptyState'),

  diagAdapter: document.getElementById('diagAdapter'),
  diagIp: document.getElementById('diagIp'),
  diagGateway: document.getElementById('diagGateway'),
  diagSubnet: document.getElementById('diagSubnet'),
  diagDns: document.getElementById('diagDns'),
  diagCidr: document.getElementById('diagCidr'),
  diagNetwork: document.getElementById('diagNetwork'),
  diagScanMethod: document.getElementById('diagScanMethod'),
  diagTotalIps: document.getElementById('diagTotalIps'),
  diagDevicesFound: document.getElementById('diagDevicesFound'),
  diagScanTime: document.getElementById('diagScanTime'),

  logOutput: document.getElementById('logOutput'),

  progressFill: document.getElementById('progressFill'),
  statusText: document.getElementById('statusText'),
  statusCount: document.getElementById('statusCount'),
  statusElapsed: document.getElementById('statusElapsed'),

  detailsModalOverlay: document.getElementById('detailsModalOverlay'),
  btnCloseDetails: document.getElementById('btnCloseDetails'),
  detailIp: document.getElementById('detailIp'),
  detailHostname: document.getElementById('detailHostname'),
  detailMac: document.getElementById('detailMac'),
  detailVendor: document.getElementById('detailVendor'),
  detailPing: document.getElementById('detailPing'),
  detailAdapter: document.getElementById('detailAdapter'),
  detailStatus: document.getElementById('detailStatus'),
  detailVoiceStatus: document.getElementById('detailVoiceStatus'),
  detailAppName: document.getElementById('detailAppName'),
  detailAppVersion: document.getElementById('detailAppVersion'),
  detailAppPort: document.getElementById('detailAppPort'),
  detailDeviceId: document.getElementById('detailDeviceId'),
  detailLastSeen: document.getElementById('detailLastSeen'),

  pingModalOverlay: document.getElementById('pingModalOverlay'),
  btnClosePing: document.getElementById('btnClosePing'),
  pingModalIp: document.getElementById('pingModalIp'),
  pingModalBody: document.getElementById('pingModalBody'),

  addDeviceModalOverlay: document.getElementById('addDeviceModalOverlay'),
  btnCloseAddDevice: document.getElementById('btnCloseAddDevice'),
  addDeviceIp: document.getElementById('addDeviceIp'),
  addDeviceHostname: document.getElementById('addDeviceHostname'),
  addDevicePort: document.getElementById('addDevicePort'),
  addDeviceResult: document.getElementById('addDeviceResult'),
  btnAddDevicePing: document.getElementById('btnAddDevicePing'),
  btnAddDeviceVerify: document.getElementById('btnAddDeviceVerify'),
  btnAddDeviceConfirm: document.getElementById('btnAddDeviceConfirm')
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function appendLog(message) {
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = `[${time}] ${message}`;
  el.logOutput.appendChild(line);
  el.logOutput.scrollTop = el.logOutput.scrollHeight;
}

// ---------------------------------------------------------------------------
// Network info panel
// ---------------------------------------------------------------------------
async function loadNetworkInfo() {
  appendLog('Detecting active adapter...');
  const result = await window.api.getNetworkInfo();

  if (!result.success) {
    appendLog(`ERROR: ${result.error}`);
    el.statusText.textContent = 'Error detecting network';
    return null;
  }

  networkInfo = result.data;

  el.infoHostname.textContent = networkInfo.hostname;
  el.infoIp.textContent = networkInfo.ip;
  el.infoSubnet.textContent = networkInfo.subnetMask;
  el.infoGateway.textContent = networkInfo.gateway;
  el.infoMac.textContent = networkInfo.mac || 'Unknown';
  el.infoAdapter.textContent = networkInfo.adapterDescription || networkInfo.adapterName;
  el.infoRange.textContent = networkInfo.networkRange;

  el.diagAdapter.textContent = networkInfo.adapterDescription || networkInfo.adapterName;
  el.diagIp.textContent = networkInfo.ip;
  el.diagGateway.textContent = networkInfo.gateway;
  el.diagSubnet.textContent = networkInfo.subnetMask;
  el.diagDns.textContent = (networkInfo.dnsServers && networkInfo.dnsServers.length)
    ? networkInfo.dnsServers.join(', ')
    : 'Unknown';
  el.diagCidr.textContent = `/${networkInfo.cidr}`;
  el.diagNetwork.textContent = `${networkInfo.networkAddress} / ${networkInfo.broadcastAddress}`;
  el.diagTotalIps.textContent = networkInfo.totalHosts;

  // Pre-fill the Advanced Scan panel with the auto-detected values so the
  // user only has to touch the fields they actually want to override.
  el.advIp.value = networkInfo.ip;
  el.advSubnet.value = networkInfo.subnetMask;
  el.advGateway.value = networkInfo.gateway;
  el.advStartIp.value = networkInfo.firstHost;
  el.advEndIp.value = networkInfo.lastHost;

  appendLog(`Adapter selected: ${networkInfo.adapterDescription || networkInfo.adapterName}`);
  appendLog(`Detected IP: ${networkInfo.ip}`);
  appendLog(`Calculating subnet... range ${networkInfo.networkRange}`);

  return networkInfo;
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------
function renderTable() {
  const query = el.searchBox.value.trim().toLowerCase();
  const list = Array.from(devices.values())
    .filter((d) => {
      if (!query) return true;
      return d.ip.toLowerCase().includes(query) || (d.hostname || '').toLowerCase().includes(query);
    })
    .sort((a, b) => ipSortKey(a.ip) - ipSortKey(b.ip));

  el.tableBody.innerHTML = '';
  el.emptyState.style.display = list.length === 0 ? 'block' : 'none';

  for (const device of list) {
    const tr = document.createElement('tr');
    tr.dataset.ip = device.ip;

    const voice = device.voiceService || { status: 'checking', message: 'Queued...' };
    const isRunning = voice.status === 'running';

    tr.innerHTML = `
      <td><span class="status-dot ${device.status}"></span>${device.status === 'online' ? 'Online' : 'Offline'}</td>
      <td>${device.ip}</td>
      <td>${escapeHtml(device.hostname) || '<span style="color:var(--text-secondary)">Unknown</span>'}</td>
      <td>${device.ping !== null && device.ping !== undefined ? device.ping + ' ms' : '—'}</td>
      <td>${device.mac}</td>
      <td>${escapeHtml(device.vendor)}</td>
      <td>${voiceBadgeHtml(voice)}</td>
      <td class="action-cell">
        <button class="row-btn" data-action="ping" data-ip="${device.ip}">Ping</button>
        <button class="row-btn call-btn" data-action="call" data-ip="${device.ip}" ${isRunning ? '' : 'disabled'}>📞 Call</button>
      </td>
    `;

    tr.addEventListener('dblclick', () => openDeviceDetails(device.ip));
    el.tableBody.appendChild(tr);
  }

  // Wire up per-row ping buttons
  el.tableBody.querySelectorAll('[data-action="ping"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPingTool(btn.dataset.ip);
    });
  });

  // Wire up per-row call buttons (enabled only when Voice Service is running)
  el.tableBody.querySelectorAll('[data-action="call"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      appendLog(`Call requested for ${btn.dataset.ip} — calling is implemented in a later phase.`);
    });
  });

  el.diagDevicesFound.textContent = devices.size;
}

const VOICE_STATUS_LABELS = {
  running: '🟢 Running',
  checking: '🟡 Checking...',
  not_installed: '🔴 Not Installed',
  offline: '⚪ Offline'
};

function voiceBadgeHtml(voice) {
  const status = voice.status || 'checking';
  const label = VOICE_STATUS_LABELS[status] || VOICE_STATUS_LABELS.checking;
  const title = voice.message ? ` title="${escapeHtml(voice.message)}"` : '';
  return `<span class="voice-badge ${status}"${title}><span class="dot"></span>${label}</span>`;
}

function ipSortKey(ip) {
  return ip.split('.').reduce((acc, octet) => acc * 256 + parseInt(octet, 10), 0);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** Lightweight IPv4 -> integer conversion, used only for the host-count display. */
function ipToLongLocal(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + (parts[3] >>> 0);
}

function countHostsInRange(firstHost, lastHost) {
  try {
    return Math.max(0, ipToLongLocal(lastHost) - ipToLongLocal(firstHost) + 1);
  } catch (err) {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------
function startElapsedTimer() {
  scanStartTime = Date.now();
  elapsedTimer = setInterval(() => {
    const secs = ((Date.now() - scanStartTime) / 1000).toFixed(1);
    el.statusElapsed.textContent = `Elapsed: ${secs}s`;
  }, 100);
}

function stopElapsedTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

async function runScan(overrides = null) {
  if (scanInProgress) return;
  if (!overrides && !networkInfo) return;

  const firstHost = overrides ? overrides.firstHost : networkInfo.firstHost;
  const lastHost = overrides ? overrides.lastHost : networkInfo.lastHost;
  const port = overrides ? overrides.port : null;
  const isManual = Boolean(overrides && overrides.isManual);

  scanInProgress = true;
  el.btnScan.disabled = true;
  el.btnStop.disabled = false;
  el.statusText.textContent = 'Scanning...';
  el.progressFill.style.width = '0%';
  startElapsedTimer();

  appendLog('Starting scan...');
  appendLog(`Scanning: ${firstHost} → ${lastHost}`);

  const previousIps = new Set(devices.keys());
  const seenThisScan = new Set();

  const result = await window.api.startScan(firstHost, lastHost, { port, isManual });

  stopElapsedTimer();
  scanInProgress = false;
  el.btnScan.disabled = false;
  el.btnStop.disabled = true;

  if (!result.success) {
    el.statusText.textContent = `Error: ${result.error}`;
    appendLog(`ERROR: ${result.error}`);
    return;
  }

  const { devices: found, elapsedMs, stopped, scanType, scanMethod } = result.data;
  lastScanElapsedMs = elapsedMs;

  found.forEach((d) => {
    // Preserve any voice-service result already streamed in for this IP —
    // the final `devices` array from the ping sweep doesn't carry it, since
    // service checks are dispatched and resolved independently over IPC.
    const existing = devices.get(d.ip);
    d.voiceService = (existing && existing.voiceService) || { status: 'checking', message: 'Checking Voice Service...' };
    devices.set(d.ip, d);
    seenThisScan.add(d.ip);
  });

  // Remove devices that were present before but did not respond this scan
  // (only prune on a full, non-stopped scan to avoid false negatives on a
  // manually interrupted sweep). Manually-added devices (Add Device dialog)
  // are flagged `manual: true` and are never pruned by a scan.
  if (!stopped) {
    for (const ip of previousIps) {
      const existing = devices.get(ip);
      if (existing && existing.manual) continue;
      if (!seenThisScan.has(ip)) {
        devices.delete(ip);
      }
    }
  }

  renderTable();

  el.statusText.textContent = stopped ? 'Scan stopped' : 'Scan complete';
  el.statusCount.textContent = `${devices.size} device(s) found`;
  el.diagScanTime.textContent = `${(elapsedMs / 1000).toFixed(2)}s`;
  el.diagScanMethod.textContent = `${scanType || (isManual ? 'Manual' : 'Automatic')} — ${scanMethod || 'ICMP + ARP'}`;
  el.diagTotalIps.textContent = countHostsInRange(firstHost, lastHost);
  el.progressFill.style.width = '100%';
}

// ---------------------------------------------------------------------------
// Device details modal
// ---------------------------------------------------------------------------
function openDeviceDetails(ip) {
  const device = devices.get(ip);
  if (!device) return;

  el.detailIp.textContent = device.ip;
  el.detailHostname.textContent = device.hostname || 'Unknown';
  el.detailMac.textContent = device.mac;
  el.detailVendor.textContent = device.vendor;
  el.detailPing.textContent = device.ping !== null && device.ping !== undefined ? `${device.ping} ms` : '—';
  el.detailAdapter.textContent = networkInfo ? (networkInfo.adapterDescription || networkInfo.adapterName) : '—';
  el.detailStatus.textContent = device.status === 'online' ? 'Online' : 'Offline';

  const voice = device.voiceService || { status: 'checking' };
  const appInfo = voice.appInfo || {};

  el.detailVoiceStatus.textContent = VOICE_STATUS_LABELS[voice.status] || 'Unknown';
  el.detailAppName.textContent = appInfo.appName || '—';
  el.detailAppVersion.textContent = appInfo.version || '—';
  el.detailAppPort.textContent = appInfo.listeningPort || '—';
  el.detailDeviceId.textContent = appInfo.deviceId || '—';
  el.detailLastSeen.textContent = voice.checkedAt ? new Date(voice.checkedAt).toLocaleTimeString() : '—';

  el.detailsModalOverlay.classList.add('open');
}

el.btnCloseDetails.addEventListener('click', () => el.detailsModalOverlay.classList.remove('open'));
el.detailsModalOverlay.addEventListener('click', (e) => {
  if (e.target === el.detailsModalOverlay) el.detailsModalOverlay.classList.remove('open');
});

// ---------------------------------------------------------------------------
// Ping tool modal
// ---------------------------------------------------------------------------
async function openPingTool(ip) {
  el.pingModalIp.textContent = ip;
  el.pingModalBody.innerHTML = '<div class="ping-loading">Pinging...</div>';
  el.pingModalOverlay.classList.add('open');

  const result = await window.api.pingDevice(ip, 4);

  if (!result.success) {
    el.pingModalBody.innerHTML = `<div class="ping-error">Ping failed: ${escapeHtml(result.error)}</div>`;
    return;
  }

  const stats = result.data;

  if (!stats.reachable) {
    el.pingModalBody.innerHTML = `
      <div class="ping-error">
        Host unreachable or ICMP is blocked.<br/>
        Packet loss: ${stats.lossPct}% (${stats.received}/${stats.sent} received)
      </div>`;
    return;
  }

  el.pingModalBody.innerHTML = `
    <div class="ping-stats-grid">
      <div class="ping-stat"><div class="val">${stats.min} ms</div><div class="lbl">Minimum</div></div>
      <div class="ping-stat"><div class="val">${stats.max} ms</div><div class="lbl">Maximum</div></div>
      <div class="ping-stat"><div class="val">${stats.avg} ms</div><div class="lbl">Average</div></div>
      <div class="ping-stat"><div class="val">${stats.lossPct}%</div><div class="lbl">Packet Loss</div></div>
    </div>
  `;
}

el.btnClosePing.addEventListener('click', () => el.pingModalOverlay.classList.remove('open'));
el.pingModalOverlay.addEventListener('click', (e) => {
  if (e.target === el.pingModalOverlay) el.pingModalOverlay.classList.remove('open');
});

// ---------------------------------------------------------------------------
// Toolbar actions
// ---------------------------------------------------------------------------
el.btnScan.addEventListener('click', () => runScan());

el.btnStop.addEventListener('click', async () => {
  await window.api.stopScan();
  appendLog('Stop requested...');
});

el.btnRefresh.addEventListener('click', async () => {
  await loadNetworkInfo();
  runScan();
});

el.btnClear.addEventListener('click', () => {
  devices.clear();
  renderTable();
  el.statusText.textContent = 'Idle';
  el.statusCount.textContent = '0 / 0';
  el.progressFill.style.width = '0%';
  appendLog('Results cleared.');
});

el.searchBox.addEventListener('input', () => renderTable());

// --- Advanced Scan panel ---
el.btnToggleAdvanced.addEventListener('click', () => {
  el.advancedPanel.classList.toggle('open');
});

el.btnAdvDetect.addEventListener('click', async () => {
  appendLog('Advanced Scan: re-detecting network automatically...');
  await loadNetworkInfo();
});

el.btnAdvReset.addEventListener('click', () => {
  if (networkInfo) {
    el.advIp.value = networkInfo.ip;
    el.advSubnet.value = networkInfo.subnetMask;
    el.advGateway.value = networkInfo.gateway;
    el.advStartIp.value = networkInfo.firstHost;
    el.advEndIp.value = networkInfo.lastHost;
  } else {
    el.advIp.value = '';
    el.advSubnet.value = '';
    el.advGateway.value = '';
    el.advStartIp.value = '';
    el.advEndIp.value = '';
  }
  el.advPort.value = '';
  appendLog('Advanced Scan: fields reset to auto-detected values.');
});

el.btnAdvScan.addEventListener('click', () => {
  const firstHost = el.advStartIp.value.trim();
  const lastHost = el.advEndIp.value.trim();
  const port = el.advPort.value.trim();

  const ipPattern = /^\d{1,3}(\.\d{1,3}){3}$/;
  if (!ipPattern.test(firstHost) || !ipPattern.test(lastHost)) {
    appendLog('ERROR: Start IP and End IP must both be valid IPv4 addresses.');
    return;
  }

  runScan({
    firstHost,
    lastHost,
    port: port || null,
    isManual: true
  });
});

// Typing an IP + subnet manually auto-fills Start/End IP via the same math
// the automatic detector uses (main process calculation, so it stays exactly
// consistent with what a real scan will do).
async function recalculateManualRange() {
  const ip = el.advIp.value.trim();
  const subnet = el.advSubnet.value.trim();
  if (!ip || !subnet) return;

  const result = await window.api.calculateRange(ip, subnet);
  if (result.success) {
    el.advStartIp.value = result.data.firstHost;
    el.advEndIp.value = result.data.lastHost;
  }
}
el.advIp.addEventListener('change', recalculateManualRange);
el.advSubnet.addEventListener('change', recalculateManualRange);

el.chkAutoScan.addEventListener('change', () => {
  if (el.chkAutoScan.checked) {
    appendLog('Auto Scan enabled (every 5s).');
    if (!scanInProgress) runScan();
    autoScanTimer = setInterval(() => {
      if (!scanInProgress) runScan();
    }, 5000);
  } else {
    appendLog('Auto Scan disabled.');
    if (autoScanTimer) clearInterval(autoScanTimer);
    autoScanTimer = null;
  }
});

// ---------------------------------------------------------------------------
// Add Device dialog (manual entry)
// ---------------------------------------------------------------------------
let lastVerifiedDevice = null;

function openAddDeviceDialog() {
  el.addDeviceIp.value = '';
  el.addDeviceHostname.value = '';
  el.addDevicePort.value = '';
  el.addDeviceResult.textContent = '';
  el.addDeviceResult.className = 'add-device-result';
  el.btnAddDeviceConfirm.disabled = true;
  lastVerifiedDevice = null;
  el.addDeviceModalOverlay.classList.add('open');
  el.addDeviceIp.focus();
}

function closeAddDeviceDialog() {
  el.addDeviceModalOverlay.classList.remove('open');
}

el.btnAddDevice.addEventListener('click', openAddDeviceDialog);
el.btnCloseAddDevice.addEventListener('click', closeAddDeviceDialog);
el.addDeviceModalOverlay.addEventListener('click', (e) => {
  if (e.target === el.addDeviceModalOverlay) closeAddDeviceDialog();
});

el.btnAddDevicePing.addEventListener('click', async () => {
  const ip = el.addDeviceIp.value.trim();
  if (!ip) {
    el.addDeviceResult.textContent = 'Enter an IP address first.';
    el.addDeviceResult.className = 'add-device-result fail';
    return;
  }

  el.addDeviceResult.textContent = 'Pinging...';
  el.addDeviceResult.className = 'add-device-result';

  const result = await window.api.pingDevice(ip, 4);
  if (!result.success || !result.data.reachable) {
    el.addDeviceResult.textContent = `No reply from ${ip}.`;
    el.addDeviceResult.className = 'add-device-result fail';
    return;
  }

  el.addDeviceResult.textContent = `Reply from ${ip}: avg ${result.data.avg} ms, ${result.data.lossPct}% loss.`;
  el.addDeviceResult.className = 'add-device-result ok';
});

el.btnAddDeviceVerify.addEventListener('click', async () => {
  const ip = el.addDeviceIp.value.trim();
  const hostname = el.addDeviceHostname.value.trim();
  const port = el.addDevicePort.value.trim();

  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    el.addDeviceResult.textContent = 'Enter a valid IPv4 address.';
    el.addDeviceResult.className = 'add-device-result fail';
    return;
  }

  el.addDeviceResult.textContent = 'Verifying...';
  el.addDeviceResult.className = 'add-device-result';
  el.btnAddDeviceConfirm.disabled = true;

  const result = await window.api.verifyDevice(ip, hostname || null, port || null);

  if (!result.success) {
    el.addDeviceResult.textContent = `Verify failed: ${result.error}`;
    el.addDeviceResult.className = 'add-device-result fail';
    lastVerifiedDevice = null;
    return;
  }

  const data = result.data;
  lastVerifiedDevice = data;

  if (!data.reachable) {
    el.addDeviceResult.textContent = `${ip} did not respond to ping${port ? ` or TCP port ${port}` : ''}. You can still add it manually.`;
    el.addDeviceResult.className = 'add-device-result fail';
    el.btnAddDeviceConfirm.disabled = false; // allow force-adding an unreachable device if the user insists
    return;
  }

  el.addDeviceResult.textContent =
    `Verified: ${data.hostname || 'Unknown host'} — MAC ${data.mac} (${data.vendor})` +
    (data.ping !== null ? `, ${data.ping} ms` : '');
  el.addDeviceResult.className = 'add-device-result ok';
  el.btnAddDeviceConfirm.disabled = false;
});

el.btnAddDeviceConfirm.addEventListener('click', () => {
  const ip = el.addDeviceIp.value.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return;

  const hostnameOverride = el.addDeviceHostname.value.trim();
  const base = lastVerifiedDevice || {
    ip,
    hostname: hostnameOverride,
    ping: null,
    mac: 'N/A',
    vendor: 'Unknown',
    status: 'online',
    discoveryMethod: 'manual'
  };

  const device = {
    ...base,
    ip,
    hostname: hostnameOverride || base.hostname || '',
    manual: true,
    voiceService: { status: 'checking', message: 'Checking Voice Service...' },
    lastSeen: Date.now()
  };

  devices.set(ip, device);
  renderTable();
  appendLog(`Manually added device: ${ip}`);

  // Kick a voice-service check for the newly-added device too, same as a
  // freshly-discovered scan result would get.
  window.api.checkServiceDevice(ip).then((result) => {
    if (result.success) {
      const existing = devices.get(ip);
      if (existing) {
        existing.voiceService = result.data;
        renderTable();
      }
    }
  });

  closeAddDeviceDialog();
});

// ---------------------------------------------------------------------------
// IPC event subscriptions (progress/log/device streaming from main process)
// ---------------------------------------------------------------------------
window.api.onScanProgress(({ done, total }) => {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  el.progressFill.style.width = `${pct}%`;
  el.statusCount.textContent = `${done} / ${total}`;
});

window.api.onDeviceFound((device) => {
  // A newly-discovered device hasn't been probed for the Voice Service yet;
  // main.js kicks that check off immediately, but give it a "checking" state
  // right away so the row doesn't flash blank while we wait for the result.
  device.voiceService = { status: 'checking', message: 'Checking Voice Service...' };
  devices.set(device.ip, device);
  renderTable();
});

window.api.onServiceStatusUpdate((result) => {
  const device = devices.get(result.ip);
  if (!device) return; // device left the list (e.g. pruned) before the check finished
  device.voiceService = result;
  renderTable();
});

window.api.onScanLog((message) => appendLog(message));

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
(async function init() {
  appendLog('Application started.');
  await loadNetworkInfo();
  el.statusText.textContent = 'Idle';
})();
