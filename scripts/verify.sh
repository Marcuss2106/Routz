#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROUTZ_NODE_DIR="${ROUTZ_NODE_DIR:-/tmp/routz-node}"

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

echo "Verification passed. Backend user API tests require the backend environment"
echo "(uv sync or backend/.venv with requirements-dev.txt) and can then run with:"
echo "  cd backend && PYTHONPATH=src .venv/bin/python -m pytest -q"
