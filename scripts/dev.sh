#!/usr/bin/env bash
#
# Brings up the whole local stack: MongoDB, the backend API, the backend worker, and the three
# web apps. Logs go to .dev-logs/. Ctrl-C stops everything this script started.
#
#   ./scripts/dev.sh          start everything
#   ./scripts/dev.sh status   show what is running
#   ./scripts/dev.sh stop     stop the backend and web apps (leaves MongoDB running)
#
set -euo pipefail

# This script lives in the backend repo. The four app repos are checked out as siblings of it,
# so the search root is one level above the backend, not the backend itself.
BACKEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$BACKEND/.." && pwd)"

# Each app is its own repository now; skip any that is not checked out here.
APP_ADMIN="$ROOT/turfgang-admin-portal"
APP_OWNER="$ROOT/turfgang-owner-web"
APP_PARTNER="$ROOT/turfgang-partner-console"
LOGS="$BACKEND/.dev-logs"
MONGO_BIN="/opt/homebrew/opt/mongodb-community@8.0/bin"
MONGO_DATA="$HOME/data/turfgang-db"
MONGO_LOG="$HOME/data/turfgang-log"
PIDFILE="$LOGS/dev.pids"

mkdir -p "$LOGS" "$MONGO_DATA" "$MONGO_LOG"
export PATH="$MONGO_BIN:$PATH"

started=()

wait_for() { # url, label, attempts
  local url="$1" label="$2" attempts="${3:-40}"
  for _ in $(seq 1 "$attempts"); do
    if curl -sf -m 2 "$url" >/dev/null 2>&1; then
      echo "  ✓ $label"
      return 0
    fi
    sleep 1
  done
  echo "  ✗ $label did not come up — check $LOGS"
  return 1
}

start_mongo() {
  if mongosh --quiet --eval 'db.runCommand({ping:1})' >/dev/null 2>&1; then
    echo "  ✓ MongoDB already running"
    return
  fi
  # A replica set is mandatory: the backend uses multi-document transactions throughout.
  mongod --dbpath "$MONGO_DATA" --logpath "$MONGO_LOG/mongod.log" \
         --replSet rs0 --bind_ip 127.0.0.1 --port 27017 --fork >/dev/null
  sleep 2
  mongosh --quiet --eval 'try { rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]}) } catch (e) {}' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    if mongosh --quiet --eval 'rs.status().members[0].stateStr' 2>/dev/null | grep -q PRIMARY; then
      echo "  ✓ MongoDB replica set PRIMARY"
      return
    fi
    sleep 1
  done
  echo "  ✗ MongoDB did not reach PRIMARY"
  exit 1
}

spawn() { # label, dir, command..., logfile
  local label="$1" dir="$2" log="$3"; shift 3
  ( cd "$dir" && "$@" >"$LOGS/$log" 2>&1 ) &
  local pid=$!
  echo "$pid $label" >> "$PIDFILE"
  started+=("$label")
}

case "${1:-start}" in
  status)
    curl -sf -m 3 localhost:3000/ready | sed 's/^/  api    /' || echo "  api    down"
    for port in 5180 5181 5182; do
      if curl -sf -m 2 "localhost:$port" >/dev/null 2>&1; then echo "  web    :$port up"; else echo "  web    :$port down"; fi
    done
    exit 0
    ;;
  stop)
    if [[ -f "$PIDFILE" ]]; then
      while read -r pid label; do
        kill "$pid" 2>/dev/null && echo "  stopped $label" || true
      done < "$PIDFILE"
      rm -f "$PIDFILE"
    fi
    # Vite, Next and tsx all spawn children that outlive the parent shell.
    pkill -f 'tsx watch src/server.ts' 2>/dev/null || true
    pkill -f 'tsx watch src/worker.ts' 2>/dev/null || true
    pkill -f 'vite --port 518' 2>/dev/null || true
    pkill -f 'next dev -p 518' 2>/dev/null || true
    # Next renames its worker to `next-server`, so the name no longer matches what was spawned.
    # Sweeping the dev ports catches it without touching Next servers from other projects.
    for port in 5180 5181 5182; do
      for pid in $(lsof -ti "tcp:$port" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
    done
    echo "Backend and web apps stopped. MongoDB left running."
    exit 0
    ;;
esac

: > "$PIDFILE"

# Vite had `strictPort` and refused to start on a taken port; `next dev -p N` silently moves to
# the next free one instead, which is how a different project's app ended up being served on a
# port this script then reported as "up". Check first so a clash is loud.
busy=""
for port in 5180 5181 5182; do
  if lsof -ti "tcp:$port" >/dev/null 2>&1; then busy="$busy $port"; fi
done
if [[ -n "$busy" ]]; then
  echo "Ports in use:$busy"
  echo "Something else is already listening. Run './scripts/dev.sh stop', or free them, then retry."
  lsof -nP -sTCP:LISTEN $(for p in $busy; do echo -n "-iTCP:$p "; done) 2>/dev/null | tail -n +2 | awk '{print "  " $1, $2, $9}'
  exit 1
fi

echo "Starting Turf Gang…"
start_mongo

spawn "api"    "$BACKEND" api.log    npm run dev
spawn "worker" "$BACKEND" worker.log npm run worker:dev
wait_for "http://localhost:3000/health" "API on :3000"

[ -d "$APP_ADMIN" ]   && spawn "admin"   "$APP_ADMIN"   admin.log   npm run dev
[ -d "$APP_OWNER" ]   && spawn "owner"   "$APP_OWNER"   owner.log   npm run dev
[ -d "$APP_PARTNER" ] && spawn "partner" "$APP_PARTNER" partner.log npm run dev

wait_for "http://localhost:5180" "Admin portal    http://localhost:5180" 60
wait_for "http://localhost:5181" "Owner web app   http://localhost:5181" 60
wait_for "http://localhost:5182" "Partner console http://localhost:5182" 60

cat <<'BANNER'

Everything is up. Seed a fully-onboarded Indore turf with:

    node scripts/seed.mjs

It prints working logins for all three apps plus sandbox and production API keys.
Logs are in .dev-logs/. Press Ctrl-C to stop.

BANNER

trap 'echo; "$0" stop; exit 0' INT TERM
wait
