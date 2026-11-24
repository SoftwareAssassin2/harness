# The seat-budget settings' commands' shared parts (ASS-546): project:set-share,
# machine:set-limits, project:set-ticket-isolation and harness:set-budget. The
# settings are ASS-528's (project.json `share`, harness.json
# max-memory-percent / max-cpu-percent, src/control/seat-budget.js) and
# ASS-529's (each workstation's and cloud VM's own max-memory-percent /
# max-cpu-percent, dev-environments.ticket-isolation,
# src/control/dev-environments.js); control rereads both files every tick.
#
# Each command edits its file as every other writer of it does (update_json's
# lock, "<file>.lock"), but holds that lock from its read to its write
# (lock_on + write_json, as ticket:renumber-backlog does, ASS-179): the value
# it reports as "before" and the checks it makes are of the file it then
# writes, so a write another command makes meanwhile is waited for, never
# overwritten. The file is written whole (a temp file renamed over it), and
# not at all when a check fails.
#
#   ss_percent <command> <what> <value> <min>   # exits 1, naming <what>, unless <value> is a number from <min> to 100
#   ss_lock <command> <file>                    # <file> resolved into $file and its lock held on descriptor 9 (not in a $(…): the lock is this shell's)
#   ss_shown <json-value>                       # a value for a message: "unset" for null, else the number or text
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/json-file.bash"

# ss_percent — a whole or decimal number (no sign, no leading zeros), at least
# <min> and at most 100.
ss_percent() {
  local command="$1" what="$2" value="$3" min="$4"
  if ! [[ "$value" =~ ^(0|[1-9][0-9]*)(\.[0-9]+)?$ ]] || [[ "$(jq -n --argjson v "$value" --argjson min "$min" '$v >= $min and $v <= 100')" != true ]]; then
    echo "$command: $what must be a percentage from $min to 100, got '$value'" >&2; exit 1
  fi
}

# ss_lock — the file must be there and be JSON; its path is resolved first so
# every spelling of it locks the one lock file (as update_json does).
ss_lock() {
  local command="$1"
  file="$(readlink -f "$2")" && [[ -f "$file" ]] || { echo "$command: no file '$2'" >&2; exit 1; }
  lock_on 9 "$file.lock" "$command" "${JSON_LOCK_TIMEOUT:-30}" || exit 1
  jq empty "$file" 2>/dev/null || { echo "$command: $file is not valid JSON; nothing written" >&2; exit 1; }
}

ss_shown() { jq -r 'if . == null then "unset" else tostring end' <<< "$1"; }
