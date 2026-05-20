// Ping Service for Smart Grid Monitoring
// Provides: ICMP ping, gnmic telemetry proxy, MPLS link/access health, TPT control

const http = require('http');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const url = require('url');
const path = require('path');

// Load centralized config (single source of truth).
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const PORT = CONFIG.services.pingService.port;

// ── TPT (IEC 61850 GOOSE) proxy helpers ──────────────────────────────────────
// Forwards requests to the tpt-daemon HTTP API running inside each RTU container.
//
// WHY docker exec instead of direct http.request:
// The macOS host bridge interface (bridge103) is assigned 192.168.30.0 — the
// network address rather than a usable host address.  Node.js TCP sockets
// cannot source a connection from that address and fail immediately with
// EHOSTUNREACH.  Routing via `docker exec <container> wget` sidesteps the
// host-network entirely: wget runs inside the container and calls localhost.
const MPLS_RTUS = CONFIG.mplsRtus || {};

// Lookup container name by host IP (config.mplsRtus[x].name == docker container name).
function _rtuContainer(host) {
    const entry = Object.values(MPLS_RTUS).find(r => r.host === host);
    return entry?.name || null;   // e.g. "RTU1" or "RTU2"
}

function tptFetch(host, port, method, endpoint, body) {
    const container = _rtuContainer(host);
    if (!container) {
        return Promise.resolve({ ok: false, error: `No RTU container mapped to host ${host}` });
    }

    return new Promise(resolve => {
        // Build docker + wget argv array — no shell, no quoting issues.
        // wget -qO- prints response to stdout; --post-data sends a POST body.
        const url  = `http://localhost:${port}${endpoint}`;
        const args = ['exec', container, 'wget', '-qO-', '--timeout=5'];
        if (method === 'POST') {
            const postBody = body ? JSON.stringify(body) : '';
            args.push('--post-data', postBody);
        }
        args.push(url);

        const proc = spawn('docker', args);
        let stdout = '', stderr = '';
        proc.stdout.on('data', c => { stdout += c; });
        proc.stderr.on('data', c => { stderr += c; });
        proc.on('close', code => {
            if (code !== 0) {
                resolve({ ok: false, error: stderr.trim() || `wget exit ${code}` });
                return;
            }
            try   { resolve({ ok: true, data: JSON.parse(stdout) }); }
            catch { resolve({ ok: false, error: 'JSON parse error', raw: stdout.slice(0, 200) }); }
        });
        proc.on('error', e => resolve({ ok: false, error: e.message }));

        // Hard kill after 7 s
        setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: false, error: 'timeout' }); }, 7000);
    });
}

