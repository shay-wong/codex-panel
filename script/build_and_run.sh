#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Codex Panel"
PROCESS_NAME="CodexPanelLauncher"
APP_BUNDLE="$HOME/Applications/$APP_NAME.app"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/$PROCESS_NAME"

app_pids() {
  /bin/ps -ax -o pid=,comm= | /usr/bin/awk -v target="$APP_BINARY" '
    {
      pid = $1
      $1 = ""
      sub(/^[[:space:]]+/, "")
      if ($0 == target) print pid
    }
  '
}

app_is_running() {
  [[ -n "$(app_pids)" ]]
}

pid_matches_app_binary() {
  local app_pid="$1"
  local command
  command="$(/bin/ps -p "$app_pid" -o comm= 2>/dev/null || true)"
  [[ "$command" == "$APP_BINARY" ]]
}

request_app_quit() {
  /usr/bin/osascript \
    -e 'tell application id "com.shay.codex-panel" to quit' \
    >/dev/null \
    || true
}

stop_app_with_wait_iterations() {
  local wait_iterations="$1"
  local app_pid app_pid_list attempt still_running
  app_pid_list="$(app_pids)"
  [[ -z "$app_pid_list" ]] && return

  request_app_quit

  for ((attempt = 0; attempt < wait_iterations; attempt += 1)); do
    still_running=false
    for app_pid in $app_pid_list; do
      if pid_matches_app_binary "$app_pid"; then
        still_running=true
        break
      fi
    done
    [[ "$still_running" == false ]] && return 0
    /bin/sleep 0.1
  done

  for app_pid in $app_pid_list; do
    if pid_matches_app_binary "$app_pid"; then
      /bin/kill -KILL "$app_pid"
    fi
  done
  for _ in {1..20}; do
    still_running=false
    for app_pid in $app_pid_list; do
      if pid_matches_app_binary "$app_pid"; then
        still_running=true
        break
      fi
    done
    [[ "$still_running" == false ]] && return 0
    /bin/sleep 0.1
  done
  echo "Codex Panel did not exit after the forced launcher-only shutdown" >&2
  return 1
}

stop_app() {
  stop_app_with_wait_iterations 300
}

open_app() {
  /usr/bin/open "$APP_BUNDLE"
}

main() {
  local mode="${1:-run}"
  stop_app
  cd "$ROOT_DIR"
  npm run codex:install

  case "$mode" in
    run)
      open_app
      ;;
    --debug|debug)
      /usr/bin/lldb -- "$APP_BINARY"
      ;;
    --logs|logs|--telemetry|telemetry)
      open_app
      /usr/bin/log stream --info --style compact --predicate "process == \"$PROCESS_NAME\""
      ;;
    --verify|verify)
      open_app
      for _ in {1..80}; do
        if app_is_running \
          && /usr/bin/curl -fsS --max-time 1 http://127.0.0.1:47823/health >/dev/null 2>&1; then
          return 0
        fi
        /bin/sleep 0.25
      done
      return 1
      ;;
    *)
      echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
      return 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
