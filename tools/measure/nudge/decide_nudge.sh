#!/usr/bin/env bash
# Gate for Approach 2: promote vs strip vs hold.
#
# Runs analyze_10v10.ts and prints the exact production action. Does NOT mutate
# the tree unless --apply is passed (and only then on PASS or FAIL — never on
# INCONCLUSIVE).
#
# Usage:
#   ./tools/measure/nudge/decide_nudge.sh path/to/clypso-diagnostics.log
#   ./tools/measure/nudge/decide_nudge.sh --fixture
#   ./tools/measure/nudge/decide_nudge.sh field/clypso-diagnostics.log --apply

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ANALYZER="$ROOT/tools/measure/nudge/analyze_10v10.ts"
APPLY=0
TARGET=""

for arg in "$@"; do
  if [[ "$arg" == "--apply" ]]; then
    APPLY=1
  elif [[ -z "$TARGET" ]]; then
    TARGET="$arg"
  fi
done

if [[ -z "$TARGET" ]]; then
  echo "usage: decide_nudge.sh <log|--fixture> [--apply]" >&2
  exit 2
fi

set +e
if [[ "$TARGET" == "--fixture" ]]; then
  OUT=$(node --experimental-strip-types "$ANALYZER" --fixture 2>&1)
else
  OUT=$(node --experimental-strip-types "$ANALYZER" "$TARGET" 2>&1)
fi
RC=$?
set -e
echo "$OUT"
echo ""

VERDICT=$(echo "$OUT" | awk '/^Verdict:/{print $2; exit}')

case "$VERDICT" in
  PASS)
    if [[ "$TARGET" == "--fixture" ]]; then
      echo "=== PRODUCTION CALL: HOLD (fixture only) ==="
      echo "Fixture proves the analyzer; it is not field evidence. Do not promote."
      exit 2
    fi
    echo "=== PRODUCTION CALL: PROMOTE ==="
    echo "p50 reduction cleared >20% with clean mic health."
    echo "Diff to apply:"
    echo "  - app/src/config.ts: metaViewNudgeAfterMark: true"
    echo "  - Settings copy: label as 'Faster Meta sync (recommended)' not Experiment"
    if [[ $APPLY -eq 1 ]]; then
      python3 - "$ROOT/app/src/config.ts" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
old = "metaViewNudgeAfterMark: false,"
new = "metaViewNudgeAfterMark: true, // field 10v10 PASS — default on"
if old not in text:
    raise SystemExit("config already promoted or unexpected shape")
p.write_text(text.replace(old, new, 1))
print("Applied: metaViewNudgeAfterMark → true")
PY
    else
      echo "Re-run with --apply to flip the default."
    fi
    exit 0
    ;;
  FAIL)
    echo "=== PRODUCTION CALL: STRIP ==="
    echo "Nudge missed the bar and/or mic daemon failed after fb-viewapp:// bounce."
    echo "Strip list (pure passive Photos watching remains):"
    echo "  - app/modules/clip-stitcher/ios/MetaViewNudge.m (+ header if any)"
    echo "  - app/src/native/MetaViewNudge.ts"
    echo "  - GlassesImportController maybeNudgeMetaView + MetaViewNudge import"
    echo "  - SettingsScreen Meta View nudge rows"
    echo "  - types/config metaViewNudgeAfterMark"
    echo "  - Info.plist schemes added solely for the probe (keep fb-viewapp if DAT needs it)"
    echo "  - Keep tools/measure/nudge/ for historical analysis of old logs"
    if [[ $APPLY -eq 1 ]]; then
      echo "Running strip…"
      bash "$ROOT/tools/measure/nudge/strip_nudge_experiment.sh"
    else
      echo "Re-run with --apply to execute tools/measure/nudge/strip_nudge_experiment.sh"
    fi
    exit 1
    ;;
  INCONCLUSIVE|*)
    echo "=== PRODUCTION CALL: HOLD ==="
    echo "Need a real 10v10 clypso-diagnostics.log (≥5 timed runs/arm)."
    echo "Do NOT promote. Do NOT strip. Path B + Shadow Proxy remain the merge deliverable."
    echo "metaViewNudgeAfterMark stays false (opt-in Settings probe only)."
    if [[ $APPLY -eq 1 ]]; then
      echo "--apply ignored on HOLD/INCONCLUSIVE."
    fi
    exit 2
    ;;
esac