async function tptAll(method, endpoint, body) {
    const rtus = Object.values(MPLS_RTUS).filter(r => r && typeof r === 'object' && r.host);
    if (!rtus.length) return { error: 'No MPLS RTUs configured in config.json' };
    const results = await Promise.all(
        rtus.map(r => tptFetch(r.host, r.tptPort || 8850, method, endpoint, body)
                       .then(res => ({ name: r.name, host: r.host, ...res })))
    );
    const out = {};
    rtus.forEach((r, i) => { out[r.name] = results[i]; });
    return out;
}
// Allow pings to MPLS network nodes and MPLS RTUs.
const ALLOWED_IPS = [
    ...Object.values(CONFIG.mplsNetwork?.nodes || {}).map(n => n.host),
    ...Object.values(CONFIG.mplsRtus           || {}).map(n => n.host),
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

        exec(cmd, { maxBuffer: 8 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
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

// Retry wrapper: up to `retries` additional attempts with `delayMs` gap.
// Returns [] on final failure instead of throwing, so callers always get an array.
async function gnmicGetSafe(host, gnmiPort, gnmiPath, retries = 1, delayMs = 1000) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await gnmicGet(host, gnmiPort, gnmiPath);
        } catch (err) {
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
    }
    return [];
}

// Simple concurrency limiter — prevents > `limit` parallel node fetches
// from firing simultaneously (avoids overwhelming docker exec with 50+ calls).
function createSemaphore(limit) {
    let active = 0;
    const queue = [];
    return function acquire() {
        return new Promise(resolve => {
            const tryRun = () => {
                if (active < limit) {
                    active++;
                    resolve(() => { active--; if (queue.length) queue.shift()(); });
                } else {
                    queue.push(tryRun);
                }
            };
            tryRun();
        });
    };
}

// Global IS-IS adjacency semaphore — limits concurrent IS-IS interface/adjacency
// GETs across ALL nodes.  These are the heaviest paths (full nested adjacency
// objects); Nokia SR OS TIMOS drops them when more than 2 hit at the same time
// even if the per-node semaphore would allow it.
const _isisSem = createSemaphore(2);

async function gnmicGetIsisAdj(host, gnmiPort, path, retries = 2, delayMs = 900) {
    const release = await _isisSem();
    try {
        return await gnmicGetSafe(host, gnmiPort, path, retries, delayMs);
    } finally {
        release();
    }
}

// Fetch live telemetry for a MPLS node via gnmic.
// Returns { node, host, ts, interfaces[], ports[], isis{} }
async function fetchGnmicNodeData(nodeId) {
    const nodeCfg = (MPLS_CFG.nodes || {})[nodeId];
    if (!nodeCfg) throw new Error(`Unknown node: ${nodeId}`);

    const host     = nodeCfg.host;
    const gnmiPort = nodeCfg.gnmiPort || 57400;

    // Run all eight queries in parallel.
    // Queries 1-3: gnmicGetSafe (1 retry, 1 s delay).
    // Queries 4-5: lightweight scalars — single attempt, fall back to [].
    // Queries 6-8: heavier nested objects (adjacency lists) — 2 retries with
    //              800 ms gap so a transient Nokia SR OS throttle doesn't lose data.
    const [
        ifaceStateUpdates, ifaceFullUpdates, portUpdates,
        isisOperUpdates, isisLevelUpdates, isisIfaceUpdates,
        srPoliciesUpdates, srAdjSidUpdates
    ] = await Promise.all([
        // 1. All routers, all interfaces, oper-state only
        gnmicGetSafe(host, gnmiPort, '/state/router[router-name=*]/interface[interface-name=*]/oper-state'),
        // 2. Base router, full interface objects (includes primary IP)
        gnmicGetSafe(host, gnmiPort, '/state/router[router-name=Base]/interface[interface-name=*]'),
        // 3. Physical port oper-states
        gnmicGetSafe(host, gnmiPort, '/state/port[port-id=*]/oper-state'),
        // 4. IS-IS instance overall oper-state (scalar — lightweight)
        gnmicGetSafe(host, gnmiPort, '/state/router[router-name=Base]/isis[isis-instance=1]/oper-state', 1, 600),
        // 5. IS-IS level info (LSP counts, overload status)
        gnmicGetSafe(host, gnmiPort, '/state/router[router-name=Base]/isis[isis-instance=1]/level[level-number=*]', 1, 600),
        // 6. IS-IS interfaces + adjacencies — heaviest query; throttled by global
        //    _isisSem (max 2 across all nodes) + 2 retries × 900 ms
        gnmicGetIsisAdj(host, gnmiPort, '/state/router[router-name=Base]/isis[isis-instance=1]/interface[interface-name=*]'),
        // 7. Segment Routing policies summary
        gnmicGetSafe(host, gnmiPort, '/state/router[router-name=Base]/segment-routing', 1, 600),
        // 8. SR adjacency-SIDs — also throttled by _isisSem
        gnmicGetIsisAdj(host, gnmiPort, '/state/router[router-name=Base]/isis[isis-instance=1]/interface[interface-name=*]/adjacency[adjacency-index=*]/sr-ipv4')
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

    // ── Parse Segment Routing data ────────────────────────────────────
    // Query 7: SR policies summary from the segment-routing root object
    let srPolicies = null;
    if (srPoliciesUpdates.length > 0) {
        const srRoot = Object.values(srPoliciesUpdates[0].values)[0] || {};
        const pol = srRoot['sr-policies'] || {};
        srPolicies = {
            ttmPreferences:           pol['ttm-preferences']             ?? null,
            bindingSidsAllocated:     pol['binding-sids-allocated']      ?? 0,
            srv6BindingSidsAllocated: pol['srv6-binding-sids-allocated'] ?? 0,
            activeBgpPolicies:        pol['active-bgp-policies']         ?? 0,
            activeStaticLocalPolicies:pol['active-static-local-policies']?? 0,
            bgpPolicies:              pol['bgp-policies']                ?? 0,
            staticLocalPolicies:      pol['static-local-policies']       ?? 0,
            staticNonLocalPolicies:   pol['static-non-local-policies']   ?? 0
        };
    }

    // Query 8: SR adjacency-SIDs keyed by interface+adj-index
    const srAdjSids = srAdjSidUpdates.map(upd => {
        const ifaceM = upd.Path.match(/interface\[interface-name=([^\]]+)\]/);
        const adjM   = upd.Path.match(/adjacency\[adjacency-index=(\d+)\]/);
        const obj    = Object.values(upd.values)[0] || {};
        const lfa    = obj['sr-lfa-info'] || {};
        return {
            ifaceName:   ifaceM ? ifaceM[1] : '?',
            adjIndex:    adjM   ? parseInt(adjM[1], 10) : 0,
            sidType:     obj['sid-type']      || 'unknown',
            sidValue:    obj['sid-value']     ?? null,
            sidProtected:obj['sid-protected'] ?? false,
            backupType:  lfa['backup-lfa-protection-type'] || '—',
            backupIp:    lfa['backup-path-ip']             || '—'
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
        },
        sr: {
            policies: srPolicies,
            adjSids:  srAdjSids
        }
    };
}

// ══════════════════════════════════════════════════════════════════════════
// ── Push Telemetry — gNMI ON_CHANGE subscribe + SSE broadcast ────────────
// ══════════════════════════════════════════════════════════════════════════

// ── In-memory state cache ─────────────────────────────────────────────────
const telemetryCache = { nodes: {}, lsp: null, ts: null, ready: false };

// ── SSE client registry ───────────────────────────────────────────────────
const sseClients = new Set();
let   _broadcastTimer = null;

function scheduleBroadcast() {
    if (_broadcastTimer) return;
    _broadcastTimer = setTimeout(() => {
        _broadcastTimer = null;
        if (!telemetryCache.ready || sseClients.size === 0) return;
        const payload = `event: telemetry\ndata: ${JSON.stringify({
            ts: telemetryCache.ts, nodes: telemetryCache.nodes, lsp: telemetryCache.lsp
        })}\n\n`;
        for (const client of [...sseClients]) {
            try { client.write(payload); } catch { sseClients.delete(client); }
        }
    }, 200);  // 200 ms debounce — coalesces rapid back-to-back changes
}

// ── LSP fetch (refactored from /api/telemetry/all inline) ─────────────────
async function fetchLspData() {
    try {
        const cfg = (MPLS_CFG.nodes || {})['mpls-a1-1'];
        if (!cfg) return null;
        const { host } = cfg;
        const gnmiPort = cfg.gnmiPort || 57400;

        const [lspUpdates, hopUpdates] = await Promise.all([
            gnmicGet(host, gnmiPort,
                '/state/router[router-name=Base]/mpls/lsp[lsp-name=*]').catch(() => []),
            gnmicGet(host, gnmiPort,
                '/state/router[router-name=Base]/mpls/actual-route-hop-list[hop-list-index=*]').catch(() => [])
        ]);

        // gNMI returned nothing (timeout, node unreachable, etc.) — return a
        // minimal fallback so telemetryCache.lsp is never null and the SSE push
        // always contains a renderable object rather than a blank card.
        if (!lspUpdates.length) return {
            lspName: 'SR-TE LSP', operState: 'unknown',
            activePath: null, pathType: 'unknown',
            headend: 'ACCESS1-1', tailend: 'ACCESS1-3',
            headendNodeId: 'mpls-a1-1', tailendNodeId: 'mpls-a1-3',
            configuredPaths: null, operationalPaths: null, paths: []
        };
        const match = lspUpdates.find(u => (u.Path||'').toLowerCase().includes('a1-3'))
                   || lspUpdates[0];
        const nameM = (match.Path||'').match(/lsp\[lsp-name=([^\]]+)\]/i);
        const obj   = Object.values(match.values||{})[0] || {};
        const operState  = ['up','down'].includes((obj['oper-state']||'').toLowerCase())
            ? obj['oper-state'].toLowerCase() : 'unknown';
        const activePath = obj['active-path'] || null;
        const paths = [];
        (Array.isArray(obj.primary)   ? obj.primary   : []).forEach(p => paths.push({
            name: p['path-name']||'primary',  type:'primary',
            operState: (p['oper-state']||'unknown').toLowerCase(),
            pathState: p['path-state']||'—',  arHopListIndex: p['ar-hop-list-index']??null
        }));
        (Array.isArray(obj.secondary) ? obj.secondary : []).forEach(s => paths.push({
            name: s['path-name']||'secondary', type:'secondary',
            operState: (s['oper-state']||'unknown').toLowerCase(),
            pathState: s['path-state']||'—',  arHopListIndex: s['ar-hop-list-index']??null
        }));
        const hit = paths.find(p => p.name === activePath);

        // Router-id → nodeId mapping from cached system-interface IPs
        const ridToNode = {};
        for (const [nid, data] of Object.entries(telemetryCache.nodes)) {
            const sys = (data.interfaces||[]).find(i => i.name==='system');
            if (sys?.ipv4) ridToNode[sys.ipv4] = nid;
        }
        // Build hop-lists
        const hopLists = {};
        for (const upd of hopUpdates) {
            const m = (upd.Path||'').match(/hop-list-index=(\d+)/);
            if (!m) continue;
            const idx = +m[1];
            const o = Object.values(upd.values||{})[0]||{};
            (hopLists[idx] = hopLists[idx]||[]).push({
                hopIndex: +(o['hop-index']||0), routerId: o['router-id']||null
            });
        }
        for (const k of Object.keys(hopLists)) hopLists[k].sort((a,b)=>a.hopIndex-b.hopIndex);

        return {
            lspName:          nameM ? nameM[1] : 'SR-TE LSP',
            operState, activePath,
            pathType:         hit ? hit.type : 'unknown',
            headend: 'ACCESS1-1', tailend: 'ACCESS1-3',
            headendNodeId: 'mpls-a1-1', tailendNodeId: 'mpls-a1-3',
            configuredPaths:  obj['configured-paths']??null,
            operationalPaths: obj['operational-paths']??null,
            paths: paths.map(p => ({
                ...p,
                nodeHops: (p.arHopListIndex!=null && hopLists[p.arHopListIndex])
                    ? ['mpls-a1-1', ...hopLists[p.arHopListIndex]
                        .map(h=>ridToNode[h.routerId]).filter(Boolean)]
                    : []
            }))
        };
    } catch { return {
        lspName: 'SR-TE LSP', operState: 'unknown',
        activePath: null, pathType: 'unknown',
        headend: 'ACCESS1-1', tailend: 'ACCESS1-3',
        headendNodeId: 'mpls-a1-1', tailendNodeId: 'mpls-a1-3',
        configuredPaths: null, operationalPaths: null, paths: []
    }; }
}

// ── Route-table statistics fetch ─────────────────────────────────────────
// Uses the /statistics sub-path which returns per-protocol active-route counts
// as a single lightweight gNMI object — far smaller than fetching all routes.
// Maps Nokia SR OS field names to the keys the telemetry page expects:
//   direct    → local    (directly connected prefixes)
//   isis      → isis
//   isis-lfa  → isis-lfa (LFA backup; kept separate so total is accurate)
//   static    → static
//   bgp       → bgp
async function fetchRouteStats(host, gnmiPort) {
    try {
        const updates = await gnmicGet(
            host, gnmiPort || 57400,
            '/state/router[router-name=Base]/route-table/unicast/ipv4/statistics'
        );
        if (!updates.length) return null;
        const stats = Object.values(updates[0].values || {})[0] || {};
        const byProtocol = {};
        let total = 0;
        for (const [proto, obj] of Object.entries(stats)) {
            if (!obj || typeof obj !== 'object') continue;
            const active = obj['active-routes'] || 0;
            if (!active) continue;
            // Normalise keys so the frontend columns work:
            //   direct   → local   (connected/directly-attached prefixes)
            //   isis-lfa → isis    (LFA backup routes are still IS-IS learned)
            const key = proto === 'direct'   ? 'local'
                      : proto === 'isis-lfa' ? 'isis'
                      : proto;
            byProtocol[key] = (byProtocol[key] || 0) + active;
            total += active;
        }
        return { total, byProtocol };
    } catch {
        return null;   // caller shows '—' gracefully
    }
}

// Scheduled LSP re-fetch (debounced — one re-fetch even if multiple LSP notifications burst)
let _lspRefreshTimer = null;
function scheduleLspRefresh() {
    if (_lspRefreshTimer) return;
    _lspRefreshTimer = setTimeout(async () => {
        _lspRefreshTimer = null;
        const lsp = await fetchLspData();
        if (lsp) {
            telemetryCache.lsp = lsp;
            telemetryCache.ts  = new Date().toISOString();
            scheduleBroadcast();
            console.log('[push] LSP cache refreshed →', lsp.operState, lsp.pathType);
        }
    }, 500);
}

// ── JSON stream parser ────────────────────────────────────────────────────
// gnmic subscribe outputs one JSON object per notification (NDJSON-style).
// We track brace depth to reliably extract complete objects even if the
// chunk boundary falls mid-object.
function makeJsonStreamParser(onObject) {
    let buf = '', depth = 0, inStr = false, esc = false, start = -1;
    return function feed(chunk) {
        buf += chunk;
        for (let i = 0; i < buf.length; i++) {
            const c = buf[i];
            if (esc)    { esc = false; continue; }
            if (inStr)  { if (c==='\\') esc=true; else if (c==='"') inStr=false; continue; }
            if (c==='"') { inStr=true; continue; }
            if (c==='{') { if (depth===0) start=i; depth++; }
            else if (c==='}') {
                if (--depth===0 && start>=0) {
                    try { onObject(JSON.parse(buf.slice(start, i+1))); } catch { /* skip */ }
                    start = -1;
                }
            }
        }
        buf = start >= 0 ? buf.slice(start) : '';
    };
}

// ── Notification handler ──────────────────────────────────────────────────
// gnmic subscribe uses a prefix + short Path per update (different from GET
// which puts the full path in Path). Reconstruct the canonical full path.
function handleSubscribeNotification(nodeId, notif) {
    if (notif['sync-response'] || !Array.isArray(notif.updates)) return;
    let changed = false;

    const prefix = notif.prefix || '';

    for (const upd of notif.updates) {
        // Full path = prefix + "/" + leaf path (strip leading slash if any)
        const leafPath = (upd.Path || '').replace(/^\//, '');
        const fullPath = prefix ? `${prefix}/${leafPath}` : leafPath;

        // Value: in subscribe mode the key is just the leaf name, not the full path
        const val  = Object.values(upd.values||{})[0];
        const node = telemetryCache.nodes[nodeId];

        // Port oper-state
        if (fullPath.includes('port[port-id=') && fullPath.endsWith('oper-state')) {
            const m = fullPath.match(/port\[port-id=([^\]]+)\]/);
            if (m && node) {
                const p = node.ports.find(p => p.portId === m[1]);
                if (p && p.operState !== val) {
                    p.operState = val;
                    changed = true;
                    console.log(`[push] ${nodeId} port ${m[1]} → ${val}`);
                }
            }
            continue;
        }

        // Interface oper-state (skip ISIS sub-paths)
        if (fullPath.includes('interface[interface-name=') &&
            fullPath.endsWith('oper-state') && !fullPath.includes('isis')) {
            const m = fullPath.match(/interface\[interface-name=([^\]]+)\]/);
            if (m && node) {
                const iface = node.interfaces.find(i => i.name === m[1]);
                if (iface && iface.operState !== val) {
                    iface.operState = val;
                    changed = true;
                    console.log(`[push] ${nodeId} iface ${m[1]} → ${val}`);
                }
            }
            continue;
        }

        // MPLS LSP (headend only) — parse directly from subscription notification.
        // gNMI GET fails when connection slots are exhausted; subscription stream
        // always works because the connection was established at startup.
        if (fullPath.includes('mpls/lsp[')) {
            const lspNameM = fullPath.match(/lsp\[lsp-name=([^\]]+)\]/);
            const lspName  = lspNameM ? lspNameM[1] : null;

            // Case A: Nokia SR OS sent the entire LSP object as one update value.
            // This happens when subscribing to the list-entry path (not a leaf).
            if (val && typeof val === 'object' && !Array.isArray(val)
                    && ('oper-state' in val || 'active-path' in val)) {
                const newOperState  = ((val['oper-state']  || 'unknown') + '').toLowerCase();
                const newActivePath = val['active-path']  || null;
                const toArr = v => Array.isArray(v) ? v : (v && typeof v === 'object' ? [v] : []);
                const paths = [];
                for (const p of toArr(val.primary))   paths.push({
                    name: p['path-name']||'primary',   type: 'primary',
                    operState: ((p['oper-state']||'unknown')+'').toLowerCase(),
                    pathState: p['path-state']||'—', arHopListIndex: p['ar-hop-list-index']??null, nodeHops: []
                });
                for (const s of toArr(val.secondary))  paths.push({
                    name: s['path-name']||'secondary', type: 'secondary',
                    operState: ((s['oper-state']||'unknown')+'').toLowerCase(),
                    pathState: s['path-state']||'—', arHopListIndex: s['ar-hop-list-index']??null, nodeHops: []
                });

                if (!telemetryCache.lsp) {
                    telemetryCache.lsp = {
                        lspName: lspName||'SR-TE LSP', operState: newOperState,
                        activePath: newActivePath, pathType: 'unknown',
                        headend: 'ACCESS1-1', tailend: 'ACCESS1-3',
                        headendNodeId: 'mpls-a1-1', tailendNodeId: 'mpls-a1-3',
                        configuredPaths: null, operationalPaths: null, paths
                    };
                } else {
                    if (lspName) telemetryCache.lsp.lspName = lspName;
                    telemetryCache.lsp.operState  = newOperState;
                    telemetryCache.lsp.activePath = newActivePath;
                    if (paths.length) telemetryCache.lsp.paths = paths;
                }
                const hit = (telemetryCache.lsp.paths||[]).find(p => p.name === telemetryCache.lsp.activePath);
                telemetryCache.lsp.pathType = hit ? hit.type : 'unknown';
                changed = true;
                console.log(`[push] ${nodeId} LSP object → oper=${newOperState} active=${newActivePath}`);

            // Case B: Nokia SR OS sent individual leaves (scalar per update).
            } else {
                const parts    = fullPath.split('/');
                const leafName = parts[parts.length - 1];
                const inSub    = fullPath.includes('/primary[') || fullPath.includes('/secondary[');

                if (!inSub && telemetryCache.lsp) {
                    if (leafName === 'oper-state') {
                        const ns = (val + '').toLowerCase();
                        if (telemetryCache.lsp.operState !== ns) {
                            if (lspName) telemetryCache.lsp.lspName = lspName;
                            telemetryCache.lsp.operState = ns;
                            changed = true;
                            console.log(`[push] ${nodeId} LSP oper-state → ${ns}`);
                        }
                    } else if (leafName === 'active-path') {
                        const nap = val || null;
                        if (telemetryCache.lsp.activePath !== nap) {
                            telemetryCache.lsp.activePath = nap;
                            const hit = (telemetryCache.lsp.paths||[]).find(p => p.name === nap);
                            telemetryCache.lsp.pathType = hit ? hit.type : 'unknown';
                            changed = true;
                            console.log(`[push] ${nodeId} LSP active-path → ${nap}`);
                        }
                    }
                } else if (inSub && telemetryCache.lsp) {
                    const isSec = fullPath.includes('/secondary[');
                    const pType = isSec ? 'secondary' : 'primary';
                    const pNM   = fullPath.match(/(?:primary|secondary)\[path-name=([^\]]+)\]/);
                    const pName = pNM ? pNM[1] : pType;
                    let pe = (telemetryCache.lsp.paths||[]).find(p => p.name === pName);
                    if (!pe) {
                        pe = { name: pName, type: pType, operState: 'unknown', pathState: '—', arHopListIndex: null, nodeHops: [] };
                        (telemetryCache.lsp.paths = telemetryCache.lsp.paths||[]).push(pe);
                    }
                    if (leafName === 'oper-state') {
                        pe.operState = (val + '').toLowerCase(); changed = true;
                    } else if (leafName === 'path-state') {
                        pe.pathState = val || '—'; changed = true;
                    }
                } else if (!telemetryCache.lsp) {
                    // No cache yet — schedule a deferred fetch (rare: startup race)
                    scheduleLspRefresh();
                }
            }
            continue;
        }
    }

    if (changed) {
        telemetryCache.ts = new Date().toISOString();
        scheduleBroadcast();
    }
}

