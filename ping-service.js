// Ping Service for Smart Grid Monitoring
// This Node.js service provides ICMP ping functionality for the web dashboard
// Also manages the gNMI service lifecycle (start/stop/status)

const http = require('http');
const net = require('net');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const url = require('url');
const path = require('path');

// Load centralized config (single source of truth).
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const PORT = CONFIG.services.pingService.port;
const GNMI_PORT = CONFIG.services.gnmiService.port;
// Allow pings to every configured router and RTU — no more hand-maintained IP list.
const ALLOWED_IPS = [
    ...Object.values(CONFIG.routers).map(r => r.host),
    ...Object.values(CONFIG.rtus).map(r => r.host)
];

// ── gnmic helper ─────────────────────────────────────────────────────────────
// Runs a gnmic GET via `docker exec` in the gnmic container.
// Returns a Promise<object[]> (the parsed updates array).
const MPLS_CFG = CONFIG.mplsNetwork;
const GNMIC_CONTAINER = MPLS_CFG.gnmicContainer || 'gnmic';
const GNMIC_BIN       = MPLS_CFG.gnmicBinary    || '/app/gnmic';
const GNMIC_CREDS     = MPLS_CFG.credentials;

function gnmicGet(host, gnmiPort, gnmiPath) {
    return new Promise((resolve, reject) => {
        const cmd = [
            'docker', 'exec', '-i', GNMIC_CONTAINER, GNMIC_BIN,
            '-a', `${host}:${gnmiPort}`,
            '-u', GNMIC_CREDS.username,
            '-p', GNMIC_CREDS.password,
            '--insecure',
            'get',
            '--path', gnmiPath,
            '--format', 'json'
        ].join(' ');

        exec(cmd, { maxBuffer: 8 * 1024 * 1024, timeout: 10000 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr ? stderr.trim() : err.message));
                return;
            }
            try {
                const parsed = JSON.parse(stdout);
                // gnmic returns an array of source responses; flatten updates
                const updates = parsed.flatMap(src => src.updates || []);
                resolve(updates);
            } catch (e) {
                reject(new Error('Failed to parse gnmic JSON: ' + e.message));
            }
        });
    });
}

