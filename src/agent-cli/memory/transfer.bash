# A project's memory backed up and restored (ASS-148) through Hindsight's own
# bank transfer (hindsight.vectorize.io/api-reference, "Bank Transfer"): an
# export is a ZIP of the bank's documents, facts and observations and its
# config, without embeddings; an import re-embeds it with no LLM. Both are
# asynchronous: each returns an operation, polled until it is done. Not
# pg_dump: the archive outlives Hindsight's own schema.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/memory.bash"

# The backups, outside the repo and the live store: hindsight-backups/<project>/
# beside Hindsight's install (HINDSIGHT_DIR, so tests that move it move these:
# ~/Library/Application Support/harness/hindsight-backups by default). A daily
# backup (memory:backup, which control runs) is <UTC time>.zip, 20261026T105411Z.zip
# — the last 14 kept; restore's own export of the bank it replaces is
# pre-restore-<UTC time>.zip, never pruned. src/control/memory-backup.js reads
# the same folder for the time of the latest.
backups_root="${HINDSIGHT_DIR:-$HOME/Library/Application Support/harness}/hindsight-backups"
backups_kept=14
backup_name='^[0-9]{8}T[0-9]{6}Z\.zip$'

# transfer_wait <command> <project> <operation> — the operation polled every
# half second until it completes, up to HINDSIGHT_TRANSFER_WAIT_SECONDS (600);
# prints its result_metadata. Fails, naming why, when it fails, is cancelled
# or not found, or does not finish in time.
transfer_wait() {
  local command="$1" project="$2" operation="$3" status reply
  for _ in $(seq $(( ${HINDSIGHT_TRANSFER_WAIT_SECONDS:-600} * 2 ))); do
    reply="$(curl -fsS --max-time 10 "http://127.0.0.1:$port/v1/default/banks/$project/operations/$operation")" \
      || { echo "$command: $project's Hindsight did not answer for operation $operation" >&2; return 1; }
    status="$(jq -r .status <<<"$reply")"
    case "$status" in
      completed) jq -c '.result_metadata // {}' <<<"$reply"; return 0 ;;
      pending|processing) sleep 0.5 ;;
      *) echo "$command: $project's Hindsight operation $operation is $status: $(jq -r '.error_message // "no reason given"' <<<"$reply")" >&2; return 1 ;;
    esac
  done
  echo "$command: $project's Hindsight operation $operation did not finish in ${HINDSIGHT_TRANSFER_WAIT_SECONDS:-600} seconds" >&2
  return 1
}

# memory_export <command> <project> <file> — the project's bank exported
# (memory_config's $port) with its data and config, the archive downloaded
# to <file>; written whole or not at all. Returns 2, saying so, when
# Hindsight answers that the bank does not exist.
memory_export() {
  local command="$1" project="$2" file="$3" reply status operation meta url part
  reply="$(curl -sS --max-time 30 -w '\n%{http_code}' -X POST "http://127.0.0.1:$port/v1/default/banks/$project/transfer/export" 2>/dev/null)" || reply=$'\n000'
  status="${reply##*$'\n'}"
  [[ "$status" != 404 ]] || { echo "$command: $project's Hindsight on 127.0.0.1:$port has no bank $project" >&2; return 2; }
  operation="$(jq -r '.operation_id // empty' <<<"${reply%$'\n'*}" 2>/dev/null || true)"
  [[ "$status" == 2* && -n "$operation" ]] \
    || { echo "$command: $project's Hindsight on 127.0.0.1:$port would not export the bank $project" >&2; return 1; }
  meta="$(transfer_wait "$command" "$project" "$operation")" || return 1
  url="$(jq -r '.download_url // empty' <<<"$meta")"
  [[ -n "$url" ]] || { echo "$command: $project's export gave no download_url" >&2; return 1; }
  [[ "$url" == http* ]] || url="http://127.0.0.1:$port$url"
  mkdir -p "$(dirname "$file")"
  part="$(mktemp "$file.XXXXXX")" \
    && curl -fsS --max-time 600 -o "$part" "$url" && [[ -s "$part" ]] && mv "$part" "$file" \
    || { rm -f "$part"; echo "$command: could not download $project's export from $url" >&2; return 1; }
}

# utc_stamp — now, as an archive's name has it.
utc_stamp() { date -u +%Y%m%dT%H%M%SZ; }
