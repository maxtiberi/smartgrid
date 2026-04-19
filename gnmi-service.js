// gNMI Service for Smart Grid Router Monitoring
// Connects to SR Linux routers via gRPC and exposes telemetry via REST API

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// Load centralized config (single source of truth for topology and credentials).
const CONFIG_PATH = path.join(__dirname, 'config.json');
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const PORT = CONFIG.services.gnmiService.port;
const GNMI_PORT = CONFIG.gnmi.port;
const GNMI_SAMPLE_INTERVAL_NS = CONFIG.gnmi.sampleIntervalNs;
const GNMI_CREDENTIALS = CONFIG.gnmi.credentials;

// Expand routers / RTUs with the shared gNMI port so existing code keeps working.
const ROUTERS = Object.fromEntries(
    Object.entries(CONFIG.routers).map(([id, r]) => [id, { ...r, port: GNMI_PORT }])
);
const RTUS = { ...CONFIG.rtus };

// RTU status cache
const rtuCache = {};

// In-memory cache for router telemetry
const routerCache = {};

// Per-router trace of recent oper-state gNMI path+value pairs (bounded, debug only).
const operStateTrace = {}; // { routerId: [{path, value, ts}] }
const TRACE_MAX = 120;

// Retry counters
const retryCount = {};

// Fault-injection overrides: { routers: {id: 'down'}, rtus: {id: 'offline'}, links: {id: 'down'} }
// Set via POST /api/fault; cleared via POST /api/fault with { clear: true }.
const faultOverrides = { routers: {}, rtus: {}, links: {} };

// Teleprotection finite-state machine.
// States: ARMED (all healthy), PICKUP (degraded but not tripped), TRIP (breaker open).
const teleprotection = {
    state: 'ARMED',
    reason: 'all-clear',
    isolatedLeaves: [],
    lastTransition: new Date().toISOString()
};

// Append-only event log (bounded) for UI timeline.
const eventLog = [];
const EVENT_LOG_MAX = 500;
function logEvent(kind, payload) {
    const entry = { ts: new Date().toISOString(), kind, ...payload };
    eventLog.push(entry);
    if (eventLog.length > EVENT_LOG_MAX) eventLog.shift();
    broadcast('event', entry);
}

// Server-Sent Events infrastructure — lets the browser drop 10s polling.
const sseClients = new Set();
function broadcast(type, data) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try { client.write(payload); } catch (_) { sseClients.delete(client); }
    }
}

// Load gNMI proto
const PROTO_PATH = __dirname + '/proto/gnmi/gnmi.proto';

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [__dirname + '/proto']
});

const gnmiProto = grpc.loadPackageDefinition(packageDefinition).gnmi;

// Create gNMI client for a router
function createGnmiClient(routerId) {
    const config = ROUTERS[routerId];

    // Use fully insecure connection (no TLS) for SR Linux v24 port 57401
    // This is the standard insecure gNMI port without encryption
    const credentials = grpc.credentials.createInsecure();

    // Create client
    const client = new gnmiProto.gNMI(
        `${config.host}:${config.port}`,
        credentials
    );

    // Create metadata for authentication
    const metadata = new grpc.Metadata();
    metadata.add('username', GNMI_CREDENTIALS.username);
    metadata.add('password', GNMI_CREDENTIALS.password);

    return { client, metadata };
}

// Build gNMI path from string
function buildPath(pathStr) {
    const elements = pathStr.split('/').filter(e => e.length > 0);
    return {
        elem: elements.map(e => {
            // Handle path with keys like "interface[name=ethernet-1/1]"
            const match = e.match(/^([^\[]+)(?:\[([^\]]+)\])?$/);
            if (match) {
                const elem = { name: match[1] };
                if (match[2]) {
                    elem.key = {};
                    const keys = match[2].split(',');
                    keys.forEach(k => {
                        const [key, val] = k.split('=');
                        elem.key[key] = val;
                    });
                }
                return elem;
            }
            return { name: e };
        })
    };
}

// Subscribe to router telemetry
function subscribeToRouter(routerId) {
    console.log(`[${routerId}] Initiating gNMI subscription...`);

    const { client, metadata } = createGnmiClient(routerId);

    // Build subscription request
    const subscribeRequest = {
        subscribe: {
            mode: 0, // STREAM
            encoding: 4, // JSON_IETF
            subscription: [
                // Interface statistics
                {
                    path: buildPath('interface'),
                    mode: 2, // SAMPLE
                    sample_interval: GNMI_SAMPLE_INTERVAL_NS
                },
                // Interface oper-state changes (ON_CHANGE ensures we get state for ALL interfaces)
                {
                    path: buildPath('interface/oper-state'),
                    mode: 1 // ON_CHANGE
                },
                // Interface IP addresses
                {
                    path: buildPath('interface/subinterface/ipv4/address'),
                    mode: 2, // SAMPLE
                    sample_interval: GNMI_SAMPLE_INTERVAL_NS
                },
                // System0 interface specifically for router IP
                {
                    path: buildPath('interface[name=system0]/subinterface[index=0]/ipv4/address'),
                    mode: 2, // SAMPLE
                    sample_interval: GNMI_SAMPLE_INTERVAL_NS
                },
                // Mgmt0 interface for router management IP (alternative to system0)
                {
                    path: buildPath('interface[name=mgmt0]/subinterface[index=0]/ipv4/address'),
                    mode: 2, // SAMPLE
                    sample_interval: GNMI_SAMPLE_INTERVAL_NS
                },
                // Network instance interfaces (to get IPs from network-instance)
                {
                    path: buildPath('network-instance[name=default]/interface'),
                    mode: 2, // SAMPLE
                    sample_interval: GNMI_SAMPLE_INTERVAL_NS
                },
                // System performance
                {
                    path: buildPath('platform/control'),
                    mode: 2, // SAMPLE
                    sample_interval: GNMI_SAMPLE_INTERVAL_NS
                },
                // Network instance default - BGP statistics
                {
                    path: buildPath('network-instance[name=default]/protocols/bgp/statistics'),
                    mode: 2, // SAMPLE
                    sample_interval: GNMI_SAMPLE_INTERVAL_NS
                },
                // Network instance default - BGP neighbors
                {
                    path: buildPath('network-instance[name=default]/protocols/bgp/neighbor'),
                    mode: 2, // SAMPLE
                    sample_interval: GNMI_SAMPLE_INTERVAL_NS
                }
            ]
        }
    };

    // Create streaming call
    const call = client.Subscribe(metadata);

    // Send subscription request
    call.write(subscribeRequest);

    // Handle responses
    call.on('data', (response) => {
        try {
            console.log(`[${routerId}] ✓ Received gNMI data`);
            processGnmiUpdate(routerId, response);
        } catch (error) {
            console.error(`[${routerId}] Error processing update:`, error.message);
        }
    });

    call.on('error', (error) => {
        console.error(`[${routerId}] gNMI error:`, error.message);

        if (!routerCache[routerId]) {
            routerCache[routerId] = {};
        }
        routerCache[routerId].status = 'disconnected';
        routerCache[routerId].error = error.message;

        // Exponential backoff retry
        const retries = retryCount[routerId] || 0;
        const delay = Math.min(5000 * Math.pow(2, retries), 60000);
        retryCount[routerId] = retries + 1;

        console.log(`[${routerId}] Retrying in ${delay/1000}s (attempt ${retries + 1})...`);
        setTimeout(() => subscribeToRouter(routerId), delay);
    });

    call.on('end', () => {
        console.log(`[${routerId}] gNMI stream ended, reconnecting...`);
        setTimeout(() => subscribeToRouter(routerId), 5000);
    });
}

