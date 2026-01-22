# Smart Grid Nokia Dashboard - Demo

Questa è una demo interattiva della **Smart Grid Nokia Dashboard**, un'applicazione per la simulazione e il monitoraggio di una rete elettrica intelligente.

## 🎮 Demo Live

Visita: **https://YOUR-USERNAME.github.io/smart-grid-nokia-dashboard/**

## 📖 Descrizione

L'applicazione simula:
- **Centrali di generazione**: Nuclear (2x), Solar, Wind
- **Rete di distribuzione**: Hub di distribuzione con 4 unità di trasmissione (T1-T4)
- **Infrastruttura router**: DC-1, DC-2, Leaf switches, RTU units
- **Teleprotezione differenziale**: Monitoraggio GOOSE tra T1 e T2
- **Turbina elettrica**: Visualizzazione della generazione con forma d'onda

## 🚀 Funzionalità

### Topologia di Rete
- Visualizzazione SVG interattiva della rete elettrica
- Animazioni per il flusso di energia
- Stato dei collegamenti (verde = attivo, rosso = fault)

### Controllo Centrali
- Avvio/arresto delle centrali elettriche
- Controllo del livello di potenza per le centrali nucleari (slider)
- Variazioni simulate per solar e wind

### Infrastruttura Router
- Topologia DC-Leaf-RTU
- Click sui nodi per dettagli (CPU, memoria, interfacce, BGP)
- Monitoraggio stato dei link

### Teleprotezione
- Stato del circuito differenziale T1↔T2
- Indicatori di raggiungibilità DC1/DC2

## ⚠️ Nota sulla Demo

Questa versione **demo** simula i dati che normalmente provengono da:
- **gNMI Service** (porta 3001) - Telemetria router SR Linux
- **Ping Service** - Monitoraggio unità di trasmissione

Nella versione completa, questi dati sono raccolti in tempo reale dai router Nokia SR Linux tramite gRPC/gNMI.

## 📁 Struttura File

```
├── index.html          # Pagina principale
├── smart-grid.css      # Stili principali
├── smart-grid.js       # Controller (versione demo)
├── turbine-styles.css  # Stili sezione turbina
└── turbine-control.js  # Controller turbina
```

## 🔧 Utilizzo Locale

1. Clona il repository
2. Apri `index.html` nel browser
3. Interagisci con i controlli per simulare la rete

## 📚 Documentazione Completa

Per la documentazione completa sull'architettura e il deployment production, consulta l'articolo **"Automazione e Reti Elettriche"** su Notion.

## 🏷️ Tags

`Smart Grid` `Nokia` `SR Linux` `gNMI` `Teleprotezione` `GOOSE` `IEC 61850`

---

*Sviluppato per la simulazione di reti elettriche intelligenti con infrastruttura Nokia IP/MPLS*
