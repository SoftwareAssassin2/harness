# arm64 variants of images a project pins but publishes for amd64 only
# (ASS-466), shared by registry:arm64-build and registry:arm64-status (and
# golden.bash, for the golden image's inputs). Sourced after registry.bash,
# registry_config already run.
#
# A ticket's VM is arm64 (Lima vz on Apple Silicon); an amd64-only image runs
# in it emulated, far slower. project.json's "arm64-images" names each image of
# the golden image's images.txt (the project's pins, as vm:build-golden's
# images step reads them) that needs an arm64 build, and how to make it:
#   "arm64-images": [
#     { "image": "<upstream>/<path>",            the pinned name, without its tag
#       "build": { "repository": "<a project repository's name, or a git URL>",
#                  "ref": "<branch, tag or commit; {tag} is the pinned tag>",
#                  "context": "<folder in it, default .>",
#                  "dockerfile": "<file in the context, default Dockerfile>",
#                  "args": { "<build arg>": "<value; {tag} is the pinned tag>" } } },
#     { "image": "<upstream>/<path>",
#       "base-swap": { "base": "<a multi-arch base image>",
#                      "copy": ["<absolute path the image adds over its base>", …] } }
#   ]
# — exactly one of build (the image's own Dockerfile, built for linux/arm64) and
# base-swap (for a thin layer over a multi-arch base: the base's arm64 image
# with the listed paths copied from the pinned amd64 image; the image's
# command and environment are the base's).
#
# The variant goes to the project's zot as 0local/<path>:<tag>, the namespace a
# VM's hosts.toml asks first (registry:hosts-toml), as a multi-arch index: the
# upstream's amd64 manifest (bytes and digest unchanged, its blobs copied in
# from zot's cache) and the arm64 build. A VM pulling <upstream>/<path>:<tag>
# gets the index from 0local and takes its linux/arm64 image; with no variant
# 0local answers 404 and the pull falls through to the cache, amd64, as before.
# What was built is recorded in <storage>/arm64.json:
#   { "<image>": { tag, digest (the arm64 manifest's), index, amd64, "built-at" } }
#
#   arm64_declarations <command> <project>  validates them (each problem said,
#       naming <command>; fails on any) and sets $arm64 — the declarations as
#       a compact JSON array, each with path and tag (its pin) added and {tag}
#       filled in, and a build's repository resolved to its URL — and
#       $arm64_accept (the Accept header for any manifest)
#   arm64_present <path> <tag>  0local/<path>:<tag> is an index with a
#       linux/arm64 image, zot holding it and every image it names; prints
#       the index (its digest on line 1, then the JSON)
arm64_accept='application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'

