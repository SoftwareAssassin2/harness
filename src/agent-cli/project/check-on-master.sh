#!/usr/bin/env bash
# Description: Whether a failure Blocked attributed to a project's code is on its latest master, from its master CI — project:check-on-master <project> <repository-url|-> <job|->.
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
#   to check (Have AI Try Again repeats the check).
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
[[ $# -eq 3 ]] || { echo "usage: $command <project> <repository-url|-> <job|->" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
project="$1" url="${2%/}" job="$3"
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
[[ -n "$url" && "$url" != - && -n "$job" && "$job" != - ]] || unknown "Troubleshoot named no failing repository and CI job to check"

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
