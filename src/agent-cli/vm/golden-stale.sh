#!/usr/bin/env bash
# Description: Whether a project's golden image is stale, and why — vm:golden-stale <project>; prints JSON.
set -euo pipefail

# ASS-149. golden-<project> is stale when the hash its label records
# (golden-image.json, vm:build-golden) is not the hash of its inputs now
# (golden.bash), or it has no label: it was never built. Prints
#   { project, image, stale, hash (the inputs' now), built-hash, built-at, why: [<line>…] }
# — built-hash and built-at null when never built. Why names what changed,
# from the input lines the label records: "added <input>", "removed
# <input>", then "changed <file>" (a file of the definition or the shared
# steps whose sha256 differs), an input a file's path ("definition/<path>",
# "shared/<path>") or the line itself ("repository <url>", a hosts.toml
# line); a label recording no input list, from before ASS-149, says
# "inputs changed since <built-at>; this build recorded no input list"; a
# current image's is empty. Reads, never builds; exits 0 stale or not, and
# fails, naming why, when the project or its definition is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/golden.bash"

[[ $# -eq 1 ]] || { echo "usage: vm:golden-stale <project>" >&2; exit 1; }
golden_definition vm:golden-stale "$1"
label="$(golden_label "$1")"
[[ -f "$label" ]] || label=/dev/null
jq -n --arg p "$1" --arg h "$hash" --arg in "$inputs" --slurpfile l "$label" '
  def key: if test("^[0-9a-f]{64}  ") then .[66:] else . end;
  ($l[0] // null) as $l
  | ($in | rtrimstr("\n") | split("\n") | map(select(length > 0))) as $new
  | ($l.inputs // null | if . == null then null else map(select(length > 0)) end) as $old
  | { project: $p, image: "golden-\($p)", stale: ($l.hash != $h), hash: $h, "built-hash": ($l.hash // null), "built-at": ($l["built-at"] // null) }
  | .why = if .stale | not then []
      elif $l == null then ["golden-\($p) has not been built"]
      elif $old == null then ["inputs changed since \($l["built-at"]); this build recorded no input list"]
      else ($old | map(key)) as $ok | ($new | map(key)) as $nk
        | ([$new[] | select(IN($old[]) | not) | key | select(IN($ok[]) | not)] | unique | map("added " + .))
        + ([$old[] | select(IN($new[]) | not) | key | select(IN($nk[]) | not)] | unique | map("removed " + .))
        + ([$new[] | select(IN($old[]) | not) | key | select(IN($ok[]))] | unique | map("changed " + .))
      end'
