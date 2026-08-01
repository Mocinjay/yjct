#!/usr/bin/env bash
#
# One command to get a freshly fetched checkout building.
#
# Safe to re-run: every step is idempotent, and the script stops with an
# explanation rather than guessing whenever something needs a human decision.
#
#     ./scripts/setup.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }
ok()   { printf '  ok  %s\n' "$1"; }

bold "Jarvis setup"
echo "in $APP_DIR"
echo

# --- 1. node ----------------------------------------------------------------
# package.json requires >= 22.11.0. Xcode's build script phases shell out to
# node, so a node that only exists inside a shell rc file is not enough.
command -v node >/dev/null 2>&1 || fail "node not found. Install Node >= 22.11.0."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "node $(node --version) is too old; package.json requires >= 22.11.0."
fi
ok "node $(node --version)"

# Xcode script phases do not inherit an interactive shell, so if node lives
# somewhere non-standard it must be recorded here. This file is gitignored
# precisely because the path differs per machine.
if [ ! -f ios/.xcode.env.local ]; then
  echo "export NODE_BINARY=$(command -v node)" > ios/.xcode.env.local
  ok "wrote ios/.xcode.env.local (NODE_BINARY=$(command -v node))"
else
  ok "ios/.xcode.env.local already present"
fi

# --- 2. JS dependencies -----------------------------------------------------
if [ -d node_modules ]; then
  ok "node_modules present (delete it and re-run for a clean install)"
else
  bold "Installing JS dependencies"
  npm ci
fi

# --- 3. signing -------------------------------------------------------------
# Signing is per-developer and deliberately NOT committed: a bundle identifier
# registered to one Apple Developer team cannot be signed by another, so a
# committed team ID breaks every other developer with "No profiles for
# '<bundle id>' were found".
if [ ! -f ios/Config/Signing.xcconfig ]; then
  cp ios/Config/Signing.xcconfig.example ios/Config/Signing.xcconfig
  echo
  bold "ACTION NEEDED: fill in ios/Config/Signing.xcconfig"
  cat <<'EOF'

  It was just created from the example with placeholder values. Set:

    DEVELOPMENT_TEAM           your 10-character Apple Developer Team ID
                               (Xcode > Settings > Accounts > your team;
                               the ID is in parentheses)
    PRODUCT_BUNDLE_IDENTIFIER  must be unique to you, e.g. com.yourname.jarvis

  Then run this script again.

EOF
  exit 1
fi

if grep -q "ABCDE12345\|com.yourname.jarvis" ios/Config/Signing.xcconfig; then
  fail "ios/Config/Signing.xcconfig still has example placeholder values. Edit it, then re-run."
fi
ok "ios/Config/Signing.xcconfig configured"

# --- 4. CocoaPods -----------------------------------------------------------
# Podfile.lock records a checksum per pod. Several React Native pods
# (hermes-engine, React-Core-prebuilt, Yoga) are prebuilt artifacts whose
# checksums differ between machines, so ANY pull that touches Podfile.lock
# leaves the sandbox out of sync and the build fails with
# "The sandbox is not in sync with the Podfile.lock". Re-running pod install
# is the fix, and is why this script should be run after every pull.
bold "Installing pods"
if bundle exec pod --version >/dev/null 2>&1; then
  (cd ios && bundle exec pod install)
elif command -v pod >/dev/null 2>&1; then
  (cd ios && pod install)
else
  cat <<'EOF'
CocoaPods is not available.

  The system Ruby (2.6) cannot run the bundler version this Gemfile wants.
  Install a modern Ruby and CocoaPods, for example:

      brew install ruby
      echo 'export PATH="/opt/homebrew/opt/ruby/bin:$PATH"' >> ~/.zshrc
      exec zsh
      gem install bundler cocoapods
      cd app && bundle install

  Then run this script again.
EOF
  exit 1
fi

echo
bold "Done."
cat <<'EOF'

  Open the WORKSPACE, never the project:

      open ios/Jarvis.xcworkspace

  Re-run this script after any pull that changes Podfile.lock or package-lock.json.
EOF
