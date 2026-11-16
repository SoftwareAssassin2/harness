# A ticket variation's steps on one of its project's GCP workstations
# (ASS-435, ASS-468): which workstation it records, claiming one for a step
# and giving it back at the step's end, and the step's working trees there
# or, in vm+workstation mode, in its VM. Sourced by vm.bash.
#
#   wsv_root <home>                             # the workstation's shared root: <home>/harness (repos/, ticket/, mnt/, run/)
#   wsv_place <project> <key> <variation>       # vm:create's choice of workstation, recorded on the variation ($wsv_machine);
#                                               # 4 when none can be used ($wsv_why). Claims nothing.
#   wsv_claim <project> <key> <variation> [<id>]   # a free, usable workstation (only <id>, given: ASS-469) claimed for one step: its holder set, the variation's
#                                               # `workstation` recorded, readied (wsv_start) and its trees on the variation's
#                                               # branches (wsv_trees start); prints { name, machine, … }; 4 when none is free ($wsv_why)
#   wsv_start <project> <key> <variation> <machine>    # readied for its holder: credentials, forwarder token, ticket copy, images
#   wsv_pull_images <project> <id> <boot-id>        # images.txt pulled there, Artifact Registry first, zot the fallback (ASS-472)
#   wsv_release <command> <project> <id> [<why>]       # the holder's step ended: its trees committed or cleaned, pushed, its
#                                               # containers, credentials and token removed, the workstation freed; prints a summary
#   wsv_specs <command> <project> <key> <variation>    # a "<name>:<branch>:<base>:<url>" line per repository (step-trees.sh)
#   wsv_trees <command> <machine> start <project> <key> <variation>   # step-trees.sh (git-hooks.sh before it) run there;
#   wsv_trees <command> <machine> end <project> <key> <variation> <completed|incomplete> [<message>]   # prints a summary
#
# ASS-468 (operator decision, 2026-11-15): a workstation is held only while
# one of a ticket variation's steps runs on it — claimed at the step's start
# and released at its end, whatever the outcome — so one ticket waiting
# (Blocked, waiting for a slot or a fix) never keeps it from the others. So
# that every step can find the repositories as it needs them, each step
# leaves them clean on master with the latest pulled, and the workstation
# keeps one shared set of repositories every variation uses in turn,
# <home>/harness/repos, cloned once and kept across steps and restarts (only
# /home survives one): no folder per variation (ASS-435's
# ~/harness/<KEY>-<variation>, removed by the next workstation:setup, or by
# wsv_release for a holder from before this change: the migration).
#
# The shared root, <home>/harness — the setup's own folder: bin, lib, tools,
# env, setup.json and golden-image beside it are never touched here — stands
# in for a VM's root as ASS-435's folder did (machine-workstation.bash):
# repos/ the repositories, ticket/ the holder's ticket's read-only copy
# (mnt/ticket links to it), run/harness a link to the setup's runtime folder.
# Its machine is workstation:<project>:<id>:<home>/harness, the same for
# every variation (one at a time), so the forwarder binding in vm-tokens.json
# under it is the holder's alone.
#
# The holder (workstations.json's `holder`, { ticket, variation, folder,
# since, boot-id, started-at, credential-kind, credential-stamps }) is
# claimed under the project's pool lock (workstations-pool.lock, descriptor
# 7), so two claims never take one workstation, and only on one that is free
# (no holder) and usable now (connected, its login live, set up since it
# connected): control keeps it so (src/control/workstations.js) while a step
# wants it. The variation records the step's claim as its `workstation`, {
# name, project, folder, since } (the machine layer runs its step there:
# machine.bash $machine_of), removed at the release; its `vm` keeps what
# vm:create recorded (a workstation of the pool, or its VM).
here_wsv="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
wsv_assignments="${ASSIGNMENTS_FILE:-$here_wsv/../../data/assignments.json}"
wsv_trees_script="$here_wsv/workstation/on-workstation/step-trees.sh"
wsv_pull_script="$here_wsv/workstation/on-workstation/pull-images.sh"
wsv_hooks_script="$here_wsv/workstation/on-workstation/git-hooks.sh"

wsv_root() { echo "$1/harness"; }

