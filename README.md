# Smart Grid Nokia Dashboard

An interactive HTML dashboard for monitoring Smart Grid power generation and SR Linux router infrastructure with real-time gNMI telemetry integration.

## Features

### Power Grid Monitoring
- **4 Power Plants**: Nuclear α (1.2 GW), Nuclear β (1.2 GW), Solar (800 MW), Wind (400 MW)
- Real-time power output monitoring
- Nuclear plants with adjustable power levels (0–100 %)
- Interactive start/stop controls
- Network topology visualization with animated energy flow and 4 logical zones:
  - `GENERATION` — power plants (4 sources, 3.6 GW nameplate)
  - `TRANSMISSION SUBSTATION` — step-up 20 → 400 kV
  - `DISTRIBUTION` — feeders **F1–F4** + secondary substations **S1–S4** + **DER**
  - `CONSUMPTION` — urban load (2.8 GW demand)
- **Voltage badges** along the corridors: 20 kV (gen output), 400 kV (HV transmission),
  20 kV MV (feeders), 0.4 kV LV (consumer side)
- **Capacity badges** next to each plant (GW / MW)
- **Secondary substations S1–S4**: MV/LV step-down (20 / 0.4 kV)
- **DER node** (PV + BESS) with **bidirectional** connection on Feeder F4 — represents
  distributed solar + battery storage exporting/importing energy at MV
- Draggable topology nodes
- Direction arrows on power flow paths

### Network Infrastructure Monitoring
- **6 SR Linux Routers**: DC-1, DC-2 (spine) + Leaf-1, Leaf-2, Leaf-3, Leaf-4 (leaf)
- **4 RTUs** (Remote Terminal Units): RTU-1..4 connected to Leaf-1..4 (ICMP ping monitored)
- Real-time gNMI telemetry streaming (5-second intervals)
- **Metrics Tracked**:
  - Interface statistics (operational state, traffic rates, errors)
  - System performance (CPU, memory utilization)
  - BGP statistics (peer sessions, routes received)
- Visual status indicators:
  - Green glow: Router connected
  - Red pulsing: Router disconnected
  - Yellow glow: Router stale (no updates >30s)
  - Grayscale: Service unavailable
- Hover tooltips with summary metrics
- Click-to-open detailed panels
- **gNMI Service toggle**: pill button in the header to start/stop the gNMI telemetry
  service from the dashboard. Detects external instances started via `start-gnmi.sh`
  and can SIGTERM them.

### Teleprotection System Panel
Industrial-infographic visualization of the differential teleprotection chain
(matching Nokia microgrid reference style):
- 400 kV HV transmission line with 5 lattice tower silhouettes
- Step-down transformers (400 / 10 kV) + 10 kV bus bar
- 19" rack illustrations for **RTU-1** and **RTU-4** with LEDs, ports, display
- Telecom Network card with **DC-1 / DC-2** routers and MPLS-TP inter-link
- Red dashed **communication layer** with animated GOOSE packets (forward + return)
- Protocol badges: `IEC 60834-1`, `IEC 61850 GOOSE`, `MPLS-TP`
- **Fault state styling**: red border + glow + pulsing LEDs when a leaf is isolated
- Top-right legend: Power Flow (solid) vs Communication Line (dashed red)

### RTU Monitoring
- ICMP ping monitoring for **RTU-1** (172.20.20.20), **RTU-2** (172.20.20.21),
  **RTU-3** (172.20.20.22), **RTU-4** (172.20.20.23)
- Real-time alerts on connectivity loss
- 10-second polling interval
- Triggers teleprotection trip if a leaf becomes isolated (both DC uplinks down)

## Architecture

```
                         ┌────────────────────────────────┐
                         │   config.json (single source)  │
                         │   routers · rtus · links · gnmi│
                         └──────┬───────────────┬─────────┘
                                │               │
   SR Linux Routers             │               │
   (172.20.20.x : 57401)        │               │
        │                       ▼               ▼
        │ gRPC streaming    gnmi-service.js   ping-service.js
        ▼ (5 s sample)        (port 3001)       (port 3000)
   gnmi subscriptions      ─ /api/routers     ─ /ping?ip=…
   (interface, system,     ─ /api/links       ─ /gnmi/status
    bgp, oper-state)       ─ /api/config      ─ /gnmi/start
                           ─ /api/sse           /gnmi/stop  (manage gNMI)
                                  │                     │
                                  └─────────┬───────────┘
                                            │ REST + SSE
                                            ▼
                                       smart-grid.js
                                  (frontend, 10 s polling)
                                            │
                                            ▼
                                       smart-grid.html (browser)
```

