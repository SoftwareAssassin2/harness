// The TUI's feature flags (ASS-262): features.json beside this file, tracked,
// names each flag true or false; main.js reads it once at start into the
// state's `features`. chat-screen: the chat screen on x; ticket-chat-tab: the
// ticket screen's Chat tab and the briefing sent as a ticket's screen opens.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FEATURES = join(import.meta.dirname, 'features.json');

// loadFeatures(file) — the flags `file` names, or none ({}) when it is
// missing or unreadable: every flag off.
export function loadFeatures(file = FEATURES) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

// featureOn(state, name) — whether flag `name` is on: only when the file set
// it true; a flag it does not name is off.
export const featureOn = (state, name) => state.features?.[name] === true;
