#!/bin/bash
# ============================================================
#  SmartGrid Nokia Dashboard — Launcher
#  Doppio click da Finder per avviare il servizio e aprire
#  la dashboard nel browser.
# ============================================================

# Vai nella cartella del progetto (dove si trova questo file)
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# Colori terminale
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${CYAN}║   SmartGrid Nokia Dashboard — Launcher   ║${RESET}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════╝${RESET}"
echo ""

# Controlla se Node.js è installato
if ! command -v node &>/dev/null; then
    echo -e "${RED}✗ Node.js non trovato.${RESET}"
    echo "  Installa Node.js da https://nodejs.org e riprova."
    echo ""
    read -p "Premi Invio per chiudere..."
    exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version) trovato${RESET}"

# Controlla se node_modules esiste, altrimenti npm install
if [ ! -d "$DIR/node_modules" ]; then
    echo -e "${YELLOW}⏳ Prima esecuzione — installazione dipendenze npm...${RESET}"
    npm install
    if [ $? -ne 0 ]; then
        echo -e "${RED}✗ npm install fallito. Controlla la connessione internet.${RESET}"
        read -p "Premi Invio per chiudere..."
        exit 1
    fi
    echo -e "${GREEN}✓ Dipendenze installate${RESET}"
fi

# Controlla se ping-service è già in esecuzione sulla porta 3000
if lsof -i :3000 -sTCP:LISTEN &>/dev/null; then
    echo -e "${YELLOW}⚠ ping-service già in esecuzione sulla porta 3000${RESET}"
else
    echo -e "${CYAN}▶ Avvio ping-service (porta 3000)...${RESET}"
    node "$DIR/ping-service.js" &
    PING_PID=$!
    sleep 1
    if kill -0 $PING_PID 2>/dev/null; then
        echo -e "${GREEN}✓ ping-service avviato (PID $PING_PID)${RESET}"
    else
        echo -e "${RED}✗ ping-service non si è avviato. Controlla i log sopra.${RESET}"
        read -p "Premi Invio per chiudere..."
        exit 1
    fi
fi

# Apri la dashboard nel browser predefinito
DASHBOARD_URL="file://$DIR/smart-grid.html"
echo ""
echo -e "${CYAN}🌐 Apertura dashboard nel browser...${RESET}"
echo -e "   ${DASHBOARD_URL}"
sleep 0.5
open "$DASHBOARD_URL"

echo ""
echo -e "${GREEN}${BOLD}✓ Dashboard avviata!${RESET}"
echo ""
echo -e "  ${BOLD}• ping-service:${RESET}  http://localhost:3000"
echo -e "  ${BOLD}• gNMI service:${RESET}  avviabile dalla dashboard con il pulsante ▶"
echo ""
echo -e "${YELLOW}  Lascia questa finestra aperta finché usi la dashboard.${RESET}"
echo -e "  Chiudi questa finestra per fermare tutti i servizi."
echo ""

# Aspetta e gestisci CTRL+C o chiusura finestra
trap 'echo ""; echo -e "${YELLOW}Arresto servizi...${RESET}"; kill $(lsof -t -i:3000 -sTCP:LISTEN) 2>/dev/null; kill $(lsof -t -i:3001 -sTCP:LISTEN) 2>/dev/null; echo -e "${GREEN}Servizi fermati.${RESET}"; exit 0' SIGINT SIGTERM

# Mantieni attivo il terminale
wait
