#!/usr/bin/env bash
# Description: Check the ticket's Open merge requests' titles and descriptions, and wait for their pipelines' pre-stage jobs — merge-request:check-details <project> <ticket-key> <variation>.
set -euo pipefail

# The grouped/v2 engines' Check Merge Request Details (ASS-219), on a timer
# after Update Merge Request Details. For each Open one, as recorded:
#   - its title, its draft prefix left off, is in the project's format
#     (merge-request-title.bash: project.json's "merge-request-title");
#   - its description names every commit on its branch: each subject, its
#     trailing (KEY) left off, found in it case aside. On GitHub a subject
#     over ~70 characters is cut short in .messageHeadline and ended with
#     "…", its remainder leading .messageBody behind another "…": the full
#     subject is rebuilt from both, each "…" left off, before the match;
#   - on GitLab, its head pipeline's .pre jobs (e.g. an mr-title lint) have
#     finished, none failed (but an allowed failure). No head pipeline, no
#     .pre job, or GitHub: nothing to wait for.
# Prints { "status": "failed" } when any check failed, writing what failed —
# a failed job with the end of its log — to the ticket's
# merge-request-details-check-<variation>.md for the agent sent back to fix
# it; else { "status": "waiting" } while a .pre job is unfinished; else
# { "status": "passed" }, that file removed. Exits 0 when the check ran;
# fails when a forge call fails, the format is unknown, or the variation has
# no merge request (but a fast-tracked ticket's, which passes).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-request-title.bash"

[[ $# -eq 3 ]] || { echo "usage: merge-request:check-details <project> <ticket-key> <variation>" >&2; exit 1; }
command=merge-request:check-details key="$(upper "$2")"
format="$(title_format "$command" "$projects/$1/project.json")"
load_merge_requests "$command" "$1" "$key" "$3"
report="$projects/$1/work/$key/merge-request-details-check-$3.md"
WAITING='["created", "pending", "running", "waiting_for_resource", "preparing", "scheduled"]'

failures="" waiting=false
for i in $(jq -r 'to_entries[] | select(.value.status == "Open" and .value.key != null) | .key' <<< "$MRS"); do
  name="$(mr_name "$i")" jobs='[]'
  IFS=$'\t' read -r url iid _ < <(mr_at "$i")
  if on_github "$url"; then
    mr="$(gh_run "$command" pr view "$iid" --repo "$(path_of "$url")" --json title,body,commits | jq -c 'def full_subject:
      .messageHeadline as $h
      | if ($h | test("…$")) then ($h | sub("…$"; "")) + (((.messageBody // "") | split("\n") | .[0] // "") | sub("^…"; "")) else $h end;
      { title, description: .body, commits: [.commits[] | full_subject] }')"
  else
    mr="$(lab "$command" "$url" "/merge_requests/$iid" | jq -c '{ title, description, pipeline: .head_pipeline.id }')"
    mr="$(lab "$command" "$url" "/merge_requests/$iid/commits?per_page=100" | jq -c --argjson mr "$mr" '$mr + { commits: [.[].title] }')"
    pipeline="$(jq -r '.pipeline // empty' <<< "$mr")"
    [[ -z "$pipeline" ]] || jobs="$(lab "$command" "$url" "/pipelines/$pipeline/jobs?per_page=100" | jq -c '[.[] | select(.stage == ".pre")]')"
  fi
  title="$(jq -r .title <<< "$mr")"
  title_fits "$format" "$key" "$title" || failures+=$'\n'"## $name: its title \"$title\" is not $(title_rule "$format")"$'\n'
  missing="$(jq -r '(.description // "" | ascii_downcase) as $d | .commits[] | sub("\\s*\\([A-Z][A-Z0-9_]*-[0-9]+\\)\\s*$"; "") | select(ascii_downcase as $c | $d | contains($c) | not) | "- \(.)"' <<< "$mr")"
  [[ -z "$missing" ]] || failures+=$'\n'"## $name: its description does not name these commits on its branch (list each subject verbatim)"$'\n'"$missing"$'\n'
  jq -e --argjson w "$WAITING" 'any(.[]; .status | IN($w[]))' <<< "$jobs" > /dev/null && waiting=true
  while IFS=$'\t' read -r job job_name; do
    log="$(lab "$command" "$url" "/jobs/$job/trace" | tail -n 60)"
    failures+=$'\n'"## $name: its pipeline's .pre job $job_name failed"$'\n\n```\n'"$log"$'\n```\n'
  done < <(jq -r '.[] | select(.status == "failed" and (.allow_failure | not)) | [.id, .name] | @tsv' <<< "$jobs")
done

if [[ -n "$failures" ]]; then
  mkdir -p "${report%/*}"
  printf '# Merge request details check — %s %s, %s\n%s' "$key" "$3" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$failures" | replace_file "$report"
  jq -nc '{ status: "failed" }'
elif [[ "$waiting" == true ]]; then jq -nc '{ status: "waiting" }'
else rm -f "$report"; jq -nc '{ status: "passed" }'; fi
