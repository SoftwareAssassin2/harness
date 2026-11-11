// Operator Needed notifications (ASS-383): which tickets wait on the operator
// in each project, and which of them have just started to. Pure, but for the
// seen file's read and write. The phone's push notifications (ASS-381) are to
// reuse neededTickets and entered as they are.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { blocksTicket } from '../control/engine.js';
import { operatorNeeded, sprintTickets } from '../tui/screens/shared.js';
import { gateWaits, needsYou } from '../tui/ticket.js';

// How much of one field goes to the summarizer: enough for its point, never a whole document.
const FIELD = 1500;
const cut = text => (text == null || text === '' ? undefined : String(text).length > FIELD ? `${String(text).slice(0, FIELD)}…` : String(text));

// reasonOf(project, row) — why the ticket of sprintTickets' `row` waits on the
// operator, as the ticket screen shows it (ASS-383 AC3): only these fields,
// those it has — `gate` (needsYou's "what", without its tab), the step's
// human-action `instructions` and the gate's `choices`; `blocked` with the
// variation's ai-feedback `short` and `long` at its engine's blocked state;
// the open blocking `questions`' text; the pending requirements `change`'s
// new description.
export function reasonOf(project, row) {
  const v = row.variation ?? {};
  const questions = (project.questions ?? []).filter(q => blocksTicket(q) && String(q['asked-on-ticket'] ?? '').toLowerCase() === row.key.toLowerCase())
    .map(q => cut(q.question)).filter(Boolean);
  const gate = gateWaits(row.gate) ? row.gate : null;
  return {
    ...(row['pending-requirements-change'] ? { change: cut(row['pending-requirements-change'].description) ?? '' } : {}),
    ...(row.step?.['is-blocked-state'] === true ? { blocked: true } : {}),
    ...(gate ? { gate: needsYou(gate, 0).replace(/ — tab \d+$/, ''), choices: gate.choices.map(c => c.decision) } : {}),
    ...(gate?.step?.action?.instructions ? { instructions: cut(gate.step.action.instructions) } : {}),
    ...(cut(v['ai-feedback-short']) ? { short: cut(v['ai-feedback-short']) } : {}),
    ...(cut(v['ai-feedback-long']) ? { long: cut(v['ai-feedback-long']) } : {}),
    ...(questions.length ? { questions } : {}),
  };
}

// neededTickets(state) — { <project id>: [{ key, title, variation, step, reason }] }:
// every project's Operator Needed tickets, operatorNeeded on its live sprint
// as the project menu's dots count them (ASS-370: the project selected, day
// null), each with the variation that waits — one at a gate or the blocked
// state ahead of the rest —, the step it waits at (its deepest) and reasonOf.
export function neededTickets(state) {
  return Object.fromEntries(state.projects.map((project, i) => {
    const live = { ...state, project: i, day: null };
    const { tickets } = sprintTickets(live);
    const keys = operatorNeeded(live, tickets);
    return [project.id, [...keys].map(key => {
      const rows = tickets.filter(t => t.key === key);
      const row = rows.find(t => gateWaits(t.gate) || t.step?.['is-blocked-state'] === true) ?? rows[0];
      const step = row.gate?.step ?? row.status?.detailStep ?? row.step;
      return { key, title: row.title ?? '', variation: row.variation?.name ?? null, step: step?.name ?? step?.id ?? null, reason: reasonOf(project, row) };
    })];
  }));
}

// entered(seen, now) — { seen, entered }: `now` (neededTickets') against the
// keys `seen` ({ <project id>: [key] }) last time: `entered`, the tickets
// newly in a project's set, [{ project, ticket }], one each, never grouped;
// `seen`, now's keys — so a ticket that leaves drops out, and notifies again
// only once it comes back.
export function entered(seen, now) {
  const list = Object.entries(now).flatMap(([project, tickets]) => tickets
    .filter(t => !(seen[project] ?? []).includes(t.key)).map(ticket => ({ project, ticket })));
  return { seen: keysOf(now), entered: list };
}
export const keysOf = now => Object.fromEntries(Object.entries(now).map(([project, tickets]) => [project, tickets.map(t => t.key)]));

// The seen file (data/operator-needed-seen.json): { seen: { <project>: [key] } },
// so a restarted dashboard does not notify again. {} when missing or unreadable.
export function readSeen(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')).seen ?? {}; } catch { return {}; }
}
// Written whole to a temp file beside it, then renamed over it: never half a file.
export function writeSeen(file, seen) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ seen }, null, 4)}\n`);
  renameSync(`${file}.tmp`, file);
}
