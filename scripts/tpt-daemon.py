#!/usr/bin/env python3
"""
TPT Daemon — IEC 61850 GOOSE Teleprotection Terminal Emulator
=============================================================
Standard : IEC 61850-8-1 (GOOSE PDU encoding)
           IEC 61850-90-1 (GOOSE over IP/UDP for wide-area transport)
Transport: UDP unicast, port 61850

Run on each MPLS RTU container:
  RTU-1:  python3 tpt-daemon.py --local 192.168.100.3 --peer 192.168.100.4
  RTU-2:  python3 tpt-daemon.py --local 192.168.100.4 --peer 192.168.100.3

HTTP control API (port 8850):
  GET  /status      current state + counters
  GET  /log         last 50 received GOOSE messages
  POST /start       begin GOOSE publication
  POST /stop        halt GOOSE publication
  POST /trip        assert trip signal  (stNum++)
  POST /clear       de-assert trip      (stNum++)
  POST /telemetry   {"voltage_pu": 1.0, "current_pu": 0.3}
  GET  /health      liveness check

Required system packages (Debian/Ubuntu/Alpine):
  python3                 (>= 3.8)

No third-party pip packages required — pure Python standard library.

Optional (enhanced ASN.1 tooling):
  pip3 install pyasn1     (not used by daemon, useful for offline PDU inspection)
"""

import argparse
import json
import logging
import socket
import struct
import threading
import time
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

GOOSE_UDP_PORT = 61850          # GOOSE over IP (IEC 61850-90-1 mapping)
API_HTTP_PORT  = 8850           # Dashboard control REST API
MAX_LOG        = 50             # Maximum GOOSE messages kept in ring buffer
CONF_REV       = 1              # GoCB configuration revision

# IEC 61850-8-1 §8.3.3 GOOSE retransmission schedule (milliseconds).
# On any state change stNum increments and PDUs are sent in a burst:
#   T1 × 2 → T2 → T3 → T3 → steady T0
T0 = 1000   # Steady-state heartbeat interval (ms)
T1 = 2      # First rapid retransmit (ms) — repeated twice
T2 = 10     # Second rapid retransmit (ms)
T3 = 100    # Third rapid retransmit (ms) — repeated twice
# Burst schedule (index into list; after exhaustion, use T0)
RETX_SCHEDULE = [T1, T1, T2, T3, T3]

# IEC 61850 dataset / GoCB naming
GCB_SUFFIX = 'LLN0$GO$GoCB01'
DS_SUFFIX  = 'LLN0$DS_TPT'


# ─────────────────────────────────────────────────────────────────────────────
# IEC 61850-8-1  GOOSE PDU  —  BER ENCODING / DECODING
# The GOOSE APDU is encoded using context-specific IMPLICIT BER tags exactly
# as specified in IEC 61850-8-1 Annex A (ASN.1 schema).
# Over IP, the Ethernet GOOSE framing is replaced by a minimal 8-byte UDP
# header (APPID + Length + Reserved×4), consistent with IEC 61850-90-1.
# ─────────────────────────────────────────────────────────────────────────────

def _ber_len(n):
    """Encode BER length field."""
    if n < 128:
        return bytes([n])
    elif n < 256:
        return bytes([0x81, n])
    else:
        return bytes([0x82, (n >> 8) & 0xFF, n & 0xFF])

def _tlv(tag, val):
    return bytes([tag]) + _ber_len(len(val)) + val

def _ber_int(tag, v):
    """Encode an unsigned integer with given context tag."""
    if v == 0:
        b = b'\x00'
    else:
        parts = []
        while v:
            parts.append(v & 0xFF)
            v >>= 8
        parts.reverse()
        # Ensure unsigned: prepend 0x00 if MSB set (sign guard)
        if parts[0] & 0x80:
            parts = [0x00] + parts
        b = bytes(parts)
    return _tlv(tag, b)

def _ber_bool(tag, v):
    """Encode a BOOLEAN with given context tag (0xFF = TRUE, 0x00 = FALSE)."""
    return _tlv(tag, bytes([0xFF if v else 0x00]))

