#!/usr/bin/env bash
# Remove Approach 2 (Meta View nudge) after a FAIL field decision.
# Leaves Path B / Shadow Proxy / TELEMETRY for mark→Photos timing intact.
# Keeps tools/measure/nudge/ analyzers for historical logs.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP="$ROOT/app"

echo "Stripping Meta View nudge experiment…"

rm -f "$APP/modules/clip-stitcher/ios/MetaViewNudge.m"
rm -f "$APP/src/native/MetaViewNudge.ts"

python3 - "$APP" <<'PY'
from pathlib import Path
import re
import sys

app = Path(sys.argv[1])

p = app / "src/markers/GlassesImportController.ts"
text = p.read_text()
text = text.replace("import { MetaViewNudge } from '../native/MetaViewNudge';\n", "")
text = re.sub(
    r"\n\s*// Optional Meta View wake \(experiment\).*?\n\s*this\.maybeNudgeMetaView\(markerId\)\.catch\(\(\) => undefined\);\n",
    "\n",
    text,
    count=1,
    flags=re.S,
)
text = re.sub(
    r"\n  private async maybeNudgeMetaView\(markerId: string\): Promise<void> \{.*?\n  \}\n",
    "\n",
    text,
    count=1,
    flags=re.S,
)
p.write_text(text)
print("patched GlassesImportController.ts")

p = app / "src/ui/screens/SettingsScreen.tsx"
text = p.read_text()
text = re.sub(
    r"\n\s*<Section title=\"Experiment — Meta View nudge\">.*?</Section>\n",
    "\n",
    text,
    count=1,
    flags=re.S,
)
p.write_text(text)
print("patched SettingsScreen.tsx")

p = app / "src/config.ts"
t = p.read_text()
t = re.sub(r"\n\s*metaViewNudgeAfterMark:\s*(?:false|true),?(?:[^\n]*)\n", "\n", t)
p.write_text(t)
print("patched config.ts")

p = app / "src/types.ts"
t = p.read_text()
t = re.sub(
    r"\n\s*/\*\*\n\s*\* Experimental: after a wake-word mark[\s\S]*?\*/\n\s*metaViewNudgeAfterMark:\s*boolean;\n",
    "\n",
    t,
    count=1,
)
t = re.sub(r"\n\s*metaViewNudgeAfterMark:\s*boolean;?\n", "\n", t)
p.write_text(t)
print("patched types.ts")
PY

echo ""
echo "Strip complete. Next:"
echo "  1. Remove MetaViewNudge from the native target if listed explicitly in Xcode."
echo "  2. cd app && npx jest --forceExit"
echo "  3. Commit: strip Meta View nudge experiment after 10v10 FAIL"
