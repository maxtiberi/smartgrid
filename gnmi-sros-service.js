// Nokia SR-OS gNMI Service — IP/MPLS Network Telemetry
// Connects to Nokia SR-OS nodes (srsim 25.10.R1) via gRPC/gNMI.
//
// Monitored data per node:
//   • Physical ports     (state/port[port-id=...])
//   • Router interfaces  (state/router[router-name=Base]/interface[...])
//   • IS-IS adjacencies  (state/router[...]/isis[...]/adjacency[...])
//   • BGP neighbors      (state/router[...]/bgp/neighbor[...])
//   • LDP sessions       (state/router[...]/ldp/session[...])
//   • MPLS-TE LSPs       (state/router[...]/mpls[...]/lsp[...])
//   • RSVP sessions      (state/router[...]/rsvp/...)
//   • System info        (state/system/...)
//
// REST API (port 3002):
//   GET /api/mpls/nodes                → all nodes summary
//   GET /api/mpls/nodes/:id            → single node detail
//   GET /api/mpls/nodes/:id/ports      → physical port table
//   GET /api/mpls/nodes/:id/interfaces → router interface table
//   GET /api/mpls/nodes/:id/protocols  → IS-IS / BGP / LDP / MPLS-TE
//   GET /api/mpls/topology             → full topology JSON (nodes + links)
//   GET /api/mpls/events               → Server-Sent Events stream
//   GET /health                        → health check

'use strict';

const grpc       = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const http       = require('http');
const fs         = require('fs');
const path       = require('path');

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const CONFIG      = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const SERVICE_PORT = CONFIG.services.mplsGnmiService.port;   // 3002
const MPLS_CFG    = CONFIG.mplsNetwork;
const NODES       = MPLS_CFG.nodes;                          // node registry
const CREDS       = MPLS_CFG.credentials;
const SAMPLE_NS   = MPLS_CFG.sampleIntervalNs;
const INSECURE    = MPLS_CFG.insecure !== false;             // default true

// ─────────────────────────────────────────────────────────────
// Load gNMI proto (shared with gnmi-service.js)
// ─────────────────────────────────────────────────────────────
const PROTO_PATH   = path.join(__dirname, 'proto/gnmi/gnmi.proto');
const packageDef   = protoLoader.loadSync(PROTO_PATH, {
    keepCase:  true,
    longs:     String,
    enums:     String,
    defaults:  true,
    oneofs:    true,
    includeDirs: [path.join(__dirname, 'proto')]
});
const gnmiProto = grpc.loadPackageDefinition(packageDef).gnmi;

// ─────────────────────────────────────────────────────────────
// In-memory caches
// ─────────────────────────────────────────────────────────────
const nodeCache  = {};   // { nodeId → telemetry cache }
const retryCount = {};   // exponential-backoff counters

// ─────────────────────────────────────────────────────────────
// Server-Sent Events
// ─────────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(type, data) {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) {
        try { c.write(msg); } catch (_) { sseClients.delete(c); }
    }
}

// ─────────────────────────────────────────────────────────────
// gNMI helpers (identical logic to gnmi-service.js)
// ─────────────────────────────────────────────────────────────
function buildPath(pathStr) {
    return {
        elem: pathStr.split('/').filter(Boolean).map(seg => {
            const m = seg.match(/^([^\[]+)(?:\[([^\]]+)\])?$/);
            if (!m) return { name: seg };
            const el = { name: m[1] };
            if (m[2]) {
                el.key = {};
                m[2].split(',').forEach(kv => {
                    const idx = kv.indexOf('=');
                    el.key[kv.slice(0, idx)] = kv.slice(idx + 1);
                });
            }
            return el;
        })
    };
}

function formatPath(p) {
    if (!p || !p.elem) return '';
    return '/' + p.elem.map(e => {
        let s = e.name;
        if (e.key) s += '[' + Object.entries(e.key).map(([k, v]) => `${k}=${v}`).join(',') + ']';
        return s;
    }).join('/');
}

function parseValue(val) {
    if (!val) return null;
    if (val.json_ietf_val) { try { return JSON.parse(val.json_ietf_val); } catch { return val.json_ietf_val; } }
    if (val.json_val)      { try { return JSON.parse(val.json_val);      } catch { return val.json_val;      } }
    if (val.string_val  !== undefined) return val.string_val;
    if (val.int_val     !== undefined) return parseInt(val.int_val,   10);
    if (val.uint_val    !== undefined) return parseInt(val.uint_val,  10);
    if (val.bool_val    !== undefined) return val.bool_val;
    if (val.float_val   !== undefined) return parseFloat(val.float_val);
    return null;
}

