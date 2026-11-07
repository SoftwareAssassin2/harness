# A ticket's chat on its screen (ASS-35): data/projects/<project>/work/<KEY>/
# collaboration.json, { session-id, briefed, turns, raised } — the Claude
# session to resume, the snapshot of what its last briefing told it, its turns
# with what each cost (collaboration:add-spend, ASS-216), and the problems it
# last raised (ASS-36). One from before ASS-216 has spend-usd, an undated total,
# instead, until project:mark-billing makes it a turn. PROJECTS_DIR overrides the projects folder, used by tests.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

# update_collaboration <command> <project> <ticket-key> [jq options…] '<filter>'
# — the ticket's collaboration.json rewritten by the filter, made first (no
# session, nothing briefed, no turns) when missing — never over one there.
# Fails, writing nothing, on a name that could climb out of the projects folder
# or a project that is not there.
update_collaboration() {
  local command="$1" project="$2" ticket="$3" dir
  shift 3
  [[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; return 1; }
  [[ "$ticket" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid ticket '$ticket'" >&2; return 1; }
  [[ -d "$projects/$project" ]] || { echo "$command: no project $project" >&2; return 1; }
  dir="$projects/$project/work/$ticket"
  mkdir -p "$dir"
  ( set -o noclobber; printf '{\n    "session-id": null,\n    "briefed": null,\n    "turns": []\n}\n' > "$dir/collaboration.json" ) 2>/dev/null || true
  update_json "$dir/collaboration.json" "$@"
}
