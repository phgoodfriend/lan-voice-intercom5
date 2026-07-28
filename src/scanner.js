'use strict';

/**
 * scanner.js
 * Fast, concurrent LAN scanner for Windows.
 *
 * Strategy:
 *  1. Enumerate every host IP in the subnet range.
 *  2. Ping all hosts concurrently using a bounded worker pool (not one at a
 *     time) so a /24 network scans in a few seconds instead of minutes.
 *  3. For hosts that reply, resolve hostname (dns.reverse, short timeout)
 *     in parallel.
 *  4. After the sweep, run a single `arp -a` pass to harvest MAC addresses
 *     for everything that replied (much cheaper than one arp call per host).
 *  5. Look up vendor name from the MAC OUI table.
 *
 * The scan is cancellable via an AbortController-like `scanState` object
 * so the UI can implement "Stop Scan" without freezing.
 */

const { exec } = require('child_process');
const net = require('net');
const dns = require('dns');
const os = require('os');
const util = require('util');
const { enumerateHosts } = require('./ipUtils');
const { lookupVendor, normalizeMac } = require('./ouiVendors');

const execPromise = util.promisify(exec);
const dnsReversePromise = util.promisify(dns.reverse);

const CONCURRENCY = 64; // number of simultaneous pings in flight
const PING_TIMEOUT_MS = 800;
const PING_RETRIES = 2; // total attempts per host, not additional retries
const HOSTNAME_TIMEOUT_MS = 1200;
const TCP_PROBE_TIMEOUT_MS = 600;

/**
 * Runs a single ICMP ping using the OS `ping` command (Windows syntax).
 * Returns { alive, timeMs } - never throws, resolves false on any failure.
 */
async function pingHost(ip) {
  const isWin = os.platform() === 'win32';
  const cmd = isWin
    ? `ping -n 1 -w ${PING_TIMEOUT_MS} ${ip}`
    : `ping -c 1 -W ${Math.ceil(PING_TIMEOUT_MS / 1000)} ${ip}`;

  try {
    const { stdout } = await execPromise(cmd, { windowsHide: true, timeout: PING_TIMEOUT_MS + 500 });

    // Windows: "Reply from 192.168.1.1: bytes=32 time=1ms TTL=64"
    // or "time<1ms"
    const timeMatch = stdout.match(/time[<=]([\d.]+)\s*ms/i);
    const replyDetected = /Reply from/i.test(stdout) || /bytes from/i.test(stdout);

    if (replyDetected) {
      return { alive: true, timeMs: timeMatch ? parseFloat(timeMatch[1]) : null };
    }
    return { alive: false, timeMs: null };
  } catch (err) {
    return { alive: false, timeMs: null };
  }
}

/**
 * Pings a host up to PING_RETRIES times, returning as soon as one succeeds.
 *
 * This exists because a single ping attempt against a host the OS hasn't
 * talked to yet frequently fails even though the host is alive: the very
 * first packet can be lost while ARP resolves the MAC address for that IP,
 * especially under the higher concurrency used here. A bare one-shot ping
 * sweep silently drops those hosts. Retrying costs nothing for hosts that
 * answer immediately (the common case) and only adds latency for hosts that
 * needed the retry, so overall scan time stays close to the original target.
 */
async function pingHostReliable(ip) {
  let lastResult = { alive: false, timeMs: null };
  for (let attempt = 1; attempt <= PING_RETRIES; attempt++) {
    lastResult = await pingHost(ip);
    if (lastResult.alive) return lastResult;
  }
  return lastResult;
}

/**
 * Generic raw TCP connect probe — used for the optional "Port" field in
 * Advanced Scan / Add Device, as a supplementary liveness signal for hosts
 * that have ICMP disabled by firewall policy but still have a TCP service
 * open. Resolves { open: boolean }, never throws.
 */
function tcpConnectCheck(ip, port, timeoutMs = TCP_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ open });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, ip);
  });
}

/**
 * Attempts reverse DNS lookup for a hostname, with a hard timeout so a slow
 * or unresponsive resolver can never freeze the scan.
 */
async function resolveHostname(ip) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), HOSTNAME_TIMEOUT_MS));
  try {
    const result = await Promise.race([dnsReversePromise(ip), timeout]);
    if (result && result.length > 0) return result[0];
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Runs `arp -a` once and returns a Map of ip -> mac (normalized uppercase).
 */
async function getArpTable() {
  const map = new Map();
  try {
    const { stdout } = await execPromise('arp -a', { windowsHide: true });
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      // Windows format:  192.168.200.141      00-1a-2b-3c-4d-5e     dynamic
      const match = line.match(/(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F-]{11,17})/);
      if (match) {
        map.set(match[1], normalizeMac(match[2]));
      }
    }
  } catch (err) {
    // arp not available or failed - MAC addresses will simply be unavailable.
  }
  return map;
}