// Format gNMI path to string
function formatPath(path) {
    if (!path || !path.elem) return '';
    return '/' + path.elem.map(e => {
        let str = e.name;
        if (e.key) {
            const keys = Object.entries(e.key).map(([k, v]) => `${k}=${v}`).join(',');
            str += `[${keys}]`;
        }
        return str;
    }).join('/');
}

// Parse gNMI value
function parseValue(val) {
    if (!val) return null;

    if (val.json_ietf_val) {
        try {
            return JSON.parse(val.json_ietf_val);
        } catch (e) {
            return val.json_ietf_val;
        }
    }
    if (val.json_val) {
        try {
            return JSON.parse(val.json_val);
        } catch (e) {
            return val.json_val;
        }
    }
    if (val.string_val !== undefined) return val.string_val;
    if (val.int_val !== undefined) return parseInt(val.int_val);
    if (val.uint_val !== undefined) return parseInt(val.uint_val);
    if (val.bool_val !== undefined) return val.bool_val;
    if (val.float_val !== undefined) return parseFloat(val.float_val);
    if (val.decimal_val !== undefined) return parseFloat(val.decimal_val.digits) / Math.pow(10, val.decimal_val.precision);

    return null;
}

// Process gNMI update
function processGnmiUpdate(routerId, response) {
    // Initialize cache if needed
    if (!routerCache[routerId]) {
        routerCache[routerId] = {
            _routerId: routerId,
            status: 'connected',
            lastUpdate: null,
            interfaces: {},
            system: { cpu: {}, memory: {}, system0IP: null },
            bgp: { totalPeers: 0, activePeers: 0, neighbors: [], routes: [] }
        };
        console.log(`[${routerId}] Cache initialized`);
    }

    const cache = routerCache[routerId];
    const prevStatus = cache.status;
    cache.lastUpdate = new Date().toISOString();
    cache.status = 'connected';
    retryCount[routerId] = 0; // Reset retry counter on success
    if (prevStatus && prevStatus !== 'connected') {
        logEvent('router-status', { id: routerId, from: prevStatus, to: 'connected' });
    }

    // Process update
    if (response.update && response.update.update) {
        console.log(`[${routerId}] Processing ${response.update.update.length} updates`);
        response.update.update.forEach(update => {
            const pathStr = formatPath(update.path);
            const value = parseValue(update.val);

            // Log detailed structure for debugging
            if (!cache._logCount) cache._logCount = 0;

            // Always log platform, control, bgp, subinterface, network-instance interface and statistics paths for debugging
            const shouldLog = cache._logCount < 10 ||
                            pathStr.includes('platform') ||
                            pathStr.includes('control') ||
                            pathStr.includes('statistics') ||
                            pathStr.includes('subinterface') ||
                            (pathStr.includes('network-instance') && pathStr.includes('interface') && !pathStr.includes('bgp')) ||
                            (pathStr.includes('bgp') && pathStr.includes('neighbor'));

            if (shouldLog && cache._logCount < 20) {
                console.log(`[${routerId}] Path: ${pathStr}`);
                if (typeof value === 'object') {
                    console.log(`[${routerId}] Value (JSON):`, JSON.stringify(value, null, 2).substring(0, 800));
                } else {
                    console.log(`[${routerId}] Value: ${value}`);
                }
                if (cache._logCount < 10) cache._logCount++;
            }

            // Route to appropriate cache section
            // Match paths with or without SR Linux namespaces
            if (pathStr.includes('network-instance') && pathStr.includes('interface') && !pathStr.includes('bgp')) {
                // Network instance interfaces (contains IP info)
                updateInterfaceFromNetworkInstance(cache, pathStr, value);
            } else if (pathStr.includes('interface')) {
                updateInterfaceCache(cache, pathStr, value);
            } else if (pathStr.includes('platform') || pathStr.includes('control') || pathStr.includes('/cpu') || pathStr.includes('/memory')) {
                updateSystemCache(cache, pathStr, value);
            } else if (pathStr.includes('network-instance') || pathStr.includes('bgp')) {
                updateBgpCache(cache, pathStr, value);
            }
        });

        // Log cache stats
        const ifaceCount = Object.keys(cache.interfaces).length;
        console.log(`[${routerId}] Cache: ${ifaceCount} interfaces, CPU: ${cache.system.cpu?.total || 0}%, BGP peers: ${cache.bgp.totalPeers}`);
    } else {
        console.log(`[${routerId}] No update data in response`);
    }
}