// ─────────────────────────────────────────────────────────────
// Create gRPC client for an SR-OS node
// ─────────────────────────────────────────────────────────────
function createClient(nodeId) {
    const cfg    = NODES[nodeId];
    const target = `${cfg.host}:${cfg.gnmiPort}`;

    let creds;
    if (INSECURE) {
        creds = grpc.credentials.createInsecure();
    } else {
        // TLS — skip server cert verification (self-signed in lab)
        creds = grpc.credentials.createSsl(null, null, null,
            { checkServerIdentity: () => undefined });
    }

    const client = new gnmiProto.gNMI(target, creds, {
        'grpc.max_receive_message_length': 4 * 1024 * 1024,
        'grpc.keepalive_time_ms':          30000,
        'grpc.keepalive_timeout_ms':       10000
    });

    const meta = new grpc.Metadata();
    meta.add('username', CREDS.username);
    meta.add('password', CREDS.password);
    return { client, meta };
}

// ─────────────────────────────────────────────────────────────
// Subscription paths — SR-OS specific YANG paths
// ─────────────────────────────────────────────────────────────
// SR-OS uses /state/… (configuration is under /configure/…).
// Nokia srsim 25.10 supports ON_CHANGE for port/interface oper-state
// and SAMPLE for statistics and protocol state.
function buildSubscriptions(nodeId) {
    const isSAR = NODES[nodeId].type === 'SAR-Hmc';
    const subs  = [
        // ── Physical ports (ON_CHANGE for fast oper-state flip) ──────────
        { path: buildPath('state/port'), mode: 1 },   // ON_CHANGE
        // SAMPLE for counters (separate subscription on same path is valid)
        { path: buildPath('state/port'), mode: 2, sample_interval: SAMPLE_NS },

        // ── Router logical interfaces (Base VRF) ─────────────────────────
        { path: buildPath('state/router[router-name=Base]/interface'),
          mode: 1 },                                  // ON_CHANGE oper-state
        { path: buildPath('state/router[router-name=Base]/interface'),
          mode: 2, sample_interval: SAMPLE_NS },      // SAMPLE statistics

        // ── IS-IS adjacencies ────────────────────────────────────────────
        { path: buildPath('state/router[router-name=Base]/isis[isis-instance=0]/adjacency'),
          mode: 2, sample_interval: SAMPLE_NS },

        // ── IS-IS global oper-state ──────────────────────────────────────
        { path: buildPath('state/router[router-name=Base]/isis[isis-instance=0]'),
          mode: 1 },

        // ── BGP neighbors ────────────────────────────────────────────────
        { path: buildPath('state/router[router-name=Base]/bgp/neighbor'),
          mode: 2, sample_interval: SAMPLE_NS },

        // ── BGP aggregate statistics ─────────────────────────────────────
        { path: buildPath('state/router[router-name=Base]/bgp/statistics'),
          mode: 2, sample_interval: SAMPLE_NS },

        // ── LDP sessions ─────────────────────────────────────────────────
        { path: buildPath('state/router[router-name=Base]/ldp'),
          mode: 2, sample_interval: SAMPLE_NS },

        // ── MPLS LSPs (RSVP-TE or SR-TE) ─────────────────────────────────
        { path: buildPath('state/router[router-name=Base]/mpls[mpls-instance=MPLS]/lsp'),
          mode: 2, sample_interval: SAMPLE_NS },

        // ── System name + resource usage ─────────────────────────────────
        { path: buildPath('state/system'), mode: 2, sample_interval: SAMPLE_NS }
    ];

    // RSVP only makes sense on SR-1 core/agg nodes, not SAR-Hmc
    if (!isSAR) {
        subs.push(
            { path: buildPath('state/router[router-name=Base]/rsvp'),
              mode: 2, sample_interval: SAMPLE_NS }
        );
    }

    return subs;
}

// ─────────────────────────────────────────────────────────────
// Cache initialiser
// ─────────────────────────────────────────────────────────────
function initCache(nodeId) {
    nodeCache[nodeId] = {
        _nodeId:    nodeId,
        status:     'connecting',
        lastUpdate: null,
        ports:      {},   // { portId → PortEntry }
        interfaces: {},   // { ifaceName → IfaceEntry }
        protocols: {
            isis: { operState: 'unknown', adjacencies: [] },
            bgp:  { operState: 'unknown', totalPeers: 0, activePeers: 0, neighbors: [] },
            ldp:  { operState: 'unknown', sessions: [] },
            mpls: { activeLsps: 0, lsps: [] },
            rsvp: { operState: 'unknown', activeSessions: 0 }
        },
        system: { nodeName: '', cpuPct: null, memPct: null }
    };
}

