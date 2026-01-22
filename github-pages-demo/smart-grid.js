// Smart Grid Simulation Controller - DEMO VERSION for GitHub Pages
// This version simulates backend responses for demonstration purposes

class SmartGrid {
    constructor() {
        this.plants = {
            nuclear1: { capacity: 1200, output: 0, active: false, rampRate: 20 },
            nuclear2: { capacity: 1200, output: 0, active: false, rampRate: 20 },
            solar: { capacity: 500, output: 0, active: false, rampRate: 15 },
            wind: { capacity: 400, output: 0, active: false, rampRate: 12 }
        };

        this.network = {
            active: false,
            efficiency: 0.95
        };

        this.city = {
            demand: 2800,
            receiving: 0
        };

        // DEMO MODE: Transmission units are always "online" in demo
        this.transmissionUnits = {
            transmission1: { ip: '172.20.20.20', alive: true, lastCheck: new Date() },
            transmission2: { ip: '172.20.20.21', alive: true, lastCheck: new Date() },
            transmission3: { ip: '172.20.20.22', alive: true, lastCheck: new Date() },
            transmission4: { ip: '172.20.20.23', alive: true, lastCheck: new Date() }
        };

        // DEMO MODE: Routers are simulated as "connected"
        this.routers = {
            dc1: { name: 'DC-1', status: 'connected', metrics: this.generateMockMetrics() },
            dc2: { name: 'DC-2', status: 'connected', metrics: this.generateMockMetrics() }
        };

        this.activeTooltip = null;
        this.activePanel = null;

        // Teleprotection state (T1-T2 differential protection)
        this.teleprotection = {
            closed: true,
            dc1Reachable: true,
            dc2Reachable: true
        };

        this.transmissionPowerMultiplier = 1.0;
        this.demoMode = true; // Flag for demo mode

        this.init();
    }

    // Generate mock metrics for demo
    generateMockMetrics() {
        return {
            interfaces: [
                { name: 'ethernet-1/1', operState: 'up', inOctets: Math.floor(Math.random() * 1000000), outOctets: Math.floor(Math.random() * 1000000) },
                { name: 'ethernet-1/2', operState: 'up', inOctets: Math.floor(Math.random() * 1000000), outOctets: Math.floor(Math.random() * 1000000) },
                { name: 'ethernet-1/3', operState: 'up', inOctets: Math.floor(Math.random() * 1000000), outOctets: Math.floor(Math.random() * 1000000) },
                { name: 'ethernet-1/4', operState: 'up', inOctets: Math.floor(Math.random() * 1000000), outOctets: Math.floor(Math.random() * 1000000) }
            ],
            bgp: {
                peers: [
                    { peerAddress: '10.0.0.1', state: 'established', receivedPrefixes: 150, sentPrefixes: 120 },
                    { peerAddress: '10.0.0.2', state: 'established', receivedPrefixes: 145, sentPrefixes: 118 }
                ]
            },
            system: {
                uptime: '5d 12h 34m',
                cpuUsage: Math.floor(Math.random() * 30) + 10,
                memoryUsage: Math.floor(Math.random() * 40) + 30
            }
        };
    }

