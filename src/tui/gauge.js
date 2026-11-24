// ASS-572: a gauge — one bar of a machine's use, as the compute network screen's cards (n) draw CPU, RAM and disk:
//   ████████░░░░░░│░░░
// The bar is the machine's whole (its total memory, every core, its whole disk); the filled part its use; the │ the
// harness's limit on it (max-memory-percent, max-cpu-percent, or, for a disk, the used level at which the free space
// falls to its hold). The filled part is colored by headroom (tone): green well under the limit, amber within
// AMBER_POINTS of it, red over it; the empty part gray, the │ plain so it shows on either. Stale figures (a stopped or
// unreachable machine's last reading) are all gray. The dashboard had no gauge before (ticket.js's progress bar is a
// count, not a use against a limit), so this is the one.
import { color } from './screens/shared.js';

export const AMBER = color('38;2;255;176;0');   // frame.js's amber (the disk-low line)
const TONES = { green: color('32'), amber: AMBER, red: color('31'), gray: color('90') };
export const AMBER_POINTS = 10;
export const FILLED = '█', EMPTY = '░', MARK = '│';

const finite = n => typeof n === 'number' && Number.isFinite(n);

// tone(used, limit, total) — 'red' over the limit, 'amber' within AMBER_POINTS points (of the total) of it, else
// 'green'; 'green' with no limit known.
export function tone(used, limit, total) {
  if (!finite(used) || !finite(limit)) return 'green';
  if (used > limit) return 'red';
  return finite(total) && total > 0 && (limit - used) / total * 100 <= AMBER_POINTS ? 'amber' : 'green';
}

// gauge({ used, total, limit, width, tone, stale }) — the bar, exactly `width` columns. `used` and `limit` in the
// units of `total`; `tone` tone()'s word (or computed from them); `stale` all gray. A use over the total fills it;
// any use at all shows at least one cell; no limit, no │. Nothing known (no used or total): an all-gray empty bar.
export function gauge({ used, total, limit = null, width = 20, tone: t = null, stale = false }) {
  const n = Math.max(1, Math.floor(width));
  if (!finite(used) || !finite(total) || total <= 0) return TONES.gray(EMPTY.repeat(n));
  const fill = Math.min(n, Math.max(used > 0 ? 1 : 0, Math.round(used / total * n)));
  const mark = finite(limit) ? Math.min(n - 1, Math.max(0, Math.round(limit / total * n) - (limit >= total ? 1 : 0))) : -1;
  const shade = stale ? TONES.gray : TONES[t ?? tone(used, limit, total)];
  // Runs of one kind of cell, each painted once: the filled run (its tone), the empty run (gray), the │ (plain).
  let out = '', run = '', kind = null;
  const flush = () => { if (run) out += kind === 'mark' ? (stale ? TONES.gray(run) : run) : kind === 'fill' ? shade(run) : TONES.gray(run); run = ''; };
  for (let i = 0; i < n; i++) {
    const k = i === mark ? 'mark' : i < fill ? 'fill' : 'empty';
    if (k !== kind) { flush(); kind = k; }
    run += k === 'mark' ? MARK : k === 'fill' ? FILLED : EMPTY;
  }
  flush();
  return out;
}
