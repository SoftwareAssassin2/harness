# A ticket variation on one of its project's GCP workstations (ASS-435):
# placing it, and what vm:create, vm:start and workstation:release do for it
# there, as they do for a VM. Sourced by vm.bash.
#
#   wsv_folder <home> <key> <variation>        # its folder there: <home>/harness/<KEY>-<variation>, never the owner's ~/workspaces
#   wsv_in_flight <project> <key> <variation>  # the variation holds on to its machine: an assignment on it, or live in the
#                                              # sprint at a step whose `vm` is running or stopped (as a VM's is deletable otherwise)
#   wsv_place <project> <key> <variation>      # a free workstation claimed for it ($wsv_machine); 4, claiming none, when none is ($wsv_why)
#   wsv_claim <project> <key> <variation> <id> # that workstation claimed for it, when free; 4 when another in flight holds it ($wsv_why)
#   wsv_create <project> <key> <variation> <machine>   # vm:create's work there; prints { name, machine, ip, created }
#   wsv_start <project> <key> <variation> <machine>    # vm:start's; prints { name, ip, credential-kind }
#   wsv_release <command> <project> <id> [<why>]       # its holder's folder removed and the workstation freed
#
# Placement (AC1; operator decision, 2026-11-14). A project in workstation
# mode runs its ticket variations on its workstations alone, one in
# vm+workstation mode on a free one first and in a VM only when none is free;
# a variation stays where it started (a recorded VM, or workstation, is used
# again). One variation per workstation at a time — a project's Docker
# containers and ports would clash otherwise — recorded in the live data:
# workstations.json's entry's `holder`, { ticket, variation, folder, since,
# boot-id, started-at, credential-kind, credential-stamps } (workstation.bash
# workstation_record), under the project's pool lock (workstations-pool.lock,
# descriptor 7), so two vm:creates never claim one; and on the variation, its
# vm { name: <id>, kind: workstation, project, folder } (ticket:set-vm).
# Free: no holder, the variation's own (a vm:create that failed part way),
# or one no longer in flight (wsv_in_flight: Done, set aside, gone from the
# sprint, at a step that needs no machine, released), which is reclaimed
# (wsv_release) as make_room deletes a VM no variation in flight needs. In
# list order; one whose gcloud login needs reauthentication is passed over,
# and one not connected is connected (workstation:connect, starting it) and
# set up (workstation:setup) first — a failure frees it again and the next is
# tried. A placement is logged on stderr with the workstation.
#
# The variation's folder (AC2) stands in for its VM's root
# (machine-workstation.bash): repos/ the repositories, cloned and checked out
# once (vm:create's script, its .vm-create-checked-out marker); ticket/ the
# ticket's read-only copy (mnt/ticket links to it); run/harness a link to the
# setup's runtime folder, where vm:start puts the forwarder token and
# vm:credentials the credentials, as a VM's /run/harness. Removed whole when
# the variation gives the workstation up (AC6, wsv_release): its
# repositories, the containers working in it or mounting it, the ticket copy,
# and the credentials and token in the runtime folder; nothing else of the
# workstation's (~/harness's bin, lib, tools, env, setup.json, the runtime
# folder's agent-url) or the owner's is touched.
here_wsv="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
wsv_assignments="${ASSIGNMENTS_FILE:-$here_wsv/../../data/assignments.json}"

wsv_folder() { echo "$1/harness/$(tr '[:lower:]' '[:upper:]' <<< "$2")-$3"; }

wsv_pool_lock() { lock_on 7 "$projects/$2/workstations-pool.lock" "$1" "${VM_LOCK_TIMEOUT:-600}"; }

