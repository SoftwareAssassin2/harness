#!/usr/bin/env bash
# Description: Whether a failure Blocked attributed to a project's code is on its latest master, from its master CI — project:check-on-master <project> <repository-url|-> <job|-> [<run-id>].
set -euo pipefail

# The operator's decision box (ASS-163, 2026-10-27), made deterministic: a
# project bug is raised only for a failure on the latest master — never for
# one seen only in our VM or on a branch. grouped-blocked runs it when
# Classify puts a block's cause in the project's own code, with the failing
# check Troubleshoot named: the repository's forge url and its CI job.
# The repository's master — the work-space branch project.json gives it,
# master when it lists none — is asked read-only, through the forge's CLI as
# control asks it (src/control/reverts.js): `glab api` on any https host but
# github.com (--hostname), `gh api` there. Of the latest 20 finished master
# pipelines (GitHub: completed workflow runs), the newest that ran the job is
# read, its retried attempts aside:
# - failed there (GitLab failed, GitHub failure): present, exit 0 — a bug
#   may be raised in the project's ticket system, this the evidence;
# - passed (success): absent, exit 3 — our environment or access, not the
#   project's code: nothing raised; the ticket's plan grows to fix it;
# - anything else (no pipeline ran the job, canceled, skipped, timed out),
#   nothing named, a url on no forge, or the forge not answering: unknown,
#   exit 4 — not proven, so no bug either; { ai-feedback-short,
#   ai-feedback-long } added for Blocked for Human, telling the operator what
#   to check (Have AI Try Again repeats the check). (ASS-492) With no
#   repository or no job named there is nothing to check, so the feedback
#   prints no blank placeholders ("job - on -'s master"): it says
#   Troubleshoot named no failing check and gives, from the Blocked run
#   <run-id> (optional; its structured-output in assignments.json),
#   Troubleshoot's summary and root cause, Classify's reasoning and any
#   missing change it named.
# The job's result is the evidence; the assertion inside it is not matched.
# A rerun on a fresh checkout of origin/master (AC1's fallback) is not made
# here: it needs the ticket's VM and the project's test environment.
# On the harness project a project issue is the harness's own backlog (as
# facts.js fixTicketIn has it): nothing checked, exit 2, raised as before.
# Prints { on-master: present|absent|unknown|not-checked, master-evidence }.
# Fails (1) on a bad project or usage.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../harness-project.bash"