// ─────────────────────────────────────────────────────────────
// Subscribe to a node and reconnect on error
// ─────────────────────────────────────────────────────────────
function subscribeToNode(nodeId) {
    const cfg = NODES[nodeId];
    console.log(`[${nodeId}] Connecting to ${cfg.host}:${cfg.gnmiPort} (SR-OS gNMI)…`);

    if (!nodeCache[nodeId]) initCache(nodeId);
    nodeCache[nodeId].status = 'connecting';

    const { client, meta } = createClient(nodeId);
    const subs = buildSubscriptions(nodeId);

    const request = {
        subscribe: {
            mode:     0,   // STREAM
            encoding: 4,   // JSON_IETF
            subscription: subs
        }
    };

    const call = client.Subscribe(meta);
    call.write(request);

    call.on('data', response => {
        try {
            processUpdate(nodeId, response);
        } catch (err) {
            console.error(`[${nodeId}] parse error:`, err.message);
        }
    });

    call.on('error', err => {
        console.error(`[${nodeId}] gNMI error: ${err.message}`);
        nodeCache[nodeId].status   = 'disconnected';
        nodeCache[nodeId].error    = err.message;
        broadcast('node-update', buildNodeSummary(nodeId));

        const r     = retryCount[nodeId] || 0;
        const delay = Math.min(5000 * Math.pow(2, r), 120000);
        retryCount[nodeId] = r + 1;
        console.log(`[${nodeId}] Retry in ${delay / 1000}s (attempt ${r + 1})`);
        setTimeout(() => subscribeToNode(nodeId), delay);
    });

    call.on('end', () => {
        console.log(`[${nodeId}] stream ended — reconnecting in 5s`);
        setTimeout(() => subscribeToNode(nodeId), 5000);
    });
}

// ─────────────────────────────────────────────────────────────
// Process one gNMI SubscribeResponse
// ─────────────────────────────────────────────────────────────
function processUpdate(nodeId, response) {
    if (!nodeCache[nodeId]) initCache(nodeId);
    const cache = nodeCache[nodeId];

    if (cache.status !== 'connected') {
        cache.status = 'connected';
        retryCount[nodeId] = 0;
        console.log(`[${nodeId}] ✓ Connected — receiving telemetry`);
    }
    cache.lastUpdate = new Date().toISOString();

    if (!response.update || !response.update.update) return;

    for (const upd of response.update.update) {
        const pathStr = formatPath(upd.path);
        const value   = parseValue(upd.val);

        if (!pathStr) continue;

        // Route to the correct parser based on path prefix
        if (/\/state\/port/.test(pathStr)) {
            updatePortCache(cache, pathStr, value);

        } else if (/\/router.*\/interface/.test(pathStr)) {
            updateIfaceCache(cache, pathStr, value);

        } else if (/\/isis.*\/adjacency/.test(pathStr)) {
            updateIsisAdjCache(cache, pathStr, value);

        } else if (/\/isis/.test(pathStr)) {
            updateIsisGlobalCache(cache, pathStr, value);

        } else if (/\/bgp/.test(pathStr)) {
            updateBgpCache(cache, pathStr, value);

        } else if (/\/ldp/.test(pathStr)) {
            updateLdpCache(cache, pathStr, value);

        } else if (/\/mpls/.test(pathStr)) {
            updateMplsCache(cache, pathStr, value);

        } else if (/\/rsvp/.test(pathStr)) {
            updateRsvpCache(cache, pathStr, value);

        } else if (/\/state\/system/.test(pathStr)) {
            updateSystemCache(cache, pathStr, value);
        }
    }

    // Push a lightweight summary over SSE so the dashboard updates instantly
    broadcast('node-update', buildNodeSummary(nodeId));
}

