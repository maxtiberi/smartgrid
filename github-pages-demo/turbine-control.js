// Turbine Control System
class TurbineControl {
    constructor() {
        // State
        this.speed = 50;
        this.isRunning = true;
        this.power = 0;
        this.maxRPM = 3000;
        this.waveformPhase = 0;

        // Elements
        this.speedSlider = document.getElementById('turbineSpeedSlider');
        this.speedPercentage = document.getElementById('turbineSpeedPercentage');
        this.toggleButton = document.getElementById('turbineToggleButton');
        this.turbineRotor = document.getElementById('turbineRotor');
        this.rpmValue = document.getElementById('turbineRpmValue');
        this.outputValue = document.getElementById('turbineOutputValue');
        this.outputBar = document.getElementById('turbineOutputBar');
        this.efficiencyValue = document.getElementById('turbineEfficiencyValue');
        this.efficiencyBar = document.getElementById('turbineEfficiencyBar');
        this.vehicleDot = document.getElementById('turbineVehicleDot');
        this.barsContainer = document.getElementById('turbineBarsContainer');

        // Status indicators
        this.systemIndicator = document.getElementById('turbineSystemIndicator');
        this.rotorIndicator = document.getElementById('turbineRotorIndicator');
        this.generatorIndicator = document.getElementById('turbineGeneratorIndicator');
        this.networkIndicator = document.getElementById('turbineNetworkIndicator');

        // Waveform
        this.waveformCanvas = document.getElementById('turbineWaveformCanvas');
        this.waveformCtx = this.waveformCanvas ? this.waveformCanvas.getContext('2d') : null;
        this.voltageValueDisplay = document.getElementById('turbineVoltageValue');

        this.init();
    }

    init() {
        this.generateBars();
        this.generateBlades();
        this.updateSliderBackground();
        this.updatePower();
        this.updateRotation();
        if (this.waveformCtx) {
            this.drawWaveform();
        }

        // Event Listeners
        if (this.speedSlider) {
            this.speedSlider.addEventListener('input', (e) => {
                this.speed = parseInt(e.target.value);
                this.speedPercentage.textContent = this.speed + '%';
                this.updateSliderBackground();
                this.updatePower();
                this.updateRotation();
            });
        }

        if (this.toggleButton) {
            this.toggleButton.addEventListener('click', () => {
                this.isRunning = !this.isRunning;

                if (this.isRunning) {
                    this.toggleButton.textContent = 'ARRESTA / STOP';
                    this.toggleButton.className = 'turbine-toggle-button running';
                } else {
                    this.toggleButton.textContent = 'AVVIA / START';
                    this.toggleButton.className = 'turbine-toggle-button stopped';
                }

                this.updatePower();
                this.updateRotation();
            });
        }
    }

    generateBars() {
        if (!this.barsContainer) return;

        for (let i = 0; i < 12; i++) {
            const bar = document.createElement('div');
            bar.className = 'turbine-bar';
            bar.style.height = Math.min(100, (i + 1) * 8) + '%';
            bar.id = `turbineBar${i}`;
            this.barsContainer.appendChild(bar);
        }

        // Add label
        const label = document.createElement('span');
        label.className = 'turbine-bars-label';
        label.id = 'turbineBarsLabel';
        label.innerHTML = `${this.speed}%<br/>velocità`;
        this.barsContainer.appendChild(label);
    }

    generateBlades() {
        if (!this.turbineRotor) return;

        const bladeCount = 8;
        for (let i = 0; i < bladeCount; i++) {
            const angle = i * (360 / bladeCount);
            const blade = document.createElement('div');
            blade.className = 'turbine-blade';
            blade.style.transform = `rotate(${angle}deg) translateX(-50%)`;

            const bladeShape = document.createElement('div');
            bladeShape.className = 'turbine-blade-shape';
            blade.appendChild(bladeShape);

            this.turbineRotor.insertBefore(blade, this.turbineRotor.firstChild);
        }
    }

    updateRotation() {
        if (!this.turbineRotor) return;

        if (this.isRunning && this.speed > 0) {
            const currentRPM = Math.round((this.speed / 100) * this.maxRPM);
            const rotationDuration = Math.max(0.1, 60 / currentRPM);
            this.turbineRotor.style.animation = `turbineSpin ${rotationDuration}s linear infinite`;
        } else {
            this.turbineRotor.style.animation = 'none';
        }
    }

    updatePower() {
        if (this.isRunning) {
            this.power = Math.round(this.speed * 12.5);
        } else {
            this.power = 0;
        }

        const currentRPM = this.isRunning ? Math.round((this.speed / 100) * this.maxRPM) : 0;
        const efficiency = this.isRunning ? 87 : 0;

        // Update displays
        if (this.rpmValue) this.rpmValue.textContent = currentRPM.toLocaleString() + ' RPM';
        if (this.outputValue) this.outputValue.textContent = this.power;
        if (this.outputBar) this.outputBar.style.width = (this.power / 1250) * 100 + '%';
        if (this.efficiencyValue) this.efficiencyValue.textContent = efficiency;
        if (this.efficiencyBar) this.efficiencyBar.style.width = efficiency + '%';

        // Update vehicle dot
        if (this.vehicleDot) {
            this.vehicleDot.style.backgroundColor = this.isRunning ? '#4a4a4a' : '#c0c0c0';
        }

        // Update bars
        this.updateBars();

        // Update status indicators
        this.updateIndicators();
    }