wsv_in_flight() {
  local project="$1" key="$2" variation="$3" sprint
  if [[ -f "$wsv_assignments" ]] && jq -e --arg p "$project" --arg k "$key" --arg v "$variation" \
      'any(.assignments[]?; .project == $p and ((.["work-item"] // "") | ascii_downcase) == ($k | ascii_downcase) and .variation == $v)' "$wsv_assignments" >/dev/null 2>&1; then
    return 0
  fi
  sprint="$(sprint_file wsv "$project" 2>/dev/null)" || return 1
  jq -e -n --slurpfile s "$sprint" --arg k "$key" --arg v "$variation" \
    --slurpfile e <(engine_files "$project" | { mapfile -t list; jq -n 'reduce inputs as $e ({}; .[input_filename | split("/") | .[-2]] = ($e.steps // []))' /dev/null "${list[@]}"; }) '
    $e[0] as $engines
    | first($s[0] | (.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($k | ascii_downcase))
      | .variations // [] | .[] | select(.name == $v and (.["is-deleted"] | not))) // null
    | if . == null then false else
        [.["harness-status"] | recurse(.["sub-status"] // empty) | select(.state != null) | . as $l
          | ($engines[$l["state-engine"]] // [] | map(select(.id == $l.state)) | first | .vm) // empty] | last
        | . == "running" or . == "stopped" end' >/dev/null
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

# wsv_take <project> <key> <variation> <id> — under the pool lock: the workstation claimed for the variation when free
# (reclaimed from a holder no longer in flight); 4, its reason in $wsv_why, when another in flight holds it.
wsv_take() {
  local project="$1" key="$2" variation="$3" id="$4" hk hv
  IFS=$'\t' read -r hk hv < <(workstation_entry "$project" "$id" | jq -r '[.holder.ticket // "", .holder.variation // ""] | @tsv')
  if [[ -n "$hk" && ! ( "${hk^^}" == "${key^^}" && "$hv" == "$variation" ) ]]; then
    if wsv_in_flight "$project" "$hk" "$hv"; then wsv_why="$id: held by $hk $hv"; return 4; fi
    wsv_release vm:create "$project" "$id" "reclaimed for $key $variation" >&2 || { wsv_why="$id: held by $hk $hv, no longer in flight, and could not be reclaimed"; return 4; }
  fi
  workstation_record "$project" "$id" --arg k "$key" --arg v "$variation" \
    'if .holder.ticket == $k and .holder.variation == $v then . else .holder = { ticket: $k, variation: $v, since: $at } end'
}

# wsv_machine_of <project> <key> <variation> <id> — its machine there, the folder under the home its setup recorded.
wsv_machine_of() {
  local home
  home="$(workstation_entry "$1" "$4" | jq -r '.setup.home // empty')"
  [[ "$home" == /* ]] || { wsv_why="$4: its setup recorded no home folder"; return 1; }
  wsv_machine="workstation:$1:$4:$(wsv_folder "$home" "$2" "$3")"
}

wsv_place() {
  local project="$1" key="$2" variation="$3" ws id why=() rc
  wsv_pool_lock vm:create "$project"
  while IFS= read -r ws; do
    id="$(jq -r .id <<< "$ws")"
    if workstation_entry "$project" "$id" | jq -e '.["last-error"].kind == "expired"' >/dev/null; then why+=("$id: its gcloud login needs reauthentication"); continue; fi
    rc=0; wsv_take "$project" "$key" "$variation" "$id" || rc=$?
    if [[ $rc -ne 0 ]]; then why+=("$wsv_why"); continue; fi
    if wsv_ready "$project" "$id" && wsv_machine_of "$project" "$key" "$variation" "$id"; then
      exec 7>&-
      echo "vm:create: $key $variation placed on $project's workstation $id" >&2
      return 0
    fi
    why+=("$wsv_why")
    workstation_record "$project" "$id" --arg k "$key" --arg v "$variation" 'if .holder.ticket == $k and .holder.variation == $v then del(.holder) else . end'
  done < <(dev_environments_workstations vm:create "$project")
  exec 7>&-
  wsv_why="no workstation of $project's is free: $(printf '%s; ' "${why[@]+"${why[@]}"}" | sed 's/; $//')"
  return 4
}

wsv_claim() {
  local project="$1" key="$2" variation="$3" id="$4" rc=0
  wsv_pool_lock vm:create "$project"
  wsv_take "$project" "$key" "$variation" "$id" || rc=$?
  exec 7>&-
  [[ $rc -eq 0 ]] || return "$rc"
  wsv_ready "$project" "$id"
}

wsv_create() {
  local project="$1" key="$2" variation="$3" machine="$4" created=false recreated="" repos
  wsm_parts "${machine#workstation:}" || exit 1
  mapfile -t repos < <(jq -r '.repositories[]?.url | (sub("\\.git$"; "") | split("/") | last), .' "$projects/$project/project.json")   # name, url, …
  if ! workstation_ssh "$wsm_project" "$wsm_id" test -d "$wsm_folder/repos" </dev/null; then
    created=true
    if [[ "$(jq -r --arg key "$key" --arg name "$variation" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
        | first(.variations // [] | .[] | select(.name == $name and (.["is-deleted"] | not))) | .vm.folder // empty' "$(sprint_file vm:create "$project")")" == "$wsm_folder" ]]; then
      recreated=recreated
      echo "vm:create: $key $variation's folder on workstation $wsm_id ($wsm_folder) was removed; it is made again, and whatever was only in it is lost" >&2
    fi
  fi
  "$agent" ticket:set-vm "$project" "$key" "$variation" "$wsm_id" "" $recreated --kind workstation --folder "$wsm_folder" >/dev/null
  workstation_record "$project" "$wsm_id" --arg f "$wsm_folder" '.holder.folder = $f'
  # The folder, standing in for a VM's root: repos, the ticket's copy (and mnt/ticket to it), run/harness the runtime folder.
  workstation_ssh "$wsm_project" "$wsm_id" bash -c 'set -e; . "$HOME/harness/env"; f="$1"
    mkdir -p "$f/repos" "$f/mnt" "$f/run" "$f/ticket"; ln -sfn ../ticket "$f/mnt/ticket"; ln -sfn "$HARNESS_RUNTIME" "$f/run/harness"' harness-ws "$wsm_folder" </dev/null \
    || { echo "vm:create: could not make $key $variation's folder $wsm_folder on workstation $wsm_id" >&2; exit 1; }
  VM_LOCK_HELD=1 "$agent" vm:start "$project" "$key" "$variation" >/dev/null 7>&- || exit 1
  machine_run --workdir / "$machine" -- bash -s "$wsm_id" "${repos[@]}" <<'EOF' || { echo "vm:create: $key $variation's folder on workstation $wsm_id is not usable" >&2; exit 1; }
set -euo pipefail
R="${HARNESS_VM_ROOT:?}"   # the variation's folder on the workstation
ws="$1"; shift
[ -d "$R/ticket" ] || { echo "vm:create: $R/ticket, the ticket's copy, is missing on workstation $ws" >&2; exit 1; }
names=()
while [ $# -gt 0 ]; do
  name="$1" url="$2"; shift 2; names+=("$name")
  [ -d "$R/repos/$name/.git" ] || git clone -q "$url" "$R/repos/$name" || { echo "vm:create: $R/repos/$name is missing on workstation $ws, and could not clone $url" >&2; exit 1; }
done
[ ! -e "$R/repos/.vm-create-checked-out" ] || exit 0
for name in "${names[@]}"; do
  cd "$R/repos/$name"
  branch="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/master)"
  { git fetch -q origin && git checkout -q -B "${branch#origin/}" "$branch"; } || { echo "vm:create: could not check out master (${branch#origin/}) in $R/repos/$name" >&2; exit 1; }
done
touch "$R/repos/.vm-create-checked-out"
EOF
  jq -nc --arg n "$wsm_id" --arg m "$machine" --argjson c "$created" '{ name: $n, machine: $m, ip: null, created: $c }'
}

wsv_start() {
  local project="$1" key="$2" variation="$3" machine="$4" entry kind token binding folder zot image pulled
  wsm_parts "${machine#workstation:}" || exit 1
  [[ "$wsm_project" == "$project" ]] || { echo "vm:start: $key $variation's workstation machine is $wsm_project's, not $project's" >&2; exit 1; }
  workstation_entry "$project" "$wsm_id" | jq -e --arg k "$key" --arg v "$variation" '.holder.ticket == $k and .holder.variation == $v' >/dev/null \
    || { echo "vm:start: $project's workstation $wsm_id is not held by $key $variation (vm:create claims it)" >&2; exit 1; }
  wsv_ready "$project" "$wsm_id" || { echo "vm:start: $wsv_why" >&2; exit 1; }
  workstation_ssh "$wsm_project" "$wsm_id" test -d "$wsm_folder/repos" </dev/null || { echo "vm:start: no folder $wsm_folder on workstation $wsm_id; vm:create makes it" >&2; exit 1; }
  workstation_ssh "$wsm_project" "$wsm_id" bash -c '. "$HOME/harness/env"; ln -sfn "$HARNESS_RUNTIME" "$1/run/harness"' harness-ws "$wsm_folder" </dev/null \
    || { echo "vm:start: could not link $wsm_folder/run/harness on workstation $wsm_id" >&2; exit 1; }

  kind="$("$agent" vm:credentials "$project" "$machine" 7>&-)"
  [[ "$kind" =~ ^(claude|anthropic|both)?$ ]] || { echo "vm:start: vm:credentials printed no credential kind for $machine: '$kind'" >&2; exit 1; }

  token="$(openssl rand -hex 32)"
  binding="$(jq -nc --arg p "$project" --arg k "$key" --arg v "$variation" --arg f "$(ticket_folder vm:start "$project" "$key")" \
    --arg h "$(printf '%s' "$token" | shasum -a 256 | cut -d' ' -f1)" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg m "$machine" \
    '{ project: $p, ticket: $k, variation: $v, "ticket-folder": $f, "token-sha256": $h, "issued-at": $at, machine: $m }')"
  mkdir -p "$(dirname "$tokens_file")"
  (umask 077; update_json --create "$tokens_file" --arg vm "$machine" --argjson b "$binding" '.[$vm] = $b')
  printf '%s\n' "$token" | workstation_ssh "$wsm_project" "$wsm_id" bash -c 'set -e; umask 077; . "$HOME/harness/env"; IFS= read -r t; printf "%s\n" "$t" > "$HARNESS_RUNTIME/agent-token"' \
    || { echo "vm:start: could not give workstation $wsm_id its forwarder token" >&2; exit 1; }

  wsm_sync_ticket "${machine#workstation:}" "$(ticket_folder vm:start "$project" "$key")" >/dev/null \
    || { echo "vm:start: could not copy $key's ticket folder to $wsm_folder/ticket on workstation $wsm_id" >&2; exit 1; }

  # AC5: the project's zot through the connection's forward, on the workstation's loopback — no registry mirror
  # there (its Docker is the config's), so each image by tag is pulled from 127.0.0.1:<port> and tagged as named.
  source "$here_wsv/registry/registry.bash"   # $root, $local_namespace, registry_upstream
  zot="$(jq -r '.registry.port // empty' "$projects/$project/project.json")"
  folder="$(jq -r '.["golden-image"].folder // empty' "$projects/$project/project.json")"
  [[ -z "$folder" || "$folder" == /* ]] || folder="$root/$folder"
  if [[ -n "$zot" && -n "$folder" && -f "$folder/images.txt" ]]; then
    registry_upstream vm:start "$project"
    while IFS= read -r image; do
      [[ "$image" =~ $pushable ]] || continue
      pulled="127.0.0.1:$zot/${BASH_REMATCH[1]}:${BASH_REMATCH[2]}"
      curl -fsI -o /dev/null --max-time 10 -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
        "http://127.0.0.1:$zot/v2/$local_namespace/${BASH_REMATCH[1]}/manifests/${BASH_REMATCH[2]}" && pulled="127.0.0.1:$zot/$local_namespace/${BASH_REMATCH[1]}:${BASH_REMATCH[2]}"
      machine_run "$machine" -- bash -c 'docker pull -q "$1" >/dev/null && docker tag "$1" "$2"' - "$pulled" "$image" </dev/null \
        || echo "vm:start: could not pull $image through $project's registry ($pulled) on workstation $wsm_id; it keeps the image it has" >&2
    done < "$folder/images.txt"
  fi

  workstation_record "$project" "$wsm_id" --arg k "$kind" \
    '.holder += { "started-at": $at, "boot-id": (.setup["boot-id"] // null), "credential-kind": (if $k == "" then null else $k end) }'
  jq -nc --arg n "$wsm_id" --arg k "$kind" '{ name: $n, ip: null, "credential-kind": (if $k == "" then null else $k end) }'
}

wsv_release() {
  local command="$1" project="$2" id="$3" why="${4:-}" holder key variation folder machine
  holder="$(workstation_entry "$project" "$id" | jq -c '.holder // empty')"
  [[ -n "$holder" ]] || return 0
  IFS=$'\t' read -r key variation folder < <(jq -r '[.ticket, .variation, (.folder // "")] | @tsv' <<< "$holder")
  if [[ -n "$folder" ]]; then
    [[ "$folder" == /*/harness/* && "$folder" != *:* ]] || { echo "$command: $project's workstation $id records a folder outside ~/harness ($folder); not removed" >&2; return 1; }
    workstation_alive "$project" "$id" || { echo "$command: $project's workstation $id has no open connection: $key $variation's folder there cannot be removed yet" >&2; return 1; }
    workstation_ssh "$project" "$id" bash -s "$folder" <<'EOF' 7>&- || { echo "$command: could not remove $key $variation's folder $folder on $project's workstation $id" >&2; return 1; }
set -uo pipefail
f="$1"
case "$f" in "$HOME/harness/"?*) ;; *) echo "not under $HOME/harness: $f" >&2; exit 1 ;; esac
case "${f#"$HOME/harness/"}" in bin|lib|tools|env|setup.json|*/*) echo "not a variation's folder: $f" >&2; exit 1 ;; esac
[ -r "$HOME/harness/env" ] && . "$HOME/harness/env"
# The containers working in the folder or mounting anything of it (a dev container's), and their anonymous volumes.
if command -v docker >/dev/null 2>&1 && ids="$(docker ps -aq 2>/dev/null)" && [ -n "$ids" ]; then
  docker inspect --format '{{.Id}} {{index .Config.Labels "com.docker.compose.project.working_dir"}}{{range .Mounts}} {{.Source}}{{end}}' $ids 2>/dev/null \
    | while read -r id paths; do
        for p in $paths; do case "$p" in "$f"|"$f"/*) docker rm -f -v "$id" >/dev/null 2>&1 || echo "could not remove container $id" >&2; break ;; esac; done
      done
fi
[ ! -e "$f" ] || { chmod -R u+w "$f" 2>/dev/null; rm -rf "$f"; } || exit 1
[ ! -e "$f" ] || { echo "$f is still there" >&2; exit 1; }
# The credentials and forwarder token vm:start and vm:credentials put in the runtime folder; setup's agent-url stays.
R="${HARNESS_RUNTIME-}"
[ -z "$R" ] || rm -rf "$R/env" "$R/gitconfig" "$R/npmrc" "$R/agent-token" "$R/gh" "$R/glab"
EOF
    machine="workstation:$project:$id:$folder"
    [[ ! -f "$tokens_file" ]] || update_json "$tokens_file" --arg n "$machine" 'del(.[$n])'
  fi
  workstation_record "$project" "$id" 'del(.holder)'
  echo "$command: $project's workstation $id freed: $key $variation's folder${folder:+ $folder} removed${why:+ ($why)}" >&2
}
