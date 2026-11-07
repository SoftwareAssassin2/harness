# State engine runs (assignments.json's transient-state-engines) and the
# ticket step each works for, for the agent-cli commands that keep a run and
# its ticket together (transient-state-engine:change-state,
# ticket:change-sub-state — ASS-161).
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../runs.bash"
#   jq "$ticket_path_def"' … ticket_path($all) …'
#
# ticket_path($all), on a run, $all every run: for a run that works for a
# ticket step — its parent is one ({ work-item, variation }, no trigger), or
# its parent run's is, walked up as far as it goes (ASS-67) — [project,
# work-item, variation, state, sub-states…]: the ticket's top-level state the
# runs are under, then the states beneath it their parent runs are under, top
# first (control's moves.js ticketPath). Empty for a trigger's run, or none's.
ticket_path_def='
  def ticket_path($all):
    def up($r; $path; $n):
      if $n > 20 then empty
      elif $r.parent["transient-state-engine"] != null then
        (first($all[] | select(.id == $r.parent["transient-state-engine"])) // null) as $p
        | if $p == null then empty else up($p; [$r.parent.state] + $path; $n + 1) end
      elif $r.parent.trigger == null and $r.parent["work-item"] != null and $r.parent.variation != null then
        [$r.project, $r.parent["work-item"], $r.parent.variation, $r.parent.state] + $path
      else empty end;
    up(.; []; 0);'
