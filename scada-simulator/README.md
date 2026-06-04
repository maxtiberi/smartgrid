# SCADA ↔ RTU simulator (IEC 60870-5-104) with primary/backup link failover

A small, self-contained simulator that runs inside two containerlab nodes
(`SCADA` and `RTU-1`) and exchanges real IEC 60870-5-104 traffic over TCP/2404.

The link layout is the one you asked for:

| Side          | Service IP        | Primary NIC | Backup NIC | Failover  |
|---------------|-------------------|-------------|------------|-----------|
| SCADA master  | `192.168.200.1/24`| `eth1` → `leaf-1` | `eth2` → `leaf-2` | application-level |
| RTU (RTU-1)   | `192.168.200.2/24`| `eth1` → `leaf-1` | `eth2` → `leaf-2` | application-level |

The service IP is mounted on whichever NIC is *active* at any moment.
On failure, `failover.sh` migrates the IP to the standby NIC and sends a
gratuitous ARP. The SCADA app rebinds its socket (`SO_BINDTODEVICE`) to
the new NIC and re-issues `STARTDT`.

## Files

| File                | Role                                                |
|---------------------|-----------------------------------------------------|
| `iec104.py`         | Minimal IEC 104 framing (U/S/I frames, type 36 ASDU)|
| `rtu_responder.py`  | IEC 104 server (runs on RTU-1)                       |
| `scada_server.py`   | IEC 104 client with primary/backup failover         |
| `failover.sh`       | Moves service IP between `eth1` and `eth2`           |
| `setup.sh`          | Initial sysctl + IP placement (runs at lab start)    |

## Bring-up

1. `lab.yaml` already mounts this directory at `/opt/scada` inside the
   `SCADA` and `RTU-1` containers, and runs `setup.sh` at start. After
   `containerlab deploy`, both containers have `192.168.200.{1,2}/24` on
   `eth1` and `eth2` is standby.

2. Start the RTU responder:

   ```sh
   docker exec -d clab-new_lab-RTU-1 python3 /opt/scada/rtu_responder.py
   ```

3. Start the SCADA master:

   ```sh
   docker exec -d clab-new_lab-SCADA python3 /opt/scada/scada_server.py
   ```

4. Tail the logs:

   ```sh
   docker logs -f clab-new_lab-SCADA
   docker logs -f clab-new_lab-RTU-1
   ```

   Or, if you started with `-d` and used redirection, look at
   `/var/log/scada.log` / `/var/log/rtu.log` inside the containers.

You should see the IEC 104 handshake (`STARTDT_ACT` → `STARTDT_CON`),
periodic spontaneous measurements (`M_ME_TF_1` at IOA 4001, ~132 kV),
and TESTFR keepalives every 20 s.

## Triggering failover (for demo)

Any of these will break the primary path and cause the SCADA side to
fail over to `eth2`:

| Action                                        | Command                                                                  |
|-----------------------------------------------|--------------------------------------------------------------------------|
| Drop SCADA's primary NIC                      | `docker exec clab-new_lab-SCADA ip link set eth1 down`                   |
| Drop RTU's primary NIC                        | `docker exec clab-new_lab-RTU-1 ip link set eth1 down`                   |
| Disable the leaf-1 ↔ SCADA interface (SR Linux)| `docker exec clab-new_lab-leaf-1 sr_cli 'enter candidate; /interface ethernet-1/6 admin-state disable; commit now'` |
| Stop the leaf-1 container                     | `docker stop clab-new_lab-leaf-1`                                        |

After the next TESTFR window the SCADA side will log:

```
SCADA session on eth1 failed: TESTFR_CON not received within T1
SCADA failing over: eth1 -> eth2
failover.sh: service IP 192.168.200.1/24 now on eth2
SCADA TCP up on eth2; sending STARTDT
```

Restore the primary path and run `failover.sh eth1` inside the SCADA
container to bring traffic back on the primary.

## L2 reachability between SCADA and RTU-1

The two service IPs share the same `/24`, so the two sides need a flat
L2 path between them through each leaf. In a default SR Linux setup the
leaf interfaces are L3; for this demo, configure both interfaces of
each leaf as `subinterface vlan-tagged` on the same bridge instance, or
use a single VLAN-aware mac-vrf. Example for `leaf-1`:

```
enter candidate
/network-instance mac-vrf-scada
    type mac-vrf
    interface ethernet-1/3.0
    interface ethernet-1/6.0
/interface ethernet-1/3 subinterface 0 type bridged
/interface ethernet-1/6 subinterface 0 type bridged
commit now
```

Repeat on `leaf-2` for `ethernet-1/4` (RTU-1:eth2) and
`ethernet-1/6` (SCADA:eth2). The simulator itself does not depend on
the bridging mode — it only needs a working L2 path on each leaf.

## Tuning

All knobs are env-vars (with `--flag` overrides on `scada_server.py`):

| Env var             | Default | Purpose                              |
|---------------------|---------|--------------------------------------|
| `SCADA_T0`          | `10`    | TCP connect timeout (seconds)        |
| `SCADA_T1`          | `15`    | Ack / U-frame response timeout       |
| `SCADA_T3`          | `20`    | TESTFR keepalive interval            |
| `SCADA_RTU_IP`      | `192.168.200.2` | RTU service IP              |
| `SCADA_PRIMARY_IF`  | `eth1`  | Primary NIC name                     |
| `SCADA_BACKUP_IF`   | `eth2`  | Backup NIC name                      |
| `SCADA_SVC_IP`      | `192.168.200.1` | SCADA service IP            |
| `RTU_PERIOD`        | `1.0`   | Seconds between spontaneous I-frames |

## Verification done

The framing layer and the failover state machine were smoke-tested on
the host (Python 3) over loopback:

- STARTDT handshake completes.
- Spontaneous `M_ME_TF_1` frames flow and parse correctly.
- TESTFR keepalive round-trips.
- Killing the RTU triggers `SessionFailed`, the failover loop runs,
  and the SCADA reconnects when the RTU is restored.
- The full IEC 104 path (incl. `failover.sh`, gratuitous ARP, NIC
  migration) requires the containerlab environment — verify there
  after `containerlab deploy lab.yaml`.
