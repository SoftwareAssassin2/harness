# The question commands' shared lookup. question_file <command> <project>
# <global|ticket-key> [<index>] sets $file to the questions file the question is
# in — data/projects/<project>/global-questions-and-answers.json, or
# data/projects/<project>/work/<ticket-key>/questions-and-answers.json — and fails
# on a name that could climb out of the projects folder or an index that is not
# a number from 0. PROJECTS_DIR overrides the projects folder, used by tests.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

question_file() {
  local command="$1" project="$2" where="$3" index="${4:-}"
  [[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; return 1; }
  [[ "$where" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid ticket '$where'" >&2; return 1; }
  [[ $# -lt 4 || "$index" =~ ^[0-9]+$ ]] || { echo "$command: index must be a number from 0, got '$index'" >&2; return 1; }
  if [[ "$where" == global ]]; then file="$projects/$project/global-questions-and-answers.json"
  else file="$projects/$project/work/$where/questions-and-answers.json"; fi
}

# judge_answer <command> <file> <index> <jq update> [jq options…] — applies the
# update to the <index>th question, which must be "Answered".
judge_answer() {
  local command="$1" file="$2" index="$3" update="$4"; shift 4
  update_json "$file" --argjson i "$index" --arg command "$command" "$@" "
    if \$i >= (.list | length) then error(\"\(\$command): no question \(\$i) in this file\")
    elif .list[\$i].status != \"Answered\" then error(\"\(\$command): question \(\$i) is not Answered (it is \(.list[\$i].status))\")
    else .list[\$i] |= ($update) end"
}
