# Smart Grid Monitoring & Control Dashboard

A comprehensive web-based monitoring and control system for Smart Grid infrastructure, featuring real-time visualization of power generation, distribution networks, and telecommunications infrastructure.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Status](https://img.shields.io/badge/status-active-success.svg)

## 🌐 Live Demo

**[View Dashboard](https://maxtiberi.github.io/smartgrid/)**

## 📋 Overview

This Smart Grid Dashboard provides an interactive visualization and control interface for monitoring electrical power generation, transmission, and distribution systems integrated with Nokia SR Linux telecommunications infrastructure. The system demonstrates the convergence of power grid operations with modern IP/MPLS networking technology.

### Key Features

- **Multi-source Power Generation Control**: Nuclear, Solar, and Wind power plants
- **Real-time Network Topology Visualization**: SVG-based interactive diagrams
- **Telecommunications Infrastructure Monitoring**: Nokia SR Linux routers (DC, Leaf, RTU)
- **IEC 61850 GOOSE Protocol Simulation**: Differential teleprotection between transmission units
- **Electric Turbine Animation**: Real-time visualization with voltage waveforms
- **High Voltage Transmission Monitoring**: 4 transmission towers with visual power flow indicators

## 🏗️ Architecture Components

### 1. Power Generation Layer

#### Nuclear Plants (2x)
- **Capacity**: 1200 MW each
- **Features**: 
  - Variable power output control (0-100%)
  - Ramp-up/ramp-down simulation
  - Visual turbine rotation animation
  - Power level indicators (15 LED indicators per plant)
- **Location Designations**: Nuclear α, Nuclear β

#### Solar Farm
- **Capacity**: 500 MW
- **Features**:
  - Simulated solar radiation variations
  - Automatic power fluctuation based on weather conditions
  - Real-time output monitoring

#### Wind Farm
- **Capacity**: 400 MW
- **Features**:
  - Dynamic wind speed simulation
  - Automatic power variation
  - Rotating turbine blade animation

### 2. Distribution Network

#### Distribution Hub
- **Function**: Central aggregation point for all power generation sources
- **Capacity**: Aggregates up to 3,300 MW total capacity
- **Connections**: 
  - 4 input connections (from generation sources)
  - 4 output connections (to transmission units)
- **Efficiency**: 95% transmission efficiency

#### Transmission Units (T1-T4)
- **Quantity**: 4 units
- **Function**: High-voltage transmission substations
- **Monitoring**: 
  - Ping-based availability monitoring
  - Individual unit status indicators
  - Automatic power reduction on unit failure
- **IP Addresses**: 
  - T1: 172.20.20.20
  - T2: 172.20.20.21
  - T3: 172.20.20.22
  - T4: 172.20.20.23

### 3. Telecommunications Infrastructure

#### Data Centers (DC-1, DC-2)
- **Type**: Nokia SR Linux core routers
- **Function**: Primary network aggregation and routing
- **Monitoring**:
  - gNMI telemetry (port 3001)
  - Real-time metrics: CPU, Memory, Uptime
  - Interface statistics (ethernet-1/1 through ethernet-1/4)
  - BGP peer status and prefix counts
- **Network**: 172.20.20.x subnet

#### Leaf Switches (4x)
- **Type**: Nokia SR Linux access layer switches
- **Function**: Edge connectivity for RTU units
- **Ports**: 2225-2228 (Leaf-1 through Leaf-4)
- **Features**:
  - 4 uplinks to DC routers (redundant paths)
  - 1 downlink to RTU
  - Link state monitoring

#### Remote Terminal Units (RTU 1-4)
- **Function**: Field monitoring and control devices
- **Connectivity**: Connected to high-voltage transmission towers
- **Features**:
  - SCADA integration points
  - Real-time sensor data collection
  - Industrial Ethernet connectivity

### 4. Teleprotection System

#### GOOSE Protocol (IEC 61850)
- **Implementation**: T1 ↔ T2 differential protection
- **Function**: Fast communication for protection relaying
- **Visualization**: 
  - Real-time GOOSE message animation (1.5s cycle)
  - Circuit breaker status (CLOSED/OPEN)
  - DC router reachability indicators
- **Monitoring**:
  - DC1 reachability status
  - DC2 reachability status
  - Automatic circuit state updates

### 5. Electric Turbine Visualization

#### Main Turbine Display
- **Type**: 8-blade turbine rotor
- **Features**:
  - Rotational animation (0-1500 RPM)
  - Variable speed control slider
  - Real-time voltage waveform (50 Hz)
  - Power output metrics
  - Efficiency gauge

#### Installation Diagram
- **Bars**: Visual representation of turbine power generation
- **Stats**: Vehicle count and rotation metrics

### 6. City Grid (Load)
- **Demand**: 2800 MW constant load
- **Display**: 
  - Real-time power received indicator
  - Visual building representation (4 buildings)
  - Color-coded status:
    - Red: No power
    - Yellow: Low power (<2200 MW)
    - Green: Adequate power (≥2200 MW)

### 7. High Voltage Transmission Lines

#### Visual Components
- **Towers**: 4 transmission towers with realistic design
- **Power Lines**: 3-phase high voltage lines
- **Insulators**: Animated electrical arc effects
- **Energy Pulses**: Multiple animated particles simulating AC current flow
- **Features**:
  - Realistic AC current simulation with phased pulses
  - Golden/yellow pulse animations
  - Variable pulse speeds and intensities

## 🛠️ Technology Stack

### Frontend
- **HTML5**: Semantic markup and structure
- **CSS3**: Advanced styling with animations and transitions
- **JavaScript (ES6+)**: Core application logic
- **SVG**: Scalable vector graphics for network diagrams
- **Canvas API**: Voltage waveform rendering

### Protocols & Standards
- **IEC 61850**: International standard for power utility automation
- **GOOSE**: Generic Object Oriented Substation Event messages
- **gNMI**: gRPC Network Management Interface (Nokia SR Linux)
- **BGP**: Border Gateway Protocol routing

### Architecture Pattern
- **MVC-inspired**: Separation of concerns
- **Event-driven**: Real-time updates via JavaScript events
- **Component-based**: Modular CSS and JavaScript

## 📁 Project Structure

```
smartgrid/
├── github-pages-demo/
│   ├── index.html              # Main HTML structure
│   ├── smart-grid.css          # Main stylesheet (network topology, plants, city)
│   ├── smart-grid.js           # Main controller logic
│   ├── turbine-styles.css      # Turbine-specific styles
│   ├── turbine-control.js      # Turbine animation and control logic
│   └── README.md               # Italian documentation
├── .github/
│   └── workflows/
│       └── deploy-pages.yml    # GitHub Actions deployment workflow
└── README.md                   # This file (English documentation)
```

### File Descriptions

#### `index.html` (1,111 lines)
- Network topology SVG diagrams
- Power plant control interfaces
- Router infrastructure visualization
- Turbine animation container
- High voltage transmission lines
- Teleprotection status indicators

#### `smart-grid.css` (1,879 lines)
- Grid layout and responsive design
- Plant card styling
- Network node and connection styles
- Topology diagram animations
- City grid visualization
- Router panel and tooltip styles

#### `smart-grid.js` (761 lines)
- SmartGrid class (main controller)
- Power plant state management
- Network topology updates
- Router telemetry simulation
- Transmission unit monitoring
- Teleprotection state logic

#### `turbine-control.js` (300 lines)
- Turbine animation controller
- Voltage waveform rendering (Canvas)
- Speed control logic
- Power output calculations
- Status indicator management

#### `turbine-styles.css` (377 lines)
- Turbine visualization styles
- Control panel styling
- Waveform canvas container
- Installation diagram styles
- Status indicator styles

## 🚀 Getting Started

### Prerequisites
- Modern web browser (Chrome, Firefox, Safari, Edge)
- HTTP server (for local development) or direct file:// access

### Local Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/maxtiberi/smartgrid.git
   cd smartgrid
   ```

2. **Navigate to dashboard directory**
   ```bash
   cd github-pages-demo
   ```

3. **Open in browser**
   ```bash
   # Option 1: Direct file access
   open index.html
   
   # Option 2: Using Python HTTP server
   python3 -m http.server 8000
   # Then visit http://localhost:8000
   
   # Option 3: Using Node.js http-server
   npx http-server -p 8000
   ```

### GitHub Pages Deployment

The project is configured for automatic deployment via GitHub Actions:

1. Push changes to the `claude/upload-html-dashboard-OxA9P` branch
2. GitHub Actions workflow automatically deploys to GitHub Pages
3. Access at: https://maxtiberi.github.io/smartgrid/

**Workflow Configuration**: `.github/workflows/deploy-pages.yml`

## 🎮 User Guide

### Starting Power Plants

1. **Nuclear Plants**:
   - Click "START" button
   - Adjust power level with slider (0-100%)
   - Watch turbine animation rotate
   - Monitor LED power indicators

2. **Solar/Wind Farms**:
   - Click "START" button
   - Power output varies automatically
   - Observe output fluctuations

### Distribution Network

1. Click "START" on Distribution Network card
2. Power flows from plants to transmission units
3. Animated particles show energy flow

### Router Monitoring

1. **Hover** over router nodes for quick info
2. **Click** on DC-1 or DC-2 for detailed panel:
   - System uptime and resource usage
   - Interface statistics (in/out octets)
   - BGP peer status and prefix counts

### Turbine Control

1. **Speed Slider**: Adjust turbine rotation (0-100%)
2. **Stop/Start Button**: Toggle turbine operation
3. **Waveform**: Real-time voltage visualization
4. **Status Indicators**: Monitor system, rotor, generator, and network status

## 📊 Demo Mode

The current implementation runs in **DEMO MODE**, simulating backend services:

### Production vs Demo

| Component | Production | Demo |
|-----------|-----------|------|
| Router Telemetry | gNMI (gRPC) from Nokia SR Linux | Simulated metrics |
| Transmission Monitoring | ICMP ping to RTU IPs | Always-online simulation |
| Power Output | Real SCADA measurements | Calculated values with randomization |
| GOOSE Messages | Real IEC 61850 packets | Visual animation only |

### Production Architecture

In a production deployment:
1. **gNMI Service** (port 3001) collects telemetry from Nokia SR Linux routers
2. **Ping Service** monitors transmission unit availability
3. **SCADA Integration** provides real power generation data
4. **GOOSE Subscriber** receives IEC 61850 teleprotection messages
5. **WebSocket Server** streams real-time data to dashboard

## 🔧 Configuration

### Modifying Capacities

Edit `smart-grid.js`:
```javascript
this.plants = {
    nuclear1: { capacity: 1200, output: 0, active: false, rampRate: 20 },
    nuclear2: { capacity: 1200, output: 0, active: false, rampRate: 20 },
    solar: { capacity: 500, output: 0, active: false, rampRate: 15 },
    wind: { capacity: 400, output: 0, active: false, rampRate: 12 }
};
```

### Adjusting Network Topology

Edit `index.html` SVG paths and coordinates:
```html
<!-- Example: Moving a node -->
<g class="node-group" data-node="nuclear1" transform="translate(150, 100)">
```

## 🧪 Testing

### Manual Testing Checklist

- [ ] All power plants start/stop correctly
- [ ] Power sliders adjust nuclear output
- [ ] Distribution network activates/deactivates
- [ ] City power indicator updates correctly
- [ ] Router nodes show tooltips on hover
- [ ] Router panels open with details
- [ ] Turbine animation responds to controls
- [ ] Voltage waveform renders smoothly
- [ ] Teleprotection status updates
- [ ] All animations run without performance issues

## 📈 Performance Considerations

- **Animation Frame Rate**: 60 FPS target for all animations
- **SVG Optimization**: Minimal DOM manipulation
- **Event Throttling**: Mouse events throttled to prevent lag
- **Memory Management**: Proper cleanup of intervals and listeners

## 🔒 Security Notes

- Demo mode only - no authentication required
- No persistent storage or cookies
- No external API calls (demo simulation)
- Safe for public hosting on GitHub Pages

## 🤝 Contributing

This project is part of a Smart Grid automation demonstration. For production deployments or enhancements:

1. Review the architecture documentation in Notion: "Automazione e Reti Elettriche"
2. Understand IEC 61850 and gNMI protocols
3. Consider Nokia SR Linux integration requirements
4. Follow industrial automation security standards

## 📝 License

This project is developed for educational and demonstration purposes.

## 🏷️ Keywords

`Smart Grid` `Power Generation` `Nokia SR Linux` `gNMI` `IEC 61850` `GOOSE Protocol` `Teleprotection` `SCADA` `Network Monitoring` `SVG Visualization` `Industrial Automation` `IP/MPLS` `BGP` `High Voltage` `Transmission Network`

## 📞 Contact

**Project**: Smart Grid Nokia Dashboard  
**Repository**: https://github.com/maxtiberi/smartgrid  
**Live Demo**: https://maxtiberi.github.io/smartgrid/

---

*Developed for Smart Grid infrastructure monitoring and control with Nokia SR Linux telecommunications integration*