def _ber_str(tag, v):
    """Encode a VisibleString with given context tag."""
    return _tlv(tag, v.encode('ascii'))

def _ber_utctime(ts):
    """
    Encode IEC 61850 UtcTime (tag [4] IMPLICIT = 0x84) — 8 bytes:
      bytes 0-3: whole seconds since Unix epoch (uint32 big-endian)
      bytes 4-6: fractional seconds (uint24, resolution 1/2^24)
      byte    7: time quality (0x0A = accuracy ≤ 10 ms, leap second unknown)
    """
    sec  = int(ts)
    frac = int((ts - sec) * (1 << 24)) & 0xFFFFFF
    b    = (struct.pack('>I', sec)
            + struct.pack('>I', frac)[1:]   # 3 bytes of 4-byte pack
            + bytes([0x0A]))
    return _tlv(0x84, b)   # [4] IMPLICIT UtcTime

# IEC 61850-8-1 Data CHOICE tags (Annex A):
#   boolean     [3] IMPLICIT BOOLEAN          → 0x83
#   floating-point [7] IMPLICIT FLOATING-POINT → 0x87
#   FLOATING-POINT ::= { exponent-width(1B=0x08) | IEEE-754-single(4B) }

def _data_bool(v):
    return _ber_bool(0x83, v)

def _data_f32(v):
    return _tlv(0x87, bytes([0x08]) + struct.pack('>f', float(v)))

def _read_tlv(buf, offset):
    """Read one TLV from buf starting at offset. Returns (tag, value, new_offset)."""
    tag = buf[offset]; offset += 1
    lb  = buf[offset]; offset += 1
    if lb & 0x80:
        nb   = lb & 0x7F
        vlen = int.from_bytes(buf[offset:offset + nb], 'big')
        offset += nb
    else:
        vlen = lb
    val = buf[offset:offset + vlen]
    return tag, val, offset + vlen


def encode_goose(gcb_ref, dat_set, go_id,
                 st_num, sq_num, simulation, nds_com,
                 trip, cmd, v_pu, i_pu, time_alive):
    """
    Build a complete IEC 61850-8-1 GOOSE APDU with UDP framing header.

    Dataset (4 entries, as per IEC 61850 logical node TPTnn):
      Tr  (BOOLEAN)  — Trip signal
      Cs  (BOOLEAN)  — Command / permissive signal
      V   (FLOAT32)  — Voltage p.u.
      I   (FLOAT32)  — Current p.u.
    """
    ts = time.time()

    all_data = _tlv(
        0xAB,                           # [11] IMPLICIT SEQUENCE-OF Data (CONSTRUCTED)
        _data_bool(trip)  +             #   Tr — Trip signal
        _data_bool(cmd)   +             #   Cs — Command signal
        _data_f32(v_pu)   +             #   V  — Voltage p.u.
        _data_f32(i_pu)                 #   I  — Current p.u.
    )

    pdu_body = (
        _ber_str (0x80, gcb_ref)   +   # [0]  gocbRef
        _ber_int (0x81, time_alive)+   # [1]  timeAllowedToLive (ms)
        _ber_str (0x82, dat_set)   +   # [2]  datSet
        _ber_str (0x83, go_id)     +   # [3]  goID
        _ber_utctime(ts)           +   # [4]  t (UtcTime)
        _ber_int (0x85, st_num)    +   # [5]  stNum
        _ber_int (0x86, sq_num)    +   # [6]  sqNum
        _ber_bool(0x87, simulation)+   # [7]  simulation
        _ber_int (0x88, CONF_REV)  +   # [8]  confRev
        _ber_bool(0x89, nds_com)   +   # [9]  ndsCom
        _ber_int (0x8A, 4)         +   # [10] numDatSetEntries
        all_data                       # [11] allData
    )
    goose_apdu = _tlv(0x61, pdu_body)  # APPLICATION[1] IECGoosePdu (CONSTRUCTED)

    # 8-byte UDP framing: APPID(2) + TotalLength(2) + Reserved(4)
    total_len = 8 + len(goose_apdu)
    header    = struct.pack('>HHI', 0x0001, total_len, 0x00000000)
    return header + goose_apdu


