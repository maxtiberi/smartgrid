#!/bin/sh
# Move the service IP from one interface to another and re-announce ownership.
#
# Usage: failover.sh <target_iface>
#
# Reads SCADA_SVC_IP / SCADA_SVC_CIDR / SCADA_PEER_IF from env or uses
# sensible defaults. Idempotent: safe to call when the IP is already on the
# target interface (the del is best-effort).

set -eu

TARGET="${1:?usage: failover.sh <iface>}"
SVC_IP="${SCADA_SVC_IP:-192.168.200.1}"
CIDR="${SCADA_SVC_CIDR:-29}"

# Strip the IP from every interface other than the target. This keeps the
# active interface unique and is safe regardless of which side ran the
# script last.
for IFACE in $(ls /sys/class/net | grep -E '^eth[0-9]+$' || true); do
    if [ "$IFACE" != "$TARGET" ]; then
        ip addr del "${SVC_IP}/${CIDR}" dev "$IFACE" 2>/dev/null || true
    fi
done

# Ensure the target is up and carries the service IP.
ip link set "$TARGET" up
if ! ip addr show dev "$TARGET" | grep -q "inet ${SVC_IP}/"; then
    ip addr add "${SVC_IP}/${CIDR}" dev "$TARGET"
fi

# Gratuitous ARP so upstream switches relearn the MAC quickly.
if command -v arping >/dev/null 2>&1; then
    arping -c 3 -A -I "$TARGET" "$SVC_IP" >/dev/null 2>&1 || true
fi

echo "service IP ${SVC_IP}/${CIDR} now on ${TARGET}"
