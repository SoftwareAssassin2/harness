// The merge requests screen (m): the live sprint's merge requests of interest (ASS-201: moved from app.js).
import { boxTable } from '../table.js';
import { link } from '../text.js';
import { below, headerLines, platform } from './frame.js';
import { ticketUrls, ticketLink, NONE, cell, agentLines, projectAssignments, timestamp } from './shared.js';

// The selected project's merge requests of interest, from its live sprint.
const mergeRequests = state => state.projects[state.project]?.sprint?.['merge-requests-of-interest'] ?? [];

const MR_HEADERS = ['Ticket', 'MR', 'Author', 'Review Status', 'Build', 'Agent'];

export function view(state, size) {
  // The live sprint's merge requests of interest, whatever the day, under
  // when they were last scanned, in a table filling the height above the
  // platform boxes.
  const scan = state.projects[state.project]?.sprint?.['last-merge-request-scan'];
  const urls = ticketUrls(state);
  // An assignment's merge-request names an iid, as text or a number.
  const onMr = mr => projectAssignments(state).filter(a => a['merge-request'] != null && String(a['merge-request']) === String(mr.iid));
  const rows = mergeRequests(state).map(mr => [
    mr.ticket ? ticketLink(mr.ticket, urls.get(mr.ticket)) : NONE,
    link(`!${mr.iid}`, mr.url),
    cell(mr.author),
    cell(mr['review-status']),
    mr.pipeline ? link(mr.pipeline, mr['build-url'] ?? mr.url) : NONE,   // as the sprint and ticket screens link a build (ASS-86)
    agentLines(onMr(mr)),
  ]);
  const bottom = below(state) + Math.max(1, platform(state, size.columns, 0).length);
  return [
    scan ? `last scanned ${timestamp(Date.parse(scan))}` : 'not scanned yet',
    '',
    ...boxTable(MR_HEADERS, rows.length ? rows : [['No merge requests of interest']], {
      columns: size.columns, stretch: 0, height: size.rows - headerLines(state, size.columns, 0).length - bottom - 2,
    }),
  ];
}