/**
 * Runs a bounded-concurrency worker pool over an array of items.
 * `onItemDone` is called after each item resolves, useful for progress events.
 */
async function runPool(items, concurrency, worker, onItemDone, shouldStop) {
  let index = 0;
  let active = 0;

  return new Promise((resolve) => {
    function next() {
      if (shouldStop && shouldStop()) {
        if (active === 0) resolve();
        return;
      }
      if (index >= items.length && active === 0) {
        resolve();
        return;
      }
      while (active < concurrency && index < items.length) {
        const item = items[index++];
        active++;
        worker(item)
          .then((result) => {
            active--;
            if (onItemDone) onItemDone(item, result);
            next();
          })
          .catch(() => {
            active--;
            next();
          });
      }
    }
    next();
  });
}

/**
 * Full network scan. Streams progress via callbacks so the caller (IPC layer)
 * can push live updates to the renderer without blocking the UI thread.
 *
 * @param {string} firstHost - first IP in range
 * @param {string} lastHost - last IP in range
 * @param {object} callbacks - { onProgress(done, total), onDeviceFound(device) }
 * @param {function} shouldStop - function returning true if scan should abort
 * @param {object} [options] - { port: number|null } optional supplementary TCP check
 */
async function scanNetwork(firstHost, lastHost, callbacks = {}, shouldStop = () => false, options = {}) {
  const { onProgress, onDeviceFound, onLog } = callbacks;
  const { port } = options;
  const hosts = enumerateHosts(firstHost, lastHost);
  const total = hosts.length;
  let done = 0;

  const methodDescription = port
    ? `ICMP Ping (2x retry) + ARP cross-reference + TCP port ${port}`
    : 'ICMP Ping (2x retry) + ARP cross-reference';

  onLog && onLog(`Scanning ${total} hosts across ${firstHost} - ${lastHost}...`);
  onLog && onLog(`Method: ${methodDescription}`);

  // Map of ip -> { pingResult, tcpOpen } for every host we actively probed.
  const probedResults = new Map();

  await runPool(
    hosts,
    CONCURRENCY,
    async (ip) => {
      if (shouldStop()) return null;
      const pingResult = await pingHostReliable(ip);
      let tcpOpen = false;
      // Only bother with the extra TCP probe for hosts ICMP already missed —
      // if ping succeeded we already know the host is alive.
      if (!pingResult.alive && port) {
        const tcpResult = await tcpConnectCheck(ip, port);
        tcpOpen = tcpResult.open;
      }
      return { ip, pingResult, tcpOpen };
    },
    (ip, result) => {
      done++;
      if (onProgress) onProgress(done, total);
      if (result) {
        probedResults.set(result.ip, result);
        if (result.pingResult.alive) {
          onLog && onLog(`Host found: ${result.ip}`);
        } else if (result.tcpOpen) {
          onLog && onLog(`Host found via TCP port ${port}: ${result.ip} (no ICMP reply)`);
        }
      }
    },
    shouldStop
  );

  if (shouldStop()) {
    onLog && onLog('Scan stopped by user.');
    return [];
  }

  const respondedHosts = hosts.filter((ip) => {
    const r = probedResults.get(ip);
    return r && (r.pingResult.alive || r.tcpOpen);
  });

  onLog && onLog(
    `Ping sweep complete. ${respondedHosts.length} host(s) responded. Reading ARP table for additional devices...`
  );

  // Read the ARP table now — the ping sweep we just ran forces an ARP
  // resolution attempt for every host on the local subnet even when the
  // ICMP echo itself is blocked by a host firewall (very common on Windows
  // machines with default Windows Defender Firewall rules). Any IP with a
  // valid, resolved MAC entry in the ARP cache is therefore a real device on
  // the LAN, whether or not it replied to ping — this is what recovers the
  // devices a ping-only scan silently misses.
  const arpTable = await getArpTable();
  const hostSet = new Set(hosts);
  const arpOnlyIps = [];

  for (const [ip, mac] of arpTable.entries()) {
    if (!hostSet.has(ip)) continue; // outside the scanned range
    if (probedResults.has(ip) && (probedResults.get(ip).pingResult.alive || probedResults.get(ip).tcpOpen)) continue; // already counted
    if (!mac || mac === '00:00:00:00:00:00' || mac === 'FF:FF:FF:FF:FF:FF') continue; // incomplete/broadcast entry
    arpOnlyIps.push(ip);
  }

  if (arpOnlyIps.length > 0) {
    onLog && onLog(`ARP table revealed ${arpOnlyIps.length} additional device(s) not responding to ICMP.`);
  }

  const allAliveIps = [...respondedHosts, ...arpOnlyIps];

  onLog && onLog(`Resolving hostnames for ${allAliveIps.length} device(s)...`);

  // Resolve hostnames concurrently for every device we're going to report.
  const hostnameResults = new Map();
  await runPool(
    allAliveIps,
    CONCURRENCY,
    async (ip) => {
      const hostname = await resolveHostname(ip);
      return { ip, hostname };
    },
    (ip, result) => {
      if (result && result.hostname) {
        hostnameResults.set(result.ip, result.hostname);
        onLog && onLog(`Hostname resolved: ${result.ip} -> ${result.hostname}`);
      }
    },
    shouldStop
  );

  const devices = allAliveIps.map((ip) => {
    const probed = probedResults.get(ip);
    const mac = arpTable.get(ip) || '';
    const vendor = mac ? lookupVendor(mac) : 'Unknown';
    const hostname = hostnameResults.get(ip) || '';

    let ping = null;
    let discoveryMethod = 'arp';
    if (probed && probed.pingResult.alive) {
      ping = probed.pingResult.timeMs;
      discoveryMethod = 'icmp';
    } else if (probed && probed.tcpOpen) {
      discoveryMethod = 'tcp';
    }

    const device = {
      ip,
      hostname,
      ping,
      mac: mac || 'N/A',
      vendor,
      status: 'online',
      discoveryMethod,
      lastSeen: Date.now()
    };

    if (onDeviceFound) onDeviceFound(device);
    return device;
  });

  onLog && onLog(`Scan complete. ${devices.length} device(s) found.`);

  return devices;
}

