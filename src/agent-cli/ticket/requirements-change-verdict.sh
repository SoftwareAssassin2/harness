#!/usr/bin/env bash
# Description: Decide a requirements-changed workflow's verdict from its per-criterion judgements — ticket:requirements-change-verdict <project> <ticket-key> <variation> <run-id>.
set -euo pipefail

# ASS-79 AC2/AC3: the run (grouped-requirements-changed's, after its judging
# step) holds the judge's verdicts in its structured-output, criteria: [{
# criteria-number, passes, reason }]. Every acceptance criterion the
# variation now has must have a verdict that passes: then exit 0 (the
# variation goes back to the step it was in) and any requirements-change-
# reason.md left by an earlier change is removed. Otherwise the failing ones
# — a criterion with no verdict fails as not judged — are written to the
# ticket folder's requirements-change-reason.md, which Root Cause Analysis
# starts from, and exit 3. Exit 1 on an unknown run or variation.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"
assignments="${ASSIGNMENTS_FILE:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/assignments.json}"

[[ $# -eq 4 ]] || { echo "usage: ticket:requirements-change-verdict <project> <ticket-key> <variation> <run-id>" >&2; exit 1; }
verdicts="$(jq -c --arg id "$4" 'first(.["transient-state-engines"] // [] | .[] | select(.id == $id)) // error("no run \($id)") | .["structured-output"].criteria // []' "$assignments" 2>&1)" \
  || { echo "ticket:requirements-change-verdict: ${verdicts#jq: error (at *): }" >&2; exit 1; }
found="$(jq -c --arg key "$2" --arg name "$3" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
  | { key, criteria: (first(.variations // [] | .[] | select(.name == $name and (.["is-deleted"] | not))) | .["acceptance-criteria"] // []) }' "$(sprint_file ticket:requirements-change-verdict "$1")")"
[[ -n "$found" ]] || { echo "ticket:requirements-change-verdict: no $2 variation $3" >&2; exit 1; }
reason="$projects/$1/work/$(jq -r .key <<< "$found")/requirements-change-reason.md"

failing="$(jq -r --argjson verdicts "$verdicts" '.criteria[] | .["criteria-number"] as $n
  | (first($verdicts[] | select(.["criteria-number"] == $n)) // { passes: false, reason: "not judged" }) as $v
  | select($v.passes != true) | "- AC\($n): \(.description) — fails: \($v.reason // "no reason given")"' <<< "$found")"
if [[ -z "$failing" ]]; then
  rm -f "$reason"
  echo "$2.$3: every revised criterion passes"; exit 0
fi
mkdir -p "$(dirname "$reason")"
printf '# Requirements change: the work no longer meets these criteria\n\n%s\n' "$failing" | replace_file "$reason"
echo "$2.$3: fails the revised criteria — see $reason"
exit 3