// ─────────────────────────────────────────────────────────────
// Port cache updater
// Path examples:
//   /state/port[port-id=1/1/c1/1]
//   /state/port[port-id=1/1/c1/1]/oper-state
//   /state/port[port-id=1/1/c1/1]/statistics/in-octets
// ─────────────────────────────────────────────────────────────
function updatePortCache(cache, pathStr, value) {
    const m = pathStr.match(/port\[port-id=([^\]]+)\]/);
    if (!m) return;
    const portId = m[1];

    if (!cache.ports[portId]) {
        cache.ports[portId] = {
            portId,
            operState: 'unknown',
            inOctets: 0, outOctets: 0,
            inErrors: 0, outErrors: 0,
            inRate:   0, outRate:   0,
            _lastIn:  0, _lastOut:  0, _lastTs: Date.now()
        };
    }
    const port = cache.ports[portId];
    const now  = Date.now();

    if (typeof value === 'string') {
        // Scalar leaf e.g. /oper-state
        if (pathStr.endsWith('/oper-state') || pathStr.match(/port\[[^\]]+\]\/oper-state$/)) {
            port.operState = value;
        }
        return;
    }

    if (typeof value !== 'object' || value === null) return;

    // Top-level port object: { "oper-state": "up", "statistics": { … } }
    if (value['oper-state'] !== undefined) port.operState = value['oper-state'];

    // Statistics can appear at top-level or nested under "statistics"
    const stats = value.statistics || (value['in-octets'] !== undefined ? value : null);
    if (stats) {
        const inOct  = parseInt(stats['in-octets'],  10) || 0;
        const outOct = parseInt(stats['out-octets'], 10) || 0;
        const dt     = (now - port._lastTs) / 1000;
        if (dt > 0 && port._lastIn  > 0) port.inRate  = ((inOct  - port._lastIn)  / dt) * 8;
        if (dt > 0 && port._lastOut > 0) port.outRate = ((outOct - port._lastOut) / dt) * 8;
        port.inOctets  = inOct;
        port.outOctets = outOct;
        port._lastIn   = inOct;
        port._lastOut  = outOct;
        port._lastTs   = now;
        if (stats['in-errors']  !== undefined) port.inErrors  = parseInt(stats['in-errors'],  10) || 0;
        if (stats['out-errors'] !== undefined) port.outErrors = parseInt(stats['out-errors'], 10) || 0;
    }

    // Path may include /statistics/in-octets as a scalar path
    if (pathStr.includes('/statistics/in-octets') && typeof value === 'number') {
        const dt = (now - port._lastTs) / 1000;
        if (dt > 0 && port._lastIn > 0) port.inRate = ((value - port._lastIn) / dt) * 8;
        port.inOctets = value; port._lastIn = value; port._lastTs = now;
    }
    if (pathStr.includes('/statistics/out-octets') && typeof value === 'number') {
        const dt = (now - port._lastTs) / 1000;
        if (dt > 0 && port._lastOut > 0) port.outRate = ((value - port._lastOut) / dt) * 8;
        port.outOctets = value; port._lastOut = value; port._lastTs = now;
    }
}

// ─────────────────────────────────────────────────────────────
// Router interface cache
// Path: /state/router[router-name=Base]/interface[interface-name=to-acc1]
//   or: /state/router[router-name=Base]/interface[interface-name=to-acc1]/oper-state
// SR-OS oper-state values: "inService" | "outOfService" | "transition"
// ─────────────────────────────────────────────────────────────
function updateIfaceCache(cache, pathStr, value) {
    const m = pathStr.match(/interface\[interface-name=([^\]]+)\]/);
    if (!m) return;
    const ifName = m[1];

    if (!cache.interfaces[ifName]) {
        cache.interfaces[ifName] = {
            name:      ifName,
            operState: 'unknown',
            ipAddress: '',
            ipPrefix:  '',
            inOctets:  0, outOctets: 0,
            inRate:    0, outRate:   0,
            _lastIn:   0, _lastOut:  0, _lastTs: Date.now()
        };
    }
    const iface = cache.interfaces[ifName];
    const now   = Date.now();

    if (typeof value === 'string') {
        if (pathStr.endsWith('/oper-state')) iface.operState = normaliseOperState(value);
        return;
    }

    if (typeof value !== 'object' || value === null) return;

    if (value['oper-state'] !== undefined) iface.operState = normaliseOperState(value['oper-state']);

    // IP address — SR-OS structure: ipv4: { primary: { ip-address, prefix-length } }
    if (value.ipv4 && value.ipv4.primary) {
        const pri = value.ipv4.primary;
        if (pri['ip-address']) {
            iface.ipAddress = pri['ip-address'];
            iface.ipPrefix  = pri['prefix-length'] != null
                ? `${pri['ip-address']}/${pri['prefix-length']}`
                : pri['ip-address'];
        }
    }
    // Alt: flat 'ip-address' field
    if (value['ip-address']) iface.ipAddress = value['ip-address'];

    // Statistics
    const stats = value.statistics || (value['in-octets'] !== undefined ? value : null);
    if (stats) {
        const inOct  = parseInt(stats['in-octets'],  10) || 0;
        const outOct = parseInt(stats['out-octets'], 10) || 0;
        const dt     = (now - iface._lastTs) / 1000;
        if (dt > 0 && iface._lastIn  > 0) iface.inRate  = ((inOct  - iface._lastIn)  / dt) * 8;
        if (dt > 0 && iface._lastOut > 0) iface.outRate = ((outOct - iface._lastOut) / dt) * 8;
        iface.inOctets  = inOct;
        iface.outOctets = outOct;
        iface._lastIn   = inOct;
        iface._lastOut  = outOct;
        iface._lastTs   = now;
    }
}

