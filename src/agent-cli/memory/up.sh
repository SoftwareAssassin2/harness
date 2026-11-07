#!/usr/bin/env bash
# Description: Bring a project's Hindsight memory up on the Mac — memory:up <project>; idempotent, and what control runs whenever it stops answering.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/memory.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

# One Hindsight per project, from the project's "hindsight" in project.json
# (see memory.bash). In order, each step only when something is missing or changed:
#  1. hindsight-api, the pinned release, installed once into its own
#     virtualenv (python3 -m venv, then pip); a failed install is removed.
#  2. Hindsight itself, started when nothing answers on the port: in its own
#     session, so it outlives the control (or shell) that ran this, listening
#     on 127.0.0.1 only, HOME its data folder, its LLM settings in its
#     environment — the key never on its command line or on disk here; its pid
#     in $data/hindsight.pid, its output in $data/hindsight.out. The Hindsight
#     this command started (that pid, still running the pinned hindsight-api)
#     is restarted when its settings changed (a key pasted into project.json:
#     config.sha256, a hash, records what it runs on) or it stopped answering
#     (hung); one it did not start is left be.
#  3. The project's bank, named after it (PUT, which leaves one that exists be).
# Then prints { project, url, mcp, vm-mcp, provider, model, data, changed }.
# Waits up to HINDSIGHT_WAIT_SECONDS (300) for Hindsight to answer: its first
# start downloads its embedding and reranking models.
# One at a time per project (ASS-179): the project's memory-up.lock is held to
# the end, so a second waits — through an install and that first start — then
# finds Hindsight answering: never a second started, nor one still starting
# taken for hung.
[[ $# -eq 1 ]] || { echo "usage: memory:up <project>" >&2; exit 1; }
memory_config memory:up "$1"
lock_on 6 "$projects/$1/memory-up.lock" memory:up $(( ${HINDSIGHT_WAIT_SECONDS:-300} + 600 ))
[[ "$provider" != none ]] || echo "memory:up: $1 has no llm-api-key in project.json's hindsight; its Hindsight runs with provider none: retain stores plain chunks, recall works, reflect is unavailable" >&2

changed=false
if [[ ! -x "$hindsight_bin" ]]; then
  "$hindsight_python" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null \
    || { echo "memory:up: Hindsight needs Python 3.11 or newer as $hindsight_python" >&2; exit 1; }
  mkdir -p "$(dirname "$hindsight_venv")"
  { "$hindsight_python" -m venv "$hindsight_venv" && "$hindsight_venv/bin/pip" install --quiet "hindsight-api==$hindsight_version" && [[ -x "$hindsight_bin" ]]; } >&2 \
    || { rm -rf "$hindsight_venv"; echo "memory:up: could not install hindsight-api $hindsight_version into $hindsight_venv" >&2; exit 1; }
  changed=true
fi

mkdir -p "$data" && chmod 700 "$data"
pid_file="$data/hindsight.pid"
fingerprint="$(printf '%s\n' "$hindsight_version" "$provider" "$model" "$key" | shasum -a 256 | cut -d' ' -f1)"
restart=false
[[ -f "$data/config.sha256" && "$(cat "$data/config.sha256")" == "$fingerprint" ]] || restart=true

answering() { curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$port/health"; }
# The Hindsight this command started, while its pid still runs the pinned
# hindsight-api (a reused pid is never signalled); stopped — TERM, KILL after
# 10 seconds — when it must restart.
pid="$(cat "$pid_file" 2>/dev/null || true)"
[[ "$pid" =~ ^[0-9]+$ && "$(ps -p "$pid" -o command= 2>/dev/null)" == *"$hindsight_bin "* ]] || pid=""
if [[ -n "$pid" ]] && { [[ "$restart" == true ]] || ! answering; }; then
  # What it spent on Claude since control last read it, recorded first: its counters go with it (memory:record-spend, ASS-269).
  "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/record-spend.sh" "$1" >/dev/null 2>&1 6>&- || true
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$pid" 2>/dev/null || true
  pid=""
fi
if [[ -z "$pid" ]] && ! answering; then
  # setsid through perl (macOS has no setsid command). Only provider none goes without the model and key.
  llm=(HINDSIGHT_API_LLM_PROVIDER="$provider")
  [[ "$provider" == none ]] || llm+=(HINDSIGHT_API_LLM_MODEL="$model" HINDSIGHT_API_LLM_API_KEY="$key")
  (cd / && exec env HOME="$data" "${llm[@]}" perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "hindsight-api: $!\n"' \
    "$hindsight_bin" --host 127.0.0.1 --port "$port" </dev/null >>"$data/hindsight.out" 2>&1 6>&-) &
  echo $! > "$pid_file"
  printf '%s\n' "$fingerprint" > "$data/config.sha256"
  changed=true
elif [[ -z "$pid" && "$restart" == true && -f "$data/config.sha256" ]]; then
  echo "memory:up: a Hindsight memory:up did not start answers on 127.0.0.1:$port, so it keeps its old settings; stop it, then run memory:up $1 again" >&2
fi

for _ in $(seq $(( ${HINDSIGHT_WAIT_SECONDS:-300} * 2 ))); do
  answering && break
  sleep 0.5
done
answering || { echo "memory:up: Hindsight did not answer on 127.0.0.1:$port — see $data/hindsight.out" >&2; exit 1; }
curl -fs -o /dev/null --max-time 10 -X PUT -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$port/v1/default/banks/$1" \
  || { echo "memory:up: Hindsight on 127.0.0.1:$port would not make the bank $1" >&2; exit 1; }

jq -n --arg p "$1" --arg port "$port" --arg provider "$provider" --arg model "$model" --arg data "$data" --argjson changed "$changed" \
  '{ project: $p, url: "http://127.0.0.1:\($port)", mcp: "http://127.0.0.1:\($port)/mcp/\($p)/", "vm-mcp": "http://host.lima.internal:\($port)/mcp/\($p)/",
     provider: $provider, model: (if $model == "" then null else $model end), data: $data, changed: $changed }'