def decode_goose(data):
    """
    Decode a GOOSE UDP frame.
    Returns a dict of decoded fields, or None if the frame is invalid.
    """
    try:
        if len(data) < 12:
            return None

        app_id, total_len = struct.unpack('>HH', data[:4])
        apdu = data[8:]             # skip 8-byte framing header

        if not apdu or apdu[0] != 0x61:
            return None             # not a GOOSE APPLICATION[1] PDU

        _, inner, _ = _read_tlv(apdu, 0)

        result = {'app_id': app_id}
        i = 0
        while i < len(inner):
            tag, val, i = _read_tlv(inner, i)

            if   tag == 0x80: result['gocbRef']           = val.decode('ascii', errors='replace')
            elif tag == 0x81: result['timeAllowedToLive'] = int.from_bytes(val, 'big')
            elif tag == 0x82: result['datSet']             = val.decode('ascii', errors='replace')
            elif tag == 0x83: result['goID']               = val.decode('ascii', errors='replace')
            elif tag == 0x84:
                sec  = struct.unpack('>I', val[0:4])[0]
                frac = int.from_bytes(val[4:7], 'big') / (1 << 24)
                result['t']     = sec + frac
                result['t_iso'] = datetime.fromtimestamp(sec + frac, tz=timezone.utc).isoformat()
            elif tag == 0x85: result['stNum']    = int.from_bytes(val, 'big')
            elif tag == 0x86: result['sqNum']    = int.from_bytes(val, 'big')
            elif tag == 0x87: result['sim']      = (val[0] != 0)
            elif tag == 0x88: result['confRev']  = int.from_bytes(val, 'big')
            elif tag == 0x89: result['ndsCom']   = (val[0] != 0)
            elif tag == 0x8A: result['numDatSetEntries'] = int.from_bytes(val, 'big')
            elif tag == 0xAB:           # allData — SEQUENCE OF Data items
                j, items = 0, []
                while j < len(val):
                    dt, dv, j = _read_tlv(val, j)
                    if   dt == 0x83:
                        items.append({'type': 'BOOLEAN', 'value': dv[0] != 0})
                    elif dt == 0x87:
                        f = struct.unpack('>f', dv[1:5])[0]   # skip exponent-width byte
                        items.append({'type': 'FLOAT32', 'value': round(f, 4)})
                    else:
                        items.append({'type': f'0x{dt:02X}', 'value': dv.hex()})
                result['allData'] = items
                if len(items) >= 4:
                    result['trip']    = items[0]['value']
                    result['cmd']     = items[1]['value']
                    result['voltage'] = items[2]['value']
                    result['current'] = items[3]['value']

        return result

    except Exception as exc:
        logging.debug('decode_goose error: %s', exc)
        return None


# ─────────────────────────────────────────────────────────────────────────────
# GOOSE PUBLISHER  (IEC 61850-8-1 §8.3.3 retransmission state machine)
# ─────────────────────────────────────────────────────────────────────────────

