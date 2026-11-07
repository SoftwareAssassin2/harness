# Locked, atomic edits to the JSON files the agent-cli writes. Every command
# that writes a JSON file goes through update_json, so two processes can never
# interleave their writes to the same file.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
#   update_json [--create] "$file" [jq options…] '<jq filter>'
#
# How it holds:
# - An exclusive flock(2) on "<file>.lock", taken before the file is read and
#   held until it has been replaced: the read, any checks the filter makes
#   (a jq error() aborts the write) and the write are one transaction.
# - The lock belongs to an open file description held by this shell, so the
#   kernel drops it when the shell exits, however it exits — killed outright
#   included. A lock can never go stale.
# - The new content goes to a temp file beside the original, keeping its
#   permissions, and is renamed over it: readers see the old file or the new
#   one, never half of one, and a failed write leaves the original as it was:
#   the temp file is renamed only once it parses as JSON (ASS-288).
# - Waiting for the lock gives up after JSON_LOCK_TIMEOUT seconds (default 30)
#   rather than hang behind a stuck writer.
# - The path is resolved first, so every spelling of it, symlinks included,
#   locks the same file.
# The lock files stay beside their files, empty; they are only something to lock.
#
#   lock_on <fd> <lock-file> <who> <seconds>   # the same lock, held on descriptor <fd> until `exec <fd>>&-` or exit
#   replace_file <file> < <content>            # an unlocked whole-file write, through a temp file of its own
#   append_line [--fresh] <file> <text>        # <text> and a newline added to <file> under the same lock
#   write_json <file> [jq options…] <filter>   # update_json's write alone, <file>.lock held by the caller
#
# lock_on is the lock itself, for a lock held across more than one write
# (vm.bash's, ASS-75). A process started while it is held inherits the
# descriptor, and the lock with it: one that outlives the holder (a daemon)
# must be started with the descriptor closed (`<fd>>&-`). It refuses a
# descriptor this shell holds a lock on still (ASS-179): reopening it would
# drop that lock unseen. A child given the descriptor holds none of its own,
# and may lock on it.

# update_json [--create] <file> [jq options…] <filter> — rewrite <file> as
# `jq <filter>` would, under the lock. Fails, leaving the file untouched, when
# the file is missing, the lock times out, or jq fails. With --create a
# missing file (its folder must exist) is first created as {} under the same
# lock, for live data that is not there until its first write (ASS-94).
update_json() {
  local create=0 file
  [[ "${1:-}" == --create ]] && { create=1; shift; }
  if [[ $create -eq 1 && ! -e "$1" ]]; then
    file="$(readlink -f "$(dirname "$1")")" && [[ -d "$file" ]] || { echo "update_json: no file '$1'" >&2; return 1; }
    file="$file/$(basename "$1")"
  else
    file="$(readlink -f "$1")" || { echo "update_json: no file '$1'" >&2; return 1; }
  fi
  shift
  [[ -f "$file" || $create -eq 1 ]] || { echo "update_json: no file '$file'" >&2; return 1; }

  lock_on 9 "$file.lock" update_json "${JSON_LOCK_TIMEOUT:-30}" || return 1

  local status=0
  # Created by the first writer to hold the lock; written beside and renamed
  # over like every other write, so a reader never sees it half there.
  [[ -f "$file" ]] || { printf '{}' > "$file.$$" && mv -f "$file.$$" "$file"; } || { exec 9>&-; return 1; }
  write_json "$file" "$@" || status=1
  exec 9>&-
  return $status
}

# write_json <file> [jq options…] <filter> — update_json's write without its
# lock, for a caller already holding <file>.lock (lock_on on another
# descriptor) across a read of its own (ticket:renumber-backlog, ASS-179).
# The temp file is moved over <file> only when jq succeeded and what it wrote
# is there and parses as JSON (ASS-288): a write cut short — a full disk — is
# never moved in, so <file> stays as it was, and this fails.
write_json() {
  local file="$1" tmp
  shift
  tmp="$(mktemp "$file.XXXXXX")" || return 1
  cp -p "$file" "$tmp"
  jq --indent 4 "$@" "$file" > "$tmp" && [[ -s "$tmp" ]] && jq empty "$tmp" 2>/dev/null && mv "$tmp" "$file" || { rm -f "$tmp"; return 1; }
}

# replace_file <file> — <file> becomes stdin, whole (ASS-176): written to a
# temp file of its own beside it (mktemp, so writers at once never share a
# name) and renamed over it, so a reader sees the old file or the new one,
# never half of one. No lock: the last writer wins. The file gets the mode a
# new file made with `>` would. Fails, leaving <file> as it was and no temp
# behind, when stdin is empty or the write fails.
replace_file() {
  local tmp
  tmp="$(mktemp "$1.XXXXXX")" || return 1
  cat > "$tmp" && [[ -s "$tmp" ]] && chmod "$(printf '%o' $(( 0666 & ~$(umask) )))" "$tmp" && mv -f "$tmp" "$1" \
    || { rm -f "$tmp"; return 1; }
}

# append_line [--fresh] <file> <text> — <text> and a newline added to the end
# of <file> (made when missing; with --fresh, <file> becomes that line alone)
# under <file>.lock, update_json's lock, so appenders at once never interleave
# and a truncation (--fresh) never lands mid-append (ASS-179). Fails, adding
# nothing, when the lock times out.
append_line() {
  local fresh=0 file
  [[ "${1:-}" == --fresh ]] && { fresh=1; shift; }
  file="$(readlink -f "$(dirname "$1")")" && [[ -d "$file" ]] || { echo "append_line: no folder for '$1'" >&2; return 1; }
  file="$file/$(basename "$1")"
  lock_on 9 "$file.lock" append_line "${JSON_LOCK_TIMEOUT:-30}" || return 1
  local status=0
  if [[ $fresh -eq 1 ]]; then printf '%s\n' "$2" > "$file" || status=1
  else printf '%s\n' "$2" >> "$file" || status=1; fi
  exec 9>&-
  return $status
}

# Descriptor 9 (update_json's) or another fixed one, not an allocated one:
# `exec {fd}>` needs bash 4.1, and macOS still ships 3.2 as /bin/bash. perl
# takes the lock on the descriptor it shares with this shell; the lock
# outlives perl because the shell still holds the descriptor.
lock_on() {
  local fd="$1" lock="$2" who="$3" seconds="$4"
  [[ "$fd" =~ ^[0-9]$ ]] || { echo "lock_on: invalid descriptor '$fd'" >&2; return 1; }
  # LOCKS_HELD (not exported, so a child starts with none) names the
  # descriptors this shell locked; one closed since (`exec <fd>>&-`) is free.
  if [[ " ${LOCKS_HELD-} " == *" $fd "* ]] && { eval ": >&$fd"; } 2>/dev/null; then
    echo "$who: descriptor $fd already holds a lock; not taking $lock on it" >&2; return 1
  fi
  eval "exec $fd>>\"\$lock\""
  perl -MFcntl=:flock -e '
      open(my $fh, ">&=", $ARGV[0]) or die "$ARGV[3]: cannot open the lock: $!\n";
      local $SIG{ALRM} = sub { die "$ARGV[3]: timed out waiting for the lock on $ARGV[1]\n" };
      alarm $ARGV[2];
      flock($fh, LOCK_EX) or die "$ARGV[3]: cannot lock $ARGV[1]: $!\n";
    ' "$fd" "$lock" "$seconds" "$who" || { eval "exec $fd>&-"; return 1; }
  [[ " ${LOCKS_HELD-} " == *" $fd "* ]] || LOCKS_HELD="${LOCKS_HELD-} $fd"
}
