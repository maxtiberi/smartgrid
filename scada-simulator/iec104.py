"""
Minimal IEC 60870-5-104 (IEC 104) framing helpers.

Supports the subset needed for a SCADA<->RTU demo:
  - APCI U-frames: STARTDT act/con, STOPDT act/con, TESTFR act/con
  - APCI S-frame (supervisory, acks I-frames)
  - APCI I-frame with a single ASDU carrying type 36 (M_ME_TF_1,
    Measured value, short floating point with CP56Time2a timestamp)

References: IEC 60870-5-104 ed.2. Only what's needed is implemented;
everything else raises or is ignored.
"""

import struct
import time
from datetime import datetime

START_BYTE = 0x68

# U-frame control field first octet (bits 7..2 select function, bits 1..0 = 11)
U_STARTDT_ACT = 0x07
U_STARTDT_CON = 0x0B
U_STOPDT_ACT  = 0x13
U_STOPDT_CON  = 0x23
U_TESTFR_ACT  = 0x43
U_TESTFR_CON  = 0x83

# ASDU type identifiers
M_ME_TF_1 = 36   # Measured value, short floating point with CP56Time2a


def build_u_frame(function: int) -> bytes:
    """U-frame: 4 control bytes, no payload. APDU length = 4."""
    return bytes([START_BYTE, 0x04, function, 0x00, 0x00, 0x00])


def build_s_frame(recv_seq: int) -> bytes:
    """S-frame (supervisory, ack-only). Control: 01 00 RR RR (recv seq <<1)."""
    rr = (recv_seq & 0x7FFF) << 1
    return bytes([START_BYTE, 0x04, 0x01, 0x00, rr & 0xFF, (rr >> 8) & 0xFF])


def _cp56time2a(ts=None) -> bytes:
    """Encode current time as 7-byte CP56Time2a."""
    if ts is None:
        ts = time.time()
    dt = datetime.fromtimestamp(ts)
    ms = (dt.second * 1000) + (dt.microsecond // 1000)
    return bytes([
        ms & 0xFF,
        (ms >> 8) & 0xFF,
        dt.minute & 0x3F,
        dt.hour & 0x1F,
        (dt.day & 0x1F) | ((dt.isoweekday() & 0x07) << 5),
        dt.month & 0x0F,
        (dt.year - 2000) & 0x7F,
    ])


def build_i_frame_measured_float(send_seq: int, recv_seq: int,
                                 ioa: int, value: float,
                                 quality: int = 0,
                                 common_addr: int = 1,
                                 cot: int = 3) -> bytes:
    """
    Build an I-frame carrying one M_ME_TF_1 (type 36) ASDU.

    send_seq / recv_seq: APCI sequence numbers (15-bit, shifted left by 1).
    ioa: Information Object Address (3 bytes, little-endian).
    value: float32 measured value.
    quality: IEC 104 QDS quality descriptor byte (0 = good).
    common_addr: ASDU common address (2 bytes).
    cot: cause of transmission (3 = spontaneous).
    """
    ss = (send_seq & 0x7FFF) << 1
    rr = (recv_seq & 0x7FFF) << 1
    apci_ctrl = bytes([ss & 0xFF, (ss >> 8) & 0xFF, rr & 0xFF, (rr >> 8) & 0xFF])

    # ASDU: type(1) | VSQ(1) | COT(2) | CommonAddr(2) | IOA(3) | value(4) | QDS(1) | CP56Time2a(7)
    type_id = M_ME_TF_1
    vsq = 0x01  # SQ=0, number of objects = 1
    cot_bytes = bytes([cot & 0xFF, 0x00])
    ca_bytes = bytes([common_addr & 0xFF, (common_addr >> 8) & 0xFF])
    ioa_bytes = bytes([ioa & 0xFF, (ioa >> 8) & 0xFF, (ioa >> 16) & 0xFF])
    val_bytes = struct.pack('<f', value)
    qds_bytes = bytes([quality & 0xFF])
    time_bytes = _cp56time2a()

    asdu = bytes([type_id, vsq]) + cot_bytes + ca_bytes + ioa_bytes + val_bytes + qds_bytes + time_bytes
    apdu_body = apci_ctrl + asdu
    return bytes([START_BYTE, len(apdu_body)]) + apdu_body


def parse_frame(buf: bytes):
    """
    Parse a single APDU starting at offset 0 of buf.
    Returns (kind, fields, total_len) or (None, None, 0) if incomplete.
    kind ∈ {"U", "S", "I"}; fields varies by kind.
    Raises ValueError on framing errors.
    """
    if len(buf) < 2:
        return None, None, 0
    if buf[0] != START_BYTE:
        raise ValueError(f"bad start byte 0x{buf[0]:02x}")
    length = buf[1]
    total = 2 + length
    if len(buf) < total:
        return None, None, 0
    if length < 4:
        raise ValueError(f"short APDU length {length}")

    c1, c2, c3, c4 = buf[2], buf[3], buf[4], buf[5]

    if c1 & 0x01 == 0:
        # I-frame: low bit of c1 is 0
        send_seq = ((c2 << 8) | c1) >> 1
        recv_seq = ((c4 << 8) | c3) >> 1
        asdu = buf[6:total]
        return "I", {"send_seq": send_seq, "recv_seq": recv_seq, "asdu": asdu}, total
    if c1 & 0x03 == 0x01:
        # S-frame
        recv_seq = ((c4 << 8) | c3) >> 1
        return "S", {"recv_seq": recv_seq}, total
    # U-frame
    return "U", {"function": c1}, total


def parse_asdu_measured_float(asdu: bytes):
    """
    Parse a type 36 (M_ME_TF_1) ASDU with a single object.
    Returns dict {ioa, value, quality, cot, common_addr} or None if not type 36.
    """
    if len(asdu) < 6 or asdu[0] != M_ME_TF_1:
        return None
    cot = asdu[2]
    common_addr = asdu[4] | (asdu[5] << 8)
    ioa = asdu[6] | (asdu[7] << 8) | (asdu[8] << 16)
    value = struct.unpack('<f', asdu[9:13])[0]
    quality = asdu[13]
    return {
        "ioa": ioa,
        "value": value,
        "quality": quality,
        "cot": cot,
        "common_addr": common_addr,
    }