// Map SR-OS oper-state strings to canonical 'up'/'down'/'unknown'
function normaliseOperState(v) {
    if (!v) return 'unknown';
    const s = String(v).toLowerCase();
    if (s === 'inservice' || s === 'up') return 'up';
    if (s === 'outofservice' || s === 'down') return 'down';
    return s; // leave 'transition', 'testing', etc. as-is
}

// ─────────────────────────────────────────────────────────────
// IS-IS global state
// Path: /state/router[router-name=Base]/isis[isis-instance=0]
// ─────────────────────────────────────────────────────────────
function updateIsisGlobalCache(cache, pathStr, value) {
    if (typeof value === 'string') {
        if (pathStr.endsWith('/oper-state')) cache.protocols.isis.operState = normaliseOperState(value);
        return;
    }
    if (typeof value === 'object' && value !== null) {
        if (value['oper-state'] !== undefined) cache.protocols.isis.operState = normaliseOperState(value['oper-state']);
    }
}

// ─────────────────────────────────────────────────────────────
// IS-IS adjacency cache
// Path: /state/router[router-name=Base]/isis[isis-instance=0]/
//       adjacency[system-id=XXXX.YYYY.ZZZZ][interface-name=to-acc1]
// Value: { "adjacency-state": "up", "neighbor-system-id": "…", … }
// ─────────────────────────────────────────────────────────────
function updateIsisAdjCache(cache, pathStr, value) {
    // Extract adjacency key(s)
    const sysM   = pathStr.match(/adjacency\[.*?system-id=([^\],]+)/);
    const ifaceM = pathStr.match(/adjacency\[.*?interface-name=([^\]]+)/);
    if (!sysM && !ifaceM) return;

    const sysId   = sysM   ? sysM[1]   : 'unknown';
    const ifaceName = ifaceM ? ifaceM[1] : 'unknown';
    const adjKey  = `${sysId}|${ifaceName}`;

    const adjs  = cache.protocols.isis.adjacencies;
    let adj     = adjs.find(a => a.key === adjKey);
    if (!adj) {
        adj = { key: adjKey, systemId: sysId, interfaceName: ifaceName, state: 'unknown', neighborLevel: '' };
        adjs.push(adj);
    }

    if (typeof value === 'string') {
        if (pathStr.endsWith('/adjacency-state')) adj.state = normaliseOperState(value);
        return;
    }
    if (typeof value === 'object' && value !== null) {
        if (value['adjacency-state'] !== undefined) adj.state = normaliseOperState(value['adjacency-state']);
        if (value['neighbor-system-id']) adj.systemId = value['neighbor-system-id'];
        if (value['level'])              adj.neighborLevel = value['level'];
        if (value['interface-name'])     adj.interfaceName = value['interface-name'];
    }
}

// ─────────────────────────────────────────────────────────────
// BGP cache
// Path: /state/router[router-name=Base]/bgp/neighbor[ip-address=X.X.X.X]
//       /state/router[router-name=Base]/bgp/statistics
// ─────────────────────────────────────────────────────────────
function updateBgpCache(cache, pathStr, value) {
    const bgp = cache.protocols.bgp;

    // BGP statistics (aggregate)
    if (pathStr.includes('/bgp/statistics') || (pathStr.includes('/bgp') && !pathStr.includes('/neighbor'))) {
        if (typeof value === 'object' && value !== null) {
            if (value['oper-state'] !== undefined) bgp.operState = normaliseOperState(value['oper-state']);
            if (value['total-peers']  !== undefined) bgp.totalPeers  = parseInt(value['total-peers'],  10) || 0;
            if (value['active-peers'] !== undefined) bgp.activePeers = parseInt(value['active-peers'], 10) || 0;
        }
        if (typeof value === 'string' && pathStr.endsWith('/oper-state')) bgp.operState = normaliseOperState(value);
        return;
    }

    // Per-neighbor
    const m = pathStr.match(/neighbor\[ip-address=([^\]]+)\]/);
    if (!m) return;
    const peerIp = m[1];

    let nbr = bgp.neighbors.find(n => n.peerAddress === peerIp);
    if (!nbr) {
        nbr = { peerAddress: peerIp, sessionState: 'unknown', peerAs: null,
                rxRoutes: 0, txRoutes: 0, uptime: null };
        bgp.neighbors.push(nbr);
    }

    if (typeof value === 'string') {
        if (pathStr.endsWith('/session-state')) nbr.sessionState = value.toLowerCase();
        return;
    }
    if (typeof value === 'object' && value !== null) {
        if (value['session-state'] !== undefined) nbr.sessionState = value['session-state'].toLowerCase();
        if (value['peer-as']       !== undefined) nbr.peerAs       = value['peer-as'];
        if (value['statistics']) {
            const s = value['statistics'];
            if (s['received-routes'] !== undefined) nbr.rxRoutes = parseInt(s['received-routes'], 10) || 0;
            if (s['sent-routes']     !== undefined) nbr.txRoutes = parseInt(s['sent-routes'],     10) || 0;
        }
        if (value['peer-address']) nbr.peerAddress = value['peer-address'];
    }

    // Recompute aggregate counts from neighbor list
    bgp.totalPeers  = bgp.neighbors.length;
    bgp.activePeers = bgp.neighbors.filter(n => n.sessionState === 'established').length;
}

