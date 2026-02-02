// gNMI Service for Smart Grid Router Monitoring
// Connects to SR Linux routers via gRPC and exposes telemetry via REST API

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const http = require('http');
const { exec } = require('child_process');

const PORT = 3001;

// Router configurations
// Port 57401 is the insecure (non-TLS) gNMI port in SR Linux v24
const ROUTERS = {
    dc1: { host: '172.20.20.5', port: 57401, name: 'DC-1', type: 'spine' },
    dc2: { host: '172.20.20.8', port: 57401, name: 'DC-2', type: 'spine' },
    leaf1: { host: '172.20.20.2', port: 57401, name: 'Leaf-1', type: 'leaf' },
    leaf2: { host: '172.20.20.3', port: 57401, name: 'Leaf-2', type: 'leaf' }
};

// RTU configurations (non-gNMI devices, monitored via ping)
const RTUS = {
    rtu1: { host: '172.20.20.20', name: 'RTU-1', type: 'rtu' },
    rtu2: { host: '172.20.20.21', name: 'RTU-2', type: 'rtu' },
    rtu3: { host: '172.20.20.22', name: 'RTU-3', type: 'rtu' },
    rtu4: { host: '172.20.20.23', name: 'RTU-4', type: 'rtu' }
};

// RTU status cache
const rtuCache = {};

const GNMI_CREDENTIALS = {
    username: 'admin',
    password: 'NokiaSrl1!'
};

// In-memory cache for router telemetry
const routerCache = {};

// Retry counters
const retryCount = {};

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
                    sample_interval: 5000000000 // 5 seconds in nanoseconds
                },
                // Interface IP addresses
                {
                    path: buildPath('interface/subinterface/ipv4/address'),
                    mode: 2, // SAMPLE
                    sample_interval: 5000000000
                },
                // System0 interface specifically for router IP
                {
                    path: buildPath('interface[name=system0]/subinterface[index=0]/ipv4/address'),
                    mode: 2, // SAMPLE
                    sample_interval: 5000000000
                },
                // Mgmt0 interface for router management IP (alternative to system0)
                {
                    path: buildPath('interface[name=mgmt0]/subinterface[index=0]/ipv4/address'),
                    mode: 2, // SAMPLE
                    sample_interval: 5000000000
                },
                // Network instance interfaces (to get IPs from network-instance)
                {
                    path: buildPath('network-instance[name=default]/interface'),
                    mode: 2, // SAMPLE
                    sample_interval: 5000000000
                },
                // System performance
                {
                    path: buildPath('platform/control'),
                    mode: 2, // SAMPLE
                    sample_interval: 5000000000
                },
                // Network instance default - BGP statistics
                {
                    path: buildPath('network-instance[name=default]/protocols/bgp/statistics'),
                    mode: 2, // SAMPLE
                    sample_interval: 5000000000
                },
                // Network instance default - BGP neighbors
                {
                    path: buildPath('network-instance[name=default]/protocols/bgp/neighbor'),
                    mode: 2, // SAMPLE
                    sample_interval: 5000000000
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
            status: 'connected',
            lastUpdate: null,
            interfaces: {},
            system: { cpu: {}, memory: {}, system0IP: null },
            bgp: { totalPeers: 0, activePeers: 0, neighbors: [], routes: [] }
        };
        console.log(`[${routerId}] Cache initialized`);
    }

    const cache = routerCache[routerId];
    cache.lastUpdate = new Date().toISOString();
    cache.status = 'connected';
    retryCount[routerId] = 0; // Reset retry counter on success

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

    // Handle object values (SR Linux sends complete interface objects)
    if (typeof value === 'object' && value !== null) {
        // Extract oper-state from object
        if (value['oper-state'] !== undefined) {
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
    else if (pathStr.includes('/oper-state')) {
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

// Link definitions: which interfaces connect which routers
const LINKS = {
    'dc1-leaf1': { router1: 'dc1', interface1: 'ethernet-1/1', router2: 'leaf1', interface2: 'ethernet-1/1' },
    'dc1-leaf2': { router1: 'dc1', interface1: 'ethernet-1/2', router2: 'leaf2', interface2: 'ethernet-1/1' },
    'dc2-leaf2': { router1: 'dc2', interface1: 'ethernet-1/1', router2: 'leaf2', interface2: 'ethernet-1/2' },
    'dc2-leaf1': { router1: 'dc2', interface1: 'ethernet-1/2', router2: 'leaf1', interface2: 'ethernet-1/3' }
};

// Handle link status endpoint
function handleGetLinks(req, res) {
    const linkStatus = {};

    for (const [linkId, link] of Object.entries(LINKS)) {
        const cache1 = routerCache[link.router1];
        const cache2 = routerCache[link.router2];

        // Check if both routers are connected
        const router1Connected = cache1 && (cache1.status === 'connected' || cache1.status === 'stale');
        const router2Connected = cache2 && (cache2.status === 'connected' || cache2.status === 'stale');

        // Get interface states
        let iface1State = 'unknown';
        let iface2State = 'unknown';

        if (cache1 && cache1.interfaces && cache1.interfaces[link.interface1]) {
            iface1State = cache1.interfaces[link.interface1].operState;
        }
        if (cache2 && cache2.interfaces && cache2.interfaces[link.interface2]) {
            iface2State = cache2.interfaces[link.interface2].operState;
        }

        // Link is UP only if both interfaces are UP
        const linkUp = iface1State === 'up' && iface2State === 'up';

        linkStatus[linkId] = {
            status: linkUp ? 'up' : 'down',
            router1: {
                id: link.router1,
                name: ROUTERS[link.router1].name,
                interface: link.interface1,
                state: iface1State,
                connected: router1Connected
            },
            router2: {
                id: link.router2,
                name: ROUTERS[link.router2].name,
                interface: link.interface2,
                state: iface2State,
                connected: router2Connected
            }
        };
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ links: linkStatus }));
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
        pingHost(rtu.host).then(result => {
            rtuCache[rtuId] = {
                status: result.alive ? 'online' : 'offline',
                lastCheck: new Date().toISOString(),
                latency: result.latency || null
            };
        }).catch(error => {
            rtuCache[rtuId] = {
                status: 'error',
                lastCheck: new Date().toISOString(),
                error: error.message
            };
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
    } else if (pathname === '/health') {
        handleHealth(req, res);
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
});

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
