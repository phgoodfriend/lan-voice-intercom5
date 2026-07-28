'use strict';

/**
 * serviceConfig.js
 * Central configuration for LAN Voice Intercom service discovery.
 * Phase 2 only DETECTS the service — it does not implement it.
 * These values describe the contract a real Phase 3 service is expected
 * to follow so this scanner can find it.
 */

module.exports = {
  // TCP port the LAN Voice Intercom service is expected to listen on.
  VOICE_SERVICE_PORT: 47811,

  // How long to wait for a raw TCP connection before declaring the port closed.
  TCP_CONNECT_TIMEOUT_MS: 600,

  // How long to wait for a health/status HTTP response before timing out.
  HTTP_HEALTH_TIMEOUT_MS: 1200,

  // Endpoints checked in order; first one that returns a valid payload wins.
  HEALTH_PATHS: ['/health', '/status'],

  // Max simultaneous service checks in flight (separate pool from the ping sweep).
  SERVICE_CHECK_CONCURRENCY: 24
};