// Update interface cache
function updateInterfaceCache(cache, pathStr, value) {
    // Extract interface name from path
    const match = pathStr.match(/interface\[name=([^\]]+)\]/);
    if (!match) return;

    const ifName = match[1];

    // Initialize interface if doesn't exist
    if (!cache.interfaces[ifName]) {
        cache.interfaces[ifName] = {
            name: ifName,
            operState: 'unknown',
            ipAddresses: [], // Array of IP addresses
            inOctets: 0,
            outOctets: 0,
            inRate: 0,
            outRate: 0,
            lastInOctets: 0,
            lastOutOctets: 0,
            lastUpdate: Date.now()
        };
    }

    const iface = cache.interfaces[ifName];
    const now = Date.now();

    // isTopLevel = true only when the path ends at the interface element itself
    // (e.g. /interface[name=X] or /interface[name=X]/oper-state).
    //
    // SR Linux virtual lab sends SEPARATE oper-state updates for every sub-container:
    //   /interface[name=ethernet-1/2]/oper-state          → "up"   ← correct interface state
    //   /interface[name=ethernet-1/2]/ethernet/oper-state → "down" ← physical-layer (no HW transceiver)
    //   /interface[name=ethernet-1/2]/transceiver/oper-state → "down" ← optical transceiver
    //
    // The old check (!includes('/ethernet[')) only matched list elements (ethernet[key=...]),
    // NOT the ethernet container (/ethernet/…), so it let the physical-layer "down" overwrite
    // the real interface state — causing e.g. DC2 ethernet-1/2 to show as "down" when it is "up".
    //
    // Fix: compute what comes AFTER the interface[name=X] element in the path.
    // Only accept oper-state updates when that remainder is '' (whole interface object)
    // or '/oper-state' (direct scalar leaf). Anything deeper is a sub-container.
    const afterIface = pathStr.replace(/^.*?interface\[[^\]]+\]/, '');
    const isTopLevel = afterIface === '' || afterIface === '/oper-state';

    // Trace helper — record every oper-state-related path for debugging.
    if (pathStr.includes('oper-state')) {
        if (!operStateTrace[cache._routerId]) operStateTrace[cache._routerId] = [];
        operStateTrace[cache._routerId].push({
            ts: new Date().toISOString(), path: pathStr,
            value: typeof value === 'object' ? value?.['oper-state'] ?? '(object)' : value,
            isTopLevel
        });
        if (operStateTrace[cache._routerId].length > TRACE_MAX)
            operStateTrace[cache._routerId].shift();
    }

    // Handle object values (SR Linux sends complete interface objects)
    if (typeof value === 'object' && value !== null) {
        // Extract oper-state only from top-level interface or subinterface paths
        // (transceiver oper-state represents physical transceiver, not interface state)
        if (value['oper-state'] !== undefined && isTopLevel) {
            iface.operState = value['oper-state'];
        }

        // Handle statistics - SR Linux sends these directly in value when path ends with /statistics[]
        if (value['in-octets'] !== undefined || value['out-octets'] !== undefined) {
            // Convert string values to numbers (SR Linux sends as strings)
            const inOctets = parseInt(value['in-octets']) || 0;
            const outOctets = parseInt(value['out-octets']) || 0;

            const timeDiff = (now - iface.lastUpdate) / 1000;

            if (timeDiff > 0 && iface.lastInOctets > 0) {
                iface.inRate = ((inOctets - iface.lastInOctets) / timeDiff) * 8;
            }
            if (timeDiff > 0 && iface.lastOutOctets > 0) {
                iface.outRate = ((outOctets - iface.lastOutOctets) / timeDiff) * 8;
            }

            iface.inOctets = inOctets;
            iface.outOctets = outOctets;
            iface.lastInOctets = inOctets;
            iface.lastOutOctets = outOctets;
        }

        // Also handle nested statistics object (for compatibility)
        if (value.statistics) {
            const stats = value.statistics;
            const inOctets = parseInt(stats['in-octets']) || 0;
            const outOctets = parseInt(stats['out-octets']) || 0;

            const timeDiff = (now - iface.lastUpdate) / 1000;
            if (timeDiff > 0 && iface.lastInOctets > 0) {
                iface.inRate = ((inOctets - iface.lastInOctets) / timeDiff) * 8;
            }
            if (timeDiff > 0 && iface.lastOutOctets > 0) {
                iface.outRate = ((outOctets - iface.lastOutOctets) / timeDiff) * 8;
            }

            iface.inOctets = inOctets;
            iface.outOctets = outOctets;
            iface.lastInOctets = inOctets;
            iface.lastOutOctets = outOctets;
        }

        iface.lastUpdate = now;
    }

    // Handle IP addresses from subinterface paths
    // Path format: /interface[name=X]/subinterface[index=Y]/ipv4/address[ip-prefix=A.B.C.D/N]
    if (pathStr.includes('subinterface') && pathStr.includes('ipv4') && pathStr.includes('address')) {
        const ipMatch = pathStr.match(/address\[ip-prefix=([^\]]+)\]/);
        if (ipMatch) {
            const ipPrefix = ipMatch[1];
            // Add to ipAddresses array if not already present
            if (!iface.ipAddresses) {
                iface.ipAddresses = [];
            }
            if (!iface.ipAddresses.includes(ipPrefix)) {
                iface.ipAddresses.push(ipPrefix);
                console.log(`[${cache._routerId}] ✓ Interface ${ifName} has IP: ${ipPrefix}`);
            }

            // If this is system0 or mgmt0 interface, also store in system cache
            if (ifName === 'system0' || ifName === 'mgmt0') {
                // Extract just the IP address without prefix length
                const ipOnly = ipPrefix.split('/')[0];
                cache.system.system0IP = ipOnly;
                console.log(`[${cache._routerId}] ✓ Management IP detected (${ifName}): ${ipOnly}`);
            }
        }
    }

    // Fallback for scalar values in specific paths
    else if (pathStr.includes('/oper-state') && isTopLevel) {
        iface.operState = value || 'unknown';
    } else if (pathStr.includes('/statistics/in-octets')) {
        const timeDiff = (now - iface.lastUpdate) / 1000;
        if (timeDiff > 0 && iface.lastInOctets > 0) {
            iface.inRate = ((value - iface.lastInOctets) / timeDiff) * 8;
        }
        iface.inOctets = value || 0;
        iface.lastInOctets = value || 0;
        iface.lastUpdate = now;
    } else if (pathStr.includes('/statistics/out-octets')) {
        const timeDiff = (now - iface.lastUpdate) / 1000;
        if (timeDiff > 0 && iface.lastOutOctets > 0) {
            iface.outRate = ((value - iface.lastOutOctets) / timeDiff) * 8;
        }
        iface.outOctets = value || 0;
        iface.lastOutOctets = value || 0;
        iface.lastUpdate = now;
    } else if (pathStr.includes('/statistics/in-errors')) {
        iface.inErrors = value || 0;
    } else if (pathStr.includes('/statistics/out-errors')) {
        iface.outErrors = value || 0;
    }
}

