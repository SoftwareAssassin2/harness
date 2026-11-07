#!/bin/bash
# Golden image step (vm:build-golden), shared by every project, last before the
# final stop: removes any container the build left, empties the apt cache,
# truncates /etc/machine-id so each clone gets its own, and trims the disk so
# freed blocks (deleted files' included) go back to the Mac and out of the image.
set -euo pipefail
if command -v docker >/dev/null; then docker ps -aq | xargs -r docker rm -f >/dev/null; fi
sudo apt-get clean
sudo truncate -s 0 /etc/machine-id
sudo fstrim /
