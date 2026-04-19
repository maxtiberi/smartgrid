// Smart Grid Simulation Controller
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

        this.transmissionUnits = {
            transmission1: {
                ip: '172.20.20.20',
                alive: true,
                lastCheck: null
            },
            transmission2: {
                ip: '172.20.20.21',
                alive: true,
                lastCheck: null
            },
            transmission3: {
                ip: '172.20.20.22',
                alive: true,
                lastCheck: null
            },
            transmission4: {
                ip: '172.20.20.23',
                alive: true,
                lastCheck: null
            }
        };

        this.routers = {
            dc1: { name: 'DC-1', status: 'unknown', metrics: null, type: 'spine', host: '172.20.20.5' },
            dc2: { name: 'DC-2', status: 'unknown', metrics: null, type: 'spine', host: '172.20.20.8' },
            leaf1: { name: 'Leaf-1', status: 'unknown', metrics: null, type: 'leaf', host: '172.20.20.4' },
            leaf2: { name: 'Leaf-2', status: 'unknown', metrics: null, type: 'leaf', host: '172.20.20.3' },
            leaf3: { name: 'Leaf-3', status: 'unknown', metrics: null, type: 'leaf', host: '172.20.20.6' },
            leaf4: { name: 'Leaf-4', status: 'unknown', metrics: null, type: 'leaf', host: '172.20.20.2' }
        };

        this.rtus = {
            rtu1: { name: 'RTU-1', status: 'unknown', host: '172.20.20.20' },
            rtu2: { name: 'RTU-2', status: 'unknown', host: '172.20.20.21' },
            rtu3: { name: 'RTU-3', status: 'unknown', host: '172.20.20.22' },
            rtu4: { name: 'RTU-4', status: 'unknown', host: '172.20.20.23' }
        };

        this.gnmiServiceUrl = 'http://localhost:3001';
        this.pingServiceUrl = 'http://localhost:3000';
        this.config = null; // Hydrated from /api/config after init().
        this.activeTooltip = null;
        this.activePanel = null;

        // Teleprotection state (T1-T2 differential protection)
        this.teleprotection = {
            closed: true, // Default state is closed
            dc1Reachable: true,
            dc2Reachable: true
        };

        this.manualOverride = false;

        // Transmission power multiplier (1.0 = 100%, 0.75 = 75%, etc.)
        // Reduced by 25% for each offline transmission unit
        this.transmissionPowerMultiplier = 1.0;

        this.init();
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

        // Initialize power slider for nuclear1
        const nuclear1Slider = document.getElementById('nuclear1-slider');
        if (nuclear1Slider) {
            nuclear1Slider.addEventListener('input', (e) => {
                this.updatePowerLevel('nuclear1', parseInt(e.target.value));
            });
        }

        // Initialize power slider for nuclear2
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

        // Start transmission units monitoring
        this.startTransmissionMonitoring();

        // Initialize router nodes event listeners
        this.initializeRouterNodes();

        // Start router monitoring
        this.startRouterMonitoring();

        // Manual override toggle
        const overrideToggle = document.getElementById('manual-override-toggle');
        if (overrideToggle) {
            overrideToggle.addEventListener('change', () => this.toggleManualOverride());
        }

        // Fault injection panel
        this.initFaultInjectionUI();

        // Fetch centralized config and overlay hardcoded defaults.
        // If the backend is down we keep the baked-in fallback — app still boots.
        this.loadConfig();
    }

    initFaultInjectionUI() {
        const kindSel = document.getElementById('fault-kind');
        const idSel   = document.getElementById('fault-id');
        if (!kindSel || !idSel) return;

        const repopulate = () => {
            const kind = kindSel.value;
            let ids = [];
            if (kind === 'router') ids = Object.keys(this.routers);
            else if (kind === 'rtu') ids = Object.keys(this.rtus);
            else if (kind === 'link') ids = Object.keys(this.config?.links || {});
            idSel.innerHTML = ids.map(id => `<option value="${id}">${id}</option>`).join('');
        };
        kindSel.addEventListener('change', repopulate);
        // Repopulate after config arrives (link list becomes known).
        setTimeout(repopulate, 500);
        setTimeout(repopulate, 2000);
        repopulate();

        document.getElementById('fault-down-btn')?.addEventListener('click', () => {
            const kind = kindSel.value;
            const id = idSel.value;
            const state = kind === 'rtu' ? 'offline' : 'down';
            this.injectFault(kind, id, state);
        });
        document.getElementById('fault-up-btn')?.addEventListener('click', () => {
            const kind = kindSel.value;
            const id = idSel.value;
            const state = kind === 'rtu' ? 'online' : 'up';
            this.injectFault(kind, id, state);
        });
        document.getElementById('fault-clear-btn')?.addEventListener('click', () => this.clearFaults());
    }

    async loadConfig() {
        try {
            const res = await fetch(`${this.gnmiServiceUrl}/api/config`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const cfg = await res.json();
            this.config = cfg;

            // Overlay router hosts from config (leaf IPs change after lab redeploy).
            for (const [id, r] of Object.entries(cfg.routers || {})) {
                if (this.routers[id]) this.routers[id].host = r.host;
            }
            for (const [id, r] of Object.entries(cfg.rtus || {})) {
                if (this.rtus[id]) this.rtus[id].host = r.host;
            }
            if (cfg.grid?.cityDemandMW) this.city.demand = cfg.grid.cityDemandMW;
            // Keep transmission-unit IP slots aligned with RTU IPs (used for ping-based monitoring).
            const rtuHosts = Object.values(cfg.rtus || {}).map(r => r.host);
            ['transmission1','transmission2','transmission3','transmission4'].forEach((k, i) => {
                if (this.transmissionUnits[k] && rtuHosts[i]) this.transmissionUnits[k].ip = rtuHosts[i];
            });
            console.log('[SmartGrid] Config loaded from /api/config');
        } catch (err) {
            console.warn('[SmartGrid] /api/config unavailable, using built-in defaults:', err.message);
        }
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

            // Update topology
            this.updateTopology(plantId, true);

            // Ramp up power over time
            this.rampPower(plantId, true);
        } else {
            // Ramp down power
            this.rampPower(plantId, false);

            // For nuclear plants, reset slider to 0 when stopped
            if (plantId === 'nuclear1' || plantId === 'nuclear2') {
                const slider = document.getElementById(`${plantId}-slider`);
                if (slider) {
                    slider.value = 0;
                }

                // Update percentage display
                const percentageDisplay = card.querySelector('.power-percentage');
                if (percentageDisplay) {
                    percentageDisplay.textContent = '0%';
                }

                // Reset all indicator circles
                const indicators = card.querySelectorAll('.indicator-circle');
                indicators.forEach(circle => {
                    circle.classList.remove('active');
                });
            }

            // Update topology
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

            // Update topology
            this.updateTopology('distribution', true);
        } else {
            card.classList.remove('active');
            btn.classList.remove('active');
            btn.querySelector('.btn-text').textContent = 'start';
            statusText.textContent = 'offline';

            // Update topology
            this.updateTopology('distribution', false);
        }

        this.updateDisplay();
    }

    toggleManualOverride() {
        const toggle = document.getElementById('manual-override-toggle');
        this.manualOverride = toggle && toggle.checked;

        const statusEl = document.getElementById('override-status');
        const warningEl = document.getElementById('override-warning');

        if (this.manualOverride) {
            // Force all routers to connected
            Object.keys(this.routers).forEach(routerId => {
                this.routers[routerId].status = 'connected';
                this.updateRouterVisualization(routerId, { status: 'connected' });
            });

            // Force all RTUs to online
            Object.keys(this.rtus).forEach(rtuId => {
                this.rtus[rtuId].status = 'online';
                this.updateRtuVisualization(rtuId, { status: 'online' });
            });

            // Force all links to up
            document.querySelectorAll('.router-connection[data-link]').forEach(connection => {
                connection.classList.remove('link-down');
                connection.classList.add('link-up');
            });

            // Force distribution network online
            this._networkStateBeforeOverride = this.network.active;
            if (!this.network.active) {
                this.network.active = true;
                const card = document.querySelector('[data-network="distribution"]');
                if (card) {
                    const btn = card.querySelector('.toggle-btn');
                    const st = card.querySelector('.status-text');
                    card.classList.add('active');
                    if (btn) btn.classList.add('active');
                    if (btn) btn.querySelector('.btn-text').textContent = 'stop';
                    if (st) st.textContent = 'online';
                    this.updateTopology('distribution', true);
                }
            }

            // Force all transmission units alive and hide loss banner
            this._transmissionUnitsBeforeOverride = {};
            Object.keys(this.transmissionUnits).forEach(unitId => {
                this._transmissionUnitsBeforeOverride[unitId] = this.transmissionUnits[unitId].alive;
                this.transmissionUnits[unitId].alive = true;
                this.updateTransmissionStatus(unitId, true);
            });
            this._transmissionMultiplierBeforeOverride = this.transmissionPowerMultiplier;
            this.transmissionPowerMultiplier = 1.0;
            const reductionDiv = document.getElementById('transmissionReduction');
            if (reductionDiv) reductionDiv.style.display = 'none';

            // Refresh city power display
            this.updateDisplay();

            // Update teleprotection as all-up
            this.updateTeleprotectionStatus();
            const allUpLinks = {};
            document.querySelectorAll('.router-connection[data-link]').forEach(el => {
                allUpLinks[el.dataset.link] = 'up';
            });
            this.updateTeleprotectionFromLinks(allUpLinks);

            // Update stats
            this.updateInfographicStats();

            // Add orange dashed outline to all router/RTU nodes
            document.querySelectorAll('.router-node').forEach(node => {
                node.classList.add('manual-override');
            });

            // Show warning and update status text
            if (statusEl) {
                statusEl.textContent = 'Active';
                statusEl.className = 'override-status active';
            }
            if (warningEl) warningEl.classList.add('visible');

        } else {
            // Restore distribution network to its previous state
            if (this._networkStateBeforeOverride === false) {
                this.network.active = false;
                const card = document.querySelector('[data-network="distribution"]');
                if (card) {
                    const btn = card.querySelector('.toggle-btn');
                    const st = card.querySelector('.status-text');
                    card.classList.remove('active');
                    if (btn) btn.classList.remove('active');
                    if (btn) btn.querySelector('.btn-text').textContent = 'start';
                    if (st) st.textContent = 'offline';
                    this.updateTopology('distribution', false);
                }
            }

            // Restore transmission units and multiplier
            if (this._transmissionUnitsBeforeOverride) {
                Object.keys(this._transmissionUnitsBeforeOverride).forEach(unitId => {
                    this.transmissionUnits[unitId].alive = this._transmissionUnitsBeforeOverride[unitId];
                    this.updateTransmissionStatus(unitId, this.transmissionUnits[unitId].alive);
                });
            }
            if (this._transmissionMultiplierBeforeOverride !== undefined) {
                this.transmissionPowerMultiplier = this._transmissionMultiplierBeforeOverride;
            }
            this.updateCityPowerReduction();

            this.updateDisplay();

            // Remove override styling
            document.querySelectorAll('.router-node').forEach(node => {
                node.classList.remove('manual-override');
            });

            if (statusEl) {
                statusEl.textContent = 'Inactive';
                statusEl.className = 'override-status inactive';
            }
            if (warningEl) warningEl.classList.remove('visible');

            // Re-poll real status immediately
            this.checkAllRouters();
            this.checkAllLinks();
        }
    }

    updatePowerLevel(plantId, percentage) {
        const plant = this.plants[plantId];
        if (!plant) return;

        // Update the target output based on percentage
        const targetOutput = (percentage / 100) * plant.capacity;

        // If plant is active, ramp to the new target
        if (plant.active) {
            const step = plant.rampRate;
            const ramp = () => {
                if (plant.output < targetOutput) {
                    plant.output = Math.min(plant.output + step, targetOutput);
                    this.updateDisplay();
                    if (plant.output < targetOutput) {
                        requestAnimationFrame(ramp);
                    }
                } else if (plant.output > targetOutput) {
                    plant.output = Math.max(plant.output - step, targetOutput);
                    this.updateDisplay();
                    if (plant.output > targetOutput) {
                        requestAnimationFrame(ramp);
                    }
                }
            };
            ramp();
        }

        // Update percentage display
        const card = document.querySelector(`[data-plant="${plantId}"]`);
        if (card) {
            const percentageDisplay = card.querySelector('.power-percentage');
            if (percentageDisplay) {
                percentageDisplay.textContent = percentage + '%';
            }

            // Update indicator circles
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

        // For nuclear plants, use slider value to determine target
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

        // Update total output
        document.getElementById('totalOutput').textContent = Math.round(totalOutput);

        // Update grid status
        const gridStatus = document.getElementById('gridStatus');
        if (this.network.active && totalOutput > 0) {
            gridStatus.textContent = 'online';
        } else {
            gridStatus.textContent = 'offline';
        }

        // Update individual plant outputs
        Object.keys(this.plants).forEach(plantId => {
            const plant = this.plants[plantId];
            const card = document.querySelector(`[data-plant="${plantId}"]`);
            if (card) {
                const outputValue = card.querySelector('.output-value');
                outputValue.textContent = Math.round(plant.output);
            }
        });

        // Calculate city power
        let cityPower = 0;
        if (this.network.active) {
            cityPower = totalOutput * this.network.efficiency;

            // Apply transmission units reduction (25% per offline unit)
            cityPower = cityPower * this.transmissionPowerMultiplier;
        }

        this.city.receiving = cityPower;

        // Update city display
        const cityPowerDisplay = document.getElementById('cityPower');
        cityPowerDisplay.textContent = Math.round(cityPower);

        const cityCard = document.querySelector('.city-card');

        // Remove all power state classes
        cityCard.classList.remove('power-none', 'power-low', 'power-high', 'powered');

        // Add appropriate class based on power level
        if (cityPower === 0) {
            cityCard.classList.add('power-none');
        } else if (cityPower < 2200) {
            cityCard.classList.add('power-low');
        } else {
            cityCard.classList.add('power-high');
        }

        // Keep legacy powered class for full demand
        if (cityPower >= this.city.demand) {
            cityCard.classList.add('powered');
        }

        // Update plant animations (turbines, wind blades)
        this.updatePlantAnimations();
    }

    updateTopology(nodeId, isActive) {
        // Update node in topology
        const node = document.querySelector(`.node-group[data-node="${nodeId}"]`);
        if (node) {
            if (isActive) {
                node.classList.add('active');
            } else {
                node.classList.remove('active');
            }
        }

        // Update connections
        const connection = document.querySelector(`.connection[data-source="${nodeId}"]`);
        if (connection) {
            if (isActive) {
                connection.classList.add('active');
            } else {
                connection.classList.remove('active');
            }
        }

        // Update energy particles
        const particles = document.querySelectorAll(`.particle-${nodeId}`);
        particles.forEach(particle => {
            if (isActive) {
                particle.classList.add('active');
            } else {
                particle.classList.remove('active');
            }
        });

        // If distribution is active/inactive, update transmission units
        if (nodeId === 'distribution') {
            const transmissionLines = document.querySelectorAll('.transmission-line');
            transmissionLines.forEach(line => {
                if (isActive) {
                    line.classList.add('active');
                } else {
                    line.classList.remove('active');
                }
            });

            // Update transmission nodes
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

            // Update transmission particles
            const transParticles = document.querySelectorAll('.particle-distribution, .particle-transmission');
            transParticles.forEach(particle => {
                if (isActive) {
                    particle.classList.add('active');
                } else {
                    particle.classList.remove('active');
                }
            });
        }

        // Update city node based on power status
        this.updateCityTopology();
    }

    updateCityTopology() {
        const cityNode = document.querySelector('.node-group[data-node="city"]');
        if (!cityNode) return;

        const totalOutput = this.getTotalOutput();
        let cityPower = this.network.active ? totalOutput * this.network.efficiency : 0;

        // Apply transmission units reduction (25% per offline unit)
        cityPower = cityPower * this.transmissionPowerMultiplier;

        if (cityPower >= this.city.demand) {
            cityNode.classList.add('active');
        } else {
            cityNode.classList.remove('active');
        }
    }

    updatePlantAnimations() {
        // Update nuclear plant turbines
        ['nuclear1', 'nuclear2'].forEach(plantId => {
            const plant = this.plants[plantId];
            const turbine = document.getElementById(`${plantId}-turbine`);
            const nodeOuter = document.querySelector(`.node-group[data-node="${plantId}"] .nuclear-node`);

            if (!turbine || !nodeOuter) return;

            // Rotate turbine if plant is active
            if (plant.active && plant.output > 0) {
                turbine.classList.add('rotating');
            } else {
                turbine.classList.remove('rotating');
            }

            // Add red alert animation if plant is active but grid is offline
            if (plant.active && plant.output > 0 && !this.network.active) {
                nodeOuter.classList.add('alert');
            } else {
                nodeOuter.classList.remove('alert');
            }
        });

        // Update wind node alert (no blade rotation animation)
        const windPlant = this.plants.wind;
        const windNodeOuter = document.querySelector('.node-group[data-node="wind"] .wind-node');

        if (windNodeOuter) {
            // Add red alert animation if plant is active but grid is offline
            if (windPlant.active && windPlant.output > 0 && !this.network.active) {
                windNodeOuter.classList.add('alert');
            } else {
                windNodeOuter.classList.remove('alert');
            }
        }

        // Solar panel could have animation here if needed (no moving parts currently)
        const solarPlant = this.plants.solar;
        const solarNodeOuter = document.querySelector('.node-group[data-node="solar"] .solar-node');

        if (solarNodeOuter) {
            // Add red alert animation if plant is active but grid is offline
            if (solarPlant.active && solarPlant.output > 0 && !this.network.active) {
                solarNodeOuter.classList.add('alert');
            } else {
                solarNodeOuter.classList.remove('alert');
            }
        }
    }

    animate() {
        // Slight variations in solar and wind output to simulate real conditions
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

    startTransmissionMonitoring() {
        // Check all transmission units status every 10 seconds
        this.checkTransmissionUnit('transmission1');
        this.checkTransmissionUnit('transmission2');
        this.checkTransmissionUnit('transmission3');
        this.checkTransmissionUnit('transmission4');

        setInterval(() => {
            this.checkTransmissionUnit('transmission1');
            this.checkTransmissionUnit('transmission2');
            this.checkTransmissionUnit('transmission3');
            this.checkTransmissionUnit('transmission4');
        }, 10000);
    }

    async checkTransmissionUnit(unitId) {
        if (this.manualOverride) return;
        const unit = this.transmissionUnits[unitId];
        if (!unit) return;

        try {
            // Call the ping service to check if host is reachable
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const response = await fetch(`http://localhost:3001/api/ping?ip=${unit.ip}`, {
                method: 'GET',
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error('Ping service error');
            }

            const result = await response.json();

            // Update status based on ping result
            const wasDown = !unit.alive;
            unit.alive = result.alive;
            unit.lastCheck = new Date();

            if (result.alive && wasDown) {
                // Host came back online
                this.clearTransmissionAlert(unitId);
                this.updateTransmissionStatus(unitId, true);
            } else if (!result.alive && unit.alive !== false) {
                // Host went offline
                this.showTransmissionAlert(unitId);
                this.updateTransmissionStatus(unitId, false);
            } else if (result.alive) {
                // Host still online
                this.updateTransmissionStatus(unitId, true);
            } else {
                // Host still offline
                this.updateTransmissionStatus(unitId, false);
            }

        } catch (error) {
            // Ping service unavailable or error
            console.error(`Error checking ${unitId}:`, error);

            // Mark as offline if we can't check
            const wasAlive = unit.alive;
            unit.alive = false;
            unit.lastCheck = new Date();

            if (wasAlive) {
                this.showTransmissionAlert(unitId);
            }

            this.updateTransmissionStatus(unitId, false);
        }
    }

    showTransmissionAlert(unitId) {
        const unit = this.transmissionUnits[unitId];
        const unitName = unitId.replace('transmission', 'T');

        // Remove existing alert if present
        const existingAlert = document.getElementById(`alert-${unitId}`);
        if (existingAlert) existingAlert.remove();

        // Create alert element
        const alertDiv = document.createElement('div');
        alertDiv.id = `alert-${unitId}`;
        alertDiv.className = 'transmission-alert';
        alertDiv.innerHTML = `
            <div class="alert-content">
                <span class="alert-icon">⚠</span>
                <div class="alert-text">
                    <strong>Transmission Unit ${unitName} Offline</strong>
                    <span>IP: ${unit.ip} - Connection failed</span>
                </div>
                <button class="alert-close" onclick="this.parentElement.parentElement.remove()">×</button>
            </div>
        `;

        document.body.appendChild(alertDiv);

        // Auto-remove after 30 seconds if not manually closed
        setTimeout(() => {
            const alert = document.getElementById(`alert-${unitId}`);
            if (alert) alert.remove();
        }, 30000);
    }

    clearTransmissionAlert(unitId) {
        const alertDiv = document.getElementById(`alert-${unitId}`);
        if (alertDiv) {
            alertDiv.remove();
        }

        const unitName = unitId.replace('transmission', 'T');

        // Show recovery notification
        const recoveryDiv = document.createElement('div');
        recoveryDiv.className = 'transmission-alert recovery';
        recoveryDiv.innerHTML = `
            <div class="alert-content">
                <span class="alert-icon">✓</span>
                <div class="alert-text">
                    <strong>Transmission Unit ${unitName} Online</strong>
                    <span>Connection restored</span>
                </div>
                <button class="alert-close" onclick="this.parentElement.parentElement.remove()">×</button>
            </div>
        `;

        document.body.appendChild(recoveryDiv);

        setTimeout(() => recoveryDiv.remove(), 10000);
    }

    updateTransmissionStatus(unitId, isAlive) {
        const node = document.querySelector(`.node-group[data-node="${unitId}"]`);
        if (!node) return;

        const unitNum = unitId.replace('transmission', '');

        if (!isAlive) {
            node.classList.add('offline');
            node.classList.remove('active');

            // Update connection lines
            const connFromDist = document.getElementById(`conn-dist-trans${unitNum}`);
            const connToCity = document.getElementById(`conn-trans${unitNum}-city`);

            if (connFromDist) connFromDist.classList.add('offline');
            if (connToCity) connToCity.classList.add('offline');
        } else {
            node.classList.remove('offline');

            // Restore connection lines if distribution is active
            if (this.network.active) {
                const connFromDist = document.getElementById(`conn-dist-trans${unitNum}`);
                const connToCity = document.getElementById(`conn-trans${unitNum}-city`);

                if (connFromDist) connFromDist.classList.remove('offline');
                if (connToCity) connToCity.classList.remove('offline');
            }
        }

        // Recalculate city power based on transmission units status
        this.updateCityPowerReduction();
    }

    updateCityPowerReduction() {
        // Count how many transmission units are offline
        const totalUnits = Object.keys(this.transmissionUnits).length;
        const offlineUnits = Object.values(this.transmissionUnits).filter(unit => !unit.alive).length;

        // Each offline unit reduces power by 25%
        const reductionPercentage = (offlineUnits / totalUnits) * 100;
        const powerMultiplier = 1 - (reductionPercentage / 100);

        // Store the multiplier for use in city power calculation
        this.transmissionPowerMultiplier = powerMultiplier;

        // Update the transmission reduction indicator
        const reductionDiv = document.getElementById('transmissionReduction');
        const reductionValue = document.getElementById('transmissionReductionValue');

        if (offlineUnits > 0) {
            reductionDiv.style.display = 'block';
            reductionValue.textContent = `${Math.round(reductionPercentage)}%`;
        } else {
            reductionDiv.style.display = 'none';
        }

        // Update the display
        this.updateCityTopology();
    }

    // ===== ROUTER MONITORING METHODS =====

    initializeRouterNodes() {
        // Attach event listeners to all router nodes
        const routerNodes = document.querySelectorAll('[data-router]');

        routerNodes.forEach(node => {
            const routerId = node.getAttribute('data-router');

            // Hover to show tooltip
            node.addEventListener('mouseenter', (e) => {
                this.showRouterTooltip(routerId, e);
            });

            node.addEventListener('mouseleave', () => {
                this.hideRouterTooltip();
            });

            // Click to show detail panel
            node.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showRouterPanel(routerId);
            });
        });
    }

    startRouterMonitoring() {
        // Prefer Server-Sent Events for real-time updates; fall back to polling.
        this.startEventStream();

        // Initial fetch so UI has data even before first SSE snapshot arrives.
        this.checkAllRouters();
        this.checkAllLinks();

        // Safety-net poll at 30s (was 10s) — SSE is authoritative when connected.
        setInterval(() => {
            if (!this._sseConnected) {
                this.checkAllRouters();
                this.checkAllLinks();
            }
        }, 30000);
    }

    startEventStream() {
        try {
            const es = new EventSource(`${this.gnmiServiceUrl}/api/events`);
            this._sseConnected = false;

            es.addEventListener('snapshot', (e) => {
                this._sseConnected = true;
                try { this.applySnapshot(JSON.parse(e.data)); } catch (err) { console.warn('snapshot parse', err); }
            });
            es.addEventListener('event', (e) => {
                try { this.appendTimelineEvent(JSON.parse(e.data)); } catch (err) {}
            });
            es.onerror = () => {
                this._sseConnected = false;
                // EventSource auto-reconnects; no manual retry needed.
            };
            this._eventSource = es;
        } catch (err) {
            console.warn('[SmartGrid] SSE unavailable, using polling fallback:', err.message);
        }
    }

    applySnapshot(snap) {
        if (this.manualOverride) return;
        // Routers
        if (snap.routers) {
            for (const [id, r] of Object.entries(snap.routers)) {
                if (this.routers[id]) {
                    this.routers[id].status = r.status;
                    this.routers[id].lastUpdate = r.lastUpdate;
                    this.updateRouterVisualization(id, r);
                }
            }
        }
        // RTUs
        if (snap.rtus) {
            for (const [id, r] of Object.entries(snap.rtus)) {
                if (this.rtus[id]) {
                    this.rtus[id].status = r.status;
                    this.updateRtuVisualization?.(id, r);
                }
            }
        }
        // Links — reuse existing rendering path.
        if (snap.links) this.renderLinkStates?.(snap.links) || this._applyLinkStates(snap.links);
        // Teleprotection FSM state
        if (snap.teleprotection) this.applyTeleprotectionFsm(snap.teleprotection);
        this.updateInfographicStats();
    }

    _applyLinkStates(links) {
        // Fallback renderer: toggle .link-up/.link-down on [data-link] elements.
        Object.entries(links).forEach(([linkId, info]) => {
            document.querySelectorAll(`[data-link="${linkId}"]`).forEach(el => {
                el.classList.toggle('link-up', info.status === 'up');
                el.classList.toggle('link-down', info.status !== 'up');
                el.classList.toggle('link-faulted', !!info.faulted);
            });
        });
        // Defer breaker/teleprotection derivation to backend FSM (applyTeleprotectionFsm).
    }

    applyTeleprotectionFsm(tp) {
        // Mirror backend FSM into existing visual indicators. Visual rule:
        // ARMED → closed/green; PICKUP → warning; TRIP → open/red.
        const breakerState = tp.state === 'TRIP' ? 'open' : 'closed';
        this.teleprotection.closed = breakerState === 'closed';
        this.teleprotection.fsm = tp;
        // Reuse existing rendering if available.
        if (typeof this.updateTeleprotectionVisual === 'function') {
            this.updateTeleprotectionVisual(breakerState, tp);
        } else {
            document.querySelectorAll('[data-teleprotection-state]').forEach(el => {
                el.setAttribute('data-teleprotection-state', tp.state.toLowerCase());
            });
        }
    }

    appendTimelineEvent(entry) {
        const list = document.getElementById('event-timeline-list');
        if (!list) return;
        const li = document.createElement('li');
        li.className = `timeline-entry kind-${entry.kind}`;
        const ts = new Date(entry.ts).toLocaleTimeString();
        let desc = '';
        switch (entry.kind) {
            case 'teleprotection': desc = `Teleprotezione: ${entry.from} → ${entry.to} (${entry.reason})`; break;
            case 'router-status':  desc = `Router ${entry.id}: ${entry.from} → ${entry.to}`; break;
            case 'rtu-status':     desc = `RTU ${entry.id}: ${entry.from} → ${entry.to}`; break;
            case 'fault-inject':   desc = `Fault inject: ${entry.kind || ''} ${entry.id} = ${entry.state}`; break;
            case 'fault-clear':    desc = 'Fault overrides cleared'; break;
            default: desc = entry.kind;
        }
        li.innerHTML = `<span class="ts">${ts}</span> <span class="desc">${desc}</span>`;
        list.insertBefore(li, list.firstChild);
        // Cap visible list to 50 entries.
        while (list.children.length > 50) list.removeChild(list.lastChild);
    }

    async injectFault(kind, id, state) {
        try {
            const res = await fetch(`${this.gnmiServiceUrl}/api/fault`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind, id, state })
            });
            if (!res.ok) console.warn('[SmartGrid] fault inject failed', await res.text());
        } catch (err) {
            console.warn('[SmartGrid] fault inject error', err);
        }
    }

    async clearFaults() {
        try {
            await fetch(`${this.gnmiServiceUrl}/api/fault`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clear: true })
            });
        } catch (err) { console.warn(err); }
    }

    async checkAllRouters() {
        if (this.manualOverride) return;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const response = await fetch(`${this.gnmiServiceUrl}/api/routers`, {
                method: 'GET',
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error('gNMI service unavailable');
            }

            const data = await response.json();

            // Update router statuses
            Object.keys(data.routers).forEach(routerId => {
                const routerData = data.routers[routerId];
                if (this.routers[routerId]) {
                    this.routers[routerId].status = routerData.status;
                    this.routers[routerId].lastUpdate = routerData.lastUpdate;
                    this.updateRouterVisualization(routerId, routerData);
                }
            });

            // Update teleprotection status based on DC1 and DC2 reachability
            this.updateTeleprotectionStatus();

            // Check RTUs and update statistics
            await this.checkAllRtus();
            this.updateInfographicStats();

        } catch (error) {
            console.error('Error checking routers:', error);

            // Mark all routers as unknown if service unavailable
            Object.keys(this.routers).forEach(routerId => {
                this.routers[routerId].status = 'unknown';
                this.updateRouterVisualization(routerId, { status: 'unknown' });
            });

            // Update teleprotection status (will be open if routers unreachable)
            this.updateTeleprotectionStatus();
            this.updateInfographicStats();
        }
    }

    async checkAllRtus() {
        if (this.manualOverride) return;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const response = await fetch(`${this.gnmiServiceUrl}/api/rtus`, {
                method: 'GET',
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error('RTU service unavailable');
            }

            const data = await response.json();

            // Update RTU statuses
            Object.keys(data.rtus).forEach(rtuId => {
                const rtuData = data.rtus[rtuId];
                if (this.rtus[rtuId]) {
                    this.rtus[rtuId].status = rtuData.status;
                    this.rtus[rtuId].lastCheck = rtuData.lastCheck;
                    this.updateRtuVisualization(rtuId, rtuData);
                }
            });

        } catch (error) {
            console.error('Error checking RTUs:', error);
            // Mark all RTUs as unknown if service unavailable
            Object.keys(this.rtus).forEach(rtuId => {
                this.rtus[rtuId].status = 'unknown';
                this.updateRtuVisualization(rtuId, { status: 'unknown' });
            });
        }
    }

    updateRtuVisualization(rtuId, statusData) {
        const node = document.querySelector(`[data-router="${rtuId}"]`);
        if (!node) {
            console.warn(`RTU node not found: ${rtuId}`);
            return;
        }

        const status = statusData.status || 'unknown';
        console.log(`Updating RTU ${rtuId} to status: ${status}`);

        // Update node class for visual styling
        node.classList.remove('rtu-online', 'rtu-offline', 'rtu-unknown');
        node.classList.add(`rtu-${status}`);

        // Update LED colors
        const leds = node.querySelectorAll('.rtu-led');
        console.log(`Found ${leds.length} LEDs for ${rtuId}`);
        leds.forEach(led => {
            led.classList.remove('led-online', 'led-offline', 'led-unknown');
            led.classList.add(`led-${status}`);
        });
    }

    updateInfographicStats() {
        // Count active routers
        const totalRouters = Object.keys(this.routers).length;
        let activeRouters = 0;
        Object.values(this.routers).forEach(router => {
            if (router.status === 'connected' || router.status === 'online') {
                activeRouters++;
            }
        });

        // Count active RTUs
        const totalRtus = Object.keys(this.rtus).length;
        let activeRtus = 0;
        Object.values(this.rtus).forEach(rtu => {
            if (rtu.status === 'online') {
                activeRtus++;
            }
        });

        // Calculate percentages
        const routersPercentage = totalRouters > 0 ? Math.round((activeRouters / totalRouters) * 100) : 0;
        const rtusPercentage = totalRtus > 0 ? Math.round((activeRtus / totalRtus) * 100) : 0;
        const totalDevices = totalRouters + totalRtus;
        const activeDevices = activeRouters + activeRtus;
        const overallPercentage = totalDevices > 0 ? Math.round((activeDevices / totalDevices) * 100) : 0;

        // Update ring values
        const activeRoutersEl = document.getElementById('active-routers');
        const totalRoutersEl = document.getElementById('total-routers');
        const activeRtusEl = document.getElementById('active-rtus');
        const totalRtusEl = document.getElementById('total-rtus');
        const activeDevicesEl = document.getElementById('active-devices');
        const totalDevicesEl = document.getElementById('total-devices');

        if (activeRoutersEl) activeRoutersEl.textContent = activeRouters;
        if (totalRoutersEl) totalRoutersEl.textContent = totalRouters;
        if (activeRtusEl) activeRtusEl.textContent = activeRtus;
        if (totalRtusEl) totalRtusEl.textContent = totalRtus;
        if (activeDevicesEl) activeDevicesEl.textContent = activeDevices;
        if (totalDevicesEl) totalDevicesEl.textContent = totalDevices;

        // Update rings with gradient colors
        this.updateRing('routers-ring', routersPercentage);
        this.updateRing('rtus-ring', rtusPercentage);
        this.updateRing('overall-ring', overallPercentage);

        // Update status text
        const routersStatusText = document.getElementById('routers-status-text');
        const rtusStatusText = document.getElementById('rtus-status-text');
        const overallStatusText = document.getElementById('overall-status-text');

        if (routersStatusText) {
            routersStatusText.textContent = this.getStatusText(routersPercentage);
            routersStatusText.className = `stats-sublabel ${this.getPercentageClass(routersPercentage)}`;
        }
        if (rtusStatusText) {
            rtusStatusText.textContent = this.getStatusText(rtusPercentage);
            rtusStatusText.className = `stats-sublabel ${this.getPercentageClass(rtusPercentage)}`;
        }
        if (overallStatusText) {
            overallStatusText.textContent = this.getStatusText(overallPercentage);
            overallStatusText.className = `stats-sublabel ${this.getPercentageClass(overallPercentage)}`;
        }
    }

    updateRing(ringId, percentage) {
        const ring = document.getElementById(ringId);
        if (!ring) return;

        // Calculate circumference (2 * PI * r where r = 15.9)
        const circumference = 2 * Math.PI * 15.9;
        const dashArray = (percentage / 100) * circumference;

        // Set stroke-dasharray
        ring.setAttribute('stroke-dasharray', `${dashArray} ${circumference}`);

        // Set color based on percentage (gradient from red to green)
        const color = this.getGradientColor(percentage);
        ring.setAttribute('stroke', color);
    }

    getGradientColor(percentage) {
        // Red (0%) -> Orange (25%) -> Yellow (50%) -> Light Green (75%) -> Green (100%)
        if (percentage === 0) {
            return '#dc3545'; // Red
        } else if (percentage <= 25) {
            // Red to Orange
            const ratio = percentage / 25;
            return this.interpolateColor('#dc3545', '#fd7e14', ratio);
        } else if (percentage <= 50) {
            // Orange to Yellow
            const ratio = (percentage - 25) / 25;
            return this.interpolateColor('#fd7e14', '#ffc107', ratio);
        } else if (percentage <= 75) {
            // Yellow to Light Green
            const ratio = (percentage - 50) / 25;
            return this.interpolateColor('#ffc107', '#20c997', ratio);
        } else {
            // Light Green to Green
            const ratio = (percentage - 75) / 25;
            return this.interpolateColor('#20c997', '#28a745', ratio);
        }
    }

    interpolateColor(color1, color2, ratio) {
        // Parse hex colors
        const r1 = parseInt(color1.slice(1, 3), 16);
        const g1 = parseInt(color1.slice(3, 5), 16);
        const b1 = parseInt(color1.slice(5, 7), 16);
        const r2 = parseInt(color2.slice(1, 3), 16);
        const g2 = parseInt(color2.slice(3, 5), 16);
        const b2 = parseInt(color2.slice(5, 7), 16);

        // Interpolate
        const r = Math.round(r1 + (r2 - r1) * ratio);
        const g = Math.round(g1 + (g2 - g1) * ratio);
        const b = Math.round(b1 + (b2 - b1) * ratio);

        // Return hex
        return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    }

    getStatusText(percentage) {
        if (percentage === 100) return 'All Online';
        if (percentage >= 75) return 'Mostly Online';
        if (percentage >= 50) return 'Degraded';
        if (percentage > 0) return 'Critical';
        return 'Offline';
    }

    getPercentageClass(percentage) {
        if (percentage >= 75) return 'status-good';
        if (percentage >= 50) return 'status-warning';
        return 'status-critical';
    }

    updateTeleprotectionStatus() {
        // Check DC1 and DC2 reachability
        const dc1Reachable = this.routers.dc1 && (this.routers.dc1.status === 'connected' || this.routers.dc1.status === 'online');
        const dc2Reachable = this.routers.dc2 && (this.routers.dc2.status === 'connected' || this.routers.dc2.status === 'online');

        // Update teleprotection state
        this.teleprotection.dc1Reachable = dc1Reachable;
        this.teleprotection.dc2Reachable = dc2Reachable;
        this.teleprotection.closed = dc1Reachable && dc2Reachable;

        // Update DOM elements
        const closedIcon = document.getElementById('teleprotection-closed');
        const openIcon = document.getElementById('teleprotection-open');
        const stateText = document.getElementById('teleprotection-state-text');
        const dc1StatusElement = document.getElementById('router-dc1-status');
        const dc2StatusElement = document.getElementById('router-dc2-status');

        if (!closedIcon || !openIcon || !stateText || !dc1StatusElement || !dc2StatusElement) {
            return; // Elements not found
        }

        // Update teleprotection icon and state text
        if (this.teleprotection.closed) {
            // Show closed icon
            closedIcon.style.display = 'block';
            openIcon.style.display = 'none';
            stateText.textContent = 'CHIUSO / CLOSED';
            stateText.className = 'teleprotection-state closed';
        } else {
            // Show open icon
            closedIcon.style.display = 'none';
            openIcon.style.display = 'block';
            stateText.textContent = 'APERTO / OPEN';
            stateText.className = 'teleprotection-state open';
        }

        // Update DC1 status indicator
        if (dc1Reachable) {
            dc1StatusElement.innerHTML = 'DC1: <span class="status-dot ok"></span>Raggiungibile / Reachable';
        } else {
            dc1StatusElement.innerHTML = 'DC1: <span class="status-dot fault"></span>Non raggiungibile / Unreachable';
        }

        // Update DC2 status indicator
        if (dc2Reachable) {
            dc2StatusElement.innerHTML = 'DC2: <span class="status-dot ok"></span>Raggiungibile / Reachable';
        } else {
            dc2StatusElement.innerHTML = 'DC2: <span class="status-dot fault"></span>Non raggiungibile / Unreachable';
        }
    }

    async fetchRouterMetrics(routerId) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const [interfacesRes, systemRes, bgpRes] = await Promise.all([
                fetch(`${this.gnmiServiceUrl}/api/routers/${routerId}/interfaces`, { signal: controller.signal }),
                fetch(`${this.gnmiServiceUrl}/api/routers/${routerId}/system`, { signal: controller.signal }),
                fetch(`${this.gnmiServiceUrl}/api/routers/${routerId}/bgp`, { signal: controller.signal })
            ]);

            clearTimeout(timeoutId);

            const interfaces = interfacesRes.ok ? await interfacesRes.json() : { interfaces: [] };
            const system = systemRes.ok ? await systemRes.json() : { cpu: {}, memory: {} };
            const bgp = bgpRes.ok ? await bgpRes.json() : { totalPeers: 0, activePeers: 0, neighbors: [] };

            return {
                interfaces: interfaces.interfaces || [],
                system: system,
                bgp: bgp
            };

        } catch (error) {
            console.error(`Error fetching metrics for ${routerId}:`, error);
            return null;
        }
    }

    updateRouterVisualization(routerId, statusData) {
        const node = document.querySelector(`[data-router="${routerId}"]`);
        if (!node) return;

        // Remove all status classes
        node.classList.remove('router-connected', 'router-disconnected', 'router-stale', 'router-unknown');

        // Add appropriate class based on status
        const status = statusData.status || 'unknown';
        node.classList.add(`router-${status}`);
    }

    showRouterTooltip(routerId, event) {
        // Remove existing tooltip
        this.hideRouterTooltip();

        const router = this.routers[routerId];
        if (!router) return;

        // Fetch metrics asynchronously
        this.fetchRouterMetrics(routerId).then(metrics => {
            if (!metrics) {
                this.renderTooltip(routerId, router, null, event);
                return;
            }

            router.metrics = metrics;
            this.renderTooltip(routerId, router, metrics, event);
        });

        // Show loading tooltip immediately
        this.renderTooltip(routerId, router, null, event);
    }

    renderTooltip(routerId, router, metrics, event) {
        // Remove old tooltip if exists
        if (this.activeTooltip) {
            this.activeTooltip.remove();
        }

        const tooltip = document.createElement('div');
        tooltip.className = 'router-tooltip';

        // Position tooltip near cursor
        tooltip.style.left = (event.pageX + 15) + 'px';
        tooltip.style.top = (event.pageY + 15) + 'px';

        let content = `
            <div class="tooltip-header">
                <span class="router-name">${router.name}</span>
                <span class="status-badge status-${router.status}">${router.status}</span>
            </div>
        `;

        if (!metrics) {
            content += '<div class="tooltip-body"><p class="loading-text">Loading metrics...</p></div>';
        } else {
            // Calculate summary metrics
            const interfaceCount = metrics.interfaces.length;
            const interfacesUp = metrics.interfaces.filter(iface => iface.operState === 'up').length;
            const interfacesDown = interfaceCount - interfacesUp;

            const cpuUsage = metrics.system.cpu?.total || 0;
            const memUsage = metrics.system.memory?.utilization || 0;

            const bgpPeersActive = metrics.bgp.activePeers || 0;
            const bgpPeersTotal = metrics.bgp.totalPeers || 0;

            const cpuClass = cpuUsage > 80 ? 'metric-critical' : cpuUsage > 60 ? 'metric-warning' : '';
            const memClass = memUsage > 80 ? 'metric-critical' : memUsage > 60 ? 'metric-warning' : '';

            content += `
                <div class="tooltip-body">
                    <div class="metric-row">
                        <span class="metric-label">Interfaces:</span>
                        <span class="metric-value">${interfacesUp} UP / ${interfacesDown} DOWN</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-label">CPU:</span>
                        <span class="metric-value ${cpuClass}">${cpuUsage.toFixed(1)}%</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-label">Memory:</span>
                        <span class="metric-value ${memClass}">${memUsage.toFixed(1)}%</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-label">BGP Peers:</span>
                        <span class="metric-value">${bgpPeersActive} / ${bgpPeersTotal}</span>
                    </div>
                </div>
                <div class="tooltip-footer">Click for details</div>
            `;
        }

        tooltip.innerHTML = content;
        document.body.appendChild(tooltip);
        this.activeTooltip = tooltip;
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

        // Fetch fresh metrics
        this.fetchRouterMetrics(routerId).then(metrics => {
            if (!metrics) {
                this.renderPanel(routerId, router, null);
                return;
            }

            router.metrics = metrics;
            this.renderPanel(routerId, router, metrics);
        });

        // Show loading panel immediately
        this.renderPanel(routerId, router, null);
    }

    // ── helpers ─────────────────────────────────────────────────────────────
    _bgpStateClass(state) {
        switch ((state || '').toLowerCase()) {
            case 'established': return 'bgp-established';
            case 'active':      return 'bgp-active';
            case 'connect':     return 'bgp-connect';
            case 'opensent':
            case 'openconfirm': return 'bgp-open';
            case 'idle':
            default:            return 'bgp-idle';
        }
    }
    _bgpStateIcon(state) {
        switch ((state || '').toLowerCase()) {
            case 'established': return '●';
            case 'active':      return '◑';
            case 'connect':     return '◔';
            case 'opensent':
            case 'openconfirm': return '◕';
            case 'idle':
            default:            return '○';
        }
    }
    _ifStateClass(state) {
        return state === 'up' ? 'if-up' : 'if-down';
    }
    _gaugeArc(pct, color) {
        // 180° arc (half-circle), r=40 centered at 50,50
        const r = 40, cx = 50, cy = 54;
        const angle = Math.min(pct, 100) / 100 * Math.PI;
        const x = cx + r * Math.cos(Math.PI - angle);
        const y = cy - r * Math.sin(Math.PI - angle);
        const large = angle > Math.PI / 2 ? 1 : 0;
        return `M${cx - r},${cy} A${r},${r} 0 ${large} 1 ${x.toFixed(2)},${y.toFixed(2)}`;
    }
    _arcGauge(pct, label, colorClass) {
        const d = this._gaugeArc(pct, colorClass);
        return `
        <div class="arc-gauge-wrap ${colorClass}">
          <svg viewBox="0 0 100 60" class="arc-gauge-svg">
            <path d="M10,54 A40,40 0 0 1 90,54" fill="none" stroke="#2a2a2a" stroke-width="10" stroke-linecap="round"/>
            <path d="${d}" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/>
          </svg>
          <div class="arc-gauge-value">${pct.toFixed(1)}<span class="arc-unit">%</span></div>
          <div class="arc-gauge-label">${label}</div>
        </div>`;
    }

    // ── main render ─────────────────────────────────────────────────────────
    renderPanel(routerId, router, metrics) {
        if (this.activePanel) this.activePanel.remove();

        const panel = document.createElement('div');
        panel.className = 'router-panel';

        const isLoading = !metrics;
        const isDC = router.type === 'spine';
        const statusDot = router.status === 'connected' ? '🟢' :
                          router.status === 'disconnected' ? '🔴' : '🟡';
        const typeLabel = router.type === 'spine' ? 'SPINE' : 'LEAF';

        // ── header ──────────────────────────────────────────────────────────
        let html = `
        <div class="panel-overlay"></div>
        <div class="panel-content rp2">
          <div class="rp2-header">
            <div class="rp2-header-left">
              <div class="rp2-router-icon">${router.type === 'spine' ? '◈' : '◇'}</div>
              <div>
                <div class="rp2-title">${router.name}</div>
                <div class="rp2-subtitle">
                  <span class="rp2-type-badge rp2-type-${router.type}">${typeLabel}</span>
                  <span class="rp2-host">${router.host || ''}</span>
                </div>
              </div>
            </div>
            <div class="rp2-header-right">
              <span class="rp2-conn-badge rp2-conn-${router.status}">${statusDot} ${router.status}</span>
              ${router.lastUpdate ? `<span class="rp2-lastseen">updated ${new Date(router.lastUpdate).toLocaleTimeString()}</span>` : ''}
              <button class="panel-close" aria-label="Chiudi">&times;</button>
            </div>
          </div>`;

        if (isLoading) {
            html += `
          <div class="rp2-loading">
            <div class="rp2-spinner"></div>
            <span>Caricamento metriche…</span>
          </div>
        </div>`;
            panel.innerHTML = html;
            document.body.appendChild(panel);
            this.activePanel = panel;
            this._bindPanelClose(panel);
            return;
        }

        // ── computed values ──────────────────────────────────────────────────
        const cpu  = metrics.system.cpu?.total || 0;
        const mem  = metrics.system.memory?.utilization || 0;
        const sysIP = metrics.system.system0IP || '—';
        const cpuClass = cpu > 80 ? 'arc-critical' : cpu > 60 ? 'arc-warning' : 'arc-normal';
        const memClass = mem > 80 ? 'arc-critical' : mem > 60 ? 'arc-warning' : 'arc-normal';

        const allIfaces = metrics.interfaces || [];
        const ifUp   = allIfaces.filter(i => i.operState === 'up').length;
        const ifDown = allIfaces.length - ifUp;

        const bgpTotal  = metrics.bgp?.totalPeers  || 0;
        const bgpActive = metrics.bgp?.activePeers || 0;
        const neighbors = metrics.bgp?.neighbors   || [];
        const maxRoutes = Math.max(...neighbors.map(n => n.routesReceived || 0), 1);

        // Teleprotection FSM from backend snapshot (if available)
        const fsm = this.teleprotection?.fsm;
        const fsmState = fsm?.state || (this.teleprotection?.closed ? 'ARMED' : 'TRIP');
        const fsmStateClass = fsmState === 'ARMED' ? 'fsm-armed' : fsmState === 'PICKUP' ? 'fsm-pickup' : 'fsm-trip';
        const fsmLabel  = fsmState === 'ARMED' ? '✓ ARMED — tutto OK' :
                          fsmState === 'PICKUP' ? '⚠ PICKUP — guasto rilevato' : '✕ TRIP — breaker aperto';

        // ── tabs ─────────────────────────────────────────────────────────────
        const tabs = ['overview','interfaces','bgp'];
        if (isDC) tabs.push('teleprotection');

        html += `
          <div class="rp2-tabs">
            ${tabs.map((t, i) => `<button class="rp2-tab${i===0?' active':''}" data-tab="${t}">${
              t === 'overview' ? '📊 Panoramica' :
              t === 'interfaces' ? `🔌 Interfacce <span class="tab-badge">${allIfaces.length}</span>` :
              t === 'bgp' ? `🌐 BGP <span class="tab-badge ${bgpActive===bgpTotal&&bgpTotal>0?'badge-ok':'badge-warn'}">${bgpActive}/${bgpTotal}</span>` :
              '🛡 Teleprotezione'
            }</button>`).join('')}
          </div>`;

        // ══ TAB: OVERVIEW ════════════════════════════════════════════════════
        html += `<div class="rp2-tab-body tab-overview active">
          <div class="rp2-overview-grid">
            <div class="rp2-kpi-card">
              <div class="kpi-label">System0 IP</div>
              <div class="kpi-mono">${sysIP}</div>
            </div>
            <div class="rp2-kpi-card">
              <div class="kpi-label">Interfacce attive</div>
              <div class="kpi-large kpi-${ifDown>0?'warn':'ok'}">${ifUp}<span class="kpi-denom">/${allIfaces.length}</span></div>
            </div>
            <div class="rp2-kpi-card">
              <div class="kpi-label">BGP Peers attivi</div>
              <div class="kpi-large kpi-${bgpActive<bgpTotal?'warn':'ok'}">${bgpActive}<span class="kpi-denom">/${bgpTotal}</span></div>
            </div>
          </div>
          <div class="rp2-gauge-row">
            ${this._arcGauge(cpu, 'CPU', cpuClass)}
            ${this._arcGauge(mem, 'Memoria', memClass)}
          </div>
        </div>`;

        // ══ TAB: INTERFACES ══════════════════════════════════════════════════
        html += `<div class="rp2-tab-body tab-interfaces">`;
        if (allIfaces.length === 0) {
            html += `<p class="rp2-empty">Nessuna interfaccia disponibile.</p>`;
        } else {
            // Sort: up first, then by name
            const sorted = [...allIfaces].sort((a, b) => {
                if (a.operState === b.operState) return a.name.localeCompare(b.name);
                return a.operState === 'up' ? -1 : 1;
            });
            html += `<div class="rp2-iface-list">`;
            sorted.forEach(iface => {
                const st = iface.operState;
                const ip = iface.ipAddresses?.length ? iface.ipAddresses[0] : '—';
                const inR  = this.formatRate(iface.inRate  || 0);
                const outR = this.formatRate(iface.outRate || 0);
                const maxR = Math.max(iface.inRate||0, iface.outRate||0, 1);
                const inPct  = Math.min((iface.inRate  || 0) / maxR * 100, 100);
                const outPct = Math.min((iface.outRate || 0) / maxR * 100, 100);
                html += `
                <div class="rp2-iface-row ${this._ifStateClass(st)}">
                  <div class="iface-led ${st === 'up' ? 'led-up' : 'led-down'}"></div>
                  <div class="iface-name">${iface.name}</div>
                  <div class="iface-state">
                    <span class="iface-badge ${st === 'up' ? 'ibadge-up' : 'ibadge-down'}">${st.toUpperCase()}</span>
                  </div>
                  <div class="iface-ip">${ip}</div>
                  <div class="iface-traffic">
                    <div class="traffic-bar-row">
                      <span class="traffic-dir">▼</span>
                      <div class="traffic-bar"><div class="tbar-fill tbar-in" style="width:${inPct}%"></div></div>
                      <span class="traffic-val">${inR}</span>
                    </div>
                    <div class="traffic-bar-row">
                      <span class="traffic-dir">▲</span>
                      <div class="traffic-bar"><div class="tbar-fill tbar-out" style="width:${outPct}%"></div></div>
                      <span class="traffic-val">${outR}</span>
                    </div>
                  </div>
                </div>`;
            });
            html += `</div>`;
        }
        html += `</div>`;

        // ══ TAB: BGP ═════════════════════════════════════════════════════════
        html += `<div class="rp2-tab-body tab-bgp">`;
        if (bgpTotal === 0) {
            html += `<p class="rp2-empty">Nessun peer BGP configurato.</p>`;
        } else {
            const bgpPct = bgpTotal > 0 ? (bgpActive / bgpTotal) * 100 : 0;
            const bgpCircum = 2 * Math.PI * 28;
            const bgpDash = (bgpPct / 100) * bgpCircum;
            html += `
            <div class="rp2-bgp-header">
              <div class="bgp-donut-wrap">
                <svg viewBox="0 0 70 70" class="bgp-donut">
                  <circle cx="35" cy="35" r="28" fill="none" stroke="#2a2a2a" stroke-width="8"/>
                  <circle cx="35" cy="35" r="28" fill="none"
                    stroke="${bgpActive === bgpTotal ? 'var(--accent-success)' : 'var(--accent-warning)'}"
                    stroke-width="8" stroke-linecap="round"
                    stroke-dasharray="${bgpDash.toFixed(1)} ${bgpCircum.toFixed(1)}"
                    transform="rotate(-90 35 35)"/>
                  <text x="35" y="39" text-anchor="middle" class="donut-text">${bgpActive}/${bgpTotal}</text>
                </svg>
                <div class="bgp-donut-label">Peers<br>attivi</div>
              </div>
              <div class="bgp-legend">
                <div class="bgp-legend-item"><span class="bgp-dot bgp-established"></span>Established</div>
                <div class="bgp-legend-item"><span class="bgp-dot bgp-active"></span>Active</div>
                <div class="bgp-legend-item"><span class="bgp-dot bgp-connect"></span>Connect</div>
                <div class="bgp-legend-item"><span class="bgp-dot bgp-idle"></span>Idle</div>
              </div>
            </div>
            <div class="rp2-peer-grid">`;

            neighbors.forEach(n => {
                const sc  = this._bgpStateClass(n.sessionState);
                const ico = this._bgpStateIcon(n.sessionState);
                const routes = n.routesReceived || 0;
                const routePct = Math.round(routes / maxRoutes * 100);
                html += `
              <div class="rp2-peer-card ${sc}">
                <div class="peer-state-icon">${ico}</div>
                <div class="peer-info">
                  <div class="peer-addr">${n.peerAddress || '—'}</div>
                  <div class="peer-state-badge ${sc}">${(n.sessionState || 'unknown').toUpperCase()}</div>
                </div>
                <div class="peer-routes">
                  <div class="peer-routes-label">Routes ricevute</div>
                  <div class="peer-routes-bar">
                    <div class="peer-routes-fill ${sc}" style="width:${routePct}%"></div>
                  </div>
                  <div class="peer-routes-val">${routes}</div>
                </div>
              </div>`;
            });

            html += `</div>`;
        }
        html += `</div>`;

        // ══ TAB: TELEPROTECTION (DC only) ════════════════════════════════════
        if (isDC) {
            const isolated = fsm?.isolatedLeaves || [];
            const breakerClosed = fsmState !== 'TRIP';
            html += `
            <div class="rp2-tab-body tab-teleprotection">
              <div class="tpt-panel">
                <div class="tpt-fsm-badge ${fsmStateClass}">
                  <div class="tpt-fsm-state">${fsmState}</div>
                  <div class="tpt-fsm-label">${fsmLabel}</div>
                  ${fsm?.reason ? `<div class="tpt-fsm-reason">${fsm.reason}</div>` : ''}
                </div>
                <div class="tpt-breaker-wrap">
                  <div class="tpt-breaker-label">Circuit Breaker</div>
                  <div class="tpt-breaker ${breakerClosed ? 'breaker-closed' : 'breaker-open'}">
                    <div class="breaker-arm"></div>
                    <div class="breaker-state">${breakerClosed ? 'CHIUSO' : 'APERTO'}</div>
                  </div>
                </div>
                <div class="tpt-leaves">
                  <div class="tpt-leaves-label">Stato Leaf</div>
                  ${['leaf1','leaf2','leaf3','leaf4'].map(l => {
                    const iso = isolated.includes(l);
                    return `<div class="tpt-leaf ${iso?'leaf-isolated':'leaf-ok'}">
                      <span>${iso?'✕':'✓'}</span> ${l.toUpperCase()}
                    </div>`;
                  }).join('')}
                </div>
              </div>
              <div class="tpt-edu-note">
                <b>Come funziona:</b> la teleprotezione differenziale usa il canale di comunicazione
                (DC-1 ↔ DC-2) per confrontare le correnti ai due estremi della linea HV. Se un Leaf
                perde <em>entrambi</em> i link verso i DC spine, il circuito è isolato e il breaker scatta
                (stato TRIP). Con un solo link attivo la protezione rimane armata (ARMED).
              </div>
            </div>`;
        }

        html += `</div>`; // panel-content

        panel.innerHTML = html;
        document.body.appendChild(panel);
        this.activePanel = panel;

        // ── tab switching ────────────────────────────────────────────────────
        panel.querySelectorAll('.rp2-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                panel.querySelectorAll('.rp2-tab').forEach(b => b.classList.remove('active'));
                panel.querySelectorAll('.rp2-tab-body').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const target = panel.querySelector(`.tab-${btn.dataset.tab}`);
                if (target) target.classList.add('active');
            });
        });

        this._bindPanelClose(panel);
    }

    _bindPanelClose(panel) {
        const closePanel = () => {
            if (this.activePanel) {
                this.activePanel.remove();
                this.activePanel = null;
            }
        };
        panel.querySelector('.panel-close')?.addEventListener('click', closePanel);
        panel.querySelector('.panel-overlay')?.addEventListener('click', closePanel);
        const esc = (e) => { if (e.key === 'Escape') { closePanel(); document.removeEventListener('keydown', esc); } };
        document.addEventListener('keydown', esc);
    }

    formatRate(bitsPerSecond) {
        if (bitsPerSecond >= 1e9) {
            return (bitsPerSecond / 1e9).toFixed(2) + ' Gbps';
        } else if (bitsPerSecond >= 1e6) {
            return (bitsPerSecond / 1e6).toFixed(2) + ' Mbps';
        } else if (bitsPerSecond >= 1e3) {
            return (bitsPerSecond / 1e3).toFixed(2) + ' Kbps';
        } else {
            return bitsPerSecond.toFixed(0) + ' bps';
        }
    }

    // Check link status based on interface operational state
    async checkAllLinks() {
        if (this.manualOverride) return;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const response = await fetch(`${this.gnmiServiceUrl}/api/links`, {
                method: 'GET',
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error('Links service unavailable');
            }

            const data = await response.json();
            console.log('[Links] Received link status:', data.links);

            // Track link states for teleprotection logic
            const linkStates = {};

            // Update each link visualization
            Object.entries(data.links).forEach(([linkId, linkData]) => {
                linkStates[linkId] = linkData.status;

                const connection = document.querySelector(`[data-link="${linkId}"]`);
                console.log(`[Links] ${linkId}: status=${linkData.status}, element found=${!!connection}`);
                if (connection) {
                    if (linkData.status === 'up') {
                        connection.classList.remove('link-down');
                        connection.classList.add('link-up');
                        console.log(`[Links] ${linkId} set to UP (green)`);
                    } else {
                        connection.classList.remove('link-up');
                        connection.classList.add('link-down');
                        console.log(`[Links] ${linkId} set to DOWN (red)`);
                    }
                }
            });

            // Update Teleprotection System based on link states
            this.updateTeleprotectionFromLinks(linkStates);

        } catch (error) {
            console.error('Error checking links:', error);
            // On error, remove status classes from all links
            document.querySelectorAll('.router-connection[data-link]').forEach(connection => {
                connection.classList.remove('link-up', 'link-down');
            });
        }
    }

    // Update Teleprotection System visualization based on link states
    updateTeleprotectionFromLinks(linkStates) {
        // Check if Leaf-1 has lost both connections to DCs (isolates Substation A / RTU-1)
        const leaf1Isolated = linkStates['dc1-leaf1'] === 'down' && linkStates['dc2-leaf1'] === 'down';

        // Check if Leaf-2 has lost both connections to DCs (isolates Substation B / RTU-2)
        const leaf2Isolated = linkStates['dc1-leaf2'] === 'down' && linkStates['dc2-leaf2'] === 'down';

        // Check if Leaf-3 has lost both connections to DCs (isolates RTU-3)
        const leaf3Isolated = linkStates['dc1-leaf3'] === 'down' && linkStates['dc2-leaf3'] === 'down';

        // Check if Leaf-4 has lost both connections to DCs (isolates RTU-4)
        const leaf4Isolated = linkStates['dc1-leaf4'] === 'down' && linkStates['dc2-leaf4'] === 'down';

        console.log(`[Teleprotection] Leaf-1 isolated: ${leaf1Isolated}, Leaf-2 isolated: ${leaf2Isolated}, Leaf-3 isolated: ${leaf3Isolated}, Leaf-4 isolated: ${leaf4Isolated}`);

        // Get teleprotection SVG elements
        const tpDiagram = document.querySelector('.teleprotection-diagram');
        if (!tpDiagram) return;

        // Update Teleprotection Equipment A (RTU-1) - connected to Leaf-1
        const tpEquipA = tpDiagram.querySelector('.tp-equip-a');
        const tpEquipALeds = tpEquipA ? tpEquipA.querySelectorAll('.tp-led') : [];

        // Update Teleprotection Equipment B (RTU-4) - connected to Leaf-2
        const tpEquipB = tpDiagram.querySelector('.tp-equip-b');
        const tpEquipBLeds = tpEquipB ? tpEquipB.querySelectorAll('.tp-led') : [];

        // Update LEDs and add/remove fault class
        if (leaf1Isolated) {
            tpEquipALeds.forEach(led => led.setAttribute('fill', '#dc3545')); // Red
            if (tpEquipA) tpEquipA.classList.add('tp-fault');
        } else {
            tpEquipALeds.forEach(led => led.setAttribute('fill', '#4caf50')); // Green
            if (tpEquipA) tpEquipA.classList.remove('tp-fault');
        }

        if (leaf2Isolated) {
            tpEquipBLeds.forEach(led => led.setAttribute('fill', '#dc3545')); // Red
            if (tpEquipB) tpEquipB.classList.add('tp-fault');
        } else {
            tpEquipBLeds.forEach(led => led.setAttribute('fill', '#4caf50')); // Green
            if (tpEquipB) tpEquipB.classList.remove('tp-fault');
        }

        // Update connection lines in teleprotection diagram
        const tpConnections = tpDiagram.querySelector('.teleprotection-connections');
        if (tpConnections) {
            const lines = tpConnections.querySelectorAll('line');

            // First two lines are Substation A side, last two are Substation B side
            lines.forEach((line, index) => {
                if (index < 2 && leaf1Isolated) {
                    line.setAttribute('stroke', '#dc3545');
                    line.setAttribute('stroke-dasharray', '5,5');
                } else if (index < 2) {
                    line.setAttribute('stroke', index === 0 ? '#2196f3' : '#00bcd4');
                    line.removeAttribute('stroke-dasharray');
                }

                if (index >= 2 && leaf2Isolated) {
                    line.setAttribute('stroke', '#dc3545');
                    line.setAttribute('stroke-dasharray', '5,5');
                } else if (index >= 2) {
                    line.setAttribute('stroke', index === 3 ? '#2196f3' : '#00bcd4');
                    line.removeAttribute('stroke-dasharray');
                }
            });
        }

        // Show/hide signal animations based on fault state
        const signalAnimations = tpDiagram.querySelectorAll('.teleprotection-connections circle');
        signalAnimations.forEach((circle, index) => {
            // First half of animations are for left side, second half for right side
            if (index < signalAnimations.length / 2) {
                circle.style.display = leaf1Isolated ? 'none' : '';
            } else {
                circle.style.display = leaf2Isolated ? 'none' : '';
            }
        });

        // Update the main teleprotection status based on network state
        const closedIcon = document.getElementById('teleprotection-closed');
        const openIcon = document.getElementById('teleprotection-open');
        const stateText = document.getElementById('teleprotection-state-text');

        if (leaf1Isolated || leaf2Isolated || leaf3Isolated || leaf4Isolated) {
            // Network fault affects teleprotection
            if (closedIcon && openIcon && stateText) {
                closedIcon.style.display = 'none';
                openIcon.style.display = 'block';
                stateText.textContent = 'FAULT DI RETE / NETWORK FAULT';
                stateText.className = 'teleprotection-state open';
            }
        } else {
            // Network is healthy - restore teleprotection status
            if (closedIcon && openIcon && stateText) {
                closedIcon.style.display = 'block';
                openIcon.style.display = 'none';
                stateText.textContent = 'CLOSED / CHIUSO';
                stateText.className = 'teleprotection-state closed';
            }
        }
    }
}