// Update interface cache from network-instance data
// Path format: /network-instance[name=default]/interface[name=ethernet-1/1.1]
// This gives us the subinterface name with IP info from network-instance perspective
function updateInterfaceFromNetworkInstance(cache, pathStr, value) {
    // Extract the interface name from the network-instance path
    // Example: /network-instance[name=default]/interface[name=ethernet-1/1.1]
    const ifaceMatch = pathStr.match(/interface\[name=([^\]]+)\]/);
    if (!ifaceMatch) return;

    let ifaceName = ifaceMatch[1];

    // Convert subinterface notation: ethernet-1/1.1 -> ethernet-1/1
    // We store by physical interface name, but track all subinterface IPs
    const baseIfaceName = ifaceName.split('.')[0];

    // Initialize interface if doesn't exist
    if (!cache.interfaces[baseIfaceName]) {
        cache.interfaces[baseIfaceName] = {
            name: baseIfaceName,
            operState: 'unknown',
            ipAddresses: [],
            inOctets: 0,
            outOctets: 0,
            inErrors: 0,
            outErrors: 0,
            inRate: 0,
            outRate: 0,
            lastInOctets: 0,
            lastOutOctets: 0,
            lastUpdate: Date.now()
        };
    }

    const iface = cache.interfaces[baseIfaceName];

    // Parse value which contains IP prefix information
    // From network-instance, the value object contains { "ipv4": {"address": [{"ip-prefix": "X.X.X.X/Y"}]} }
    if (typeof value === 'object' && value !== null) {
        // Check for ipv4 address in the value
        if (value.ipv4 && value.ipv4.address && Array.isArray(value.ipv4.address)) {
            value.ipv4.address.forEach(addr => {
                if (addr['ip-prefix']) {
                    const ipPrefix = addr['ip-prefix'];
                    if (!iface.ipAddresses) {
                        iface.ipAddresses = [];
                    }
                    if (!iface.ipAddresses.includes(ipPrefix)) {
                        iface.ipAddresses.push(ipPrefix);
                        console.log(`[${cache._routerId}] ✓ Interface ${baseIfaceName} (from network-instance) has IP: ${ipPrefix}`);
                    }
                }
            });
        }

        // Also check if the value directly has ip-prefix (different format)
        if (value['ip-prefix']) {
            const ipPrefix = value['ip-prefix'];
            if (!iface.ipAddresses) {
                iface.ipAddresses = [];
            }
            if (!iface.ipAddresses.includes(ipPrefix)) {
                iface.ipAddresses.push(ipPrefix);
                console.log(`[${cache._routerId}] ✓ Interface ${baseIfaceName} (from network-instance) has IP: ${ipPrefix}`);
            }
        }
    }
}

// Update system cache
function updateSystemCache(cache, pathStr, value) {
    // Handle full platform/control object from SR Linux
    if (typeof value === 'object' && value !== null) {
        // SR Linux CPU data from :cpu[index=all]/total[]
        // Path: /platform[]/control[slot=A]/srl_nokia-platform-cpu:cpu[index=all]/total[]
        // Value: {"instant": 4, "average-1": 5, "average-5": 5, "average-15": 5}
        // Note: SR Linux uses namespace prefix like "srl_nokia-platform-cpu:cpu" so we check for "cpu" not "/cpu"
        if (pathStr.includes('cpu') && pathStr.includes('/total')) {
            if (value.instant !== undefined) {
                cache.system.cpu.total = value.instant;
                console.log(`[${cache._routerId}] ✓ CPU updated: ${value.instant}%`);
            } else if (value['average-1'] !== undefined) {
                cache.system.cpu.total = value['average-1'];
                console.log(`[${cache._routerId}] ✓ CPU updated: ${value['average-1']}%`);
            }
        }

        // SR Linux Memory data from /memory[]
        // Path: /platform[]/control[slot=A]/srl_nokia-platform-memory:memory[]
        // Value: {"physical": "12295260000", "reserved": "9817376000", "free": "2477884000", "utilization": 79}
        if (pathStr.includes('memory') && value.utilization !== undefined) {
            cache.system.memory.utilization = value.utilization;
            if (value.physical) cache.system.memory.physical = parseInt(value.physical) || 0;
            if (value.reserved) cache.system.memory.used = parseInt(value.reserved) || 0;
            if (value.free) cache.system.memory.free = parseInt(value.free) || 0;
            console.log(`[${cache._routerId}] ✓ Memory updated: ${value.utilization}%`);
        }

        // Generic CPU data (backward compatibility)
        if (value.cpu) {
            if (value.cpu.total !== undefined) {
                cache.system.cpu.total = value.cpu.total;
            }
            if (value.cpu.average !== undefined) {
                cache.system.cpu.total = value.cpu.average;
            }
        }

        // Generic memory data (backward compatibility)
        if (value.memory && !pathStr.includes('/memory')) {
            if (value.memory.physical !== undefined) {
                cache.system.memory.physical = value.memory.physical;
            }
            if (value.memory.used !== undefined) {
                cache.system.memory.used = value.memory.used;
            }
            if (value.memory.free !== undefined) {
                cache.system.memory.free = value.memory.free;
            }

            // Calculate utilization
            if (cache.system.memory.used && cache.system.memory.physical) {
                cache.system.memory.utilization = (cache.system.memory.used / cache.system.memory.physical) * 100;
            }
        }
    }

    // Fallback to scalar values
    if (pathStr.includes('/cpu') && pathStr.includes('/total') && typeof value === 'number') {
        cache.system.cpu.total = value;
    } else if (pathStr.includes('/memory/physical') && typeof value === 'number') {
        cache.system.memory.physical = value;
    }
}

