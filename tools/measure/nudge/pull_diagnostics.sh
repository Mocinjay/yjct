#!/usr/bin/env bash
# Pull clypso-diagnostics.log from a connected iPhone for the 10v10 nudge gate.
#
# Prerequisites: Xcode, device unlocked + trusted, Clypso installed from a
# build that includes TELEMETRY lines (refactor/clypso-architecture).
#
# Usage:
#   ./tools/measure/nudge/pull_diagnostics.sh
#   ./tools/measure/nudge/pull_diagnostics.sh com.your.bundle.id
#   ./tools/measure/nudge/pull_diagnostics.sh --from ~/Downloads/clypso-diagnostics.log
#
# Writes tools/measure/nudge/field/clypso-diagnostics.log then prints the
# analyzer command.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FIELD_DIR="$ROOT/tools/measure/nudge/field"
OUT="$FIELD_DIR/clypso-diagnostics.log"
mkdir -p "$FIELD_DIR"

BUNDLE="${1:-}"
if [[ "${1:-}" == "--from" ]]; then
  SRC="${2:?path required after --from}"
  cp "$SRC" "$OUT"
  echo "Copied $SRC → $OUT"
elif [[ -n "$BUNDLE" && "$BUNDLE" != --* ]]; then
  DEST="$FIELD_DIR/container"
  rm -rf "$DEST"
  echo "Downloading app container for $BUNDLE …"
  xcrun devicectl device copy from \
    --device "$(xcrun devicectl list devices 2>/dev/null | awk '/iPhone|iPad/{print $NF; exit}')" \
    --source "Documents/clypso-diagnostics.log" \
    --destination "$OUT" \
    --domain-type appDataContainer \
    --domain-identifier "$BUNDLE" 2>/dev/null \
  || {
    echo ""
    echo "Automatic pull failed. Manual path (Xcode):"
    echo "  1. Window → Devices and Simulators → select iPhone"
    echo "  2. Installed Apps → Clypso → gear → Download Container…"
    echo "  3. Inside the .xcappdata: AppData/Documents/clypso-diagnostics.log"
    echo "  4. Re-run: $0 --from /path/to/clypso-diagnostics.log"
    exit 1
  }
else
  echo "No bundle id / --from given."
  echo ""
  echo "Preferred (after a 10v10 session on device):"
  echo "  1. Xcode → Devices and Simulators → Clypso → Download Container"
  echo "  2. Copy AppData/Documents/clypso-diagnostics.log here:"
  echo "       $OUT"
  echo "  3. Or: $0 --from ~/Downloads/clypso-diagnostics.log"
  echo ""
  echo "Then analyze:"
  echo "  node --experimental-strip-types tools/measure/nudge/analyze_10v10.ts $OUT"
  exit 2
fi

wc -l "$OUT" | awk '{print "lines:", $1}'
if ! grep -q '\[TELEMETRY\]' "$OUT"; then
  echo "WARN: no [TELEMETRY] lines — build may predate instrumentation, or session had no marks."
fi
echo ""
echo "Analyze:"
echo "  node --experimental-strip-types tools/measure/nudge/analyze_10v10.ts \"$OUT\""
echo "Decide (prints promote vs strip; applies nothing):"
echo "  ./tools/measure/nudge/decide_nudge.sh \"$OUT\""
