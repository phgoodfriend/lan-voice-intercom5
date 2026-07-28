'use strict';

/**
 * serviceDiscovery.js
 * Detects whether a discovered LAN device is running the LAN Voice Intercom
 * service. This module ONLY performs detection — no calling, no audio, no
 * WebRTC. It is a read-only probe.
 *
 * Detection is two-stage, matching the spec:
 *   1. Raw TCP connect to the service port (fast, cheap "is anything listening?").
 *   2. If the port is open, an HTTP GET to a lightweight /health or /status
 *      endpoint, expecting a small JSON payload identifying the app.
 *
 * A device is only ever probed here if the LAN Scanner (Phase 1) already
 * found it to be online via ICMP ping — this module does not re-implement
 * host discovery.
 */

const net = require('net');
const http = require('http');
const config = require('./serviceConfig');

// ---------------------------------------------------------------------------
// Low-level probes
// ---------------------------------------------------------------------------

/**
 * Attempts a raw TCP connection to ip:port.
 * Resolves { open: true } on success, or { open: false, reason } on failure.
 * Never rejects/throws.
 */
function tcpProbe(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ open: true }));
    socket.once('timeout', () => finish({ open: false, reason: 'timeout' }));
    socket.once('error', (err) => finish({ open: false, reason: err.code || 'error' }));

    socket.connect(port, ip);
  });
}

/** Maps a raw Node network error code into a human-readable status message. */
function describeError(err) {
  switch (err.code) {
    case 'ECONNREFUSED':
      return 'TCP connection refused.';
    case 'ECONNRESET':
      return 'Connection reset — possible firewall blocking connection.';
    case 'ETIMEDOUT':
      return 'Service timeout.';
    case 'EHOSTUNREACH':
      return 'Host unreachable.';
    default:
      return err.message || 'Unknown connection error.';
  }
}

/**
 * Performs an HTTP GET against ip:port/path expecting a small JSON payload.
 * Resolves { ok: true, data } on a valid 200 + JSON response, or
 * { ok: false, reason } otherwise. Never rejects/throws.
 */
function httpGetJson(ip, port, path, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: ip, port, path, timeout: timeoutMs },
      (res) => {
        // Drain and collect the body.
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          // Guard against a misbehaving/huge response on a non-intercom service.
          if (body.length > 8192) {
            req.destroy();
          }
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve({ ok: false, reason: `Invalid response (HTTP ${res.statusCode}).` });
            return;
          }
          try {
            const json = JSON.parse(body);
            resolve({ ok: true, data: json });
          } catch (err) {
            resolve({ ok: false, reason: 'Invalid response (not valid JSON).' });
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'Service timeout.' });
    });

    req.on('error', (err) => {
      resolve({ ok: false, reason: describeError(err) });
    });
  });
}

// ---------------------------------------------------------------------------
// High-level device check
// ---------------------------------------------------------------------------

/**
 * Checks a single device for a running LAN Voice Intercom service.
 * Assumes the caller has already confirmed the device is online (ICMP alive)
 * — this function does not ping.
 *
 * @param {string} ip
 * @param {object} [opts]
 * @param {function} [opts.onLog] - receives verbose log strings
 * @returns {Promise<object>} result: { ip, status, message, appInfo, checkedAt }
 *   status is one of: 'running' | 'not_installed'
 *   (the caller is responsible for the 'offline' / 'checking' states, since
 *   those depend on ping results and UI timing, not this probe.)
 */
async function checkVoiceService(ip, opts = {}) {
  const { onLog } = opts;
  const port = config.VOICE_SERVICE_PORT;

  onLog && onLog(`Checking Voice Service on ${ip}...`);

  const probe = await tcpProbe(ip, port, config.TCP_CONNECT_TIMEOUT_MS);

  if (!probe.open) {
    const reasonText =
      probe.reason === 'timeout'
        ? 'Connection timed out — port closed or firewall blocking connection.'
        : probe.reason === 'ECONNREFUSED'
        ? 'TCP connection refused. Application not running.'
        : 'Port closed. Application not detected.';

    onLog && onLog(`  ${ip}: ${reasonText}`);

    return {
      ip,
      status: 'not_installed',
      message: reasonText,
      appInfo: null,
      checkedAt: Date.now()
    };
  }

  onLog && onLog(`  ${ip}: TCP connection successful.`);

  // Port is open — try the known health/status endpoints in order.
  for (const path of config.HEALTH_PATHS) {
    const result = await httpGetJson(ip, port, path, config.HTTP_HEALTH_TIMEOUT_MS);

    if (result.ok && result.data && typeof result.data === 'object') {
      const data = result.data;
      const looksLikeIntercom = Boolean(data.appName || data.app || data.service);

      if (looksLikeIntercom) {
        onLog && onLog(`  ${ip}: Health check passed. Voice Service detected.`);
        return {
          ip,
          status: 'running',
          message: 'Voice Service detected.',
          appInfo: {
            appName: data.appName || data.app || data.service || 'LAN Voice Intercom',
            version: data.version || 'Unknown',
            computerName: data.computerName || data.hostname || null,
            listeningPort: data.port || port,
            deviceId: data.deviceId || data.id || null
          },
          checkedAt: Date.now()
        };
      }
    }
  }

  // Port was open but nothing we asked responded with a recognizable payload —
  // most likely a different service is using this port.
  onLog && onLog(`  ${ip}: Port open, but application not detected (invalid response).`);
  return {
    ip,
    status: 'not_installed',
    message: 'Port open, but response was invalid or unrecognized.',
    appInfo: null,
    checkedAt: Date.now()
  };
}

// ---------------------------------------------------------------------------
// Bounded-concurrency batch runner (independent from the Phase 1 ping pool)
// ---------------------------------------------------------------------------

/**
 * Runs checkVoiceService over many devices with a concurrency cap so we
 * never open hundreds of sockets at once. Calls onResult(result) as each
 * device finishes; never blocks the caller's event loop.
 *
 * @param {string[]} ips
 * @param {object} opts - { onResult, onLog, concurrency, shouldStop }
 */
async function checkVoiceServiceBatch(ips, opts = {}) {
  const {
    onResult,
    onLog,
    concurrency = config.SERVICE_CHECK_CONCURRENCY,
    shouldStop = () => false
  } = opts;

  let index = 0;
  let active = 0;

  return new Promise((resolve) => {
    function next() {
      if (shouldStop()) {
        if (active === 0) resolve();
        return;
      }
      if (index >= ips.length && active === 0) {
        resolve();
        return;
      }
      while (active < concurrency && index < ips.length) {
        const ip = ips[index++];
        active++;
        checkVoiceService(ip, { onLog })
          .then((result) => {
            active--;
            if (onResult) onResult(result);
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

module.exports = {
  checkVoiceService,
  checkVoiceServiceBatch
};
