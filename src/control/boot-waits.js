// ASS-575: each project's remote boot waits (ASS-553 AC7, seats.js bootWaits) recorded where the dashboard reads them,
// data/projects/<p>/boot-waits.json — control's live data, written by seats.js each tick it changes (atomically; removed
// when no machine waits):
//
//   { "wait-seconds": 900,
//     "machines": { "<id>": { "since": "<ISO>", "ends-at": "<ISO>", "over": false } } }
//
// One entry per workstation or cloud VM a step was placed on while it was not up (or that control first saw so while
// holding seats): `since` is when its wait began, `ends-at` when it runs out (since + remote-boot-wait-seconds), `over`
// whether control already counts it as lost (project.bootWaitOver, seat-kinds.js seatCapacity). Pure helpers, shared by
// control (seats.js) and the dashboard (tui/load.js, tui/screens/shared.js planProject, the n screen's cards).
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workstationUsable } from './workstation-connection.js';
import { lostWhy } from './seat-kinds.js';
import { BOOT_WAIT_SECONDS } from './run-targets.js';

export const BOOT_WAITS_FILE = 'boot-waits.json';

// overWhy(seconds) — the reason a machine past its boot wait can't be used: project.bootWaitOver's value, the same
// words in control and the dashboard (seat-kinds.js keepSeats logs it).
export const overWhy = seconds => `it did not come up within ${Math.round(seconds)} s (remote-boot-wait-seconds)`;

// bootWaitsJson(waits, seconds) — the file's content for a project: `waits` is Map id → { since (ms), over }.
export function bootWaitsJson(waits, seconds) {
  const machines = {};
  for (const [id, w] of waits) machines[id] = { since: new Date(w.since).toISOString(), 'ends-at': new Date(w.since + seconds * 1000).toISOString(), over: w.over === true };
  return { 'wait-seconds': seconds, machines };
}

// writeBootWaits(dir, json, log) — the file written whole when its content changed, removed when no machine waits.
export function writeBootWaits(dir, json, log = () => {}) {
  const file = join(dir, BOOT_WAITS_FILE);
  try {
    if (!Object.keys(json.machines).length) { if (existsSync(file)) rmSync(file, { force: true }); return; }
    const text = `${JSON.stringify(json, null, 2)}\n`;
    if (existsSync(file) && readFileSync(file, 'utf8') === text) return;
    writeFileSync(`${file}.tmp`, text);
    renameSync(`${file}.tmp`, file);
  } catch (error) { log(`${file}: ${error.message}`); }
}

// loadBootWaits(dir) — the project's boot-waits.json, or null (none, unreadable).
export function loadBootWaits(dir) {
  const file = join(dir, BOOT_WAITS_FILE);
  if (!existsSync(file)) return null;
  try { const j = JSON.parse(readFileSync(file, 'utf8')); return j && typeof j.machines === 'object' && j.machines ? j : null; } catch { return null; }
}

// bootWaitOf(file, entry, id, now) — one machine's boot wait as the dashboard sees it now: null when it waits for nothing
// (no entry, or it is up, or unusable for another reason: lostWhy), else { since, endsAt, seconds, waited (s), over }.
// `over` once control said so or its time ran out (control says so at its next tick, so the dashboard never shows it
// placeable meanwhile).
export function bootWaitOf(file, entry, id, now = Date.now()) {
  const w = file?.machines?.[id];
  if (!w || workstationUsable(entry) || lostWhy(entry)) return null;
  const seconds = Number(file['wait-seconds'] ?? BOOT_WAIT_SECONDS), since = Date.parse(w.since);
  if (!Number.isFinite(since)) return null;
  const endsAt = Date.parse(w['ends-at'] ?? '') || since + seconds * 1000;
  return { since, endsAt, seconds, waited: Math.max(0, (now - since) / 1000), over: w.over === true || now > endsAt };
}

// bootWaitOverOf(file, workstations, now) — project.bootWaitOver as control builds it (seats.js bootWaits): id → why,
// for each machine past its boot wait, from the recorded file and the machines' live entries.
export function bootWaitOverOf(file, workstations, now = Date.now()) {
  const over = {};
  for (const id of Object.keys(file?.machines ?? {})) {
    const b = bootWaitOf(file, workstations?.[id], id, now);
    if (b?.over) over[id] = overWhy(b.seconds);
  }
  return over;
}
