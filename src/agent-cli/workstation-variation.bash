# A ticket variation's steps on one of its project's GCP workstations
# (ASS-435, ASS-468): which workstation it records, claiming one for a step
# and giving it back at the step's end, and the step's working trees there
# or, in vm+workstation mode, in its VM. Sourced by vm.bash.
# ASS-481 AC3: the pool (dev_environments_workstations) holds the project's
# cloud VMs after its workstations, each taken as a workstation is — placed,
# claimed, readied (images pulled once per boot, ASS-472/473) and released
# alike — its machine cloud-vm:<project>:<id>:<root> and its claim recorded
# with kind cloud-vm.
#
#   wsv_root <home>                             # the workstation's shared root: <home>/harness (repos/, ticket/, mnt/, run/)
#   wsv_place <project> <key> <variation>       # vm:create's choice of workstation, recorded on the variation ($wsv_machine);
#                                               # 4 when none can be used ($wsv_why). Claims nothing.
#   wsv_claim <project> <key> <variation> [<id>]   # a free, usable workstation (only <id>, given: ASS-469) claimed for one step: its holder set, the variation's
#                                               # `workstation` recorded, readied (wsv_start) and its trees on the variation's
#                                               # branches (wsv_trees start); prints { name, machine, … }; 4 when none is free ($wsv_why);
#                                               # 5 when an image it needs could not be pulled and is not there (ASS-473)
#   wsv_start <project> <key> <variation> <machine>    # readied for its holder: credentials, forwarder token, ticket copy, images
#   wsv_pull_images <project> <id> <boot-id>        # images.txt pulled there, Artifact Registry first, zot the fallback (ASS-472)
#   wsv_release <command> <project> <id> [<why>]       # the holder's step ended: its trees committed or cleaned, pushed, its
#                                               # containers, credentials and token removed, the workstation freed; prints a summary
#   wsv_specs <command> <project> <key> <variation>    # a "<name>:<branch>:<base>:<url>" line per repository (step-trees.sh)
#   wsv_trees <command> <machine> start <project> <key> <variation>   # step-trees.sh (git-hooks.sh before it) run there;
#   wsv_trees <command> <machine> end <project> <key> <variation> <completed|incomplete> [<message>]   # prints a summary
#                                               # (ASS-480: its "set-aside", [{ repository, branch, ref, commits, why }],
#                                               # the stray local branches step-trees.sh kept under refs/harness/stray/, start or end)
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

# $wsv_set_up — a jq test of a live data entry: set up since its connection opened (src/control/workstation-connection.js
# setUp's rule) — or, ASS-481 AC3, a cloud VM's (its whole disk kept across a stop) set up under the boot it runs now.
# shellcheck disable=SC2016
wsv_set_up='.setup.ok == true and ((.setup["checked-at"] // "") >= (.["connected-at"] // "") or ((.["boot-id"] // "") != "" and .setup["boot-id"] == .["boot-id"]))'

wsv_root() { echo "$1/harness"; }

