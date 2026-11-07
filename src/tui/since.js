// The progress bar's changes since yesterday (ASS-260): each run's count of
// ticket variations on the day on show against the same run's count in the
// latest end-of-day snapshot before it.
import { localDate } from '../downloader/cycle.js';
import { sprintTickets } from './screens/shared.js';

// earlierDay({ sprint, days }, day) — "yesterday's snapshot": the latest
// snapshot dated before `day` ('YYYY-MM-DD') and inside the active sprint, as
// pastDays (app.js) keeps them; so Monday's is Friday's when the weekend has
// none, and the sprint's first day has none (null).
export const earlierDay = ({ sprint, days }, day) => (sprint
  ? Object.keys(days ?? {}).filter(date => date >= sprint.start && date <= sprint.end && date < day).toSorted().at(-1) ?? null
  : null);

// runsBefore(state, now, runs) — the earlier snapshot's runs, counted by the
// bar's own `runs` (tickets → Map of run → its tickets) over sprintTickets of
// that day, so a change is exactly today's run count minus the snapshot's; or
// null with no earlier snapshot (no changes shown). The day on show is
// state.day, or `now`'s local day (the midnight snapshot's, localDate).
export function runsBefore(state, now, runs) {
  const project = state.projects[state.project];
  const day = project && earlierDay(project, state.day ?? localDate(new Date(now ?? Date.now())));
  return day ? runs(sprintTickets({ ...state, day }).tickets) : null;
}
