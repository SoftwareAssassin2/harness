#!/usr/bin/env bash
# Description: Carry a fix to a project's golden image definition into a rebuild, in the background, and log its result on the tickets it fixed — vm:golden-followup <project> [<ticket-key> <variation>]; prints JSON.
set -euo pipefail

# ASS-427 AC2/AC3/AC6: Blocked's Repair the VM fixes the ticket's VM in place
# and writes the same fix into the VM's source; grouped-blocked's Rebuild the
# Source in the Background then runs this with the ticket, and control runs it
# without one every minute while anything is queued or followed
# (src/control/golden-followup.js). The ticket never waits on it.
#
# With <ticket-key> <variation> it first records them as waiting on a rebuild
# (data/projects/<project>/golden-followup.json: { entries: [{ ticket,
# variation, at, build }] }, build null until one is started for them). Then,
# under golden-followup.lock (so the step and control never both act), when no
# build of golden-<project> runs (golden.bash golden_status):
#   1. each file vm:golden-write queued while a build ran (golden-queue/) is
#      written into the definition, through vm:golden-write, and dropped;
#   2. each entry whose build has ended has its result logged on its ticket
#      (the variation's change log, work.bash blocked_log): rebuilt with the
#      fix, its build's checks passed — its tools check (project.json
#      golden-image.tools, vm:golden-add-tool) among them — or failed, its exit
#      and log; and is dropped;
#   3. the entries waiting with no build, or a definition just written from
#      the queue: when the image is not current with its definition, the
#      rebuild is started (vm:build-golden-start, detached, never waited on)
#      and they record it (build: its started-at; one found already running,
#      started by another, is theirs too); when it is current — a VM-setup
#      fix, ~/.harness/vm-credentials.json, needs none — they are logged so,
#      and dropped. A start refused (the disk hold) leaves them waiting, logged,
#      for the next run to try again.
# While a build runs, nothing is written or started (one build per project at
# a time): the queue and the entries wait for it to end; an entry recorded
# then is logged as waiting. Prints { project, status, applied: [files],
# started, reported: [{ ticket, variation, result }], waiting: <entries
# left>, queued: <files left> }. Exits 0 — the step is best-effort, and
# whatever it found is logged — but 1 on bad arguments, an unknown project,
# ticket or variation, or a project with no golden-image definition.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/golden.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$here_vm/work.bash"