class GoosePublisher:
    """
    Publishes GOOSE PDUs to the peer RTU using the IEC 61850-8-1 state machine.

    Normal operation: sends one PDU every T0 ms (keepalive).
    On any dataset state change (trip / clear):
      — stNum increments
      — sqNum resets to 0
      — PDUs are sent in a rapid-retransmit burst per RETX_SCHEDULE
      — then returns to T0 steady state
    """

    def __init__(self, local_ip, peer_ip):
        self.local_ip   = local_ip
        self.peer_ip    = peer_ip
        label           = local_ip.replace('.', '')
        self.gcb_ref    = f'{label}/{GCB_SUFFIX}'
        self.dat_set    = f'{label}/{DS_SUFFIX}'
        self.go_id      = f'TPT_{label}'
        self._sock      = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._lock      = threading.Lock()
        self._thread    = None
        self._running   = False
        # Dataset values
        self.trip        = False
        self.cmd         = False
        self.voltage_pu  = 1.0
        self.current_pu  = 0.0
        # State counters
        self.st_num      = 0
        self.sq_num      = 0
        self._prev_trip  = False
        self._retx_idx   = len(RETX_SCHEDULE)   # start in steady state
        self.sent_count  = 0

    # ── Public controls ──────────────────────────────────────────────────────

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread  = threading.Thread(target=self._run, daemon=True, name='goose-pub')
        self._thread.start()
        logging.info('GOOSE publisher started  →  %s:%d', self.peer_ip, GOOSE_UDP_PORT)

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)
        logging.info('GOOSE publisher stopped')

    def set_trip(self, assert_trip):
        with self._lock:
            if assert_trip != self._prev_trip:
                self.st_num    += 1
                self.sq_num     = 0
                self._retx_idx  = 0         # trigger rapid-retransmit burst
                self._prev_trip = assert_trip
            self.trip = assert_trip

    def set_telemetry(self, v_pu, i_pu):
        with self._lock:
            self.voltage_pu = round(float(v_pu), 4)
            self.current_pu = round(float(i_pu), 4)

    @property
    def is_running(self):
        return self._running

    # ── Internal publish loop ─────────────────────────────────────────────────

    def _run(self):
        while self._running:
            with self._lock:
                idx          = self._retx_idx
                interval_ms  = RETX_SCHEDULE[idx] if idx < len(RETX_SCHEDULE) else T0
                time_alive   = interval_ms * 2          # IEC 61850-8-1 §8.3.3 recommendation
                pdu = encode_goose(
                    gcb_ref    = self.gcb_ref,
                    dat_set    = self.dat_set,
                    go_id      = self.go_id,
                    st_num     = self.st_num,
                    sq_num     = self.sq_num,
                    simulation = False,
                    nds_com    = False,
                    trip       = self.trip,
                    cmd        = self.cmd,
                    v_pu       = self.voltage_pu,
                    i_pu       = self.current_pu,
                    time_alive = time_alive,
                )
                self.sq_num  += 1
                if idx < len(RETX_SCHEDULE):
                    self._retx_idx += 1
                self.sent_count += 1

            try:
                self._sock.sendto(pdu, (self.peer_ip, GOOSE_UDP_PORT))
                logging.debug('GOOSE TX  stNum=%d sqNum=%d trip=%s  → %s',
                              self.st_num, self.sq_num - 1, self.trip, self.peer_ip)
            except OSError as exc:
                logging.warning('GOOSE send error: %s', exc)

            time.sleep(interval_ms / 1000.0)


# ─────────────────────────────────────────────────────────────────────────────
# GOOSE SUBSCRIBER
# ─────────────────────────────────────────────────────────────────────────────

class GooseSubscriber:
    """Listens on GOOSE_UDP_PORT and decodes incoming GOOSE PDUs from the peer."""

    def __init__(self, msg_log):
        self._log       = msg_log           # shared deque
        self._sock      = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(('', GOOSE_UDP_PORT))
        self._sock.settimeout(1.0)
        self._lock      = threading.Lock()
        self._thread    = None
        self._running   = False
        self.last_msg    = None
        self.last_rx_time = None   # epoch float — used for peer-alive timeout
        self.recv_count  = 0
        self.trip_count  = 0

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread  = threading.Thread(target=self._run, daemon=True, name='goose-sub')
        self._thread.start()
        logging.info('GOOSE subscriber listening on UDP :%d', GOOSE_UDP_PORT)

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)

    def _run(self):
        while self._running:
            try:
                data, addr = self._sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError as exc:
                logging.warning('GOOSE recv error: %s', exc)
                continue

            msg = decode_goose(data)
            if not msg:
                continue

            msg['from']   = addr[0]
            msg['rx_iso'] = datetime.now(tz=timezone.utc).isoformat()

            with self._lock:
                self.last_msg     = msg
                self.last_rx_time = time.time()
                self.recv_count  += 1
                if msg.get('trip'):
                    self.trip_count += 1
                # Compact log entry for dashboard
                self._log.appendleft({
                    'ts':      msg['rx_iso'],
                    't_iso':   msg.get('t_iso'),
                    'from':    addr[0],
                    'stNum':   msg.get('stNum', 0),
                    'sqNum':   msg.get('sqNum', 0),
                    'trip':    msg.get('trip',    False),
                    'cmd':     msg.get('cmd',     False),
                    'voltage': msg.get('voltage', 0.0),
                    'current': msg.get('current', 0.0),
                    'goID':    msg.get('goID',    '—'),
                })
            logging.debug('GOOSE RX  from=%s  stNum=%d sqNum=%d  trip=%s',
                          addr[0], msg.get('stNum', 0), msg.get('sqNum', 0), msg.get('trip'))


