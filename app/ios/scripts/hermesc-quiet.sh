#!/bin/sh
#
# A drop-in stand-in for `hermesc`, pointed at by HERMES_CLI_PATH in the
# "Bundle React Native code and images" build phase.
#
# Compiling the Metro bundle produces ~46 warnings on every device build, and
# not one of them is about our code:
#
#   - "the variable <x> was not declared" for every host global the bundle
#     touches (console, setTimeout, fetch, document, localStorage, ...). Hermes
#     has no lib.dom, so every global looks undeclared to it. They are provided
#     by the runtime at execution time and always have been.
#   - "Direct call to eval()" twice, from React DevTools' backend.
#
# Both live inside React Native's own JavaScript. The only ways to reach the
# compiler's flags are this variable or patching react-native-xcode.sh, which
# hard-codes EXTRA_COMPILER_ARGS. Two categories are turned off by name rather
# than using -w, so a genuinely new class of warning still surfaces.
exec "${HERMES_ENGINE_PATH:-$PODS_ROOT/hermes-engine}/destroot/bin/hermesc" \
  -Wno-undefined-variable \
  -Wno-direct-eval \
  "$@"
