#!/bin/sh
# Live fixture for waking a sleeping coordinator, away from the real ones in ~/orca/coordinators:
# a copy of this folder whose COORDINATOR_HOME is a throwaway folder, loaded as the local.flow dev
# plugin (the installed plugin keeps running on the real coordinators, untouched).
#
#   scripts/resume-fixture.sh up              copy to $FIXTURE_ROOT/plugin, point it at $FIXTURE_ROOT/coordinators, load it
#   NO_PREFLIGHT=1 scripts/resume-fixture.sh up   the same, with no transcript preflight (exercises the post-resume exit check)
#   FIXTURE_WAKE=<name> scripts/resume-fixture.sh up   the panel clicks that coordinator once loaded (for `shot`)
#   scripts/resume-fixture.sh create <name>   create a coordinator there (first launch and binding)
#   scripts/resume-fixture.sh click <name>    what clicking it does (sidebar.openCoordinator)
#   scripts/resume-fixture.sh fresh <name>    Start new conversation, as the Sessions menu does
#   scripts/resume-fixture.sh down            unload the dev copy; delete $FIXTURE_ROOT yourself after closing its terminals
set -eu
cd "$(dirname "$0")/.."
ROOT=${FIXTURE_ROOT:-/tmp/orca-flow-resume-fixture}
COPY=$ROOT/plugin
HOMEDIR=$ROOT/coordinators
req() { orca plugin dev request local.flow "$1" --data "$2" --timeout-ms 120000 --json; }

case "${1:-}" in
  up)
    case "$HOMEDIR" in "$HOME/orca/coordinators"*) echo 'refusing: the fixture must live outside ~/orca/coordinators'; exit 1 ;; esac
    mkdir -p "$HOMEDIR" "$COPY"
    rsync -a --delete --exclude .git --exclude .orca --exclude node_modules ./ "$COPY/"
    sed -i '' "s|^export const COORDINATOR_HOME = .*|export const COORDINATOR_HOME = '$HOMEDIR'|" "$COPY/src/coordinators.ts"
    grep -q "COORDINATOR_HOME = '$HOMEDIR'" "$COPY/src/coordinators.ts" || { echo 'could not point the copy at the fixture home'; exit 1; }
    # The installed copy owns Alt+1..9; the same keybindings in a second plugin error both.
    python3 -c "import json,sys; p=sys.argv[1]; m=json.load(open(p)); m['contributes'].pop('keybindings',None); json.dump(m,open(p,'w'),indent=2)" "$COPY/orca-plugin.json"
    if [ -n "${NO_PREFLIGHT:-}" ]; then
      sed -i '' "s|^      const verdict = conversationSaved(.*|      const verdict = null as boolean \| null|" "$COPY/src/worker.ts"
      grep -q 'const verdict = null' "$COPY/src/worker.ts" || { echo 'could not turn the preflight off'; exit 1; }
    fi
    # FIXTURE_WAKE=<name>: the panel runs a click on that coordinator once it loads (wake), so
    # `orca plugin shot` can show its recovery menu without driving Orca's window.
    if [ -n "${FIXTURE_WAKE:-}" ]; then
      printf "\nsetTimeout(() => void wake('%s'), 3000)\n" "$FIXTURE_WAKE" >> "$COPY/src/panel/app.ts"
    fi
    "$COPY/scripts/dev.sh" load
    ;;
  create) req sidebar.createCoordinator "{\"name\":\"$2\",\"look\":null}" ;;
  click) req sidebar.openCoordinator "{\"key\":\"$2\"}" ;;
  fresh) req sidebar.coordinatorSessions "{\"key\":\"$2\",\"action\":\"fresh\",\"agent\":\"claude\"}" ;;
  down)
    orca plugin disable local.flow --json >/dev/null 2>&1 || true
    orca plugin dev unload "$COPY" --json >/dev/null && echo "unloaded $COPY"
    ;;
  *) sed -n 2,14p "$0"; exit 1 ;;
esac
