#!/usr/bin/env bash
set -euo pipefail

# Start the complete local Routz demo:
#   railroad backend :8000
#   acoustic backend :8001
#   user backend     :8002
#   user frontend    :3000
#   3D simulation    :3100
#
# Optional overrides:
#   ROUTZ_BACKEND_PYTHON=/path/to/python
#   ROUTZ_SIMULATION_PYTHON=/path/to/python
#   ROUTZ_NODE_DIR=/path/to/node/bin
#   ROUTZ_ENV_FILE=/path/to/env-file

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROUTZ_ENV_FILE:-$PROJECT_ROOT/deploy/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

BACKEND_PYTHON="${ROUTZ_BACKEND_PYTHON:-}"
if [[ -z "$BACKEND_PYTHON" && -x "$PROJECT_ROOT/backend/.venv/bin/python" ]]; then
  BACKEND_PYTHON="$PROJECT_ROOT/backend/.venv/bin/python"
fi
BACKEND_PYTHON="${BACKEND_PYTHON:-python3}"

SIMULATION_PYTHON="${ROUTZ_SIMULATION_PYTHON:-$BACKEND_PYTHON}"

NODE_BIN="${ROUTZ_NODE_DIR:-}"
if [[ -n "$NODE_BIN" ]]; then
  PATH="$NODE_BIN:$PATH"
fi

if ! command -v "$BACKEND_PYTHON" >/dev/null 2>&1 && [[ ! -x "$BACKEND_PYTHON" ]]; then
  echo "Backend Python was not found: $BACKEND_PYTHON" >&2
  exit 1
fi
if ! command -v "$SIMULATION_PYTHON" >/dev/null 2>&1 && [[ ! -x "$SIMULATION_PYTHON" ]]; then
  echo "Simulation Python was not found: $SIMULATION_PYTHON" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Set ROUTZ_NODE_DIR to the directory containing node and npm." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for local health checks." >&2
  exit 1
fi

check_imports() {
  local python="$1"
  shift
  "$python" - "$@" <<'PY'
import importlib.util
import sys

missing = [name for name in sys.argv[1:] if importlib.util.find_spec(name) is None]
if missing:
    print(", ".join(missing))
    raise SystemExit(1)
PY
}

if ! check_imports "$BACKEND_PYTHON" fastapi uvicorn shapely pyproj; then
  echo "The backend Python environment is missing FastAPI, uvicorn, shapely, or pyproj." >&2
  echo "Install backend/requirements.txt or set ROUTZ_BACKEND_PYTHON to a ready environment." >&2
  exit 1
fi
if ! check_imports "$SIMULATION_PYTHON" fastapi uvicorn numpy scipy soundfile websockets; then
  echo "The simulation Python environment is missing an acoustic service dependency." >&2
  echo "Install simulation_backend/requirements.txt or set ROUTZ_SIMULATION_PYTHON." >&2
  exit 1
fi
for frontend_dir in "$PROJECT_ROOT/frontend" "$PROJECT_ROOT/simulation_frontend"; do
  if [[ ! -d "$frontend_dir/node_modules" ]]; then
    echo "Missing Node dependencies in $frontend_dir; run npm install there first." >&2
    exit 1
  fi
done

export INTERNAL_API_TOKEN="${INTERNAL_API_TOKEN:-local-dev-token}"
export USER_BACKEND_PORT="${USER_BACKEND_PORT:-8002}"
export USER_ALLOWED_ORIGINS="${USER_ALLOWED_ORIGINS:-http://localhost:3000,http://localhost:3100,http://127.0.0.1:3000,http://127.0.0.1:3100}"
export SIMULATION_ALLOWED_ORIGINS="${SIMULATION_ALLOWED_ORIGINS:-$USER_ALLOWED_ORIGINS}"
export USER_BACKEND_PREDICTIONS_URL="${USER_BACKEND_PREDICTIONS_URL:-http://127.0.0.1:8002/api/predictions}"
export NEXT_PUBLIC_USER_API_URL="${NEXT_PUBLIC_USER_API_URL:-http://127.0.0.1:8002}"
export NEXT_PUBLIC_USER_WS_URL="${NEXT_PUBLIC_USER_WS_URL:-ws://127.0.0.1:8002/ws/updates}"
export NEXT_PUBLIC_ROUTZ_API_URL="${NEXT_PUBLIC_ROUTZ_API_URL:-$NEXT_PUBLIC_USER_API_URL}"
export NEXT_PUBLIC_ROUTZ_WS_URL="${NEXT_PUBLIC_ROUTZ_WS_URL:-$NEXT_PUBLIC_USER_WS_URL}"
export NEXT_PUBLIC_SIMULATION_API_URL="${NEXT_PUBLIC_SIMULATION_API_URL:-http://127.0.0.1:8000}"
export NEXT_PUBLIC_SIMULATION_WS_URL="${NEXT_PUBLIC_SIMULATION_WS_URL:-ws://127.0.0.1:8000/ws/simulation}"
export NEXT_PUBLIC_AUDIO_WS_URL="${NEXT_PUBLIC_AUDIO_WS_URL:-ws://127.0.0.1:8001/ws/simulation}"

PIDS=()

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
}

on_signal() {
  exit 130
}

trap cleanup EXIT
trap on_signal INT TERM

run_background() {
  "$@" &
  PIDS+=("$!")
}

wait_for_health() {
  local name="$1"
  local url="$2"
  local attempts=0
  until curl -fsS --max-time 2 "$url" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if (( attempts >= 60 )); then
      echo "Timed out waiting for $name at $url" >&2
      exit 1
    fi
    sleep 0.5
  done
}

echo "Starting railroad backend on :8000"
run_background env PYTHONPATH="$PROJECT_ROOT/backend/src" "$BACKEND_PYTHON" -m uvicorn backend.main:app --host 127.0.0.1 --port 8000

echo "Starting user backend on :8002"
run_background env PYTHONPATH="$PROJECT_ROOT/backend/src" "$BACKEND_PYTHON" -m uvicorn backend.user_api:app --host 127.0.0.1 --port 8002

echo "Starting acoustic backend on :8001"
run_background env PYTHONPATH="$PROJECT_ROOT/simulation_backend" "$SIMULATION_PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port 8001

wait_for_health "railroad backend" "http://127.0.0.1:8000/health"
wait_for_health "user backend" "http://127.0.0.1:8002/health"
wait_for_health "acoustic backend" "http://127.0.0.1:8001/health"

echo "Starting user frontend on :3000"
(cd "$PROJECT_ROOT/frontend" && npm run dev -- --hostname 127.0.0.1 --port 3000) &
PIDS+=("$!")

echo "Starting 3D simulation frontend on :3100"
(cd "$PROJECT_ROOT/simulation_frontend" && npm run dev -- --hostname 127.0.0.1 --port 3100) &
PIDS+=("$!")

cat <<'EOF'

Routz is running:
  User map:       http://localhost:3000
  3D simulation:  http://localhost:3100
  Railroad API:   http://localhost:8000/health
  Acoustic API:   http://localhost:8001/health
  User API:       http://localhost:8002/health

Run the smoke test in another terminal:
  ./scripts/e2e_smoke.py

Press Ctrl-C to stop all services.
EOF

while true; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      exit $?
    fi
  done
  sleep 2
done