// Draggable Topology Nodes
class DraggableTopology {
    constructor() {
        this.selectedNode = null;
        this.offset = { x: 0, y: 0 };
        this.nodePositions = {
            nuclear1: { x: 150, y: 100 },
            nuclear2: { x: 150, y: 300 },
            solar: { x: 400, y: 100 },
            wind: { x: 400, y: 300 },
            distribution: { x: 545, y: 200 },
            transmission1: { x: 765, y: 80 },
            transmission2: { x: 765, y: 200 },
            transmission3: { x: 765, y: 280 },
            transmission4: { x: 765, y: 360 },
            city: { x: 1050, y: 200 }
        };
        this.init();
    }

    init() {
        const svg = document.querySelector('.topology-diagram');
        const nodes = document.querySelectorAll('.node-group');

        nodes.forEach(node => {
            node.style.cursor = 'move';

            node.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this.startDrag(node, e);
            });
        });

        svg.addEventListener('mousemove', (e) => {
            if (this.selectedNode) {
                this.drag(e);
            }
        });

        svg.addEventListener('mouseup', () => {
            this.endDrag();
        });

        svg.addEventListener('mouseleave', () => {
            this.endDrag();
        });
    }

    startDrag(node, e) {
        this.selectedNode = node;
        const nodeId = node.dataset.node;
        const pos = this.nodePositions[nodeId];

        const svg = document.querySelector('.topology-diagram');

        // Safari compatible coordinate conversion
        const rect = svg.getBoundingClientRect();
        const viewBox = svg.viewBox.baseVal;
        const scaleX = viewBox.width / rect.width;
        const scaleY = viewBox.height / rect.height;

        const svgX = (e.clientX - rect.left) * scaleX;
        const svgY = (e.clientY - rect.top) * scaleY;

        this.offset.x = svgX - pos.x;
        this.offset.y = svgY - pos.y;

        console.log('Started dragging:', nodeId);
    }

    drag(e) {
        if (!this.selectedNode) return;

        const svg = document.querySelector('.topology-diagram');

        // Safari compatible coordinate conversion
        const rect = svg.getBoundingClientRect();
        const viewBox = svg.viewBox.baseVal;
        const scaleX = viewBox.width / rect.width;
        const scaleY = viewBox.height / rect.height;

        const svgX = (e.clientX - rect.left) * scaleX;
        const svgY = (e.clientY - rect.top) * scaleY;

        const nodeId = this.selectedNode.dataset.node;
        const newX = svgX - this.offset.x;
        const newY = svgY - this.offset.y;

        this.nodePositions[nodeId] = { x: newX, y: newY };
        this.selectedNode.setAttribute('transform', `translate(${newX}, ${newY})`);

        this.updateConnections(nodeId);
    }

    endDrag() {
        if (this.selectedNode) {
            console.log('Stopped dragging');
        }
        this.selectedNode = null;
    }

    // Calculate intersection point with Hub square edges
    getHubEdgePoint(fromX, fromY, hubX, hubY) {
        // Hub is 60x60 square, so half-size is 30
        const halfSize = 30;

        // Calculate direction vector
        const dx = hubX - fromX;
        const dy = hubY - fromY;

        // Calculate intersections with all four edges
        const intersections = [];

        // Left edge (x = hubX - 30)
        if (dx !== 0) {
            const t = (hubX - halfSize - fromX) / dx;
            const y = fromY + t * dy;
            if (y >= hubY - halfSize && y <= hubY + halfSize && t > 0) {
                intersections.push({ x: hubX - halfSize, y, t });
            }
        }

        // Right edge (x = hubX + 30)
        if (dx !== 0) {
            const t = (hubX + halfSize - fromX) / dx;
            const y = fromY + t * dy;
            if (y >= hubY - halfSize && y <= hubY + halfSize && t > 0) {
                intersections.push({ x: hubX + halfSize, y, t });
            }
        }

        // Top edge (y = hubY - 30)
        if (dy !== 0) {
            const t = (hubY - halfSize - fromY) / dy;
            const x = fromX + t * dx;
            if (x >= hubX - halfSize && x <= hubX + halfSize && t > 0) {
                intersections.push({ x, y: hubY - halfSize, t });
            }
        }

        // Bottom edge (y = hubY + 30)
        if (dy !== 0) {
            const t = (hubY + halfSize - fromY) / dy;
            const x = fromX + t * dx;
            if (x >= hubX - halfSize && x <= hubX + halfSize && t > 0) {
                intersections.push({ x, y: hubY + halfSize, t });
            }
        }

        // Return the closest intersection (smallest t value)
        if (intersections.length > 0) {
            intersections.sort((a, b) => a.t - b.t);
            return { x: intersections[0].x, y: intersections[0].y };
        }

        // Fallback to center if no intersection found
        return { x: hubX, y: hubY };
    }

    updateConnections(nodeId) {
        const pos = this.nodePositions[nodeId];

        // Plants to Distribution Hub
        if (nodeId === 'nuclear1' || nodeId === 'nuclear2' || nodeId === 'solar' || nodeId === 'wind') {
            const connection = document.querySelector(`.connection[data-source="${nodeId}"]`);
            const particles = document.querySelectorAll(`.particle-${nodeId}`);
            const distPos = this.nodePositions.distribution;

            const angle = Math.atan2(distPos.y - pos.y, distPos.x - pos.x);
            const startX = pos.x + 35 * Math.cos(angle);
            const startY = pos.y + 35 * Math.sin(angle);

            // Calculate edge intersection for Hub
            const hubEdge = this.getHubEdgePoint(startX, startY, distPos.x, distPos.y);
            const endX = hubEdge.x;
            const endY = hubEdge.y;

            const path = `M ${startX} ${startY} L ${endX} ${endY}`;
            if (connection) connection.setAttribute('d', path);
            particles.forEach(particle => {
                const motion = particle.querySelector('animateMotion');
                if (motion) motion.setAttribute('path', path);
            });
        }

        // Distribution Hub
        if (nodeId === 'distribution') {
            // Update incoming from plants
            ['nuclear1', 'nuclear2', 'solar', 'wind'].forEach(plantId => {
                const plantPos = this.nodePositions[plantId];
                const connection = document.querySelector(`.connection[data-source="${plantId}"]`);
                const particles = document.querySelectorAll(`.particle-${plantId}`);

                const angle = Math.atan2(pos.y - plantPos.y, pos.x - plantPos.x);
                const startX = plantPos.x + 35 * Math.cos(angle);
                const startY = plantPos.y + 35 * Math.sin(angle);

                // Calculate edge intersection for Hub
                const hubEdge = this.getHubEdgePoint(startX, startY, pos.x, pos.y);
                const endX = hubEdge.x;
                const endY = hubEdge.y;

                const path = `M ${startX} ${startY} L ${endX} ${endY}`;
                if (connection) connection.setAttribute('d', path);
                particles.forEach(particle => {
                    const motion = particle.querySelector('animateMotion');
                    if (motion) motion.setAttribute('path', path);
                });
            });

            // Update outgoing to transmission units
            [1, 2, 3, 4].forEach(i => {
                const transPos = this.nodePositions[`transmission${i}`];
                const connection = document.getElementById(`conn-dist-trans${i}`);

                // Calculate edge intersection for Hub (starting from Hub to transmission)
                const hubEdge = this.getHubEdgePoint(transPos.x, transPos.y, pos.x, pos.y);
                const startX = hubEdge.x;
                const startY = hubEdge.y;

                const transAngle = Math.atan2(pos.y - transPos.y, pos.x - transPos.x);
                const endX = transPos.x + 15 * Math.cos(transAngle);
                const endY = transPos.y + 15 * Math.sin(transAngle);

                const path = `M ${startX} ${startY} L ${endX} ${endY}`;
                if (connection) {
                    connection.setAttribute('d', path);
                    const motion = connection.nextElementSibling?.querySelector('animateMotion');
                    if (motion) motion.setAttribute('path', path);
                }
            });
        }

        // Transmission Units
        if (nodeId.startsWith('transmission')) {
            const transNum = nodeId.replace('transmission', '');
            const distPos = this.nodePositions.distribution;
            const cityPos = this.nodePositions.city;

            // Update connection from distribution
            const connToDist = document.getElementById(`conn-dist-trans${transNum}`);
            if (connToDist) {
                // Calculate edge intersection for Hub
                const hubEdge = this.getHubEdgePoint(pos.x, pos.y, distPos.x, distPos.y);
                const startX = hubEdge.x;
                const startY = hubEdge.y;

                const transAngle = Math.atan2(distPos.y - pos.y, distPos.x - pos.x);
                const endX = pos.x + 15 * Math.cos(transAngle);
                const endY = pos.y + 15 * Math.sin(transAngle);

                const path = `M ${startX} ${startY} L ${endX} ${endY}`;
                connToDist.setAttribute('d', path);
                const motion = connToDist.nextElementSibling?.querySelector('animateMotion');
                if (motion) motion.setAttribute('path', path);
            }

            // Update connection to city
            const connToCity = document.getElementById(`conn-trans${transNum}-city`);
            if (connToCity) {
                const angle = Math.atan2(cityPos.y - pos.y, cityPos.x - pos.x);
                const startX = pos.x + 15 * Math.cos(angle);
                const startY = pos.y + 15 * Math.sin(angle);

                const cityAngle = Math.atan2(pos.y - cityPos.y, pos.x - cityPos.x);
                const endX = cityPos.x + 40 * Math.cos(cityAngle);
                const endY = cityPos.y + 40 * Math.sin(cityAngle);

                const path = `M ${startX} ${startY} L ${endX} ${endY}`;
                connToCity.setAttribute('d', path);
                const motion = connToCity.nextElementSibling?.querySelector('animateMotion');
                if (motion) motion.setAttribute('path', path);
            }
        }

        // City
        if (nodeId === 'city') {
            [1, 2, 3, 4].forEach(i => {
                const transPos = this.nodePositions[`transmission${i}`];
                const connection = document.getElementById(`conn-trans${i}-city`);

                const angle = Math.atan2(pos.y - transPos.y, pos.x - transPos.x);
                const startX = transPos.x + 15 * Math.cos(angle);
                const startY = transPos.y + 15 * Math.sin(angle);

                const cityAngle = Math.atan2(transPos.y - pos.y, transPos.x - pos.x);
                const endX = pos.x + 40 * Math.cos(cityAngle);
                const endY = pos.y + 40 * Math.sin(cityAngle);

                const path = `M ${startX} ${startY} L ${endX} ${endY}`;
                if (connection) {
                    connection.setAttribute('d', path);
                    const motion = connection.nextElementSibling?.querySelector('animateMotion');
                    if (motion) motion.setAttribute('path', path);
                }
            });
        }
    }
}

