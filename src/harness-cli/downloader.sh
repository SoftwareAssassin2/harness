#!/usr/bin/env bash
# Description: Run the downloader — Jira and GitLab into the projects' JSON, on harness.json's interval; --once for one round, --dry-run to only print the writes.
set -euo pipefail

exec node "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../downloader/main.js" "$@"