    init() {
        // Initialize button listeners
        document.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const target = e.currentTarget.dataset.target;
                if (target === 'distribution') {
                    this.toggleNetwork();
                } else {
                    this.togglePlant(target);
                }
            });
        });

        // Initialize power sliders
        const nuclear1Slider = document.getElementById('nuclear1-slider');
        if (nuclear1Slider) {
            nuclear1Slider.addEventListener('input', (e) => {
                this.updatePowerLevel('nuclear1', parseInt(e.target.value));
            });
        }

        const nuclear2Slider = document.getElementById('nuclear2-slider');
        if (nuclear2Slider) {
            nuclear2Slider.addEventListener('input', (e) => {
                this.updatePowerLevel('nuclear2', parseInt(e.target.value));
            });
        }

        // Start animation loop
        this.animate();

        // Update display immediately
        this.updateDisplay();

        // DEMO: Start simulated monitoring (no actual network calls)
        this.startDemoTransmissionMonitoring();

        // Initialize router nodes event listeners
        this.initializeRouterNodes();

        // DEMO: Set all links to "up" state
        this.setDemoLinkStatus();
    }

    togglePlant(plantId) {
        const plant = this.plants[plantId];
        if (!plant) return;

        plant.active = !plant.active;

        const card = document.querySelector(`[data-plant="${plantId}"]`);
        const btn = card.querySelector('.toggle-btn');

        if (plant.active) {
            card.classList.add('active');
            btn.classList.add('active');
            btn.querySelector('.btn-text').textContent = 'stop';
            this.updateTopology(plantId, true);
            this.rampPower(plantId, true);
        } else {
            this.rampPower(plantId, false);

            if (plantId === 'nuclear1' || plantId === 'nuclear2') {
                const slider = document.getElementById(`${plantId}-slider`);
                if (slider) slider.value = 0;

                const percentageDisplay = card.querySelector('.power-percentage');
                if (percentageDisplay) percentageDisplay.textContent = '0%';

                const indicators = card.querySelectorAll('.indicator-circle');
                indicators.forEach(circle => circle.classList.remove('active'));
            }

            this.updateTopology(plantId, false);

            setTimeout(() => {
                card.classList.remove('active');
                btn.classList.remove('active');
                btn.querySelector('.btn-text').textContent = 'start';
            }, 1000);
        }
    }

    toggleNetwork() {
        this.network.active = !this.network.active;

        const card = document.querySelector('[data-network="distribution"]');
        const btn = card.querySelector('.toggle-btn');
        const statusText = card.querySelector('.status-text');

        if (this.network.active) {
            card.classList.add('active');
            btn.classList.add('active');
            btn.querySelector('.btn-text').textContent = 'stop';
            statusText.textContent = 'online';
            this.updateTopology('distribution', true);
        } else {
            card.classList.remove('active');
            btn.classList.remove('active');
            btn.querySelector('.btn-text').textContent = 'start';
            statusText.textContent = 'offline';
            this.updateTopology('distribution', false);
        }

        this.updateDisplay();
    }

    updatePowerLevel(plantId, percentage) {
        const plant = this.plants[plantId];
        if (!plant) return;

        const targetOutput = (percentage / 100) * plant.capacity;

        if (plant.active) {
            const step = plant.rampRate;
            const ramp = () => {
                if (plant.output < targetOutput) {
                    plant.output = Math.min(plant.output + step, targetOutput);
                    this.updateDisplay();
                    if (plant.output < targetOutput) requestAnimationFrame(ramp);
                } else if (plant.output > targetOutput) {
                    plant.output = Math.max(plant.output - step, targetOutput);
                    this.updateDisplay();
                    if (plant.output > targetOutput) requestAnimationFrame(ramp);
                }
            };
            ramp();
        }

        const card = document.querySelector(`[data-plant="${plantId}"]`);
        if (card) {
            const percentageDisplay = card.querySelector('.power-percentage');
            if (percentageDisplay) percentageDisplay.textContent = percentage + '%';

            const indicators = card.querySelectorAll('.indicator-circle');
            const activatedCount = Math.ceil((percentage / 100) * indicators.length);
            indicators.forEach((circle, index) => {
                if (index < activatedCount) {
                    circle.classList.add('active');
                } else {
                    circle.classList.remove('active');
                }
            });
        }

        this.updateDisplay();
    }

    rampPower(plantId, isRampingUp) {
        const plant = this.plants[plantId];
        if (!plant) return;

        let targetOutput;

        if (plantId === 'nuclear1') {
            const slider = document.getElementById('nuclear1-slider');
            const percentage = slider ? parseInt(slider.value) : 100;
            targetOutput = isRampingUp ? (percentage / 100) * plant.capacity : 0;
        } else if (plantId === 'nuclear2') {
            const slider = document.getElementById('nuclear2-slider');
            const percentage = slider ? parseInt(slider.value) : 100;
            targetOutput = isRampingUp ? (percentage / 100) * plant.capacity : 0;
        } else {
            targetOutput = isRampingUp ? plant.capacity : 0;
        }

        const step = plant.rampRate;

        const ramp = () => {
            if (isRampingUp) {
                if (plant.output < targetOutput) {
                    plant.output = Math.min(plant.output + step, targetOutput);
                    this.updateDisplay();
                    requestAnimationFrame(ramp);
                }
            } else {
                if (plant.output > targetOutput) {
                    plant.output = Math.max(plant.output - step, targetOutput);
                    this.updateDisplay();
                    requestAnimationFrame(ramp);
                }
            }
        };

        ramp();
    }

    getTotalOutput() {
        return Object.values(this.plants).reduce((sum, plant) => sum + plant.output, 0);
    }

    updateDisplay() {
        const totalOutput = this.getTotalOutput();

        document.getElementById('totalOutput').textContent = Math.round(totalOutput);

        const gridStatus = document.getElementById('gridStatus');
        if (this.network.active && totalOutput > 0) {
            gridStatus.textContent = 'online';
        } else {
            gridStatus.textContent = 'offline';
        }

        Object.keys(this.plants).forEach(plantId => {
            const plant = this.plants[plantId];
            const card = document.querySelector(`[data-plant="${plantId}"]`);
            if (card) {
                const outputValue = card.querySelector('.output-value');
                outputValue.textContent = Math.round(plant.output);
            }
        });

        let cityPower = 0;
        if (this.network.active) {
            cityPower = totalOutput * this.network.efficiency;
            cityPower = cityPower * this.transmissionPowerMultiplier;
        }

        this.city.receiving = cityPower;

        const cityPowerDisplay = document.getElementById('cityPower');
        cityPowerDisplay.textContent = Math.round(cityPower);

        const cityCard = document.querySelector('.city-card');
        cityCard.classList.remove('power-none', 'power-low', 'power-high', 'powered');

        if (cityPower === 0) {
            cityCard.classList.add('power-none');
        } else if (cityPower < 2200) {
            cityCard.classList.add('power-low');
        } else {
            cityCard.classList.add('power-high');
        }

        if (cityPower >= this.city.demand) {
            cityCard.classList.add('powered');
        }

        this.updatePlantAnimations();
    }

    updateTopology(nodeId, isActive) {
        const node = document.querySelector(`.node-group[data-node="${nodeId}"]`);
        if (node) {
            if (isActive) {
                node.classList.add('active');
            } else {
                node.classList.remove('active');
            }
        }

        const connection = document.querySelector(`.connection[data-source="${nodeId}"]`);
        if (connection) {
            if (isActive) {
                connection.classList.add('active');
            } else {
                connection.classList.remove('active');
            }
        }

        const particles = document.querySelectorAll(`.particle-${nodeId}`);
        particles.forEach(particle => {
            if (isActive) {
                particle.classList.add('active');
            } else {
                particle.classList.remove('active');
            }
        });

        if (nodeId === 'distribution') {
            const transmissionLines = document.querySelectorAll('.transmission-line');
            transmissionLines.forEach(line => {
                if (isActive) {
                    line.classList.add('active');
                } else {
                    line.classList.remove('active');
                }
            });

            ['transmission1', 'transmission2', 'transmission3', 'transmission4'].forEach(transId => {
                const transNode = document.querySelector(`.node-group[data-node="${transId}"]`);
                if (transNode) {
                    if (isActive) {
                        transNode.classList.add('active');
                    } else {
                        transNode.classList.remove('active');
                    }
                }
            });

            const transParticles = document.querySelectorAll('.particle-distribution, .particle-transmission');
            transParticles.forEach(particle => {
                if (isActive) {
                    particle.classList.add('active');
                } else {
                    particle.classList.remove('active');
                }
            });
        }

        this.updateCityTopology();
    }

    updateCityTopology() {
        const cityNode = document.querySelector('.node-group[data-node="city"]');
        if (!cityNode) return;

        const totalOutput = this.getTotalOutput();
        let cityPower = this.network.active ? totalOutput * this.network.efficiency : 0;
        cityPower = cityPower * this.transmissionPowerMultiplier;

        if (cityPower >= this.city.demand) {
            cityNode.classList.add('active');
        } else {
            cityNode.classList.remove('active');
        }
    }

    updatePlantAnimations() {
        ['nuclear1', 'nuclear2'].forEach(plantId => {
            const plant = this.plants[plantId];
            const turbine = document.getElementById(`${plantId}-turbine`);
            const nodeOuter = document.querySelector(`.node-group[data-node="${plantId}"] .nuclear-node`);

            if (!turbine || !nodeOuter) return;

            if (plant.active && plant.output > 0) {
                turbine.classList.add('rotating');
            } else {
                turbine.classList.remove('rotating');
            }

            if (plant.active && plant.output > 0 && !this.network.active) {
                nodeOuter.classList.add('alert');
            } else {
                nodeOuter.classList.remove('alert');
            }
        });

        const windPlant = this.plants.wind;
        const windNodeOuter = document.querySelector('.node-group[data-node="wind"] .wind-node');
        if (windNodeOuter) {
            if (windPlant.active && windPlant.output > 0 && !this.network.active) {
                windNodeOuter.classList.add('alert');
            } else {
                windNodeOuter.classList.remove('alert');
            }
        }

        const solarPlant = this.plants.solar;
        const solarNodeOuter = document.querySelector('.node-group[data-node="solar"] .solar-node');
        if (solarNodeOuter) {
            if (solarPlant.active && solarPlant.output > 0 && !this.network.active) {
                solarNodeOuter.classList.add('alert');
            } else {
                solarNodeOuter.classList.remove('alert');
            }
        }
    }

    animate() {
        if (this.plants.solar.active && this.plants.solar.output > 0) {
            const variation = (Math.random() - 0.5) * 10;
            this.plants.solar.output = Math.max(0, Math.min(this.plants.solar.capacity,
                this.plants.solar.output + variation));
        }

        if (this.plants.wind.active && this.plants.wind.output > 0) {
            const variation = (Math.random() - 0.5) * 15;
            this.plants.wind.output = Math.max(0, Math.min(this.plants.wind.capacity,
                this.plants.wind.output + variation));
        }

        this.updateDisplay();
        this.updateCityTopology();

        requestAnimationFrame(() => this.animate());
    }

    // DEMO: Simulated transmission monitoring (no network calls)
    startDemoTransmissionMonitoring() {
        // In demo mode, all units stay "online"
        Object.keys(this.transmissionUnits).forEach(unitId => {
            this.updateTransmissionStatus(unitId, true);
        });

        // Update teleprotection to closed state
        this.updateTeleprotectionStatus();
    }

    updateTransmissionStatus(unitId, isAlive) {
        const node = document.querySelector(`.node-group[data-node="${unitId}"]`);
        if (!node) return;

        const unitNum = unitId.replace('transmission', '');

        if (!isAlive) {
            node.classList.add('offline');
            node.classList.remove('active');
        } else {
            node.classList.remove('offline');
        }

        this.updateCityPowerReduction();
    }

    updateCityPowerReduction() {
        const totalUnits = Object.keys(this.transmissionUnits).length;
        const offlineUnits = Object.values(this.transmissionUnits).filter(unit => !unit.alive).length;

        const reductionPercentage = (offlineUnits / totalUnits) * 100;
        const powerMultiplier = 1 - (reductionPercentage / 100);

        this.transmissionPowerMultiplier = powerMultiplier;

        const reductionDiv = document.getElementById('transmissionReduction');
        const reductionValue = document.getElementById('transmissionReductionValue');

        if (offlineUnits > 0) {
            reductionDiv.style.display = 'block';
            reductionValue.textContent = `${Math.round(reductionPercentage)}%`;
        } else {
            reductionDiv.style.display = 'none';
        }

        this.updateCityTopology();
    }

    // DEMO: Set all links to "up" state
    setDemoLinkStatus() {
        const connections = document.querySelectorAll('.router-connection');
        connections.forEach(conn => {
            conn.classList.add('link-up');
            conn.classList.remove('link-down');
        });
    }

    initializeRouterNodes() {
        const routerNodes = document.querySelectorAll('[data-router]');

        routerNodes.forEach(node => {
            const routerId = node.getAttribute('data-router');

            node.addEventListener('mouseenter', (e) => {
                this.showRouterTooltip(routerId, e);
            });

            node.addEventListener('mouseleave', () => {
                this.hideRouterTooltip();
            });

            node.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showRouterPanel(routerId);
            });
        });
    }

    showRouterTooltip(routerId, event) {
        this.hideRouterTooltip();

        const router = this.routers[routerId];
        if (!router) return;

        const tooltip = document.createElement('div');
        tooltip.className = 'router-tooltip';
        tooltip.innerHTML = `
            <div class="tooltip-header">
                <span class="router-name">${router.name}</span>
                <span class="status-badge status-connected">CONNECTED</span>
            </div>
            <div class="tooltip-body">
                <div class="metric-row">
                    <span class="metric-label">Status</span>
                    <span class="metric-value">Online (Demo)</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Interfaces</span>
                    <span class="metric-value">4 Active</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">BGP Peers</span>
                    <span class="metric-value">2 Established</span>
                </div>
            </div>
            <div class="tooltip-footer">Click for details (Demo Mode)</div>
        `;

        document.body.appendChild(tooltip);
        this.activeTooltip = tooltip;

        const rect = event.target.getBoundingClientRect();
        tooltip.style.left = `${rect.right + 10}px`;
        tooltip.style.top = `${rect.top}px`;
    }

    hideRouterTooltip() {
        if (this.activeTooltip) {
            this.activeTooltip.remove();
            this.activeTooltip = null;
        }
    }

    showRouterPanel(routerId) {
        const router = this.routers[routerId];
        if (!router) return;

        this.hideRouterPanel();

        const panel = document.createElement('div');
        panel.className = 'router-panel';
        panel.innerHTML = `
            <div class="panel-overlay" onclick="smartGrid.hideRouterPanel()"></div>
            <div class="panel-content">
                <div class="panel-header">
                    <h2>${router.name} - Router Details (Demo)</h2>
                    <button class="panel-close" onclick="smartGrid.hideRouterPanel()">×</button>
                </div>
                <div class="panel-body">
                    <div class="metrics-section">
                        <h3>System Status</h3>
                        <div class="metrics-grid">
                            <div class="metric-card">
                                <div class="metric-label">Status</div>
                                <div class="metric-value-display status-closed">CONNECTED</div>
                            </div>
                            <div class="metric-card">
                                <div class="metric-label">Uptime</div>
                                <div class="metric-value-display">${router.metrics.system.uptime}</div>
                            </div>
                            <div class="metric-card">
                                <div class="metric-label">CPU Usage</div>
                                <div class="metric-gauge normal">
                                    <div class="gauge-fill" style="width: ${router.metrics.system.cpuUsage}%"></div>
                                    <span class="gauge-value">${router.metrics.system.cpuUsage}%</span>
                                </div>
                            </div>
                            <div class="metric-card">
                                <div class="metric-label">Memory Usage</div>
                                <div class="metric-gauge normal">
                                    <div class="gauge-fill" style="width: ${router.metrics.system.memoryUsage}%"></div>
                                    <span class="gauge-value">${router.metrics.system.memoryUsage}%</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="metrics-section">
                        <h3>Interfaces</h3>
                        <table class="metrics-table">
                            <thead>
                                <tr>
                                    <th>Interface</th>
                                    <th>Status</th>
                                    <th>In Octets</th>
                                    <th>Out Octets</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${router.metrics.interfaces.map(iface => `
                                    <tr>
                                        <td>${iface.name}</td>
                                        <td><span class="status-indicator status-up">UP</span></td>
                                        <td>${iface.inOctets.toLocaleString()}</td>
                                        <td>${iface.outOctets.toLocaleString()}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>

                    <div class="metrics-section">
                        <h3>BGP Peers</h3>
                        <div class="bgp-summary">
                            <div class="bgp-stat">
                                <span class="stat-label">Total Peers</span>
                                <span class="stat-value">${router.metrics.bgp.peers.length}</span>
                            </div>
                            <div class="bgp-stat">
                                <span class="stat-label">Established</span>
                                <span class="stat-value">${router.metrics.bgp.peers.filter(p => p.state === 'established').length}</span>
                            </div>
                        </div>
                        <table class="metrics-table">
                            <thead>
                                <tr>
                                    <th>Peer Address</th>
                                    <th>State</th>
                                    <th>Received Prefixes</th>
                                    <th>Sent Prefixes</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${router.metrics.bgp.peers.map(peer => `
                                    <tr>
                                        <td>${peer.peerAddress}</td>
                                        <td><span class="status-indicator status-up">${peer.state.toUpperCase()}</span></td>
                                        <td>${peer.receivedPrefixes}</td>
                                        <td>${peer.sentPrefixes}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>

                    <div style="text-align: center; padding: 20px; color: #666; font-style: italic;">
                        This is a demo version. In production, data is retrieved via gNMI from SR Linux routers.
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);
        this.activePanel = panel;
    }

    hideRouterPanel() {
        if (this.activePanel) {
            this.activePanel.remove();
            this.activePanel = null;
        }
    }

    updateTeleprotectionStatus() {
        const dc1Reachable = this.routers.dc1 && this.routers.dc1.status === 'connected';
        const dc2Reachable = this.routers.dc2 && this.routers.dc2.status === 'connected';

        this.teleprotection.dc1Reachable = dc1Reachable;
        this.teleprotection.dc2Reachable = dc2Reachable;
        this.teleprotection.closed = dc1Reachable && dc2Reachable;

        const closedIcon = document.getElementById('teleprotection-closed');
        const openIcon = document.getElementById('teleprotection-open');
        const stateText = document.getElementById('teleprotection-state-text');
        const dc1StatusElement = document.getElementById('router-dc1-status');
        const dc2StatusElement = document.getElementById('router-dc2-status');

        if (this.teleprotection.closed) {
            if (closedIcon) closedIcon.style.display = 'block';
            if (openIcon) openIcon.style.display = 'none';
            if (stateText) {
                stateText.textContent = 'CHIUSO / CLOSED';
                stateText.classList.remove('open');
                stateText.classList.add('closed');
            }
        } else {
            if (closedIcon) closedIcon.style.display = 'none';
            if (openIcon) openIcon.style.display = 'block';
            if (stateText) {
                stateText.textContent = 'APERTO / OPEN';
                stateText.classList.remove('closed');
                stateText.classList.add('open');
            }
        }

        if (dc1StatusElement) {
            const dot = dc1StatusElement.querySelector('.status-dot');
            if (dc1Reachable) {
                dc1StatusElement.innerHTML = 'DC1: <span class="status-dot ok"></span>Raggiungibile';
            } else {
                dc1StatusElement.innerHTML = 'DC1: <span class="status-dot fault"></span>Non raggiungibile';
            }
        }

        if (dc2StatusElement) {
            if (dc2Reachable) {
                dc2StatusElement.innerHTML = 'DC2: <span class="status-dot ok"></span>Raggiungibile';
            } else {
                dc2StatusElement.innerHTML = 'DC2: <span class="status-dot fault"></span>Non raggiungibile';
            }
        }
    }
}

// Initialize the smart grid when page loads
let smartGrid;
document.addEventListener('DOMContentLoaded', () => {
    smartGrid = new SmartGrid();

    // Add demo mode banner
    const banner = document.createElement('div');
    banner.style.cssText = 'background: #4a6a5a; color: white; text-align: center; padding: 8px; font-size: 12px; position: fixed; top: 0; left: 0; right: 0; z-index: 9999;';
    banner.innerHTML = '🎮 <strong>DEMO MODE</strong> - This is a static demonstration. Backend services are simulated. | <a href="https://github.com/YOUR-USERNAME/smart-grid-nokia-dashboard" style="color: #aaffaa;">View Source</a>';
    document.body.prepend(banner);
    document.body.style.paddingTop = '32px';
});