wsv_pool_lock() { lock_on 7 "$projects/$2/workstations-pool.lock" "$1" "${VM_LOCK_TIMEOUT:-600}"; }

# wsv_busy <project> <key> <variation> — an assignment is on the variation: an agent of its step at work (or about to be).
wsv_busy() {
  [[ -f "$wsv_assignments" ]] && jq -e --arg p "$1" --arg k "$2" --arg v "$3" \
    'any(.assignments[]?; .project == $p and ((.["work-item"] // "") | ascii_downcase) == ($k | ascii_downcase) and .variation == $v)' "$wsv_assignments" >/dev/null 2>&1
}

# wsv_ready <project> <id> — the workstation connected (workstation:connect: started when stopped) and set up since
# (workstation:setup), each run as needed; fails, its reason in $wsv_why. Never passes on the pool lock (descriptor 7):
# the connection's master outlives this command.
wsv_ready() {
  local project="$1" id="$2" out
  if ! workstation_alive "$project" "$id"; then
    out="$("$agent" workstation:connect "$project" "$id" 2>&1 >/dev/null </dev/null 7>&-)" || { wsv_why="$id: could not connect: $(tail -n 1 <<< "$out")"; return 1; }
  fi
  if ! workstation_entry "$project" "$id" | jq -e '.setup.ok == true and (.setup["checked-at"] // "") >= (.["connected-at"] // "")' >/dev/null; then
    out="$("$agent" workstation:setup "$project" "$id" 2>&1 >/dev/null </dev/null 7>&-)" || { wsv_why="$id: setup failed: $(tail -n 1 <<< "$out")"; return 1; }
  fi
}

# wsv_usable <project> <id> — why the workstation cannot take a step now (printed), or nothing when it can: its
# login live, connected (its master answering), set up since.
wsv_usable() {
  local e
  e="$(workstation_entry "$1" "$2")"
  if jq -e '.["last-error"].kind == "expired"' >/dev/null <<< "$e"; then echo "its gcloud login needs reauthentication"; return; fi
  if ! jq -e '.connected == true' >/dev/null <<< "$e" || ! workstation_alive "$1" "$2"; then echo "not connected (stopped, or starting)"; return; fi
  if jq -e '.setup.ok == false' >/dev/null <<< "$e"; then echo "its setup failed"; return; fi
  jq -e '.setup.ok == true and (.setup["checked-at"] // "") >= (.["connected-at"] // "") and (.setup.home // "" | startswith("/"))' >/dev/null <<< "$e" || echo "being set up"
}