# ASS-529: a machine takes several of its project's tickets at once, each step in a folder of its own there — a slot.
# Slot 0 is the shared root, <home>/harness, its holder the live data's `holder` (as before); slot n (1, 2, …) is
# <home>/harness/slots/<n>, its holder `holders["<n>"]`. Each slot's folder stands in for a VM's root as the shared
# root does (repos/, ticket/, mnt/, run/ — its repositories cloned once into it, cloned with the shared root's as a
# reference when there, and kept clean on master between steps), so one ticket's steps never touch another's
# checkout; and its machine, <kind>:<project>:<id>:<folder>, is its own, so its forwarder binding is too. The slot's
# slot.env, sourced by every session there (machine-workstation.bash wsm_enter), depends on the project's
# dev-environments ticket-isolation (wsv_isolation). one-at-a-time, the default: nothing is added to its sessions
# (its test and CI steps run one at a time per machine, control's rule) — slot 0 has no slot.env, exactly as before
# ASS-529; slot n's names only AGENT_TOKEN_FILE (its own forwarder token, agent-token-<n> in the runtime folder; slot
# 0's stays agent-token). separate (opt-in): every slot's names HARNESS_TICKET, HARNESS_VARIATION, HARNESS_SLOT,
# HARNESS_PORT_OFFSET (100 × the slot: the project's compose files and test scripts add it to the ports they bind),
# COMPOSE_PROJECT_NAME harness-slot<n> (its containers, volumes, networks and so its databases named apart) and
# AGENT_TOKEN_FILE. The credentials in the runtime folder
# are the project's and shared (machines are never shared between projects); a step's end removes them only when no
# other slot is held.
#   $wsv_holders — a jq filter: a live data entry → its holders, [{ …, slot }], slot 0 first.
# shellcheck disable=SC2016
wsv_holders='[(if .holder then [.holder + { slot: (.holder.slot // 0) }] else [] end)[], ((.holders // {}) | to_entries | sort_by(.key | tonumber) | map(.value + { slot: (.value.slot // (.key | tonumber)) }))[]]'
# wsv_isolation <project> — its dev-environments ticket-isolation: one-at-a-time (the default, unset) or separate.
wsv_isolation() { jq -r '."dev-environments"."ticket-isolation" // "one-at-a-time"' "$projects/$1/project.json"; }
# wsv_slot_root <home> <slot> — the slot's folder.
wsv_slot_root() { if [[ "$2" == 0 ]]; then wsv_root "$1"; else echo "$(wsv_root "$1")/slots/$2"; fi; }
# wsv_token_name <slot> — the slot's forwarder token file in the runtime folder.
wsv_token_name() { if [[ "$1" == 0 ]]; then echo agent-token; else echo "agent-token-$1"; fi; }
# wsv_on_holder <filter> — a jq filter (given $f, a slot's folder): <filter> applied to the holder of that folder.
wsv_on_holder() { echo "if (.holder.folder // \"\") == \$f then .holder |= ($1) else .holders = ((.holders // {}) | with_entries(if .value.folder == \$f then .value |= ($1) else . end)) end"; }

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
  if ! workstation_entry "$project" "$id" | jq -e "$wsv_set_up" >/dev/null; then
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
  jq -e "$wsv_set_up"' and (.setup.home // "" | startswith("/"))' >/dev/null <<< "$e" || echo "being set up"
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
    wsv_machine="$(workstation_kind "$ws"):$project:$id:$(wsv_root "$home")"
    return 0
  done < <(dev_environments_workstations vm:create "$project")
  wsv_why="no workstation of $project's can be used: $(printf '%s; ' "${why[@]+"${why[@]}"}" | sed 's/; $//')"
  return 4
}