**Data flow**:
- `gnmi-service.js` subscribes to each router via gNMI on port **57401**, caches state,
  and exposes a REST API + Server-Sent Events stream on **port 3001**.
- `ping-service.js` provides ICMP ping (for RTUs) and now also **manages the gNMI service
  lifecycle** (start/stop/status, including detecting external instances on port 3001).
- `smart-grid.js` consumes both APIs, drives the topology animations, fault state, and
  the gNMI toggle button.
- `config.json` is the single source of truth for routers, RTUs, links, ports, and gNMI
  credentials — both backend services and the frontend hydrate from it via `/api/config`.

## Prerequisites

- Node.js (v14 or higher)
- Access to SR Linux routers on network 172.20.20.0/24
- Modern web browser (Chrome, Firefox, Safari, Edge)

## Installation

```bash
cd SmartGrid-Nokia-Dashboard

# Install dependencies
npm install

# Verify proto files exist
ls -la proto/gnmi/
ls -la proto/gnmi_ext/
```

## Usage

### 1. Start the Ping Service (recommended first)

```bash
node ping-service.js
```

The ping service runs on port **3000** and also exposes the `/gnmi/{status,start,stop}`
endpoints used by the dashboard's gNMI toggle button.

Expected output:
```
Ping service running on http://localhost:3000
Monitoring IPs: 172.20.20.5, 172.20.20.8, ...
```

### 2. Start the gNMI Service

You have **two options**:

**A) From the dashboard** (recommended): once ping-service is up and the page is loaded,
click the `Start` pill button in the top-right header. The button reflects the live
state (`Start` / `Stop · pid X` / `Stop (external)` / `ping-svc offline`).

**B) From a terminal**:
```bash
bash start-gnmi.sh        # wrapper with proto-file checks and logs
# or directly:
node gnmi-service.js
```

The dashboard's status pill will detect the external process via a port-3001 probe and
show the `external` state (amber LED + "ext" badge).

Expected output:
```
gNMI Service starting...
Listening on http://localhost:3001
Starting gNMI subscriptions for 6 routers...
Router dc1 (DC-1) connected
Router dc2 (DC-2) connected
...
```

### 3. Open the Dashboard

```bash
open smart-grid.html
```

Or simply open `smart-grid.html` in your web browser.

### 4. After every Containerlab redeploy: refresh router IPs

Leaf router IPs are auto-assigned by Docker and **change on every `clab redeploy`**.
Run the helper script to sync `config.json` with the live container IPs:

```bash
# Dry-run: show what would change
bash scripts/update-ips.sh

# Apply changes
bash scripts/update-ips.sh --apply
```

If you skip this step, the dashboard will appear to show wrong link states because gNMI
subscribes to the wrong containers.

## API Endpoints

### gNMI Service (port 3001)

- `GET /health` — service health check
- `GET /api/config` — full topology config (routers, RTUs, links, ports)
- `GET /api/routers` — list of routers with status summary
- `GET /api/routers/:id/interfaces` — interface statistics for router
- `GET /api/routers/:id/system` — CPU / memory metrics
- `GET /api/routers/:id/bgp` — BGP peer information
- `GET /api/links` — computed link state for all topology links
- `GET /api/sse` — Server-Sent Events stream for real-time updates
- `GET /api/debug/cache` — full router cache (debug)
- `GET /api/debug/trace` — bounded oper-state trace (debug)

Router IDs: `dc1`, `dc2`, `leaf1`, `leaf2`, `leaf3`, `leaf4`

### Ping Service (port 3000)

- `GET /health` — service health check
- `GET /ping?ip=<ip_address>` — ICMP ping (whitelisted to configured router/RTU IPs)
- `GET /gnmi/status` — gNMI service status. Returns:
  ```json
  { "running": true, "managed": true, "external": false,
    "pid": 25475, "port": 3001, "logs": [ … ] }
  ```
  Probes port 3001 directly, so it detects **any** gNMI instance —
  including ones started outside the dashboard (e.g. via `start-gnmi.sh`).
- `GET /gnmi/start` — spawn `node gnmi-service.js` as a child process
- `GET /gnmi/stop` — SIGTERM the gNMI service. If the running instance is external
  (not spawned by ping-service), looks up its PID via `lsof -t -i :3001` and signals it.

## Configuration

### Single Source of Truth — `config.json`

All topology data (routers, RTUs, links, service ports, gNMI credentials) lives in
`config.json` at the project root. Both backend services and the frontend hydrate from
this file via `/api/config`.