# arm64_pins <project> — images.txt's pins by tag under the upstream, as a JSON array of { image, path, tag }.
arm64_pins() {
  local folder line
  folder="$(jq -r '.["golden-image"].folder // empty' "$projects/$1/project.json")"
  [[ -z "$folder" || "$folder" == /* ]] || folder="$root/$folder"
  {
    if [[ -n "$folder" && -f "$folder/images.txt" ]]; then
      while IFS= read -r line; do
        line="${line#"${line%%[![:space:]]*}"}" line="${line%"${line##*[![:space:]]}"}"
        [[ "$line" =~ $pushable ]] || continue
        jq -nc --arg i "$upstream/${BASH_REMATCH[1]}" --arg p "${BASH_REMATCH[1]}" --arg t "${BASH_REMATCH[2]}" '{ image: $i, path: $p, tag: $t }'
      done < "$folder/images.txt"
    fi
  } | jq -sc .
}

arm64_declarations() {
  local command="$1" project="$2" pins errors
  arm64="[]"
  jq -e 'has("arm64-images")' "$projects/$project/project.json" >/dev/null || return 0
  [[ -n "$upstream" ]] || { echo "$command: $project declares arm64-images, but its registry has no upstream to pull the images it pins from" >&2; return 1; }
  pins="$(arm64_pins "$project")"
  errors="$(jq -r --argjson pins "$pins" --arg host "$upstream" '
    .repositories as $repos
    | .["arm64-images"] as $d
    | if ($d | type) != "array" then "arm64-images must be a list of { image, build or base-swap }"
      else $d | to_entries[] | .key as $i | .value as $e
      | "arm64-images[\($i)]\(if ($e | type) == "object" and ($e.image | type) == "string" then " (\($e.image))" else "" end)" as $at
      | if ($e | type) != "object" then "\($at) must be an object: { image, build or base-swap }"
        else
          (if ($e.image | type) != "string" or ($e.image | length) == 0 then "\($at) needs an image: its name in images.txt, without its tag"
           elif ($e.image | test("@|:[^/]*$")) then "\($at): image is the name alone, without a tag or digest (the tag is the one images.txt pins)"
           elif ($e.image | startswith("\($host)/") | not) then "\($at) is not an image of the registry upstream \($host)"
           elif ([$pins[] | select(.image == $e.image)] | length) == 0 then "\($at) is an unknown image: images.txt pins no \($e.image):<tag>"
           elif ([$d[] | select(type == "object" and .image == $e.image)] | length) > 1 then "\($at) is declared more than once"
           else empty end),
          ($e | keys - ["image", "build", "base-swap"] | .[] | "\($at) has an unknown key \"\(.)\""),
          (if ($e | has("build")) == ($e | has("base-swap")) then "\($at) needs a build source: exactly one of build { repository, ref, … } and base-swap { base, copy }"
           elif $e | has("build") then
             $e.build as $b
             | if ($b | type) != "object" then "\($at) build must be an object: { repository, ref, context, dockerfile, args }"
               else
                 (if ($b.repository | type) != "string" or ($b.repository | length) == 0 then "\($at) build is missing its build source: a repository (a project repository'"'"'s name, or a git URL)"
                  elif ($b.repository | test("://|^/|^[^/@ ]+@[^:]+:")) or ([$repos[]?.url | sub("\\.git$"; "") | split("/") | last] | index($b.repository)) != null then empty
                  else "\($at) build names no repository of the project, nor a git URL: \($b.repository)" end),
                 (if ($b.ref | type) != "string" or ($b.ref | length) == 0 then "\($at) build needs a ref: the branch, tag or commit to build ({tag} is the pinned tag)" else empty end),
                 (if $b | has("context") | not then empty
                  elif ($b.context | type) != "string" or ($b.context | test("^/|(^|/)\\.\\.(/|$)")) then "\($at) build context must be a folder inside the repository" else empty end),
                 (if $b | has("dockerfile") | not then empty
                  elif ($b.dockerfile | type) != "string" or ($b.dockerfile | test("^/|(^|/)\\.\\.(/|$)")) then "\($at) build dockerfile must be a file inside the context" else empty end),
                 (if $b | has("args") | not then empty
                  elif ($b.args | type) != "object" or ([$b.args[] | type] - ["string"] | length) > 0 then "\($at) build args must be an object of strings" else empty end),
                 ($b | keys - ["repository", "ref", "context", "dockerfile", "args"] | .[] | "\($at) build has an unknown key \"\(.)\"")
               end
           else
             $e["base-swap"] as $s
             | if ($s | type) != "object" then "\($at) base-swap must be an object: { base, copy }"
               else
                 (if ($s.base | type) != "string" or ($s.base | length) == 0 then "\($at) base-swap is missing its build source: a base, the multi-arch image the pinned one is a layer over" else empty end),
                 (if ($s.copy | type) != "array" or ($s.copy | length) == 0 or ([$s.copy[] | type == "string" and startswith("/")] | all | not)
                  then "\($at) base-swap needs copy: the absolute paths the pinned image adds over its base" else empty end),
                 ($s | keys - ["base", "copy"] | .[] | "\($at) base-swap has an unknown key \"\(.)\"")
               end
           end)
        end
      end' "$projects/$project/project.json")"
  [[ -z "$errors" ]] || { sed "s/^/$command: $project: /" <<<"$errors" >&2; return 1; }
  arm64="$(jq -c --argjson pins "$pins" '
    .repositories as $repos
    | [.["arm64-images"][] | .image as $image | first($pins[] | select(.image == $image)) as $pin
       | . + { path: $pin.path, tag: $pin.tag }
       | if has("build") then
           .build |= ((.repository as $r | first(($repos[]?.url | select(sub("\\.git$"; "") | split("/") | last == $r)), $r)) as $url
             | { url: $url, ref: (.ref | gsub("\\{tag\\}"; $pin.tag)), context: (.context // "."), dockerfile: (.dockerfile // "Dockerfile"),
                 args: ((.args // {}) | map_values(gsub("\\{tag\\}"; $pin.tag))) })
         else . end]' "$projects/$project/project.json")"
}

arm64_present() {
  local tmp index digest child
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/arm64.XXXXXX")"
  curl -fsS --max-time 10 -D "$tmp/headers" -o "$tmp/index" -H "Accept: $arm64_accept" "http://127.0.0.1:$port/v2/$local_namespace/$1/manifests/$2" 2>/dev/null \
    || { rm -rf "$tmp"; return 1; }
  index="$(cat "$tmp/index")" digest="sha256:$(shasum -a 256 "$tmp/index" | cut -d' ' -f1)"
  rm -rf "$tmp"
  jq -e '(.mediaType == "application/vnd.oci.image.index.v1+json" or .mediaType == "application/vnd.docker.distribution.manifest.list.v2+json")
    and any(.manifests[]; .platform.architecture == "arm64" and .platform.os == "linux")' <<<"$index" >/dev/null 2>&1 || return 1
  for child in $(jq -r '.manifests[].digest' <<<"$index"); do
    curl -fsI -o /dev/null --max-time 10 -H "Accept: $arm64_accept" "http://127.0.0.1:$port/v2/$local_namespace/$1/manifests/$child" || return 1
  done
  printf '%s\n%s\n' "$digest" "$(jq -c . <<<"$index")"
}
