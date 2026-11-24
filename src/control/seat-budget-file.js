// ASS-528: where a project's seat budget is kept — data/projects/<p>/seat-budget.json, written by control's
// seat-budget.js each tick it changes, read by state.js and the dashboard (here alone, so neither pulls in control's
// budget phase).
import { join } from 'node:path';

export const SEAT_BUDGET_FILE = 'seat-budget.json';

// seatBudgetFile(projectsDir, id) — the project's seat-budget.json.
export const seatBudgetFile = (projectsDir, id) => join(projectsDir, id, SEAT_BUDGET_FILE);

// ASS-529: a project's remote machines' seats — data/projects/<p>/remote-seats.json, written by control's
// remote-seats.js, read by state.js and the dashboard alike: { "<machine id>": { seats, held, pending, state, why,
// limits, … } }.
export const REMOTE_SEATS_FILE = 'remote-seats.json';
export const remoteSeatsFile = (projectsDir, id) => join(projectsDir, id, REMOTE_SEATS_FILE);