// Fetch live telemetry for a MPLS node via gnmic.
// Returns { node, host, ts, interfaces[], ports[], isis{} }
async function fetchGnmicNodeData(nodeId) {
    const nodeCfg = (MPLS_CFG.nodes || {})[nodeId];
    if (!nodeCfg) throw new Error(`Unknown node: ${nodeId}`);

    const host     = nodeCfg.host;
    const gnmiPort = nodeCfg.gnmiPort || 57400;

    // Run all six queries in parallel for best latency
    const [
        ifaceStateUpdates, ifaceFullUpdates, portUpdates,
        isisOperUpdates, isisLevelUpdates, isisIfaceUpdates
    ] = await Promise.all([
        // 1. All routers, all interfaces, oper-state only  ← exact user-specified command
        gnmicGet(host, gnmiPort, '/state/router[router-name=*]/interface[interface-name=*]/oper-state'),
        // 2. Base router, full interface objects (includes primary IP)
        gnmicGet(host, gnmiPort, '/state/router[router-name=Base]/interface[interface-name=*]'),
        // 3. Physical port oper-states
        gnmicGet(host, gnmiPort, '/state/port[port-id=*]/oper-state'),
        // 4. IS-IS instance overall oper-state
        gnmicGet(host, gnmiPort, '/state/router[router-name=Base]/isis[isis-instance=1]/oper-state').catch(() => []),
        // 5. IS-IS level info (LSP counts, overload status)
        gnmicGet(host, gnmiPort, '/state/router[router-name=Base]/isis[isis-instance=1]/level[level-number=*]').catch(() => []),
        // 6. IS-IS interfaces + adjacencies (includes neighbor IPs, levels, uptime)
        gnmicGet(host, gnmiPort, '/state/router[router-name=Base]/isis[isis-instance=1]/interface[interface-name=*]').catch(() => [])
    ]);

    // Build interface map: key = "routerName|ifaceName"
    // Seed from query 1 (all routers, oper-state scalar)
    const ifaceMap = {};
    for (const upd of ifaceStateUpdates) {
        const routerM = upd.Path.match(/router\[router-name=([^\]]+)\]/);
        const ifaceM  = upd.Path.match(/interface\[interface-name=([^\]]+)\]/);
        if (!routerM || !ifaceM) continue;
        const key = `${routerM[1]}|${ifaceM[1]}`;
        const val = Object.values(upd.values)[0];
        ifaceMap[key] = {
            router:    routerM[1],
            name:      ifaceM[1],
            operState: typeof val === 'string' ? val : 'unknown',
            ipv4:      '',
            inPkts:    null,
            outPkts:   null
        };
    }

    // Enrich from query 2 (Base router full objects) — adds IP + counters
    for (const upd of ifaceFullUpdates) {
        const routerM = upd.Path.match(/router\[router-name=([^\]]+)\]/);
        const ifaceM  = upd.Path.match(/interface\[interface-name=([^\]]+)\]/);
        if (!routerM || !ifaceM) continue;
        const key = `${routerM[1]}|${ifaceM[1]}`;
        const obj = Object.values(upd.values)[0];
        if (!ifaceMap[key]) {
            ifaceMap[key] = { router: routerM[1], name: ifaceM[1],
                              operState: 'unknown', ipv4: '', inPkts: null, outPkts: null };
        }
        const entry = ifaceMap[key];
        // oper-state (may override the scalar from query 1)
        if (obj['oper-state']) entry.operState = obj['oper-state'];
        // Primary IPv4 address
        const pri = obj.ipv4 && obj.ipv4.primary;
        if (pri && pri['oper-address']) entry.ipv4 = pri['oper-address'];
        // Packet counters
        const stats = obj.ipv4 && obj.ipv4.statistics;
        if (stats) {
            entry.inPkts  = parseInt(stats['in-packets'],  10) || 0;
            entry.outPkts = parseInt(stats['out-packets'], 10) || 0;
        }
    }

    // Build port list from query 3
    const ports = portUpdates.map(upd => {
        const portM = upd.Path.match(/port\[port-id=([^\]]+)\]/);
        const state = Object.values(upd.values)[0];
        return {
            portId:    portM ? portM[1] : '?',
            operState: typeof state === 'string' ? state : 'unknown'
        };
    }).sort((a, b) => {
        // Natural sort: A/ ports first, then 1/1/c* numerically
        const aIsAlpha = a.portId.startsWith('A/') || a.portId.startsWith('B/');
        const bIsAlpha = b.portId.startsWith('A/') || b.portId.startsWith('B/');
        if (aIsAlpha !== bIsAlpha) return aIsAlpha ? 1 : -1;
        return a.portId.localeCompare(b.portId, undefined, { numeric: true });
    });

    // ── Parse IS-IS data ──────────────────────────────────────────────
    // Overall oper-state
    const isisOperState = isisOperUpdates.length > 0
        ? (String(Object.values(isisOperUpdates[0].values)[0]) || 'unknown')
        : 'unknown';

    // Level info: { level: 1|2, lsps: N, overload: 'not-in-overload'|... }
    const isisLevels = isisLevelUpdates.map(upd => {
        const lvlM = upd.Path.match(/level\[level-number=(\d+)\]/);
        const obj  = Object.values(upd.values)[0] || {};
        return {
            level:    lvlM ? parseInt(lvlM[1], 10) : 0,
            lsps:     typeof obj.lsps === 'number' ? obj.lsps : 0,
            overload: (obj.overload && obj.overload.status) || 'unknown'
        };
    }).sort((a, b) => a.level - b.level);

    // Interfaces + adjacencies
    const isisInterfaces = isisIfaceUpdates.map(upd => {
        const ifaceM = upd.Path.match(/interface\[interface-name=([^\]]+)\]/);
        const obj    = Object.values(upd.values)[0] || {};
        const adjs   = (obj.adjacency || []).map(a => ({
            index:            a['adjacency-index'],
            level:            a.level             || '—',
            operState:        a['oper-state']      || 'unknown',
            neighborIp:       (a.neighbor && a.neighbor.ipv4)         || '—',
            neighborSystemId: (a.neighbor && a.neighbor['system-id']) || '—',
            uptime:           typeof a.uptime === 'number' ? a.uptime : null
        }));
        return {
            name:        ifaceM ? ifaceM[1] : '?',
            operState:   obj['oper-state'] || 'unknown',
            adjacencies: adjs
        };
    });

    return {
        node:       nodeCfg.name || nodeId,
        nodeId,
        host,
        gnmiPort,
        ts:         new Date().toISOString(),
        interfaces: Object.values(ifaceMap),
        ports,
        isis: {
            operState:  isisOperState,
            instance:   1,
            levels:     isisLevels,
            interfaces: isisInterfaces
        }
    };
}

