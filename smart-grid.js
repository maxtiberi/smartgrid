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
            transmission1: { ip: null, alive: true, lastCheck: null },
            transmission2: { ip: null, alive: true, lastCheck: null },
            transmission3: { ip: null, alive: true, lastCheck: null },
            transmission4: { ip: null, alive: true, lastCheck: null }
        };


        this.pingServiceUrl = 'http://localhost:3000';
        this.config = null;
        this.activeTooltip = null;
        this.activePanel = null;

        // Teleprotection state — driven by MPLS GOOSE comm-loss
        this.teleprotection = {
            closed: true
        };

        // true when RTU1↔RTU2 GOOSE channel is down (no IGP path or comm-loss).
        // Used to force Grid Status and Distribution Network offline independent
        // of the user's network.active switch.
        this.mplsCommLoss = false;

        this.manualOverride = false;

        // Transmission power multiplier (1.0 = 100%, 0.75 = 75%, etc.)
        // Reduced by 25% for each offline transmission unit
        this.transmissionPowerMultiplier = 1.0;

        this.init();
        // Expose instance globally so IIFEs (TPT poll, mplsTrafficFlow, popups)
        // can reach updateMplsTeleprotectionStatus, mplsCommLoss, etc.
        window.smartGrid = this;
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
        this.startLinkMonitoring();



        // Manual override toggle
        const overrideToggle = document.getElementById('manual-override-toggle');
        if (overrideToggle) {
            overrideToggle.addEventListener('change', () => this.toggleManualOverride());
        }


        // Fetch centralized config and overlay hardcoded defaults.
        // If the backend is down we keep the baked-in fallback — app still boots.
        this.loadConfig();
    }


    async loadConfig() {
        try {
            const res = await fetch(`${this.pingServiceUrl}/api/config`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const cfg = await res.json();
            this.config = cfg;
            if (cfg.grid?.cityDemandMW) this.city.demand = cfg.grid.cityDemandMW;
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

            // Force MPLS teleprotection to closed (GOOSE comm healthy)
            this.updateMplsTeleprotectionStatus(false);

            // Update stats
            this.updateInfographicStats();

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

            if (statusEl) {
                statusEl.textContent = 'Inactive';
                statusEl.className = 'override-status inactive';
            }
            if (warningEl) warningEl.classList.remove('visible');
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

        // Update grid status — offline when comm-loss even if network switch is on
        const gridStatus = document.getElementById('gridStatus');
        if (this.network.active && totalOutput > 0 && !this.mplsCommLoss) {
            gridStatus.textContent = 'online';
            gridStatus.className   = '';
        } else {
            gridStatus.textContent = 'offline';
            gridStatus.className   = this.mplsCommLoss ? 'stat-value-fault' : '';
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

        // Calculate city power — zero when MPLS comm-loss regardless of user switches
        let cityPower = 0;
        if (this.network.active && !this.mplsCommLoss) {
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
        // MPLS-based check: transmission is healthy when ACCESS1-1 and ACCESS1-3 are
        // reachable AND the GOOSE channel between RTU1 and RTU2 is active.
        this._mplsAccessAlive = null;  // null = no data yet; don't touch initial alive:true state
        this._checkMplsAccess();
        setInterval(() => this._checkMplsAccess(), 10000);
    }

    async _checkMplsAccess() {
        if (this.manualOverride) return;
        try {
            const ctrl = new AbortController();
            const tid  = setTimeout(() => ctrl.abort(), 12000);
            const res  = await fetch(`${this.pingServiceUrl}/api/mpls/access-health`, { signal: ctrl.signal });
            clearTimeout(tid);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            this._mplsAccessAlive = {
                access1: !!(data.access1?.healthy),
                access3: !!(data.access3?.healthy),
            };
            this._mplsAccessDetail = data;
        } catch (err) {
            console.warn('[MPLS] access-health check failed:', err.message);
            // On error keep previous state — don't flip to dead on transient failure
        }
        this._applyMplsTransmissionState();
        this._updateTpFaultIndicators();
    }

    _updateTpFaultIndicators() {
        const a1RtuFault = this._mplsAccessDetail?.access1?.rtuPortUp === false;
        const lineA  = document.getElementById('tp-comm-line-a');
        const faultA = document.getElementById('tp-fault-a11-rtu');
        const pulseA1 = document.getElementById('tp-pulse-a1');
        const pulseA2 = document.getElementById('tp-pulse-a2');
        if (lineA)   lineA.classList.toggle('tp-comm-line-fault', a1RtuFault);
        if (faultA)  faultA.setAttribute('display', a1RtuFault ? 'block' : 'none');
        if (pulseA1) pulseA1.style.visibility = a1RtuFault ? 'hidden' : '';
        if (pulseA2) pulseA2.style.visibility = a1RtuFault ? 'hidden' : '';
    }

    startLinkMonitoring() {
        this._checkLinkHealth();
        // Stagger from access-health (10 s) to avoid burst; re-check every 15 s.
        setInterval(() => this._checkLinkHealth(), 15000);
    }

    async _checkLinkHealth() {
        if (this.manualOverride) return;
        try {
            const ctrl = new AbortController();
            const tid  = setTimeout(() => ctrl.abort(), 14000);
            const res  = await fetch(`${this.pingServiceUrl}/api/mpls/link-health`, { signal: ctrl.signal });
            clearTimeout(tid);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            this._applyLinkHealth(data.links || {});
        } catch (err) {
            console.warn('[MPLS] link-health check failed:', err.message);
        }
    }

    _applyLinkHealth(links) {
        const faultSet = new Set();
        for (const [linkId, info] of Object.entries(links)) {
            const el = document.getElementById(linkId);
            if (!el) continue;
            const fault = info.status === 'down';
            el.classList.toggle('mpls-link-fault', fault);
            if (fault) faultSet.add(linkId);
        }
        // Notify traffic-flow module so it can reroute (or signal comm-loss)
        window.mplsTrafficFlow?.onLinkHealthUpdate(faultSet);
    }

    _applyMplsTransmissionState() {
        // No data yet — preserve initial alive:true state from constructor.
        if (this._mplsAccessAlive === null) return;

        // All three conditions must hold for the grid to receive full energy.
        const healthy = (this._mplsAccessAlive?.access1 ?? false)
                     && (this._mplsAccessAlive?.access3 ?? false)
                     && (this.teleprotection.closed);

        Object.keys(this.transmissionUnits).forEach(unitId => {
            const wasAlive = this.transmissionUnits[unitId].alive;
            this.transmissionUnits[unitId].alive      = healthy;
            this.transmissionUnits[unitId].lastCheck  = new Date();
            if (!wasAlive && healthy)  this.clearTransmissionAlert(unitId);
            if (wasAlive  && !healthy) this.showTransmissionAlert(unitId);
            this.updateTransmissionStatus(unitId, healthy);
        });
    }

    showTransmissionAlert(unitId) {
        const unitName = unitId.replace('transmission', 'T');

        // Remove existing alert if present
        const existingAlert = document.getElementById(`alert-${unitId}`);
        if (existingAlert) existingAlert.remove();

        const a1 = this._mplsAccessAlive?.access1;
        const a3 = this._mplsAccessAlive?.access3;
        const goose = this.teleprotection.closed;
        const reason = !goose  ? 'GOOSE comm-loss — RTU1↔RTU2 channel down'
                     : !a1    ? 'ACCESS1-1 (192.168.30.11) unreachable'
                     : !a3    ? 'ACCESS1-3 (192.168.30.13) unreachable'
                     :          'MPLS path degraded';

        // Create alert element
        const alertDiv = document.createElement('div');
        alertDiv.id = `alert-${unitId}`;
        alertDiv.className = 'transmission-alert';
        alertDiv.innerHTML = `
            <div class="alert-content">
                <span class="alert-icon">⚠</span>
                <div class="alert-text">
                    <strong>Transmission Unit ${unitName} — MPLS Path Lost</strong>
                    <span>${reason}</span>
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


    updateInfographicStats() {
        // Count MPLS network nodes from config
        const mplsNodes = Object.values(this.config?.mplsNetwork?.nodes || {});
        const totalNodes = mplsNodes.length || 7;
        const activeNodes = totalNodes; // MPLS node liveness driven by gnmic separately

        // Count MPLS RTUs
        const mplsRtus = Object.values(this.config?.mplsRtus || {});
        const totalRtus = mplsRtus.length || 2;
        const activeRtus = this.teleprotection.closed ? totalRtus : 0;

        const totalDevices = totalNodes + totalRtus;
        const activeDevices = activeNodes + activeRtus;

        const nodesPercentage    = 100;
        const rtusPercentage     = totalRtus > 0 ? Math.round((activeRtus / totalRtus) * 100) : 0;
        const overallPercentage  = totalDevices > 0 ? Math.round((activeDevices / totalDevices) * 100) : 0;

        const activeRoutersEl = document.getElementById('active-routers');
        const totalRoutersEl  = document.getElementById('total-routers');
        const activeRtusEl    = document.getElementById('active-rtus');
        const totalRtusEl     = document.getElementById('total-rtus');
        const activeDevicesEl = document.getElementById('active-devices');
        const totalDevicesEl  = document.getElementById('total-devices');

        if (activeRoutersEl) activeRoutersEl.textContent = activeNodes;
        if (totalRoutersEl)  totalRoutersEl.textContent  = totalNodes;
        if (activeRtusEl)    activeRtusEl.textContent    = activeRtus;
        if (totalRtusEl)     totalRtusEl.textContent     = totalRtus;
        if (activeDevicesEl) activeDevicesEl.textContent = activeDevices;
        if (totalDevicesEl)  totalDevicesEl.textContent  = totalDevices;

        this.updateRing('routers-ring', nodesPercentage);
        this.updateRing('rtus-ring', rtusPercentage);
        this.updateRing('overall-ring', overallPercentage);

        const rtusStatusText    = document.getElementById('rtus-status-text');
        const overallStatusText = document.getElementById('overall-status-text');
        if (rtusStatusText)    { rtusStatusText.textContent    = this.getStatusText(rtusPercentage);    rtusStatusText.className    = `stats-sublabel ${this.getPercentageClass(rtusPercentage)}`;    }
        if (overallStatusText) { overallStatusText.textContent = this.getStatusText(overallPercentage); overallStatusText.className = `stats-sublabel ${this.getPercentageClass(overallPercentage)}`; }
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

    // ── MPLS Teleprotection ─────────────────────────────────────────────
    // Called by the TPT poll loop or mplsTrafficFlow whenever GOOSE comm-loss
    // state changes.  Drives:
    //   • teleprotection SVG icon (closed / open)
    //   • Grid Status header (online / offline)
    //   • Distribution Network card status text
    //   • City power (forced to 0 on comm-loss)
    updateMplsTeleprotectionStatus(commLoss) {
        const changed = this.teleprotection.closed === commLoss; // closed XOR commLoss
        this.teleprotection.closed = !commLoss;

        // ── 1. Persist comm-loss flag for updateDisplay() ─────────────────
        this.mplsCommLoss = commLoss;

        // ── 2. Distribution Network card: reflect forced offline state ─────
        const distCard = document.querySelector('[data-network="distribution"]');
        if (distCard) {
            distCard.classList.toggle('mpls-forced-offline', commLoss);
            const st = distCard.querySelector('.status-text');
            if (st) {
                st.textContent = commLoss ? 'offline'
                               : (this.network.active ? 'online' : 'offline');
                st.classList.toggle('status-fault', commLoss);
            }
        }

        // ── 3. Force all transmission units offline on comm-loss ───────────
        //    (belt-and-suspenders: _applyMplsTransmissionState may return early
        //     if _mplsAccessAlive is still null during startup)
        if (commLoss) {
            Object.keys(this.transmissionUnits).forEach(unitId => {
                const wasAlive = this.transmissionUnits[unitId].alive;
                this.transmissionUnits[unitId].alive = false;
                if (wasAlive) this.showTransmissionAlert(unitId);
                this.updateTransmissionStatus(unitId, false);
            });
        }

        // ── 4. Re-evaluate via normal MPLS state machine too ─────────────
        // When GOOSE state changes, immediately re-evaluate transmission health
        // (don't wait for the next 10s ping cycle).
        if (changed) this._applyMplsTransmissionState();

        const closedIcon = document.getElementById('teleprotection-closed');
        const openIcon   = document.getElementById('teleprotection-open');
        const stateText  = document.getElementById('teleprotection-state-text');

        if (commLoss) {
            if (closedIcon) closedIcon.style.display = 'none';
            if (openIcon)   openIcon.style.display   = 'block';
            if (stateText)  { stateText.textContent = 'COMM LOSS / APERTO'; stateText.className = 'teleprotection-state open'; }
        } else {
            if (closedIcon) closedIcon.style.display = 'block';
            if (openIcon)   openIcon.style.display   = 'none';
            if (stateText)  { stateText.textContent = 'CHIUSO / CLOSED'; stateText.className = 'teleprotection-state closed'; }
        }

        // Update MPLS RTU GOOSE status indicators
        const rtu1El = document.getElementById('mpls-rtu1-status');
        const rtu2El = document.getElementById('mpls-rtu2-status');
        const dot1 = commLoss ? '<span class="status-dot fault"></span>' : '<span class="status-dot ok"></span>';
        const dot2 = commLoss ? '<span class="status-dot fault"></span>' : '<span class="status-dot ok"></span>';
        if (rtu1El) rtu1El.innerHTML = commLoss ? `RTU1: ${dot1}Comm Loss` : `RTU1: ${dot1}GOOSE Active`;
        if (rtu2El) rtu2El.innerHTML = commLoss ? `RTU2: ${dot2}Comm Loss` : `RTU2: ${dot2}GOOSE Active`;

        // Update teleprotection diagram LEDs if elements exist
        const tpEquipA = document.querySelector('.tp-equip-a');
        const tpEquipB = document.querySelector('.tp-equip-b');
        if (tpEquipA) {
            tpEquipA.querySelectorAll('.tp-led').forEach(led => led.setAttribute('fill', commLoss ? '#dc3545' : '#4caf50'));
            tpEquipA.classList.toggle('tp-fault', commLoss);
        }
        if (tpEquipB) {
            tpEquipB.querySelectorAll('.tp-led').forEach(led => led.setAttribute('fill', commLoss ? '#dc3545' : '#4caf50'));
            tpEquipB.classList.toggle('tp-fault', commLoss);
        }

        this.updateInfographicStats();

        // ── 5. Alarm / restore Generation plant cards ─────────────────────
        document.querySelectorAll('.plant-card').forEach(card => {
            card.classList.toggle('plant-alarmed', commLoss);
        });

        // ── 6. MPLS section offline visual indicator ──────────────────────
        const mplsSection = document.querySelector('.mpls-section');
        if (mplsSection) mplsSection.classList.toggle('mpls-comm-loss', commLoss);

        // ── 7. Refresh Grid Status header and city power immediately ───────
        this.updateDisplay();
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

    // --- gNMI Service Controller ---------------------------------------
    // Single controller that drives BOTH UIs simultaneously:
    (function initPingServiceStatus() {
        const container = document.getElementById('ping-svc-status');
        const label     = document.getElementById('ping-svc-text');
        if (!container) return;

        async function check() {
            try {
                const r = await fetch('http://localhost:3000/health',
                                      { signal: AbortSignal.timeout(4000) });
                if (r.ok) {
                    container.dataset.state = 'running';
                    label.textContent = 'RUNNING · :3000';
                } else throw new Error();
            } catch {
                container.dataset.state = 'offline';
                label.textContent = 'OFFLINE';
            }
        }
        check();
        setInterval(check, 10000);
    })();

    // ================================================================
    // DC1 LIVE TELEMETRY POPUP
    // Triggered by clicking the DC1 node in the MPLS topology SVG.
    // Fetches live data via GET /gnmic/node/mpls-dc1 (ping-service,
    // port 3000) which runs docker exec gnmic internally.
    // ================================================================
    (function initDc1Popup() {
        const PING_BASE   = 'http://localhost:3000';
        const NODE_ID     = 'mpls-dc1';
        const NODE_NAME   = 'dc1';

        // DOM refs
        const overlay    = document.getElementById('dc1-popup-overlay');
        const closeBtn   = document.getElementById('dc1-popup-close-btn');
        const refreshBtn = document.getElementById('dc1-popup-refresh-btn');
        const loading    = document.getElementById('dc1-popup-loading');
        const errorBox   = document.getElementById('dc1-popup-error');
        const errorText  = document.getElementById('dc1-popup-error-text');
        const body       = document.getElementById('dc1-popup-body');
        const tsEl       = document.getElementById('dc1-popup-ts');
        const portGrid   = document.getElementById('dc1-popup-port-grid');
        const portsCount = document.getElementById('dc1-popup-ports-count');
        const ifacesBody = document.getElementById('dc1-popup-ifaces-body');
        const ifacesCount= document.getElementById('dc1-popup-ifaces-count');
        // IS-IS section
        const isisLed    = document.getElementById('dc1-popup-isis-led');
        const isisState  = document.getElementById('dc1-popup-isis-state');
        const isisLevels = document.getElementById('dc1-popup-isis-levels');
        const isisBody   = document.getElementById('dc1-popup-isis-body');
        // Segment Routing section
        const srLed      = document.getElementById('dc1-popup-sr-led');
        const srState    = document.getElementById('dc1-popup-sr-state');
        const srSummary  = document.getElementById('dc1-popup-sr-summary');
        const srBody     = document.getElementById('dc1-popup-sr-body');
        // SVG node group (click target)
        const dc1SvgNode = document.getElementById('mpls-node-mpls-dc1');
        // SVG port tiles (for live colour sync)
        const svgPortMap = {
            '1/1/c1':   document.getElementById('dc1-svg-port-c1'),
            '1/1/c2':   document.getElementById('dc1-svg-port-c2'),
            '1/1/c3':   document.getElementById('dc1-svg-port-c3'),
            '1/1/c4':   document.getElementById('dc1-svg-port-c4'),
            '1/1/c5':   document.getElementById('dc1-svg-port-c5'),
        };

        if (!overlay) return; // Guard: HTML section may be absent

        // ── Helpers ─────────────────────────────────────────────────
        function fmt0(n) {
            if (n == null) return '—';
            if (n >= 1e9) return (n/1e9).toFixed(1)+'G';
            if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
            if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
            return String(n);
        }

        function stateHtml(s) {
            const lo = (s || '').toLowerCase();
            const cls = (lo === 'up' || lo === 'inservice') ? 'state-up'
                      : (lo === 'down' || lo === 'outofservice') ? 'state-down'
                      : 'state-unknown';
            const label = lo === 'inservice' ? 'UP' : lo === 'outofservice' ? 'DOWN' : (s||'?').toUpperCase();
            return `<span class="dc1-iface-state ${cls}"><span class="dc1-iface-led"></span>${label}</span>`;
        }

        // ── Uptime formatter ────────────────────────────────────────
        function formatUptime(secs) {
            if (secs == null || secs === 0) return '—';
            if (secs < 60)   return `${secs}s`;
            if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
            const h = Math.floor(secs / 3600);
            const m = Math.floor((secs % 3600) / 60);
            return `${h}h ${m}m`;
        }

        // ── IS-IS section renderer ──────────────────────────────────
        function renderIsisSection(isis) {
            if (!isis) return;

            // Overall state LED + text
            const isUp = isis.operState === 'up';
            if (isisLed)   isisLed.setAttribute('data-state', isUp ? 'up' : 'down');
            if (isisState) isisState.textContent = isis.operState ? isis.operState.toUpperCase() : '—';

            // Level badges
            if (isisLevels) {
                const levels = isis.levels || [];
                if (levels.length === 0) {
                    isisLevels.innerHTML = '';
                } else {
                    isisLevels.innerHTML = levels.map(l => {
                        const overloaded = l.overload && l.overload !== 'not-in-overload';
                        const cls = overloaded ? ' overloaded' : '';
                        const warn = overloaded ? ' ⚠' : '';
                        return `<span class="dc1-isis-level-badge${cls}">L${l.level} · ${l.lsps} LSP${l.lsps !== 1 ? 's' : ''}${warn}</span>`;
                    }).join('');
                }
            }

            // Adjacency table — flatten all non-system interfaces
            if (isisBody) {
                const rows = [];
                (isis.interfaces || []).forEach(iface => {
                    if (iface.name === 'system') return;   // loopback, skip
                    (iface.adjacencies || []).forEach(adj => {
                        rows.push({ ifaceName: iface.name, ...adj });
                    });
                });

                if (rows.length === 0) {
                    isisBody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#888;padding:14px 0">no active adjacencies</td></tr>';
                } else {
                    isisBody.innerHTML = rows.map(r => `<tr>
                        <td>${r.ifaceName}</td>
                        <td class="dc1-ip-addr">${r.neighborIp}</td>
                        <td><span class="dc1-isis-level-tag">${r.level}</span></td>
                        <td>${stateHtml(r.operState)}</td>
                        <td class="dc1-isis-uptime">${formatUptime(r.uptime)}</td>
                    </tr>`).join('');
                }
            }
        }

        // ── Port grid renderer ───────────────────────────────────────
        function renderPortGrid(ports) {
            if (!portGrid) return;
            portGrid.innerHTML = '';
            const upCount = ports.filter(p => p.operState === 'up').length;
            if (portsCount) portsCount.textContent = `${upCount}/${ports.length} up`;

            ports.forEach(p => {
                const isUp        = p.operState === 'up';
                const isBreakout  = /\/\d+$/.test(p.portId) && p.portId.includes('/c');
                const isMgmt      = p.portId.startsWith('A/') || p.portId.startsWith('B/');
                const tileClass   = isMgmt ? 'port-mgmt' : isBreakout ? 'port-breakout' : 'port-connector';
                const ledClass    = isUp ? 'port-up' : 'port-down';

                const tile = document.createElement('div');
                tile.className = `dc1-port-tile ${tileClass}`;
                tile.title    = `${p.portId}: ${p.operState.toUpperCase()}`;
                tile.innerHTML = `
                    <div class="dc1-port-tile-led ${ledClass}"></div>
                    <span class="dc1-port-tile-id">${p.portId.replace('1/1/', '')}</span>`;
                portGrid.appendChild(tile);

                // Also update the matching SVG chassis port rect
                const svgPort = svgPortMap[p.portId];
                if (svgPort) {
                    svgPort.setAttribute('fill', isUp ? '#3a6a4a' : '#3a3a4a');
                }
            });
        }

        // ── Interface table renderer ─────────────────────────────────
        function renderIfaceTable(ifaces) {
            if (!ifacesBody) return;
            if (!ifaces || ifaces.length === 0) {
                ifacesBody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888;padding:16px">no interface data</td></tr>';
                return;
            }
            // Sort: Base router first, then alphabetically
            const sorted = [...ifaces].sort((a, b) => {
                if (a.router !== b.router) return a.router === 'Base' ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            const upCount = sorted.filter(i => i.operState === 'up').length;
            if (ifacesCount) ifacesCount.textContent = `${upCount}/${sorted.length} up`;

            ifacesBody.innerHTML = sorted.map(i => {
                const isMgmt  = i.router !== 'Base';
                const rdgBadge= isMgmt
                    ? `<span class="dc1-router-badge badge-mgmt">${i.router}</span>`
                    : `<span class="dc1-router-badge">Base</span>`;
                const ipHtml  = i.ipv4
                    ? `<span class="dc1-ip-addr">${i.ipv4}</span>`
                    : `<span class="dc1-ip-addr empty">—</span>`;
                return `<tr>
                    <td>${rdgBadge}</td>
                    <td>${i.name}</td>
                    <td>${stateHtml(i.operState)}</td>
                    <td>${ipHtml}</td>
                    <td>${fmt0(i.inPkts)}</td>
                    <td>${fmt0(i.outPkts)}</td>
                </tr>`;
            }).join('');
        }

        // ── Segment Routing section renderer ────────────────────────
        function renderSrSection(sr) {
            if (!sr) return;
            const adjSids = sr.adjSids || [];
            const pol     = sr.policies || {};

            const srActive = adjSids.length > 0;
            if (srLed)   srLed.setAttribute('data-state', srActive ? 'up' : 'down');
            if (srState) srState.textContent = `${adjSids.length} adj-SID${adjSids.length !== 1 ? 's' : ''}`;

            if (srSummary) {
                const stats = [
                    { v: adjSids.length,                          l: 'Adj-SIDs' },
                    { v: pol.bindingSidsAllocated  ?? '—',        l: 'Binding SIDs' },
                    { v: pol.ttmPreferences        ?? '—',        l: 'TTM Prefs' },
                    { v: pol.activeBgpPolicies     ?? '—',        l: 'Active BGP Pol' },
                    { v: pol.activeStaticLocalPolicies ?? '—',    l: 'Static Pol' }
                ];
                srSummary.innerHTML = stats.map(s =>
                    `<div class="dc-sr-stat">
                        <span class="dc-sr-stat-value">${s.v}</span>
                        <span class="dc-sr-stat-label">${s.l}</span>
                    </div>`
                ).join('');
            }

            if (srBody) {
                srBody.innerHTML = adjSids.length === 0
                    ? '<tr><td colspan="5" style="text-align:center;color:#888;padding:14px 0">no adjacency SIDs</td></tr>'
                    : adjSids.map(s => {
                        const protHtml   = s.sidProtected
                            ? '<span class="dc-sr-protected">Protected</span>'
                            : '<span class="dc-sr-unprotected">—</span>';
                        const typeLabel  = (s.sidType || '').replace('mpls-label', 'MPLS');
                        return `<tr>
                            <td>${s.ifaceName}</td>
                            <td><span class="dc-sr-sid-badge">${s.sidValue ?? '—'}</span></td>
                            <td><span class="dc-sr-type-chip">${typeLabel}</span></td>
                            <td>${protHtml}</td>
                            <td class="dc-sr-backup-ip">${s.backupIp}</td>
                        </tr>`;
                    }).join('');
            }
        }

        // ── Fetch & render ───────────────────────────────────────────
        async function loadData() {
            // Reset to loading state
            if (loading)  loading.style.display  = 'flex';
            if (errorBox) errorBox.style.display  = 'none';
            if (body)     body.style.display      = 'none';
            if (refreshBtn) refreshBtn.disabled   = true;

            try {
                const res = await fetch(`${PING_BASE}/gnmic/node/${NODE_ID}`, { cache: 'no-store' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (data.error) throw new Error(data.error);

                // Timestamp badge
                if (tsEl) {
                    const t = new Date(data.ts);
                    tsEl.textContent = `${t.toLocaleTimeString()} · gnmic`;
                }

                renderPortGrid(data.ports || []);
                renderIfaceTable(data.interfaces || []);
                renderIsisSection(data.isis || null);
                renderSrSection(data.sr || null);

                // Show body
                if (loading) loading.style.display = 'none';
                if (body)    body.style.display    = 'block';

            } catch (err) {
                if (loading)    loading.style.display = 'none';
                if (errorBox)   errorBox.style.display = 'flex';
                if (errorText)  errorText.textContent =
                    `gnmic unreachable: ${err.message} — is ping-service.js running?`;
            } finally {
                if (refreshBtn) refreshBtn.disabled = false;
            }
        }

        // ── Open / Close ─────────────────────────────────────────────
        function openPopup() {
            overlay.style.display = 'flex';
            document.body.style.overflow = 'hidden';
            loadData();
        }

        function closePopup() {
            overlay.style.display = 'none';
            document.body.style.overflow = '';
        }

        // ── Event wiring ─────────────────────────────────────────────
        // Click on DC1 SVG node
        if (dc1SvgNode) {
            dc1SvgNode.addEventListener('click', openPopup);
            dc1SvgNode.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPopup(); }
            });
        }

        // Close button
        if (closeBtn) closeBtn.addEventListener('click', closePopup);

        // Refresh button
        if (refreshBtn) refreshBtn.addEventListener('click', loadData);

        // Click outside card to close
        overlay.addEventListener('click', e => {
            if (e.target === overlay) closePopup();
        });

        // ESC key
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && overlay.style.display !== 'none') closePopup();
        });

        // Console helper
        window.dc1Popup = { open: openPopup, close: closePopup, refresh: loadData };
    })();

    // ================================================================
    // DC2 LIVE TELEMETRY POPUP
    // Opened when user clicks the dc2 SVG node in MPLS NETWORK.
    // Fetches from ping-service /gnmic/node/mpls-dc2 which runs
    // docker exec gnmic for ports, interfaces, IS-IS, and SR adj-SIDs.
    // ================================================================
    (function initDc2Popup() {
        const PING_BASE = 'http://localhost:3000';
        const NODE_ID   = 'mpls-dc2';

        // DOM refs
        const overlay    = document.getElementById('dc2-popup-overlay');
        const closeBtn   = document.getElementById('dc2-popup-close-btn');
        const refreshBtn = document.getElementById('dc2-popup-refresh-btn');
        const loading    = document.getElementById('dc2-popup-loading');
        const errorBox   = document.getElementById('dc2-popup-error');
        const errorText  = document.getElementById('dc2-popup-error-text');
        const body       = document.getElementById('dc2-popup-body');
        const tsEl       = document.getElementById('dc2-popup-ts');
        const portGrid   = document.getElementById('dc2-popup-port-grid');
        const portsCount = document.getElementById('dc2-popup-ports-count');
        const ifacesBody = document.getElementById('dc2-popup-ifaces-body');
        const ifacesCount= document.getElementById('dc2-popup-ifaces-count');
        // IS-IS
        const isisLed    = document.getElementById('dc2-popup-isis-led');
        const isisState  = document.getElementById('dc2-popup-isis-state');
        const isisLevels = document.getElementById('dc2-popup-isis-levels');
        const isisBody   = document.getElementById('dc2-popup-isis-body');
        // Segment Routing
        const srLed      = document.getElementById('dc2-popup-sr-led');
        const srState    = document.getElementById('dc2-popup-sr-state');
        const srSummary  = document.getElementById('dc2-popup-sr-summary');
        const srBody     = document.getElementById('dc2-popup-sr-body');
        // SVG node + port tiles
        const dc2SvgNode = document.getElementById('mpls-node-mpls-dc2');
        const svgPortMap = {
            '1/1/c1':   document.getElementById('dc2-svg-port-c1'),
            '1/1/c2':   document.getElementById('dc2-svg-port-c2'),
            '1/1/c3':   document.getElementById('dc2-svg-port-c3'),
            '1/1/c4':   document.getElementById('dc2-svg-port-c4'),
            '1/1/c5':   document.getElementById('dc2-svg-port-c5'),
        };

        if (!overlay) return;

        // ── Helpers ─────────────────────────────────────────────────
        function fmt0(n) {
            if (n == null) return '—';
            if (n >= 1e9) return (n/1e9).toFixed(1)+'G';
            if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
            if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
            return String(n);
        }
        function stateHtml(s) {
            const lo = (s || '').toLowerCase();
            const cls = (lo === 'up' || lo === 'inservice') ? 'state-up'
                      : (lo === 'down' || lo === 'outofservice') ? 'state-down'
                      : 'state-unknown';
            const label = lo === 'inservice' ? 'UP' : lo === 'outofservice' ? 'DOWN' : (s||'?').toUpperCase();
            return `<span class="dc1-iface-state ${cls}"><span class="dc1-iface-led"></span>${label}</span>`;
        }
        function fmtUptime(secs) {
            if (secs == null || secs === 0) return '—';
            if (secs < 60)   return `${secs}s`;
            if (secs < 3600) return `${Math.floor(secs/60)}m ${secs%60}s`;
            const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60);
            return `${h}h ${m}m`;
        }

        // ── Port grid ────────────────────────────────────────────────
        function renderPortGrid(ports) {
            if (!portGrid) return;
            portGrid.innerHTML = '';
            const upCount = ports.filter(p => p.operState === 'up').length;
            if (portsCount) portsCount.textContent = `${upCount}/${ports.length} up`;
            ports.forEach(p => {
                const isUp       = p.operState === 'up';
                const isBreakout = /\/\d+$/.test(p.portId) && p.portId.includes('/c');
                const isMgmt     = p.portId.startsWith('A/') || p.portId.startsWith('B/');
                const tileClass  = isMgmt ? 'port-mgmt' : isBreakout ? 'port-breakout' : 'port-connector';
                const tile = document.createElement('div');
                tile.className = `dc1-port-tile ${tileClass}`;
                tile.title = `${p.portId}: ${p.operState.toUpperCase()}`;
                tile.innerHTML = `
                    <div class="dc1-port-tile-led ${isUp ? 'port-up' : 'port-down'}"></div>
                    <span class="dc1-port-tile-id">${p.portId.replace('1/1/', '')}</span>`;
                portGrid.appendChild(tile);
                const svgPort = svgPortMap[p.portId];
                if (svgPort) svgPort.setAttribute('fill', isUp ? '#3a6a4a' : '#3a3a4a');
            });
        }

        // ── Interface table ──────────────────────────────────────────
        function renderIfaceTable(ifaces) {
            if (!ifacesBody) return;
            if (!ifaces || ifaces.length === 0) {
                ifacesBody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888;padding:16px">no interface data</td></tr>';
                return;
            }
            const sorted = [...ifaces].sort((a, b) => {
                if (a.router !== b.router) return a.router === 'Base' ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            const upCount = sorted.filter(i => i.operState === 'up').length;
            if (ifacesCount) ifacesCount.textContent = `${upCount}/${sorted.length} up`;
            ifacesBody.innerHTML = sorted.map(i => {
                const isMgmt  = i.router !== 'Base';
                const badge   = isMgmt
                    ? `<span class="dc1-router-badge badge-mgmt">${i.router}</span>`
                    : `<span class="dc1-router-badge">Base</span>`;
                const ipHtml  = i.ipv4
                    ? `<span class="dc1-ip-addr">${i.ipv4}</span>`
                    : `<span class="dc1-ip-addr empty">—</span>`;
                return `<tr>
                    <td>${badge}</td>
                    <td>${i.name}</td>
                    <td>${stateHtml(i.operState)}</td>
                    <td>${ipHtml}</td>
                    <td>${fmt0(i.inPkts)}</td>
                    <td>${fmt0(i.outPkts)}</td>
                </tr>`;
            }).join('');
        }

        // ── IS-IS section ────────────────────────────────────────────
        function renderIsisSection(isis) {
            if (!isis) return;
            const isUp = isis.operState === 'up';
            if (isisLed)   isisLed.setAttribute('data-state', isUp ? 'up' : 'down');
            if (isisState) isisState.textContent = isUp ? 'UP' : (isis.operState || '—').toUpperCase();
            if (isisLevels) {
                isisLevels.innerHTML = (isis.levels || []).map(l => {
                    const over = l.overload && l.overload !== 'not-in-overload';
                    return `<span class="dc1-isis-level-badge${over ? ' overloaded' : ''}">L${l.level} · ${l.lsps} LSP${l.lsps !== 1 ? 's' : ''}${over ? ' ⚠' : ''}</span>`;
                }).join('');
            }
            if (isisBody) {
                const rows = [];
                (isis.interfaces || []).forEach(ifc => {
                    if (ifc.name === 'system') return;
                    (ifc.adjacencies || []).forEach(adj => rows.push({ ifaceName: ifc.name, ...adj }));
                });
                isisBody.innerHTML = rows.length === 0
                    ? '<tr><td colspan="5" style="text-align:center;color:#888;padding:14px 0">no active adjacencies</td></tr>'
                    : rows.map(r => `<tr>
                        <td>${r.ifaceName}</td>
                        <td class="dc1-ip-addr">${r.neighborIp}</td>
                        <td><span class="dc1-isis-level-tag">${r.level}</span></td>
                        <td>${stateHtml(r.operState)}</td>
                        <td class="dc1-isis-uptime">${fmtUptime(r.uptime)}</td>
                      </tr>`).join('');
            }
        }

        // ── Segment Routing section ──────────────────────────────────
        function renderSrSection(sr) {
            if (!sr) return;
            const adjSids = sr.adjSids || [];
            const pol     = sr.policies || {};

            // LED: up when at least one adj-SID exists with a valid label
            const hasActiveSids = adjSids.some(s => s.sidValue != null && s.sidValue !== 524287);
            // 524287 = max-label / unallocated sentinel in srsim
            const srActive = adjSids.length > 0;
            if (srLed)   srLed.setAttribute('data-state', srActive ? 'up' : 'down');
            if (srState) srState.textContent = `${adjSids.length} adj-SID${adjSids.length !== 1 ? 's' : ''}`;

            // Summary stats row
            if (srSummary) {
                const stats = [
                    { v: adjSids.length,                         l: 'Adj-SIDs' },
                    { v: pol.bindingSidsAllocated ?? '—',        l: 'Binding SIDs' },
                    { v: pol.ttmPreferences       ?? '—',        l: 'TTM Prefs' },
                    { v: pol.activeBgpPolicies    ?? '—',        l: 'Active BGP Pol' },
                    { v: pol.activeStaticLocalPolicies ?? '—',   l: 'Static Pol' }
                ];
                srSummary.innerHTML = stats.map(s =>
                    `<div class="dc-sr-stat">
                        <span class="dc-sr-stat-value">${s.v}</span>
                        <span class="dc-sr-stat-label">${s.l}</span>
                    </div>`
                ).join('');
            }

            // Adjacency-SID table
            if (srBody) {
                srBody.innerHTML = adjSids.length === 0
                    ? '<tr><td colspan="5" style="text-align:center;color:#888;padding:14px 0">no adjacency SIDs</td></tr>'
                    : adjSids.map(s => {
                        const protHtml = s.sidProtected
                            ? '<span class="dc-sr-protected">Protected</span>'
                            : '<span class="dc-sr-unprotected">—</span>';
                        const typeLabel = (s.sidType || '').replace('mpls-label', 'MPLS');
                        return `<tr>
                            <td>${s.ifaceName}</td>
                            <td><span class="dc-sr-sid-badge">${s.sidValue ?? '—'}</span></td>
                            <td><span class="dc-sr-type-chip">${typeLabel}</span></td>
                            <td>${protHtml}</td>
                            <td class="dc-sr-backup-ip">${s.backupIp}</td>
                        </tr>`;
                    }).join('');
            }
        }

        // ── Fetch & render ───────────────────────────────────────────
        async function loadData() {
            if (loading)    loading.style.display  = 'flex';
            if (errorBox)   errorBox.style.display = 'none';
            if (body)       body.style.display     = 'none';
            if (refreshBtn) refreshBtn.disabled    = true;

            try {
                const res = await fetch(`${PING_BASE}/gnmic/node/${NODE_ID}`, { cache: 'no-store' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (data.error) throw new Error(data.error);

                if (tsEl) {
                    const t = new Date(data.ts);
                    tsEl.textContent = `${t.toLocaleTimeString()} · gnmic`;
                }

                renderPortGrid(data.ports || []);
                renderIfaceTable(data.interfaces || []);
                renderIsisSection(data.isis || null);
                renderSrSection(data.sr || null);

                if (loading) loading.style.display = 'none';
                if (body)    body.style.display    = 'block';

            } catch (err) {
                if (loading)   loading.style.display = 'none';
                if (errorBox)  errorBox.style.display = 'flex';
                if (errorText) errorText.textContent =
                    `gnmic unreachable: ${err.message} — is ping-service.js running?`;
            } finally {
                if (refreshBtn) refreshBtn.disabled = false;
            }
        }

        function openPopup()  { overlay.style.display = 'flex'; document.body.style.overflow = 'hidden'; loadData(); }
        function closePopup() { overlay.style.display = 'none'; document.body.style.overflow = ''; }

        if (dc2SvgNode) {
            dc2SvgNode.addEventListener('click', openPopup);
            dc2SvgNode.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPopup(); }
            });
        }
        if (closeBtn)   closeBtn.addEventListener('click', closePopup);
        if (refreshBtn) refreshBtn.addEventListener('click', loadData);
        overlay.addEventListener('click', e => { if (e.target === overlay) closePopup(); });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && overlay.style.display !== 'none') closePopup();
        });

        window.dc2Popup = { open: openPopup, close: closePopup, refresh: loadData };
    })();

    // ================================================================
    // ACCESS1-1 LIVE TELEMETRY POPUP
    // Triggered by clicking ACCESS1-1 in the MPLS topology SVG.
    // Fetches /gnmic/node/mpls-a1-1 from ping-service (port 3000).
    // ================================================================
    (function initA11Popup() {
        const PING_BASE = 'http://localhost:3000';
        const NODE_ID   = 'mpls-a1-1';

        const overlay    = document.getElementById('a11-popup-overlay');
        const closeBtn   = document.getElementById('a11-popup-close-btn');
        const refreshBtn = document.getElementById('a11-popup-refresh-btn');
        const loading    = document.getElementById('a11-popup-loading');
        const errorBox   = document.getElementById('a11-popup-error');
        const errorText  = document.getElementById('a11-popup-error-text');
        const body       = document.getElementById('a11-popup-body');
        const tsEl       = document.getElementById('a11-popup-ts');
        const portGrid   = document.getElementById('a11-popup-port-grid');
        const portsCount = document.getElementById('a11-popup-ports-count');
        const ifacesBody = document.getElementById('a11-popup-ifaces-body');
        const ifacesCount= document.getElementById('a11-popup-ifaces-count');
        const isisLed    = document.getElementById('a11-popup-isis-led');
        const isisState  = document.getElementById('a11-popup-isis-state');
        const isisLevels = document.getElementById('a11-popup-isis-levels');
        const isisBody   = document.getElementById('a11-popup-isis-body');
        const srLed      = document.getElementById('a11-popup-sr-led');
        const srState    = document.getElementById('a11-popup-sr-state');
        const srSummary  = document.getElementById('a11-popup-sr-summary');
        const srBody     = document.getElementById('a11-popup-sr-body');
        const lspLed     = document.getElementById('a11-popup-lsp-led');
        const lspState   = document.getElementById('a11-popup-lsp-state');
        const lspSummary = document.getElementById('a11-popup-lsp-summary');
        const svgNode    = document.getElementById('mpls-node-mpls-a1-1');
        const svgPortMap = {
            '1/1/c1': document.getElementById('a11-svg-port-c1'),
            '1/1/c2': document.getElementById('a11-svg-port-c2'),
            '1/1/c3': document.getElementById('a11-svg-port-c3'),
            '1/1/c4': document.getElementById('a11-svg-port-c4'),
            '1/1/c5': document.getElementById('a11-svg-port-c5'),
        };

        if (!overlay) return;

        function fmt0(n) {
            if (n == null) return '—';
            if (n >= 1e9) return (n/1e9).toFixed(1)+'G';
            if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
            if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
            return String(n);
        }

        function stateHtml(s) {
            const lo = (s || '').toLowerCase();
            const cls = (lo === 'up' || lo === 'inservice') ? 'state-up'
                      : (lo === 'down' || lo === 'outofservice') ? 'state-down'
                      : 'state-unknown';
            const label = lo === 'inservice' ? 'UP' : lo === 'outofservice' ? 'DOWN' : (s||'?').toUpperCase();
            return `<span class="dc1-iface-state ${cls}"><span class="dc1-iface-led"></span>${label}</span>`;
        }

        function formatUptime(secs) {
            if (secs == null || secs === 0) return '—';
            if (secs < 60)   return `${secs}s`;
            if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
            const h = Math.floor(secs / 3600);
            const m = Math.floor((secs % 3600) / 60);
            return `${h}h ${m}m`;
        }

        function renderPortGrid(ports) {
            if (!portGrid) return;
            portGrid.innerHTML = '';
            const upCount = ports.filter(p => p.operState === 'up').length;
            if (portsCount) portsCount.textContent = `${upCount}/${ports.length} up`;
            ports.forEach(p => {
                const isUp       = p.operState === 'up';
                const isBreakout = /\/\d+$/.test(p.portId) && p.portId.includes('/c');
                const isMgmt     = p.portId.startsWith('A/') || p.portId.startsWith('B/');
                const tileClass  = isMgmt ? 'port-mgmt' : isBreakout ? 'port-breakout' : 'port-connector';
                const tile = document.createElement('div');
                tile.className = `dc1-port-tile ${tileClass}`;
                tile.title     = `${p.portId}: ${p.operState.toUpperCase()}`;
                tile.innerHTML = `
                    <div class="dc1-port-tile-led ${isUp ? 'port-up' : 'port-down'}"></div>
                    <span class="dc1-port-tile-id">${p.portId.replace('1/1/', '')}</span>`;
                portGrid.appendChild(tile);
                const svgPort = svgPortMap[p.portId];
                if (svgPort) svgPort.setAttribute('fill', isUp ? '#3a6a4a' : '#3a3a4a');
            });
        }

        function renderIfaceTable(ifaces) {
            if (!ifacesBody) return;
            if (!ifaces || ifaces.length === 0) {
                ifacesBody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888;padding:16px">no interface data</td></tr>';
                return;
            }
            const sorted = [...ifaces].sort((a, b) => {
                if (a.router !== b.router) return a.router === 'Base' ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            const upCount = sorted.filter(i => i.operState === 'up').length;
            if (ifacesCount) ifacesCount.textContent = `${upCount}/${sorted.length} up`;
            ifacesBody.innerHTML = sorted.map(i => {
                const isMgmt   = i.router !== 'Base';
                const rdgBadge = isMgmt
                    ? `<span class="dc1-router-badge badge-mgmt">${i.router}</span>`
                    : `<span class="dc1-router-badge">Base</span>`;
                const ipHtml = i.ipv4
                    ? `<span class="dc1-ip-addr">${i.ipv4}</span>`
                    : `<span class="dc1-ip-addr empty">—</span>`;
                return `<tr>
                    <td>${rdgBadge}</td>
                    <td>${i.name}</td>
                    <td>${stateHtml(i.operState)}</td>
                    <td>${ipHtml}</td>
                    <td>${fmt0(i.inPkts)}</td>
                    <td>${fmt0(i.outPkts)}</td>
                </tr>`;
            }).join('');
        }

        function renderIsisSection(isis) {
            if (!isis) return;
            const isUp = isis.operState === 'up';
            if (isisLed)   isisLed.setAttribute('data-state', isUp ? 'up' : 'down');
            if (isisState) isisState.textContent = isis.operState ? isis.operState.toUpperCase() : '—';
            if (isisLevels) {
                const levels = isis.levels || [];
                isisLevels.innerHTML = levels.length === 0 ? '' : levels.map(l => {
                    const overloaded = l.overload && l.overload !== 'not-in-overload';
                    return `<span class="dc1-isis-level-badge${overloaded ? ' overloaded' : ''}">L${l.level} · ${l.lsps} LSP${l.lsps !== 1 ? 's' : ''}${overloaded ? ' ⚠' : ''}</span>`;
                }).join('');
            }
            if (isisBody) {
                const rows = [];
                (isis.interfaces || []).forEach(iface => {
                    if (iface.name === 'system') return;
                    (iface.adjacencies || []).forEach(adj => rows.push({ ifaceName: iface.name, ...adj }));
                });
                isisBody.innerHTML = rows.length === 0
                    ? '<tr><td colspan="5" style="text-align:center;color:#888;padding:14px 0">no active adjacencies</td></tr>'
                    : rows.map(r => `<tr>
                        <td>${r.ifaceName}</td>
                        <td class="dc1-ip-addr">${r.neighborIp}</td>
                        <td><span class="dc1-isis-level-tag">${r.level}</span></td>
                        <td>${stateHtml(r.operState)}</td>
                        <td class="dc1-isis-uptime">${formatUptime(r.uptime)}</td>
                    </tr>`).join('');
            }
        }

        function renderSrSection(sr) {
            if (!sr) return;
            const adjSids  = sr.adjSids  || [];
            const pol      = sr.policies || {};
            const srActive = adjSids.length > 0;
            if (srLed)   srLed.setAttribute('data-state', srActive ? 'up' : 'down');
            if (srState) srState.textContent = `${adjSids.length} adj-SID${adjSids.length !== 1 ? 's' : ''}`;
            if (srSummary) {
                srSummary.innerHTML = [
                    { v: adjSids.length,                          l: 'Adj-SIDs' },
                    { v: pol.bindingSidsAllocated  ?? '—',        l: 'Binding SIDs' },
                    { v: pol.ttmPreferences        ?? '—',        l: 'TTM Prefs' },
                    { v: pol.activeBgpPolicies     ?? '—',        l: 'Active BGP Pol' },
                    { v: pol.activeStaticLocalPolicies ?? '—',    l: 'Static Pol' }
                ].map(s => `<div class="dc-sr-stat">
                    <span class="dc-sr-stat-value">${s.v}</span>
                    <span class="dc-sr-stat-label">${s.l}</span>
                </div>`).join('');
            }
            if (srBody) {
                srBody.innerHTML = adjSids.length === 0
                    ? '<tr><td colspan="5" style="text-align:center;color:#888;padding:14px 0">no adjacency SIDs</td></tr>'
                    : adjSids.map(s => `<tr>
                        <td>${s.ifaceName}</td>
                        <td><span class="dc-sr-sid-badge">${s.sidValue ?? '—'}</span></td>
                        <td><span class="dc-sr-type-chip">${(s.sidType || '').replace('mpls-label', 'MPLS')}</span></td>
                        <td>${s.sidProtected ? '<span class="dc-sr-protected">Protected</span>' : '<span class="dc-sr-unprotected">—</span>'}</td>
                        <td class="dc-sr-backup-ip">${s.backupIp}</td>
                    </tr>`).join('');
            }
        }

        function renderLspSection(lsp) {
            if (!lsp) {
                if (lspLed)     lspLed.setAttribute('data-state', 'unknown');
                if (lspState)   lspState.textContent = '—';
                if (lspSummary) lspSummary.innerHTML = '';
                return;
            }
            const isUp = lsp.operState === 'up';
            const isDn = lsp.operState === 'down';
            if (lspLed)   lspLed.setAttribute('data-state', isUp ? 'up' : isDn ? 'down' : 'unknown');
            if (lspState) lspState.textContent = lsp.operState ? lsp.operState.toUpperCase() : '—';

            function pathBadge(type) {
                if (type === 'primary')   return '<span class="a11-lsp-path-badge primary">PRIMARY</span>';
                if (type === 'secondary') return '<span class="a11-lsp-path-badge secondary">SECONDARY</span>';
                return '';
            }

            // Build path rows table (primary first, then secondaries)
            const pathRows = (lsp.paths || []).map(p => {
                const isActive  = p.name === lsp.activePath;
                const stateCls  = p.operState === 'up'   ? 'state-up'
                                : p.operState === 'down' ? 'state-down' : 'state-unknown';
                const stateLabel = (p.operState || '?').toUpperCase();
                return `<tr${isActive ? ' class="a11-lsp-active-row"' : ''}>
                    <td class="mono">${p.name}${isActive ? ' <span class="a11-lsp-active-marker">▶ active</span>' : ''}</td>
                    <td>${pathBadge(p.type)}</td>
                    <td><span class="dc1-iface-state ${stateCls}"><span class="dc1-iface-led"></span>${stateLabel}</span></td>
                    <td class="a11-lsp-path-state">${p.pathState || '—'}</td>
                </tr>`;
            }).join('');

            if (lspSummary) {
                lspSummary.innerHTML = `
                <div class="a11-lsp-grid">
                    <div class="a11-lsp-row">
                        <span class="a11-lsp-key">LSP Name</span>
                        <span class="a11-lsp-val mono">${lsp.lspName || '—'}</span>
                    </div>
                    <div class="a11-lsp-row">
                        <span class="a11-lsp-key">Headend → Tailend</span>
                        <span class="a11-lsp-val">${lsp.headend || '—'} → ${lsp.tailend || '—'}</span>
                    </div>
                    <div class="a11-lsp-row">
                        <span class="a11-lsp-key">Paths (cfg / oper)</span>
                        <span class="a11-lsp-val">${lsp.configuredPaths ?? '—'} / ${lsp.operationalPaths ?? '—'}</span>
                    </div>
                </div>
                ${pathRows.length ? `
                <table class="dc1-popup-table a11-lsp-table" style="margin-top:8px">
                    <thead><tr>
                        <th>Path Name</th><th>Type</th><th>State</th><th>Status</th>
                    </tr></thead>
                    <tbody>${pathRows}</tbody>
                </table>` : ''}`;
            }
        }

        async function loadData() {
            if (loading)    loading.style.display  = 'flex';
            if (errorBox)   errorBox.style.display = 'none';
            if (body)       body.style.display     = 'none';
            if (refreshBtn) refreshBtn.disabled    = true;
            try {
                // Fetch node telemetry and SR-TE LSP state in parallel
                const [res, lspRes] = await Promise.all([
                    fetch(`${PING_BASE}/gnmic/node/${NODE_ID}`, { cache: 'no-store' }),
                    fetch(`${PING_BASE}/api/mpls/srte-lsp`,     { cache: 'no-store' }).catch(() => null)
                ]);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data    = await res.json();
                const lspData = lspRes ? await lspRes.json().catch(() => null) : null;
                if (data.error) throw new Error(data.error);
                if (tsEl) {
                    const t = new Date(data.ts);
                    tsEl.textContent = `${t.toLocaleTimeString()} · gnmic`;
                }
                renderPortGrid(data.ports || []);
                renderIfaceTable(data.interfaces || []);
                renderIsisSection(data.isis || null);
                renderSrSection(data.sr || null);
                renderLspSection(lspData || null);
                if (loading) loading.style.display = 'none';
                if (body)    body.style.display    = 'block';
            } catch (err) {
                if (loading)   loading.style.display = 'none';
                if (errorBox)  errorBox.style.display = 'flex';
                if (errorText) errorText.textContent =
                    `gnmic unreachable: ${err.message} — is ping-service.js running?`;
            } finally {
                if (refreshBtn) refreshBtn.disabled = false;
            }
        }

        function openPopup()  { overlay.style.display = 'flex'; document.body.style.overflow = 'hidden'; loadData(); }
        function closePopup() { overlay.style.display = 'none'; document.body.style.overflow = ''; }

        if (svgNode) {
            svgNode.addEventListener('click', openPopup);
            svgNode.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPopup(); }
            });
        }
        if (closeBtn)   closeBtn.addEventListener('click', closePopup);
        if (refreshBtn) refreshBtn.addEventListener('click', loadData);
        overlay.addEventListener('click', e => { if (e.target === overlay) closePopup(); });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && overlay.style.display !== 'none') closePopup();
        });

        window.a11Popup = { open: openPopup, close: closePopup, refresh: loadData };
    })();

    // ═══════════════════════════════════════════════════════════════════════
    // IEC 61850 GOOSE — TPT Control Panel
    // Polls /api/tpt/status and /api/tpt/log every 1.5 s while running.
    // ═══════════════════════════════════════════════════════════════════════
    (() => {
        const API = 'http://localhost:3000';
        let _pollTimer = null;

        // ── DOM refs ─────────────────────────────────────────────────────
        const deployBtn = document.getElementById('tpt-deploy-btn');
        const startBtn  = document.getElementById('tpt-start-btn');
        const stopBtn   = document.getElementById('tpt-stop-btn');
        const tripBtn   = document.getElementById('tpt-trip-btn');
        const clearBtn  = document.getElementById('tpt-clear-btn');
        const logEl     = document.getElementById('tpt-log');
        const chanVis   = document.querySelector('.tpt-channel-vis');

        // per-node refs (rtu1 / rtu2)
        const nodes = ['rtu1', 'rtu2'].map(id => {
            const n = id === 'rtu1' ? '1' : '2';
            return {
                id,
                card:     document.getElementById(`tpt-card-${id}`),
                dot:      document.getElementById(`tpt-dot-${id}`),
                sent:     document.getElementById(`tpt${n}-sent`),
                stnum:    document.getElementById(`tpt${n}-stnum`),
                v:        document.getElementById(`tpt${n}-v`),
                i:        document.getElementById(`tpt${n}-i`),
                tripInd:  document.getElementById(`tpt${n}-trip-ind`),
                tripDot:  document.getElementById(`tpt${n}-trip-dot`),
                tripLbl:  document.getElementById(`tpt${n}-trip-label`),
            };
        });

        // ── Helpers ──────────────────────────────────────────────────────
        const PEER_TIMEOUT_MS = 5000;   // 5 × T0 heartbeat

        // ── PDU popover — last rendered entries, needed for click handler ───
        let _lastLogEntries = [];

        // ── Heartbeat ring state ──────────────────────────────────────────
        // Written by updateNodeCard() (poll thread), read by RAF loop.
        const CIRC = 2 * Math.PI * 22;  // stroke circumference for r=22 ≈ 138.2
        const tptHbState = {
            rtu1: { lastTsMs: null, commLoss: false, running: false },
            rtu2: { lastTsMs: null, commLoss: false, running: false },
        };

        // RAF-based ring ticker — runs at ~12 fps, very cheap
        let _hbRafId   = null;
        let _hbLastTick = 0;
        const HB_TICK_MS = 80;

        function tickHeartbeatRings(now) {
            _hbRafId = requestAnimationFrame(tickHeartbeatRings);
            if (now - _hbLastTick < HB_TICK_MS) return;
            _hbLastTick = now;

            ['rtu1', 'rtu2'].forEach((id, idx) => {
                const n   = idx + 1;
                const arc = document.getElementById(`tpt${n}-hb-arc`);
                const val = document.getElementById(`tpt${n}-hb-val`);
                const sub = document.getElementById(`tpt${n}-hb-sub`);
                const st  = tptHbState[id];
                if (!arc) return;

                // Daemon offline or never connected
                if (!st.running || st.lastTsMs === null) {
                    arc.setAttribute('stroke-dasharray', `0 ${CIRC}`);
                    arc.style.stroke = '#ccc';
                    if (val) { val.textContent = '—'; val.style.fill = '#bbb'; }
                    if (sub) sub.textContent = 'offline';
                    return;
                }

                // COMM LOSS — freeze ring red with × marker
                if (st.commLoss) {
                    arc.setAttribute('stroke-dasharray', `${CIRC} ${CIRC}`);
                    arc.style.stroke = '#c0392b';
                    if (val) { val.textContent = '✕'; val.style.fill = '#c0392b'; }
                    if (sub) sub.textContent = 'COMM LOSS';
                    return;
                }

                // Normal countdown
                const age      = Date.now() - st.lastTsMs;
                const fraction = Math.max(0, 1 - age / PEER_TIMEOUT_MS);
                const dash     = (fraction * CIRC).toFixed(2);
                const secsLeft = Math.max(0, (PEER_TIMEOUT_MS - age) / 1000);
                const color    = age < 2500 ? '#2a8a50' : age < 4000 ? '#b07800' : '#c0392b';

                arc.setAttribute('stroke-dasharray', `${dash} ${CIRC}`);
                arc.style.stroke = color;
                if (val) { val.textContent = secsLeft.toFixed(1); val.style.fill = color; }
                if (sub) sub.textContent = age < 1200 ? 'fresh' :
                                           age < 3000 ? 'ok'    :
                                           age < 4500 ? 'stale…' : 'timeout!';
            });
        }
        // Start the RAF loop immediately (it's cheap and self-throttled)
        _hbRafId = requestAnimationFrame(tickHeartbeatRings);

        function apiFetch(endpoint, method = 'GET') {
            return fetch(`${API}${endpoint}`, { method })
                .then(r => r.json())
                .catch(() => null);
        }

        function fmtTime(isoStr) {
            if (!isoStr) return '—';
            try { return new Date(isoStr).toLocaleTimeString('en-GB', { hour12: false, fractionalSecondDigits: 1 }); }
            catch { return isoStr.slice(11, 22); }
        }

        // Returns true if the peer's last heartbeat is stale (MPLS path broken).
        // Works with both old daemons (peer_last_ts only) and new ones (peer_alive).
        function isPeerStale(status) {
            if (!status) return false;
            const hasReceived = (status.sub_recv ?? 0) > 0;
            if (!hasReceived) return false;                     // never connected — not a loss event
            if ('peer_alive' in status) return !status.peer_alive;  // new daemon: use explicit flag
            if (!status.peer_last_ts) return true;             // old daemon: never got any message
            return (Date.now() - new Date(status.peer_last_ts).getTime()) > PEER_TIMEOUT_MS;
        }

        function updateNodeCard(ref, status) {
            if (!status || !ref.card) return;
            const isOnline = status.pub_running != null;
            const running  = status.pub_running;
            const tripped  = status.trip_asserted;
            const commLoss = isOnline && isPeerStale(status);

            ref.card.className = 'tpt-node-card' +
                (tripped   ? ' tpt-tripped'   : '') +
                (commLoss  ? ' tpt-comm-loss' : '') +
                (!isOnline ? ' tpt-offline'   : '');

            if (ref.dot) {
                ref.dot.className = 'tpt-node-dot ' +
                    (!isOnline ? 'offline' : tripped ? 'tripped' : commLoss ? 'commloss' : running ? 'running' : 'offline');
            }
            if (ref.sent)  ref.sent.textContent = status.pub_sent ?? '—';
            if (ref.stnum) ref.stnum.textContent = status.st_num  ?? '—';
            if (ref.v && status.voltage_pu != null)
                ref.v.textContent = status.voltage_pu.toFixed(3);
            if (ref.i && status.current_pu != null)
                ref.i.textContent = status.current_pu.toFixed(3);

            if (ref.tripInd) {
                ref.tripInd.className = 'tpt-trip-indicator' +
                    (tripped  ? ' tripped'   : '') +
                    (commLoss ? ' comm-loss' : '');
                if (ref.tripLbl) ref.tripLbl.textContent =
                    tripped ? '⚡ TRIPPED' : commLoss ? '⚠ LINK DOWN' : 'ARMED';
            }

            // Feed heartbeat ring state (read by RAF loop every ~80 ms)
            if (tptHbState[ref.id]) {
                tptHbState[ref.id].running  = !!running;
                tptHbState[ref.id].commLoss = commLoss;
                tptHbState[ref.id].lastTsMs = status.peer_last_ts
                    ? new Date(status.peer_last_ts).getTime() : null;
            }
        }

        function fmtAge(isoStr) {
            if (!isoStr) return null;
            const s = Math.round((Date.now() - new Date(isoStr).getTime()) / 1000);
            if (s < 60)  return `${s}s ago`;
            if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s ago`;
            return `${Math.floor(s/3600)}h ago`;
        }

        // ── Latency sparkline + MIN/AVG/MAX stats ────────────────────────
        // Polyline of inter-arrival intervals on a log-Y axis so the full
        // T1(2 ms) → T0(1000 ms) range is visible without clipping.
        // Up to 40 most-recent intervals; newest point on the right.
        function updateSparkline(entries) {
            const svg    = document.getElementById('tpt-spark-svg');
            const elMin  = document.getElementById('tpt-stat-min');
            const elAvg  = document.getElementById('tpt-stat-avg');
            const elMax  = document.getElementById('tpt-stat-max');
            if (!svg) return;

            // entries arrive newest-first; collect valid ΔT values oldest→newest
            const vals = entries.slice().reverse()
                .map(e => e._intervalMs)
                .filter(v => v != null && v > 0);

            const reset = () => {
                svg.innerHTML = `<text x="150" y="15" text-anchor="middle" class="tpt-spark-empty">No PDU data</text>`;
                [elMin, elAvg, elMax].forEach(el => { if (el) el.textContent = '—'; });
            };
            if (vals.length < 2) { reset(); return; }

            // ── stats ────────────────────────────────────────────────────
            const minV = Math.min(...vals);
            const maxV = Math.max(...vals);
            const avgV = vals.reduce((a, b) => a + b, 0) / vals.length;
            const fmtMs = v => v < 10 ? v.toFixed(1) + 'ms' : Math.round(v) + 'ms';
            if (elMin) elMin.textContent = fmtMs(minV);
            if (elAvg) elAvg.textContent = fmtMs(avgV);
            if (elMax) elMax.textContent = fmtMs(maxV);

            // ── sparkline ────────────────────────────────────────────────
            const VW = 300, VH = 30, PAD = 3;
            const MAX_PTS  = 40;
            const MAX_LOG  = Math.log10(2001);   // Y headroom above 1000 ms
            const pts      = vals.slice(-MAX_PTS);
            const n        = pts.length;
            const xStep    = (VW - PAD * 2) / Math.max(1, n - 1);

            const logY = ms =>
                VH - PAD - (Math.log10(Math.max(1, ms)) / MAX_LOG) * (VH - PAD * 2);

            const ptColor = ms => {
                if (ms <=   5) return '#c0392b';   // T1
                if (ms <=  20) return '#c05010';   // T2
                if (ms <= 200) return '#906800';   // T3
                return '#2a7848';                  // T0 heartbeat
            };

            const points = pts.map((v, i) => ({ x: PAD + i * xStep, y: logY(v), v }));

            // reference line at T0 = 1000 ms
            const refY = logY(1000).toFixed(1);

            // coloured segments
            let segs = '';
            for (let i = 0; i < points.length - 1; i++) {
                const a = points[i], b = points[i + 1];
                segs += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}"
                               x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"
                               stroke="${ptColor(b.v)}" stroke-width="1.5"
                               stroke-linecap="round"/>`;
            }

            // dots at each point
            const dots = points.map(p =>
                `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}"
                         r="2" fill="${ptColor(p.v)}" opacity="0.85"/>`
            ).join('');

            svg.innerHTML =
                `<line x1="${PAD}" y1="${refY}" x2="${VW - PAD}" y2="${refY}"
                       stroke="rgba(42,120,72,0.2)" stroke-width="1" stroke-dasharray="3 3"/>` +
                segs + dots;
        }

        // ── Burst retransmit chart ────────────────────────────────────────
        // Renders a log-scale bar chart of PDU inter-arrival times, making the
        // IEC 61850 retransmit burst pattern (T1→T2→T3→T0) visually obvious.
        function updateBurstChart(entries) {
            const svg = document.getElementById('tpt-burst-svg');
            if (!svg) return;

            const H       = 58;             // viewBox height
            const VW      = 400;            // viewBox width
            const MAX_BARS = 20;
            const MAX_LOG  = Math.log10(5001); // log10(max expected interval + 1) ≈ 3.70

            // Filter entries that have a measured interval, oldest → newest
            const bars = entries.slice().reverse().filter(e => e._intervalMs > 0);

            if (!bars.length) {
                svg.innerHTML = `<text x="200" y="29" text-anchor="middle" class="tpt-burst-empty">No PDU data yet</text>`;
                return;
            }

            const visible = bars.slice(-MAX_BARS);
            const count   = visible.length;
            const barW    = Math.floor(VW / MAX_BARS) - 1;          // bar width (~19px)
            const totalW  = count * (barW + 1) - 1;
            const offsetX = Math.floor((VW - totalW) / 2);          // center the group

            // Reference lines (T1, T2, T3, T0) — dashed horizontals
            const refs = [
                { ms: 1000, label: 'T0', stroke: 'rgba(42,138,80,0.40)'   },
                { ms: 100,  label: 'T3', stroke: 'rgba(160,120,0,0.40)'   },
                { ms: 10,   label: 'T2', stroke: 'rgba(200,100,0,0.40)'   },
                { ms: 2,    label: 'T1', stroke: 'rgba(192,57,43,0.50)'   },
            ];

            let out = '';

            refs.forEach(({ ms, label, stroke }) => {
                const logH = Math.log10(ms + 1) / MAX_LOG * H;
                const y    = (H - logH).toFixed(1);
                const labelColor = stroke.replace(/[\d.]+\)$/, '0.80)');
                out += `<line x1="0" y1="${y}" x2="${VW}" y2="${y}" stroke="${stroke}" stroke-width="0.8" stroke-dasharray="4 3"/>`;
                out += `<text x="3" y="${(parseFloat(y) - 1.5).toFixed(1)}" fill="${labelColor}" font-size="5.5" font-family="IBM Plex Mono,monospace">${label}</text>`;
            });

            // Bars
            visible.forEach((e, i) => {
                const ms   = e._intervalMs;
                const logH = Math.log10(ms + 1) / MAX_LOG * H;
                const barH = Math.max(2, logH).toFixed(1);
                const x    = offsetX + i * (barW + 1);
                const y    = (H - parseFloat(barH)).toFixed(1);
                const col  = ms <= 5   ? '#c0392b'   // T1 — red
                           : ms <= 20  ? '#c05010'   // T2 — orange
                           : ms <= 200 ? '#a07800'   // T3 — amber
                                       : '#2a8a50';  // T0 — green
                const op   = e.trip ? '0.95' : '0.72';
                out += `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${col}" opacity="${op}" rx="1"/>`;
            });

            svg.innerHTML = out;
        }

        // ── StNum Event Strip — fault recorder ───────────────────────────
        // Maintains a per-RTU history of (stNum, trip, commLoss) state changes
        // and renders them as a scrollable strip of colored segment pills.
        const EV_MAX = 30;   // max events retained per RTU
        const _evStrip = { rtu1: [], rtu2: [] };
        const _evLast  = { rtu1: null, rtu2: null };

        function fmtDur(ms) {
            if (ms < 500)   return `${ms}ms`;
            if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
            const m = Math.floor(ms / 60000);
            const s = Math.floor((ms % 60000) / 1000);
            return `${m}m ${s}s`;
        }

        function fmtTs(epochMs) {
            try { return new Date(epochMs).toLocaleTimeString('en-GB', { hour12: false, fractionalSecondDigits: 1 }); }
            catch { return '—'; }
        }

        function updateEventStrip(id, status, commLoss) {
            if (!status) return;
            const stNum = status.st_num  ?? null;
            const trip  = !!status.trip_asserted;
            const now   = Date.now();
            const last  = _evLast[id];
            const arr   = _evStrip[id];

            // Helper: close the currently open event
            function closeOpen() {
                if (arr.length && arr[arr.length - 1].endTs === null) {
                    arr[arr.length - 1].endTs = now;
                }
            }

            if (last === null) {
                // First observation — seed the strip
                _evLast[id] = { stNum, trip, commLoss };
                if (stNum != null || commLoss) {
                    arr.push({ stNum, trip, commLoss, ts: now, endTs: null });
                }
            } else {
                const stNumChanged  = stNum !== null && stNum !== last.stNum;
                const commLossGained = commLoss && !last.commLoss;
                const commLossCleared = !commLoss && last.commLoss;

                if (commLossGained || commLossCleared || stNumChanged) {
                    closeOpen();
                    arr.push({ stNum, trip, commLoss, ts: now, endTs: null });
                }
                _evLast[id] = { stNum, trip, commLoss };
            }

            // Trim to max
            if (arr.length > EV_MAX) _evStrip[id] = arr.slice(-EV_MAX);
        }

        function renderEventStrip() {
            ['rtu1', 'rtu2'].forEach(id => {
                const track = document.getElementById(`tpt-strip-${id}`);
                if (!track) return;
                const events = _evStrip[id];

                if (!events.length) {
                    track.innerHTML = '<span class="tpt-recorder-idle">No events — start daemon and wait for heartbeat</span>';
                    return;
                }

                const now = Date.now();
                const html = events.map(ev => {
                    const dur   = ev.endTs ? ev.endTs - ev.ts : now - ev.ts;
                    const isOpen = ev.endTs === null;
                    const cls   = ev.commLoss ? 'tpt-seg-commloss' : ev.trip ? 'tpt-seg-trip' : 'tpt-seg-armed';
                    const icon  = ev.commLoss ? '⚠' : ev.trip ? '⚡' : '●';
                    const lbl   = ev.commLoss ? 'COMM LOSS' : ev.trip ? 'TRIP' : 'ARMED';
                    const title = `stNum ${ev.stNum ?? '?'} · ${fmtTs(ev.ts)}${ev.endTs ? ' → ' + fmtTs(ev.endTs) : ' (live)'} · ${fmtDur(dur)}`;
                    return `<div class="tpt-strip-seg ${cls}${isOpen ? ' tpt-seg-open' : ''}" title="${title}">
                        <span class="tpt-seg-icon">${icon}</span>
                        <span class="tpt-seg-label">${lbl}</span>
                        <span class="tpt-seg-snum">stNum ${ev.stNum ?? '?'}</span>
                        <span class="tpt-seg-ts">${fmtTs(ev.ts)}</span>
                        <span class="tpt-seg-dur">${fmtDur(dur)}</span>
                    </div>`;
                }).join('');

                track.innerHTML = html;
                // Auto-scroll to newest (bottom, track is now vertical)
                requestAnimationFrame(() => { track.scrollTop = track.scrollHeight; });
            });
        }

        // Clear history button
        const recorderClearBtn = document.getElementById('tpt-recorder-clear');
        if (recorderClearBtn) {
            recorderClearBtn.addEventListener('click', () => {
                _evStrip.rtu1 = [];
                _evStrip.rtu2 = [];
                _evLast.rtu1 = null;
                _evLast.rtu2 = null;
                renderEventStrip();
            });
        }

        // ── PDU Detail Popover ────────────────────────────────────────────
        // Shown on click of a .tpt-log-entry row; decoded Wireshark-style.

        function retransmitInfo(ms) {
            if (ms == null || ms <= 0) return null;
            if (ms <= 5)   return { label: 'T1', desc: 'first retransmit burst',  cls: 'pop-val-t1' };
            if (ms <= 20)  return { label: 'T2', desc: 'rapid retransmit',        cls: 'pop-val-t2' };
            if (ms <= 200) return { label: 'T3', desc: 'slow retransmit',         cls: 'pop-val-t3' };
            return           { label: 'T0', desc: 'steady heartbeat',            cls: 'pop-val-t0' };
        }

        function popRow(key, val, note = '', valCls = '') {
            const noteHtml = note ? `<span class="tpt-pop-note">${note}</span>` : '';
            return `<div class="tpt-pop-row">
                <span class="tpt-pop-key">${key}</span>
                <span class="tpt-pop-val${valCls ? ' ' + valCls : ''}">${val}</span>
                ${noteHtml}
            </div>`;
        }

        function buildPopoverHtml(e) {
            // Infer source details
            const srcLabel = e._src || (e.from?.includes('30.7') ? 'RTU1' : e.from?.includes('30.6') ? 'RTU2' : '');
            const appid    = srcLabel === 'RTU1' ? '0x0001' : srcLabel === 'RTU2' ? '0x0002' : '0x0001';
            const gocbRef  = srcLabel === 'RTU1' ? 'RTU1/LLN0$GO$XCBR1'
                           : srcLabel === 'RTU2' ? 'RTU2/LLN0$GO$XCBR2' : '—';

            // Network delay (received – PDU timestamp)
            const netDelay = (e.t_iso && e.ts)
                ? Math.round(new Date(e.ts).getTime() - new Date(e.t_iso).getTime())
                : null;
            const netDelayCls = netDelay == null ? '' : netDelay < 10 ? 'pop-val-good' : netDelay < 50 ? 'pop-val-warn' : 'pop-val-bad';
            const netDelayNote = netDelay == null ? '' : netDelay < 10 ? '← excellent' : netDelay < 50 ? '← acceptable' : '← degraded';

            // Retransmit info
            const rt = retransmitInfo(e._intervalMs);

            // timeAllowedToLive — estimate: 2.5 × tx_interval, min 1000ms
            const tal = e._intervalMs > 0
                ? Math.max(1000, Math.round(e._intervalMs * 2.5))
                : 10000;

            // State badge
            const stateBadge = `<span class="tpt-pop-state ${e.trip ? 'pop-trip' : 'pop-armed'}">${e.trip ? '⚡ TRIP' : '● ARMED'}</span>`;

            const titlebar = `<div class="tpt-pop-titlebar">
                <span class="tpt-pop-proto">▼ IEC&nbsp;61850-8-1&nbsp;GOOSE&nbsp;PDU</span>
                ${stateBadge}
                <button class="tpt-pop-close" id="tpt-pop-close-btn" aria-label="Close">&#xD7;</button>
            </div>`;

            const secHdr = `<div class="tpt-pop-sec-hdr">PROTOCOL HEADER</div>`;
            const hdrRows =
                popRow('APPID', appid, 'application identifier') +
                popRow('gocbRef', gocbRef, 'GOOSE control block ref') +
                popRow('goID', e.goID ?? '—', 'GOOSE identifier') +
                popRow('confRev', '1', 'configuration revision') +
                popRow('ndsCom', 'false', 'needs commissioning') +
                popRow('numDatSetEntries', '4', 'dataset member count') +
                popRow('timeAllowedToLive', `${tal} ms`, 'max subscriber silence before alarm');

            const seqHdr = `<div class="tpt-pop-sec-hdr">SEQUENCE NUMBERS</div>`;
            const seqRows =
                popRow('stNum', `${e.stNum ?? '—'}`, 'increments on each state change') +
                popRow('sqNum', `${e.sqNum ?? '—'}`, 'retransmit counter within burst') +
                (e._intervalMs > 0
                    ? popRow('Δt from prev PDU',
                        `${e._intervalMs} ms${rt ? ' &nbsp;←&nbsp;' + rt.label : ''}`,
                        rt ? rt.desc : '',
                        rt ? rt.cls : '')
                    : popRow('Δt from prev PDU', '—', 'first entry in window')) +
                (e._jitterMs != null
                    ? popRow('jitter vs T0', `${Math.round(e._jitterMs)} ms`,
                        Math.round(e._jitterMs) < 20 ? '← normal' : '← high jitter')
                    : '');

            const dsHdr = `<div class="tpt-pop-sec-hdr">DATASET &nbsp;·&nbsp; XCBR1$ST$Pos (4 entries)</div>`;
            const dsRows =
                popRow('[0] trip', e.trip ? 'TRUE ⚡' : 'FALSE ●', 'circuit breaker state',
                    e.trip ? 'pop-val-trip' : 'pop-val-armed') +
                popRow('[1] voltage_pu', e.voltage != null ? e.voltage.toFixed(4) : '—', 'p.u. (nominal = 1.0)') +
                popRow('[2] current_pu', e.current != null ? e.current.toFixed(4) : '—', 'p.u. (nominal = 0.0)') +
                popRow('[3] reserved', '—', '');

            const tsHdr = `<div class="tpt-pop-sec-hdr">TIMESTAMPS &amp; ROUTING</div>`;
            const tsRows =
                (e.t_iso ? popRow('PDU T₀ (embedded)', fmtTime(e.t_iso), 'IEC 61850 UTC timestamp in PDU') : '') +
                popRow('Received at', fmtTime(e.ts), 'subscriber wall-clock') +
                (netDelay != null
                    ? popRow('Network delay', `${netDelay} ms`, netDelayNote, netDelayCls)
                    : '') +
                popRow('Source IP', e.from ?? '—', srcLabel ? `(${srcLabel})` : '');

            return titlebar +
                `<div class="tpt-pop-section">${secHdr}${hdrRows}</div>` +
                `<div class="tpt-pop-section">${seqHdr}${seqRows}</div>` +
                `<div class="tpt-pop-section">${dsHdr}${dsRows}</div>` +
                `<div class="tpt-pop-section">${tsHdr}${tsRows}</div>`;
        }

        function showPduPopover(entry, clientX, clientY) {
            const popover  = document.getElementById('tpt-pdu-popover');
            const backdrop = document.getElementById('tpt-pdu-backdrop');
            if (!popover) return;

            popover.innerHTML = buildPopoverHtml(entry);
            popover.style.display = 'block';
            if (backdrop) backdrop.style.display = 'block';

            // Position near click, keep within viewport
            const PW = 368, PH = 440;
            let x = clientX + 14;
            let y = clientY + 8;
            if (x + PW > window.innerWidth  - 8) x = clientX - PW - 14;
            if (y + PH > window.innerHeight - 8) y = clientY - PH;
            if (y < 8) y = 8;
            if (x < 8) x = 8;
            popover.style.left = `${x}px`;
            popover.style.top  = `${y}px`;

            // Close button inside the popover
            const closeBtn = document.getElementById('tpt-pop-close-btn');
            if (closeBtn) closeBtn.addEventListener('click', hidePduPopover);
        }

        function hidePduPopover() {
            const popover  = document.getElementById('tpt-pdu-popover');
            const backdrop = document.getElementById('tpt-pdu-backdrop');
            if (popover)  popover.style.display  = 'none';
            if (backdrop) backdrop.style.display = 'none';
            // Remove active highlight from any log row
            logEl?.querySelectorAll('.tpt-pop-active')
                 .forEach(el => el.classList.remove('tpt-pop-active'));
        }

        // Click on backdrop → close
        const popBackdrop = document.getElementById('tpt-pdu-backdrop');
        if (popBackdrop) popBackdrop.addEventListener('click', hidePduPopover);

        // ESC key → close
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') hidePduPopover();
        });

        // Delegate clicks on log entries
        if (logEl) {
            logEl.addEventListener('click', (ev) => {
                const row = ev.target.closest('[data-entry-idx]');
                if (!row) return;
                const idx   = parseInt(row.dataset.entryIdx, 10);
                const entry = _lastLogEntries[idx];
                if (!entry) return;
                // Highlight selected row
                logEl.querySelectorAll('.tpt-pop-active')
                     .forEach(el => el.classList.remove('tpt-pop-active'));
                row.classList.add('tpt-pop-active');
                showPduPopover(entry, ev.clientX, ev.clientY);
            });
        }

        function renderLog(rtu1Log, rtu2Log, commLoss) {
            if (!logEl) return;

            // Merge and sort by timestamp descending (newest first)
            const entries = [
                ...(rtu1Log?.entries || []).map(e => ({ ...e, _src: 'RTU1' })),
                ...(rtu2Log?.entries || []).map(e => ({ ...e, _src: 'RTU2' })),
            ].sort((a, b) => (b.ts || '').localeCompare(a.ts || '')).slice(0, 10);

            if (!entries.length) {
                updateBurstChart([]);
                updateSparkline([]);
                logEl.innerHTML = '<div class="tpt-log-idle">No GOOSE messages received yet</div>';
                return;
            }

            // Compute inter-arrival interval per source (newest-first, so prev is at higher index)
            const T0_MS = 1000;
            const prevTsBySource = {};
            entries.forEach(e => {
                const prev = prevTsBySource[e._src];
                if (prev !== undefined) {
                    e._intervalMs = new Date(prev).getTime() - new Date(e.ts).getTime();
                    e._jitterMs   = Math.abs(e._intervalMs - T0_MS);
                }
                prevTsBySource[e._src] = e.ts;
            });

            const colHdr = `<div class="tpt-log-cols">
                <span>Time</span><span>From</span>
                <span>stNum</span><span>sqNum</span>
                <span>V p.u.</span><span>I p.u.</span>
                <span>Delay ms</span><span>Jitter ms</span><span>Status</span>
            </div>`;

            // Banner shown above rows when path is broken
            const lastTs = entries[0]?.ts;
            const commBanner = commLoss
                ? `<div class="tpt-log-comm-banner">&#9888; COMM LOSS — MPLS path down — last PDU ${fmtAge(lastTs)}</div>`
                : '';

            // Store for popover click handler
            _lastLogEntries = entries;

            const rows = entries.map((e, idx) => {
                const tripClass = e.trip ? 'tpt-entry-trip' : 'tpt-entry-trip armed';
                const tripTxt   = e.trip ? '⚡ TRIP' : 'ARMED';
                const rowClass  = e.trip ? 'tpt-log-entry tpt-entry-trip' : 'tpt-log-entry';
                const delayMs   = (e.t_iso && e.ts)
                    ? Math.round(new Date(e.ts).getTime() - new Date(e.t_iso).getTime())
                    : null;
                const jitterTxt = e._jitterMs != null ? Math.round(e._jitterMs) : '—';
                return `<div class="${rowClass}" data-entry-idx="${idx}" title="Click to inspect PDU">
                    <span class="tpt-entry-ts">${fmtTime(e.ts)}</span>
                    <span class="tpt-entry-from">${e.from || e._src}</span>
                    <span class="tpt-entry-st">${e.stNum ?? '—'}</span>
                    <span class="tpt-entry-sq">${e.sqNum ?? '—'}</span>
                    <span class="tpt-entry-v">${e.voltage != null ? e.voltage.toFixed(3) : '—'}</span>
                    <span class="tpt-entry-i">${e.current != null ? e.current.toFixed(3) : '—'}</span>
                    <span class="tpt-entry-delay">${delayMs != null ? delayMs : '—'}</span>
                    <span class="tpt-entry-jitter">${jitterTxt}</span>
                    <span class="${tripClass}">${tripTxt}</span>
                </div>`;
            }).join('');

            updateBurstChart(entries);
            updateSparkline(entries);
            logEl.innerHTML = commBanner + colHdr + rows;
        }

        // ── Poll loop ─────────────────────────────────────────────────────
        async function poll() {
            const [status, logData] = await Promise.all([
                apiFetch('/api/tpt/status'),
                apiFetch('/api/tpt/log'),
            ]);

            if (status) {
                const rtu1 = status.RTU1?.data;
                const rtu2 = status.RTU2?.data;
                updateNodeCard(nodes[0], rtu1);
                updateNodeCard(nodes[1], rtu2);

                // Channel: broken if either side has a stale peer heartbeat
                const commLoss = isPeerStale(rtu1) || isPeerStale(rtu2);
                const active   = (rtu1?.pub_running || rtu2?.pub_running) && !commLoss;
                // Keep traffic-flow visualiser in sync with GOOSE state
                window.mplsTrafficFlow?.onTptStateChange(active);
                if (chanVis) {
                    chanVis.className = 'tpt-channel-vis' +
                        (commLoss ? ' comm-loss' : active ? '' : ' inactive');
                    const lbl = chanVis.querySelector('.tpt-channel-label');
                    if (lbl) lbl.innerHTML = commLoss ? '&#9888; LINK<br>DOWN' : 'UDP :61850<br>GOOSE';
                }

                if (logData) renderLog(logData.RTU1?.data, logData.RTU2?.data, commLoss);

                // Update event recorder (per-RTU commLoss computed individually)
                const cl1 = rtu1 ? (rtu1.pub_running != null) && isPeerStale(rtu1) : false;
                const cl2 = rtu2 ? (rtu2.pub_running != null) && isPeerStale(rtu2) : false;
                updateEventStrip('rtu1', rtu1, cl1);
                updateEventStrip('rtu2', rtu2, cl2);
                renderEventStrip();

                // Drive main-dashboard teleprotection via the traffic-flow module
                // so topology and GOOSE faults are combined correctly (OR logic).
                // Never call updateMplsTeleprotectionStatus() directly from here —
                // that would race against the Dijkstra topology check.
                window.mplsTrafficFlow?.onTptCommLossChange(commLoss);
            }
        }

        function startPolling() {
            if (_pollTimer) return;
            poll();
            _pollTimer = setInterval(poll, 1500);
        }

        function stopPolling() {
            if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
        }

        // ── Button handlers ───────────────────────────────────────────────
        if (startBtn) {
            startBtn.addEventListener('click', async () => {
                startBtn.disabled = true;
                await apiFetch('/api/tpt/start', 'POST');
                startPolling();
                setTimeout(() => { startBtn.disabled = false; }, 1500);
            });
        }

        if (stopBtn) {
            stopBtn.addEventListener('click', async () => {
                stopBtn.disabled = true;
                await apiFetch('/api/tpt/stop', 'POST');
                setTimeout(() => {
                    stopBtn.disabled = false;
                    poll();   // refresh state immediately
                }, 800);
            });
        }

        if (tripBtn) {
            // ── Trip modal wiring ─────────────────────────────────────────
            const tripModal    = document.getElementById('trip-modal-backdrop');
            const modalConfirm = document.getElementById('trip-modal-confirm');
            const modalCancel  = document.getElementById('trip-modal-cancel');
            const modalCloseX  = document.getElementById('trip-modal-close-x');

            function openTripModal() {
                tripModal.hidden = false;
                // next frame so the display:none→flex transition plays
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => tripModal.classList.add('trip-modal-visible'));
                });
                modalConfirm.disabled = false;
                modalConfirm.textContent = '⚡ Execute Trip';
            }

            function closeTripModal() {
                tripModal.classList.remove('trip-modal-visible');
                tripModal.addEventListener('transitionend', () => {
                    tripModal.hidden = true;
                }, { once: true });
            }

            // Clicking the backdrop (outside the card) also closes
            tripModal.addEventListener('click', e => {
                if (e.target === tripModal) closeTripModal();
            });

            // ESC key closes
            document.addEventListener('keydown', e => {
                if (e.key === 'Escape' && !tripModal.hidden) closeTripModal();
            });

            modalCancel.addEventListener('click', closeTripModal);
            modalCloseX.addEventListener('click', closeTripModal);

            // Trip button → open modal
            tripBtn.addEventListener('click', () => openTripModal());

            // Confirm → execute trip, then close
            modalConfirm.addEventListener('click', async () => {
                modalConfirm.disabled = true;
                modalConfirm.textContent = '⚡ Tripping…';
                closeTripModal();
                tripBtn.disabled = true;
                tripBtn.textContent = '⚡ Tripping…';
                await apiFetch('/api/tpt/trip', 'POST');
                await poll();
                setTimeout(() => {
                    tripBtn.disabled = false;
                    tripBtn.textContent = '⚡ Trip RTU1';
                }, 2000);
            });
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', async () => {
                await apiFetch('/api/tpt/clear', 'POST');
                await poll();
            });
        }

        // ── Deploy button — runs install-tpt.sh via backend ───────────────
        if (deployBtn) {
            deployBtn.addEventListener('click', async () => {
                deployBtn.disabled = true;
                deployBtn.textContent = '⬆ Installing…';
                if (logEl) logEl.innerHTML = '<div class="tpt-log-idle">⬆ Running install-tpt.sh — copying daemon to RTU containers…</div>';

                const result = await apiFetch('/api/tpt/install', 'POST');

                deployBtn.disabled = false;
                deployBtn.textContent = '⬆ Deploy';

                if (!result) {
                    if (logEl) logEl.innerHTML = '<div class="tpt-log-idle" style="color:var(--accent-danger)">✗ Deploy failed — no response from backend</div>';
                    return;
                }

                // Backend returned an error object (e.g. route not found on old process)
                if (result.error || result.exitCode === undefined) {
                    const msg = result.error || 'Unexpected response — backend may need restarting';
                    if (logEl) logEl.innerHTML = `<div class="tpt-log-idle" style="color:var(--accent-danger)">✗ Backend error: ${msg}</div>`;
                    return;
                }

                // Show script output in the log panel
                const success = result.exitCode === 0;
                const icon = success ? '✓' : '✗';
                const colour = success ? 'var(--accent-ok,#4caf50)' : 'var(--accent-danger,#f44336)';
                if (logEl) {
                    logEl.innerHTML = `<div class="tpt-log-idle" style="color:${colour};margin-bottom:6px;">` +
                        `${icon} install-tpt.sh exited ${result.exitCode}</div>` +
                        `<pre style="font-size:10px;line-height:1.5;white-space:pre-wrap;color:var(--text-secondary);">` +
                        (result.output || '(no output)').replace(/</g, '&lt;') + `</pre>`;
                }

                // If successful, kick off polling immediately so RTU cards update
                if (success) {
                    startPolling();
                    await poll();
                }
            });
        }

        // ── Auto-start polling (daemon may already be running) ────────────
        startPolling();

    })();

    // ═══════════════════════════════════════════════════════════════════════
    // MPLS Traffic Flow Visualiser
    // Renders animated IGP-path packets between RTU1 and RTU2 while the
    // GOOSE teleprotection channel is active.
    //
    // Behaviour:
    //  • Inactive  → no animation (clean topology)
    //  • Active    → animated packets follow primary IGP path (teal)
    //  • Link fault → Dijkstra reroutes; rerouted path shown in orange
    //  • No path   → smart-grid COMM LOSS triggered; grid deactivates
    // ═══════════════════════════════════════════════════════════════════════
    (function initMplsTrafficFlow() {

        const SVG_NS = 'http://www.w3.org/2000/svg';

        // ── IGP graph — mirrors config.json topology + SVG coordinates ────
        // pts[0] = endpoint near `from` node; pts[1] = endpoint near `to` node.
        // Dijkstra reverses the pts array when traversing the edge backwards.
        //
        // IS-IS metric: all links = 10  (Nokia SR-OS default)
        //
        // Primary path (cost 40, 4 hops) — shortest via ACCESS ring:
        //   RTU1 → A1-1 → A1-2 → A1-3 → RTU2
        //
        // Rerouted path (cost 50, 5 hops) — any A1-2 ring link down:
        //   RTU1 → A1-1 → ACC1 → ACC2 → A1-3 → RTU2
        //
        // No path → RTU1 or RTU2 link down → COMM LOSS → Smart Grid off
        const EDGES = [
            // RTU1 ↔ A1-1  (vertical)
            { linkId: 'link-a1-1-rtu1',  from: 'a1-1',  to: 'rtu1',  cost: 10,
              pts: [{x:250,y:400},{x:250,y:453}] },

            // ACCESS ring: A1-1 ↔ A1-2 ↔ A1-3  (horizontal — PRIMARY path)
            { linkId: 'link-a1-1-a1-2',  from: 'a1-1',  to: 'a1-2',  cost: 10,
              pts: [{x:282,y:367},{x:518,y:367}] },
            { linkId: 'link-a1-2-a1-3',  from: 'a1-2',  to: 'a1-3',  cost: 10,
              pts: [{x:582,y:367},{x:788,y:367}] },

            // A1-3 ↔ RTU2  (vertical)
            { linkId: 'link-a1-3-rtu2',  from: 'a1-3',  to: 'rtu2',  cost: 10,
              pts: [{x:820,y:400},{x:820,y:453}] },

            // ACC1 ↔ A1-1  (diagonal — used in rerouted path)
            { linkId: 'link-acc1-a1-1',  from: 'acc1',  to: 'a1-1',  cost: 10,
              pts: [{x:350,y:268},{x:280,y:335}] },
            // ACC2 ↔ A1-3  (diagonal — used in rerouted path)
            { linkId: 'link-acc2-a1-3',  from: 'acc2',  to: 'a1-3',  cost: 10,
              pts: [{x:750,y:268},{x:820,y:335}] },

            // DC1 ↔ ACC1  (vertical)
            { linkId: 'link-dc1-acc1',   from: 'dc1',   to: 'acc1',  cost: 10,
              pts: [{x:360,y:138},{x:360,y:202}] },
            // DC2 ↔ ACC2  (vertical)
            { linkId: 'link-dc2-acc2',   from: 'dc2',   to: 'acc2',  cost: 10,
              pts: [{x:740,y:138},{x:740,y:202}] },

            // DC1 ↔ DC2  (horizontal, core backbone)
            { linkId: 'link-dc1-dc2',    from: 'dc1',   to: 'dc2',   cost: 10,
              pts: [{x:392,y:105},{x:708,y:105}] },

            // ACC1 ↔ ACC2  (horizontal, aggregation ring)
            { linkId: 'link-acc1-acc2',  from: 'acc1',  to: 'acc2',  cost: 10,
              pts: [{x:392,y:235},{x:708,y:235}] },
        ];

        const NODES = ['rtu1','rtu2','a1-1','a1-2','a1-3','acc1','acc2','dc1','dc2'];

        // ── Dijkstra ──────────────────────────────────────────────────────
        // Returns ordered array of edges rtu1→rtu2, or null if no path.
        function dijkstra(faultSet) {
            // Build adjacency list, skipping faulted links.
            const adj = {};
            NODES.forEach(n => { adj[n] = []; });
            for (const e of EDGES) {
                if (faultSet.has(e.linkId)) continue;
                // Forward direction
                adj[e.from].push({ to: e.to, cost: e.cost,
                                   edge: { ...e } });
                // Reverse direction — flip pts so SVG coords stay correct
                adj[e.to ].push({ to: e.from, cost: e.cost,
                                   edge: { ...e, pts: [e.pts[1], e.pts[0]] } });
            }

            const dist = {}; const prev = {}; const prevEdge = {};
            NODES.forEach(n => { dist[n] = Infinity; });
            dist['rtu1'] = 0;
            const unvisited = new Set(NODES);

            while (unvisited.size) {
                let u = null;
                for (const n of unvisited) { if (u === null || dist[n] < dist[u]) u = n; }
                if (dist[u] === Infinity || u === 'rtu2') break;
                unvisited.delete(u);
                for (const { to, cost, edge } of adj[u]) {
                    const alt = dist[u] + cost;
                    if (alt < dist[to]) {
                        dist[to] = alt;
                        prev[to] = u;
                        prevEdge[to] = edge;
                    }
                }
            }

            if (dist['rtu2'] === Infinity) return null;
            const path = []; let cur = 'rtu2';
            while (cur !== 'rtu1') { path.unshift(prevEdge[cur]); cur = prev[cur]; }
            return path;
        }

        // Cache the primary (fault-free) path link IDs for reroute detection
        const PRIMARY_LINK_IDS = new Set((dijkstra(new Set()) || []).map(e => e.linkId));

        // ── SVG element references ─────────────────────────────────────────
        const highlightG  = document.getElementById('mpls-path-highlight');
        const statusG     = document.getElementById('mpls-path-status-group');
        const statusText  = document.getElementById('mpls-path-status-text');
        const statusBg    = document.getElementById('mpls-path-status-bg');

        // ── State ──────────────────────────────────────────────────────────
        let _tptActive     = false;
        let _faultLinks    = new Set();
        let _animElems     = [];   // all created SVG elements (cleared on update)
        // Two independent comm-loss sources — alarm fires when EITHER is true,
        // clears only when BOTH are false.  Prevents the race where Dijkstra
        // heals the alarm every 15 s while the TPT GOOSE layer still reports
        // a heartbeat timeout, causing oscillation on a single link fault.
        let _topoCommLoss  = false;  // driven by Dijkstra (no IGP path rtu1↔rtu2)
        let _gooseCommLoss = false;  // driven by GOOSE heartbeat timeout (TPT poll)

        function applyCommLoss() {
            window.smartGrid?.updateMplsTeleprotectionStatus(_topoCommLoss || _gooseCommLoss);
        }

        // ── Helpers ────────────────────────────────────────────────────────
        function clearFlow() {
            _animElems.forEach(el => {
                try { el.remove(); } catch (_) {}
            });
            _animElems = [];
            if (statusG) statusG.setAttribute('visibility', 'hidden');
        }

        function renderFlow(pathEdges) {
            clearFlow();
            if (!pathEdges) return;

            const isRerouted = pathEdges.some(e => !PRIMARY_LINK_IDS.has(e.linkId));
            const segClass   = isRerouted ? 'mpls-path-seg-rerouted' : 'mpls-path-seg-primary';

            pathEdges.forEach((e, idx) => {
                const [a, b] = e.pts;

                // Glowing link overlay
                const ln = document.createElementNS(SVG_NS, 'line');
                ln.setAttribute('x1', a.x); ln.setAttribute('y1', a.y);
                ln.setAttribute('x2', b.x); ln.setAttribute('y2', b.y);
                ln.setAttribute('class', segClass);
                highlightG.appendChild(ln);
                _animElems.push(ln);

                // (packet animation removed)
            });

            // Status label
            if (statusText && statusG) {
                const hops = pathEdges.length;
                statusText.textContent = isRerouted
                    ? `⚡ REROUTED  ·  ${hops}-hop failover path via IGP  ·  RTU1 ↔ RTU2`
                    : `● ACTIVE  ·  RTU1 ↔ RTU2  ·  primary path  ·  ${hops} hops`;
                statusText.setAttribute('fill', isRerouted ? '#ff9800' : '#00c8a0');
                if (statusBg) statusBg.setAttribute('stroke', isRerouted ? '#ff9800' : '#00c8a0');
                statusG.setAttribute('visibility', 'visible');
            }
        }

        function renderNoPath() {
            clearFlow();
            if (statusText && statusG) {
                statusText.textContent = '⚠  NO PATH AVAILABLE  —  RTU1 ↔ RTU2 unreachable  —  SMART GRID DEACTIVATED';
                statusText.setAttribute('fill', '#dc3545');
                if (statusBg) statusBg.setAttribute('stroke', '#dc3545');
                statusG.setAttribute('visibility', 'visible');
            }
        }

        // ── Main update ────────────────────────────────────────────────────
        // Runs Dijkstra unconditionally. Only updates _topoCommLoss; GOOSE-level
        // recovery is handled independently by onTptCommLossChange().
        function update() {
            const path = dijkstra(_faultLinks);

            if (!path) {
                // No IGP path RTU1↔RTU2 → topology-driven comm-loss
                clearFlow();
                renderNoPath();
                if (!_topoCommLoss) {
                    _topoCommLoss = true;
                    applyCommLoss();
                }
                return;
            }

            // Topology path restored — clear only the topology-side flag.
            // If the GOOSE layer (_gooseCommLoss) is still true the alarm stays on
            // until the TPT poll confirms the GOOSE heartbeat has resumed.
            if (_topoCommLoss) {
                _topoCommLoss = false;
                applyCommLoss();
            }

            if (!_tptActive) {
                clearFlow();   // path exists but daemon not running — clean topology
                return;
            }

            renderFlow(path);
        }

        // ── Public API ─────────────────────────────────────────────────────
        window.mplsTrafficFlow = {
            /** Called by TPT poll loop when GOOSE daemon active/inactive */
            onTptStateChange(active) {
                if (_tptActive === active) return;  // no-op if unchanged
                _tptActive = active;
                update();
            },
            /** Called by SmartGrid._applyLinkHealth with current fault set */
            onLinkHealthUpdate(faultSet) {
                _faultLinks = faultSet;
                update();
            },
            /**
             * Called by the TPT poll whenever the GOOSE-layer comm-loss state
             * changes. Updates only _gooseCommLoss, then recomputes the final
             * alarm state via applyCommLoss().  This is the authoritative source
             * when the TPT daemon is running — the topology layer must not
             * override it.
             */
            onTptCommLossChange(gooseLoss) {
                if (_gooseCommLoss === gooseLoss) return;
                _gooseCommLoss = gooseLoss;
                applyCommLoss();
            },
        };

    })();

    // ══════════════════════════════════════════════════════════════════════════
    // SR-TE LSP Overlay
    // LSP: to-ACCESS1-3, headend ACCESS1-1
    // PRIMARY  path (to-ACCESS1-3):        A1-1 → A1-2 → A1-3  (ACCESS ring)
    // SECONDARY path (to-ACCESS1-3-backup): A1-1 → ACC1 → ACC2 → A1-3 (aggregation)
    //
    // Active path is drawn solid (mpls-srte-active); standby is dim dashed
    // (mpls-srte-standby). Polls /api/mpls/srte-lsp every 20 s via gNMI.
    // ══════════════════════════════════════════════════════════════════════════
    (function initSrteLspOverlay() {
        const SVG_NS   = 'http://www.w3.org/2000/svg';
        const overlayG = document.getElementById('mpls-srte-overlay');
        if (!overlayG) return;

        const BASE_URL = window.smartGrid?.pingServiceUrl || 'http://localhost:3000';
        const POLL_MS  = 20_000;

        // PRIMARY path (to-ACCESS1-3):        A1-1 → A1-2 → A1-3  (ACCESS ring)
        // Offset 5 px above physical link lines.
        // Derived from SVG link coordinates:
        //   link-a1-1-a1-2: x1=282 y1=367 x2=518 y2=367
        //   link-a1-2-a1-3: x1=582 y1=367 x2=788 y2=367
        const PRIMARY_SEGS = [
            [282, 362, 518, 362],   // A1-1 → A1-2
            [582, 362, 788, 362],   // A1-2 → A1-3
        ];

        // SECONDARY path (to-ACCESS1-3-backup): A1-1 → ACC1 → ACC2 → A1-3 (aggregation)
        // Offset ~4 px to the left/above physical link lines for visual separation.
        // Derived from SVG link coordinates:
        //   link-acc1-a1-1: x1=350 y1=268 x2=280 y2=335  (reversed for A1-1→ACC1)
        //   link-acc1-acc2: x1=392 y1=235 x2=708 y2=235
        //   link-acc2-a1-3: x1=750 y1=268 x2=820 y2=335
        const SECONDARY_SEGS = [
            [276, 338, 346, 271],   // A1-1 → ACC1  (diagonal, -4 px offset)
            [392, 230, 708, 230],   // ACC1 → ACC2  (horizontal, 5 px above y=235)
            [754, 271, 824, 338],   // ACC2 → A1-3  (diagonal, -4 px offset)
        ];

        function drawSegs(segs, segCls, dotCls) {
            segs.forEach(([x1, y1, x2, y2]) => {
                const line = document.createElementNS(SVG_NS, 'line');
                line.setAttribute('x1', x1); line.setAttribute('y1', y1);
                line.setAttribute('x2', x2); line.setAttribute('y2', y2);
                line.setAttribute('class', segCls);
                overlayG.appendChild(line);
                // directional mid-point dot
                const dot = document.createElementNS(SVG_NS, 'circle');
                dot.setAttribute('cx', (x1 + x2) / 2);
                dot.setAttribute('cy', (y1 + y2) / 2);
                dot.setAttribute('r', 3);
                dot.setAttribute('class', dotCls);
                overlayG.appendChild(dot);
            });
        }

        function buildOverlay(lsp) {
            overlayG.innerHTML = '';
            const operState = (lsp.operState || 'unknown').toLowerCase();
            const pathType  = (lsp.pathType  || 'unknown').toLowerCase();

            if (operState === 'unknown') {
                // Cannot determine active path — show ring only in grey
                drawSegs(SECONDARY_SEGS,
                         'mpls-srte-seg mpls-srte-unknown',
                         'mpls-srte-dot mpls-srte-unknown');
                return;
            }

            // Identify which segments are active vs standby
            const isPrimaryActive = pathType !== 'secondary';  // primary is default
            const activeSegs  = isPrimaryActive ? PRIMARY_SEGS   : SECONDARY_SEGS;
            const standbySegs = isPrimaryActive ? SECONDARY_SEGS : PRIMARY_SEGS;

            const stateCls = operState === 'up' ? 'mpls-srte-up' : 'mpls-srte-down';

            // Standby path drawn first (below active)
            drawSegs(standbySegs,
                     'mpls-srte-seg mpls-srte-standby',
                     'mpls-srte-dot mpls-srte-standby');

            // Active path drawn on top — solid + state colour
            drawSegs(activeSegs,
                     `mpls-srte-seg mpls-srte-active ${stateCls}`,
                     `mpls-srte-dot mpls-srte-active ${stateCls}`);
        }

        async function poll() {
            try {
                const r    = await fetch(`${BASE_URL}/api/mpls/srte-lsp`,
                                         { signal: AbortSignal.timeout(6000) });
                const data = await r.json();
                buildOverlay(data);
            } catch {
                buildOverlay({ operState: 'unknown', pathType: 'unknown' });
            }
        }

        poll();
        setInterval(poll, POLL_MS);
    })();

    // ================================================================
    // IEC 60870-5-104 SCADA Panel — polls /api/scada/status every 5 s
    // ================================================================
    (function initScadaPanel() {
        const SCADA_POLL_MS = 5_000;

        // DOM refs — panel
        const sessionBadge  = document.getElementById('scada-session-badge');
        const masterCard    = document.getElementById('scada-iec-master-card');
        const rtuCard       = document.getElementById('scada-iec-rtu-card');
        const dotMaster     = document.getElementById('scada-dot-master');
        const dotRtu        = document.getElementById('scada-dot-rtu');
        const ifaceBadge    = document.getElementById('scada-iface-badge');
        const sessionVal    = document.getElementById('scada-session-val');
        const lastTs        = document.getElementById('scada-last-ts');
        const measVal       = document.getElementById('scada-meas-val');
        const sendSeq       = document.getElementById('scada-send-seq');
        const quality       = document.getElementById('scada-quality');
        const logEl         = document.getElementById('scada-iec-log');
        const channel       = document.getElementById('scada-iec-channel');
        const failoverBar   = document.getElementById('scada-failover-bar');
        const failoverIface = document.getElementById('scada-failover-iface');

        // DOM refs — MPLS SVG SCADA node
        const svgLed        = document.getElementById('scada-svg-led');
        const svgIfaceText  = document.getElementById('scada-svg-iface');
        const svgEth1Port   = document.getElementById('scada-eth1-port');
        const svgEth2Port   = document.getElementById('scada-eth2-port');
        const svgEth1Link   = document.getElementById('scada-eth1-link');
        const svgEth2Link   = document.getElementById('scada-eth2-link');

        if (!sessionBadge) return; // panel not in DOM

        function classify(line) {
            if (line.includes('ioa='))            return 'scada-log-line-measure';
            if (line.includes('failing over') ||
                line.includes('failed over'))      return 'scada-log-line-failover';
            if (line.includes('failed') ||
                line.includes('session lost'))     return 'scada-log-line-fail';
            if (line.includes('STARTDT') ||
                line.includes('TESTFR'))           return 'scada-log-line-ctrl';
            return '';
        }

        function render(d) {
            if (!d || !d.ok || !d.running) {
                // Container not reachable
                sessionBadge.textContent = 'OFFLINE';
                sessionBadge.className   = 'scada-iec-session-badge';
                if (dotMaster) dotMaster.className = 'scada-iec-dot down';
                if (dotRtu)    dotRtu.className    = 'scada-iec-dot';
                if (masterCard) masterCard.className = 'scada-iec-node-card session-down';
                if (channel)   channel.className   = 'scada-iec-channel inactive';
                if (svgLed)    svgLed.className.baseVal = 'mpls-status-led mpls-led-idle';
                if (logEl) logEl.innerHTML = `<span class="scada-iec-log-idle">${d?.error || 'Container offline or log empty'}</span>`;
                if (failoverBar) failoverBar.style.display = 'none';
                return;
            }

            const up       = d.sessionUp;
            const fo       = d.failedOver;
            const iface    = d.activeIface || '—';
            // eth2 = primary (normal operation); eth1 = backup (failover state)
            const onBackup = iface === 'eth1' || fo;

            // ── Session badge ──────────────────────────────────────────
            sessionBadge.textContent = up ? (onBackup ? '▲ BACKUP' : '● SESSION UP') : '○ CONNECTING';
            sessionBadge.className   = 'scada-iec-session-badge' + (up ? (onBackup ? ' failover' : ' up') : '');

            // ── Node card states ───────────────────────────────────────
            if (dotMaster) dotMaster.className = `scada-iec-dot ${up ? 'up' : 'down'}`;
            if (dotRtu)    dotRtu.className    = `scada-iec-dot ${(up && d.lastVal !== null) ? 'up' : 'down'}`;
            if (masterCard) masterCard.className = `scada-iec-node-card ${up ? 'session-up' : 'session-down'}`;
            if (rtuCard)    rtuCard.className   = `scada-iec-node-card ${(up && d.lastVal !== null) ? 'session-up' : ''}`;

            // ── Active interface badge ─────────────────────────────────
            if (ifaceBadge) {
                ifaceBadge.textContent = onBackup ? `${iface} BACKUP` : `${iface} PRIMARY`;
                ifaceBadge.className   = 'scada-iec-iface-badge' + (onBackup ? ' backup' : '');
            }
            if (sessionVal) sessionVal.textContent = up ? 'ESTABLISHED' : 'DOWN';
            if (lastTs)     lastTs.textContent     = d.lastTs || '—';

            // ── RTU measurements ───────────────────────────────────────
            if (measVal) measVal.textContent  = d.lastVal !== null ? d.lastVal.toFixed(3) : '—';
            if (sendSeq) sendSeq.textContent  = d.lastSendSeq !== null ? d.lastSendSeq : '—';
            if (quality) quality.textContent  = d.lastVal !== null ? 'GOOD' : '—';

            // ── Channel visualiser ─────────────────────────────────────
            if (channel) channel.className = 'scada-iec-channel' +
                (!up ? ' inactive' : onBackup ? ' failover' : '');

            // ── Failover bar ───────────────────────────────────────────
            if (failoverBar) {
                failoverBar.style.display = onBackup ? '' : 'none';
                if (failoverIface) failoverIface.textContent = iface;
            }

            // ── Log lines ──────────────────────────────────────────────
            if (logEl && d.lastLines?.length) {
                logEl.innerHTML = d.lastLines.map(l => {
                    const cls = classify(l);
                    const safe = l.replace(/</g, '&lt;');
                    return `<div class="${cls}">${safe}</div>`;
                }).join('');
                logEl.scrollTop = logEl.scrollHeight;
            } else if (logEl) {
                logEl.innerHTML = '<span class="scada-iec-log-idle">No log data yet</span>';
            }

            // ── SVG SCADA node ─────────────────────────────────────────
            if (svgLed) {
                const ledState = up ? 'mpls-led-ok' : 'mpls-led-idle';
                svgLed.setAttribute('class', `mpls-status-led ${ledState}`);
            }
            // Normal state: eth2 is primary (active).  Failover: eth1 is backup (active).
            if (svgIfaceText) {
                svgIfaceText.textContent = onBackup ? 'eth1 BACKUP' : 'eth2 PRIMARY';
                svgIfaceText.setAttribute('class', `scada-iface-badge${onBackup ? ' scada-on-backup' : ''}`);
            }
            // eth1 port: backup (standby when normal, active on failover)
            if (svgEth1Port) svgEth1Port.setAttribute('class',
                `scada-port ${onBackup ? 'scada-port-backup scada-port-active' : 'scada-port-backup'}`);
            // eth2 port: primary (active when normal, standby on failover)
            if (svgEth2Port) svgEth2Port.setAttribute('class',
                `scada-port ${onBackup ? 'scada-port-primary scada-port-standby' : 'scada-port-primary'}`);
            // Link lines: eth2→dc2 is primary (solid), eth1→dc1 is backup (dashed)
            if (svgEth1Link) svgEth1Link.setAttribute('class',
                `scada-link ${onBackup ? 'scada-link-backup scada-link-active' : 'scada-link-backup'}`);
            if (svgEth2Link) svgEth2Link.setAttribute('class',
                `scada-link ${onBackup ? 'scada-link-primary scada-link-standby' : 'scada-link-primary'}`);
        }

        async function poll() {
            try {
                const r = await fetch('/api/scada/status', { signal: AbortSignal.timeout(6000) });
                render(r.ok ? await r.json() : null);
            } catch {
                render(null);
            }
        }

        poll();
        setInterval(poll, SCADA_POLL_MS);
    })();

});

