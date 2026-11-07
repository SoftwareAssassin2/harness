#!/usr/bin/env bash
# Description: Whether a golden rebuild ticket's image build has settled, for v2's Await the Golden Build step — vm:golden-ready <project> <ticket-key>; prints JSON.
set -euo pipefail

# ASS-157: the engine waits for a rebuild's detached build, not the Test
# agent (a headless agent cannot sleep it out). The ticket, in <project>'s
# active sprint, is a golden rebuild when fast-tracked ("fast-track": true)
# and titled "Rebuild golden-<image's project>"; its image is read with
# vm:golden-status and its JSON printed. Exits:
#   0  building — no exit of the step matches, so its timer asks again; the
#      one reading that is not a failure (control backs off, then Blocks, a
#      script step whose exit code is not 0 and leaves it where it is)
#   2  current, 3 failed — settled: Test judges it
#   4  not a golden rebuild — prints { "golden-rebuild": false }; let through
#   1  the ticket is not in the sprint, or vm:golden-status fails
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"

[[ $# -eq 2 ]] || { echo "usage: vm:golden-ready <project> <ticket-key>" >&2; exit 1; }
image="$(jq -r --arg key "$2" '
  first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_upcase == ($key | ascii_upcase)))
  | if .["fast-track"] == true and ((.title // "") | test("^Rebuild golden-[A-Za-z0-9_-]+$")) then .title | ltrimstr("Rebuild golden-") else "-" end' \
  "$(sprint_file vm:golden-ready "$1")")"
[[ -n "$image" ]] || { echo "vm:golden-ready: no $2 in $1's active sprint" >&2; exit 1; }
[[ "$image" != - ]] || { echo '{"golden-rebuild":false}'; exit 4; }
reading="$("$here/../../../agent.sh" vm:golden-status "$image")"
echo "$reading"
case "$(jq -r .status <<< "$reading")" in
  building) exit 0 ;;
  current) exit 2 ;;
  *) exit 3 ;;
esac
