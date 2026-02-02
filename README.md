# Smart Grid Nokia Dashboard

An interactive HTML dashboard for monitoring Smart Grid power generation and SR Linux router infrastructure with real-time gNMI telemetry integration.

## Features

### Power Grid Monitoring
- **4 Power Plants**: 2 Nuclear, 1 Solar, 1 Wind
- Real-time power output monitoring
- Nuclear plants with adjustable power levels (0-100%)
- Interactive start/stop controls
- Network topology visualization with animated energy flow
- Draggable topology nodes

### Network Infrastructure Monitoring
- **5 SR Linux Routers**: DC-1, DC-2, Leaf-1, Leaf-2, Leaf-3
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

### Transmission Unit Monitoring
- ICMP ping monitoring for T1 (172.20.20.4) and T2 (172.20.20.5)
- Real-time alerts on connectivity loss
- 10-second polling interval

## Architecture

```
SR Linux Routers (172.20.20.x:57400)
    ↓ gRPC streaming (5s interval)
gnmi-service.js (port 3001)
    ↓ REST API
smart-grid.js (polling 10s)
    ↓ DOM updates
smart-grid.html (browser)
```

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

### 1. Start the gNMI Service

```bash
node gnmi-service.js
```

Expected output:
```
gNMI Service starting...
Listening on http://localhost:3001
Starting gNMI subscriptions for 5 routers...
Router dc1 (DC-1) connected
Router dc2 (DC-2) connected
...
```

### 2. Start the Ping Service

In a second terminal:

```bash
node ping-service.js
```

Expected output:
```
Ping service listening on port 3000
```

### 3. Open the Dashboard

```bash
open smart-grid.html
```

Or simply open `smart-grid.html` in your web browser.

## API Endpoints

### gNMI Service (port 3001)

- `GET /health` - Service health check
- `GET /api/routers` - List all routers with status summary
- `GET /api/routers/:id/interfaces` - Interface statistics for router
- `GET /api/routers/:id/system` - CPU/memory metrics for router
- `GET /api/routers/:id/bgp` - BGP peer information for router

Router IDs: `dc1`, `dc2`, `leaf1`, `leaf2`, `leaf3`

### Ping Service (port 3000)

- `GET /ping?ip=<ip_address>` - Ping specified IP address

## Configuration

### Router Addresses

Default router configuration in `gnmi-service.js`:

```javascript
const ROUTERS = {
    dc1: { host: '172.20.20.7', port: 57400, name: 'DC-1' },
    dc2: { host: '172.20.20.8', port: 57400, name: 'DC-2' },
    leaf1: { host: '172.20.20.5', port: 57400, name: 'leaf-1' },
    leaf2: { host: '172.20.20.6', port: 57400, name: 'leaf-2' },
    leaf3: { host: '172.20.20.2', port: 57400, name: 'leaf-3' }
};
```

### gNMI Authentication

Default credentials (configured in `gnmi-service.js`):
- Username: `admin`
- Password: `NokiaSrl1!`

### gNMI Subscriptions

Telemetry paths (5-second sample interval):
- `/interface` - All interface operational state and statistics
- `/platform/control` - CPU and memory metrics
- `/network-instance[name=default]/protocols/bgp/statistics` - BGP statistics in default network-instance
- `/network-instance[name=default]/protocols/bgp/neighbor` - BGP neighbor sessions in default network-instance

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
curl "http://localhost:3000/ping?ip=172.20.20.4"
curl "http://localhost:3000/ping?ip=172.20.20.5"
```

### Dashboard Interactions

1. **Power Plants**: Click "start" to activate plants, adjust nuclear plant sliders
2. **Distribution Network**: Toggle network on/off
3. **Router Nodes**:
   - Hover over router nodes to see tooltip with metrics
   - Click router nodes to open detailed panel
   - Press ESC to close panel
4. **Topology**: Drag nodes to rearrange network visualization

## Troubleshooting

### Routers show "unknown" status

- Verify `gnmi-service.js` is running on port 3001
- Check SR Linux routers are accessible at 172.20.20.x:57400
- Verify network connectivity to router management interfaces
- Check browser console for CORS or fetch errors

### gNMI service fails to connect

- Verify router IPs and credentials in `gnmi-service.js`
- Check that gNMI is enabled on SR Linux routers
- Verify port 57400 is accessible (not blocked by firewall)
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
├── smart-grid.html           # Main dashboard HTML
├── smart-grid.css            # Dashboard styles
├── smart-grid.js             # Frontend logic (SmartGrid class)
├── gnmi-service.js           # Backend gNMI service
├── ping-service.js           # Backend ping service
├── package.json              # Node.js dependencies
├── package-lock.json         # Dependency lock file
├── proto/                    # Protocol buffer definitions
│   ├── gnmi/
│   │   └── gnmi.proto       # gNMI protocol definitions
│   └── gnmi_ext/
│       └── gnmi_ext.proto   # gNMI extensions
└── node_modules/            # Installed dependencies
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

## Version

- Dashboard Version: 1.0.0
- gNMI Service Version: 1.0.0
- Last Updated: January 11, 2026