# wsv_place — vm:create's (Setup's Create VM): the variation is to run its steps on the project's workstations, so
# it records the first of the pool, in list order, whose login is live and whose home folder a setup has recorded
# (connected and set up first when none has yet). Nothing is claimed: each step claims one (wsv_claim).
wsv_place() {
  local project="$1" key="$2" variation="$3" ws id home why=()
  while IFS= read -r ws; do
    id="$(jq -r .id <<< "$ws")"
    if workstation_entry "$project" "$id" | jq -e '.["last-error"].kind == "expired"' >/dev/null; then why+=("$id: its gcloud login needs reauthentication"); continue; fi
    home="$(workstation_entry "$project" "$id" | jq -r '.setup.home // empty')"
    if [[ "$home" != /* ]]; then
      wsv_ready "$project" "$id" || { why+=("$wsv_why"); continue; }
      home="$(workstation_entry "$project" "$id" | jq -r '.setup.home // empty')"
      [[ "$home" == /* ]] || { why+=("$id: its setup recorded no home folder"); continue; }
    fi
    wsv_machine="workstation:$project:$id:$(wsv_root "$home")"
    return 0
  done < <(dev_environments_workstations vm:create "$project")
  wsv_why="no workstation of $project's can be used: $(printf '%s; ' "${why[@]+"${why[@]}"}" | sed 's/; $//')"
  return 4
}

# wsv_set_on <project> <key> <variation> <id> <folder>|"" — the variation's `workstation`, the step's claim, recorded (or removed).
wsv_set_on() {
  update_whole_ticket vm:workstation "$1" "$2" --arg name "$3" --arg id "$4" --arg f "${5-}" --arg p "$1" '
    .variations |= map(if .name != $name or .["is-deleted"] then .
      elif $f == "" then (if .workstation.name == $id then del(.workstation) else . end)
      else .workstation = { name: $id, project: $p, folder: $f, since: $at }
        | if .vm.kind == "workstation" and .vm.name == $id then .vm.folder = $f else . end end)' >/dev/null
}

wsv_claim() {
  local project="$1" key="$2" variation="$3" only="${4:-}" ws id hk hv home w why=() chosen="" machine root summary kind
  wsv_pool_lock workstation:claim "$project"
  while IFS= read -r ws; do
    id="$(jq -r .id <<< "$ws")"
    [[ -z "$only" || "$id" == "$only" ]] || continue
    IFS=$'\t' read -r hk hv < <(workstation_entry "$project" "$id" | jq -r '[.holder.ticket // "", .holder.variation // ""] | @tsv')
    if [[ -n "$hk" ]]; then why+=("$id: held by $hk $hv"); continue; fi
    w="$(wsv_usable "$project" "$id")"
    [[ -z "$w" ]] || { why+=("$id: $w"); continue; }
    home="$(workstation_entry "$project" "$id" | jq -r '.setup.home')"
    root="$(wsv_root "$home")" chosen="$id"
    workstation_record "$project" "$id" --arg k "$key" --arg v "$variation" --arg f "$root" '.holder = { ticket: $k, variation: $v, folder: $f, since: $at }'
    break
  done < <(dev_environments_workstations workstation:claim "$project")
  exec 7>&-
  if [[ -z "$chosen" ]]; then wsv_why="no workstation of $project's is free: $(printf '%s; ' "${why[@]+"${why[@]}"}" | sed 's/; $//')"; return 4; fi
  id="$chosen" machine="workstation:$project:$chosen:$root"
  echo "workstation:claim: $key $variation claimed $project's workstation $id for a step" >&2
  # The shared root, standing in for a VM's: repos, the ticket's copy (and mnt/ticket to it), run/harness the runtime folder.
  if wsv_set_on "$project" "$key" "$variation" "$id" "$root" && workstation_ssh "$project" "$id" bash -c 'set -e; . "$HOME/harness/env"; f="$1"
      mkdir -p "$f/repos" "$f/mnt" "$f/run" "$f/ticket"; ln -sfn ../ticket "$f/mnt/ticket"; ln -sfn "$HARNESS_RUNTIME" "$f/run/harness"' harness-ws "$root" </dev/null \
    && kind="$(wsv_start "$project" "$key" "$variation" "$machine" | jq -r '.["credential-kind"] // ""')" \
    && summary="$(wsv_trees workstation:claim "$machine" start "$project" "$key" "$variation")"; then
    jq -c --arg n "$id" --arg m "$machine" --arg k "$kind" '{ name: $n, machine: $m, "credential-kind": (if $k == "" then null else $k end) } + .' <<< "$summary"
    return 0
  fi
  echo "workstation:claim: $key $variation's step could not be readied on workstation $id; it is given back" >&2
  wsv_release workstation:claim "$project" "$id" "its claim failed" >/dev/null || true
  return 1
}

wsv_start() {
  local project="$1" key="$2" variation="$3" machine="$4" entry kind token binding boot
  wsm_parts "${machine#workstation:}" || exit 1
  [[ "$wsm_project" == "$project" ]] || { echo "vm:start: $key $variation's workstation machine is $wsm_project's, not $project's" >&2; return 1; }
  workstation_entry "$project" "$wsm_id" | jq -e --arg k "$key" --arg v "$variation" '.holder.ticket == $k and .holder.variation == $v' >/dev/null \
    || { echo "vm:start: $project's workstation $wsm_id is not held by $key $variation (control claims it for each of its steps: workstation:claim)" >&2; return 1; }
  wsv_ready "$project" "$wsm_id" || { echo "vm:start: $wsv_why" >&2; return 1; }
  workstation_ssh "$wsm_project" "$wsm_id" bash -c '. "$HOME/harness/env"; mkdir -p "$1/repos" "$1/run" && ln -sfn "$HARNESS_RUNTIME" "$1/run/harness"' harness-ws "$wsm_folder" </dev/null \
    || { echo "vm:start: could not link $wsm_folder/run/harness on workstation $wsm_id" >&2; return 1; }

  kind="$("$agent" vm:credentials "$project" "$machine" 7>&-)" || return 1
  [[ "$kind" =~ ^(claude|anthropic|both)?$ ]] || { echo "vm:start: vm:credentials printed no credential kind for $machine: '$kind'" >&2; return 1; }

  token="$(openssl rand -hex 32)"
  binding="$(jq -nc --arg p "$project" --arg k "$key" --arg v "$variation" --arg f "$(ticket_folder vm:start "$project" "$key")" \
    --arg h "$(printf '%s' "$token" | shasum -a 256 | cut -d' ' -f1)" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg m "$machine" \
    '{ project: $p, ticket: $k, variation: $v, "ticket-folder": $f, "token-sha256": $h, "issued-at": $at, machine: $m }')"
  mkdir -p "$(dirname "$tokens_file")"
  (umask 077; update_json --create "$tokens_file" --arg vm "$machine" --argjson b "$binding" '.[$vm] = $b')
  printf '%s\n' "$token" | workstation_ssh "$wsm_project" "$wsm_id" bash -c 'set -e; umask 077; . "$HOME/harness/env"; IFS= read -r t; printf "%s\n" "$t" > "$HARNESS_RUNTIME/agent-token"' \
    || { echo "vm:start: could not give workstation $wsm_id its forwarder token" >&2; return 1; }

  wsm_sync_ticket "${machine#workstation:}" "$(ticket_folder vm:start "$project" "$key")" >/dev/null \
    || { echo "vm:start: could not copy $key's ticket folder to $wsm_folder/ticket on workstation $wsm_id" >&2; return 1; }

  # AC5 (ASS-435): the project's images, once per boot of the workstation (images-boot-id, ASS-468), not at every
  # step's claim: its Docker's images persist under /home. ASS-472: straight from Artifact Registry there, zot the
  # fallback (wsv_pull_images).
  boot="$(workstation_entry "$project" "$wsm_id" | jq -r '.setup["boot-id"] // empty')"
  if [[ "$(workstation_entry "$project" "$wsm_id" | jq -r '.["images-boot-id"] // empty')" != "$boot" ]]; then
    if wsv_pull_images "$project" "$wsm_id" "$boot"; then workstation_record "$project" "$wsm_id" --arg b "$boot" '.["images-boot-id"] = $b'
    else echo "vm:start: the images could not be pulled on workstation $wsm_id; they are tried again at its next step's claim" >&2; fi
  fi

  workstation_record "$project" "$wsm_id" --arg k "$kind" \
    '.holder += { "started-at": $at, "boot-id": (.setup["boot-id"] // null), "credential-kind": (if $k == "" then null else $k end) }'
  jq -nc --arg n "$wsm_id" --arg k "$kind" '{ name: $n, ip: null, "credential-kind": (if $k == "" then null else $k end) }'
}

# wsv_pull_images <project> <id> <boot-id> — ASS-472: each image of the project's images.txt under its registry
# upstream (Artifact Registry, e.g. us-central1-docker.pkg.dev; comments, blank lines and other registries'
# images passed over) pulled on the workstation by on-workstation/pull-images.sh, in one session: a local rebuild
# in zot first (registry:push's, as in a VM), else straight from Artifact Registry in the workstation's own region
# as its service account (the metadata server's token, never one of the Mac's), else through the project's zot at
# 127.0.0.1:<registry.port> (the connection's forward) as before. Each pull logged as it ends (vm:start: workstation
# <id>: pulled <image> from Artifact Registry in 4s (downloaded) …), and the run's summary recorded on the
# workstation's live data as `last-image-pull` { at, boot-id, seconds, from-registry, from-zot, failed, up-to-date,
# zot: [{ image, why }], failures: [{ image, why }] } (AC3). An image that fails both ways leaves the workstation
# the one it has, as before (ASS-473 is to retry it and fail the claim). Nothing to pull (no upstream, no
# images.txt): nothing run or recorded. Fails only when the session itself fails (nothing then recorded as pulled
# for the boot, so the next claim tries again).
wsv_pull_images() {
  local project="$1" id="$2" boot="${3:-}" folder zot fallback image images=() out rc=0 started summary
  source "$here_wsv/registry/registry.bash"   # $root, $local_namespace, registry_upstream
  registry_upstream vm:start "$project" || return 1
  folder="$(jq -r '.["golden-image"].folder // empty' "$projects/$project/project.json")"
  [[ -z "$folder" || "$folder" == /* ]] || folder="$root/$folder"
  [[ -n "$upstream" && -n "$folder" && -f "$folder/images.txt" ]] || return 0
  zot="$(jq -r '.registry.port // empty' "$projects/$project/project.json")"
  while IFS= read -r image || [[ -n "$image" ]]; do   # a last line with no newline too
    if [[ "$image" == "$upstream"/?* ]]; then images+=("$image"); fi
  done < <(sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$folder/images.txt")
  [[ ${#images[@]} -gt 0 ]] || return 0
  fallback="no zot to fall back on"; [[ -z "$zot" ]] || fallback="zot (127.0.0.1:$zot) the fallback"
  echo "vm:start: pulling ${#images[@]} images on workstation $id: Artifact Registry ($upstream) first, $fallback" >&2
  started=$SECONDS
  out="$(workstation_ssh "$project" "$id" bash -s -- "$upstream" "$zot" "$local_namespace" "${images[@]}" < "$wsv_pull_script" 2> >(sed "s/^/vm:start: workstation $id: /" >&2) 7>&-)" || rc=$?
  summary="$({ grep $'^!pull\t' <<< "$out" || true; } | jq -R -s -c --arg b "$boot" --argjson s "$(( SECONDS - started ))" '
    [split("\n")[] | select(length > 0) | split("\t") | { image: .[1], source: .[2], status: .[4], why: (.[5] // "") }] as $p
    | def count(f): [$p[] | select(f)] | length;
    { "boot-id": (if $b == "" then null else $b end), seconds: $s,
      "from-registry": count(.source == "registry"), "from-zot": count(.source == "zot"), failed: count(.source == "failed"),
      "up-to-date": count(.status == "up-to-date"),
      zot: [$p[] | select(.source == "zot") | { image, why }], failures: [$p[] | select(.source == "failed") | { image, why }] }')"
  [[ $rc -eq 0 ]] || summary="$(jq -c --arg e "the session on the workstation failed (exit $rc)" '. + { error: $e }' <<< "$summary")"
  workstation_record "$project" "$id" --argjson s "$summary" '.["last-image-pull"] = ({ at: $at } + $s)'
  jq -r '"vm:start: workstation \($id): images pulled in \(.seconds)s: \(.["from-registry"]) from Artifact Registry, \(.["from-zot"]) through zot, \(.failed) failed (\(.["up-to-date"]) already up to date)"' --arg id "$id" <<< "$summary" >&2
  return "$rc"
}

wsv_specs() {
  local command="$1" project="$2" key="$3" variation="$4" plan
  # A variation set aside or gone from the sprint has none to read: every repository then on master (a step's end
  # needs no branch: it pushes whatever local branch has commits).
  plan="$("$agent" ticket:merge-request-plan "$project" "$key" "$variation" 2>/dev/null 7>&-)" || { echo "$command: could not read $key $variation's merge-request plan; its repositories are taken as planning nothing" >&2; plan='[]'; }
  # Its branch in each repository: the plan's entry there not Merged or Closed (an entry naming no repository —
  # an id-less one ticket:sync found on the forge, ASS-321 — is in none, and is passed over).
  jq -r --argjson plan "$plan" '.repositories[]?.url as $url
    | (first($plan[] | select(.repository != null and .repository == $url and ((.status // "") | IN("Merged", "Closed") | not) and (.branch // "") != "")) // {}) as $m
    | "\($url | sub("\\.git$"; "") | split("/") | last):\($m.branch // ""):\($m.base // ""):\($url)"' "$projects/$project/project.json"
}

wsv_trees() {
  local command="$1" machine="$2" mode="$3" project="$4" key="$5" variation="$6" specs=() rc=0 out tmp slug
  local args=()
  out="$(wsv_specs "$command" "$project" "$key" "$variation")" || return 1
  [[ -z "$out" ]] || mapfile -t specs <<< "$out"
  if [[ "$mode" == start ]]; then
    slug="$key"; [[ "$variation" == A ]] || slug="$key.$variation"
    args=(start "$slug")
  else
    args=(end "${7:-incomplete}" "${8:-$key $variation: work its step left uncommitted, committed by the harness at the end of the step (ASS-468)}")
  fi
  tmp="$(mktemp -d)"
  cat "$wsv_hooks_script" "$wsv_trees_script" | machine_run --workdir / "$machine" -- bash -s -- "${args[@]}" "${specs[@]+"${specs[@]}"}" > "$tmp/out" 2> "$tmp/err" 7>&- || rc=$?
  sed "s/^/$command: $key $variation: /" "$tmp/err" >&2
  grep -v '^!' "$tmp/out" | sed "s/^/$command: $key $variation: /" >&2
  awk -F'\t' -v rc="$rc" 'BEGIN { p = ""; f = ""; c = ""; d = ""; m = ""; u = "" }
    function q(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); return "\"" s "\"" }
    function list(s) { n = split(s, a, ","); r = ""; for (i = 1; i <= n; i++) if (a[i] != "") r = r (r ? "," : "") q(a[i]); return "[" r "]" }
    $1 == "!pushed" { p = p (p ? "," : "") "{\"repository\":" q($2) ",\"branch\":" q($3) ",\"commits\":" ($4 + 0) "}" }
    $1 == "!push-failed" { f = f (f ? "," : "") "{\"repository\":" q($2) ",\"branch\":" q($3) ",\"why\":" q($4) "}" }
    $1 == "!committed" { c = c (c ? "," : "") "{\"repository\":" q($2) ",\"branch\":" q($3) ",\"files\":" list($4) "}" }
    $1 == "!discarded" { d = d (d ? "," : "") "{\"repository\":" q($2) ",\"branch\":" q($3) ",\"files\":" list($4) "}" }
    $1 == "!master-reset" { m = m (m ? "," : "") "{\"repository\":" q($2) ",\"branch\":" q($3) ",\"commits\":" q($4) "}" }
    $1 == "!unclean" { u = u (u ? "," : "") "{\"repository\":" q($2) ",\"why\":" q($3) "}" }
    END { print "{\"pushed\":[" p "],\"push-failed\":[" f "],\"committed\":[" c "],\"discarded\":[" d "],\"master-reset\":[" m "],\"unclean\":[" u "],\"exit\":" rc "}" }' "$tmp/out"
  rm -rf "$tmp"
  [[ $rc -eq 0 ]] || { echo "$command: $key $variation's working trees in $machine are not clean (exit $rc)" >&2; return 1; }
}

wsv_release() {
  local command="$1" project="$2" id="$3" why="${4:-}" holder key variation folder machine old="" summary rc=0 docker_out
  holder="$(workstation_entry "$project" "$id" | jq -c '.holder // empty')"
  [[ -n "$holder" ]] || { jq -nc '{ released: null }'; return 0; }
  IFS=$'\t' read -r key variation folder < <(jq -r '[.ticket, .variation, (.folder // "")] | @tsv' <<< "$holder")
  summary='{"pushed":[],"push-failed":[],"committed":[],"discarded":[],"master-reset":[],"unclean":[]}'
  if [[ -n "$folder" ]]; then
    [[ "$folder" == /*/harness || "$folder" == /*/harness/* ]] && [[ "$folder" != *:* ]] || { echo "$command: $project's workstation $id records a folder outside ~/harness ($folder); not touched" >&2; return 1; }
    [[ "$folder" == */harness ]] || old=old   # ASS-435's folder of its own (~/harness/<KEY>-<variation>): the migration (below)
    workstation_alive "$project" "$id" || { echo "$command: $project's workstation $id has no open connection: $key $variation's step there cannot be ended yet" >&2; return 1; }
    machine="workstation:$project:$id:$folder"
    # Its working trees (AC3, AC9, AC10): a completed step's leftovers committed on its branch ($wsv_completed, the caller's),
    # an incomplete one's discarded; committed work pushed; master at GitLab's latest.
    if workstation_ssh "$project" "$id" test -d "$folder/repos" </dev/null; then
      summary="$(wsv_trees "$command" "$machine" end "$project" "$key" "$variation" "${wsv_completed:-incomplete}" "${wsv_message:-}")" || rc=$?
      if [[ $rc -ne 0 ]]; then
        if [[ -z "$old" ]]; then echo "$command: $project's workstation $id kept by $key $variation: its working trees are not clean yet, so it is not freed" >&2; return 1; fi
        echo "$command: $key $variation's folder $folder: its working trees could not all be cleaned; it is removed all the same" >&2
      fi
    fi
    # The step's containers — working in the shared repositories or the ticket's copy (the variation's folder, for one
    # from before ASS-468), or mounting anything there — their anonymous volumes, and their compose projects' named
    # volumes and networks.
    docker_out="$(workstation_ssh "$project" "$id" bash -s "$folder" "$old" <<'EOF' 7>&-
set -uo pipefail
f="$1" old="$2"
[ -r "$HOME/harness/env" ] && . "$HOME/harness/env"
if [ -n "$old" ]; then under=("$f"); else under=("$f/repos" "$f/ticket"); fi
if command -v docker >/dev/null 2>&1 && ids="$(docker ps -aq 2>/dev/null)" && [ -n "$ids" ]; then
  projects=""
  while read -r id cp paths; do
    for p in $paths; do
      for u in "${under[@]}"; do
        case "$p" in "$u"|"$u"/*)
          if docker rm -f -v "$id" >/dev/null 2>&1; then echo "removed container $id"; else echo "could not remove container $id" >&2; fi
          [ -z "$cp" ] || [ "$cp" = "-" ] || projects="$projects $cp"
          continue 3 ;;
        esac
      done
    done
  done < <(docker inspect --format '{{.Id}} {{or (index .Config.Labels "com.docker.compose.project") "-"}} {{index .Config.Labels "com.docker.compose.project.working_dir"}}{{range .Mounts}} {{.Source}}{{end}}' $ids 2>/dev/null)
  for cp in $(tr ' ' '\n' <<< "$projects" | sort -u); do
    for v in $(docker volume ls -q --filter "label=com.docker.compose.project=$cp" 2>/dev/null); do docker volume rm -f "$v" >/dev/null 2>&1 && echo "removed volume $v"; done
    for n in $(docker network ls -q --filter "label=com.docker.compose.project=$cp" 2>/dev/null); do docker network rm "$n" >/dev/null 2>&1 && echo "removed network $n"; done
  done
fi
if [ -n "$old" ]; then
  case "$f" in "$HOME/harness/"?*) ;; *) echo "not under $HOME/harness: $f" >&2; exit 1 ;; esac
  case "${f#"$HOME/harness/"}" in bin|lib|tools|env|setup.json|golden-image|repos|ticket|mnt|run|*/*) echo "not a variation's folder: $f" >&2; exit 1 ;; esac
  [ ! -e "$f" ] || { chmod -R u+w "$f" 2>/dev/null; rm -rf "$f"; } || exit 1
  [ ! -e "$f" ] || { echo "$f is still there" >&2; exit 1; }
  echo "removed its folder $f"
