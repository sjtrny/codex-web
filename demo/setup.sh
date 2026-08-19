#!/bin/sh
set -eu

demo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$demo_dir"

npm ci
npx playwright install chromium
"${PYTHON:-python3}" -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