```json
{
  "services": {
    "pingService": { "port": 3000 },
    "gnmiService": { "port": 3001 }
  },
  "gnmi": {
    "port": 57401,
    "insecure": true,
    "credentials": { "username": "admin", "password": "NokiaSrl1!" },
    "sampleIntervalNs": 5000000000
  },
  "routers": {
    "dc1":   { "host": "172.20.20.5", "name": "DC-1",   "type": "spine" },
    "dc2":   { "host": "172.20.20.8", "name": "DC-2",   "type": "spine" },
    "leaf1": { "host": "172.20.20.2", "name": "Leaf-1", "type": "leaf"  },
    "leaf2": { "host": "172.20.20.4", "name": "Leaf-2", "type": "leaf"  },
    "leaf3": { "host": "172.20.20.6", "name": "Leaf-3", "type": "leaf"  },
    "leaf4": { "host": "172.20.20.3", "name": "Leaf-4", "type": "leaf"  }
  },
  "rtus": { "rtu1": { … }, "rtu2": { … }, … },
  "links": { "dc1-leaf1": { … }, … }
}
```

> ⚠️ **Leaf IPs change on every `clab redeploy`** because Docker assigns them
> dynamically. Use `scripts/update-ips.sh` to keep `config.json` in sync.

### gNMI Subscriptions

Telemetry paths (5-second sample interval, plus ON_CHANGE for `interface/oper-state`):
- `/interface` — all interface operational state and statistics
- `/interface[name=*]/oper-state` — explicit ON_CHANGE for non-configured interfaces
- `/platform/control` — CPU and memory metrics
- `/network-instance[name=default]/protocols/bgp/statistics` — BGP statistics
- `/network-instance[name=default]/protocols/bgp/neighbor` — BGP neighbor sessions

> The transceiver/ethernet/healthz `oper-state` paths are filtered out because
> SR Linux reports `down` for the virtual transceivers in lab environments — using
> them would overwrite the real interface state.

## Testing

### Test gNMI Service

```bash
# Health check
curl http://localhost:3001/health

# Get all routers status
curl http://localhost:3001/api/routers | json_pp

# Get specific router metrics
curl http://localhost:3001/api/routers/dc1/interfaces | json_pp
curl http://localhost:3001/api/routers/dc1/system | json_pp
curl http://localhost:3001/api/routers/dc1/bgp | json_pp
```

### Test Ping Service

```bash
# ICMP ping
curl "http://localhost:3000/ping?ip=172.20.20.5"
curl "http://localhost:3000/ping?ip=172.20.20.20"   # RTU-1

# gNMI lifecycle
curl http://localhost:3000/gnmi/status | jq
curl http://localhost:3000/gnmi/start  | jq
curl http://localhost:3000/gnmi/stop   | jq
```

### Dashboard Interactions

1. **gNMI toggle** (top-right header): start/stop the telemetry service. The pill LED
   shows the current state — green pulsing (managed) / amber (external) /
   red (stopped) / grey blinking (ping-service unreachable).
2. **Power Plants**: click "start" to activate plants, adjust nuclear plant sliders.
3. **Distribution Network**: toggle network on/off; this drives the activation of all
   transmission lines, secondary substations, and the city node together.
4. **Router Nodes**:
   - Hover over router nodes to see tooltip with metrics
   - Click router nodes to open detailed panel
   - Press ESC to close panel
5. **Topology**: drag nodes to rearrange network visualization.
6. **Manual override / fault injection**: panels under the topology let you force
   devices online or inject router/link faults to test the teleprotection logic.

## Troubleshooting

### Routers show "unknown" status

- Verify `gnmi-service.js` is running on port 3001
- Check SR Linux routers are accessible at 172.20.20.x:57401
- Verify network connectivity to router management interfaces
- Check browser console for CORS or fetch errors

### gNMI service fails to connect

- Verify router IPs and credentials in `gnmi-service.js`
- Check that gNMI is enabled on SR Linux routers
- Verify port 57401 is accessible (not blocked by firewall)
- Check proto files exist in `proto/gnmi/` and `proto/gnmi_ext/`

### Dependencies missing

```bash
npm install @grpc/grpc-js @grpc/proto-loader ping
```

### CORS errors in browser

- Ensure `gnmi-service.js` has CORS enabled (already configured)
- Check that services are running on correct ports (3000, 3001)

## File Structure