/**
 * Detailed ping test for a single device (used by the per-row "Ping" button).
 * Sends `count` pings and reports min/max/avg/loss.
 */
async function detailedPing(ip, count = 4) {
  const results = [];
  for (let i = 0; i < count; i++) {
    const result = await pingHost(ip);
    results.push(result);
  }

  const times = results.filter((r) => r.alive && r.timeMs !== null).map((r) => r.timeMs);
  const received = results.filter((r) => r.alive).length;
  const lost = count - received;
  const lossPct = Math.round((lost / count) * 100);

  if (times.length === 0) {
    return {
      ip,
      sent: count,
      received,
      lost,
      lossPct,
      min: null,
      max: null,
      avg: null,
      reachable: false
    };
  }

  return {
    ip,
    sent: count,
    received,
    lost,
    lossPct,
    min: Math.min(...times),
    max: Math.max(...times),
    avg: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10,
    reachable: true
  };
}

/**
 * Full on-demand check for a single, manually-entered IP (Add Device dialog's
 * "Verify" button). Runs the same detection used during a full scan — ping,
 * optional TCP port probe, ARP/vendor lookup, hostname — for just this host.
 *
 * @param {string} ip
 * @param {object} [opts] - { port: number|null, hostnameOverride: string|null }
 */
async function verifyDevice(ip, opts = {}) {
  const { port, hostnameOverride } = opts;

  const pingResult = await pingHostReliable(ip);

  let tcpOpen = false;
  if (port) {
    const tcpResult = await tcpConnectCheck(ip, port);
    tcpOpen = tcpResult.open;
  }

  const reachable = pingResult.alive || tcpOpen;

  // A single-host arp -a still returns the whole table, but it's cheap and
  // guarantees we pick up an ARP entry for this IP if one exists (the ping
  // attempt above will have triggered ARP resolution for it either way).
  const arpTable = await getArpTable();
  const mac = arpTable.get(ip) || '';
  const vendor = mac ? lookupVendor(mac) : 'Unknown';

  const hostname = hostnameOverride || (await resolveHostname(ip)) || '';

  return {
    ip,
    hostname,
    ping: pingResult.alive ? pingResult.timeMs : null,
    mac: mac || 'N/A',
    vendor,
    status: reachable ? 'online' : 'offline',
    discoveryMethod: pingResult.alive ? 'icmp' : tcpOpen ? 'tcp' : 'none',
    reachable,
    lastSeen: Date.now()
  };
}

module.exports = {
  scanNetwork,
  detailedPing,
  verifyDevice,
  pingHost,
  pingHostReliable,
  tcpConnectCheck,
  resolveHostname,
  getArpTable
};
