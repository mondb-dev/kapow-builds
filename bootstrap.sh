#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Copy .env.example and fill in your keys."
  exit 1
fi

# Export all vars from root .env
set -a
source "$ENV_FILE"
set +a

AGENTS=(planner builder qa gate technician security actions)
BOARD=board
DB=db

usage() {
  echo "Usage: $0 {install|dev|build|stop|status|db:migrate|db:seed|db:push}"
  echo ""
  echo "  install    - npm install in all projects (db first)"
  echo "  dev        - start all agents + board in background"
  echo "  build      - build all projects"
  echo "  stop       - kill all running kapow processes"
  echo "  status     - show running kapow processes"
  echo "  db:migrate - run Prisma migrations"
  echo "  db:push    - push schema to DB without migrations"
  echo "  db:seed    - seed the database with initial data"
  exit 1
}

cmd_install() {
  # Install DB package first (other packages depend on it)
  echo "Installing db..."
  (cd "$ROOT/$DB" && npm install && npx prisma generate)

  for agent in "${AGENTS[@]}"; do
    echo "Installing $agent..."
    (cd "$ROOT/$agent" && npm install)
  done
  echo "Installing board..."
  (cd "$ROOT/$BOARD" && npm install)
  echo "All dependencies installed."
}

cmd_dev() {
  local LOG_DIR="$ROOT/logs"
  mkdir -p "$LOG_DIR"

  # Start agents
  for agent in "${AGENTS[@]}"; do
    echo "Starting $agent..."
    (cd "$ROOT/$agent" && npm run dev > "$LOG_DIR/$agent.log" 2>&1) &
    echo "$!" > "$LOG_DIR/$agent.pid"
  done

  # Start board
  echo "Starting board..."
  (cd "$ROOT/$BOARD" && npm run dev > "$LOG_DIR/board.log" 2>&1) &
  echo "$!" > "$LOG_DIR/board.pid"

  echo ""
  echo "All services starting:"
  echo "  kapow-planner     → http://localhost:3001"
  echo "  kapow-builder     → http://localhost:3002"
  echo "  kapow-qa          → http://localhost:3003"
  echo "  kapow-gate        → http://localhost:3004"
  echo "  kapow-technician  → http://localhost:3006"
  echo "  kapow-security    → http://localhost:3007"
  echo "  kapow-actions     → http://localhost:3000"
  echo "  kapow-board       → http://localhost:3005"
  echo ""
  echo "Logs: $LOG_DIR/"
  echo "Stop: $0 stop"
}

cmd_build() {
  # Build DB package first
  echo "Building db..."
  (cd "$ROOT/$DB" && npm run build)

  for agent in "${AGENTS[@]}"; do
    echo "Building $agent..."
    (cd "$ROOT/$agent" && npm run build)
  done
  echo "Building board..."
  (cd "$ROOT/$BOARD" && npm run build)
  echo "All builds complete."
}

cmd_stop() {
  local LOG_DIR="$ROOT/logs"
  local stopped=0
  for svc in "${AGENTS[@]}" "$BOARD"; do
    local pidfile="$LOG_DIR/$svc.pid"
    if [ -f "$pidfile" ]; then
      local pid
      pid=$(cat "$pidfile")
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        echo "Stopped $svc (pid $pid)"
        stopped=$((stopped + 1))
      fi
      rm -f "$pidfile"
    fi
  done
  if [ "$stopped" -eq 0 ]; then
    echo "No running kapow processes found."
  fi
}

cmd_status() {
  local LOG_DIR="$ROOT/logs"
  for svc in "${AGENTS[@]}" "$BOARD"; do
    local pidfile="$LOG_DIR/$svc.pid"
    if [ -f "$pidfile" ]; then
      local pid
      pid=$(cat "$pidfile")
      if kill -0 "$pid" 2>/dev/null; then
        echo "$svc: running (pid $pid)"
      else
        echo "$svc: dead (stale pid $pid)"
      fi
    else
      echo "$svc: not started"
    fi
  done
}

cmd_db_migrate() {
  echo "Running Prisma migrations..."
  (cd "$ROOT/$DB" && npx prisma migrate dev)
}

cmd_db_push() {
  echo "Pushing schema to database..."
  (cd "$ROOT/$DB" && npx prisma db push)
}

cmd_db_seed() {
  echo "Seeding database..."
  (cd "$ROOT/$DB" && npx tsx src/seed.ts)
}

case "${1:-}" in
  install)    cmd_install ;;
  dev)        cmd_dev ;;
  build)      cmd_build ;;
  stop)       cmd_stop ;;
  status)     cmd_status ;;
  db:migrate) cmd_db_migrate ;;
  db:push)    cmd_db_push ;;
  db:seed)    cmd_db_seed ;;
  *)          usage ;;
esac
