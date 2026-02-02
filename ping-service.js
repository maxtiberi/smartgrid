// Ping Service for Smart Grid Monitoring
// This Node.js service provides ICMP ping functionality for the web dashboard

const http = require('http');
const { exec } = require('child_process');
const url = require('url');

const PORT = 3000;
const ALLOWED_IPS = ['172.20.20.9', '172.20.20.2', '172.20.20.4', '172.20.20.5', '172.20.20.8'];

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
    console.log(`  curl http://localhost:${PORT}/ping?ip=172.20.20.4`);
});
