# LAN Voice Intercom — Scanner (Phase 1 + Phase 2 + Phase 1 fixes)

A professional LAN discovery tool built with **Electron + Node.js**, styled after
Advanced IP Scanner.

- **Phase 1**: network scanning (adapter detection, ping sweep, hostname/MAC/vendor lookup).
- **Phase 2**: on top of every device Phase 1 finds, automatically detects whether
  it's running the LAN Voice Intercom service (TCP probe + `/health`/`/status`
  check) and enables/disables a Call button accordingly.
- **This build**: fixes two Phase 1 bugs (missed devices, wrong local IP) and adds
  Advanced Scan (manual network settings + IP range) and Add Device (manually add
  a host by IP).

Voice calling, chat, microphone access, and WebRTC are still **not** implemented —
this remains detection/scanning only.

## What was fixed

**"Not all devices are found"** — the ping sweep now retries each host once before
giving up (a lone first packet frequently gets lost to ARP-resolution delay under
high concurrency, silently dropping live hosts), and — more importantly — the ARP
table is now cross-referenced after every sweep: a ping forces ARP resolution for
every host on the local subnet even when the ICMP *reply* itself is blocked by a
host firewall (the default on most Windows machines), so any IP with a real ARP
entry is now reported as a device even if it never answered ping. Optionally
supplying a port (Advanced Scan / Add Device) adds a third detection path — a raw
TCP connect — for hosts that block both ICMP and ARP discovery some other way.

**"Local PC IP is wrong"** — adapter selection previously trusted
`os.networkInterfaces()` order and the first `ipconfig` block that happened to
list *any* gateway, which can pick a statically-configured but disconnected
adapter over the one actually carrying traffic. It now cross-references
`route print -4`'s `0.0.0.0/0.0.0.0` entry — the OS's own record of which adapter
handles outbound traffic right now — and falls back to the old heuristic only if
that lookup fails.

## Advanced Scan & Add Device (new)

- **Advanced Scan** panel (toolbar → *⚙ Advanced Scan*): shows the auto-detected
  Current IP / Subnet / Gateway / Start IP / End IP, all editable, plus an
  optional Port for the supplementary TCP check. *Detect Automatically* re-pulls
  the real adapter info; *Reset* restores it into the fields; *Scan* runs a fully
  manual-range scan without touching the automatic values shown in the top panel.
- **Add Device** (toolbar → *➕ Add Device*): enter an IP (+ optional hostname/port),
  *Ping* for a quick reachability check, *Verify* for the full ping+ARP+vendor+
  hostname probe, then *Add* to insert it into the table regardless of whether the
  automatic scan found it. Manually-added devices are protected from being pruned
  by the next automatic scan's "remove offline devices" step.



## Requirements

- Windows 10/11 (uses `ipconfig`, `ping`, and `arp` under the hood)
- Node.js 18+ and npm

## Setup

```bash
cd lan-scanner
npm install
npm start
```

This installs Electron locally and launches the app.

## What's implemented

| Feature | Where |
|---|---|
| Active adapter / IP / subnet / gateway / MAC detection (filters out loopback, APIPA, Docker, VMware, VirtualBox, Hyper-V, VPN adapters) | `src/networkInfo.js` |
| Subnet range calculation from IP + netmask | `src/ipUtils.js` |
| Concurrent ping sweep (64 hosts in flight at once, ~seconds for a /24) | `src/scanner.js` |
| Hostname resolution (reverse DNS, timeboxed) | `src/scanner.js` |
| MAC address harvesting via a single `arp -a` pass after the sweep | `src/scanner.js` |
| MAC → vendor lookup (offline OUI table) | `src/ouiVendors.js` |
| Search by IP/hostname, Auto Scan every 5s, Stop Scan, Clear Results | `renderer/renderer.js` |
| Per-device detailed Ping tool (min/max/avg/loss) | `src/scanner.js` (`detailedPing`) + Ping modal in UI |
| Device Details modal (double-click a row) | `renderer/renderer.js` |
| Diagnostics panel + verbose log panel | `renderer/index.html` / `renderer.js` |
| Progress bar, live count, elapsed time | status bar in `renderer/index.html` |

## Architecture notes

- **Main process** (`main.js`) owns all networking/child-process work and streams
  progress to the renderer via IPC events (`scan:progress`, `scan:device-found`,
  `scan:log`) so the UI thread is never blocked.
- **Renderer** (`renderer/`) is plain HTML/CSS/JS — no framework — talking to the
  main process only through the safe `window.api` bridge defined in `preload.js`
  (`contextIsolation: true`, no direct Node access from the page).