command=project:check-on-master
[[ $# -eq 3 || $# -eq 4 ]] || { echo "usage: $command <project> <repository-url|-> <job|-> [<run-id>]" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
project="$1" url="${2%/}" job="$3" run_id="${4:-}"
url="${url%.git}"
said() { jq -nc --arg o "$1" --arg e "$2" '{ "on-master": $o, "master-evidence": $e }'; }

if is_harness_project "$project"; then
  said not-checked "$project is the harness project: its project issues are the harness's own backlog, raised without a master check"; exit 2
fi

unknown() {
  jq -nc --arg e "$1" --arg u "${url:--}" --arg j "${job:--}" '{ "on-master": "unknown", "master-evidence": $e,
    "ai-feedback-short": "Not proven on master: no project bug raised",
    "ai-feedback-long": "Blocked put the failure in the project'"'"'s code, but the latest master could not show it: \($e). Only a failure on the latest master is raised as a project bug. Check job \($j) on \($u)'"'"'s master: failing there, raise the bug in the project'"'"'s ticket system and have the ticket wait on it; passing, the cause is our environment or access: fix that, then mark the ticket Resolved (or Have AI Try Again to repeat the check)." }'
  echo "$command: $1" >&2; exit 4
}
# nothing_named — (ASS-492) unknown with nothing to check: the run's own finding said instead of blank placeholders.
nothing_named() {
  local e="Troubleshoot named no failing repository and CI job to check" found='{}'
  if [[ -n "$run_id" && "$run_id" != - ]]; then
    found="$(jq -c --arg id "$run_id" 'first(.["transient-state-engines"] // [] | .[] | select(.id == $id) | .["structured-output"] // {}) // {}' \
      "${ASSIGNMENTS_FILE:-$here/../../../data/assignments.json}" 2>/dev/null)" || found='{}'
    [[ -n "$found" ]] || found='{}'
  fi
  jq -nc --arg e "$e" --argjson f "$found" 'def said($x): ($x // "") | if type == "string" then gsub("^\\s+|\\s+$"; "") else tostring end;
    { "on-master": "unknown", "master-evidence": $e,
      "ai-feedback-short": "Not proven on master: Troubleshoot named no failing check",
      "ai-feedback-long": ([
        "Blocked put the cause in the project'"'"'s code, but Troubleshoot named no failing check (no repository and CI job), so the latest master was not checked and no project bug was raised.",
        (if said($f.summary) != "" then "Summary: \(said($f.summary))" else empty end),
        (if said($f["root-cause"]) != "" then "Root cause: \(said($f["root-cause"]))" else empty end),
        (if said($f.reasoning) != "" then "Classify: \(said($f.reasoning))" else empty end),
        (if said($f["missing-change"]) != "" then "Missing change: \(said($f["missing-change"]))\(if said($f["missing-change-repository"]) != "" then " in \(said($f["missing-change-repository"]))" else "" end)" else empty end),
        "Decide where the fix goes: a change this ticket still needs, plan it (ticket:add-merge-request) and move the ticket back to Build; a bug on the project'"'"'s master, raise it and have the ticket wait on it; our environment or access, fix that and mark the ticket Resolved (or Have AI Try Again to repeat Blocked)."
      ] | join("\n")) }'
  echo "$command: $e" >&2; exit 4
}
[[ -n "$url" && "$url" != - && -n "$job" && "$job" != - ]] || nothing_named

branch="$(jq -r --arg u "$url" 'def norm: ascii_downcase | sub("\\.git$"; "") | sub("/$"; "");
  first(.repositories[]? | select((.url // "" | norm) == ($u | norm)) | .["work-space"].branch // empty) // "master"' "$projects/$project/project.json")"

err="$(mktemp)" why="$(mktemp)"; trap 'rm -f "$err" "$why"' EXIT
# ask <tool> <args…> — the forge's JSON answer; fails, its complaint in $why, when it gives none.
ask() {
  local out
  out="$("$@" 2>"$err")" && jq -e . <<< "$out" >/dev/null 2>&1 && { printf '%s' "$out"; return 0; }
  echo "could not ask $1: $(cat "$err" - <<< "${out:-}" | grep -m 1 . || echo 'no answer')" > "$why"; return 1
}

# pipelines: one "<id>\t<sha>\t<url>" line each, newest first; jobs_of <id>: [{ name, result, url }].
case "$url" in
  https://github.com/*)
    path="${url#https://github.com/}"
    pipelines="$(ask gh api "repos/$path/actions/runs?branch=$branch&status=completed&per_page=20" | jq -r '.workflow_runs[]? | [.id, .head_sha, .html_url] | @tsv')" || unknown "$(cat "$why")"
    jobs_of() { ask gh api "repos/$path/actions/runs/$1/jobs?per_page=100" | jq -c '[.jobs[]? | { name, result: .conclusion, url: .html_url }]'; } ;;
  https://*)
    rest="${url#https://}" host="${rest%%/*}" path="${rest#*/}"
    id="$(jq -rn --arg p "$path" '$p | @uri')"
    pipelines="$(ask glab api "projects/$id/pipelines?ref=$branch&scope=finished&per_page=20" --hostname "$host" | jq -r '.[]? | [.id, .sha, .web_url] | @tsv')" || unknown "$(cat "$why")"
    jobs_of() { ask glab api "projects/$id/pipelines/$1/jobs?per_page=100" --hostname "$host" | jq -c '[.[]? | { name, result: .status, url: .web_url }]'; } ;;
  *) unknown "$url is not an https url on GitHub or GitLab" ;;
esac

while IFS=$'\t' read -r pipeline sha at; do
  [[ -n "$pipeline" ]] || continue
  found="$(jobs_of "$pipeline")" || unknown "$(cat "$why")"
  found="$(jq -c --arg j "$job" 'first(.[] | select(.name == $j)) // empty' <<< "$found")"
  [[ -n "$found" ]] || continue
  result="$(jq -r '.result // "none"' <<< "$found")"
  evidence="$url $branch: job $job $result — $(jq -r '.url // "-"' <<< "$found"), pipeline $at at $sha"
  case "$result" in
    failed|failure) said present "$evidence"; exit 0 ;;
    success) said absent "$evidence"; exit 3 ;;
    *) unknown "$evidence" ;;
  esac
done <<< "$pipelines"
unknown "no finished $branch pipeline of the last 20 ran job $job on $url"