// ── Per-node gNMI subscribe process ──────────────────────────────────────
function startNodeSubscription(nodeId) {
    const cfg = (MPLS_CFG.nodes||{})[nodeId];
    if (!cfg) return;

    const paths = [
        '/state/port[port-id=*]/oper-state',
        '/state/router[router-name=Base]/interface[interface-name=*]/oper-state',
    ];
    if (nodeId === 'mpls-a1-1') {
        paths.push('/state/router[router-name=Base]/mpls/lsp[lsp-name=*]');
    }

    const args = [
        'exec', '-i', GNMIC_CONTAINER, GNMIC_BIN,
        '-a', `${cfg.host}:${cfg.gnmiPort||57400}`,
        '-u', GNMIC_CREDS.username, '-p', GNMIC_CREDS.password,
        '--insecure',
        'subscribe', '--mode', 'stream', '--stream-mode', 'on-change',
        '--format', 'json',
    ];
    for (const p of paths) args.push('--path', p);

    const proc   = spawn('docker', args);
    const parser = makeJsonStreamParser(notif => handleSubscribeNotification(nodeId, notif));

    proc.stdout.on('data', c => parser(c.toString()));
    proc.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (msg && !msg.includes('level=info')) // suppress gnmic info logs
            console.warn(`[push] ${nodeId} stderr: ${msg}`);
    });
    proc.on('close', code => {
        console.warn(`[push] ${nodeId} subscription closed (${code}) — retry in 5 s`);
        setTimeout(() => startNodeSubscription(nodeId), 5000);
    });
    console.log(`[push] Subscribed to ${nodeId} (${cfg.host}) ON_CHANGE`);
}

