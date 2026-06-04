#!/bin/sh
# One-time setup inside SCADA or RTU container.
#
# Usage: setup.sh <role>
#   role = scada   -> service IP 192.168.200.1/24, places it on eth1
#   role = rtu     -> service IP 192.168.200.2/24, places it on eth1
#
# Both sides:
#   - Set arp_ignore/arp_announce so each NIC only ARPs for its own IPs
#     (avoids cross-interface ARP confusion when the IP migrates).
#   - Bring eth1 and eth2 up.
#   - Drop any pre-existing 192.168.200.x address on eth1/eth2.
#   - Add the service IP to eth1 as the initial active interface.

set -eu

ROLE="${1:?usage: setup.sh <scada|rtu>}"

case "$ROLE" in
    scada) SVC_IP="192.168.200.1" ;;
    rtu)   SVC_IP="192.168.200.2" ;;
    *) echo "unknown role: $ROLE" >&2; exit 2 ;;
esac

CIDR=24

# Per-interface ARP sanity: respond only for IPs on the receiving NIC,
# announce using the source IP of the outgoing NIC. Standard for
# multihomed Linux hosts that share an IP via app-level failover.
sysctl -w net.ipv4.conf.all.arp_ignore=1 >/dev/null
sysctl -w net.ipv4.conf.all.arp_announce=2 >/dev/null
sysctl -w net.ipv4.conf.eth1.arp_ignore=1 >/dev/null 2>&1 || true
sysctl -w net.ipv4.conf.eth1.arp_announce=2 >/dev/null 2>&1 || true
sysctl -w net.ipv4.conf.eth2.arp_ignore=1 >/dev/null 2>&1 || true
sysctl -w net.ipv4.conf.eth2.arp_announce=2 >/dev/null 2>&1 || true

for IFACE in eth1 eth2; do
    if [ -d "/sys/class/net/$IFACE" ]; then
        ip link set "$IFACE" up
        ip addr del "${SVC_IP}/${CIDR}" dev "$IFACE" 2>/dev/null || true
    fi
done

# Initial active = eth1
ip addr add "${SVC_IP}/${CIDR}" dev eth1
echo "[$ROLE] ${SVC_IP}/${CIDR} bound to eth1; eth2 standby"
