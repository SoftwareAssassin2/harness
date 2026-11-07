// Backing off a step that keeps failing — an agent's error result, an agent
// that dies before ending its turn, a dispatch that throws, a script that
// fails back into its own step (a turn no exit matches is no failure: it may
// just need more turns): each failure holds the
// item (a ticket variation's step, or a run's step) longer before it is tried
// again, from 30 seconds doubling to 30 minutes at most, until it moves to
// another step. A rate limit has its own hold (see finish.js). Pure, on
// control's memory.backoff: key → { failures, until (ms), error }.

const BASE = 30e3, MAX = 30 * 60e3;

// backoffDelay(failures) — how long the nth failure in a row holds the item, ms.
export const backoffDelay = failures => Math.min(BASE * 2 ** (failures - 1), MAX);

// The key of a ticket variation's step, and of a run's.
export const ticketKey = (project, key, variation, state) => `${project}/${key}/${variation}/${state}`;
export const runKey = (run, state) => `run/${run}/${state}`;
// recordKey(record) — the key of what an assignment record's agent worked on.
export const recordKey = record => (record['transient-state-engine']
  ? runKey(record['transient-state-engine'], record.state)
  : ticketKey(record.project, record['work-item'], record.variation, record.state));

// A ticket's step that fails this many times in a row goes to Blocked (ASS-6; see steps.js blockFailing).
export const BLOCK_AFTER = 3;

// failed(memory, key, now, error) — one more failure, `error` what it said: the item held for the next
// delay; a ticket's step, or a run's, at BLOCK_AFTER failures is queued for
// Blocked (memory.toBlock; a run's only blocks a ticket whose step it is
// inside, see steps.js blockFailing). Returns { failures, until, error }.
export function failed(memory, key, now, error) {
  const failures = (memory.backoff.get(key)?.failures ?? 0) + 1;
  const entry = { failures, until: now + backoffDelay(failures), error };
  memory.backoff.set(key, entry);
  if (failures >= BLOCK_AFTER) (memory.toBlock ??= new Set()).add(key);
  return entry;
}

// waiting(memory, key, now) — whether the item is held now.
export const waiting = (memory, key, now) => (memory.backoff.get(key)?.until ?? 0) > now;

// cleared(memory, key) — its failures forgotten (it moved on).
export const cleared = (memory, key) => { memory.backoff.delete(key); };

// "30s", "60s", "2m", "30m": a hold, as a log line says it.
export const held = ms => (ms < 120e3 ? `${Math.round(ms / 1e3)}s` : `${Math.round(ms / 60e3)}m`);

// A step whose agent cannot start (ASS-167): it ends with no result and never
// sent its init event (no session id: its CLI missing, say). This many in a
// row go to Blocked for Human (steps.js escalateFailedStarts), whatever step —
// Blocked's own too, which the failures above never leave.
export const FAILED_STARTS = 3;

// counted(memory, key, agent, result) — the agent's start counted for the
// item: a failed one (no result, no sessionId) one more, its session `dir`
// kept for its stderr; any other start forgets them. On control's
// memory.failedStarts: key → { count, dir }.
export function counted(memory, key, { sessionId, dir }, result) {
  const starts = (memory.failedStarts ??= new Map());
  if (sessionId || result) starts.delete(key);
  else starts.set(key, { count: (starts.get(key)?.count ?? 0) + 1, dir });
}
