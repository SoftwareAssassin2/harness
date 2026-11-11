# The reports and change log agents write into a ticket's work folder,
# data/projects/<project>/work/<KEY> (ASS-181), through work:write and
# work:append — from the Mac or, through the forwarder, from a ticket
# variation's VM, the content on stdin.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../work.bash"
#   work_file <command> <project> <ticket-key> <variation|-> <name>   # the file, by absolute path
#   work_path <command> <project> <ticket-key> <variation|-> <file-name>   # the file, by its exact name (ASS-180; see below)
#
# A report is the variation's own: <name> with -<variation> before its
# extension (execution-plan.md for A: execution-plan-A.md), so variations
# never write each other's; "-" is the ticket's own <name> (the Mac's alone:
# the forwarder holds a VM to its variation). One name per file, no fallback
# to the unsuffixed one. <name> is taken only when plain —
# ^[a-z0-9][a-z0-9-]*\.(md|txt|log|json)$ — and neither it nor the
# variation's name one the harness writes itself (WORK_MANAGED), and the
# file, symlinks resolved, is in the work folder, which must exist (it is
# made at dispatch). <ticket-key> may be a run's folder instead, run-<id> (a
# health or memory check's, ASS-182: its agent writes only through agent.sh).
# Fails, naming <command>, otherwise. PROJECTS_DIR
# overrides the projects folder, used by tests.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/json-file.bash"
work_projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../data/projects}"

# The files in a work folder other commands write, under locks of their own: shell patterns.
# operator-review-<V>.md is the operator's notes from Human Review rejections (ticket:human-review, ASS-228).
# ci-checks-results-<V>.md and ci-checks-baseline-<V>.json are ci-checks:verify's (ASS-249).
# numbered-files-check-<V>.md is merge-request:check-numbered-files' (ASS-385).
# split-proposal.json is ticket:propose-split's, the proposal ticket:apply-split creates its tickets from (ASS-252).
WORK_MANAGED=(ticket.json '*.lock' acceptance-criteria.json questions-and-answers.json requirements-history.jsonl
  'demo-plan-*' 'automated-tests-*' 'automated-test-results-*' jira-comments.json collaboration.json 'operator-review*' 'ci-checks-*' 'numbered-files-check-*' split-proposal.json)

# work_path <command> <project> <ticket-key> <variation|-> <file-name> — the
# file's absolute path, by its exact name (no <name>-<variation> suffixing),
# with the segment, work-folder-exists and symlink-escape checks work_file
# makes: for the harness's own commands that write a WORK_MANAGED file (ASS-180
# automated-tests:record, ticket:set-demo-plan) under the file's own lock.
work_path() {
  local command="$1" project="$2" key="$3" variation="$4" name="$5" file folder
  # A ticket's key in upper case; a run's folder (run-<id>, a health or memory check's: ASS-182) as named.
  [[ "$key" == run-* ]] || key="$(tr '[:lower:]' '[:upper:]' <<< "$key")"
  for pair in "project:$project" "ticket:$key" "variation:$variation"; do
    [[ "${pair#*:}" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid ${pair%%:*} '${pair#*:}'" >&2; return 1; }
  done
  folder="$(cd "$work_projects/$project/work/$key" 2>/dev/null && pwd -P)" || { echo "$command: $key has no work folder in $project" >&2; return 1; }
  file="$folder/$name"
  [[ ! -L "$file" ]] || [[ "$(readlink -f "$file")" == "$folder/"* ]] || { echo "$command: $file is not in $key's work folder" >&2; return 1; }
  printf '%s\n' "$file"
}

work_file() {
  local command="$1" project="$2" variation="$4" name="$5" file pattern
  [[ "$name" =~ ^[a-z0-9][a-z0-9-]*\.(md|txt|log|json)$ ]] || { echo "$command: invalid name '$name': a plain name, ^[a-z0-9][a-z0-9-]*\\.(md|txt|log|json)\$" >&2; return 1; }
  file="$name"
  [[ "$variation" == - ]] || file="${name%.*}-$variation.${name##*.}"
  for pattern in "${WORK_MANAGED[@]}"; do
    # shellcheck disable=SC2053 # the pattern is a glob
    [[ "$name" != $pattern && "$file" != $pattern ]] || { echo "$command: $file is the harness's own: not written" >&2; return 1; }
  done
  work_path "$command" "$project" "$3" "$variation" "$file"
}

# work_inputs <variation> — the files of a ticket's work folder that are the
# variation's own inputs, changed only through the harness's own write
# commands: automated-tests-<variation>.json (automated-tests:record) and
# demo-plan-<variation>.json (ticket:set-demo-plan). An allowlist, for
# ticket:wait-on and ticket:fix-landed (ASS-342): never a file the harness
# writes on its own while the ticket is blocked or waiting — ticket.json,
# *.lock, step outputs, change-log-<variation>.md (Blocked's notes),
# execution-plan-<variation>.md (ticket:plan-obstacle-fix) — nor another
# variation's.
work_inputs() { printf '%s\n' "automated-tests-$1.json" "demo-plan-$1.json"; }

# work_input_digests <command> <project> <ticket-key> <variation> — as JSON,
# { <name>: its SHA-256, or null while it is missing } for each of the
# variation's work_inputs; {} when the ticket has no work folder.
work_input_digests() {
  local name file digest digests='{}'
  while IFS= read -r name; do
    file="$(work_path "$1" "$2" "$3" "$4" "$name" 2>/dev/null)" || { echo '{}'; return 0; }
    digest=null
    [[ -f "$file" ]] && digest="\"$(shasum -a 256 < "$file" | cut -d' ' -f1)\""
    digests="$(jq -c --arg n "$name" --argjson d "$digest" '.[$n] = $d' <<< "$digests")"
  done < <(work_inputs "$4")
  printf '%s\n' "$digests"
}