// Initialize the Smart Grid when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM Content Loaded - Initializing...');

    // Security Control - Simple direct implementation (initialize FIRST)
    const toggle = document.getElementById('anysec-toggle');
    const statusText = document.getElementById('security-status');

    console.log('Security toggle found:', toggle);
    console.log('Security status text found:', statusText);

    function updateSecurityAnimation() {
        const isEnabled = toggle.checked;
        console.log('=== Security Update Called ===');
        console.log('Encryption enabled:', isEnabled);

        // Get all packets
        const securePackets = document.querySelectorAll('.secure-packet');
        const insecurePackets = document.querySelectorAll('.insecure-packet');

        console.log('Found secure packets:', securePackets.length);
        console.log('Found insecure packets:', insecurePackets.length);

        if (isEnabled) {
            console.log('Enabling encryption...');
            statusText.textContent = 'Enabled';
            statusText.className = 'security-status enabled';

            // Show secure packets (green with shield)
            securePackets.forEach((packet, i) => {
                packet.setAttribute('style', 'display: inline');
                console.log(`Secure packet ${i} shown`);
            });

            // Hide insecure packets (red with open lock)
            insecurePackets.forEach((packet, i) => {
                packet.setAttribute('style', 'display: none');
                console.log(`Insecure packet ${i} hidden`);
            });
        } else {
            console.log('Disabling encryption...');
            statusText.textContent = 'Disabled';
            statusText.className = 'security-status disabled';

            // Hide secure packets
            securePackets.forEach((packet, i) => {
                packet.setAttribute('style', 'display: none');
                console.log(`Secure packet ${i} hidden`);
            });

            // Show insecure packets
            insecurePackets.forEach((packet, i) => {
                packet.setAttribute('style', 'display: inline');
                console.log(`Insecure packet ${i} shown`);
            });
        }

        console.log('=== Security Update Complete ===');
    }

    if (toggle) {
        console.log('Attaching change listener to toggle');
        toggle.addEventListener('change', function() {
            console.log('>>> TOGGLE CHANGED! New state:', this.checked);
            updateSecurityAnimation();
        });

        // Initialize with encryption disabled
        console.log('Setting initial state');
        updateSecurityAnimation();
    } else {
        console.error('ERROR: Toggle element not found!');
    }

    console.log('Security control initialized');

    // Initialize other components with error handling
    try {
        console.log('Initializing SmartGrid...');
        new SmartGrid();
        console.log('SmartGrid initialized');
    } catch (e) {
        console.error('Error initializing SmartGrid:', e);
    }

    try {
        console.log('Initializing DraggableTopology...');
        new DraggableTopology();
        console.log('DraggableTopology initialized');
    } catch (e) {
        console.error('Error initializing DraggableTopology:', e);
    }

    console.log('All components initialized');

    // --- gNMI Service Controller ---
    (function initGnmiController() {
        const PING_BASE = 'http://localhost:3000';
        let gnmiRunning = false;
        let statusPollInterval = null;

        const dot       = document.getElementById('gnmiDot');
        const label     = document.getElementById('gnmiStatusLabel');
        const pidLabel  = document.getElementById('gnmiPidLabel');
        const btn       = document.getElementById('gnmiActionBtn');
        const btnIcon   = document.getElementById('gnmiActionIcon');
        const btnLbl    = document.getElementById('gnmiActionLabel');
        const logPanel  = document.getElementById('gnmiLogPanel');
        const logBody   = document.getElementById('gnmiLogBody');

        if (!dot || !btn) return; // elements not in page

        function setLoadingState() {
            dot.className = 'gnmi-dot loading';
            label.className = 'gnmi-status-label loading';
            label.textContent = 'In corso...';
            btn.className = 'gnmi-action-btn loading-state';
            btnIcon.textContent = '⏳';
            btnLbl.textContent = 'Attendere...';
            btn.disabled = true;
        }

        function applyStatus(data) {
            gnmiRunning = data.running;
            if (data.running) {
                dot.className = 'gnmi-dot running';
                label.className = 'gnmi-status-label running';
                label.textContent = 'In esecuzione';
                pidLabel.textContent = data.pid ? `PID ${data.pid}` : '';
                btn.className = 'gnmi-action-btn stop';
                btnIcon.textContent = '⏹';
                btnLbl.textContent = 'Ferma Servizio';
            } else {
                dot.className = 'gnmi-dot stopped';
                label.className = 'gnmi-status-label stopped';
                label.textContent = 'Fermo';
                pidLabel.textContent = '';
                btn.className = 'gnmi-action-btn start';
                btnIcon.textContent = '▶';
                btnLbl.textContent = 'Avvia Servizio';
            }
            btn.disabled = false;
            // Update log panel if open
            if (logPanel && logPanel.style.display !== 'none') {
                renderLogs(data.logs || []);
            }
        }

        function renderLogs(logs) {
            if (!logBody) return;
            if (!logs || logs.length === 0) {
                logBody.innerHTML = '<span class="gnmi-log-empty">Nessun log disponibile.</span>';
                return;
            }
            logBody.innerHTML = logs.map(entry => {
                const isErr = entry.msg && entry.msg.startsWith('[ERR]');
                const ts = entry.ts ? entry.ts.substring(11, 19) : '';
                return `<div class="gnmi-log-line">
                    <span class="gnmi-log-ts">${ts}</span>
                    <span class="gnmi-log-msg${isErr ? ' error' : ''}">${entry.msg || ''}</span>
                </div>`;
            }).join('');
            logBody.scrollTop = logBody.scrollHeight;
        }

        async function fetchStatus() {
            try {
                const res = await fetch(`${PING_BASE}/gnmi/status`);
                if (!res.ok) throw new Error('status ' + res.status);
                const data = await res.json();
                applyStatus(data);
            } catch (e) {
                // ping-service not reachable
                dot.className = 'gnmi-dot stopped';
                label.className = 'gnmi-status-label stopped';
                label.textContent = 'Ping-service offline';
                btn.className = 'gnmi-action-btn loading-state';
                btn.disabled = true;
                btnIcon.textContent = '⚠';
                btnLbl.textContent = 'Servizio N/D';
                pidLabel.textContent = '';
            }
        }

        window.gnmiToggleService = async function() {
            setLoadingState();
            const endpoint = gnmiRunning ? '/gnmi/stop' : '/gnmi/start';
            try {
                const res = await fetch(`${PING_BASE}${endpoint}`);
                const data = await res.json();
                console.log('[gNMI Control]', data.message);
                // Poll until state changes (max 5s)
                let attempts = 0;
                const poll = setInterval(async () => {
                    await fetchStatus();
                    attempts++;
                    if (attempts >= 10) clearInterval(poll);
                }, 500);
            } catch (e) {
                console.error('[gNMI Control] Error:', e);
                await fetchStatus();
            }
        };

        window.gnmiToggleLogs = async function() {
            if (!logPanel) return;
            const isHidden = logPanel.style.display === 'none';
            logPanel.style.display = isHidden ? 'block' : 'none';
            if (isHidden) {
                try {
                    const res = await fetch(`${PING_BASE}/gnmi/status`);
                    const data = await res.json();
                    renderLogs(data.logs || []);
                } catch (e) {
                    renderLogs([]);
                }
            }
        };

        // Initial status + poll every 8s
        fetchStatus();
        statusPollInterval = setInterval(fetchStatus, 8000);
    })();
});
