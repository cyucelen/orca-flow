#!/bin/sh
# Development loop for the sidebar plugin, working around an Orca hash bug (seen in 1.4.254 and
# 1.4.268): approval hashes the folder without `.orca/`, the worker's start check hashes it with
# `.orca/`, so any `.orca/` present when Orca hot-reloads the folder fails "content hash mismatch"
# and Orca drops local.flow to pending (no sidebar). So `.orca/` never goes into this folder:
# `check` type-checks and tests a copy in a temporary folder. Never run `orca plugin types .` here.
#
# Exactly one Orca Flow may run (both bind Alt+1..9; two running error each other). `load` swaps
# to local.flow and goes back to the installed copy when local.flow fails; `off` goes back to it.
#
#   scripts/dev.sh check   types + tsc + tests, in a temporary copy of this folder
#   scripts/dev.sh load    disable the installed copy, approve and (re)start local.flow, fall back on failure
#   scripts/dev.sh off     unload local.flow and run the installed copy again
#   scripts/dev.sh shot    screenshot the panel and status bar to $SHOTS (default /tmp/orca-sidebar-shots)
set -eu
cd "$(dirname "$0")/.."
KEY=local.flow
INSTALLED=cyucelen.flow
SHOTS=${SHOTS:-/tmp/orca-sidebar-shots}
status() { orca plugin list --json | python3 -c "import json,sys; print(next((p.get('status') for p in json.load(sys.stdin)['result']['plugins'] if p['pluginKey']=='$1'), 'absent'))"; }
# Enables a plugin; Orca can answer with an approval fingerprint (or a newer one), so retry with it.
enable() {
  try() { orca plugin enable "$1" ${2:+--approve "$2"} --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print('' if d['ok'] else d.get('error',{}).get('data',{}).get('approvalFingerprint','failed'))"; }
  fp=${2:-}
  for _ in 1 2 3; do again=$(try "$1" "$fp"); [ -z "$again" ] && return 0; [ "$again" = failed ] && return 1; fp=$again; done
  return 1
}
restore_installed() {
  [ "$(status $INSTALLED)" = absent ] && { echo "$INSTALLED is not installed: no Orca Flow runs"; return 1; }
  [ "$(status $INSTALLED)" = running ] || enable $INSTALLED || { echo "$INSTALLED: enable failed"; return 1; }
  echo "$INSTALLED: $(status $INSTALLED)"
}

case "${1:-}" in
  check)
    # Left over from a hand-run `orca plugin types .`: remove it before Orca reloads with it.
    rm -rf .orca
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/orca-flow-check.XXXXXX")
    trap 'rm -rf "$tmp"' EXIT
    rsync -a --exclude .git --exclude .orca --exclude node_modules ./ "$tmp/"
    cd "$tmp"
    orca plugin types . --json >/dev/null
    npx -y -p typescript tsc -p . --noEmit
    # Show the summaries, but fail the script when any test fails.
    out=$(orca plugin test . 2>&1) || { echo "$out" | grep -E '✖|Error|expected|actual' | head -20; echo 'plugin tests FAILED'; exit 1; }
    echo "$out" | tail -1
    out=$(node --test test/*.test.mjs 2>&1) || { echo "$out" | grep -E '✖|Error' | head -20; echo 'orca-flow tests FAILED'; exit 1; }
    echo "$out" | grep -E '(pass|fail) [0-9]'
    ;;
  load)
    # Both copies bind Alt+1..9, and Orca errors both when they run at once: the installed copy
    # goes off first, and comes back when local.flow does not reach running.
    fp=$(orca plugin dev load . --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('data',{}).get('approvalFingerprint',''))")
    # `dev load` writes .orca/ typings into the folder: remove them before the worker starts.
    rm -rf .orca
    orca plugin disable "$INSTALLED" --json >/dev/null 2>&1 || true
    orca plugin disable "$KEY" --json >/dev/null 2>&1 || true
    enable "$KEY" "$fp" || true
    sleep 6
    if [ "$(status $KEY)" = running ]; then
      echo "$KEY: running ($INSTALLED disabled)"
    else
      echo "$KEY: $(status $KEY), not running; going back to $INSTALLED"
      orca plugin disable "$KEY" --json >/dev/null 2>&1 || true
      restore_installed
      exit 1
    fi
    ;;
  off)
    orca plugin disable "$KEY" --json >/dev/null 2>&1 || true
    orca plugin dev unload . --json >/dev/null 2>&1 || true
    restore_installed
    ;;
  shot)
    mkdir -p "$SHOTS"
    orca plugin open "$KEY" --panel orca-flow --json >/dev/null
    sleep 3
    orca plugin shot "$KEY" --panel orca-flow --out "$SHOTS/panel.png" --json >/dev/null && echo "$SHOTS/panel.png"
    orca plugin shot "$KEY" --status-bar --out "$SHOTS/status.png" --json >/dev/null && echo "$SHOTS/status.png"
    ;;
  *) sed -n 2,14p "$0"; exit 1 ;;
esac
