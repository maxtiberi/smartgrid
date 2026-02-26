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
            leaf1: { name: 'Leaf-1', status: 'unknown', metrics: null, type: 'leaf', host: '172.20.20.2' },
            leaf2: { name: 'Leaf-2', status: 'unknown', metrics: null, type: 'leaf', host: '172.20.20.3' }
        };

        this.rtus = {
            rtu1: { name: 'RTU-1', status: 'unknown', host: '172.20.20.20' },
            rtu2: { name: 'RTU-2', status: 'unknown', host: '172.20.20.21' },
            rtu3: { name: 'RTU-3', status: 'unknown', host: '172.20.20.22' },
            rtu4: { name: 'RTU-4', status: 'unknown', host: '172.20.20.23' }
        };

        this.gnmiServiceUrl = 'http://localhost:3001';
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

            // Force full transmission power
            this._transmissionMultiplierBeforeOverride = this.transmissionPowerMultiplier;
            this.transmissionPowerMultiplier = 1.0;

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

            // Restore transmission multiplier
            if (this._transmissionMultiplierBeforeOverride !== undefined) {
                this.transmissionPowerMultiplier = this._transmissionMultiplierBeforeOverride;
            }

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
        // Check all routers immediately
        this.checkAllRouters();
        this.checkAllLinks();

        // Poll every 10 seconds
        setInterval(() => {
            this.checkAllRouters();
            this.checkAllLinks();
        }, 10000);
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

    renderPanel(routerId, router, metrics) {
        // Remove existing panel
        if (this.activePanel) {
            this.activePanel.remove();
        }

        const panel = document.createElement('div');
        panel.className = 'router-panel';

        let content = `
            <div class="panel-overlay"></div>
            <div class="panel-content">
                <div class="panel-header">
                    <h2>${router.name} Details</h2>
                    <span class="status-badge status-${router.status}">${router.status}</span>
                    <button class="panel-close">&times;</button>
                </div>
        `;

        if (!metrics) {
            content += '<div class="panel-body"><p class="loading-text">Loading metrics...</p></div>';
        } else {
            content += '<div class="panel-body">';

            // System Performance Section
            const cpuUsage = metrics.system.cpu?.total || 0;
            const memUsage = metrics.system.memory?.utilization || 0;
            const system0IP = metrics.system.system0IP || 'N/A';
            const cpuClass = cpuUsage > 80 ? 'critical' : cpuUsage > 60 ? 'warning' : 'normal';
            const memClass = memUsage > 80 ? 'critical' : memUsage > 60 ? 'warning' : 'normal';

            // Check TPT status for DC1 only (based on BGP routes received)
            let tptStatusHtml = '';
            if (routerId === 'dc1') {
                // Count total routes received from all BGP neighbors
                let totalRoutesReceived = 0;
                if (metrics.bgp.neighbors) {
                    metrics.bgp.neighbors.forEach(n => {
                        totalRoutesReceived += n.routesReceived || 0;
                    });
                }

                // If DC1 receives at least 2 BGP routes, circuit is closed
                const circuitClosed = totalRoutesReceived >= 2;
                const tptStatus = circuitClosed ? 'Chiuso / Closed' : 'Aperto / Open';
                const tptClass = circuitClosed ? 'status-closed' : 'status-open';
                tptStatusHtml = `
                    <div class="metric-card">
                        <div class="metric-label">TPT Status</div>
                        <div class="metric-value-display ${tptClass}">${tptStatus}</div>
                        <div class="metric-unit">${totalRoutesReceived} route${totalRoutesReceived !== 1 ? 's' : ''} received</div>
                    </div>
                `;
            }

            content += `
                <section class="metrics-section">
                    <h3>System Performance</h3>
                    <div class="metrics-grid">
                        <div class="metric-card">
                            <div class="metric-label">System0 IP Address</div>
                            <div class="metric-value-display">${system0IP}</div>
                        </div>
                        ${tptStatusHtml}
                        <div class="metric-card">
                            <div class="metric-label">CPU Usage</div>
                            <div class="metric-gauge ${cpuClass}">
                                <div class="gauge-fill" style="width: ${cpuUsage}%"></div>
                                <div class="gauge-value">${cpuUsage.toFixed(1)}%</div>
                            </div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-label">Memory Usage</div>
                            <div class="metric-gauge ${memClass}">
                                <div class="gauge-fill" style="width: ${memUsage}%"></div>
                                <div class="gauge-value">${memUsage.toFixed(1)}%</div>
                            </div>
                        </div>
                    </div>
                </section>
            `;

            // Interface Statistics Section
            content += `
                <section class="metrics-section">
                    <h3>Interface Statistics</h3>
            `;

            if (metrics.interfaces.length === 0) {
                content += '<p class="no-data">No interface data available</p>';
            } else {
                content += `
                    <table class="metrics-table">
                        <thead>
                            <tr>
                                <th>Interface</th>
                                <th>Status</th>
                                <th>IPv4 Addresses</th>
                                <th>In Rate</th>
                                <th>Out Rate</th>
                            </tr>
                        </thead>
                        <tbody>
                `;

                // Filter to show only active interfaces (operState === 'up')
                const activeInterfaces = metrics.interfaces.filter(iface => iface.operState === 'up');

                activeInterfaces.forEach(iface => {
                    const statusClass = 'status-up';
                    const inRate = this.formatRate(iface.inRate || 0);
                    const outRate = this.formatRate(iface.outRate || 0);

                    // Format IP addresses
                    let ipAddresses = 'N/A';
                    if (iface.ipAddresses && iface.ipAddresses.length > 0) {
                        ipAddresses = iface.ipAddresses.join('<br>');
                    }

                    content += `
                        <tr>
                            <td>${iface.name}</td>
                            <td><span class="status-indicator ${statusClass}">${iface.operState}</span></td>
                            <td>${ipAddresses}</td>
                            <td>${inRate}</td>
                            <td>${outRate}</td>
                        </tr>
                    `;
                });

                content += `
                        </tbody>
                    </table>
                `;
            }

            content += '</section>';

            // BGP Statistics Section
            content += `
                <section class="metrics-section">
                    <h3>BGP Statistics</h3>
            `;

            if (metrics.bgp.totalPeers === 0) {
                content += '<p class="no-data">No BGP peers configured</p>';
            } else {
                content += `
                    <div class="bgp-summary">
                        <div class="bgp-stat">
                            <span class="stat-label">Total Peers:</span>
                            <span class="stat-value">${metrics.bgp.totalPeers}</span>
                        </div>
                        <div class="bgp-stat">
                            <span class="stat-label">Active Peers:</span>
                            <span class="stat-value">${metrics.bgp.activePeers}</span>
                        </div>
                    </div>
                    <table class="metrics-table">
                        <thead>
                            <tr>
                                <th>Peer Address</th>
                                <th>Session State</th>
                                <th>Routes Received</th>
                            </tr>
                        </thead>
                        <tbody>
                `;

                metrics.bgp.neighbors.forEach(neighbor => {
                    const stateClass = neighbor.sessionState === 'established' ? 'status-up' : 'status-down';

                    content += `
                        <tr>
                            <td>${neighbor.peerAddress}</td>
                            <td><span class="status-indicator ${stateClass}">${neighbor.sessionState}</span></td>
                            <td>${neighbor.routesReceived || 0}</td>
                        </tr>
                    `;
                });

                content += `
                        </tbody>
                    </table>
                `;
            }

            content += '</section>';
            content += '</div>'; // panel-body
        }

        content += '</div>'; // panel-content

        panel.innerHTML = content;
        document.body.appendChild(panel);
        this.activePanel = panel;

        // Add close handlers
        const closeBtn = panel.querySelector('.panel-close');
        const overlay = panel.querySelector('.panel-overlay');

        const closePanel = () => {
            if (this.activePanel) {
                this.activePanel.remove();
                this.activePanel = null;
            }
        };

        closeBtn.addEventListener('click', closePanel);
        overlay.addEventListener('click', closePanel);

        // Close on ESC key
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                closePanel();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
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

        // Check if Leaf-2 has lost both connections to DCs (isolates Substation B / RTU-4)
        const leaf2Isolated = linkStates['dc1-leaf2'] === 'down' && linkStates['dc2-leaf2'] === 'down';

        console.log(`[Teleprotection] Leaf-1 isolated: ${leaf1Isolated}, Leaf-2 isolated: ${leaf2Isolated}`);

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

        if (leaf1Isolated || leaf2Isolated) {
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
});
