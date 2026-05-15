#!/usr/bin/env bash
# update-ips.sh — Sync config.json router IPs with current Containerlab container IPs.
#
# Usage:  bash scripts/update-ips.sh [--apply]
#
# Without --apply  → shows a diff of what WOULD change (dry-run, safe to run anytime)
# With    --apply  → patches config.json in-place and prints a summary
#
# Run this after every `clab deploy` or `clab redeploy` to avoid the symptom where
# gnmic connects to the wrong container and the dashboard shows incorrect link states.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/../config.json"
APPLY=false
[[ "${1-}" == "--apply" ]] && APPLY=true

# Pairs: "config_key:container_name"
MAPPINGS="dc1:DC-1 dc2:DC-2 leaf1:leaf-1 leaf2:leaf-2 leaf3:leaf-3 leaf4:leaf-4"

any_change=false

for pair in $MAPPINGS; do
  rid="${pair%%:*}"
  cname="${pair##*:}"

  actual_ip=$(docker inspect "$cname" 2>/dev/null \
    | python3 -c "import sys,json; nets=json.load(sys.stdin)[0]['NetworkSettings']['Networks']; print(list(nets.values())[0]['IPAddress'])" 2>/dev/null || true)

  if [ -z "$actual_ip" ]; then
    echo "⚠  $rid ($cname): container not found — skipping"
    continue
  fi

  current_ip=$(python3 -c "import json; print(json.load(open('$CONFIG'))['routers']['$rid']['host'])")

  if [ "$actual_ip" = "$current_ip" ]; then
    echo "✓  $rid ($cname): $current_ip  [no change]"
  else
    any_change=true
    echo "✗  $rid ($cname): config=$current_ip  actual=$actual_ip  ← NEEDS UPDATE"
    if $APPLY; then
      python3 - "$CONFIG" "$current_ip" "$actual_ip" <<'PYEOF'
import sys, pathlib
cfg_path, old_ip, new_ip = sys.argv[1], sys.argv[2], sys.argv[3]
text = pathlib.Path(cfg_path).read_text()
# Replace only the first occurrence of this exact IP to avoid false matches across routers
patched = text.replace(f'"host": "{old_ip}"', f'"host": "{new_ip}"', 1)
pathlib.Path(cfg_path).write_text(patched)
PYEOF
      echo "   → patched: $current_ip → $actual_ip"
    fi
  fi
done

echo ""
if $any_change && ! $APPLY; then
  echo "Run with --apply to patch config.json, then restart the backend:"
  echo "  bash scripts/update-ips.sh --apply && pkill -f ping-service.js && node ping-service.js &"
elif ! $any_change; then
  echo "All IPs are correct — no action needed."
fi
