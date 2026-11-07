// until(check, ms) — polls check() until it is true or `ms` have passed, and
// throws on a real timeout (ASS-211) rather than return a stale false that
// reads as a code bug: for a test waiting on another process (a fake
// agent, control, the downloader). The default allows for a busy machine,
// where starting a process can take seconds (ASS-109): a check that comes
// true returns at once, so only a failing test waits the whole limit.
import { appendFileSync } from 'node:fs';
export const LOADED_MS = 30_000;
const note = (ms, how, check) => { if (process.env.UNTIL_LOG) try { appendFileSync(process.env.UNTIL_LOG, `${ms}\t${how}\t${String(check).replace(/\s+/g, ' ').slice(0, 80)}\n`); } catch { /* ignore */ } };
export const until = async (check, ms = LOADED_MS) => {
  const began = Date.now();
  for (const end = began + ms; Date.now() < end; await new Promise(r => setTimeout(r, 25))) if (check()) { note(Date.now() - began, 'ok', check); return true; }
  const last = check();
  note(Date.now() - began, last ? 'ok-late' : 'TIMEOUT', check);
  if (last) return last;
  throw new Error(`until(): condition not met within ${ms}ms: ${String(check).replace(/\s+/g, ' ').slice(0, 200)}`);
};
// within(promise, ms) — the promise's value, or `still running after <ms>ms`
// should it not settle in time: for a process a test expects to exit.
export const within = (promise, ms = LOADED_MS) => Promise.race([promise, new Promise(r => setTimeout(r, ms, `still running after ${ms}ms`).unref())]);
