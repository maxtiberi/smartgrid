#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  install-tpt.sh  —  Deploy IEC 61850 TPT Daemon to MPLS RTU containers
#
#  Usage:
#    ./scripts/install-tpt.sh [rtu1-container] [rtu2-container]
#
#  Defaults (network.yaml has prefix: "" so names are bare node names):
#    RTU-1 container : RTU1
#    RTU-2 container : RTU2
#
#  RTU IPs (from network.yaml / containerlab inspect):
#    RTU-1 mgmt : 192.168.30.6   GOOSE eth1: 192.168.100.3
#    RTU-2 mgmt : 192.168.30.7   GOOSE eth1: 192.168.100.4
#
#  Libraries required inside each container (Debian/Ubuntu/Alpine):
#    python3 >= 3.8          — standard in most base images
#    No pip packages needed  — pure Python standard library only
#
#  Optional (for offline ASN.1 inspection):
#    pip3 install pyasn1
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_SRC="${SCRIPT_DIR}/tpt-daemon.py"
DAEMON_DST="/app/tpt-daemon.py"

RTU1_CONTAINER="${1:-RTU1}"
RTU2_CONTAINER="${2:-RTU2}"
RTU1_MGMT_IP="192.168.30.6"    # management IP — used to reach HTTP API from host
RTU2_MGMT_IP="192.168.30.7"
RTU1_GOOSE_IP="192.168.100.3"  # eth1 IP — GOOSE UDP bind/send address
RTU2_GOOSE_IP="192.168.100.4"
API_PORT="8850"

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'; BLU='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLU}[INFO ]${NC}  $*"; }
ok()      { echo -e "${GRN}[ OK  ]${NC}  $*"; }
warn()    { echo -e "${YLW}[WARN ]${NC}  $*"; }
die()     { echo -e "${RED}[FAIL ]${NC}  $*" >&2; exit 1; }

# ── Pre-flight checks ──────────────────────────────────────────────
command -v docker &>/dev/null || die "docker not found in PATH"
[[ -f "${DAEMON_SRC}" ]]       || die "Daemon not found: ${DAEMON_SRC}"

info "Checking containers are running..."
docker inspect "${RTU1_CONTAINER}" &>/dev/null || die "Container not found: ${RTU1_CONTAINER}"
docker inspect "${RTU2_CONTAINER}" &>/dev/null || die "Container not found: ${RTU2_CONTAINER}"
ok "Both containers reachable"

# ── Install python3 if missing (Alpine or Debian) ──────────────────
install_python() {
    local cname="$1"
    info "Checking python3 in ${cname}..."
    if docker exec "${cname}" python3 --version &>/dev/null; then
        ok "python3 already present in ${cname}"
    else
        warn "python3 not found — attempting install (Alpine apk / Debian apt)"
        docker exec "${cname}" sh -c 'apk add --no-cache python3 2>/dev/null || apt-get install -y python3 2>/dev/null' \
            || die "Could not install python3 in ${cname}. Install manually."
        ok "python3 installed in ${cname}"
    fi
}

install_python "${RTU1_CONTAINER}"
install_python "${RTU2_CONTAINER}"

# ── Copy daemon script ─────────────────────────────────────────────
info "Copying tpt-daemon.py to containers..."
docker exec "${RTU1_CONTAINER}" mkdir -p /app
docker exec "${RTU2_CONTAINER}" mkdir -p /app
docker cp "${DAEMON_SRC}" "${RTU1_CONTAINER}:${DAEMON_DST}"
docker cp "${DAEMON_SRC}" "${RTU2_CONTAINER}:${DAEMON_DST}"
docker exec "${RTU1_CONTAINER}" chmod +x "${DAEMON_DST}"
docker exec "${RTU2_CONTAINER}" chmod +x "${DAEMON_DST}"
ok "Daemon copied to both containers"

# ── Kill any previous instance ─────────────────────────────────────
kill_prev() {
    local cname="$1"
    # pkill returns 1 when no process matches — that is fine; never fail the script
    docker exec "${cname}" sh -c \
        "pkill -f tpt-daemon.py 2>/dev/null; sleep 0.3; exit 0" || true
}
info "Stopping any previous daemon instances..."
kill_prev "${RTU1_CONTAINER}" || true
kill_prev "${RTU2_CONTAINER}" || true

# ── Launch daemon in each container ───────────────────────────────
info "Starting TPT daemon on RTU-1 (GOOSE: ${RTU1_GOOSE_IP})..."
docker exec -d "${RTU1_CONTAINER}" python3 "${DAEMON_DST}" \
    --local "${RTU1_GOOSE_IP}" \
    --peer  "${RTU2_GOOSE_IP}" \
    --api-port "${API_PORT}" \
    --auto-start \
    --sim-telemetry
ok "RTU-1 daemon launched"

info "Starting TPT daemon on RTU-2 (GOOSE: ${RTU2_GOOSE_IP})..."
docker exec -d "${RTU2_CONTAINER}" python3 "${DAEMON_DST}" \
    --local "${RTU2_GOOSE_IP}" \
    --peer  "${RTU1_GOOSE_IP}" \
    --api-port "${API_PORT}" \
    --auto-start \
    --sim-telemetry
ok "RTU-2 daemon launched"

# ── Wait and verify ────────────────────────────────────────────────
info "Waiting 2 s for APIs to initialize..."
sleep 2

check_api() {
    local ip="$1"
    local name="$2"
    if curl -sf --max-time 3 "http://${ip}:${API_PORT}/health" | grep -q 'local_ip'; then
        ok "${name} API reachable at http://${ip}:${API_PORT}"
    else
        warn "${name} API not yet responding at http://${ip}:${API_PORT} — check logs"
        warn "  docker exec ${RTU1_CONTAINER} cat /proc/\$(pgrep -f tpt-daemon)/fd/1 2>/dev/null"
    fi
}

check_api "${RTU1_MGMT_IP}" "RTU-1" || true
check_api "${RTU2_MGMT_IP}" "RTU-2" || true

echo ""
echo -e "${GRN}══════════════════════════════════════════════════${NC}"
echo -e "${GRN}  TPT Daemon installed and running on both RTUs   ${NC}"
echo -e "${GRN}══════════════════════════════════════════════════${NC}"
echo ""
echo "  RTU-1 API:  http://${RTU1_MGMT_IP}:${API_PORT}/status"
echo "  RTU-2 API:  http://${RTU2_MGMT_IP}:${API_PORT}/status"
echo ""
echo "  Dashboard start/stop via:  http://localhost:3000/api/tpt/start"
echo "  To view logs:              http://localhost:3000/api/tpt/log"
echo ""
echo "  To restart daemons:        ./scripts/install-tpt.sh"
echo "  To stop:  docker exec ${RTU1_CONTAINER} pkill -f tpt-daemon.py"
echo "            docker exec ${RTU2_CONTAINER} pkill -f tpt-daemon.py"