// ─────────────────────────────────────────────────────────────
// LDP cache
// Path: /state/router[router-name=Base]/ldp
//       /state/router[router-name=Base]/ldp/session[ldp-neighbor-id=X.X.X.X:0]
// ─────────────────────────────────────────────────────────────
function updateLdpCache(cache, pathStr, value) {
    const ldp = cache.protocols.ldp;

    // LDP global state
    if (!pathStr.includes('/session')) {
        if (typeof value === 'string') {
            if (pathStr.endsWith('/oper-state')) ldp.operState = normaliseOperState(value);
        } else if (typeof value === 'object' && value !== null) {
            if (value['oper-state'] !== undefined) ldp.operState = normaliseOperState(value['oper-state']);
        }
        return;
    }

    // LDP session
    const m = pathStr.match(/session\[ldp-neighbor-id=([^\]]+)\]/);
    if (!m) return;
    const neighborId = m[1];

    let sess = ldp.sessions.find(s => s.neighborId === neighborId);
    if (!sess) {
        sess = { neighborId, operState: 'unknown', uptime: null, localLdpId: '', txKa: 0, rxKa: 0 };
        ldp.sessions.push(sess);
    }

    if (typeof value === 'string') {
        if (pathStr.endsWith('/oper-state')) sess.operState = normaliseOperState(value);
        return;
    }
    if (typeof value === 'object' && value !== null) {
        if (value['oper-state']  !== undefined) sess.operState  = normaliseOperState(value['oper-state']);
        if (value['local-lsr-id'] !== undefined) sess.localLdpId = value['local-lsr-id'];
        if (value['statistics']) {
            const s = value['statistics'];
            if (s['keep-alive-sent']     !== undefined) sess.txKa = parseInt(s['keep-alive-sent'],     10) || 0;
            if (s['keep-alive-received'] !== undefined) sess.rxKa = parseInt(s['keep-alive-received'], 10) || 0;
        }
    }
}

// ─────────────────────────────────────────────────────────────
// MPLS-TE LSP cache
// Path: /state/router[router-name=Base]/mpls[mpls-instance=MPLS]/lsp[lsp-name=X]
// ─────────────────────────────────────────────────────────────
function updateMplsCache(cache, pathStr, value) {
    const mpls = cache.protocols.mpls;
    const m    = pathStr.match(/lsp\[lsp-name=([^\]]+)\]/);
    if (!m) return;
    const lspName = m[1];

    let lsp = mpls.lsps.find(l => l.name === lspName);
    if (!lsp) {
        lsp = { name: lspName, operState: 'unknown', toAddr: '', activePath: '', hopCount: 0 };
        mpls.lsps.push(lsp);
    }

    if (typeof value === 'string') {
        if (pathStr.endsWith('/oper-state')) lsp.operState = normaliseOperState(value);
        return;
    }
    if (typeof value === 'object' && value !== null) {
        if (value['oper-state']   !== undefined) lsp.operState   = normaliseOperState(value['oper-state']);
        if (value['to-address']   !== undefined) lsp.toAddr      = value['to-address'];
        if (value['active-path']  !== undefined) lsp.activePath  = value['active-path'];
        if (value['hop-count']    !== undefined) lsp.hopCount    = parseInt(value['hop-count'], 10) || 0;
    }

    mpls.activeLsps = mpls.lsps.filter(l => l.operState === 'up').length;
}

