// ASS-526: the loops control has finished since it started, for the counter in
// the dashboard's bottom-right corner (src/tui/screens/frame.js loopCounter),
// which shows it modulo 100: that control is alive and ticking, at a glance.
// tick-stats.js (ASS-490) counts the ticks too, but writes at most every 30
// seconds; this is written after every loop, so the corner moves with each.
//
// main.js makes one per control at its start — which writes 0, so a control
// that restarts starts again at 0 — and calls finished() after each tick(ctx)
// returns or throws (a throwing loop counts too), in the same `finally` as the
// tick's timing. Written to data/projects/<project>/loop-count.json
// ($HARNESS_HOME's loop-count.json for a control with no --project) by a
// temporary file renamed over it, so the dashboard never reads half a file:
//   { "control-pid", "started" (ISO), "loops": <finished loops since started> }
// The whole count is kept, not its remainder: the dashboard takes it modulo
// 100. A write is one small file each loop (every --tick-ms, 2 s by default).
// A control that is down leaves its last file, so the counter stays at its last
// value. A write that fails is logged once per failure streak and never stops
// the loop.
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOOP_COUNT_FILE = 'loop-count.json';

// loopCountFile({ paths, home, project }) — where a control's count goes: its project's folder, or `home` with none.
export const loopCountFile = ({ paths, home, project }) => project ? join(paths.projects, project, LOOP_COUNT_FILE) : join(home, LOOP_COUNT_FILE);

// loopCounter({ file, log, pid, now }) — a control's count, written at 0 at once; finished() after each loop adds one
// and writes it; loops() what it holds.
export function loopCounter({ file, log = () => {}, pid = process.pid, now = () => new Date() }) {
  const started = now().toISOString();
  let loops = 0, failing = false;
  const write = () => {
    const tmp = `${file}.${pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ 'control-pid': pid, started, loops })}\n`);
      renameSync(tmp, file);
      failing = false;
    } catch (error) {
      if (!failing) log('error', `loop-count: ${file}: ${error.message}; the loop goes on, and this is not said again until a write succeeds`);
      failing = true;
    }
  };
  write();
  return {
    finished() { loops++; write(); },
    loops: () => loops,
  };
}