command=vm:golden-followup title="Rebuild the Source"
[[ $# -eq 1 || $# -eq 3 ]] || { echo "usage: $command <project> [<ticket-key> <variation>]" >&2; exit 1; }
project="$1" key="" variation=""
[[ $# -eq 1 ]] || { key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3"; variation_exists "$command" "$project" "$key" "$variation"; }
golden_definition "$command" "$project"
dir="$projects/$project" golden="golden-$project"
file="$dir/golden-followup.json" queue="$dir/golden-queue"
lock_on 5 "$dir/golden-followup.lock" "$command" "${JSON_LOCK_TIMEOUT:-60}"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
entries() { jq -c '.entries // []' "$file" 2>/dev/null || echo '[]'; }
say() { blocked_log "$1" "$2" "$3" "$title" "$4"; }
# each <filter> — each entry the jq filter selects, as "<ticket>\t<variation>" lines.
each() { entries | jq -r ".[] | select($1) | [.ticket, .variation] | @tsv"; }

if [[ -n "$key" ]]; then
  update_json --create "$file" --arg k "$key" --arg v "$variation" --arg at "$(now)" \
    '.entries = ([(.entries // [])[] | select(.ticket != $k or .variation != $v or .build != null)] + [{ ticket: $k, variation: $v, at: $at, build: null }])'
fi

status="$(golden_status "$project" | jq -r .status)"
applied=() started=false reported='[]'
if [[ "$status" == building ]]; then
  [[ -z "$key" ]] || say "$project" "$key" "$variation" "$golden is being built now (one build per project at a time): the fix's definition change waits in golden-queue, and the rebuild with it starts once that build ends. This ticket goes on on its fixed VM; it does not wait."
else
  # 1. The queue, written into the definition.
  if [[ -d "$queue" ]]; then
    while IFS= read -r -d '' q; do
      rel="${q#"$queue"/}"
      # A temp file vm:golden-write is renaming into place now (<file>.XXXXXX, seconds old) is left for the next run.
      [[ ! "$rel" =~ \.[A-Za-z0-9]{6}$ ]] || (( $(date +%s) - $(stat -f %m "$q" 2>/dev/null || stat -c %Y "$q") > 120 )) || continue
      out="$("$agent" vm:golden-write "$project" "$rel" < "$q" 5>&-)" || { echo "$command: the queued $rel could not be written: left queued" >&2; continue; }
      [[ "$(jq -r .queued <<< "$out")" == false ]] || break   # a build started meanwhile: the rest wait for it
      rm -f "$q"
      applied+=("$rel")
    done < <(find "$queue" -type f ! -name '.*' -print0 2>/dev/null | LC_ALL=C sort -z)
    find "$queue" -mindepth 1 -type d -empty -delete 2>/dev/null || true
  fi
  [[ ${#applied[@]} -eq 0 ]] || golden_definition "$command" "$project"   # its hash now the written definition's
  now_status="$(golden_status "$project")"
  status="$(jq -r .status <<< "$now_status")"

  # 2. The builds that have ended, their results logged.
  if [[ "$status" != building ]]; then
    code="$(jq -r '.["exit-code"] // "null"' <<< "$now_status")"
    label="$(golden_label "$project")"
    built="$(jq -r '"built-at \(.["built-at"] // "?"), generation \(.generation // .["built-at"] // "?")"' "$label" 2>/dev/null || echo 'its label unread')"
    while IFS=$'\t' read -r k v; do
      [[ -n "$k" ]] || continue
      if [[ "$code" == 0 || ( "$code" == null && "$status" == current ) ]]; then
        result=rebuilt
        say "$project" "$k" "$v" "$golden rebuilt with the fix ($built): its build's checks passed, the tools check (project.json golden-image.tools) among them. Later VMs are cloned from it."
      else
        result=failed
        say "$project" "$k" "$v" "$golden's rebuild with the fix failed (exit $code): see $dir/golden-image-build.log and $dir/golden-build-run.log. This ticket's VM keeps its fix; later VMs are cloned from the older image, without it, until golden-$project is rebuilt (vm:golden-stale says so; check-health raises its rebuild ticket)."
      fi
      reported="$(jq -c --arg k "$k" --arg v "$v" --arg r "$result" '. + [{ ticket: $k, variation: $v, result: $r }]' <<< "$reported")"
    done < <(each '.build != null')
    [[ "$reported" == '[]' ]] || update_json "$file" '.entries = [(.entries // [])[] | select(.build == null)]'
  fi

  # 3. A rebuild for the fixes waiting, or for a definition just written.
  if [[ "$status" != building && ( -n "$(each '.build == null')" || ${#applied[@]} -gt 0 ) ]]; then
    if [[ "$status" == current ]]; then
      while IFS=$'\t' read -r k v; do
        [[ -n "$k" ]] || continue
        say "$project" "$k" "$v" "No rebuild needed: $golden is current with its definition (the fix was to the VM's setup, or needed no image change). Later VMs get it as they start."
      done < <(each '.build == null')
      update_json --create "$file" '.entries = [(.entries // [])[] | select(.build != null)]'
    elif out="$("$agent" vm:build-golden-start "$project" 5>&- 2>&1)"; then
      started="$(jq -r .started <<< "$out")"
      at="$(jq -r '.["started-at"] // empty' "$dir/golden-build-run.json" 2>/dev/null || true)"
      at="${at:-$(now)}"
      while IFS=$'\t' read -r k v; do
        [[ -n "$k" ]] || continue
        say "$project" "$k" "$v" "$( [[ "$started" == true ]] && echo "Started $golden's rebuild with the fix (vm:build-golden-start, $at)" || echo "$golden is being rebuilt already (since $at): the fix is in that build")${applied[*]:+, the queued ${applied[*]} written into its definition first}. Nobody waits for it: this ticket goes on on its fixed VM, and the build's result is logged here when it ends."
      done < <(each '.build == null')
      update_json --create "$file" --arg at "$at" '.entries = [(.entries // [])[] | if .build == null then .build = $at else . end]'
      status=building
    else
      while IFS=$'\t' read -r k v; do
        [[ -n "$k" ]] || continue
        say "$project" "$k" "$v" "$golden's rebuild could not start yet: $(tail -n 1 <<< "$out"). It is tried again (control, every minute) until it starts; this ticket does not wait."
      done < <(each '.build == null and (.refused // false | not)')
      update_json --create "$file" '.entries = [(.entries // [])[] | if .build == null then .refused = true else . end]'
      echo "$command: vm:build-golden-start $project: $out" >&2
    fi
  fi
fi

left=0; [[ ! -d "$queue" ]] || left="$(find "$queue" -type f ! -name '.*' | wc -l | tr -d ' ')"
jq -nc --arg p "$project" --arg s "$status" --argjson started "$started" --argjson reported "$reported" --argjson waiting "$(entries | jq length)" --argjson queued "$left" \
  --argjson applied "$(printf '%s\n' ${applied[@]+"${applied[@]}"} | jq -Rsc 'split("\n") | map(select(. != ""))')" \
  '{ project: $p, status: $s, applied: $applied, started: $started, reported: $reported, waiting: $waiting, queued: $queued }'