// Update BGP cache
function updateBgpCache(cache, pathStr, value) {
    // Ensure BGP cache structure exists
    if (!cache.bgp) {
        cache.bgp = { totalPeers: 0, activePeers: 0, neighbors: [] };
    }
    if (!cache.bgp.neighbors) {
        cache.bgp.neighbors = [];
    }

    // Handle full BGP object from SR Linux
    if (typeof value === 'object' && value !== null) {
        // Statistics object
        if (value.statistics || (pathStr.includes('/statistics') && !pathStr.includes('/neighbor'))) {
            const stats = value.statistics || value;
            if (stats['total-peers'] !== undefined) {
                cache.bgp.totalPeers = stats['total-peers'];
            }
            if (stats['active-peers'] !== undefined) {
                cache.bgp.activePeers = stats['active-peers'];
            }
        }

        // BGP neighbor data from SR Linux
        // Path: /network-instance[name=default]/protocols[]/bgp[]/neighbor[peer-address=X.X.X.X]
        // Value: {"session-state": "established", "peer-address": "X.X.X.X", ...}
        if (value['peer-address'] || pathStr.includes('/neighbor[peer-address=')) {
            // Extract peer address from value or path
            let peerAddr = value['peer-address'];
            if (!peerAddr) {
                const match = pathStr.match(/neighbor\[peer-address=([^\]]+)\]/);
                if (match) peerAddr = match[1];
            }

            if (peerAddr) {
                let neighbor = cache.bgp.neighbors.find(n => n.peerAddress === peerAddr);

                if (!neighbor) {
                    neighbor = {
                        peerAddress: peerAddr,
                        sessionState: 'unknown',
                        routesReceived: 0
                    };
                    cache.bgp.neighbors.push(neighbor);
                }

                if (value['session-state']) {
                    neighbor.sessionState = value['session-state'];
                }
                if (value['received-routes'] !== undefined) {
                    neighbor.routesReceived = value['received-routes'];
                }
                // SR Linux may not have 'received-routes' directly, use alternative if available
                if (value['afi-safi'] && Array.isArray(value['afi-safi'])) {
                    // Try to extract route count from afi-safi data
                    value['afi-safi'].forEach(af => {
                        if (af['received-routes']) {
                            neighbor.routesReceived += af['received-routes'];
                        }
                    });
                }

                // Update counts
                cache.bgp.totalPeers = cache.bgp.neighbors.length;
                cache.bgp.activePeers = cache.bgp.neighbors.filter(n => n.sessionState === 'established').length;
            }
        }
    }

    // Fallback to path-based parsing
    if (pathStr.includes('/protocols/bgp/statistics')) {
        if (pathStr.includes('/total-peers')) {
            cache.bgp.totalPeers = value || 0;
        } else if (pathStr.includes('/active-peers')) {
            cache.bgp.activePeers = value || 0;
        }
    } else if (pathStr.includes('/protocols/bgp/neighbor')) {
        // Extract peer address
        const match = pathStr.match(/neighbor\[peer-address=([^\]]+)\]/);
        if (match) {
            const peerAddr = match[1];
            let neighbor = cache.bgp.neighbors.find(n => n.peerAddress === peerAddr);

            if (!neighbor) {
                neighbor = {
                    peerAddress: peerAddr,
                    sessionState: 'unknown',
                    routesReceived: 0
                };
                cache.bgp.neighbors.push(neighbor);
            }

            if (pathStr.includes('/session-state')) {
                neighbor.sessionState = value || 'unknown';
            } else if (pathStr.includes('/received-routes')) {
                neighbor.routesReceived = value || 0;
            }

            // Update counts
            cache.bgp.totalPeers = cache.bgp.neighbors.length;
            cache.bgp.activePeers = cache.bgp.neighbors.filter(n => n.sessionState === 'established').length;
        }
    }

    // Handle routes from route-table
    // Path format: /network-instance[name=default]/route-table/ipv4-unicast/route[ipv4-prefix=X.X.X.X/Y][route-type=bgp]
    // or: /network-instance[name=default]/route-table/ipv4-unicast/route[ipv4-prefix=X.X.X.X/Y][route-owner=bgp_mgr]
    if (pathStr.includes('/route-table/ipv4-unicast/route')) {
        // Extract the ipv4-prefix from the path
        const prefixMatch = pathStr.match(/ipv4-prefix=([^\]]+)\]/);

        // Check if this is a BGP route (route-type=bgp or route-owner=bgp_mgr)
        const isBgpRoute = pathStr.includes('route-type=bgp') || pathStr.includes('route-owner=bgp_mgr');

        if (prefixMatch && isBgpRoute) {
            const prefix = prefixMatch[1];

            // Check if route already exists
            const existingRoute = cache.bgp.routes.find(r => r.prefix === prefix);

            if (!existingRoute) {
                cache.bgp.routes.push({
                    prefix: prefix,
                    received: true
                });
                console.log(`[${cache._routerId}] ✓ BGP route received: ${prefix}`);
            }
        }
    }
}

// Mark stale routers
function markStaleRouters() {
    setInterval(() => {
        const now = Date.now();
        for (const routerId in routerCache) {
            const cache = routerCache[routerId];
            if (cache.lastUpdate) {
                const lastUpdateTime = new Date(cache.lastUpdate).getTime();
                if (now - lastUpdateTime > 30000 && cache.status === 'connected') {
                    cache.status = 'stale';
                    console.log(`[${routerId}] Marked as stale (no updates for 30s)`);
                }
            }
        }
    }, 10000);
}

// HTTP Request Handlers

function handleGetRouters(req, res) {
    const summary = {};
    for (const routerId in ROUTERS) {
        const cache = routerCache[routerId];
        summary[routerId] = {
            name: ROUTERS[routerId].name,
            type: ROUTERS[routerId].type,
            host: ROUTERS[routerId].host,
            status: cache ? cache.status : 'unknown',
            lastUpdate: cache ? cache.lastUpdate : null
        };
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ routers: summary }));
}

// Handle RTU status (ping-based monitoring)
function handleGetRtus(req, res) {
    const summary = {};
    for (const rtuId in RTUS) {
        const cache = rtuCache[rtuId];
        summary[rtuId] = {
            name: RTUS[rtuId].name,
            type: RTUS[rtuId].type,
            host: RTUS[rtuId].host,
            status: cache ? cache.status : 'unknown',
            lastCheck: cache ? cache.lastCheck : null
        };
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rtus: summary }));
}

// Link definitions loaded from config.json (single source of truth).
const LINKS = CONFIG.links;

