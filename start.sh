#!/bin/sh
# macOS and Linux counterpart of start.ps1.
#
#   ./start.sh            build if the sources moved on, then run in the background
#   ./start.sh stop       stop the background server
#   ./start.sh restart    stop, then start again
#   ./start.sh fg         run attached to this terminal (Ctrl+C stops it)
#
# The background server writes to logs/promptor.log (the run before it is kept
# as logs/promptor.previous.log) and its process id to logs/promptor.pid.
set -eu

root=$(cd "$(dirname "$0")" && pwd)
cd "$root"

entry="$root/dist/server/main.js"
log="$root/logs/promptor.log"
pidfile="$root/logs/promptor.pid"

# ssh sessions and launchd skip the login profile that puts pwsh and node on
# PATH. Append the usual install places so both are found anyway, behind
# whatever the caller's PATH already prefers.
PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
export PATH

# The pid of the background server, or failure when there is none. The file
# alone is not proof: the server may have exited (closing the last page of a
# single machine ends it) and the system may have handed the pid to another
# process since.
running_pid() {
  [ -f "$pidfile" ] || return 1
  pid=$(cat "$pidfile")
  case $(ps -p "$pid" -o command= 2>/dev/null) in
    *dist/server/main.js*) echo "$pid" ;;
    *) return 1 ;;
  esac
}

prepare() {
  if ! command -v node >/dev/null; then
    echo "node was not found; install Node.js first." >&2
    exit 1
  fi
  if ! command -v pwsh >/dev/null; then
    echo "Warning: pwsh was not found; terminals will not start until PowerShell 7 is installed." >&2
  fi
  [ -d node_modules ] || npm ci
  # Same reasoning as start.ps1: a forgotten rebuild silently serves the
  # previous bundle, and an unchanged tree should still start immediately.
  if [ ! -f "$entry" ] || [ -n "$(find src config package.json package-lock.json -newer "$entry" 2>/dev/null | head -n 1)" ]; then
    echo "Sources changed since the last build; rebuilding..."
    npm run build
  fi
}

start() {
  if pid=$(running_pid); then
    echo "Codex Promptor is already running (pid $pid)."
    return 0
  fi
  prepare
  mkdir -p logs
  [ -f "$log" ] && mv "$log" "$root/logs/promptor.previous.log"
  CODEX_PROMPTOR_ROOT="$root" nohup node "$entry" >"$log" 2>&1 &
  pid=$!
  echo "$pid" >"$pidfile"
  # Wait for the ready line, so a start that fails says why here rather than
  # in a log nobody opens.
  i=0
  until grep -q "Codex Promptor ready" "$log"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$pidfile"
      echo "Codex Promptor did not start:" >&2
      tail -n 20 "$log" >&2
      exit 1
    fi
    i=$((i + 1))
    if [ "$i" -ge 60 ]; then
      echo "Codex Promptor is still starting (pid $pid); see logs/promptor.log."
      return 0
    fi
    sleep 0.5
  done
  grep "Codex Promptor ready" "$log"
  echo "Running in the background (pid $pid). Log: logs/promptor.log. Stop: ./start.sh stop"
}

stop() {
  if ! pid=$(running_pid); then
    rm -f "$pidfile"
    echo "Codex Promptor is not running."
    return 0
  fi
  kill -TERM "$pid"
  # Shutdown closes every terminal first, which takes a moment.
  i=0
  while kill -0 "$pid" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 20 ]; then
      echo "Codex Promptor (pid $pid) is still shutting down." >&2
      exit 1
    fi
    sleep 0.5
  done
  rm -f "$pidfile"
  echo "Codex Promptor stopped."
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  fg)
    if pid=$(running_pid); then
      echo "Codex Promptor is already running in the background (pid $pid); run ./start.sh stop first." >&2
      exit 1
    fi
    prepare
    CODEX_PROMPTOR_ROOT="$root" exec node "$entry"
    ;;
  *)
    echo "Usage: ./start.sh [start|stop|restart|fg]" >&2
    exit 2
    ;;
esac
