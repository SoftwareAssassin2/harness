// The open MRs screen (U, ASS-366): the selected project's merge requests
// ready for approval (ASS-367), grouped by ticket, as the paste-ready text merge-requests-summary.js
// writes — shown as it is copied, scrolling as the updates screen (u) does.
import { openMergeRequests, openMergeRequestLines, inPlay } from '../merge-requests-summary.js';
import { below, headerLines, platform } from './frame.js';
import { clamp, gray, sprintTickets } from './shared.js';

// The live sprint's tickets in the sprint screen's order (sprintTickets, read
// as of today whatever day the sprint screen shows), each once: the row of
// its variation in play (inPlay).
const tickets = state => sprintTickets({ ...state, day: null }).tickets.filter(t => t.variation === inPlay(t));

// The screen: what the keys do, a blank line, then the text, in the space
// left above the platform boxes; the header's date is `now`'s UTC date.
function openMrsView(state, { columns = 0, rows = Infinity, now = Date.now() }) {
  const head = [state.focus === 'openmrs' ? gray('↑/↓ scroll') : '', ''];
  const list = openMergeRequestLines(openMergeRequests(tickets(state)), now);
  const bottom = below(state) + platform(state, columns, now).length;
  const height = Math.max(1, rows - headerLines(state, columns, now).length - bottom - head.length);
  return { head, list, height };
}

export function view(state, size) {
  const { head, list, height } = openMrsView(state, size);
  return [...head, ...list.slice(state.openMrsScroll, state.openMrsScroll + height)];
}

// Its keys: ↑/↓ scroll, no further than the text's end; the screen keys leave it.
export function onKey(state, key, size, { step, sideways }) {
  if (state.focus === 'openmrs' && step && !sideways) {
    const { list, height } = openMrsView(state, size);
    return { ...state, openMrsScroll: clamp(state.openMrsScroll + step, 0, Math.max(0, list.length - height)) };
  }
}