// ─────────────────────────────────────────────────────────────
// RSVP cache
// Path: /state/router[router-name=Base]/rsvp
// ─────────────────────────────────────────────────────────────
function updateRsvpCache(cache, pathStr, value) {
    const rsvp = cache.protocols.rsvp;
    if (typeof value === 'string') {
        if (pathStr.endsWith('/oper-state')) rsvp.operState = normaliseOperState(value);
        return;
    }
    if (typeof value === 'object' && value !== null) {
        if (value['oper-state']       !== undefined) rsvp.operState      = normaliseOperState(value['oper-state']);
        if (value['active-sessions']  !== undefined) rsvp.activeSessions = parseInt(value['active-sessions'], 10) || 0;
        if (value['statistics']) {
            const s = value['statistics'];
            if (s['active-sessions'] !== undefined) rsvp.activeSessions = parseInt(s['active-sessions'], 10) || 0;
        }
    }
}

// ─────────────────────────────────────────────────────────────
// System cache
// Path: /state/system/...
// ─────────────────────────────────────────────────────────────
function updateSystemCache(cache, pathStr, value) {
    const sys = cache.system;
    if (typeof value === 'string') {
        if (pathStr.endsWith('/oper-name') || pathStr.endsWith('/name')) sys.nodeName = value;
        return;
    }
    if (typeof value === 'object' && value !== null) {
        if (value['oper-name'] !== undefined) sys.nodeName = value['oper-name'];
        if (value['name']      !== undefined) sys.nodeName = value['name'];

        // CPU — SR-OS: { "cpu-usage": { "busy-pct": 12 } }
        const cpu = value['cpu-usage'] || value.cpu;
        if (cpu) {
            if (cpu['busy-pct']  !== undefined) sys.cpuPct = parseFloat(cpu['busy-pct']);
            if (cpu['total']     !== undefined) sys.cpuPct = parseFloat(cpu['total']);
            if (cpu['instant']   !== undefined) sys.cpuPct = parseFloat(cpu['instant']);
        }
        if (typeof value['cpu-usage'] === 'number') sys.cpuPct = value['cpu-usage'];

        // Memory — SR-OS: { "memory-pools": { "total-in-use": N, "total-available": N } }
        const mem = value['memory-pools'] || value.memory;
        if (mem) {
            const used  = parseInt(mem['total-in-use'],    10) || 0;
            const avail = parseInt(mem['total-available'], 10) || 0;
            if (avail > 0) sys.memPct = Math.round((used / avail) * 100);
            if (mem['utilization'] !== undefined) sys.memPct = parseInt(mem['utilization'], 10);
        }
    }
}

// ─────────────────────────────────────────────────────────────
// Summary builder — lightweight version for SSE & /nodes list
// ─────────────────────────────────────────────────────────────
function buildNodeSummary(nodeId) {
    const cfg   = NODES[nodeId];
    const cache = nodeCache[nodeId];
    if (!cache) {
        return { nodeId, name: cfg.name, type: cfg.type, role: cfg.role,
                 host: cfg.host, status: 'unknown', lastUpdate: null };
    }

    const ports     = Object.values(cache.ports);
    const portsUp   = ports.filter(p => p.operState === 'up').length;
    const ifaces    = Object.values(cache.interfaces);
    const ifacesUp  = ifaces.filter(i => i.operState === 'up').length;
    const isis      = cache.protocols.isis;
    const bgp       = cache.protocols.bgp;
    const ldp       = cache.protocols.ldp;

    return {
        nodeId,
        name:       cfg.name,
        type:       cfg.type,
        role:       cfg.role,
        host:       cfg.host,
        status:     cache.status,
        lastUpdate: cache.lastUpdate,
        summary: {
            ports:      { total: ports.length,  up: portsUp },
            interfaces: { total: ifaces.length, up: ifacesUp },
            isis:       { operState: isis.operState, adjacencies: isis.adjacencies.length,
                          upAdj: isis.adjacencies.filter(a => a.state === 'up').length },
            bgp:        { operState: bgp.operState, totalPeers: bgp.totalPeers, activePeers: bgp.activePeers },
            ldp:        { operState: ldp.operState, sessions: ldp.sessions.length,
                          upSessions: ldp.sessions.filter(s => s.operState === 'up').length },
            mpls:       { activeLsps: cache.protocols.mpls.activeLsps },
            rsvp:       { operState: cache.protocols.rsvp.operState,
                          activeSessions: cache.protocols.rsvp.activeSessions },
            cpu:        cache.system.cpuPct,
            mem:        cache.system.memPct,
            nodeName:   cache.system.nodeName
        }
    };
}

function buildFullTopology() {
    const nodes = {};
    for (const nodeId of Object.keys(NODES)) {
        nodes[nodeId] = buildNodeSummary(nodeId);
    }
    return { nodes, ts: new Date().toISOString() };
}

