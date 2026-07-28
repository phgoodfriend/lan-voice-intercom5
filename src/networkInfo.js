'use strict';

/**
 * networkInfo.js
 * Detects the active physical network adapter (Ethernet or Wi-Fi), its IPv4
 * address, subnet mask, MAC address, default gateway and computed CIDR/range.
 *
 * Virtual adapters (VMware, VirtualBox, Hyper-V, Docker, VPN/TAP, loopback,
 * APIPA, disabled adapters) are filtered out.
 */

const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const { calculateNetworkRange, netmaskToCidr } = require('./ipUtils');

const execPromise = util.promisify(exec);

// Adapter *interface name* patterns that indicate a virtual / non-physical adapter.
const VIRTUAL_NAME_PATTERNS = [
  /virtualbox/i,
  /vmware/i,
  /vethernet/i,
  /hyper-v/i,
  /docker/i,
  /npcap/i,
  /loopback/i,
  /tap-windows/i,
  /tunnel/i,
  /pseudo/i,
  /wsl/i,
  /bluetooth/i,
  /vpn/i
];

function isApipa(ip) {
  return ip.startsWith('169.254.');
}

function isVirtualAdapterName(name) {
  return VIRTUAL_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Runs `ipconfig /all` and returns the raw text output.
 * Windows-only, as required by the spec (Windows 10/11 target).
 */
async function getIpconfigOutput() {
  try {
    const { stdout } = await execPromise('ipconfig /all', { windowsHide: true });
    return stdout;
  } catch (err) {
    throw new Error('Failed to run ipconfig. Is this running on Windows? ' + err.message);
  }
}

/**
 * Parses `ipconfig /all` output into per-adapter text blocks.
 */
function splitAdaptersFromIpconfig(raw) {
  // Adapter blocks start with a line like:
  // "Ethernet adapter Ethernet:" or "Wireless LAN adapter Wi-Fi:"
  const lines = raw.split(/\r?\n/);
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const headerMatch = line.match(/^([A-Za-z].*adapter.*):\s*$/);
    if (headerMatch) {
      if (current) blocks.push(current);
      current = { header: headerMatch[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/**
 * Runs `route print -4` and returns the parsed 0.0.0.0/0.0.0.0 default
 * route(s): [{ gateway, interfaceIp, metric }]. This is the ground truth
 * for "which adapter actually carries LAN traffic right now" — unlike
 * os.networkInterfaces(), which can list a statically-configured but
 * disconnected adapter's leftover IP/gateway as if it were live. Sorting by
 * metric mirrors how Windows itself picks the active default gateway when
 * more than one adapter is up.
 */
async function getDefaultRoutes() {
  try {
    const { stdout } = await execPromise('route print -4', { windowsHide: true });
    const lines = stdout.split(/\r?\n/);
    const routes = [];

    for (const line of lines) {
      const match = line.match(
        /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s*$/
      );
      if (match) {
        routes.push({ gateway: match[1], interfaceIp: match[2], metric: parseInt(match[3], 10) });
      }
    }

    routes.sort((a, b) => a.metric - b.metric);
    return routes;
  } catch (err) {
    return [];
  }
}

/**
 * Parses the "DNS Servers" entry (and any indented continuation lines that
 * list additional servers) out of an ipconfig adapter block.
 */
function extractDnsServers(blockText) {
  const lines = blockText.split('\n');
  const servers = [];
  let inDnsSection = false;

  for (const line of lines) {
    const dnsMatch = line.match(/DNS Servers[.\s]*:\s*([0-9.]+)/i);
    if (dnsMatch) {
      servers.push(dnsMatch[1].trim());
      inDnsSection = true;
      continue;
    }
    if (inDnsSection) {
      // Continuation lines are just an indented IP with no label.
      const continuation = line.match(/^\s{2,}([0-9]{1,3}(?:\.[0-9]{1,3}){3})\s*$/);
      if (continuation) {
        servers.push(continuation[1].trim());
        continue;
      }
      inDnsSection = false;
    }
  }

  return servers;
}

/**
 * Given the parsed adapter blocks and the target IPv4 address, find the
 * matching block and extract Default Gateway + Physical (MAC) Address + DNS.
 */
function extractGatewayAndMacForIp(blocks, targetIp) {
  for (const block of blocks) {
    const text = block.lines.join('\n');
    const hasIp = text.includes(targetIp);
    if (!hasIp) continue;

    const gatewayMatch = text.match(/Default Gateway[.\s]*:\s*([0-9.]+)/i);
    const macMatch = text.match(/Physical Address[.\s]*:\s*([0-9A-Fa-f-]+)/i);
    const dnsServers = extractDnsServers(text);

    return {
      gateway: gatewayMatch ? gatewayMatch[1].trim() : null,
      mac: macMatch ? macMatch[1].trim().replace(/-/g, ':').toUpperCase() : null,
      adapterDescription: block.header,
      dnsServers
    };
  }
  return { gateway: null, mac: null, adapterDescription: null, dnsServers: [] };
}

/**
 * Picks the best candidate physical adapter from os.networkInterfaces().
 * Preference order: adapter that is not virtual, not internal, IPv4, not APIPA.
 */
function findCandidateAdapters() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrList] of Object.entries(interfaces)) {
    if (isVirtualAdapterName(name)) continue;

    for (const addr of addrList) {
      if (addr.family !== 'IPv4') continue;
      if (addr.internal) continue;
      if (isApipa(addr.address)) continue;

      candidates.push({ name, ...addr });
    }
  }

  return candidates;
}

/**
 * Main export: detects the active adapter and returns a full info object.
 */
async function getActiveNetworkInfo() {
  const candidates = findCandidateAdapters();

  if (candidates.length === 0) {
    throw new Error(
      'No active Ethernet or Wi-Fi adapter was found. Please check that you are connected to a network.'
    );
  }

  const ipconfigRaw = await getIpconfigOutput();
  const blocks = splitAdaptersFromIpconfig(ipconfigRaw);

  let chosen = null;
  let gatewayInfo = { gateway: null, mac: null, adapterDescription: null, dnsServers: [] };

  // --- Primary method: match the OS's actual default route -----------------
  // This is the fix for "wrong local IP": os.networkInterfaces() can list a
  // statically-configured but physically disconnected adapter's leftover
  // IP/gateway. The routing table only lists the adapter Windows is actually
  // using right now, so cross-referencing it against our candidate list is
  // the most reliable way to pick the true active LAN adapter.
  const defaultRoutes = await getDefaultRoutes();
  for (const route of defaultRoutes) {
    const match = candidates.find((c) => c.address === route.interfaceIp);
    if (match) {
      chosen = match;
      gatewayInfo = extractGatewayAndMacForIp(blocks, match.address);
      if (!gatewayInfo.gateway) gatewayInfo.gateway = route.gateway;
      break;
    }
  }

  // --- Fallback: adapter whose ipconfig block itself lists a gateway -------
  if (!chosen) {
    for (const candidate of candidates) {
      const info = extractGatewayAndMacForIp(blocks, candidate.address);
      if (info.gateway) {
        chosen = candidate;
        gatewayInfo = info;
        break;
      }
    }
  }

  // --- Last resort: just take the first non-virtual candidate --------------
  if (!chosen) {
    chosen = candidates[0];
    gatewayInfo = extractGatewayAndMacForIp(blocks, chosen.address);
  }

  const range = calculateNetworkRange(chosen.address, chosen.netmask);
  const cidr = netmaskToCidr(chosen.netmask);

  return {
    hostname: os.hostname(),
    adapterName: chosen.name,
    adapterDescription: gatewayInfo.adapterDescription || chosen.name,
    ip: chosen.address,
    subnetMask: chosen.netmask,
    mac: (gatewayInfo.mac || chosen.mac || '').toUpperCase(),
    gateway: gatewayInfo.gateway || 'Unknown',
    dnsServers: gatewayInfo.dnsServers || [],
    cidr,
    networkRange: `${range.firstHost} - ${range.lastHost}`,
    firstHost: range.firstHost,
    lastHost: range.lastHost,
    networkAddress: range.network,
    broadcastAddress: range.broadcast,
    totalHosts: range.totalHosts
  };
}

module.exports = {
  getActiveNetworkInfo
};
