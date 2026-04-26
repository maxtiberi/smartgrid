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
