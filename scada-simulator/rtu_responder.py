#!/usr/bin/env python3
"""
IEC 60870-5-104 RTU responder.

Listens on TCP/2404 on the service IP (192.168.200.2). Runs on the RTU
container; the service IP is mounted on whichever physical interface
(eth1 or eth2) is currently active — switching is handled by failover.sh,
not by this process.

Behavior:
  - Accept one SCADA client at a time.
  - Handle U-frames: STARTDT_ACT -> STARTDT_CON, TESTFR_ACT -> TESTFR_CON,
                     STOPDT_ACT -> STOPDT_CON.
  - After STARTDT_CON, every PERIOD seconds emit a spontaneous I-frame
    (type 36, M_ME_TF_1) at IOA 4001 with a slowly varying float
    (simulated grid voltage in kV).
  - Ack received I-frames with an S-frame every K_ACK frames.
  - Log each event with the local time and the peer's source IP, which
    reveals which physical path the SCADA side is using.
"""

import math
import os
import random
import socket
import sys
import threading
import time

from iec104 import (
    U_STARTDT_ACT, U_STARTDT_CON,
    U_STOPDT_ACT, U_STOPDT_CON,
    U_TESTFR_ACT, U_TESTFR_CON,
    build_i_frame_measured_float, build_s_frame, build_u_frame,
    parse_frame,
)

LISTEN_ADDR = os.environ.get("RTU_BIND", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("RTU_PORT", "2404"))
COMMON_ADDR = int(os.environ.get("RTU_CA", "1"))
PERIOD_S = float(os.environ.get("RTU_PERIOD", "1.0"))
K_ACK = int(os.environ.get("RTU_K_ACK", "8"))  # ack window


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] RTU {msg}", flush=True)


def handle_client(sock: socket.socket, peer: tuple) -> None:
    peer_str = f"{peer[0]}:{peer[1]}"
    log(f"connect from {peer_str}")
    sock.settimeout(15.0)

    started = False
    send_seq = 0
    recv_seq = 0
    unacked_in = 0
    last_emit = 0.0
    buf = b""
    t0 = time.time()

    try:
        while True:
            # Emit a spontaneous measurement if started
            now = time.time()
            if started and (now - last_emit) >= PERIOD_S:
                # Slowly varying value: 132 kV ± small noise + slow sine.
                value = 132.0 + 0.5 * math.sin((now - t0) / 5.0) + random.uniform(-0.05, 0.05)
                frame = build_i_frame_measured_float(
                    send_seq=send_seq, recv_seq=recv_seq,
                    ioa=4001, value=value, quality=0,
                    common_addr=COMMON_ADDR, cot=3,
                )
                try:
                    sock.sendall(frame)
                except OSError as e:
                    log(f"send failed to {peer_str}: {e}")
                    return
                send_seq = (send_seq + 1) & 0x7FFF
                last_emit = now
                log(f"-> {peer_str} I send={send_seq-1} val={value:.3f}kV")

            # Read with a short timeout so we can keep emitting
            sock.settimeout(0.25)
            try:
                chunk = sock.recv(4096)
                if not chunk:
                    log(f"peer {peer_str} closed")
                    return
                buf += chunk
            except socket.timeout:
                continue
            except OSError as e:
                log(f"recv failed: {e}")
                return

            # Drain whole APDUs
            while True:
                try:
                    kind, fields, total = parse_frame(buf)
                except ValueError as e:
                    log(f"framing error from {peer_str}: {e} — closing")
                    return
                if kind is None:
                    break
                payload = buf[:total]
                buf = buf[total:]

                if kind == "U":
                    fn = fields["function"]
                    if fn == U_STARTDT_ACT:
                        log(f"<- {peer_str} U STARTDT_ACT")
                        sock.sendall(build_u_frame(U_STARTDT_CON))
                        started = True
                        last_emit = 0.0  # force immediate emission
                    elif fn == U_STOPDT_ACT:
                        log(f"<- {peer_str} U STOPDT_ACT")
                        sock.sendall(build_u_frame(U_STOPDT_CON))
                        started = False
                    elif fn == U_TESTFR_ACT:
                        log(f"<- {peer_str} U TESTFR_ACT")
                        sock.sendall(build_u_frame(U_TESTFR_CON))
                    elif fn in (U_STARTDT_CON, U_STOPDT_CON, U_TESTFR_CON):
                        # RTU normally doesn't receive these; ignore.
                        pass
                    else:
                        log(f"<- {peer_str} U unknown fn=0x{fn:02x}")

                elif kind == "S":
                    # SCADA acked some of our I-frames; no state to update here.
                    pass

                elif kind == "I":
                    recv_seq = (fields["send_seq"] + 1) & 0x7FFF
                    unacked_in += 1
                    if unacked_in >= K_ACK:
                        sock.sendall(build_s_frame(recv_seq))
                        unacked_in = 0
    finally:
        try:
            sock.close()
        except OSError:
            pass
        log(f"disconnect {peer_str}")


def main() -> int:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind((LISTEN_ADDR, LISTEN_PORT))
    except OSError as e:
        log(f"bind {LISTEN_ADDR}:{LISTEN_PORT} failed: {e}")
        return 1
    srv.listen(2)
    log(f"listening on {LISTEN_ADDR}:{LISTEN_PORT} CA={COMMON_ADDR}")

    while True:
        try:
            sock, peer = srv.accept()
        except KeyboardInterrupt:
            log("shutting down")
            return 0
        # Serial — a single SCADA at a time is realistic for this demo.
        # If a new client arrives while one is connected, the new one waits
        # for the previous handler to return.
        threading.Thread(target=handle_client, args=(sock, peer), daemon=True).start()


if __name__ == "__main__":
    sys.exit(main())
