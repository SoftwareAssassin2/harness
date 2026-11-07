// The updates screen's summary: the progress made since a moment, from each
// ticket variation's state-changes, each key linked to its ticket's url when
// the sprint has one. Pure; app.js owns the screen.

import { wrap, link } from './text.js';
import { stateOf, levelChanges } from './status.js';

const TYPES = ['features', 'bugs', 'spikes'];
const times = n => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// progressSince({ sprint, steps, since }) — { summary, sections }:
// sections are [{ title, bullets }] in a fixed order, the empty ones left out.
// A variation counts when it changed state after `since` (ms since the epoch):
// from where it stood then (the first such change's from-state) to its status
// now. It is Delivered at the engine's last step, Blocked in a quarantined
// step, else Moved forward or Sent back by sequence. Apart from that, one that
// left a quarantined step since then is Unblocked: its latest such move, to
// where it resumed. A resolved block is progress; it is counted on its own.
export function progressSince({ sprint, steps, since }) {
  const step = id => steps.find(s => s.id === id);
  const name = id => step(id)?.name ?? id;
  const sequence = id => step(id)?.sequence ?? 0;
  const last = Math.max(...steps.map(s => s.sequence));
  const after = timestamp => Boolean(timestamp) && Date.parse(timestamp) > since;
  const quarantined = id => step(id)?.area === 'quarantine';
  const sections = { 'Delivered': [], 'Unblocked': [], 'Moved forward': [], 'Sent back': [], 'Blocked': [] };

  for (const ticket of TYPES.flatMap(type => sprint?.[type] ?? [])) {
    const variations = ticket.variations ?? [];
    for (const v of variations) {
      const changes = levelChanges(v).filter(c => after(c.timestamp));
      if (!changes.length) continue;
      const from = changes[0]['from-state'], to = stateOf(v);
      const back = changes.filter(c => sequence(c['to-state']) < sequence(c['from-state']) && !quarantined(c['to-state'])).length;
      const named = variations.length > 1 ? `${ticket.key}.${v.name}` : ticket.key;
      const key = ticket.url ? link(named, ticket.url) : named;   // linked when the sprint has its url (ASS-86)
      const resumed = changes.findLast(c => quarantined(c['from-state']) && !quarantined(c['to-state']));
      if (resumed) sections['Unblocked'].push(`${key}: ${ticket.title} (${name(resumed['from-state'])} → ${name(resumed['to-state'])})`);
      const moved = `${key}: ${ticket.title} (${name(from)} → ${name(to)}`;
      if (quarantined(to)) sections['Blocked'].push(`${moved})${v['ai-feedback-short'] ? `: ${v['ai-feedback-short']}` : ''}`);
      else if (sequence(to) === last) sections['Delivered'].push(`${moved})`);
      else if (sequence(to) < sequence(from)) sections['Sent back'].push(`${moved})`);
      else sections['Moved forward'].push(`${moved}${back ? `, sent back ${times(back)}` : ''})`);
    }
  }
  const count = title => sections[title].length;
  const tickets = ['Delivered', 'Moved forward', 'Sent back', 'Blocked'].reduce((sum, title) => sum + count(title), 0);
  const resolved = count('Unblocked') ? `; ${plural(count('Unblocked'), 'block')} resolved` : '';
  const summary = tickets === 0
    ? 'No progress since then.'
    : `${plural(tickets, 'ticket')} moved: ${count('Delivered')} delivered, ${count('Moved forward')} moved forward, ${count('Sent back')} sent back, ${count('Blocked')} blocked${resolved}.`;
  return { summary, sections: Object.entries(sections).filter(([, bullets]) => bullets.length).map(([title, bullets]) => ({ title, bullets })) };
}

// The summary as lines `width` columns wide: the summary line, then each
// section's title over its bullets ("• "), a bullet too long for one line
// wrapping under its own text; a blank line between.
export const progressLines = ({ summary, sections }, width) => [
  ...wrap(summary, width),
  ...sections.flatMap(({ title, bullets }) => [
    '', title,
    ...bullets.flatMap(bullet => wrap(bullet, Math.max(10, width - 2)).map((line, i) => (i ? '  ' : '• ') + line)),
  ]),
];
