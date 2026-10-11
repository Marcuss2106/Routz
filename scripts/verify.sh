#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROUTZ_NODE_DIR="${ROUTZ_NODE_DIR:-/tmp/routz-node}"
if [[ -x /tmp/routz-simulation-venv/bin/python ]]; then
  ROUTZ_VERIFY_PYTHON="/tmp/routz-simulation-venv/bin/python"
else
  ROUTZ_VERIFY_PYTHON="python3"
fi

echo "== acoustic backend tests =="
if [[ -x /tmp/routz-simulation-venv/bin/python ]]; then
  (cd "$PROJECT_ROOT/simulation_backend" && PYTHONPATH=. /tmp/routz-simulation-venv/bin/python -m pytest -q)
else
  (cd "$PROJECT_ROOT/simulation_backend" && PYTHONPATH=. python3 -m pytest -q)
fi

echo "== TypeScript apps =="
if [[ -x "$ROUTZ_NODE_DIR/bin/npm" ]]; then
  export PATH="$ROUTZ_NODE_DIR/bin:$PATH"
fi
(cd "$PROJECT_ROOT/frontend" && npm run lint && npm run build)
(cd "$PROJECT_ROOT/simulation_frontend" && npm run lint && npm run build)

echo "== orchestration scripts =="
bash -n "$PROJECT_ROOT/scripts/dev.sh"
"$ROUTZ_VERIFY_PYTHON" - "$PROJECT_ROOT/scripts/e2e_smoke.py" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
compile(path.read_text(), str(path), "exec")
PY

if [[ "${ROUTZ_RUN_E2E:-0}" == "1" ]]; then
  echo "== live end-to-end smoke test =="
  "$ROUTZ_VERIFY_PYTHON" "$PROJECT_ROOT/scripts/e2e_smoke.py"
fi

echo "Verification passed. Backend user API tests require the backend environment"
echo "(uv sync or backend/.venv with requirements-dev.txt) and can then run with:"
echo "  cd backend && PYTHONPATH=src .venv/bin/python -m pytest -q"
echo "Set ROUTZ_RUN_E2E=1 while scripts/dev.sh is running to include the live smoke test."
