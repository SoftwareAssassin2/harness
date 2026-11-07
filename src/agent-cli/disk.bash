# The harness's disk (ASS-288): the free space on the volumes holding its VMs
# (LIMA_HOME) and its data folder, against harness.json's disk-free-warn-gb and
# disk-free-hold-gb (GB, 10^9 bytes; 50 and 15 when it has neither).
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../disk.bash"
#   volume_of <folder>        # "<free-bytes>\t<mount point>" of the volume holding <folder> (its nearest existing folder), by df
#   disk_levels <command>     # "<warn-bytes> <hold-bytes>"; fails, naming <command>, on a threshold that is not a positive number or a hold above the warn
#   disk_held                 # whether disk-space.json records the hold (level hold)
#   gib <bytes>               # the bytes in GiB, one decimal: 12.3
#   $disk_space_file          # what control last read: disk-space.json beside harness.json (DISK_SPACE_FILE overrides it)
#   $disk_data_folder         # the data folder: harness.json's
#
# HARNESS_FILE overrides harness.json, used by tests.
here_disk="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
disk_harness_file="${HARNESS_FILE:-$here_disk/../../data/harness.json}"
disk_data_folder="$(dirname "$disk_harness_file")"
disk_space_file="${DISK_SPACE_FILE:-$disk_data_folder/disk-space.json}"

volume_of() {
  local dir="$1" out
  while [[ ! -d "$dir" ]]; do dir="$(dirname "$dir")"; done
  # -P: one line per volume, the mount point (which may hold spaces) after the fifth field.
  out="$(df -kP "$dir" 2>/dev/null | awk 'NR == 2 { m = $0; for (i = 1; i <= 5; i++) sub(/^[^ ]+ +/, "", m); printf "%.0f\t%s\n", $4 * 1024, m }')" || true
  [[ "$out" =~ ^[0-9]+$'\t' ]] || { echo "could not read the free space on the volume holding $1 (df)" >&2; return 1; }
  echo "$out"
}

disk_levels() {
  local out
  out="$(jq -r '[.["disk-free-warn-gb"] // 50, .["disk-free-hold-gb"] // 15] as [$w, $h]
    | if ($w | type) != "number" or ($h | type) != "number" or $w <= 0 or $h <= 0 then "bad"
      elif $h > $w then "order"
      else "\($w * 1e9 | floor) \($h * 1e9 | floor)" end' "$disk_harness_file")" || return 1
  case "$out" in
    bad) echo "$1: harness.json's disk-free-warn-gb and disk-free-hold-gb must be positive numbers (GB)" >&2; return 1 ;;
    order) echo "$1: harness.json's disk-free-hold-gb is above its disk-free-warn-gb" >&2; return 1 ;;
  esac
  echo "$out"
}

disk_held() { [[ -f "$disk_space_file" && "$(jq -r '.level // empty' "$disk_space_file" 2>/dev/null)" == hold ]]; }

gib() { jq -rn --argjson b "$1" '$b / 1073741824 * 10 | round / 10 | tostring | if test("\\.") then . else . + ".0" end'; }
