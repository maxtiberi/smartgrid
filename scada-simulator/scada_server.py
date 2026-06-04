#!/usr/bin/env python3
"""
SCADA master simulator (IEC 60870-5-104 client) with application-level
primary/backup link failover.

Network model
-------------
Both SCADA and RTU expose a single "service" IP (192.168.200.1 on SCADA,
192.168.200.2 on RTU) that is mounted on whichever physical interface
(eth1 = primary, eth2 = backup) is currently active. Failover happens
in two coordinated steps when the active path is lost:

  1. The application detects loss-of-keepalive (TESTFR timeout, TCP
     reset, or send error) on the active socket.
  2. It calls ./failover.sh <new_iface> which removes the service IP
     from the failed NIC, adds it to the standby NIC, and emits a
     gratuitous ARP so upstream switches relearn the MAC.
  3. It opens a fresh TCP connection — this time bound to the new
     local interface using SO_BINDTODEVICE — and re-issues STARTDT.

This file is the SCADA side. rtu_responder.py is the RTU side. They
share iec104.py for framing.

Failover requirements (CAP_NET_ADMIN / root):
  - The script needs to run `ip addr {add,del}` and `arping`. In
    containerlab the default linux kind runs as root, so this is fine.
"""

import argparse
import errno
import os
import socket
import struct
import subprocess
import sys
import time

from iec104 import (
    U_STARTDT_ACT, U_STARTDT_CON,
    U_TESTFR_ACT, U_TESTFR_CON,
    build_s_frame, build_u_frame,
    parse_asdu_measured_float, parse_frame,
)

# --- Defaults; override via CLI flags or env --------------------------------

DEFAULT_RTU_IP     = os.environ.get("SCADA_RTU_IP",     "192.168.200.20")
DEFAULT_RTU_PORT   = int(os.environ.get("SCADA_RTU_PORT", "2404"))
DEFAULT_PRIMARY    = os.environ.get("SCADA_PRIMARY_IF",  "eth2")
DEFAULT_BACKUP     = os.environ.get("SCADA_BACKUP_IF",   "eth1")
DEFAULT_SVC_IP     = os.environ.get("SCADA_SVC_IP",      "192.168.200.1")
DEFAULT_SVC_CIDR   = int(os.environ.get("SCADA_SVC_CIDR", "29"))
DEFAULT_FAILOVER   = os.environ.get("SCADA_FAILOVER_SH",
                                    os.path.join(os.path.dirname(__file__), "failover.sh"))
# RTU subnet route: must point to the PE gateway that carries the L3VPN to the RTU.
# Applied at startup and again after every interface failover so the kernel
# routing table is always consistent regardless of which NIC is active.
DEFAULT_RTU_SUBNET = os.environ.get("SCADA_RTU_SUBNET", "192.168.200.16/29")
DEFAULT_GW         = os.environ.get("SCADA_GW",         "192.168.200.2")

# IEC 104 timers (defaults in seconds; spec defaults are t0=30, t1=15, t2=10, t3=20)
T1_TIMEOUT  = float(os.environ.get("SCADA_T1", "15"))  # ack/U-frame response timeout
T3_INTERVAL = float(os.environ.get("SCADA_T3", "20"))  # TESTFR keepalive interval
CONNECT_TIMEOUT = float(os.environ.get("SCADA_T0", "10"))


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] SCADA {msg}", flush=True)