- **Scanning strategy**: enumerate every host in the subnet → ping all of them
  concurrently with a bounded worker pool (default 64 in flight) → resolve
  hostnames for hosts that replied → one `arp -a` pass to grab MACs → look up
  vendor from the offline OUI table. This avoids scanning one IP at a time and
  avoids one `arp` call per host, which is what keeps a /24 scan fast.
- **Stop Scan** sets a flag checked by the worker pool between ping dispatches,
  so cancellation is cooperative and immediate rather than killing processes.

## Phase 2 — Voice Service discovery

| Feature | Where |
|---|---|
| TCP port probe + `/health` \| `/status` HTTP check | `src/serviceDiscovery.js` |
| Service port / timeouts / endpoint config | `src/serviceConfig.js` |
| Per-device check dispatched the instant the ping sweep finds it (streamed, non-blocking) | `main.js` (`beginServiceCheckFor`) |
| Voice Service column (🟢 Running / 🟡 Checking / 🔴 Not Installed / ⚪ Offline) | `renderer/index.html` + `renderer.js` |
| Call button — enabled only when Voice Service is Running | `renderer/renderer.js` |
| Extended Device Details (app name, version, listening port, device ID, last seen) | `renderer/index.html` modal |
| Distinct error messages: refused, timeout, firewall (reset), invalid response, host unreachable | `src/serviceDiscovery.js` (`describeError`) |

**How discovery works:** for every host the (unmodified) Phase 1 ping sweep
finds alive, `main.js` immediately — without waiting for the whole sweep to
finish — opens a raw TCP connection to the configured port
(`src/serviceConfig.js`, default `47811`). If nothing answers, the device is
`Not Installed`. If the port is open, it fetches `/health` then `/status` and
expects a small JSON payload with at least an `appName` (or `app`/`service`)
field; a valid payload means `Running` and its `version`/`computerName`/`port`/
`deviceId` populate the Device Details dialog. Every check streams its result
back to the renderer over IPC (`service:status-update`) the moment it resolves,
so nothing blocks the UI and the table fills in progressively.

**Auto Scan** already re-runs the full scan (and therefore every service
check) every 5 seconds, which naturally covers newly-started/-stopped services
and devices joining/leaving the network without any extra polling logic.

**Testing without a real Phase 3 service:** `dev-tools/mock-voice-service.js`
is a throwaway HTTP server (not part of the app, not started by it) that
answers on the configured port/paths with a valid payload, so you can point
the scanner at a machine running it and see a device go 🟢 Running end-to-end.
Run it with `node dev-tools/mock-voice-service.js`.

## Known limitations

- The bundled OUI vendor table covers common consumer/enterprise vendors, not
  the full IEEE registry (40,000+ entries) — unrecognized prefixes show `Unknown`.
- ICMP ping can be blocked by Windows Firewall on some networks/devices; hosts
  that don't respond to ICMP but are otherwise online may not appear. The ping
  tool will show 100% packet loss rather than freezing in that case.
- Hostname resolution depends on the OS resolver / DNS reachability; devices
  without reverse DNS entries show "Unknown" hostname (their IP is still shown).

- The ⚪ Offline Voice Service state is defined in the UI/badge styling but
  won't currently appear in practice: Phase 1's Auto Scan removes devices
  entirely once they stop responding to ping rather than keeping an offline
  row, so there's no "online host, but ping just failed" row to show it on.
  If a future phase keeps offline rows visible, this state is already wired up.
  (Manually-added devices are the one exception — they're never pruned.)
- The service port (`47811`) is a placeholder default until Phase 3 defines
  the real service; change it in `src/serviceConfig.js` if needed.
- Health-check "app detection" trusts any JSON payload with an `appName`
  field — it's a lightweight identification check, not authentication.
- ARP-only device discovery (devices found via the ARP table but not ICMP)
  depends on the OS having already attempted to talk to that IP recently —
  our own ping sweep guarantees this for the current scan, but a device that
  joined the network and was never pinged by anyone won't have an ARP entry
  yet on the very first pass. In practice this only means "found `arp`-only
  devices might take one full scan cycle to first appear," not that they're
  missed permanently.
- `route print -4` parsing (used to pick the correct adapter) assumes a
  standard Windows `route print` table format; on non-English Windows
  locales the table layout is typically the same but hasn't been verified
  here — the ipconfig-based fallback covers that case if the route-table
  method doesn't match anything.

## Next phases (not in this build)

- Voice calling over LAN
- Text chat
- Microphone capture / WebRTC transport