// ── Kill orphan gnmic subscribe processes from previous server runs ────────
// Each restart of ping-service.js leaves subscribe processes running inside
// the gnmic container.  Nokia SR OS TIMOS caps gRPC connections per source IP;
// accumulated orphans exhaust that cap and make GET requests fail with EOF.
async function killOrphanSubscriptions() {
    return new Promise(resolve => {
        exec(
            `docker exec ${GNMIC_CONTAINER} sh -c ` +
            `"ps aux | grep 'gnmic.*--mode stream' | grep -v grep | awk '{print \\$1}' | xargs -r kill 2>/dev/null; echo done"`,
            () => resolve()
        );
    });
}

// ── Initial cache population + subscription bootstrap ─────────────────────
async function initPushTelemetry() {
    console.log('[push] Building initial state cache…');

    // Kill orphan subscription processes from previous runs before starting GETs.
    // Gives Nokia SR OS time to reclaim connection slots (200 ms grace period).
    console.log('[push] Clearing orphan gnmic processes…');
    await killOrphanSubscriptions();
    await new Promise(r => setTimeout(r, 2000));
    console.log('[push] Orphan cleanup done — proceeding with initial fetch…');

    try {
        const nodeIds = Object.keys(MPLS_CFG.nodes||{});
        // Keep max 2 nodes fetching simultaneously.  Each node fires 8 gNMI GETs
        // in parallel, so sem(2) → up to 16 concurrent docker-exec calls — well
        // within Nokia SR OS TIMOS gRPC limits.  sem(3) caused IS-IS interface
        // queries to be dropped intermittently under 24-call burst load.
        const sem     = createSemaphore(2);
        const nodeResults = await Promise.allSettled(nodeIds.map(async nodeId => {
            const cfg     = MPLS_CFG.nodes[nodeId];
            const release = await sem();
            try {
                const [nd, routes] = await Promise.all([
                    fetchGnmicNodeData(nodeId),
                    fetchRouteStats(cfg.host, cfg.gnmiPort || 57400)
                ]);
                return { nodeId, data: {
                    name: cfg.name||nodeId, role: cfg.role||'unknown', host: cfg.host,
                    interfaces: nd.interfaces||[], ports: nd.ports||[],
                    isis: nd.isis||null, sr: nd.sr||null, routes
                }};
            } catch (e) {
                return { nodeId, data: {
                    name: cfg.name||nodeId, role: cfg.role||'unknown', host: cfg.host,
                    error: e.message, interfaces:[], ports:[], isis:null, sr:null, routes:null
                }};
            } finally { release(); }
        }));

        for (const r of nodeResults)
            if (r.status==='fulfilled') telemetryCache.nodes[r.value.nodeId] = r.value.data;

        telemetryCache.lsp   = await fetchLspData();
        telemetryCache.ts    = new Date().toISOString();
        telemetryCache.ready = true;
        console.log(`[push] Cache ready — ${Object.keys(telemetryCache.nodes).length} nodes, LSP: ${telemetryCache.lsp?.operState||'n/a'}`);
    } catch (e) {
        console.error('[push] Initial cache failed:', e.message);
    }

    // Start ON_CHANGE subscriptions for every MPLS node
    for (const nodeId of Object.keys(MPLS_CFG.nodes||{}))
        startNodeSubscription(nodeId);

    // ── Periodic full node refresh ─────────────────────────────────────────
    // ON_CHANGE subscriptions only update port/interface oper-state.
    // IS-IS adjacencies, route counts and other complex state stay stale
    // until we re-run fetchGnmicNodeData.  Refresh all nodes every 90 s
    // and broadcast, so the telemetry page stays live without user action.
    const NODE_REFRESH_MS = 90_000;

    // Guard: prevent a new refresh cycle from starting while the previous one
    // is still running.  Without this, a slow cycle (> 90 s under heavy load)
    // causes a second setInterval fire to launch a concurrent refresh.  The two
    // instances then read prevIsisIfaces from the live cache at different points
    // in time, and whichever for-loop runs last can overwrite good IS-IS data
    // with a stale empty baseline — exactly the "rotating missing nodes" bug.
    let _nodeRefreshing = false;

    async function refreshNodeCache() {
        if (_nodeRefreshing) {
            console.log('[push] Skip node refresh — previous cycle still running');
            return;
        }
        _nodeRefreshing = true;

        // Snapshot IS-IS interfaces for every cached node RIGHT NOW, before any
        // async work starts.  All per-node functions below read from this snapshot
        // so they all use the same consistent baseline regardless of how long each
        // gNMI query takes or what the live cache looks like later in the cycle.
        const prevIsisSnapshot = {};
        for (const [nid, n] of Object.entries(telemetryCache.nodes)) {
            prevIsisSnapshot[nid] = n?.isis?.interfaces || [];
        }

        try {
            const nodeIds = Object.keys(MPLS_CFG.nodes || {});
            const sem     = createSemaphore(2);   // max 2 nodes simultaneously (see initPushTelemetry)
            const results = await Promise.allSettled(nodeIds.map(async nodeId => {
                const cfg     = MPLS_CFG.nodes[nodeId];
                const release = await sem();
                try {
                    const [nd, routes] = await Promise.all([
                        fetchGnmicNodeData(nodeId),
                        fetchRouteStats(cfg.host, cfg.gnmiPort || 57400)
                    ]);

                    // fetchGnmicNodeData never throws — it uses gnmicGetSafe /
                    // .catch(()=>[]) internally, so an unreachable node returns
                    // empty arrays rather than an error.  A real SR-OS node always
                    // has at least one port; empty ports AND empty interfaces means
                    // gNMI was unreachable (network fault, container down, etc.).
                    // In that case return null so the existing cached entry is kept
                    // and the dashboard does not go blank during faults.
                    const hasData = (nd.ports      && nd.ports.length      > 0)
                                 || (nd.interfaces && nd.interfaces.length  > 0);
                    if (!hasData) {
                        console.warn(`[push] ${nodeId} returned empty data — keeping cached entry`);
                        return null;
                    }

                    // ── Merge IS-IS adjacency data ──────────────────────────
                    // Nokia SR OS occasionally returns 0 IS-IS interfaces even
                    // when the protocol is up, due to gNMI throttling under
                    // load.  Rather than overwriting the cache with an empty
                    // list, fall back to the pre-cycle snapshot.
                    // prevIsisSnapshot is read from the immutable snapshot
                    // captured at cycle start — immune to concurrent writes.
                    const prevIsisIfaces = prevIsisSnapshot[nodeId] || [];
                    const newIsisIfaces  = nd.isis?.interfaces || [];
                    const isis = nd.isis ? {
                        ...nd.isis,
                        interfaces: newIsisIfaces.length > 0 ? newIsisIfaces : prevIsisIfaces
                    } : (telemetryCache.nodes[nodeId]?.isis || null);

                    return { nodeId, data: {
                        name: cfg.name || nodeId, role: cfg.role || 'unknown', host: cfg.host,
                        interfaces: nd.interfaces || [], ports: nd.ports || [],
                        isis, sr: nd.sr || null,
                        routes: routes || telemetryCache.nodes[nodeId]?.routes || null
                    }};
                } catch (e) {
                    console.warn(`[push] ${nodeId} refresh error — keeping cached entry:`, e.message);
                    return null;   // keep existing cached entry on exception
                } finally { release(); }
            }));

            let updated = false;
            for (const r of results) {
                if (r.status === 'fulfilled' && r.value) {
                    telemetryCache.nodes[r.value.nodeId] = r.value.data;
                    updated = true;
                }
            }
            if (updated) {
                telemetryCache.ts = new Date().toISOString();
                scheduleBroadcast();
                console.log('[push] Node cache refreshed (periodic)');
            }
        } finally {
            _nodeRefreshing = false;
        }
    }

    setInterval(refreshNodeCache, NODE_REFRESH_MS);

    // ── Periodic LSP state poll ────────────────────────────────────────────
    // Nokia SR Linux does not reliably emit gNMI on_change for active-path
    // transitions (primary → secondary failover). Without this poll the SSE
    // cache stays stale until a full page refresh.  Poll every 15 s, broadcast
    // only when operState / activePath / pathType actually changed.
    const LSP_POLL_MS = 15_000;
    async function refreshLspCache() {
        const lsp = await fetchLspData();
        if (!lsp) return;
        const prev = telemetryCache.lsp;
        const pathStatesChanged = (lsp.paths || []).some((p, i) => {
            const pp = (prev?.paths || [])[i];
            return !pp || pp.operState !== p.operState || pp.pathState !== p.pathState;
        });
        const changed = !prev
            || prev.operState  !== lsp.operState
            || prev.activePath !== lsp.activePath
            || prev.pathType   !== lsp.pathType
            || pathStatesChanged;
        telemetryCache.lsp = lsp;
        if (changed) {
            telemetryCache.ts = new Date().toISOString();
            scheduleBroadcast();
            console.log('[push] LSP change detected →',
                lsp.operState, '|', lsp.activePath, '|', lsp.pathType);
        }
    }
    setInterval(refreshLspCache, LSP_POLL_MS);
}