// ─────────────────────────────────────────────────────────────
// HTTP server — REST API
// ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const url      = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // ── Health check ────────────────────────────────────────
    if (pathname === '/health' && req.method === 'GET') {
        const conns = {};
        for (const id of Object.keys(NODES)) conns[id] = nodeCache[id]?.status || 'unknown';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'gnmi-sros-service', connections: conns }));
        return;
    }

    // ── GET /api/mpls/nodes ──────────────────────────────────
    if (pathname === '/api/mpls/nodes' && req.method === 'GET') {
        const result = {};
        for (const id of Object.keys(NODES)) result[id] = buildNodeSummary(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ nodes: result, ts: new Date().toISOString() }));
        return;
    }

    // ── GET /api/mpls/topology ───────────────────────────────
    if (pathname === '/api/mpls/topology' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(buildFullTopology()));
        return;
    }

    // ── GET /api/mpls/events (SSE) ───────────────────────────
    if (pathname === '/api/mpls/events' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        // Initial snapshot
        res.write(`event: snapshot\ndata: ${JSON.stringify(buildFullTopology())}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }

    // ── Per-node routes ──────────────────────────────────────
    const nodeMatch = pathname.match(/^\/api\/mpls\/nodes\/([^/]+)(\/.*)?$/);
    if (nodeMatch) {
        const nodeId = nodeMatch[1];
        const sub    = (nodeMatch[2] || '/').replace(/\/$/, '') || '/';

        if (!NODES[nodeId]) {
            const ids = Object.keys(NODES).join(', ');
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Node "${nodeId}" not found. Valid: ${ids}` }));
            return;
        }

        const cache = nodeCache[nodeId];

        if (sub === '/' || sub === '') {
            // Full detail
            const out = {
                ...buildNodeSummary(nodeId),
                ports:      cache ? Object.values(cache.ports) : [],
                interfaces: cache ? Object.values(cache.interfaces) : [],
                protocols:  cache ? cache.protocols : {},
                system:     cache ? cache.system : {}
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(out));

        } else if (sub === '/ports') {
            const ports = cache ? Object.values(cache.ports) : [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ nodeId, ports }));

        } else if (sub === '/interfaces') {
            const ifaces = cache ? Object.values(cache.interfaces) : [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ nodeId, interfaces: ifaces }));

        } else if (sub === '/protocols') {
            const protos = cache ? cache.protocols : {};
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ nodeId, protocols: protos }));

        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unknown sub-resource. Use /ports, /interfaces, /protocols' }));
        }
        return;
    }

    // ── 404 ──────────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────
server.listen(SERVICE_PORT, () => {
    console.log(`\n=== Nokia SR-OS gNMI Service ===`);
    console.log(`Listening on http://localhost:${SERVICE_PORT}`);
    console.log(`\nEndpoints:`);
    console.log(`  GET /api/mpls/nodes                 — all nodes summary`);
    console.log(`  GET /api/mpls/nodes/:id             — full node detail`);
    console.log(`  GET /api/mpls/nodes/:id/ports       — physical port table`);
    console.log(`  GET /api/mpls/nodes/:id/interfaces  — router interface table`);
    console.log(`  GET /api/mpls/nodes/:id/protocols   — IS-IS / BGP / LDP / MPLS-TE`);
    console.log(`  GET /api/mpls/topology              — full topology`);
    console.log(`  GET /api/mpls/events                — SSE stream`);
    console.log(`  GET /health                         — health check\n`);

    console.log(`Nodes:`);
    for (const [id, cfg] of Object.entries(NODES)) {
        console.log(`  ${id.padEnd(12)} ${cfg.name.padEnd(12)} ${cfg.type.padEnd(8)} ${cfg.host}:${cfg.gnmiPort}  [${cfg.role}]`);
        initCache(id);
    }
    console.log('');

    // Start with dc1 (primary focus of this service).
    // Comment-in the others when those nodes are reachable.
    subscribeToNode('mpls-dc1');

    // Uncomment to subscribe to additional nodes:
    // subscribeToNode('mpls-dc2');
    // subscribeToNode('mpls-acc1');
    // subscribeToNode('mpls-acc2');
    // subscribeToNode('mpls-a1-1');
    // subscribeToNode('mpls-a1-2');
    // subscribeToNode('mpls-a1-3');
});

// Periodic SSE heartbeat — keeps connections alive and pushes fresh snapshots
setInterval(() => {
    if (sseClients.size > 0) broadcast('snapshot', buildFullTopology());
}, 5000);
