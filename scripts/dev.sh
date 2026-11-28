#!/bin/sh
# Development loop for the sidebar plugin, working around an Orca hash bug (seen in 1.4.254 and
# 1.4.268): approval hashes the folder without `.orca/`, the worker's start check hashes it with
# `.orca/`, so any `.orca/` present when Orca hot-reloads the folder fails "content hash mismatch"
# and Orca drops local.flow to pending (no sidebar). So `.orca/` never goes into this folder:
# `check` type-checks and tests a copy in a temporary folder. Never run `orca plugin types .` here.
# The Usage tab (src/usage-open.ts) writes `.orca/orca-flow/` into whatever workspace is focused, this
# one included: both copies below exclude every `.orca` (at any depth) and then fail if one got in.
#
# Orca (1.4.268) also ties a development plugin's approval to its exact files: any edit drops it to
# pending until it is approved again. So Orca never loads this worktree: `load` copies it to
# $DEV_DIR (default ~/.orca-flow/dev/flow) and approves that copy. Edits here change nothing in the
# sidebar until the next `load`.
#
# Exactly one Orca Flow may run (both bind Alt+1..9; two running error each other). `load` swaps
# to local.flow and goes back to the installed copy when local.flow fails; `off` goes back to it.
#
# The panel and editors load generated .js (scripts/build-frames.mjs), never .ts: Orca transpiles a frame's .ts under
# a 2000 ms timer that a busy cold start loses. `check` fails when that .js is stale; `load` regenerates it in the copy.
#
#   scripts/dev.sh check   generated frame JS fresh + types + tsc + tests (+ the cold-start check when Chrome is
#                          installed), in a temporary copy of this folder
#   scripts/dev.sh load    copy this folder to $DEV_DIR, regenerate the frame JS there, disable the installed copy,
#                          approve and (re)start local.flow from the copy, fall back on failure
#   scripts/dev.sh off     unload local.flow and run the installed copy again
#   scripts/dev.sh shot    screenshot the panel and status bar to $SHOTS (default /tmp/orca-sidebar-shots)
set -eu
cd "$(dirname "$0")/.."
KEY=local.flow
INSTALLED=cyucelen.flow
SHOTS=${SHOTS:-/tmp/orca-sidebar-shots}
DEV_DIR=${DEV_DIR:-$HOME/.orca-flow/dev/flow}
HERE=$(pwd)
# Fails when a `.orca` folder is anywhere in the copy $1 (see the hash bug above).
no_dot_orca() { if [ -n "$(find "$1" -name .orca -prune -print -quit)" ]; then echo "a .orca folder is in the copy $1: not loading it (Orca's content hash would not match)"; return 1; fi; }
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
    no_dot_orca "$tmp"
    cd "$tmp"
    node scripts/build-frames.mjs --check
    orca plugin types . --json >/dev/null
    # Erasable syntax and explicit type-only imports: what build-frames.mjs's type stripping needs to stay exact.
    npx -y -p typescript tsc -p . --noEmit --erasableSyntaxOnly --verbatimModuleSyntax
    # Show the summaries, but fail the script when any test fails. A throwaway HOME: src/writer.ts reads the Claude
    # profile Orca selected (~/Library/Application Support/orca/claude-profiles/selected-host), which would override
    # the writer tests' own config dir on a machine that has one selected.
    mkdir -p "$tmp/.home"
    out=$(HOME="$tmp/.home" orca plugin test . 2>&1) || { echo "$out" | grep -E '✖|Error|expected|actual' | head -20; echo 'plugin tests FAILED'; exit 1; }
    echo "$out" | tail -1
    out=$(node --test test/*.test.mjs 2>&1) || { echo "$out" | grep -E '✖|Error' | head -20; echo 'orca-flow tests FAILED'; exit 1; }
    echo "$out" | grep -E '(pass|fail) [0-9]'
    if [ -x "${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}" ]; then
      out=$(node scripts/cold-start-check.mjs 2>&1) || { echo "$out" | grep -E 'FAIL|failed'; echo 'cold-start check FAILED'; exit 1; }
      echo "$out" | tail -1
    else
      echo 'cold-start check skipped: no Chrome (set CHROME to its binary)'
    fi
    ;;
  load)
    # Both copies bind Alt+1..9, and Orca errors both when they run at once: the installed copy
    # goes off first, and comes back when local.flow does not reach running.
    orca plugin dev unload "$HERE" --json >/dev/null 2>&1 || true
    mkdir -p "$DEV_DIR"
    rsync -a --delete --exclude .git --exclude .orca --exclude node_modules ./ "$DEV_DIR/"
    rm -rf "$DEV_DIR/.orca" # rsync leaves an excluded folder in the destination alone
    # The copy runs fresh frame JS even when this folder's is stale; say so, since a commit needs it here too.
    node "$DEV_DIR/scripts/build-frames.mjs" >/dev/null
    node scripts/build-frames.mjs --check >/dev/null 2>&1 || echo 'note: the generated frame JS here is stale; run node scripts/build-frames.mjs before committing'
    no_dot_orca "$DEV_DIR"
    fp=$(orca plugin dev load "$DEV_DIR" --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('data',{}).get('approvalFingerprint',''))")
    # `dev load` writes .orca/ typings into the folder: remove them before the worker starts.
    rm -rf "$DEV_DIR/.orca"
    orca plugin disable "$INSTALLED" --json >/dev/null 2>&1 || true
    orca plugin disable "$KEY" --json >/dev/null 2>&1 || true
    enable "$KEY" "$fp" || true
    sleep 6
    if [ "$(status $KEY)" = running ]; then
      echo "$KEY: running from $DEV_DIR at $(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . || echo '+changes') ($INSTALLED disabled)"
    else
      echo "$KEY: $(status $KEY), not running; going back to $INSTALLED"
      orca plugin disable "$KEY" --json >/dev/null 2>&1 || true
      restore_installed
      exit 1
    fi
    ;;
  off)
    orca plugin disable "$KEY" --json >/dev/null 2>&1 || true
    orca plugin dev unload "$DEV_DIR" --json >/dev/null 2>&1 || true
    orca plugin dev unload "$HERE" --json >/dev/null 2>&1 || true
    restore_installed
    ;;
  shot)
    mkdir -p "$SHOTS"
    orca plugin open "$KEY" --panel orca-flow --json >/dev/null
    sleep 3
    orca plugin shot "$KEY" --panel orca-flow --out "$SHOTS/panel.png" --json >/dev/null && echo "$SHOTS/panel.png"
    orca plugin shot "$KEY" --status-bar --out "$SHOTS/status.png" --json >/dev/null && echo "$SHOTS/status.png"
    ;;
  *) sed -n 2,26p "$0"; exit 1 ;;
esac
