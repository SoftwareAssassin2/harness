// Header warning notifications (ASS-412): which of the dashboard header's
// warnings (frame.js headerWarnings, the one list the header renders) are up
// in each project, and which may notify. Pure; the notifier
// (notifier.js headerWarningNotifier) keeps the seen set and the times.
import { headerWarnings } from '../tui/screens/frame.js';

// The seen set's key for the warnings the whole harness shares (scope
// 'harness'): never a project id, which is plain characters (load.js).
export const HARNESS = '*';

// liveWarnings(state, now) — { <project id | HARNESS>: [{ key, warning, projects }] }:
// headerWarnings for every project, selected on its live sprint (day null, as
// neededTickets reads it), but those the operator caused (operator true); a
// harness-wide one once, under HARNESS, with every project it shows in
// (`projects`, in menu order); a project's under its id. `key` is the
// warning's stable id, so detect.js entered and keysOf diff them as tickets.
export function liveWarnings(state, now = Date.now()) {
  const out = {};
  state.projects.forEach((project, i) => {
    for (const warning of headerWarnings({ ...state, project: i, day: null }, now)) {
      if (warning.operator) continue;
      const list = (out[warning.scope === 'harness' ? HARNESS : project.id] ??= []);
      const have = list.find(item => item.key === warning.id);
      if (have) have.projects.push(project.id);
      else list.push({ key: warning.id, warning, projects: [project.id] });
    }
  });
  return out;
}

// settled(live, seen, upSince, now) — `live` but the warnings with an `after`
// (No work in progress) up for less than it since upSince (`<scope>/<key>` →
// ms), unless `seen` has them already — one up since the dashboard started
// stays seen rather than dropping out and notifying once it settles.
export function settled(live, seen, upSince, now) {
  return Object.fromEntries(Object.entries(live).map(([scope, items]) => [scope, items.filter(({ key, warning }) =>
    !warning.after || (seen[scope] ?? []).includes(key) || now - (upSince.get(`${scope}/${key}`) ?? now) >= warning.after)]));
}
