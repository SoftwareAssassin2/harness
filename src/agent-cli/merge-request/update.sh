#!/usr/bin/env bash
# Description: Set one of the ticket's merge requests' description (on stdin, or from a file) and title on its forge — merge-request:update <project> <ticket-key> <variation> <id> - [<title>] | <id> --from <file> [<title>].
set -euo pipefail

# ASS-238: how a VM agent edits a merge request — on the host, with the
# host's glab or gh login. <id> is a planned merge request's id, one already
# created. The description, on stdin, replaces its description; <title>, when
# given, its title. On GitLab a draft stays a draft (its "Draft: " prefix is
# kept on a new title), and a title that changed starts a new merge request
# pipeline, so its pre-stage jobs (mr-title) check the new one: a pipeline
# that cannot be started is said, not failed on. Prints its url.
# ASS-592: --from <file> in place of "-" reads the description from that file,
# for a host agent whose agent.sh line can have no heredoc or redirect. Only on
# the Mac: a VM keeps "-" (the forwarder lets only "-" through, ASS-182).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

usage="usage: merge-request:update <project> <ticket-key> <variation> <id> - [<title>] | merge-request:update <project> <ticket-key> <variation> <id> --from <file> [<title>]"
command=merge-request:update key="$(upper "${2-}")" has_title=false title=
if [[ ( $# -eq 5 || $# -eq 6 ) && "$5" == - ]]; then
  [[ $# -eq 6 ]] && has_title=true title="$6"
  description="$(cat)"
  [[ -n "${description//[[:space:]]/}" ]] || { echo "$command: nothing on stdin" >&2; exit 1; }
elif [[ ( $# -eq 6 || $# -eq 7 ) && "$5" == --from ]]; then
  [[ $# -eq 7 ]] && has_title=true title="$7"
  [[ -f "$6" && -r "$6" ]] || { echo "$command: no file $6" >&2; exit 1; }
  description="$(cat "$6")"
  [[ -n "${description//[[:space:]]/}" ]] || { echo "$command: $6 is empty" >&2; exit 1; }
else echo "$usage" >&2; exit 1; fi
load_merge_requests "$command" "$1" "$key" "$3"
i="$(mr_by_id "$command" "$key" "$3" "$4")"
IFS=$'\t' read -r url iid _ < <(mr_at "$i")

if on_github "$url"; then
  title_args=(); [[ "$has_title" == true ]] && title_args=(--title "$title")
  gh_run "$command" pr edit "$iid" --repo "$(path_of "$url")" --body "$description" ${title_args[@]+"${title_args[@]}"}
  exit 0
fi
fields=(-f "description=$description") changed=false
if [[ "$has_title" == true ]]; then
  was="$(lab "$command" "$url" "/merge_requests/$iid")"
  if [[ "$(jq -r .draft <<< "$was")" == true ]] && ! grep -qiE '^(\[draft\]|\(draft\)|draft:)' <<< "$title"; then title="Draft: $title"; fi
  [[ "$title" == "$(jq -r .title <<< "$was")" ]] || changed=true
  fields+=(-f "title=$title")
fi
lab "$command" "$url" "/merge_requests/$iid" -X PUT "${fields[@]}" | jq -r .web_url
if [[ "$changed" == true ]]; then
  lab "$command" "$url" "/merge_requests/$iid/pipelines" -X POST >/dev/null || echo "$command: could not start a new merge request pipeline for !$iid" >&2
fi
