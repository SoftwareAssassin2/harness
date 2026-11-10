#!/usr/bin/env bash
# Description: Keep the tickets a project's tickets depend on that its sprint and backlog do not hold — ticket:sync-outside <project> <json-file>.
set -euo pipefail

# The downloader's write of a project's outside dependencies (ASS-355): the
# Jira tickets its sprint and backlog tickets depend on (their
# `dependencies`) that neither holds — assigned to a teammate, say — read by
# key each cycle. <json-file> holds { "fetched-at", "keys": [ the keys
# wanted ], "tickets": [ { key, title, url, ticket-system-status,
# ticket-system-assignment, … }… ] }; in one locked write (update_json:
# written beside and renamed over, so a reader never sees half of it)
# data/projects/<project>/outside-tickets.json becomes { "fetched-at",
# "tickets": [ { key, title, url, ticket-system-status,
# ticket-system-assignment } ] }, by key: each fetched ticket as fetched (its
# other fields dropped), one wanted but not fetched (a read that failed) kept
# as it was, one no longer wanted dropped. No keys empties it. Made when
# missing. Control and the dashboard judge dependencies against it
# (src/control/dependencies.js). Prints `synced <n> outside tickets`. Fails,
# writing nothing, on a bad or missing project, a missing file, or one not of
# that shape. PROJECTS_DIR overrides the projects folder, used by tests.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

[[ $# -eq 2 ]] || { echo "usage: ticket:sync-outside <project> <json-file>" >&2; exit 1; }
project="$1" fetched="$2"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ticket:sync-outside: invalid project '$project'" >&2; exit 1; }
[[ -f "$projects/$project/project.json" ]] || { echo "ticket:sync-outside: no project $project" >&2; exit 1; }
[[ -f "$fetched" ]] || { echo "ticket:sync-outside: no file $fetched" >&2; exit 1; }
jq -e '(.keys | type == "array" and all(type == "string")) and (.tickets | type == "array" and all(type == "object" and (.key | type == "string")))' "$fetched" >/dev/null 2>&1 \
  || { echo "ticket:sync-outside: $fetched is not { keys: [<key>…], tickets: [{ key, … }] }" >&2; exit 1; }

update_json --create "$projects/$project/outside-tickets.json" --slurpfile f "$fetched" '
  def up: ascii_upcase;
  ($f[0].keys | map(up)) as $want
  | ($f[0].tickets | map(select(.key | up as $k | $want | any(. == $k)))
      | map({ key, title: (.title // ""), url: (.url // null), "ticket-system-status": (."ticket-system-status" // null), "ticket-system-assignment": (."ticket-system-assignment" // null) })) as $new
  | ($new | map(.key | up)) as $got
  | ((.tickets // []) | map(select(.key | up as $k | ($want | any(. == $k)) and ($got | any(. == $k) | not))))  as $kept
  | { "fetched-at": ($f[0]."fetched-at" // null), tickets: ($new + $kept | sort_by(.key)) }'
jq -r '"synced \(.tickets | length) outside tickets"' "$projects/$project/outside-tickets.json"
