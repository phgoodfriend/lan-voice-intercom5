'use strict';

/**
 * ipUtils.js
 * Pure helper functions for IPv4 arithmetic. No external dependencies.
 */

/** Convert "a.b.c.d" -> 32-bit unsigned integer */
function ipToLong(ip) {
  const parts = ip.split('.').map(Number);
  return (
    ((parts[0] << 24) >>> 0) +
    ((parts[1] << 16) >>> 0) +
    ((parts[2] << 8) >>> 0) +
    (parts[3] >>> 0)
  ) >>> 0;
}

/** Convert 32-bit unsigned integer -> "a.b.c.d" */
function longToIp(long) {
  return [
    (long >>> 24) & 255,
    (long >>> 16) & 255,
    (long >>> 8) & 255,
    long & 255
  ].join('.');
}

/** Convert a dotted subnet mask (e.g. 255.255.255.0) into CIDR prefix length (e.g. 24) */
function netmaskToCidr(netmask) {
  const long = ipToLong(netmask);
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if ((long >>> i) & 1) bits++;
    else break;
  }
  return bits;
}

/**
 * Given an IP and subnet mask, calculate the usable host range.
 * Returns { network, broadcast, firstHost, lastHost, totalHosts, cidr }
 */
function calculateNetworkRange(ip, netmask) {
  const ipLong = ipToLong(ip);
  const maskLong = ipToLong(netmask);

  const networkLong = (ipLong & maskLong) >>> 0;
  const broadcastLong = (networkLong | (~maskLong >>> 0)) >>> 0;

  const cidr = netmaskToCidr(netmask);

  // For very small subnets (/31, /32) there are no usable host ranges in the classic sense.
  let firstHostLong = networkLong;
  let lastHostLong = broadcastLong;
  if (cidr <= 30) {
    firstHostLong = networkLong + 1;
    lastHostLong = broadcastLong - 1;
  }

  return {
    network: longToIp(networkLong),
    broadcast: longToIp(broadcastLong),
    firstHost: longToIp(firstHostLong),
    lastHost: longToIp(lastHostLong),
    totalHosts: Math.max(0, lastHostLong - firstHostLong + 1),
    cidr
  };
}

/**
 * Generate a flat array of every host IP string between firstHost and lastHost (inclusive).
 * Caps at 65536 addresses as a safety guard against accidentally scanning huge ranges.
 */
function enumerateHosts(firstHost, lastHost) {
  const start = ipToLong(firstHost);
  const end = ipToLong(lastHost);
  const hosts = [];
  const max = Math.min(end, start + 65535);
  for (let cur = start; cur <= max; cur++) {
    hosts.push(longToIp(cur));
  }
  return hosts;
}

module.exports = {
  ipToLong,
  longToIp,
  netmaskToCidr,
  calculateNetworkRange,
  enumerateHosts
};
