#!/usr/bin/env bash
# Description: The story points a project's estimates take — project:story-point-scale <project>.
set -euo pipefail

# Prints the project's scale as a JSON array (see story_point_scale in
# ticket-system.bash): project.json's story-point-scale, else [1,2,3,5].
# The estimate prompt sizes on it; ticket:set-points accepts only its values.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket-system.bash"

[[ $# -eq 1 ]] || { echo "usage: project:story-point-scale <project>" >&2; exit 1; }
story_point_scale project:story-point-scale "$1"
