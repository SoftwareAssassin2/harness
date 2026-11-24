#!/bin/bash
# Builds the spike's sandbox image (image/Dockerfile) for this Mac's arch and
# pushes it to the kind registry (localhost:5001). Usage: build-image.sh <substrate-checkout> <harness-checkout>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; sub="$1"; harness="$2"
ctx="$(mktemp -d /tmp/ASS-532-image.XXXX)"
cp "$here/image/Dockerfile" "$here/image/provision.sh" "$here/tlshold.mjs" "$harness/src/agent-cli/vm/golden-image/git.sh" "$ctx/"
( cd "$sub" && CGO_ENABLED=0 GOOS=linux GOARCH="${ARCH:-arm64}" go build -o "$ctx/sandbox-server" ./demos/sandbox )
git clone -q --no-local "$harness" "$ctx/repo"
time docker buildx build --platform "linux/${ARCH:-arm64}" -t "localhost:5001/harness-sandbox:${TAG:-spike}" --push "$ctx"
rm -rf "$ctx"
