#!/bin/bash
# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

# Starts Metro in its own Terminal window.
#
# React Native shipped `scripts/launchPackager.command` for this until it was
# removed in 0.86, which left builds started from Xcode with no way to bring
# Metro up. The "Start Packager" build phase `open`s this file so Metro is
# owned by Terminal.app rather than by the Xcode build process (Xcode tears
# down the process group of a script phase when the phase finishes, which
# would kill a plain background job).

THIS_DIR=$(cd -P "$(dirname "$(readlink "${BASH_SOURCE[0]}" || echo "${BASH_SOURCE[0]}")")" && pwd)
PROJECT_ROOT="$THIS_DIR/../.."

# `open` does not forward environment variables, so the build phase hands the
# port over through this file.
if [[ -f "$THIS_DIR/.packager.env" ]]; then
  # shellcheck disable=SC1091
  source "$THIS_DIR/.packager.env"
fi
export RCT_METRO_PORT="${RCT_METRO_PORT:=8081}"

# Resolve NODE_BINARY exactly like the other Xcode script phases do, so Metro
# runs under the same Node as the build (nvm/Homebrew installs are not on the
# PATH of a GUI-launched Terminal).
if [[ -f "$PROJECT_ROOT/ios/.xcode.env" ]]; then
  # shellcheck disable=SC1091
  source "$PROJECT_ROOT/ios/.xcode.env"
fi
if [[ -f "$PROJECT_ROOT/ios/.xcode.env.local" ]]; then
  # shellcheck disable=SC1091
  source "$PROJECT_ROOT/ios/.xcode.env.local"
fi
export NODE_BINARY

cd "$PROJECT_ROOT" || exit 1
"$PROJECT_ROOT/node_modules/react-native/scripts/packager.sh" --port "$RCT_METRO_PORT"

if [[ -z "$CI" ]]; then
  echo "Process terminated. Press <enter> to close the window"
  read -r
fi