    updateBars() {
        if (!this.barsContainer) return;

        for (let i = 0; i < 12; i++) {
            const bar = document.getElementById(`turbineBar${i}`);
            if (bar) {
                bar.style.opacity = this.speed > i * 8 ? 1 : 0.2;
            }
        }
        const label = document.getElementById('turbineBarsLabel');
        if (label) {
            label.innerHTML = `${this.speed}%<br/>velocità`;
        }
    }

    updateIndicators() {
        // Sistema is always active
        if (this.systemIndicator) {
            this.systemIndicator.className = 'turbine-indicator-circle active';
            this.systemIndicator.textContent = '●';
        }

        // Rotore active when running
        if (this.rotorIndicator) {
            if (this.isRunning) {
                this.rotorIndicator.className = 'turbine-indicator-circle active';
                this.rotorIndicator.textContent = '●';
            } else {
                this.rotorIndicator.className = 'turbine-indicator-circle inactive';
                this.rotorIndicator.textContent = '○';
            }
        }

        // Generatore active when running and speed > 20
        if (this.generatorIndicator) {
            if (this.isRunning && this.speed > 20) {
                this.generatorIndicator.className = 'turbine-indicator-circle active';
                this.generatorIndicator.textContent = '●';
            } else {
                this.generatorIndicator.className = 'turbine-indicator-circle inactive';
                this.generatorIndicator.textContent = '○';
            }
        }

        // Rete active when running and speed > 50
        if (this.networkIndicator) {
            if (this.isRunning && this.speed > 50) {
                this.networkIndicator.className = 'turbine-indicator-circle active';
                this.networkIndicator.textContent = '●';
            } else {
                this.networkIndicator.className = 'turbine-indicator-circle inactive';
                this.networkIndicator.textContent = '○';
            }
        }
    }

    updateSliderBackground() {
        if (this.speedSlider) {
            this.speedSlider.style.background = `linear-gradient(to right, #4a4a4a 0%, #4a4a4a ${this.speed}%, #d0cec9 ${this.speed}%, #d0cec9 100%)`;
        }
    }

    drawWaveform() {
        if (!this.waveformCtx || !this.waveformCanvas) return;

        const width = this.waveformCanvas.width;
        const height = this.waveformCanvas.height;
        const centerY = height / 2;

        // Clear canvas
        this.waveformCtx.fillStyle = '#f5f3ef';
        this.waveformCtx.fillRect(0, 0, width, height);

        // Draw grid lines
        this.waveformCtx.strokeStyle = '#d0cec9';
        this.waveformCtx.lineWidth = 1;

        // Horizontal center line
        this.waveformCtx.beginPath();
        this.waveformCtx.moveTo(0, centerY);
        this.waveformCtx.lineTo(width, centerY);
        this.waveformCtx.stroke();

        // Vertical grid lines
        for (let x = 0; x < width; x += width / 4) {
            this.waveformCtx.beginPath();
            this.waveformCtx.moveTo(x, 0);
            this.waveformCtx.lineTo(x, height);
            this.waveformCtx.stroke();
        }

        // Calculate voltage based on RPM
        const currentRPM = this.isRunning ? (this.speed / 100) * this.maxRPM : 0;
        const peakVoltage = (currentRPM / this.maxRPM) * 325;
        const amplitude = (peakVoltage / 325) * (height / 2 - 20);

        // Draw sine wave
        if (this.isRunning && this.speed > 0) {
            this.waveformCtx.strokeStyle = '#4a4a4a';
            this.waveformCtx.lineWidth = 2;
            this.waveformCtx.beginPath();

            // Draw 2 complete cycles (50Hz)
            const frequency = 2;
            for (let x = 0; x < width; x++) {
                const angle = (x / width) * Math.PI * 2 * frequency + this.waveformPhase;
                const y = centerY - Math.sin(angle) * amplitude;

                if (x === 0) {
                    this.waveformCtx.moveTo(x, y);
                } else {
                    this.waveformCtx.lineTo(x, y);
                }
            }

            this.waveformCtx.stroke();

            // Update phase for animation
            const animationSpeed = 0.05 * (this.speed / 100);
            this.waveformPhase += animationSpeed;
            if (this.waveformPhase > Math.PI * 2) {
                this.waveformPhase -= Math.PI * 2;
            }

            // Update voltage display
            const instantVoltage = Math.round(Math.sin(this.waveformPhase) * peakVoltage);
            if (this.voltageValueDisplay) {
                this.voltageValueDisplay.textContent = `${instantVoltage} V`;
            }
        } else {
            // Show 0V when stopped
            if (this.voltageValueDisplay) {
                this.voltageValueDisplay.textContent = '0 V';
            }
            this.waveformPhase = 0;
        }

        // Continue animation
        requestAnimationFrame(() => this.drawWaveform());
    }
}

// Initialize Turbine Control when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new TurbineControl();
});