def run_failover_script(script: str, iface: str) -> bool:
    """Invoke failover.sh <iface>. Returns True on success."""
    try:
        result = subprocess.run(
            [script, iface],
            capture_output=True, text=True, timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        log(f"failover.sh failed: {e}")
        return False
    if result.returncode != 0:
        log(f"failover.sh rc={result.returncode} stderr={result.stderr.strip()}")
        return False
    if result.stdout.strip():
        log(f"failover.sh: {result.stdout.strip()}")
    return True


def ensure_route(rtu_subnet: str, gateway: str) -> None:
    """Add (or replace) the static route to the RTU subnet via the PE gateway.

    Uses 'ip route replace' which is idempotent: it succeeds whether the
    route already exists or not, and overwrites any stale entry with the
    same destination.  Called:
      - at startup, before the first connection attempt
      - after every interface failover, so the new NIC binding also has
        a working path to the RTU subnet

    The gateway (192.168.200.2) is the PE router's VPRN interface in the
    SCADA subnet; the L3VPN backbone then carries traffic onward to the RTU.
    """
    try:
        result = subprocess.run(
            ["ip", "route", "replace", rtu_subnet, "via", gateway],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            log(f"route: {rtu_subnet} via {gateway} — OK")
        else:
            log(f"route: ip route replace failed rc={result.returncode} "
                f"stderr={result.stderr.strip()}")
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        log(f"route: ip route replace error: {e}")


def open_bound_socket(local_iface: str, remote_ip: str, remote_port: int) -> socket.socket:
    """Open a TCP socket bound to a specific interface via SO_BINDTODEVICE."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
    # SO_BINDTODEVICE forces egress out of `local_iface` regardless of the
    # routing table — this is what makes "active link" deterministic when
    # the same service IP is configured on multiple interfaces.
    try:
        s.setsockopt(socket.SOL_SOCKET, 25, local_iface.encode() + b"\0")  # 25 = SO_BINDTODEVICE
    except PermissionError:
        log("SO_BINDTODEVICE needs root / CAP_NET_RAW — egress NIC is not pinned")
    except OSError as e:
        # Non-Linux (e.g. macOS smoke test) — option not supported, fall back to routing.
        log(f"SO_BINDTODEVICE unsupported on this OS ({e.errno}) — relying on routing")
    s.settimeout(CONNECT_TIMEOUT)
    s.connect((remote_ip, remote_port))
    s.settimeout(None)
    return s


def send_with_timeout(sock: socket.socket, data: bytes, timeout: float) -> None:
    sock.settimeout(timeout)
    try:
        sock.sendall(data)
    finally:
        sock.settimeout(None)


def recv_one_frame(sock: socket.socket, buf: bytearray, deadline: float) -> tuple:
    """Read until one full APDU is in buf. Returns (kind, fields, payload_bytes)."""
    while True:
        try:
            kind, fields, total = parse_frame(bytes(buf))
        except ValueError as e:
            raise ConnectionError(f"framing error: {e}")
        if kind is not None:
            payload = bytes(buf[:total])
            del buf[:total]
            return kind, fields, payload
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("frame read timeout")
        sock.settimeout(remaining)
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            # socket.timeout is not always TimeoutError on Python < 3.10.
            raise TimeoutError("frame read timeout")
        if not chunk:
            raise ConnectionError("peer closed")
        buf += chunk


class SessionFailed(Exception):
    """Raised when the current TCP session is unhealthy and we should retry."""


def run_session(local_iface: str, rtu_ip: str, rtu_port: int) -> None:
    """One end-to-end session on a given interface. Returns when the session ends
    (either because the link failed or because the program was interrupted)."""
    log(f"connecting via {local_iface} -> {rtu_ip}:{rtu_port}")
    try:
        sock = open_bound_socket(local_iface, rtu_ip, rtu_port)
    except (ConnectionError, socket.timeout, OSError) as e:
        raise SessionFailed(f"TCP connect failed: {e}")
    log(f"TCP up on {local_iface}; sending STARTDT")

    buf = bytearray()
    send_seq = 0
    recv_seq = 0
    unacked_in = 0
    K_ACK = 8

    # --- STARTDT handshake ---
    send_with_timeout(sock, build_u_frame(U_STARTDT_ACT), T1_TIMEOUT)
    try:
        kind, fields, _ = recv_one_frame(sock, buf, time.monotonic() + T1_TIMEOUT)
    except (TimeoutError, ConnectionError) as e:
        sock.close()
        raise SessionFailed(f"STARTDT_CON not received: {e}")
    if kind != "U" or fields["function"] != U_STARTDT_CON:
        sock.close()
        raise SessionFailed(f"expected STARTDT_CON, got {kind} {fields}")
    log("STARTDT_CON received — session up")

    last_keepalive_sent = time.monotonic()
    awaiting_testfr_con = False
    testfr_deadline = 0.0

    try:
        while True:
            now = time.monotonic()

            # T3: send TESTFR_ACT periodically if idle
            if not awaiting_testfr_con and (now - last_keepalive_sent) >= T3_INTERVAL:
                try:
                    send_with_timeout(sock, build_u_frame(U_TESTFR_ACT), T1_TIMEOUT)
                except OSError as e:
                    raise SessionFailed(f"TESTFR send failed: {e}")
                awaiting_testfr_con = True
                testfr_deadline = now + T1_TIMEOUT
                last_keepalive_sent = now
                log("-> RTU TESTFR_ACT (keepalive)")

            # T1: TESTFR_CON must arrive within T1_TIMEOUT
            if awaiting_testfr_con and now > testfr_deadline:
                raise SessionFailed("TESTFR_CON not received within T1")

            # Receive next frame with a short deadline so we can run timers
            short_deadline = min(now + 0.5,
                                 testfr_deadline if awaiting_testfr_con else now + T3_INTERVAL)
            try:
                kind, fields, _ = recv_one_frame(sock, buf, short_deadline)
            except TimeoutError:
                continue
            except ConnectionError as e:
                raise SessionFailed(f"recv: {e}")

            if kind == "U":
                fn = fields["function"]
                if fn == U_TESTFR_CON:
                    awaiting_testfr_con = False
                    log("<- RTU TESTFR_CON")
                elif fn == U_TESTFR_ACT:
                    sock.sendall(build_u_frame(U_TESTFR_CON))
                else:
                    log(f"<- RTU U fn=0x{fn:02x}")

            elif kind == "S":
                # RTU acked some of our I-frames; nothing to track on master side.
                pass

            elif kind == "I":
                recv_seq = (fields["send_seq"] + 1) & 0x7FFF
                unacked_in += 1
                meas = parse_asdu_measured_float(fields["asdu"])
                if meas is not None:
                    log(f"<- RTU I send={fields['send_seq']} ioa={meas['ioa']} "
                        f"val={meas['value']:.3f} q=0x{meas['quality']:02x}")
                else:
                    log(f"<- RTU I send={fields['send_seq']} (unhandled ASDU type)")
                if unacked_in >= K_ACK:
                    sock.sendall(build_s_frame(recv_seq))
                    unacked_in = 0
    finally:
        try:
            sock.close()
        except OSError:
            pass


def _is_transient_connect_error(msg: str) -> bool:
    """Return True if the session failure looks like a transient routing/reachability
    glitch that is worth retrying on the PRIMARY before committing to failover.

    Patterns matched (all case-insensitive):
      - EHOSTUNREACH  (errno 113): no route to host — kernel routing table not ready
      - ENETUNREACH   (errno 101): network unreachable — same root cause
      - timed out                : connect timeout — link may just be warming up
    """
    msg_lower = msg.lower()
    return (
        "host is unreachable" in msg_lower or   # EHOSTUNREACH (errno 113)
        "ehostunreach" in msg_lower or
        "network is unreachable" in msg_lower or  # ENETUNREACH  (errno 101)
        "enetunreach" in msg_lower or
        "timed out" in msg_lower                  # connect timeout
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="SCADA IEC 104 client with primary/backup failover")
    ap.add_argument("--rtu-ip", default=DEFAULT_RTU_IP)
    ap.add_argument("--rtu-port", type=int, default=DEFAULT_RTU_PORT)
    ap.add_argument("--primary-if", default=DEFAULT_PRIMARY)
    ap.add_argument("--backup-if", default=DEFAULT_BACKUP)
    ap.add_argument("--failover-script", default=DEFAULT_FAILOVER)
    ap.add_argument("--no-failover-script", action="store_true",
                    help="Don't invoke failover.sh; only rebind the socket. "
                         "Use this when the IP is already on both NICs.")
    ap.add_argument("--retry-delay", type=float, default=3.0,
                    help="Seconds to wait after a session fails before retrying")
    ap.add_argument("--primary-retries", type=int, default=5,
                    help="Max consecutive transient-connect failures on the primary "
                         "before committing to permanent failover (default: 5). "
                         "Hard failures (TCP reset, STARTDT timeout) always "
                         "trigger immediate failover regardless of this value.")
    ap.add_argument("--rtu-subnet", default=DEFAULT_RTU_SUBNET,
                    help="RTU subnet CIDR reachable via --gateway (default: 192.168.200.16/29)")
    ap.add_argument("--gateway", default=DEFAULT_GW,
                    help="PE gateway IP for the RTU subnet route (default: 192.168.200.2)")
    ap.add_argument("--no-route", action="store_true",
                    help="Skip ip route replace calls (use when route is managed externally)")
    args = ap.parse_args()

    interfaces = [args.primary_if, args.backup_if]
    active_idx = 0
    # Counts consecutive transient failures on the primary (EHOSTUNREACH / timeout).
    # Reset to 0 after any successful session.  Reaching primary_retries triggers
    # real failover even for transient errors (avoids stuck-on-primary forever).
    primary_transient_fails = 0

    log(f"start: primary={args.primary_if} backup={args.backup_if} "
        f"target={args.rtu_ip}:{args.rtu_port} "
        f"primary-retries={args.primary_retries}")

    # ── Startup route ────────────────────────────────────────────────────────
    # Ensure the L3VPN path to the RTU subnet exists before the first connect
    # attempt.  The route survives reboots of the far-end PE but may be lost
    # after a link-down event, so we re-apply it after every failover as well.
    if not args.no_route:
        ensure_route(args.rtu_subnet, args.gateway)

    while True:
        iface = interfaces[active_idx]
        session_failed_msg: str | None = None
        try:
            run_session(iface, args.rtu_ip, args.rtu_port)
            # run_session only returns by raising; if it does return, treat as failure
            raise SessionFailed("session ended unexpectedly")
        except SessionFailed as e:
            session_failed_msg = str(e)
            log(f"session on {iface} failed: {e}")
            # Any successful session (past the STARTDT handshake) resets the
            # transient-failure counter — the link is genuinely working.
            if active_idx == 0 and "TCP connect failed" not in session_failed_msg:
                primary_transient_fails = 0
        except KeyboardInterrupt:
            log("interrupted")
            return 0

        # Failover policy: primary → backup is a ONE-WAY transition.
        # Once on backup, stay on backup and keep retrying — never auto-flip back.
        # Manual failback: run  failover.sh <primary-if>  inside the container,
        # then restart this process.
        if active_idx == 0:
            err = session_failed_msg or ""

            # ── Transient-connect retry on primary ──────────────────────────
            # EHOSTUNREACH / ENETUNREACH / timeout on the primary usually means
            # the kernel route isn't ready yet (startup race) or the L3VPN path
            # is momentarily down.  Retry up to --primary-retries times before
            # committing to permanent failover so we don't strand on the backup
            # path because of a 200 ms routing-table gap at boot.
            if _is_transient_connect_error(err):
                primary_transient_fails += 1
                remaining = args.primary_retries - primary_transient_fails
                if remaining > 0:
                    log(f"primary {iface}: transient connect error "
                        f"({primary_transient_fails}/{args.primary_retries}) — "
                        f"retrying primary in {args.retry_delay}s "
                        f"({remaining} attempt(s) left before failover)")
                    # Re-apply route in case it was lost after a link flap.
                    if not args.no_route:
                        ensure_route(args.rtu_subnet, args.gateway)
                    time.sleep(args.retry_delay)
                    continue   # stay on active_idx=0 (primary)
                else:
                    log(f"primary {iface}: transient error limit reached "
                        f"({args.primary_retries} attempts) — triggering failover")

            # ── Primary failed hard (or retries exhausted): move to backup ──
            primary_transient_fails = 0
            next_iface = interfaces[1]
            log(f"primary {iface} failed — failing over to backup {next_iface}")

            if not args.no_failover_script:
                ok = run_failover_script(args.failover_script, next_iface)
                if not ok:
                    log("failover script failed — retrying primary after delay")
                    time.sleep(args.retry_delay)
                    continue          # stay on primary_idx=0, try again

            active_idx = 1

            # ── Post-failover route ──────────────────────────────────────────
            # The kernel may have purged routes associated with the old NIC
            # after the link-down event.  Re-apply the RTU subnet route so the
            # new interface binding can reach the RTU via the PE gateway.
            if not args.no_route:
                ensure_route(args.rtu_subnet, args.gateway)

        else:
            # ── Already on backup: session lost, retry backup ─────────────────
            log(f"backup {iface} session lost — retrying in {args.retry_delay}s "
                f"(manual failback: run 'failover.sh {interfaces[0]}' + restart)")

        time.sleep(args.retry_delay)


if __name__ == "__main__":
    sys.exit(main())