// --- gNMI Service Manager ---
let gnmiProcess = null;
let gnmiLogs = [];
const MAX_LOGS = 100;

// Probe port 3001 — detects ANY gNMI instance, including ones started
// outside this process (e.g. via start-gnmi.sh in a terminal).
function probeGnmiPort(timeoutMs = 400) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let settled = false;
        const finish = (alive) => { if (!settled) { settled = true; sock.destroy(); resolve(alive); } };
        sock.setTimeout(timeoutMs);
        sock.once('connect',  () => finish(true));
        sock.once('timeout',  () => finish(false));
        sock.once('error',    () => finish(false));
        sock.connect(GNMI_PORT, '127.0.0.1');
    });
}

async function getGnmiStatus() {
    const childRunning = gnmiProcess !== null && gnmiProcess.exitCode === null;
    const portOpen = await probeGnmiPort();
    // "running" is true if EITHER our child is alive OR something is listening
    // on the gNMI port (e.g. start-gnmi.sh started from a terminal).
    return {
        running: childRunning || portOpen,
        managed: childRunning,           // true only when we own the process
        external: !childRunning && portOpen,
        pid: gnmiProcess ? gnmiProcess.pid : null,
        port: GNMI_PORT,
        logs: gnmiLogs.slice(-20)
    };
}

async function startGnmi() {
    // If we already own a live child, refuse.
    if (gnmiProcess && gnmiProcess.exitCode === null) {
        return { success: false, message: 'gNMI service is already running', pid: gnmiProcess.pid };
    }
    // If port is already taken by an external process, refuse — we'd just hit EADDRINUSE.
    if (await probeGnmiPort()) {
        return { success: false, message: `Port ${GNMI_PORT} already in use (external process). Stop it first.` };
    }
    const gnmiPath = path.join(__dirname, 'gnmi-service.js');
    gnmiLogs = [];
    gnmiProcess = spawn('node', [gnmiPath], {
        cwd: __dirname,
        detached: false
    });
    gnmiProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        lines.forEach(line => gnmiLogs.push({ ts: new Date().toISOString(), msg: line }));
        if (gnmiLogs.length > MAX_LOGS) gnmiLogs = gnmiLogs.slice(-MAX_LOGS);
        console.log('[gNMI]', data.toString().trim());
    });
    gnmiProcess.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        lines.forEach(line => gnmiLogs.push({ ts: new Date().toISOString(), msg: '[ERR] ' + line }));
        if (gnmiLogs.length > MAX_LOGS) gnmiLogs = gnmiLogs.slice(-MAX_LOGS);
        console.error('[gNMI ERR]', data.toString().trim());
    });
    gnmiProcess.on('exit', (code) => {
        gnmiLogs.push({ ts: new Date().toISOString(), msg: `Process exited with code ${code}` });
        console.log(`[gNMI] Process exited with code ${code}`);
        gnmiProcess = null;
    });
    return { success: true, message: 'gNMI service started', pid: gnmiProcess.pid };
}