# wsv_set_on <project> <key> <variation> <id> <folder>|"" [<kind>] — the variation's `workstation`, the step's claim,
# recorded (or removed); ASS-481: kind cloud-vm recorded on it for a cloud VM's (a workstation's has none).
wsv_set_on() {
  update_whole_ticket vm:workstation "$1" "$2" --arg name "$3" --arg id "$4" --arg f "${5-}" --arg p "$1" --arg k "${6:-workstation}" '
    .variations |= map(if .name != $name or .["is-deleted"] then .
      elif $f == "" then (if .workstation.name == $id then del(.workstation) else . end)
      else .workstation = ({ name: $id, project: $p, folder: $f, since: $at } + (if $k == "workstation" then {} else { kind: $k } end))
        | if ((.vm.kind // "") | IN("workstation", "cloud-vm")) and .vm.name == $id then .vm.folder = $f else . end end)' >/dev/null
}

# ASS-553: a ticket's worktree on a workstation or cloud VM (run targets workstation-worktree, cloud-vm-worktree):
# workstation:claim --workstation <id> --worktree ($wsv_worktree=1) takes a slot as above — a holder in `holders`, its
# number (never 0: the shared root stays the plain steps') naming its forwarder token and slot.env — but its folder is
# the variation's own, <home>/harness/worktrees/<KEY>[.<variation>] (wsv_worktree_root), kept between its steps and
# never given to another ticket: its checkout (each repository cloned once, the shared root's as a reference) and what
# its steps leave ignored there (dependencies, build caches) stay its own. The variation records it as one of its
# `remote-worktrees` [{ name, project, kind, folder, since }], which workstation:remove-worktree removes once the ticket
# is done (control: run-target-places.js removeDoneWorktrees). A step's end (wsv_release) ends it as any slot's: its
# work committed and pushed, the folder kept.
#   wsv_worktree_root <home> <key> <variation> — the variation's worktree folder on the machine.
wsv_worktree_root() { if [[ "$3" == A ]]; then echo "$(wsv_root "$1")/worktrees/$2"; else echo "$(wsv_root "$1")/worktrees/$2.$3"; fi; }
# $wsv_worktree_folder — a regex: a folder that is a worktree's (never removed by a step's end, nor taken as ASS-435's).
wsv_worktree_folder='/harness/worktrees/[A-Za-z0-9][A-Za-z0-9._-]*$'

# wsv_note_worktree <project> <key> <variation> <id> <folder> <kind> — the variation's remote-worktrees gets it (once).
wsv_note_worktree() {
  update_whole_ticket vm:workstation "$1" "$2" --arg name "$3" --arg id "$4" --arg f "$5" --arg p "$1" --arg k "$6" '
    .variations |= map(if .name != $name or .["is-deleted"] then .
      else .["remote-worktrees"] = (((.["remote-worktrees"] // []) | map(select(.name != $id or .folder != $f))) + [{ name: $id, project: $p, kind: $k, folder: $f, since: $at }]) end)' >/dev/null
}

wsv_claim() {
  local project="$1" key="$2" variation="$3" only="${4:-}" ws id entry holders home w why=() chosen="" machine root summary kind rc=0 remote=workstation slot=0
  wsv_pool_lock workstation:claim "$project"
  while IFS= read -r ws; do
    id="$(jq -r .id <<< "$ws")"
    [[ -z "$only" || "$id" == "$only" ]] || continue
    entry="$(workstation_entry "$project" "$id")"
    holders="$(jq -r "$wsv_holders"' | map("\(.ticket) \(.variation)") | join(", ")' <<< "$entry")"
    if jq -e --arg k "$key" --arg v "$variation" "$wsv_holders"' | any(.ticket == $k and .variation == $v)' <<< "$entry" >/dev/null; then why+=("$id: $key $variation holds a step there already"); continue; fi
    # ASS-529: --workstation (control's: the variation's seat is on it, its seats from its memory and CPU) takes a free
    # slot beside the other tickets' steps there; without it, as before, only a machine nothing holds.
    if [[ -n "$holders" && -z "$only" ]]; then why+=("$id: held by $holders"); continue; fi
    w="$(wsv_usable "$project" "$id")"
    [[ -z "$w" ]] || { why+=("$id: $w"); continue; }
    home="$(jq -r '.setup.home' <<< "$entry")"
    slot="$(jq -r --argjson from "$([[ -n "${wsv_worktree:-}" ]] && echo 1 || echo 0)" "$wsv_holders"' | map(.slot) as $taken | first(range($from; 1000) | select(. as $n | $taken | any(.[]; . == $n) | not))' <<< "$entry")"
    root="$(wsv_slot_root "$home" "$slot")" chosen="$id" remote="$(workstation_kind "$ws")"
    [[ -z "${wsv_worktree:-}" ]] || root="$(wsv_worktree_root "$home" "$key" "$variation")"
    if [[ "$slot" == 0 ]]; then workstation_record "$project" "$id" --arg k "$key" --arg v "$variation" --arg f "$root" '.holder = { ticket: $k, variation: $v, folder: $f, since: $at }'
    else workstation_record "$project" "$id" --arg k "$key" --arg v "$variation" --arg f "$root" --argjson n "$slot" --arg wt "${wsv_worktree:-}" '.holders[($n | tostring)] = ({ ticket: $k, variation: $v, folder: $f, slot: $n, since: $at } + (if $wt == "" then {} else { worktree: true } end))'; fi
    break
  done < <(dev_environments_workstations workstation:claim "$project")
  exec 7>&-
  if [[ -z "$chosen" ]]; then wsv_why="no workstation of $project's is free: $(printf '%s; ' "${why[@]+"${why[@]}"}" | sed 's/; $//')"; return 4; fi
  id="$chosen" machine="$remote:$project:$chosen:$root"
  if [[ -n "${wsv_worktree:-}" ]]; then echo "workstation:claim: $key $variation claimed $project's $remote $id for a step in its worktree $root (its own, kept between its steps)" >&2
  else echo "workstation:claim: $key $variation claimed $project's $remote $id for a step$([[ "$slot" == 0 ]] || echo " (its folder $root, beside the other tickets' steps there)")" >&2; fi
  # The slot's folder, standing in for a VM's: repos, the ticket's copy (and mnt/ticket to it), run/harness the runtime
  # folder; its slot.env (ASS-529).
  if wsv_set_on "$project" "$key" "$variation" "$id" "$root" "$remote" && workstation_ssh "$project" "$id" bash -c 'set -e; . "$HOME/harness/env"; f="$1" n="$2" k="$3" v="$4" t="$5" i="$6"
      mkdir -p "$f/repos" "$f/mnt" "$f/run" "$f/ticket"; ln -sfn ../ticket "$f/mnt/ticket"; ln -sfn "$HARNESS_RUNTIME" "$f/run/harness"
      if [ "$i" = separate ]; then printf "%s\n" "HARNESS_TICKET=$k" "HARNESS_VARIATION=$v" "HARNESS_SLOT=$n" "HARNESS_PORT_OFFSET=$((n * 100))" "COMPOSE_PROJECT_NAME=harness-slot$n" "AGENT_TOKEN_FILE=$HARNESS_RUNTIME/$t" > "$f/slot.env"
      elif [ "$n" != 0 ]; then printf "%s\n" "AGENT_TOKEN_FILE=$HARNESS_RUNTIME/$t" > "$f/slot.env"
      else rm -f "$f/slot.env"; fi' \
      harness-ws "$root" "$slot" "$key" "$variation" "$(wsv_token_name "$slot")" "$(wsv_isolation "$project")" </dev/null \
    && { kind="$(wsv_start "$project" "$key" "$variation" "$machine" | jq -r '.["credential-kind"] // ""')" || rc=$?; [[ $rc -eq 0 ]]; } \
    && summary="$(wsv_trees workstation:claim "$machine" start "$project" "$key" "$variation")"; then
    [[ -z "${wsv_worktree:-}" ]] || wsv_note_worktree "$project" "$key" "$variation" "$id" "$root" "$remote"
    jq -c --arg n "$id" --arg m "$machine" --arg k "$kind" --arg f "$root" --argjson s "$slot" --arg wt "${wsv_worktree:-}" '{ name: $n, machine: $m, "credential-kind": (if $k == "" then null else $k end), slot: $s, folder: $f } + (if $wt == "" then {} else { worktree: true } end) + .' <<< "$summary"
    return 0
  fi
  wsv_slot="$slot" wsv_release workstation:claim "$project" "$id" "its claim failed" >/dev/null || true
  # ASS-473 AC2: an image missing there fails the claim apart (5), its last line naming each with its error, for
  # control's Health; the workstation given back meanwhile, as for any failed claim.
  if [[ $rc -eq 5 ]]; then
    echo "workstation:claim: $key $variation's step cannot start on workstation $id: images it needs could not be pulled and are not there: $(wsv_missing_images "$project" "$id"); it is given back" >&2
    return 5
  fi
  echo "workstation:claim: $key $variation's step could not be readied on workstation $id; it is given back" >&2
  return 1
}

wsv_start() {
  local project="$1" key="$2" variation="$3" machine="$4" entry kind token binding boot registry slot
  wsm_parts "${machine#*:}" || exit 1
  [[ "$wsm_project" == "$project" ]] || { echo "vm:start: $key $variation's workstation machine is $wsm_project's, not $project's" >&2; return 1; }
  slot="$(workstation_entry "$project" "$wsm_id" | jq -r --arg k "$key" --arg v "$variation" --arg f "$wsm_folder" "$wsv_holders"' | map(select(.ticket == $k and .variation == $v and .folder == $f)) | first | .slot // empty')"
  [[ -n "$slot" ]] || { echo "vm:start: $project's workstation $wsm_id is not held by $key $variation (control claims it for each of its steps: workstation:claim)" >&2; return 1; }
  wsv_ready "$project" "$wsm_id" || { echo "vm:start: $wsv_why" >&2; return 1; }
  workstation_ssh "$wsm_project" "$wsm_id" bash -c '. "$HOME/harness/env"; mkdir -p "$1/repos" "$1/run" && ln -sfn "$HARNESS_RUNTIME" "$1/run/harness"' harness-ws "$wsm_folder" </dev/null \
    || { echo "vm:start: could not link $wsm_folder/run/harness on workstation $wsm_id" >&2; return 1; }

  # ASS-477: the harness's Docker config (~/harness/docker, DOCKER_CONFIG in the harness's sessions) made again from
  # the owner's ~/.docker/config.json at each step's claim, so a change the owner made since reaches this step's
  # agents, the project's Artifact Registry host still sent to docker-credential-harness (the workstation's service
  # account). Its failure is a warning: the config the last setup or claim wrote stays.
  registry="$(jq -r '.registry.upstream.host // empty' "$projects/$project/project.json")"
  if [[ -n "$registry" ]]; then
    workstation_ssh "$wsm_project" "$wsm_id" bash -c '. "$HOME/harness/env"; docker-credential-harness configure "$1"' harness-ws "$registry" </dev/null \
      || echo "vm:start: warning: the harness's Docker config on workstation $wsm_id could not be made again from the owner's; the last one stays" >&2
  fi

  kind="$("$agent" vm:credentials "$project" "$machine" 7>&-)" || return 1
  [[ "$kind" =~ ^(claude|anthropic|both)?$ ]] || { echo "vm:start: vm:credentials printed no credential kind for $machine: '$kind'" >&2; return 1; }

  token="$(openssl rand -hex 32)"
  binding="$(jq -nc --arg p "$project" --arg k "$key" --arg v "$variation" --arg f "$(ticket_folder vm:start "$project" "$key")" \
    --arg h "$(printf '%s' "$token" | shasum -a 256 | cut -d' ' -f1)" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg m "$machine" \
    '{ project: $p, ticket: $k, variation: $v, "ticket-folder": $f, "token-sha256": $h, "issued-at": $at, machine: $m }')"
  mkdir -p "$(dirname "$tokens_file")"
  (umask 077; update_json --create "$tokens_file" --arg vm "$machine" --argjson b "$binding" '.[$vm] = $b')
  printf '%s\n' "$token" | workstation_ssh "$wsm_project" "$wsm_id" bash -c 'set -e; umask 077; . "$HOME/harness/env"; IFS= read -r t; printf "%s\n" "$t" > "$HARNESS_RUNTIME/$1"' harness-ws "$(wsv_token_name "$slot")" \
    || { echo "vm:start: could not give workstation $wsm_id its forwarder token" >&2; return 1; }

  wsm_sync_ticket "${machine#*:}" "$(ticket_folder vm:start "$project" "$key")" >/dev/null \
    || { echo "vm:start: could not copy $key's ticket folder to $wsm_folder/ticket on workstation $wsm_id" >&2; return 1; }

  # AC5 (ASS-435): the project's images, once per boot of the workstation (images-boot-id, ASS-468), not at every
  # step's claim: its Docker's images persist under /home. ASS-472: straight from Artifact Registry there, zot the
  # fallback (wsv_pull_images).
  boot="$(workstation_entry "$project" "$wsm_id" | jq -r '.setup["boot-id"] // empty')"
  # ASS-473 AC2: an image that could not be pulled and is not there fails the step's readying (5, each named with
  # its error), so no agent of it starts without it; images-boot-id unrecorded, the next claim pulls again.
  if [[ "$(workstation_entry "$project" "$wsm_id" | jq -r '.["images-boot-id"] // empty')" != "$boot" ]]; then
    if wsv_pull_images "$project" "$wsm_id" "$boot"; then workstation_record "$project" "$wsm_id" --arg b "$boot" '.["images-boot-id"] = $b'
    elif [[ $? -eq 5 ]]; then
      echo "vm:start: workstation $wsm_id lacks images its step needs, which could not be pulled: $(wsv_missing_images "$project" "$wsm_id")" >&2
      return 5
    else echo "vm:start: the images could not be pulled on workstation $wsm_id; they are tried again at its next step's claim" >&2; fi
  fi

  workstation_record "$project" "$wsm_id" --arg k "$kind" --arg f "$wsm_folder" \
    "(.setup[\"boot-id\"] // null) as \$boot | $(wsv_on_holder '. + { "started-at": $at, "boot-id": $boot, "credential-kind": (if $k == "" then null else $k end) }')"
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
# zot: [{ image, why }], failures: [{ image, why, present }], missing } (AC3). ASS-473: each source tried 3 times
# with backoff (pull-images.sh tries); an image that still fails leaves the workstation the one it has — `present`
# when it has one (an older version: a warning, as on a VM), else counted `missing`. Nothing to pull (no upstream,
# no images.txt): nothing run or recorded. Fails (1) when the session itself fails, and (5) when the session ran
# but an image is missing (wsv_missing_images names each): nothing then recorded as pulled for the boot, so the
# next claim tries again.
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
      "up-to-date": count(.status == "up-to-date"), missing: count(.source == "failed" and .status == "missing"),
      zot: [$p[] | select(.source == "zot") | { image, why }],
      failures: [$p[] | select(.source == "failed") | { image, why, present: (.status != "missing") }] }')"
  [[ $rc -eq 0 ]] || summary="$(jq -c --arg e "the session on the workstation failed (exit $rc)" '. + { error: $e }' <<< "$summary")"
  workstation_record "$project" "$id" --argjson s "$summary" '.["last-image-pull"] = ({ at: $at } + $s)'
  jq -r '"vm:start: workstation \($id): images pulled in \(.seconds)s: \(.["from-registry"]) from Artifact Registry, \(.["from-zot"]) through zot, \(.failed) failed\(if .missing > 0 then ", \(.missing) of them not there" else "" end) (\(.["up-to-date"]) already up to date)"' --arg id "$id" <<< "$summary" >&2
  [[ $rc -eq 0 ]] || return "$rc"
  if jq -e '.missing > 0' >/dev/null <<< "$summary"; then return 5; fi
}

# wsv_missing_images <project> <id> — ASS-473: the images its last pull could not pull and it lacks, each with its
# error ("<image> (<why>); …"), from its last-image-pull.
wsv_missing_images() {
  workstation_entry "$1" "$2" | jq -r '[.["last-image-pull"].failures[]? | select(.present == false) | "\(.image) (\(.why))"] | join("; ")'
}

wsv_specs() {
  local command="$1" project="$2" key="$3" variation="$4" plan
  # A variation set aside or gone from the sprint has none to read: every repository then on master (a step's end
  # needs no branch, and pushes nothing then — ASS-478: only its own planned branches are pushed; what it committed
  # stays on its local branch, never pruned while it has work master lacks).
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
  slug="$key"; [[ "$variation" == A ]] || slug="$key.$variation"   # its branches' change/<slug>-<id> (ASS-480: its own, the only ones pushed)
  if [[ "$mode" == start ]]; then
    args=(start "$slug")
  else
    args=(end "$slug" "${7:-incomplete}" "${8:-$key $variation: work its step left uncommitted, committed by the harness at the end of the step (ASS-468)}")
  fi
  tmp="$(mktemp -d)"
  cat "$wsv_hooks_script" "$wsv_trees_script" | machine_run --workdir / "$machine" -- bash -s -- "${args[@]}" "${specs[@]+"${specs[@]}"}" > "$tmp/out" 2> "$tmp/err" 7>&- || rc=$?
  sed "s/^/$command: $key $variation: /" "$tmp/err" >&2
  grep -v '^!' "$tmp/out" | sed "s/^/$command: $key $variation: /" >&2
  awk -F'\t' -v rc="$rc" 'BEGIN { p = ""; f = ""; c = ""; d = ""; m = ""; u = ""; sa = "" }
    function q(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); return "\"" s "\"" }
    function list(s) { n = split(s, a, ","); r = ""; for (i = 1; i <= n; i++) if (a[i] != "") r = r (r ? "," : "") q(a[i]); return "[" r "]" }
    $1 == "!pushed" { p = p (p ? "," : "") "{\"repository\":" q($2) ",\"branch\":" q($3) ",\"commits\":" ($4 + 0) "}" }
    $1 == "!push-failed" { f = f (f ? "," : "") "{\"repository\":" q($2) ",\"branch\":" q($3) ",\"why\":" q($4) "}" }
    $1 == "!committed" { c = c (c ? "," : "") "{\"repository\":" q($2) ",\"branch\":" q($3) ",\"files\":" list($4) "}" }
    $1 == "!discarded" { d = d (d ? "," : "") "{\"repository\":" q($2) ",\"branch\":" q($3) ",\"files\":" list($4) "}" }
    $1 == "!master-reset" { m = m (m ? "," : "") "{\"repository\":" q($2) ",\"branch\":" q($3) ",\"commits\":" q($4) "}" }
    $1 == "!unclean" { u = u (u ? "," : "") "{\"repository\":" q($2) ",\"why\":" q($3) "}" }
    $1 == "!set-aside" { sa = sa (sa ? "," : "") "{\"repository\":" q($2) ",\"branch\":" q($3) ",\"ref\":" q($4) ",\"commits\":" ($5 + 0) ",\"why\":" q($6) "}" }
    END { print "{\"pushed\":[" p "],\"push-failed\":[" f "],\"committed\":[" c "],\"discarded\":[" d "],\"master-reset\":[" m "],\"unclean\":[" u "],\"set-aside\":[" sa "],\"exit\":" rc "}" }' "$tmp/out"
  rm -rf "$tmp"
  [[ $rc -eq 0 ]] || { echo "$command: $key $variation's working trees in $machine are not clean (exit $rc)" >&2; return 1; }
}

wsv_release() {
  local command="$1" project="$2" id="$3" why="${4:-}" holder key variation folder machine old="" summary rc=0 docker_out slot="${wsv_slot:-0}" others
  # ASS-529: the holder of slot $wsv_slot (0, the shared root, by default); the others' steps there go on untouched.
  holder="$(workstation_entry "$project" "$id" | jq -c --argjson n "$slot" "$wsv_holders"' | map(select(.slot == $n)) | first // empty')"
  [[ -n "$holder" ]] || { jq -nc '{ released: null }'; return 0; }
  others="$(workstation_entry "$project" "$id" | jq -r --argjson n "$slot" "$wsv_holders"' | map(select(.slot != $n)) | length')"
  IFS=$'\t' read -r key variation folder < <(jq -r '[.ticket, .variation, (.folder // "")] | @tsv' <<< "$holder")
  summary='{"pushed":[],"push-failed":[],"committed":[],"discarded":[],"master-reset":[],"unclean":[],"set-aside":[]}'
  if [[ -n "$folder" ]]; then
    [[ "$folder" == /*/harness || "$folder" == /*/harness/* ]] && [[ "$folder" != *:* ]] || { echo "$command: $project's workstation $id records a folder outside ~/harness ($folder); not touched" >&2; return 1; }
    [[ "$folder" == */harness || "$folder" =~ /harness/slots/[0-9]+$ || "$folder" =~ $wsv_worktree_folder ]] || old=old   # ASS-435's folder of its own (~/harness/<KEY>-<variation>): the migration (below); ASS-529's slots and ASS-553's worktrees are not
    workstation_alive "$project" "$id" || { echo "$command: $project's workstation $id has no open connection: $key $variation's step there cannot be ended yet" >&2; return 1; }
    machine="$(workstation_kind "$(dev_environments_workstation "$command" "$project" "$id" 2>/dev/null || echo '{}')"):$project:$id:$folder"   # ASS-481: cloud-vm:… for a cloud VM's
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
    docker_out="$(workstation_ssh "$project" "$id" bash -s "$folder" "$old" "$(wsv_token_name "$slot")" "$others" <<'EOF' 7>&-
set -uo pipefail
f="$1" old="$2" token="${3:-agent-token}" others="${4:-0}"
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
# The forwarder token vm:start put in the runtime folder for this slot (ASS-529: each slot its own), and the
# credentials vm:credentials put there — the project's, shared by every slot, so only once no other slot is held;
# setup's agent-url stays.
R="${HARNESS_RUNTIME-}"
[ -z "$R" ] || rm -f "$R/$token"
[ -z "$R" ] || [ "$others" -gt 0 ] || rm -rf "$R/env" "$R/gitconfig" "$R/npmrc" "$R/gh" "$R/glab"
EOF
)" || { echo "$command: could not clean up after $key $variation's step on $project's workstation $id" >&2; return 1; }
    [[ -z "$docker_out" ]] || sed "s/^/$command: $key $variation: /" <<< "$docker_out" >&2
    [[ ! -f "$tokens_file" ]] || update_json "$tokens_file" --arg n "$machine" 'del(.[$n])'
  fi
  wsv_set_on "$project" "$key" "$variation" "$id" "" 2>/dev/null || true
  if [[ "$slot" == 0 ]]; then workstation_record "$project" "$id" 'del(.holder)'
  else workstation_record "$project" "$id" --arg n "$slot" 'del(.holders[$n]) | if (.holders // {}) == {} then del(.holders) else . end'; fi
  echo "$command: $project's workstation $id freed: $key $variation's step ended there${old:+, its folder $folder removed (a holder from before ASS-468)}${why:+ ($why)}" >&2
  jq -c --arg k "$key" --arg v "$variation" --arg f "$folder" --arg old "$old" '{ released: { ticket: $k, variation: $v, folder: $f, migrated: ($old != "") } } + .' <<< "$summary"
}