// ── Function to ping an IP address ───────────────────────────────────────
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

// ── MPLS Access Node Health ───────────────────────────────────────────────────
// Checks container liveness (docker ps label filter) + RTU-facing port oper-state
// (gnmic). Returns { containerRunning, rtuPort, rtuPortUp, healthy }.

function dockerContainerRunning(cLabNodeName) {
    return new Promise((resolve) => {
        exec(`docker ps -q --filter "name=${cLabNodeName}"`,
            { timeout: 5000 },
            (err, stdout) => {
                resolve(!err && stdout.trim().length > 0);
            }
        );
    });
}

// Query all port oper-states for a node in one gnmic call.
// Returns { '1/1/c1/1': 'up', '1/1/c2/1': 'down', ... } or null on failure.
function gnmicAllPortStates(host, gnmiPort) {
    return new Promise((resolve) => {
        const cmd = [
            'docker', 'exec', '-i', GNMIC_CONTAINER, GNMIC_BIN,
            '-a', `${host}:${gnmiPort}`,
            '-u', GNMIC_CREDS.username,
            '-p', GNMIC_CREDS.password,
            '--insecure',
            'get',
            '--path', '/state/port[port-id=*]/oper-state',
            '--format', 'json'
        ].join(' ');

        exec(cmd, { maxBuffer: 2 * 1024 * 1024, timeout: 10000 }, (err, stdout) => {
            if (err) { resolve(null); return; }
            try {
                const parsed = JSON.parse(stdout);
                const updates = parsed.flatMap(s => s.updates || []);
                const result = {};
                for (const u of updates) {
                    // Port ID lives in the Path field, e.g. "state/port[port-id=1/1/c1/1]/oper-state"
                    const m = (u.Path || '').match(/port-id=([^\]]+)\]/);
                    if (m) result[m[1]] = String(Object.values(u.values)[0]).toLowerCase();
                }
                resolve(result);
            } catch { resolve(null); }
        });
    });
}

// Topology links — each entry maps a link ID to one or two (nodeId, portId) endpoints.
// A link with only endpoint `a` (no `b`) goes to an unmonitored device (RTU).
const MPLS_LINKS = [
    { id: 'link-dc1-dc2',   a: ['mpls-dc1',  '1/1/c2/1'], b: ['mpls-dc2',  '1/1/c2/1'] },
    { id: 'link-dc1-acc1',  a: ['mpls-dc1',  '1/1/c1/1'], b: ['mpls-acc1', '1/1/c1/1'] },
    { id: 'link-dc2-acc2',  a: ['mpls-dc2',  '1/1/c1/1'], b: ['mpls-acc2', '1/1/c1/1'] },
    { id: 'link-acc1-acc2', a: ['mpls-acc1', '1/1/c3/1'], b: ['mpls-acc2', '1/1/c3/1'] },
    { id: 'link-acc1-a1-1', a: ['mpls-acc1', '1/1/c2/1'], b: ['mpls-a1-1', '1/1/c2/1'] },
    { id: 'link-acc2-a1-3', a: ['mpls-acc2', '1/1/c2/1'], b: ['mpls-a1-3', '1/1/c2/1'] },
    { id: 'link-a1-1-a1-2', a: ['mpls-a1-1', '1/1/c1/1'], b: ['mpls-a1-2', '1/1/c1/1'] },
    { id: 'link-a1-2-a1-3', a: ['mpls-a1-2', '1/1/c2/1'], b: ['mpls-a1-3', '1/1/c1/1'] },
    { id: 'link-a1-1-rtu1', a: ['mpls-a1-1', '1/1/c3/1'], b: null },
    { id: 'link-a1-3-rtu2', a: ['mpls-a1-3', '1/1/c3/1'], b: null },
];

// Query a single port oper-state via gnmic; returns 'up', 'down', or null.
function gnmicPortState(host, gnmiPort, portId) {
    return new Promise((resolve) => {
        const cmd = [
            'docker', 'exec', '-i', GNMIC_CONTAINER, GNMIC_BIN,
            '-a', `${host}:${gnmiPort}`,
            '-u', GNMIC_CREDS.username,
            '-p', GNMIC_CREDS.password,
            '--insecure',
            'get',
            '--path', `/state/port[port-id=${portId}]/oper-state`,
            '--format', 'json'
        ].join(' ');

        exec(cmd, { maxBuffer: 1024 * 1024, timeout: 8000 }, (err, stdout) => {
            if (err) { resolve(null); return; }
            try {
                const parsed = JSON.parse(stdout);
                const updates = parsed.flatMap(s => s.updates || []);
                const state = updates.length > 0
                    ? String(Object.values(updates[0].values)[0]).toLowerCase()
                    : null;
                resolve(state);
            } catch { resolve(null); }
        });
    });
}

