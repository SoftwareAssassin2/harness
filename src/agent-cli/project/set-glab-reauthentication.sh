#!/usr/bin/env bash
# Description: Record whether a project's glab login has expired — project:set-glab-reauthentication <project> <true|false>.
set -euo pipefail

# Writes true while the user's glab login has expired, as control finds it
# for a project with check-for-expired-glab-auth (ASS-61), to
# data/projects/<project>/glab-requires-reauthentication — the dashboard then says
# to run glab auth login. See reauthentication.bash.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../reauthentication.bash"
set_reauthentication glab "$@"