// Pure computation — reused by REST handler, SSE snapshot, and teleprotection FSM.
function computeLinks() {
    const linkStatus = {};

    for (const [linkId, link] of Object.entries(LINKS)) {
        const dev1 = ROUTERS[link.router1] || RTUS[link.router1];
        const dev2 = ROUTERS[link.router2] || RTUS[link.router2];

        const cache1 = routerCache[link.router1] || rtuCache[link.router1];
        const cache2 = routerCache[link.router2] || rtuCache[link.router2];

        // Fault-injection override beats cache state.
        const router1Connected = faultOverrides.routers[link.router1] === 'down' || faultOverrides.rtus[link.router1] === 'offline'
            ? false
            : cache1 && (cache1.status === 'connected' || cache1.status === 'stale' || cache1.status === 'online');
        const router2Connected = faultOverrides.routers[link.router2] === 'down' || faultOverrides.rtus[link.router2] === 'offline'
            ? false
            : cache2 && (cache2.status === 'connected' || cache2.status === 'stale' || cache2.status === 'online');

        let iface1State = 'unknown';
        let iface2State = 'unknown';
        const rCache1 = routerCache[link.router1];
        const rCache2 = routerCache[link.router2];
        if (rCache1 && rCache1.interfaces && rCache1.interfaces[link.interface1]) iface1State = rCache1.interfaces[link.interface1].operState;
        if (rCache2 && rCache2.interfaces && rCache2.interfaces[link.interface2]) iface2State = rCache2.interfaces[link.interface2].operState;

        const isRtu1 = !!RTUS[link.router1];
        const isRtu2 = !!RTUS[link.router2];
        if (isRtu1) iface1State = router1Connected ? 'up' : 'down';
        if (isRtu2) iface2State = router2Connected ? 'up' : 'down';

        let linkUp = iface1State === 'up' && iface2State === 'up';
        // Explicit link fault injection always wins.
        if (faultOverrides.links[linkId] === 'down') linkUp = false;

        linkStatus[linkId] = {
            status: linkUp ? 'up' : 'down',
            faulted: faultOverrides.links[linkId] === 'down',
            router1: { id: link.router1, name: dev1 ? dev1.name : link.router1, interface: link.interface1, state: iface1State, connected: router1Connected },
            router2: { id: link.router2, name: dev2 ? dev2.name : link.router2, interface: link.interface2, state: iface2State, connected: router2Connected }
        };
    }
    return linkStatus;
}

function handleGetLinks(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ links: computeLinks() }));
}

// Teleprotection FSM — leaf is isolated when both its DC uplinks are down.
// ARMED (all clear) → PICKUP (one leaf fully isolated, awaiting confirmation) → TRIP (sustained).
// This simplified model mirrors real teleprotection: PICKUP is a transient detection,
// TRIP is the committed action after the condition persists (here: 2 consecutive evaluations).
let _pickupCount = 0;
function evaluateTeleprotection() {
    const links = computeLinks();
    const isolated = [];
    for (const leaf of ['leaf1', 'leaf2', 'leaf3', 'leaf4']) {
        const dc1Down = links[`dc1-${leaf}`]?.status !== 'up';
        const dc2Down = links[`dc2-${leaf}`]?.status !== 'up';
        if (dc1Down && dc2Down) isolated.push(leaf);
    }

    const prev = teleprotection.state;
    let next = prev;
    let reason = teleprotection.reason;

    if (isolated.length === 0) {
        next = 'ARMED';
        reason = 'all-clear';
        _pickupCount = 0;
    } else if (prev === 'ARMED') {
        next = 'PICKUP';
        reason = `leaves isolated: ${isolated.join(',')}`;
        _pickupCount = 1;
    } else if (prev === 'PICKUP') {
        _pickupCount += 1;
        if (_pickupCount >= 2) { next = 'TRIP'; reason = `sustained isolation: ${isolated.join(',')}`; }
    } else if (prev === 'TRIP') {
        reason = `sustained isolation: ${isolated.join(',')}`;
    }

    teleprotection.isolatedLeaves = isolated;
    if (next !== prev) {
        teleprotection.state = next;
        teleprotection.reason = reason;
        teleprotection.lastTransition = new Date().toISOString();
        logEvent('teleprotection', { from: prev, to: next, reason, isolatedLeaves: isolated });
    } else {
        teleprotection.reason = reason;
    }
}

function buildSnapshot() {
    const routers = {};
    for (const id in ROUTERS) {
        const c = routerCache[id];
        const forced = faultOverrides.routers[id];
        routers[id] = {
            name: ROUTERS[id].name,
            type: ROUTERS[id].type,
            host: ROUTERS[id].host,
            status: forced === 'down' ? 'disconnected' : (c ? c.status : 'unknown'),
            faulted: forced === 'down',
            lastUpdate: c ? c.lastUpdate : null
        };
    }
    const rtus = {};
    for (const id in RTUS) {
        const c = rtuCache[id];
        const forced = faultOverrides.rtus[id];
        rtus[id] = {
            name: RTUS[id].name,
            host: RTUS[id].host,
            status: forced === 'offline' ? 'offline' : (c ? c.status : 'unknown'),
            faulted: forced === 'offline',
            lastCheck: c ? c.lastCheck : null
        };
    }
    return { routers, rtus, links: computeLinks(), teleprotection, faults: faultOverrides, ts: new Date().toISOString() };
}

function broadcastSnapshot() {
    evaluateTeleprotection();
    broadcast('snapshot', buildSnapshot());
}

// Handle global statistics
function handleGetStats(req, res) {
    // Count routers
    const totalRouters = Object.keys(ROUTERS).length;
    let activeRouters = 0;
    for (const routerId in ROUTERS) {
        const cache = routerCache[routerId];
        if (cache && (cache.status === 'connected' || cache.status === 'stale')) {
            activeRouters++;
        }
    }

    // Count RTUs
    const totalRtus = Object.keys(RTUS).length;
    let activeRtus = 0;
    for (const rtuId in RTUS) {
        const cache = rtuCache[rtuId];
        if (cache && cache.status === 'online') {
            activeRtus++;
        }
    }

    const totalDevices = totalRouters + totalRtus;
    const activeDevices = activeRouters + activeRtus;
    const activePercentage = totalDevices > 0 ? Math.round((activeDevices / totalDevices) * 100) : 0;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        routers: {
            total: totalRouters,
            active: activeRouters,
            percentage: totalRouters > 0 ? Math.round((activeRouters / totalRouters) * 100) : 0
        },
        rtus: {
            total: totalRtus,
            active: activeRtus,
            percentage: totalRtus > 0 ? Math.round((activeRtus / totalRtus) * 100) : 0
        },
        overall: {
            total: totalDevices,
            active: activeDevices,
            percentage: activePercentage
        }
    }));
}