// Find PID listening on the gNMI port (used to stop external instances).
function findGnmiPid() {
    return new Promise((resolve) => {
        // -t = terse PID list, -i = port filter, -sTCP:LISTEN = only listeners
        exec(`lsof -t -i :${GNMI_PORT} -sTCP:LISTEN`, (err, stdout) => {
            if (err || !stdout.trim()) return resolve(null);
            const pid = parseInt(stdout.trim().split('\n')[0], 10);
            resolve(Number.isFinite(pid) ? pid : null);
        });
    });
}

async function stopGnmi() {
    // Case 1: we own the process → SIGTERM it directly.
    if (gnmiProcess && gnmiProcess.exitCode === null) {
        gnmiProcess.kill('SIGTERM');
        return { success: true, message: 'gNMI service stop signal sent (managed)' };
    }
    // Case 2: external process listening on port 3001 → look it up and SIGTERM.
    if (await probeGnmiPort()) {
        const pid = await findGnmiPid();
        if (!pid) {
            return { success: false, message: `Port ${GNMI_PORT} is open but no PID found (insufficient permissions?)` };
        }
        try {
            process.kill(pid, 'SIGTERM');
            return { success: true, message: `External gNMI process ${pid} signalled (SIGTERM)` };
        } catch (e) {
            return { success: false, message: `Failed to signal PID ${pid}: ${e.message}` };
        }
    }
    return { success: false, message: 'gNMI service is not running' };
}

// Function to ping an IP address
function pingHost(ip) {
    return new Promise((resolve, reject) => {
        // Validate IP is in allowed list
        if (!ALLOWED_IPS.includes(ip)) {
            reject(new Error('IP not allowed'));
            return;
        }

        // Use platform-specific ping command
        const isWindows = process.platform === 'win32';
        const pingCommand = isWindows
            ? `ping -n 1 -w 2000 ${ip}`
            : `ping -c 1 -W 2 ${ip}`;

        exec(pingCommand, (error, stdout, stderr) => {
            if (error) {
                resolve({
                    ip: ip,
                    alive: false,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            } else {
                // Parse output to check if ping was successful
                const success = stdout.toLowerCase().includes('ttl=') ||
                               stdout.toLowerCase().includes('time=');

                resolve({
                    ip: ip,
                    alive: success,
                    timestamp: new Date().toISOString()
                });
            }
        });
    });
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Parse URL
    const parsedUrl = url.parse(req.url, true);

    // Handle ping request
    if (parsedUrl.pathname === '/ping' && req.method === 'GET') {
        const ip = parsedUrl.query.ip;

        if (!ip) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'IP parameter required' }));
            return;
        }

        try {
            const result = await pingHost(ip);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }
    // Health check endpoint
    else if (parsedUrl.pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'ping-service' }));
    }
    // gNMI status
    else if (parsedUrl.pathname === '/gnmi/status' && req.method === 'GET') {
        const status = await getGnmiStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
    }
    // gNMI start
    else if (parsedUrl.pathname === '/gnmi/start' && req.method === 'GET') {
        const result = await startGnmi();
        res.writeHead(result.success ? 200 : 409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    }
    // gnmic live node telemetry — GET /gnmic/node/:nodeId
    // Runs docker exec gnmic queries and returns live port+interface data.
    else if (parsedUrl.pathname.startsWith('/gnmic/node/') && req.method === 'GET') {
        const nodeId = parsedUrl.pathname.replace('/gnmic/node/', '');
        res.setHeader('Content-Type', 'application/json');
        fetchGnmicNodeData(nodeId)
            .then(data  => { res.writeHead(200); res.end(JSON.stringify(data)); })
            .catch(err  => { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); });
    }
    // gNMI stop
    else if (parsedUrl.pathname === '/gnmi/stop' && req.method === 'GET') {
        const result = await stopGnmi();
        res.writeHead(result.success ? 200 : 409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    }
    // Not found
    else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
});

// Start server
server.listen(PORT, () => {
    console.log(`Ping service running on http://localhost:${PORT}`);
    console.log(`Monitoring IPs: ${ALLOWED_IPS.join(', ')}`);
    console.log(`\nExample usage:`);
    const exampleIp = ALLOWED_IPS[0];
    console.log(`  curl http://localhost:${PORT}/ping?ip=${exampleIp}`);
});
