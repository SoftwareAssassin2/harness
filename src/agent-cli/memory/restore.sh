#!/usr/bin/env bash
# Description: Restore a project's Hindsight memory from a backup — memory:restore <project> [<archive>]; the latest daily backup by default, asking first.
set -euo pipefail
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/transfer.bash"

# The archive: a file in the project's hindsight-backups/<project>/ or a
# path; without one, the latest daily backup (see transfer.bash). In order:
#  1. refused while any of the project's agents has an assignment
#     (assignments.json; ASSIGNMENTS_FILE overrides it, for tests): they
#     retain to and recall from the bank being replaced;
#  2. asks on stderr, reading the answer from stdin — y or yes goes ahead,
#     anything else changes nothing; the agents are checked again after;
#  3. the current bank exported to pre-restore-<UTC time>.zip beside the
#     backups (never pruned), so a restore can itself be undone — failing
#     that, nothing is deleted; a project with no bank (one a failed restore
#     deleted) has none to export, and pre-restore is null;
#  4. the bank deleted, then recreated from the archive by Hindsight's
#     transfer import in restore mode — which makes the bank itself (it must
#     not exist) and re-embeds the memories without the LLM.
# Prints { project, archive, pre-restore, imported } — imported the import's
# per-component counts as Hindsight reports them.
[[ $# -eq 1 || $# -eq 2 ]] || { echo "usage: memory:restore <project> [<archive>]" >&2; exit 1; }
project="$1"
memory_config memory:restore "$project"
folder="$backups_root/$project"
assignments="${ASSIGNMENTS_FILE:-$here/../../../data/assignments.json}"

if [[ $# -eq 2 ]]; then
  archive="$2"
  [[ "$archive" == */* ]] || archive="$folder/$archive"
  [[ -f "$archive" ]] || { echo "memory:restore: no archive $archive" >&2; exit 1; }
else
  latest="$(ls "$folder" 2>/dev/null | grep -E "$backup_name" | sort | tail -n 1 || true)"
  [[ -n "$latest" ]] || { echo "memory:restore: $project has no backups in $folder" >&2; exit 1; }
  archive="$folder/$latest"
fi

refuse_while_agents_run() {
  local names
  names="$(jq -r --arg p "$project" '[.assignments[]? | select(.project == $p) | .["agent-name"]] | join(", ")' "$assignments" 2>/dev/null || true)"
  [[ -z "$names" ]] || { echo "memory:restore: $project's agents are running ($names); restore its memory once they have stopped" >&2; exit 1; }
}
refuse_while_agents_run
printf "Restore %s's memory from %s? Its bank is deleted and recreated from it; the current bank is exported first. [y/N] " "$project" "$archive" >&2
answer=""
read -r answer || true
[[ "$answer" =~ ^([yY]|[yY][eE][sS])$ ]] || { echo "memory:restore: not confirmed; $project's memory is unchanged" >&2; exit 1; }
refuse_while_agents_run

pre="$folder/pre-restore-$(utc_stamp).zip" exported=0
memory_export memory:restore "$project" "$pre" || exported=$?
if [[ $exported -eq 0 ]]; then
  curl -fsS --max-time 30 -o /dev/null -X DELETE "http://127.0.0.1:$port/v1/default/banks/$project" \
    || { echo "memory:restore: $project's Hindsight would not delete the bank $project; its memory is unchanged" >&2; exit 1; }
  lost="memory:restore: $project's bank was deleted but not restored; what it held is in $pre — memory:restore $project $pre puts it back"
elif [[ $exported -eq 2 ]]; then
  pre="" lost="memory:restore: $project still has no bank"    # nothing to keep or delete: a failed restore's, say
else
  echo "memory:restore: $project's memory is unchanged" >&2; exit 1
fi
operation="$(curl -fsS --max-time 600 -X POST -F "file=@$archive;type=application/zip" \
  "http://127.0.0.1:$port/v1/default/banks/$project/transfer/import?mode=restore&target_bank_id=$project" | jq -r .operation_id)" \
  || { echo "memory:restore: $project's Hindsight would not import $archive" >&2; echo "$lost" >&2; exit 1; }
imported="$(transfer_wait memory:restore "$project" "$operation")" || { echo "$lost" >&2; exit 1; }

jq -n --arg p "$project" --arg a "$archive" --arg pre "$pre" --argjson imported "$imported" \
  '{ project: $p, archive: $a, "pre-restore": (if $pre == "" then null else $pre end), imported: $imported }'