else
  [ ! -e "$f/ticket" ] || { chmod -R u+w "$f/ticket" 2>/dev/null; rm -rf "$f/ticket"; mkdir -p "$f/ticket"; }
fi
# The credentials and forwarder token vm:start and vm:credentials put in the runtime folder; setup's agent-url stays.
R="${HARNESS_RUNTIME-}"
[ -z "$R" ] || rm -rf "$R/env" "$R/gitconfig" "$R/npmrc" "$R/agent-token" "$R/gh" "$R/glab"
EOF
)" || { echo "$command: could not clean up after $key $variation's step on $project's workstation $id" >&2; return 1; }
    [[ -z "$docker_out" ]] || sed "s/^/$command: $key $variation: /" <<< "$docker_out" >&2
    [[ ! -f "$tokens_file" ]] || update_json "$tokens_file" --arg n "$machine" 'del(.[$n])'
  fi
  wsv_set_on "$project" "$key" "$variation" "$id" "" 2>/dev/null || true
  workstation_record "$project" "$id" 'del(.holder)'
  echo "$command: $project's workstation $id freed: $key $variation's step ended there${old:+, its folder $folder removed (a holder from before ASS-468)}${why:+ ($why)}" >&2
  jq -c --arg k "$key" --arg v "$variation" --arg f "$folder" --arg old "$old" '{ released: { ticket: $k, variation: $v, folder: $f, migrated: ($old != "") } } + .' <<< "$summary"
}
