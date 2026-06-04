#!/bin/bash
# ============================================================
#  SmartGrid Nokia Dashboard — Launcher
#  Doppio click da Finder (macOS) oppure esegui da terminale
#  Linux/SSH per avviare il servizio e aprire la dashboard.
# ============================================================

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

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
if lsof -i :3000 -sTCP:LISTEN &>/dev/null 2>&1 || ss -tlnp 2>/dev/null | grep -q ':3000 '; then
    echo -e "${YELLOW}⚠ ping-service già in esecuzione sulla porta 3000${RESET}"
else
    echo -e "${CYAN}▶ Avvio ping-service (porta 3000)...${RESET}"
    # NO_PROXY evita che il proxy aziendale intercetti le richieste a localhost
    NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 \
        node "$DIR/ping-service.js" > /tmp/ping-service.log 2>&1 &
    PING_PID=$!
    sleep 1
    if kill -0 $PING_PID 2>/dev/null; then
        echo -e "${GREEN}✓ ping-service avviato (PID $PING_PID)${RESET}"
    else
        echo -e "${RED}✗ ping-service non si è avviato. Controlla i log:${RESET}"
        echo -e "  tail -20 /tmp/ping-service.log"
        read -p "Premi Invio per chiudere..."
        exit 1
    fi
fi

# Apri la dashboard nel browser — sempre via HTTP (stesso origine del servizio,
# evita che il proxy aziendale intercetti le richieste a localhost:3000).
DASHBOARD_URL="http://localhost:3000/smart-grid.html"
echo ""
echo -e "${CYAN}🌐 Apertura dashboard nel browser...${RESET}"
echo -e "   ${DASHBOARD_URL}"
sleep 0.5
if [[ "$OSTYPE" == "darwin"* ]]; then
    open "$DASHBOARD_URL"
elif command -v xdg-open &>/dev/null; then
    xdg-open "$DASHBOARD_URL" &>/dev/null &
else
    echo -e "${YELLOW}  Apri manualmente: ${DASHBOARD_URL}${RESET}"
fi

echo ""
echo -e "${GREEN}${BOLD}✓ Dashboard avviata!${RESET}"
echo ""
echo -e "  ${BOLD}• ping-service:${RESET}  http://localhost:3000"
echo -e "  ${BOLD}• TPT Deploy:${RESET}    usa il pulsante Deploy nella sezione MPLS"
echo -e "  ${BOLD}• Log:${RESET}           tail -f /tmp/ping-service.log"
echo ""
echo -e "${YELLOW}  Lascia questa finestra aperta finché usi la dashboard.${RESET}"
echo -e "  Chiudi questa finestra per fermare tutti i servizi."
echo ""

# Aspetta e gestisci CTRL+C o chiusura finestra
trap 'echo ""; echo -e "${YELLOW}Arresto servizi...${RESET}"; kill $(lsof -t -i:3000 -sTCP:LISTEN 2>/dev/null) 2>/dev/null; kill $(ss -tlnp 2>/dev/null | awk "/:3000 /{print \$NF}" | grep -oP "pid=\K[0-9]+") 2>/dev/null; echo -e "${GREEN}Servizi fermati.${RESET}"; exit 0' SIGINT SIGTERM

wait
