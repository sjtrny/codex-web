#!/bin/sh
set -eu

demo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$demo_dir"

if [ ! -x .venv/bin/python ] || [ ! -d node_modules ]; then
  echo "Run ./setup.sh first." >&2
  exit 1
fi

exec node record.js "$@"
