#!/bin/bash
# In a VM, for vm:step-start and vm:refresh-repositories (ASS-503): each
# repository named, /repos/<name>, whose pnpm-lock.yaml differs from the one
# its node_modules was last installed from — the harness's copy of it,
# node_modules/.harness-installed-lock.yaml; none yet in a golden-installed
# one — gets `pnpm install --frozen-lockfile`, so pnpm's verify-deps does not
# refuse its commands once a checkout has moved; the copy is then written.
#   install-deps.sh <repository…>
# Prints "<name>: deps installed|skipped (…)" for each with a pnpm-lock.yaml,
# nothing for the others. A failed install prints "<name>: pnpm install
# --frozen-lockfile failed: <its last lines>" on stderr, goes on with the
# rest, and exits 1.
R="${HARNESS_VM_ROOT-}"   # empty in a VM; tests run this against a folder standing in for its root
# A non-login shell: the registry credentials /etc/profile.d/harness-credentials.sh would source.
if [ -r "$R/run/harness/env" ]; then set -a; . "$R/run/harness/env"; set +a; fi
rc=0
for name in "$@"; do
  d="$R/repos/$name" stamp="node_modules/.harness-installed-lock.yaml"
  [ -f "$d/pnpm-lock.yaml" ] || continue
  if cmp -s "$d/pnpm-lock.yaml" "$d/$stamp"; then echo "$name: deps skipped (pnpm-lock.yaml unchanged)"; continue; fi
  if out="$(cd "$d" && CI=true pnpm install --frozen-lockfile 2>&1 < /dev/null)" && cp "$d/pnpm-lock.yaml" "$d/$stamp"; then
    echo "$name: deps installed (pnpm-lock.yaml changed)"
  else
    echo "$name: pnpm install --frozen-lockfile failed: $(tail -n 20 <<< "$out")" >&2
    rc=1
  fi
done
exit "$rc"