# ─────────────────────────────────────────────────────────────────────────────
# HTTP CONTROL API
# ─────────────────────────────────────────────────────────────────────────────

# Module-level singletons (set by main())
_pub  = None
_sub  = None
_log  = None
_args = None


def _json(handler, code, body):
    payload = json.dumps(body, default=str).encode()
    handler.send_response(code)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Content-Length', str(len(payload)))
    handler.send_header('Access-Control-Allow-Origin', '*')
    handler.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    handler.end_headers()
    handler.wfile.write(payload)


class TptHandler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        pass   # suppress per-request access log (daemon uses its own logger)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

    def do_GET(self):
        if self.path in ('/status', '/health'):
            _json(self, 200, self._build_status())
        elif self.path == '/log':
            with (_sub._lock if _sub else threading.Lock()):
                entries = list(_log) if _log else []
            _json(self, 200, {'entries': entries, 'total': len(entries)})
        else:
            _json(self, 404, {'error': 'not found'})

    def do_POST(self):
        if   self.path == '/start':
            if _pub and not _pub.is_running:
                _pub.start()
            _json(self, 200, {'ok': True, 'pub_running': _pub.is_running if _pub else False})

        elif self.path == '/stop':
            if _pub and _pub.is_running:
                _pub.stop()
            _json(self, 200, {'ok': True, 'pub_running': _pub.is_running if _pub else False})

        elif self.path == '/trip':
            if _pub:
                _pub.set_trip(True)
            _json(self, 200, {'trip': True, 'st_num': _pub.st_num if _pub else 0})

        elif self.path == '/clear':
            if _pub:
                _pub.set_trip(False)
            _json(self, 200, {'trip': False, 'st_num': _pub.st_num if _pub else 0})

        elif self.path == '/telemetry':
            try:
                n = int(self.headers.get('Content-Length', 0))
                b = json.loads(self.rfile.read(n)) if n else {}
                v = float(b.get('voltage_pu', 1.0))
                i = float(b.get('current_pu', 0.0))
                if _pub:
                    _pub.set_telemetry(v, i)
                _json(self, 200, {'voltage_pu': v, 'current_pu': i})
            except Exception as exc:
                _json(self, 400, {'error': str(exc)})
        else:
            _json(self, 404, {'error': 'not found'})

    def _build_status(self):
        last = _sub.last_msg if _sub else None
        last_rx = _sub.last_rx_time if _sub else None
        peer_alive = last_rx is not None and (time.time() - last_rx) < (5 * T0 / 1000)
        return {
            'local_ip':       _args.local if _args else 'unknown',
            'peer_ip':        _args.peer  if _args else 'unknown',
            'pub_running':    _pub.is_running  if _pub else False,
            'pub_sent':       _pub.sent_count  if _pub else 0,
            'trip_asserted':  _pub.trip        if _pub else False,
            'cmd_asserted':   _pub.cmd         if _pub else False,
            'voltage_pu':     _pub.voltage_pu  if _pub else 1.0,
            'current_pu':     _pub.current_pu  if _pub else 0.0,
            'st_num':         _pub.st_num      if _pub else 0,
            'sq_num':         _pub.sq_num      if _pub else 0,
            'sub_recv':       _sub.recv_count  if _sub else 0,
            'sub_trips_seen': _sub.trip_count  if _sub else 0,
            'peer_alive':     peer_alive,
            'peer_trip':      last.get('trip')    if last else None,
            'peer_voltage':   last.get('voltage') if last else None,
            'peer_current':   last.get('current') if last else None,
            'peer_st_num':    last.get('stNum')   if last else None,
            'peer_last_ts':   last.get('rx_iso')  if last else None,
            'uptime_s':       round(time.time() - _start_time, 1),
        }