async function checkAccessNodeHealth(nodeId) {
    const nodeCfg = (MPLS_CFG.nodes || {})[nodeId];
    if (!nodeCfg) return { healthy: false, error: `Unknown node: ${nodeId}` };

    // Use the node's display name (e.g. "ACCESS1-1") which matches the Docker container name.
    const containerRunning = await dockerContainerRunning(nodeCfg.name);

    // Find the port that links to an RTU (look for a link whose dest contains 'RTU')
    const links = nodeCfg.links || {};
    const rtuPort = Object.entries(links).find(([, dest]) =>
        /^RTU/i.test(dest)
    )?.[0] ?? null;

    let rtuPortUp = null;
    if (containerRunning && rtuPort) {
        const state = await gnmicPortState(nodeCfg.host, nodeCfg.gnmiPort || 57400, rtuPort);
        rtuPortUp = (state === null) ? null : (state === 'up');
    }

    // rtuPortUp===null means gnmic unavailable — treat as unknown, not down
    const healthy = containerRunning && rtuPortUp !== false;
    return { nodeId, containerRunning, rtuPort, rtuPortUp, healthy, ts: new Date().toISOString() };
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
    // gnmic live node telemetry — GET /gnmic/node/:nodeId
    // Runs docker exec gnmic queries and returns live port+interface data.
    else if (parsedUrl.pathname.startsWith('/gnmic/node/') && req.method === 'GET') {
        const nodeId = parsedUrl.pathname.replace('/gnmic/node/', '');
        res.setHeader('Content-Type', 'application/json');
        fetchGnmicNodeData(nodeId)
            .then(data  => { res.writeHead(200); res.end(JSON.stringify(data)); })
            .catch(err  => { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); });
    }

    // ── TPT / IEC 61850 GOOSE proxy ─────────────────────────────────────────
    // All routes forward to tpt-daemon HTTP API running on RTU containers.
    else if (parsedUrl.pathname === '/api/tpt/status' && req.method === 'GET') {
        // GET /status from every RTU daemon
        const result = await tptAll('GET', '/status');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    }
    else if (parsedUrl.pathname === '/api/tpt/log' && req.method === 'GET') {
        // GET /log from every RTU daemon
        const result = await tptAll('GET', '/log');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    }
    else if (parsedUrl.pathname === '/api/tpt/start' && req.method === 'POST') {
        const result = await tptAll('POST', '/start');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    }
    else if (parsedUrl.pathname === '/api/tpt/stop' && req.method === 'POST') {
        const result = await tptAll('POST', '/stop');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    }
    else if (parsedUrl.pathname === '/api/tpt/trip' && req.method === 'POST') {
        // Trip only RTU1 (origin of trip command); RTU2 receives via GOOSE
        const rtu1 = MPLS_RTUS.rtu1;
        if (!rtu1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'rtu1 not configured' }));
            return;
        }
        const result = await tptFetch(rtu1.host, rtu1.tptPort || 8850, 'POST', '/trip');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ RTU1: result }));
    }
    else if (parsedUrl.pathname === '/api/tpt/clear' && req.method === 'POST') {
        const result = await tptAll('POST', '/clear');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    }
    // ── TPT Install ─────────────────────────────────────────────────────────
    // POST /api/tpt/install
    // Runs install-tpt.sh: copies tpt-daemon.py into RTU containers and starts daemons.
    // Returns { exitCode, output } when the script completes (~3 s typical).
    else if (parsedUrl.pathname === '/api/tpt/install' && req.method === 'POST') {
        const scriptPath = path.join(__dirname, 'scripts', 'install-tpt.sh');
        let output = '';
        const child = spawn('bash', [scriptPath], {
            env: { ...process.env },
            // strip ANSI colour codes so the JSON output is readable in the UI
        });
        child.stdout.on('data', d => { output += d.toString(); });
        child.stderr.on('data', d => { output += d.toString(); });
        child.on('close', code => {
            // Strip ANSI escape sequences for clean display
            const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ exitCode: code, output: clean }));
        });
        child.on('error', err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ exitCode: -1, output: '', error: err.message }));
        });
        return; // response sent by child event handlers
    }
    // ── IEC 60870-5-104 SCADA status ────────────────────────────────────────────
    // GET /api/scada/status
    // Reads the tail of /tmp/scada.log from the SCADA container and parses it into
    // structured state: session up/down, active interface, last M_ME_TF_1 measurement.
    else if (parsedUrl.pathname === '/api/scada/status' && req.method === 'GET') {
        const result = await new Promise(resolve => {
            // Read startup context (head -20) AND recent activity (tail -30) in one exec.
            // This ensures we always see the initial "connecting via ethX" / "STARTDT_CON"
            // lines even after the session has been running for hours and the tail window
            // only contains measurement frames.
            const proc = spawn('docker', [
                'exec', 'SCADA', 'sh', '-c',
                'head -20 /tmp/scada.log && echo "---SPLIT---" && tail -30 /tmp/scada.log',
            ]);
            let out = '', err = '';
            proc.stdout.on('data', d => { out += d; });
            proc.stderr.on('data', d => { err += d; });
            proc.on('error', e => resolve({ ok: false, running: false, error: e.message }));
            proc.on('close', code => {
                if (code !== 0 && !out) {
                    resolve({ ok: false, running: false,
                              error: err.trim() || `docker exit ${code}` });
                    return;
                }
                // Split into head (startup context) + tail (recent activity) sections.
                const splitIdx = out.indexOf('---SPLIT---');
                const headPart = splitIdx >= 0 ? out.slice(0, splitIdx) : '';
                const tailPart = splitIdx >= 0 ? out.slice(splitIdx + 11) : out;
                const headLines = headPart.split('\n').filter(l => l.trim());
                const tailLines = tailPart.split('\n').filter(l => l.trim());
                // allLines: head first (for context), then tail (for recency).
                // Duplicates are fine — later entries overwrite state variables.
                const allLines = [...headLines, ...tailLines];

                let activeIface = null, sessionUp = false, failedOver = false;
                let lastVal = null, lastTs = null, lastIoa = null, lastSendSeq = null;
                for (const line of allLines) {
                    // "connecting via ethX ->" → new attempt on that iface
                    let m = line.match(/connecting via (\w+)/);
                    if (m) { activeIface = m[1]; sessionUp = false; }
                    // "TCP up on ethX;" → TCP connected (before STARTDT_CON)
                    m = line.match(/TCP up on (\w+);/);
                    if (m) activeIface = m[1];
                    // Session established
                    if (line.includes('STARTDT_CON received')) sessionUp = true;
                    // Session lost
                    if ((line.includes('session on') && line.includes('failed')) ||
                        line.includes('session lost') ||
                        line.includes('session ended')) sessionUp = false;
                    // Failover triggered (primary → backup)
                    if (line.includes('failing over') || line.includes('failed over to backup'))
                        failedOver = true;
                    // Measurement: "<- RTU I send=N ioa=4001 val=132.043 q=0x00"
                    m = line.match(/ioa=(\d+)\s+val=([\d.]+)/);
                    if (m) {
                        lastIoa = parseInt(m[1], 10);
                        lastVal = parseFloat(m[2]);
                        const tsM = line.match(/^\[(\d+:\d+:\d+)\]/);
                        if (tsM) lastTs = tsM[1];
                        const seqM = line.match(/send=(\d+)/);
                        if (seqM) lastSendSeq = parseInt(seqM[1], 10);
                    }
                }

                // Inference: active measurements prove the session is alive even when
                // STARTDT_CON scrolled past the log window captured above.
                if (!sessionUp && lastVal !== null) sessionUp = true;

                // If no interface was found in either window, default to primary (eth2).
                // This can happen if both windows are filled with measurement frames only.
                if (!activeIface) activeIface = failedOver ? 'eth1' : 'eth2';

                resolve({
                    ok: true,
                    running: allLines.length > 0,
                    activeIface,
                    sessionUp,
                    failedOver,
                    lastVal,
                    lastTs,
                    lastIoa,
                    lastSendSeq,
                    lastLines: tailLines.slice(-12),   // show recent tail lines in the log UI
                });
            });
            setTimeout(() => {
                try { proc.kill(); } catch {}
                resolve({ ok: false, running: false, error: 'timeout' });
            }, 5000);
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    }
    // ── MPLS Access Node Health ──────────────────────────────────────────────
    // GET /api/mpls/access-health
    // Returns container liveness + RTU-facing port oper-state for ACCESS1-1 and ACCESS1-3.
    else if (parsedUrl.pathname === '/api/mpls/access-health' && req.method === 'GET') {
        const [access1, access3] = await Promise.all([
            checkAccessNodeHealth('mpls-a1-1'),
            checkAccessNodeHealth('mpls-a1-3'),
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access1, access3, ts: new Date().toISOString() }));
    }
    // ── MPLS Link Health ─────────────────────────────────────────────────────
    // GET /api/mpls/link-health
    // Queries all SR-OS nodes in parallel, returns per-link up/down/unknown status.
    else if (parsedUrl.pathname === '/api/mpls/link-health' && req.method === 'GET') {
        try {
            const nodeIds = Object.keys(MPLS_CFG.nodes || {});
            const portStateMap = {};
            await Promise.all(nodeIds.map(async (nodeId) => {
                const nodeCfg = MPLS_CFG.nodes[nodeId];
                portStateMap[nodeId] = await gnmicAllPortStates(nodeCfg.host, nodeCfg.gnmiPort || 57400);
            }));

            const links = {};
            for (const link of MPLS_LINKS) {
                const [aNode, aPort] = link.a;
                const aState = portStateMap[aNode]?.[aPort] ?? null;
                let bState = null;
                if (link.b) {
                    const [bNode, bPort] = link.b;
                    bState = portStateMap[bNode]?.[bPort] ?? null;
                }
                // Down if either endpoint explicitly reports down; up if either reports up; else unknown.
                let status;
                if (aState === 'down' || bState === 'down') status = 'down';
                else if (aState === 'up'   || bState === 'up')   status = 'up';
                else status = 'unknown';
                links[link.id] = { status, a: { node: aNode, port: aPort, state: aState },
                                            b: link.b ? { node: link.b[0], port: link.b[1], state: bState } : null };
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ts: new Date().toISOString(), links }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
    }
    // ── SR-TE LSP State ──────────────────────────────────────────────────────────
    // GET /api/mpls/srte-lsp
    // Queries ACCESS1-1 for all MPLS LSPs and returns the first SR-TE entry whose
    // name contains "a1-3" or "access1-3" (case-insensitive), or any active LSP
    // if none matches. Falls back gracefully when gNMI is unreachable.
    else if (parsedUrl.pathname === '/api/mpls/srte-lsp' && req.method === 'GET') {
        try {
            const headendCfg = (MPLS_CFG.nodes || {})['mpls-a1-1'];
            if (!headendCfg) throw new Error('mpls-a1-1 not found in config');
            const host     = headendCfg.host;
            const gnmiPort = headendCfg.gnmiPort || 57400;

            // SR-TE and RSVP-TE LSPs share the same YANG list: mpls/lsp[lsp-name=*]
            // (show router mpls lsp / show router mpls sr-te-lsp both read this list)
            const lspUpdates = await gnmicGet(
                host, gnmiPort,
                '/state/router[router-name=Base]/mpls/lsp[lsp-name=*]'
            ).catch(() => []);

            let lspName    = null;
            let operState  = 'unknown';
            let activePath = null;

            let pathType         = 'unknown';
            let configuredPaths  = null;
            let operationalPaths = null;
            let paths            = [];   // [{name, type, operState, pathState}]

            if (lspUpdates.length > 0) {
                // Find the LSP whose name references the tailend (to-ACCESS1-3 / a1-3)
                const match = lspUpdates.find(upd => {
                    const nm = (upd.Path || '').toLowerCase();
                    return nm.includes('access1-3') || nm.includes('a1-3') || nm.includes('access13');
                }) || lspUpdates[0];  // fall back to first LSP found

                const nameM = match.Path.match(/lsp\[lsp-name=([^\]]+)\]/i);
                lspName = nameM ? nameM[1] : 'SR-TE LSP';

                const obj = Object.values(match.values)[0] || {};
                operState = (obj['oper-state'] || 'unknown').toLowerCase();
                if (!['up', 'down'].includes(operState)) operState = 'unknown';
                activePath       = obj['active-path']       || null;
                configuredPaths  = obj['configured-paths']  ?? null;
                operationalPaths = obj['operational-paths'] ?? null;

                // primary and secondary are inline arrays in the LSP state object —
                // no second gNMI query needed.
                const primaryArr   = Array.isArray(obj.primary)   ? obj.primary   : [];
                const secondaryArr = Array.isArray(obj.secondary) ? obj.secondary : [];

                primaryArr.forEach(p => paths.push({
                    name:       p['path-name']  || 'primary',
                    type:       'primary',
                    operState:  (p['oper-state']  || 'unknown').toLowerCase(),
                    pathState:  p['path-state']  || '—',
                }));
                secondaryArr.forEach(s => paths.push({
                    name:       s['path-name']  || 'secondary',
                    type:       'secondary',
                    operState:  (s['oper-state']  || 'unknown').toLowerCase(),
                    pathState:  s['path-state']  || '—',
                }));

                // Determine active path type from the parsed path list
                if (activePath) {
                    const hit = paths.find(p => p.name === activePath);
                    pathType = hit ? hit.type : 'unknown';
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ts:               new Date().toISOString(),
                headend:          'ACCESS1-1',
                tailend:          'ACCESS1-3',
                lspName:          lspName || 'SR-TE LSP',
                operState,
                activePath,
                pathType,
                configuredPaths,
                operationalPaths,
                paths             // [{name, type, operState, pathState}]
            }));
        } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            // Return a well-formed response even on error (overlay still renders statically)
            res.end(JSON.stringify({
                ts:        new Date().toISOString(),
                headend:   'ACCESS1-1',
                tailend:   'ACCESS1-3',
                path:      ['a1-1', 'acc1', 'acc2', 'a1-3'],
                lspName:   'SR-TE LSP',
                operState: 'unknown',
                error:     err.message
            }));
        }
    }
    // ── Telemetry All-Nodes ──────────────────────────────────────────────────
    // GET /api/telemetry/all
    // Returns the in-memory telemetryCache built and refreshed by
    // initPushTelemetry() (updated every 60 s with IS-IS merge strategy).
    // Serving from cache avoids the 7×8 parallel gNMI burst that was causing
    // Nokia SR OS TIMOS to drop IS-IS interface/adjacency queries intermittently.
    // If the cache is not yet ready (server just started) we wait up to 10 s.
    else if (parsedUrl.pathname === '/api/telemetry/all' && req.method === 'GET') {
        try {
            // Wait for cache if server just started (max 10 s).
            if (!telemetryCache.ready) {
                await new Promise((resolve, reject) => {
                    const deadline = Date.now() + 10_000;
                    const poll = setInterval(() => {
                        if (telemetryCache.ready) { clearInterval(poll); resolve(); }
                        else if (Date.now() > deadline) { clearInterval(poll); resolve(); /* serve partial */ }
                    }, 300);
                });
            }

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify({
                ts:    telemetryCache.ts || new Date().toISOString(),
                nodes: telemetryCache.nodes,
                lsp:   telemetryCache.lsp,
            }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
    }
    // ── LEGACY /api/telemetry/all – fresh-fetch variant (kept for debug) ──────
    // GET /api/telemetry/fresh — bypasses cache, re-fetches all nodes live.
    // Use only for debugging; will cause IS-IS gaps under concurrent load.
    else if (parsedUrl.pathname === '/api/telemetry/fresh' && req.method === 'GET') {
        try {
            const nodeIds = Object.keys(MPLS_CFG.nodes || {});

            // Helper: route-table summary for one node (graceful on failure).
            // SR-OS returns the entire route-table as a single object at the
            // /route-table path; routes are under .unicast.ipv4.route[] with
            // field "ipv4-prefix" and "protocol". Leaf-path predicates like
            // route[dest-prefix=*] are not supported on this platform.
            async function fetchRouteTable(host, gnmiPort) {
                try {
                    const updates = await gnmicGet(
                        host, gnmiPort,
                        '/state/router[router-name=Base]/route-table'
                    );
                    if (!updates.length) return null;

                    // updates[0].values has one key like "state/router/route-table"
                    const rtObj = Object.values(updates[0].values || {})[0] || {};
                    const routes = (rtObj.unicast || {}).ipv4?.route || [];

                    const byProtocol = {};
                    for (const r of routes) {
                        // protocol values observed: 'local', 'isis', 'bgp', 'static', 'ospf'
                        const proto = (r.protocol || 'unknown').toLowerCase();
                        byProtocol[proto] = (byProtocol[proto] || 0) + 1;
                    }
                    const total = routes.length;
                    return { total, byProtocol };
                } catch {
                    return null; // caller renders '—'
                }
            }

            // Semaphore: max 2 nodes fetched concurrently (2×8 = 16 peak docker-exec
            // calls).  3 was causing Nokia SR OS TIMOS to drop IS-IS interface queries
            // intermittently due to gRPC connection-slot exhaustion under 24-call burst.
            const nodeSem = createSemaphore(2);

            const nodePromises = nodeIds.map(async nodeId => {
                const cfg = MPLS_CFG.nodes[nodeId];
                const release = await nodeSem();
                try {
                    const nodeData = await fetchGnmicNodeData(nodeId);
                    const routes   = await fetchRouteTable(cfg.host, cfg.gnmiPort || 57400);
                    return {
                        nodeId,
                        data: {
                            name:       cfg.name       || nodeId,
                            role:       cfg.role       || 'unknown',
                            host:       cfg.host,
                            interfaces: nodeData.interfaces || [],
                            ports:      nodeData.ports      || [],
                            isis:       nodeData.isis       || null,
                            sr:         nodeData.sr         || null,
                            routes
                        }
                    };
                } catch (err) {
                    return {
                        nodeId,
                        data: {
                            name:  cfg.name || nodeId,
                            role:  cfg.role || 'unknown',
                            host:  cfg.host,
                            error: err.message,
                            interfaces: [], ports: [], isis: null, sr: null, routes: null
                        }
                    };
                } finally {
                    release();
                }
            });

            const headendCfgLsp = (MPLS_CFG.nodes || {})['mpls-a1-1'];

            // Run node fetches + LSP fetch + hop-list fetch all concurrently
            const [nodeResults, lspRaw, hopUpdates] = await Promise.all([
                Promise.allSettled(nodePromises),

                // ── LSP state (same as before, but now also captures arHopListIndex)
                (async () => {
                    try {
                        if (!headendCfgLsp) return null;
                        const lspUpdates = await gnmicGet(
                            headendCfgLsp.host, headendCfgLsp.gnmiPort || 57400,
                            '/state/router[router-name=Base]/mpls/lsp[lsp-name=*]'
                        ).catch(() => []);
                        if (!lspUpdates.length) return { operState: 'unknown', lspName: 'SR-TE LSP', paths: [] };
                        const match = lspUpdates.find(u => {
                            const nm = (u.Path || '').toLowerCase();
                            return nm.includes('a1-3') || nm.includes('access1-3');
                        }) || lspUpdates[0];
                        const nameM = match.Path.match(/lsp\[lsp-name=([^\]]+)\]/i);
                        const lspName = nameM ? nameM[1] : 'SR-TE LSP';
                        const obj = Object.values(match.values || {})[0] || {};
                        const operState = ['up','down'].includes((obj['oper-state']||'').toLowerCase())
                            ? obj['oper-state'].toLowerCase() : 'unknown';
                        const activePath = obj['active-path'] || null;
                        const paths = [];
                        // Extract ar-hop-list-index so we can later join with the hop-list data
                        (Array.isArray(obj.primary)   ? obj.primary   : []).forEach(p => paths.push({
                            name: p['path-name']||'primary', type:'primary',
                            operState:(p['oper-state']||'unknown').toLowerCase(),
                            pathState: p['path-state']||'—',
                            arHopListIndex: p['ar-hop-list-index'] ?? null
                        }));
                        (Array.isArray(obj.secondary) ? obj.secondary : []).forEach(s => paths.push({
                            name: s['path-name']||'secondary', type:'secondary',
                            operState:(s['oper-state']||'unknown').toLowerCase(),
                            pathState: s['path-state']||'—',
                            arHopListIndex: s['ar-hop-list-index'] ?? null
                        }));
                        const hit = paths.find(p => p.name === activePath);
                        return { lspName, operState, activePath,
                                 pathType: hit ? hit.type : 'unknown',
                                 headend: 'ACCESS1-1', tailend: 'ACCESS1-3',
                                 headendNodeId: 'mpls-a1-1', tailendNodeId: 'mpls-a1-3',
                                 paths };
                    } catch { return null; }
                })(),

                // ── Actual-route hop-list from headend — gives us the real forwarding path
                headendCfgLsp ? gnmicGet(
                    headendCfgLsp.host, headendCfgLsp.gnmiPort || 57400,
                    '/state/router[router-name=Base]/mpls/actual-route-hop-list[hop-list-index=*]'
                ).catch(() => []) : Promise.resolve([])
            ]);

            // Assemble nodes map
            const nodes = {};
            for (const result of nodeResults) {
                if (result.status === 'fulfilled') {
                    const { nodeId, data } = result.value;
                    nodes[nodeId] = data;
                }
            }

            // ── Build router-id → nodeId map from each node's system interface IP
            const routerIdToNode = {};
            for (const [nodeId, data] of Object.entries(nodes)) {
                const sysIf = (data.interfaces || []).find(i => i.name === 'system');
                if (sysIf && sysIf.ipv4) routerIdToNode[sysIf.ipv4] = nodeId;
            }

            // ── Parse hop-lists: group updates by hop-list-index, sort by hop-index
            const hopLists = {};
            for (const upd of hopUpdates) {
                const m = (upd.Path || '').match(/hop-list-index=(\d+)/);
                if (!m) continue;
                const idx = +m[1];
                const obj = Object.values(upd.values || {})[0] || {};
                (hopLists[idx] = hopLists[idx] || []).push({
                    hopIndex: +(obj['hop-index'] || 0),
                    routerId: obj['router-id'] || null
                });
            }
            for (const k of Object.keys(hopLists))
                hopLists[k].sort((a, b) => a.hopIndex - b.hopIndex);

            // ── Enrich each LSP path with an ordered list of node-ids (for topology overlay)
            const lspResult = lspRaw;
            if (lspResult && lspResult.paths) {
                lspResult.paths = lspResult.paths.map(p => {
                    const hlIdx = p.arHopListIndex;
                    const hops = (hlIdx != null && hopLists[hlIdx])
                        ? hopLists[hlIdx].map(h => routerIdToNode[h.routerId]).filter(Boolean)
                        : [];
                    // Full node-id sequence: headend + intermediate hops (tailend is last hop)
                    const nodeHops = ['mpls-a1-1', ...hops];
                    return { ...p, nodeHops };
                });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ts: new Date().toISOString(), nodes, lsp: lspResult }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
    }
    // ── SSE push stream ───────────────────────────────────────────────────
    // GET /api/events
    // Long-lived text/event-stream connection. Sends a 'telemetry' event
    // immediately with the current cache, then on every gNMI ON_CHANGE.
    else if (parsedUrl.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type':                'text/event-stream',
            'Cache-Control':               'no-cache',
            'Connection':                  'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'X-Accel-Buffering':           'no',  // disable nginx proxy buffering
        });
        res.flushHeaders();

        if (telemetryCache.ready) {
            // Deliver current state immediately so the page doesn't wait
            res.write(`event: telemetry\ndata: ${JSON.stringify({
                ts: telemetryCache.ts, nodes: telemetryCache.nodes, lsp: telemetryCache.lsp
            })}\n\n`);
        } else {
            res.write('event: wait\ndata: {}\n\n');
        }

        // Heartbeat every 25 s — keeps the connection alive through proxies
        const hb = setInterval(() => {
            try { res.write(': heartbeat\n\n'); }
            catch { clearInterval(hb); sseClients.delete(res); }
        }, 25_000);

        sseClients.add(res);
        req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
    }

    // Not found
    else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
});

// Kill orphan subscription processes when this process exits so the next
// start begins with a clean slate (no accumulated connection-slot leak).
function cleanupOnExit() {
    exec(
        `docker exec ${GNMIC_CONTAINER} sh -c ` +
        `"ps aux | grep 'gnmic.*--mode stream' | grep -v grep | awk '{print \\$1}' | xargs -r kill 2>/dev/null" 2>/dev/null`
    );
}
process.on('exit',    cleanupOnExit);
process.on('SIGTERM', () => { cleanupOnExit(); process.exit(0); });
process.on('SIGINT',  () => { cleanupOnExit(); process.exit(0); });

// Start server, then bootstrap push telemetry in the background
server.listen(PORT, () => {
    console.log(`Ping service running on http://localhost:${PORT}`);
    console.log(`Monitoring IPs: ${ALLOWED_IPS.join(', ')}`);
    const exampleIp = ALLOWED_IPS[0];
    console.log(`  curl http://localhost:${PORT}/ping?ip=${exampleIp}`);
    // Kick off gNMI ON_CHANGE subscriptions after server is accepting connections
    initPushTelemetry();
});
