'use strict';

/**
 * dev-tools/mock-voice-service.js
 *
 * NOT part of the LAN Voice Intercom app itself, and not started by it.
 * This is a throwaway standalone HTTP server you can run on a second
 * machine (or a second terminal on the same machine) to sanity-check that
 * the Phase 2 service discovery logic correctly finds it.
 *
 * It listens on the same port/paths that src/serviceConfig.js expects and
 * answers with the JSON shape checkVoiceService() looks for. Phase 3 will
 * replace this with the real service; this file exists purely for testing.
 *
 * Usage:
 *   node dev-tools/mock-voice-service.js
 */

const http = require('http');
const os = require('os');
const config = require('../src/serviceConfig');

const payload = {
  appName: 'LAN Voice Intercom',
  version: '0.1.0-dev',
  computerName: os.hostname(),
  port: config.VOICE_SERVICE_PORT,
  deviceId: 'dev-' + Math.random().toString(16).slice(2, 10)
};

const server = http.createServer((req, res) => {
  if (config.HEALTH_PATHS.includes(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(config.VOICE_SERVICE_PORT, () => {
  console.log(`Mock LAN Voice Intercom service listening on port ${config.VOICE_SERVICE_PORT}`);
  console.log(`Health paths: ${config.HEALTH_PATHS.join(', ')}`);
});
