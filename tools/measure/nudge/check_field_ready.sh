#!/usr/bin/env bash
# Fail fast if hardware / field artifacts are missing before a 10v10 gate run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FIELD="$ROOT/tools/measure/nudge/field/clypso-diagnostics.log"
ok=1

echo "=== Clypso field readiness ==="

if xcrun xctrace list devices 2>/dev/null | grep -qiE 'iPhone|iPad'; then
  echo "OK  iOS device visible to xctrace"
else
  echo "BLOCKED  no iPhone/iPad in xctrace (connect + trust, or fix CoreDevice)"
  ok=0
fi

if [[ -f "$FIELD" ]] && grep -q '\[TELEMETRY\]' "$FIELD"; then
  n=$(grep -c '\[TELEMETRY\]' "$FIELD" || true)
  echo "OK  field log with TELEMETRY ($n lines): $FIELD"
else
  echo "BLOCKED  no TELEMETRY field log at $FIELD"
  echo "         pull via: ./tools/measure/nudge/pull_diagnostics.sh --from <path>"
  ok=0
fi

shopt -s nullglob
masters=( "$HOME"/masters/*.{mp4,mov,MP4,MOV} )
if [[ ${#masters[@]} -gt 0 ]]; then
  echo "OK  ${#masters[@]} master file(s) in ~/masters"
else
  echo "BLOCKED  ~/masters empty — export Meta Photos masters for HDR checks"
  ok=0
fi

echo ""
if [[ $ok -eq 1 ]]; then
  echo "Ready: run decide_nudge.sh … --apply and HDR scripts."
  exit 0
fi
echo "Not ready for automated --apply / real HDR. See FIELD-RUNBOOK.md"
exit 1
