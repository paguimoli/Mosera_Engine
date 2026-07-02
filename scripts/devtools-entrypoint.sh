#!/usr/bin/env bash
set -euo pipefail

if [ -d /opt/lottery-devtools/node_modules ] && [ ! -x /workspace/node_modules/.bin/next ]; then
  mkdir -p /workspace/node_modules
  cp -a /opt/lottery-devtools/node_modules/. /workspace/node_modules/
fi

exec "$@"