// Monitor RTUs via ping
function monitorRtus() {
    for (const rtuId in RTUS) {
        const rtu = RTUS[rtuId];
        const prevStatus = rtuCache[rtuId]?.status;
        pingHost(rtu.host).then(result => {
            const newStatus = result.alive ? 'online' : 'offline';
            rtuCache[rtuId] = {
                status: newStatus,
                lastCheck: new Date().toISOString(),
                latency: result.latency || null
            };
            if (prevStatus && prevStatus !== newStatus) {
                logEvent('rtu-status', { id: rtuId, from: prevStatus, to: newStatus });
            }
        }).catch(error => {
            rtuCache[rtuId] = {
                status: 'error',
                lastCheck: new Date().toISOString(),
                error: error.message
            };
            if (prevStatus && prevStatus !== 'error') {
                logEvent('rtu-status', { id: rtuId, from: prevStatus, to: 'error' });
            }
        });
    }
}

// Ping function for RTU monitoring
function pingHost(ip) {
    return new Promise((resolve, reject) => {
        const isWindows = process.platform === 'win32';
        const pingCommand = isWindows
            ? `ping -n 1 -w 2000 ${ip}`
            : `ping -c 1 -W 2 ${ip}`;

        exec(pingCommand, (error, stdout, stderr) => {
            if (error) {
                resolve({ ip, alive: false, error: error.message });
            } else {
                const success = stdout.toLowerCase().includes('ttl=') ||
                               stdout.toLowerCase().includes('time=');

                // Extract latency if available
                let latency = null;
                const latencyMatch = stdout.match(/time[=<](\d+\.?\d*)/i);
                if (latencyMatch) {
                    latency = parseFloat(latencyMatch[1]);
                }

                resolve({ ip, alive: success, latency });
            }
        });
    });
}

function handleGetInterfaces(req, res, routerId) {
    const cache = routerCache[routerId];

    if (!cache || cache.status === 'disconnected') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Router unavailable' }));
        return;
    }

    // Filter interfaces to show only those with IP addresses configured
    // Since IP address data might not be available via gNMI subscription,
    // we filter by: operState=UP AND (has traffic OR is management interface)
    const allInterfaces = Object.values(cache.interfaces);

    // Debug: show all UP interfaces first
    console.log(`[DEBUG] ${routerId} - Total interfaces: ${allInterfaces.length}`);
    const upInterfaces = allInterfaces.filter(i => i.operState === 'up');
    console.log(`[DEBUG] ${routerId} - UP interfaces: ${upInterfaces.length}`);
    upInterfaces.forEach(i => {
        console.log(`[DEBUG] ${routerId} - ${i.name}: operState=${i.operState}, IPs=${JSON.stringify(i.ipAddresses)}, inOctets=${i.inOctets}, outOctets=${i.outOctets}`);
    });

    const interfaces = allInterfaces.filter(iface => {
        // Check if has explicit IP addresses (from subinterface data)
        if (iface.ipAddresses && iface.ipAddresses.length > 0) {
            return true;
        }
        // Fallback: Show interfaces that are UP and have traffic or are mgmt/system interfaces
        const isUp = iface.operState === 'up';
        const hasTraffic = (iface.inOctets > 0 || iface.outOctets > 0);
        const isManagement = iface.name.includes('mgmt') || iface.name.includes('system');
        return isUp && (hasTraffic || isManagement);
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        interfaces,
        total: allInterfaces.length,
        filtered: interfaces.length
    }));
}

function handleGetSystem(req, res, routerId) {
    const cache = routerCache[routerId];

    if (!cache || cache.status === 'disconnected') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Router unavailable' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cache.system));
}

function handleGetBgp(req, res, routerId) {
    const cache = routerCache[routerId];

    if (!cache || cache.status === 'disconnected') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Router unavailable' }));
        return;
    }

    // Debug BGP data
    console.log(`[DEBUG BGP] ${routerId} - Total peers: ${cache.bgp.totalPeers}, Active: ${cache.bgp.activePeers}`);
    console.log(`[DEBUG BGP] ${routerId} - Neighbors:`, JSON.stringify(cache.bgp.neighbors, null, 2));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cache.bgp));
}

function handleHealth(req, res) {
    const connections = {};
    for (const routerId in ROUTERS) {
        const cache = routerCache[routerId];
        connections[routerId] = cache ? cache.status : 'unknown';
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'ok',
        service: 'gnmi-service',
        connections
    }));
}

// Ping function
function pingHost(ip) {
    return new Promise((resolve, reject) => {
        // Use platform-specific ping command
        const isWindows = process.platform === 'win32';
        const pingCommand = isWindows
            ? `ping -n 1 -w 2000 ${ip}`
            : `ping -c 1 -W 2 ${ip}`;

        exec(pingCommand, (error, stdout, stderr) => {
            // Parse output to check if ping was successful
            // Check for various success indicators:
            // - ttl= (bytes received line)
            // - time= (round-trip time)
            // - "1 packets received" or "1 received" (statistics line)
            const output = stdout.toLowerCase();

            // Check for success indicators
            const hasResponse = output.includes('ttl=') ||
                               output.includes('time=') ||
                               /1\s+packets?\s+received/.test(output);

            // Check for packet loss percentage (0% or 0.0% means success)
            const packetLossMatch = output.match(/([\d.]+)%\s+packet\s+loss/);
            const hasZeroLoss = packetLossMatch && parseFloat(packetLossMatch[1]) === 0;

            const success = hasResponse || hasZeroLoss;

            resolve({
                ip: ip,
                alive: success,
                timestamp: new Date().toISOString()
            });
        });
    });
}

// Handler for ping endpoint
function handlePing(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const ip = parsedUrl.searchParams.get('ip');

    if (!ip) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'IP parameter required' }));
        return;
    }

    // Validate IP format (basic validation)
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(ip)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid IP format' }));
        return;
    }

    pingHost(ip).then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    }).catch(error => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    });
}