# ─────────────────────────────────────────────────────────────────────────────
# SIMULATED TELEMETRY TICKER  (optional — for demo without real sensors)
# ─────────────────────────────────────────────────────────────────────────────

def _telemetry_ticker(pub):
    """
    Gently oscillates voltage and current to simulate a live grid measurement.
    Disabled when a trip is asserted (voltage collapses, current spikes).
    """
    import math
    t = 0.0
    while pub.is_running or True:
        time.sleep(0.5)
        t += 0.5
        if not pub.trip:
            v = 1.0 + 0.02 * math.sin(t * 0.3)
            i = 0.6 + 0.10 * math.sin(t * 0.5 + 1.0)
        else:
            # Fault condition: voltage sag, overcurrent
            v = 0.35 + 0.05 * math.sin(t * 2.0)
            i = 2.8  + 0.30 * math.sin(t * 3.0)
        pub.set_telemetry(round(v, 3), round(i, 3))


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

_start_time = time.time()


def main():
    global _pub, _sub, _log, _args, _start_time

    parser = argparse.ArgumentParser(
        description='IEC 61850 GOOSE TPT Daemon',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument('--local',      required=True,  metavar='IP',
                        help='IP address of this RTU (published in GOOSE)')
    parser.add_argument('--peer',       required=True,  metavar='IP',
                        help='IP address of the peer RTU (GOOSE destination)')
    parser.add_argument('--api-port',   type=int, default=API_HTTP_PORT,
                        help=f'HTTP API port (default: {API_HTTP_PORT})')
    parser.add_argument('--auto-start', action='store_true',
                        help='Start GOOSE publication immediately on launch')
    parser.add_argument('--sim-telemetry', action='store_true',
                        help='Enable simulated voltage/current oscillation')
    parser.add_argument('--log-level',  default='INFO',
                        choices=['DEBUG', 'INFO', 'WARNING', 'ERROR'])
    _args = parser.parse_args()

    logging.basicConfig(
        level   = getattr(logging, _args.log_level),
        format  = '%(asctime)s  [%(levelname)-7s]  %(message)s',
        datefmt = '%Y-%m-%dT%H:%M:%S',
    )

    _start_time = time.time()
    logging.info('═══════════════════════════════════════════════════════')
    logging.info('  IEC 61850 GOOSE TPT Daemon')
    logging.info('  Local : %s   Peer : %s', _args.local, _args.peer)
    logging.info('  GOOSE UDP port : %d    API HTTP port : %d',
                 GOOSE_UDP_PORT, _args.api_port)
    logging.info('═══════════════════════════════════════════════════════')

    _log = deque(maxlen=MAX_LOG)
    _pub = GoosePublisher(_args.local, _args.peer)
    _sub = GooseSubscriber(_log)

    # Subscriber always listens (needed to receive peer trips even when not publishing)
    _sub.start()

    if _args.auto_start:
        _pub.start()

    if _args.sim_telemetry:
        t = threading.Thread(target=_telemetry_ticker, args=(_pub,), daemon=True, name='telem')
        t.start()
        logging.info('Simulated telemetry ticker enabled')

    srv = HTTPServer(('0.0.0.0', _args.api_port), TptHandler)
    logging.info('HTTP control API  →  http://0.0.0.0:%d', _args.api_port)
    logging.info('Endpoints: /status /log /start /stop /trip /clear /telemetry')

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        logging.info('Shutdown requested')
    finally:
        _pub.stop()
        _sub.stop()
        srv.server_close()
        logging.info('TPT Daemon stopped')


if __name__ == '__main__':
    main()
