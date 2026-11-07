#!/usr/bin/env bash
# Description: Move a run's folder into its ticket's — ticket:adopt-run-folder <project> <ticket-key> <run-id>.
set -euo pipefail

# A run's work without a ticket goes to its root run's folder,
# data/projects/<project>/work/run-<root id> (see prompt.bash work_folder): a health
# check's reports wait there for the ticket they lead to. Once the ticket is
# made, or found, its files move into data/projects/<project>/work/<TICKET-KEY>
# (made if missing), beside what is there, and the run's folder is removed.
# <run-id> may be any run of the chain. Prints { moved: [<file>…] }; nothing
# to move is no failure. Fails, moving nothing, when a file would overwrite
# one in the ticket's folder.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../prompt.bash"

[[ $# -eq 3 ]] || { echo "usage: ticket:adopt-run-folder <project> <ticket-key> <run-id>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" run="$3"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ticket:adopt-run-folder: invalid project '$project'" >&2; exit 1; }
[[ "$key" =~ ^[A-Z0-9_]+-[0-9]+$ ]] || { echo "ticket:adopt-run-folder: invalid ticket '$2'" >&2; exit 1; }
[[ "$run" =~ ^[0-9a-f-]+$ ]] || { echo "ticket:adopt-run-folder: invalid run '$run'" >&2; exit 1; }
work="$prompt_projects_dir/$project/work"
from="$work/run-$(run_root "$run")" to="$prompt_projects_dir/$(home_project ticket:adopt-run-folder "$project" "$key")/work/$key"   # the ticket's own project's folder

# The run's lock, work/run-<root id>.lock, held to the end (ASS-179): the
# folder is not made (agent:dispatch) or deleted (transient-state-engine:remove) mid-move.
lock_on 5 "$from.lock" ticket:adopt-run-folder "${JSON_LOCK_TIMEOUT:-30}"
[[ -d "$from" ]] || { echo '{"moved":[]}'; exit 0; }
files=()
while IFS= read -r name; do files+=("$name"); done < <(cd "$from" && ls -A | sort)
for name in "${files[@]+"${files[@]}"}"; do
  [[ ! -e "$to/$name" ]] || { echo "ticket:adopt-run-folder: $key already has $name" >&2; exit 1; }
done
mkdir -p "$to"
for name in "${files[@]+"${files[@]}"}"; do mv "$from/$name" "$to/$name"; done
rmdir "$from"
jq -nc '$ARGS.positional | { moved: . }' --args "${files[@]+"${files[@]}"}"
