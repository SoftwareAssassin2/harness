#!/usr/bin/env bash
# Description: Record whether a project's gcloud login has expired — project:set-gcloud-reauthentication <project> <true|false>.
set -euo pipefail

# Writes true while the user's gcloud login has expired, as control finds it
# for a project with check-for-expired-gcloud-auth (ASS-28), to
# data/projects/<project>/gcloud-requires-reauthentication — the dashboard then says
# to run gcloud auth login. See reauthentication.bash.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../reauthentication.bash"
set_reauthentication gcloud "$@"
