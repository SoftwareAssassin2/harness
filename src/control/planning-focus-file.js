// ASS-531: the focus-on-planning switch — data/projects/<p>/planning-focus.json, { on, by, at }, written whole (a temp
// file renamed over it, under its lock) by `agent.sh project:set-planning-focus <project> on|off` alone, the
// dashboard's sprint screen key included; read here by control (state.js) and the dashboard (load.js), so neither
// pulls in the other's code. A file of its own, not project.json (the operator's hand-edited config): a live switch
// the dashboard flips. Control reads it every tick, so the switch survives restarts and takes effect, on or off,
// without one. While on, control ranks the project's variations at a planning step ahead of the rest when giving seats
// and dispatching agents (plan.js atPlanningStep, sprintOrder), and max-tickets-ready-for-build does not hold planning
// back; off (or no file), ranking is exactly as without it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOnce } from './read.js';

export const PLANNING_FOCUS_FILE = 'planning-focus.json';

// loadPlanningFocus(dir, read) — the project folder's planning-focus.json, or null: none, or caught half-written (off
// till the next read finds it whole — never a reason to skip a tick).
export function loadPlanningFocus(dir, read = readJsonOnce) {
  try { return existsSync(join(dir, PLANNING_FOCUS_FILE)) ? read(join(dir, PLANNING_FOCUS_FILE)) : null; } catch { return null; }
}

// planningFocusOn(project) — whether the project's switch is on: its loaded planningFocus record says on: true.
export const planningFocusOn = project => project?.planningFocus?.on === true;