```
SmartGrid-Nokia-Dashboard/
├── README.md                 # This file
├── config.json               # Single source of truth (routers, RTUs, links, ports)
├── smart-grid.html           # Main dashboard HTML (topology + panels)
├── smart-grid.css            # Dashboard styles (zones, badges, teleprotection, etc.)
├── smart-grid.js             # Frontend logic (SmartGrid + DraggableTopology + gNMI controller)
├── gnmi-service.js           # Backend gNMI service (port 3001)
├── ping-service.js           # Backend ping service + gNMI lifecycle (port 3000)
├── start-gnmi.sh             # Wrapper to start gNMI service with proto-file checks
├── turbine-control.js        # Turbine animation controller
├── turbine-styles.css        # Turbine styles
├── tpt-simulator.html        # Standalone interactive TPT simulator
├── lab.yaml                  # Containerlab topology definition (source of truth for nodes/links)
├── scripts/
│   └── update-ips.sh         # Sync config.json with current container IPs after `clab redeploy`
├── proto/                    # Protocol buffer definitions
│   ├── gnmi/gnmi.proto
│   └── gnmi_ext/gnmi_ext.proto
├── package.json              # Node.js dependencies
└── package-lock.json
```

## Dependencies

### Runtime
- `@grpc/grpc-js` (^1.14.3) - gRPC client for Node.js
- `@grpc/proto-loader` (^0.7.15) - Protocol buffer loader
- `ping` (^0.4.4) - ICMP ping utility
- `express` (^4.21.2) - HTTP server framework
- `cors` (^2.8.5) - CORS middleware

### Protocol Buffers
- OpenConfig gNMI proto files (included in `proto/` directory)

## Performance

- **gNMI subscriptions**: 5-second sample interval per router
- **Frontend polling**: 10-second interval for router status
- **Ping monitoring**: 10-second interval for transmission units
- **Metrics caching**: In-memory cache in gNMI service
- **Auto-reconnection**: Exponential backoff (5s, 10s, 20s, max 60s)

## Security Notes

This dashboard is configured for lab/development environments:

- Credentials hardcoded (use environment variables in production)
- TLS verification disabled (`skip-verify: true`) for self-signed certs
- CORS allows all origins (restrict in production)
- No authentication on API endpoints

## Browser Compatibility

Tested and supported:
- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

Requires modern JavaScript features: async/await, fetch API, ES6 modules

## License

Based on Nokia SR Linux Smart Grid Lab configuration.

## Support

For issues related to:
- SR Linux router configuration: Consult Nokia SR Linux documentation
- gNMI protocol: See OpenConfig gNMI specification
- Dashboard functionality: Check browser console for errors

## Version & Recent Updates

- Dashboard Version: **1.1.0**
- gNMI Service Version: 1.0.0
- Last Updated: **April 26, 2026**

### Changelog 1.1.0 (April 2026)

**Network Topology — physically accurate smart grid hierarchy**
- Reordered zones to match real grids: `Generation → Transmission Substation → Distribution → Consumption`
- Renamed Hub → **Step-up Substation** (20 → 400 kV) and T1–T4 → **Feeders F1–F4**
- Each F→City link split into **F→S (MV)** and **S→City (LV)** with a secondary substation
  in between (S1–S4, MV/LV step-down)
- New **DER node** (PV + BESS) with bidirectional connection on Feeder F4 — represents
  distributed solar/storage exporting/importing energy at the MV level
- Voltage badges (20 / 400 kV / 20 kV MV / 0.4 kV LV) and capacity badges (GW / MW)
- 5 zone-aware backgrounds and dashed separators
- Direction arrows on power flow

**Teleprotection System panel — full industrial redesign**
- 400 kV HV line with 5 lattice transmission towers
- Step-down transformers (400/10 kV) feeding a 10 kV bus bar
- 19" rack-style RTU illustrations (LEDs, ports, display) for RTU-1 / RTU-4
- Telecom Network card with DC-1 / DC-2 routers and MPLS-TP link
- Red dashed communication layer with animated GOOSE packets (forward + return)
- Protocol badges: IEC 60834-1, IEC 61850 GOOSE, MPLS-TP
- Top-right legend, knockout label background for HV line readability
- Fault state styling (red border + glow + pulsing LEDs) when a leaf is isolated

**gNMI service control from the dashboard**
- Header pill button to start/stop the gNMI telemetry service
- `ping-service` now exposes `/gnmi/{status, start, stop}` and probes port 3001 to
  detect external instances started outside the dashboard (e.g. via `start-gnmi.sh`)
- External processes can be SIGTERM'd via `lsof` PID lookup
- Refuses to start when port 3001 is already taken (avoids EADDRINUSE)
- Single controller drives both the new pill button and the existing detailed
  control panel below the topology, in sync

**Operational helper**
- `scripts/update-ips.sh` syncs `config.json` with current container IPs after
  `clab redeploy` (dry-run by default, `--apply` to write). Bash 3.2 compatible.
