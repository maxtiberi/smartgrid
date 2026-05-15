# SmartGrid Nokia Dashboard

Interactive web dashboard for a Nokia SR-OS smart-grid teleprotection lab.  
Combines animated power-grid simulation with live telemetry from real Nokia SR-1 (srsim) routers, IEC 61850 GOOSE teleprotection monitoring, and per-link fault visualisation.

---

## Contents

1. [Architecture](#architecture)
2. [Network Topology](#network-topology)
3. [Features](#features)
4. [Prerequisites](#prerequisites)
5. [Installation & Startup](#installation--startup)
6. [API Reference](#api-reference)
7. [Configuration](#configuration)
8. [Monitoring Loops](#monitoring-loops)
9. [Teleprotection (IEC 61850 GOOSE)](#teleprotection-iec-61850-goose)
10. [Scripts](#scripts)
11. [File Structure](#file-structure)
12. [Troubleshooting](#troubleshooting)

---

## Architecture

```
 ┌──────────────────────────────────────────────────────────────────┐
 │                        config.json                               │
 │   nodes · links · credentials · RTU endpoints · grid params      │
 └─────────────────────┬────────────────────────────────────────────┘
                       │  loaded at startup by both backend + frontend
                       │
        ┌──────────────▼──────────────────────────────────┐
        │              ping-service.js (port 3000)        │
        │                                                  │
        │  • ICMP ping (whitelisted IPs)                   │
        │  • gNMI via docker exec gnmic (on demand)        │
        │  • /api/mpls/access-health   (10 s poll)         │
        │  • /api/mpls/link-health     (15 s poll)         │
        │  • /api/tpt/*  → proxy to tpt-daemon.py          │
        │  • /gnmic/node/:id  → live node telemetry        │
        │  • /gnmi/status|start|stop  (legacy gNMI svc)    │
        └────────────────────┬────────────────────────────┘
                             │  REST (fetch)
                             ▼
                      smart-grid.js  (browser)
                      SmartGrid class + IIFEs
                             │
                             ▼
                      smart-grid.html  (browser)
                      SVG topology + panels + popups


 Containerlab network (192.168.30.0/24):
 ┌────────────────────────────────────────────────────────────────┐
 │  SR-OS routers (srsim 25.10.R1)  ←─ gNMI :57400 ──► gnmic   │
 │  dc1 dc2 acc1 acc2 a1-1 a1-2 a1-3                             │
 │                                                                │
 │  RTU containers (Linux)                                        │
 │  rtu1 (192.168.30.7)  rtu2 (192.168.30.6)                     │
 │    └─ tpt-daemon.py (HTTP :8850, UDP GOOSE :61850) ──────────► │
 └────────────────────────────────────────────────────────────────┘
```

**Request flow for link health:**
1. Browser polls `/api/mpls/link-health` every 15 s
2. ping-service queries all 7 nodes in parallel via `docker exec gnmic … get --path '/state/port[port-id=*]/oper-state'`
3. Port states are mapped to the 10 logical topology links
4. Browser toggles `.mpls-link-fault` CSS class on each `<line>` element → red blinking indicator

---

## Network Topology

### SR-OS Nodes

| Node key | Container name | IP | Role | Ports (links) |
|---|---|---|---|---|
| mpls-dc1 | DC-1 (dc1) | 192.168.30.2 | Core | c1/1→ACC1, c2/1→DC-2 |
| mpls-dc2 | DC-2 (dc2) | 192.168.30.3 | Core | c1/1→ACC2, c2/1→DC-1 |
| mpls-acc1 | SR1-ACC1 (acc1) | 192.168.30.4 | Aggregation | c1/1→DC-1, c2/1→ACCESS1-1, c3/1→ACC2 |
| mpls-acc2 | SR1-ACC2 (acc2) | 192.168.30.5 | Aggregation | c1/1→DC-2, c2/1→ACCESS1-3, c3/1→ACC1 |
| mpls-a1-1 | ACCESS1-1 | 192.168.30.11 | Access | c1/1→ACCESS1-2, c2/1→ACC1, c3/1→RTU1 |
| mpls-a1-2 | ACCESS1-2 | 192.168.30.12 | Access | c1/1→ACCESS1-1, c2/1→ACCESS1-3 |
| mpls-a1-3 | ACCESS1-3 | 192.168.30.13 | Access | c1/1→ACCESS1-2, c2/1→ACC2, c3/1→RTU2 |

### Infrastructure

| Container | IP | Role |
|---|---|---|
| gnmic | 192.168.30.10 | gNMI collector (gnmic binary at /app/gnmic, API :9804) |
| gnmi-relay | 192.168.30.20 | TCP relay host:57400 → dc1:57400 |

### RTUs

| RTU | Container IP | GOOSE IP | Peer GOOSE IP | HTTP API |
|---|---|---|---|---|
| RTU1 | 192.168.30.7 | 192.168.100.3 | 192.168.100.4 | :8850 |
| RTU2 | 192.168.30.6 | 192.168.100.4 | 192.168.100.3 | :8850 |

### Topology Links (10 total)

| Link ID | Endpoint A | Endpoint B |
|---|---|---|
| link-dc1-dc2 | dc1 · 1/1/c2/1 | dc2 · 1/1/c2/1 |
| link-dc1-acc1 | dc1 · 1/1/c1/1 | acc1 · 1/1/c1/1 |
| link-dc2-acc2 | dc2 · 1/1/c1/1 | acc2 · 1/1/c1/1 |
| link-acc1-acc2 | acc1 · 1/1/c3/1 | acc2 · 1/1/c3/1 |
| link-acc1-a1-1 | acc1 · 1/1/c2/1 | a1-1 · 1/1/c2/1 |
| link-acc2-a1-3 | acc2 · 1/1/c2/1 | a1-3 · 1/1/c2/1 |
| link-a1-1-a1-2 | a1-1 · 1/1/c1/1 | a1-2 · 1/1/c1/1 |
| link-a1-2-a1-3 | a1-2 · 1/1/c2/1 | a1-3 · 1/1/c1/1 |
| link-a1-1-rtu1 | a1-1 · 1/1/c3/1 | *(RTU — unmonitored)* |
| link-a1-3-rtu2 | a1-3 · 1/1/c3/1 | *(RTU — unmonitored)* |

---

## Features

### Power Grid Simulation

- **4 power plants**: Nuclear α (1.2 GW), Nuclear β (1.2 GW), Solar (800 MW), Wind (400 MW)
- Animated energy flow from generation → step-up substation → feeders F1–F4 → secondary substations S1–S4 → city (2.8 GW demand)
- Nuclear plants have adjustable power sliders (0–100%)
- Solar/wind add realistic ±5%/±7.5% noise via continuous animation loop
- DER node (PV + BESS, 350 kW) on Feeder F4 with bidirectional flow
- **Transmission power reduction**: each offline access node reduces city power by 25%
- Draggable topology nodes with live-updating connection paths

### MPLS Network Topology (Live)

- SVG diagram of the full 7-node SR-OS topology with role-differentiated link styles (core / aggregation / access / RTU)
- **Link fault visualisation**: any port reporting `down` via gNMI turns the corresponding link red and blinking
- Clickable nodes (DC-1, DC-2, ACCESS1-1) open live telemetry popups showing:
  - Physical port grid (colour-coded: up=green, down=red, unconfigured=grey)
  - Router interfaces table (oper-state, IP, in/out packet counters)
  - IS-IS adjacency status (level, neighbour, state, metric)
  - Segment Routing summary (prefix-SIDs, active adjacency-SIDs)

### Teleprotection System (IEC 61850 GOOSE)

- Industrial-infographic panel: 400 kV HV line, transformers, 19" rack RTU illustrations, MPLS-TP comm link
- Animated GOOSE packet pulses (forward + return) between ACCESS1-1 and ACCESS1-3
- **ACCESS1-1 ↔ RTU1 link fault indicator**: when port 1/1/c3/1 on ACCESS1-1 reports `down`, the comm line turns red and a `LINK FAULT` badge appears at the midpoint
- Trip/Clear controls proxied to both RTU daemons simultaneously
- Teleprotection state badge: CLOSED (normal) / OPEN (fault/trip)

### Statistics Rings

Three circular progress rings updated every monitoring cycle:
- **Routers online** (out of 7)
- **RTUs reachable** (out of 2)
- **Overall health** (weighted average)

### Security Panel

Toggle between secure (green, AES-256 shield icons) and insecure (red, open-lock icons) packet animations on the topology links.

### Manual Override

Forces all devices online and all links up. Disables all monitoring polls while active. Restores previous state on deactivation.

---

## Prerequisites

- **Docker** with containerlab deployed (`clab deploy`)
- **Node.js** ≥ 14
- **gnmic** container running (`docker ps | grep gnmic`)
- RTU containers running (`docker ps | grep rtu`)
- Modern browser (Chrome 90+, Firefox 88+, Safari 14+)

---

## Installation & Startup

### 1. Install Node dependencies

```bash
npm install
```

### 2. Deploy the containerlab topology

```bash
clab deploy -t smart_grid.yaml    # adjust filename to your topology file
```

Verify containers are up:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

### 3. Install and start TPT daemons on RTUs

```bash
bash scripts/install-tpt.sh
```

This copies `tpt-daemon.py` to both RTU containers, installs Python 3, and launches the daemons with GOOSE publication and telemetry simulation enabled.  
Verify: `curl http://192.168.30.7:8850/health` and `curl http://192.168.30.6:8850/health`

### 4. Start the backend

```bash
node ping-service.js
# or: npm start
```

Expected output:
```
Ping service running on http://localhost:3000
Monitoring IPs: 192.168.30.2, 192.168.30.3, ...
```

### 5. Open the dashboard

```bash
open smart-grid.html
```

Or open `smart-grid.html` directly in any browser.

### After every `clab redeploy`

SR-OS container IPs can change. Sync `config.json`:

```bash
bash scripts/update-ips.sh          # dry-run: shows diff
bash scripts/update-ips.sh --apply  # writes changes
```

---

## API Reference

All endpoints are on `ping-service.js` at `http://localhost:3000`.

### General

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Service liveness: `{status: "ok", service: "ping-service"}` |
| GET | `/ping?ip=X.X.X.X` | ICMP to a whitelisted IP: `{ip, alive, timestamp}` |

### gNMI (via gnmic container)

| Method | Path | Description |
|---|---|---|
| GET | `/gnmi/status` | gNMI service status: `{running, managed, external, pid, port, logs[]}` |
| GET | `/gnmi/start` | Spawn `node gnmi-service.js` as a child process |
| GET | `/gnmi/stop` | SIGTERM the managed gNMI service |
| GET | `/gnmic/node/:nodeId` | Live telemetry for a node (8 parallel gNMI queries). Returns: `{node, host, ts, interfaces[], ports[], isis{}, sr{}}` |

Valid `:nodeId` values: `mpls-dc1`, `mpls-dc2`, `mpls-acc1`, `mpls-acc2`, `mpls-a1-1`, `mpls-a1-2`, `mpls-a1-3`

The 8 queries issued per node:
1. All interfaces oper-state (`/state/router[*]/interface[*]/oper-state`)
2. Base router interface objects with IPs and counters
3. Physical port oper-states (`/state/port[port-id=*]/oper-state`)
4. IS-IS instance state
5. IS-IS level details
6. IS-IS interface adjacencies
7. SR policy summary
8. SR adjacency-SID table

### MPLS Health

| Method | Path | Description |
|---|---|---|
| GET | `/api/mpls/access-health` | Container liveness + RTU-facing port state for ACCESS1-1 and ACCESS1-3 |
| GET | `/api/mpls/link-health` | Port oper-states for all 7 nodes → per-link up/down/unknown status |

**`/api/mpls/access-health` response:**
```json
{
  "access1": {
    "nodeId": "mpls-a1-1",
    "containerRunning": true,
    "rtuPort": "1/1/c3/1",
    "rtuPortUp": true,
    "healthy": true,
    "ts": "…"
  },
  "access3": { … },
  "ts": "…"
}
```

`healthy = containerRunning && rtuPortUp !== false`  
`rtuPortUp = null` means gnmic was unreachable — treated as unknown, not failure.

**`/api/mpls/link-health` response:**
```json
{
  "ts": "…",
  "links": {
    "link-dc1-dc2": {
      "status": "up",
      "a": { "node": "mpls-dc1", "port": "1/1/c2/1", "state": "up" },
      "b": { "node": "mpls-dc2", "port": "1/1/c2/1", "state": "up" }
    },
    "link-a1-1-a1-2": {
      "status": "down",
      "a": { "node": "mpls-a1-1", "port": "1/1/c1/1", "state": "down" },
      "b": { "node": "mpls-a1-2", "port": "1/1/c1/1", "state": "down" }
    }
  }
}
```

Status logic: `down` if either endpoint is `"down"`; `up` if either is `"up"`; `unknown` if both are `null` (gnmic unreachable).

### Teleprotection (TPT)

All TPT endpoints proxy to both RTU daemons at `http://192.168.30.7:8850` and `http://192.168.30.6:8850`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/tpt/status` | Combined status from both RTUs |
| GET | `/api/tpt/log` | Last 50 GOOSE messages from both RTUs |
| POST | `/api/tpt/start` | Start GOOSE publication on both RTUs |
| POST | `/api/tpt/stop` | Stop GOOSE publication on both RTUs |
| POST | `/api/tpt/trip` | Assert trip on RTU1 |
| POST | `/api/tpt/clear` | De-assert trip on both RTUs |

---

## Configuration

### `config.json` — single source of truth

```json
{
  "services": {
    "pingService":     { "port": 3000 },
    "mplsGnmiService": { "port": 3002 }
  },
  "mplsRtus": {
    "rtu1": { "host": "192.168.30.7", "name": "RTU1", "tptPort": 8850,
              "accessNode": "mpls-a1-1", "gooseHost": "192.168.100.3", "peerHost": "192.168.100.4" },
    "rtu2": { "host": "192.168.30.6", "name": "RTU2", "tptPort": 8850,
              "accessNode": "mpls-a1-3", "gooseHost": "192.168.100.4", "peerHost": "192.168.100.3" }
  },
  "mplsNetwork": {
    "credentials": { "username": "admin", "password": "NokiaSros1!" },
    "insecure": true,
    "gnmicContainer": "gnmic",
    "gnmicBinary": "/app/gnmic",
    "nodes": { "mpls-dc1": { … }, … },
    "infrastructure": { "gnmic": { … }, "gnmi-relay": { … } }
  },
  "grid": {
    "cityDemandMW": 2800,
    "transmissionUnits": 4,
    "transmissionLossPerUnitPct": 25
  }
}
```

The frontend fetches this via `/api/config` (served by ping-service). Both `pingServiceUrl` and all node IPs/ports are read from this file at runtime — nothing is hard-coded in the frontend.

### Enabling gNMI on an SR-OS node

SR-OS srsim nodes require explicit gRPC configuration in their startup config (`/home/sros/chroot/cf3:/config.cfg`). Add this block inside `system {}`, after `dns {}` and before `management-interface {}`:

```
grpc {
    admin-state enable
    allow-unsecure-connection
    gnmi { admin-state enable; auto-config-save true }
    gnoi { cert-mgmt { admin-state enable } file { admin-state enable } system { admin-state enable } }
    md-cli { admin-state enable }
    rib-api { admin-state enable }
}
```

Then restart the container. gRPC becomes available in ~60–90 s.

---

## Monitoring Loops

| Loop | Interval | Trigger | Effect |
|---|---|---|---|
| **Access node health** | 10 s | `startTransmissionMonitoring()` | GET `/api/mpls/access-health` → set all transmission units alive/dead → recalculate city power → update teleprotection fault indicators |
| **Link health** | 15 s | `startLinkMonitoring()` | GET `/api/mpls/link-health` → toggle `.mpls-link-fault` class on each `<line>` element |
| **Animation loop** | rAF (~60 fps) | `animate()` | Add noise to solar/wind output, call `updateDisplay()` |
| **gNMI status** | 5 s | `initGnmiController()` IIFE | GET `/gnmi/status` → update header pill LED and label |
| **Node telemetry** | on demand | click on node | GET `/gnmic/node/:id` → render popup with port grid, interfaces, IS-IS, SR |

**Null-guard behaviour:** The first access-health response can arrive after the page load. `_mplsAccessAlive` is initialised to `null`; `_applyMplsTransmissionState()` returns immediately if it is still `null`, preserving the default `alive: true` state for all transmission units until real data arrives.

**Error behaviour:** On a failed fetch, the previous cached state is kept. The dashboard never flips to "fault" on a transient network error — a link must explicitly report `down` to trigger the fault class.

---

## Teleprotection (IEC 61850 GOOSE)

### tpt-daemon.py

Runs inside each RTU container. Implements a complete IEC 61850-8-1 GOOSE state machine:

- **Transport**: UDP unicast, port 61850
- **Encoding**: BER (Basic Encoding Rules), context-specific IMPLICIT tags
- **Dataset**: 4 entries — `Tr` (trip BOOLEAN), `Cs` (command BOOLEAN), `V` (voltage FLOAT32), `I` (current FLOAT32)
- **Retransmission schedule** (IEC 61850-8-1 §8.3.3): on state change → T1=2 ms (×2), T2=10 ms, T3=100 ms (×2), then steady-state T0=1000 ms heartbeat
- `stNum` increments on every trip/clear; `sqNum` increments on every retransmit burst

**Telemetry simulation** (`--sim-telemetry`):
- Voltage oscillates ±2% at 0.3 Hz (normal)
- Current oscillates ±10% at 0.5 Hz (normal)
- On trip: voltage sags to 0.35 p.u., current spikes to 2.8 p.u.

**HTTP API** (port 8850):

| Endpoint | Description |
|---|---|
| GET `/status` or `/health` | Full state: local/peer IPs, pub_running, trip_asserted, V/I readings, stNum, sqNum, peer liveness, peer last values |
| GET `/log` | Last 50 decoded received GOOSE PDUs |
| POST `/start` | Begin GOOSE publication |
| POST `/stop` | Stop publication |
| POST `/trip` | Assert trip (increments stNum, triggers burst) |
| POST `/clear` | De-assert trip |
| POST `/telemetry` | Override V/I values: `{"voltage_pu": 1.02, "current_pu": 0.95}` |

### Fault indicator in the dashboard

The ACCESS1-1 ↔ RTU1 link state (`access1.rtuPortUp`) is checked after every access-health poll:
- `rtuPortUp === false` → `tp-comm-line-a` gets `.tp-comm-line-fault` (red, blinking), the `tp-fault-a11-rtu` SVG group becomes visible, GOOSE pulse animations are hidden
- `rtuPortUp === null` → no change (gnmic unavailable, treated as unknown)
- `rtuPortUp === true` → normal state restored

---

## Scripts

### `scripts/install-tpt.sh`

Deploys `tpt-daemon.py` to both RTU containers and starts the daemons.

```bash
bash scripts/install-tpt.sh
```

Steps: checks Docker + containers running → installs Python 3 → copies and chmod daemon → kills previous instances → launches with `--auto-start --sim-telemetry` → verifies HTTP health endpoints.

### `scripts/update-ips.sh`

Syncs SR-OS node IPs in `config.json` with current container IPs (necessary after `clab redeploy`).

```bash
bash scripts/update-ips.sh           # dry-run
bash scripts/update-ips.sh --apply   # write changes
```

Maps: dc1→DC-1, dc2→DC-2, acc1→SR1-ACC1, acc2→SR1-ACC2, a1-1→ACCESS1-1, a1-2→ACCESS1-2, a1-3→ACCESS1-3

---

## File Structure

```
SmartGrid-Nokia-Dashboard/
├── config.json              # Single source of truth: nodes, links, RTUs, grid params
├── smart-grid.html          # Dashboard UI: SVG topology + all panels + popups
├── smart-grid.css           # Styles: zones, links, fault states, popups, teleprotection
├── smart-grid.js            # Frontend: SmartGrid class + DraggableTopology + IIFEs
│                            #   IIFEs: initGnmiController, initDc1Popup, initDc2Popup,
│                            #          initA11Popup, security toggle, TPT control panel
├── ping-service.js          # Backend (port 3000): gNMI orchestration, health monitoring,
│                            #   TPT proxy, MPLS link/access health endpoints
├── turbine-control.js       # Turbine blade animation helper
├── turbine-styles.css       # Turbine SVG styles
├── lab.yaml                 # Containerlab topology definition (reference)
├── scripts/
│   ├── install-tpt.sh       # Deploy tpt-daemon.py to RTU containers
│   ├── tpt-daemon.py        # IEC 61850 GOOSE daemon (runs in RTU containers)
│   └── update-ips.sh        # Sync config.json IPs after clab redeploy
├── Avvia Dashboard.command  # macOS double-click launcher
├── package.json             # npm start → node ping-service.js
├── proto/                   # gNMI + gNMI_ext protobuf definitions (legacy)
├── gnmi-service.js          # Legacy SR Linux gNMI service (not used in MPLS lab)
└── archive/                 # Previous versions of source files
```

---

## Troubleshooting

### All link statuses show `unknown`

gnmic is not reachable or the gNMI port on SR-OS nodes is not enabled.

```bash
# Check gnmic container is running
docker ps | grep gnmic

# Test a direct port query
docker exec -i gnmic /app/gnmic \
  -a 192.168.30.11:57400 -u admin -p NokiaSros1! --insecure \
  get --path '/state/port[port-id=1/1/c1/1]/oper-state' --format json
```

If gNMI is not enabled on the SR-OS node, patch its startup config and restart:
```bash
# Copy config with gRPC block, then restart
docker restart ACCESS1-1
# Wait ~90 s for gRPC to become available
```

### `access-health` returns `containerRunning: false`

The container name in `config.json` (`mplsNetwork.nodes.*.name`) must exactly match the Docker container name shown by `docker ps`. For srsim nodes the container name is the `name` field in the containerlab topology (e.g. `ACCESS1-1`), not the topology key with prefix stripped.

### Fault indicator shows but link is actually up

The port may be reported `down` due to a connector breakout mismatch. Check:
```bash
# Verify port oper-state directly
docker exec -i gnmic /app/gnmic -a 192.168.30.11:57400 -u admin -p NokiaSros1! --insecure \
  get --path '/state/port[port-id=*]/oper-state' --format json | grep -A2 'port-id'
```

### RTU TPT daemon not responding

```bash
# Re-run installer
bash scripts/install-tpt.sh

# Manual check inside container
docker exec clab-smart_grid-rtu1 curl -s http://192.168.100.3:8850/health
```

### Dashboard shows wrong link states after lab redeploy

IPs have changed. Run:
```bash
bash scripts/update-ips.sh --apply
# Then restart ping-service
pkill -f 'node ping-service.js'
node ping-service.js &
```

---

## Security Notes

This is a lab/demo environment:
- gNMI credentials are in `config.json` in plain text
- TLS is disabled (`insecure: true`) — no certificate verification
- CORS allows all origins
- No authentication on any API endpoint

Do not expose port 3000 outside the lab network.