// HTTP Server
const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Use WHATWG URL API instead of deprecated url.parse()
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // Route handlers
    if (pathname === '/api/routers' && req.method === 'GET') {
        handleGetRouters(req, res);
    } else if (pathname.match(/^\/api\/routers\/(\w+)\/interfaces$/)) {
        const routerId = pathname.match(/^\/api\/routers\/(\w+)\/interfaces$/)[1];
        if (!ROUTERS[routerId]) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Router not found' }));
            return;
        }
        handleGetInterfaces(req, res, routerId);
    } else if (pathname.match(/^\/api\/routers\/(\w+)\/system$/)) {
        const routerId = pathname.match(/^\/api\/routers\/(\w+)\/system$/)[1];
        if (!ROUTERS[routerId]) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Router not found' }));
            return;
        }
        handleGetSystem(req, res, routerId);
    } else if (pathname.match(/^\/api\/routers\/(\w+)\/bgp$/)) {
        const routerId = pathname.match(/^\/api\/routers\/(\w+)\/bgp$/)[1];
        if (!ROUTERS[routerId]) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Router not found' }));
            return;
        }
        handleGetBgp(req, res, routerId);
    } else if (pathname === '/api/ping' && req.method === 'GET') {
        handlePing(req, res);
    } else if (pathname === '/api/rtus' && req.method === 'GET') {
        handleGetRtus(req, res);
    } else if (pathname === '/api/stats' && req.method === 'GET') {
        handleGetStats(req, res);
    } else if (pathname === '/api/links' && req.method === 'GET') {
        handleGetLinks(req, res);
    } else if (pathname === '/api/config' && req.method === 'GET') {
        // Expose the same config.json the frontend should use — omit credentials.
        const { credentials, ...gnmiPublic } = CONFIG.gnmi;
        const publicConfig = { ...CONFIG, gnmi: gnmiPublic };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(publicConfig));
    } else if (pathname === '/api/teleprotection' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(teleprotection));
    } else if (pathname === '/api/events' && req.method === 'GET') {
        // Server-Sent Events stream — replaces 10s REST polling.
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        res.write(`event: snapshot\ndata: ${JSON.stringify(buildSnapshot())}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
    } else if (pathname === '/api/eventlog' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events: eventLog }));
    } else if (pathname === '/api/fault' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 8192) req.destroy(); });
        req.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(body || '{}'); } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid JSON' }));
                return;
            }
            if (parsed.clear) {
                faultOverrides.routers = {}; faultOverrides.rtus = {}; faultOverrides.links = {};
                logEvent('fault-clear', {});
            } else {
                // Shape: { kind: 'router'|'rtu'|'link', id: string, state: 'down'|'offline'|'up'|'online' }
                const { kind, id, state } = parsed;
                const healthy = state === 'up' || state === 'online';
                if (kind === 'router' && ROUTERS[id]) {
                    if (healthy) delete faultOverrides.routers[id]; else faultOverrides.routers[id] = 'down';
                } else if (kind === 'rtu' && RTUS[id]) {
                    if (healthy) delete faultOverrides.rtus[id]; else faultOverrides.rtus[id] = 'offline';
                } else if (kind === 'link' && LINKS[id]) {
                    if (healthy) delete faultOverrides.links[id]; else faultOverrides.links[id] = 'down';
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'unknown kind or id' }));
                    return;
                }
                logEvent('fault-inject', { kind, id, state });
            }
            broadcastSnapshot();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ faults: faultOverrides }));
        });
    } else if (pathname === '/api/debug/trace' && req.method === 'GET') {
        // Diagnostic: show last N oper-state gNMI paths received per router.
        // Usage: GET /api/debug/trace?id=leaf1
        const id = parsedUrl.searchParams.get('id');
        const out = id ? { [id]: operStateTrace[id] || [] } : operStateTrace;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out, null, 2));
    } else if (pathname === '/api/debug/cache' && req.method === 'GET') {
        // Diagnostic: expose raw interface operState for all routers.
        // Usage: GET /api/debug/cache          → all routers
        //        GET /api/debug/cache?id=leaf1  → single router
        const id = parsedUrl.searchParams.get('id');
        const out = {};
        const ids = id ? [id] : Object.keys(routerCache);
        for (const rid of ids) {
            const c = routerCache[rid];
            if (!c) { out[rid] = null; continue; }
            out[rid] = {
                status: c.status,
                lastUpdate: c.lastUpdate,
                interfaces: Object.fromEntries(
                    Object.entries(c.interfaces || {}).map(([k, v]) => [k, v.operState])
                )
            };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out, null, 2));
    } else if (pathname === '/health') {
        handleHealth(req, res);
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
});

// Periodic safety-net broadcast — pushes snapshot to all SSE clients every 2s
// so UI stays fresh even when individual gNMI updates don't trigger changes.
// Also drives the teleprotection FSM re-evaluation.
setInterval(() => {
    if (sseClients.size > 0) broadcastSnapshot();
    else evaluateTeleprotection();
}, 2000);

// Start server
server.listen(PORT, () => {
    console.log(`\ngNMI Service running on http://localhost:${PORT}`);
    console.log(`\nAPI Endpoints:`);
    console.log(`  GET /api/routers                  - List all routers`);
    console.log(`  GET /api/routers/:id/interfaces   - Interface statistics`);
    console.log(`  GET /api/routers/:id/system       - System performance`);
    console.log(`  GET /api/routers/:id/bgp          - BGP statistics`);
    console.log(`  GET /api/rtus                     - List all RTUs`);
    console.log(`  GET /api/stats                    - Global device statistics`);
    console.log(`  GET /api/links                    - Router link status`);
    console.log(`  GET /api/ping?ip=<IP>             - Ping an IP address`);
    console.log(`  GET /api/config                   - Topology & service config`);
    console.log(`  GET /api/teleprotection           - Teleprotection FSM state`);
    console.log(`  GET /api/events                   - SSE snapshot/event stream`);
    console.log(`  GET /api/eventlog                 - Recent event log`);
    console.log(`  POST /api/fault                   - Inject/clear fault overrides`);
    console.log(`  GET /health                       - Service health\n`);

    console.log(`Configured Routers (gNMI):`);
    for (const [id, config] of Object.entries(ROUTERS)) {
        console.log(`  ${id}: ${config.name} (${config.host}:${config.port}) [${config.type}]`);
    }
    console.log('');

    console.log(`Configured RTUs (Ping):`);
    for (const [id, config] of Object.entries(RTUS)) {
        console.log(`  ${id}: ${config.name} (${config.host}) [${config.type}]`);
    }
    console.log('');

    // Start subscriptions for routers
    for (const routerId in ROUTERS) {
        subscribeToRouter(routerId);
    }

    // Start RTU monitoring (every 10 seconds)
    monitorRtus();
    setInterval(monitorRtus, 10000);

    // Start stale marker
    markStaleRouters();
});
