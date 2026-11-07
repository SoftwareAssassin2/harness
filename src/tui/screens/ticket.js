// The ticket screen, opened from the sprint (s) or the backlog (b): its tabs beside the
// quick-details panel, its actions' forms and its chat (ASS-201: moved from app.js;
// its line builders stay in src/tui/ticket.js).
import { join } from 'node:path';
import { statusOf, stepOf, engineSteps, isOpenQuestion } from '../../control/engine.js';
import { contextOf } from '../../control/moves.js';
import { spendLimit, usageSpend } from '../../control/spend.js';
import { ticketQuestionLines, questionDetails } from '../questions.js';
import { reviewLines, splitProposalLines, ticketScreenshots, ticketDocuments } from '../review.js';
import { stateOf, enginesOf } from '../status.js';
import { scrollBox, scrollLast } from '../table.js';
import { visible, wrap } from '../text.js';
import { ticketLines, overlapsOf, workedByHand, refinementHistory, humanGate, gateLines, stateCounts, statesColumn, pendingChange, quickLines, stripLines, needsYou, defaultTab, gateWaits, tabWidth, panelWidth, ticketTabs, tabsOf, RETURN_STEPS } from '../ticket.js';
import { featureOn } from '../features.js';
import { below, headerLines, platform } from './frame.js';
import { foldResults, promptRows, fitRows, viewLog } from './log.js';
import { NONE, projectAssignments, liveAssignments, clamp, ICONS, backlogTickets, refinementName, color, red, sprintTickets, statusText, ticketAgents, chatSpend, refinementSteps } from './shared.js';

// The answer form's fields, in tab order.
const FORM = ['answer', 'why-this-answer', 'scope'];

// A key while an answer is being written: tab and shift-tab move between the
// form's fields; every printable key is text in the field being edited; enter
// saves the form as `submit`, for main.js to hand the agent-cli, once the
// answer is not blank; escape gives up.
export function editAnswer(state, key) {
  const { draft } = state;
  if (key.name === 'escape') return { ...state, draft: null };
  if (key.name === 'tab') {
    const at = (FORM.indexOf(draft.field) + (key.shift ? -1 : 1) + FORM.length) % FORM.length;
    return { ...state, draft: { ...draft, field: FORM[at] } };
  }
  const edit = text => ({ ...state, draft: { ...draft, [draft.field]: text } });
  if (key.name === 'backspace') return edit([...draft[draft.field]].slice(0, -1).join(''));
  if (key.name === 'return' || key.name === 'enter') {
    // The question answered is the one the ticket screen's list has selected (ASS-101).
    const question = ticketQuestions(state)[state.ticketQuestionSelected];
    if (!draft.answer.trim() || !question) return state;
    const { id } = state.projects[state.project];
    const fields = Object.fromEntries(FORM.map(field => [field, draft[field].trim()]));
    return { ...state, draft: null, message: '', submit: { project: id, source: question.source, index: question.index, ...fields } };
  }
  const text = key.sequence ?? '';
  return [...text].length === 1 && text >= ' ' && text !== '\x7f' ? edit(draft[draft.field] + text) : state;
}

// A ticket screen opened afresh (ASS-101): every tab at its top, the first
// question and the first choice selected, on the tab openTicket picks;
// closing it clears the ticket and its chat.
export const OPENED_TICKET = {
  ticketScroll: 0, ticketStatesScroll: null, ticketHistoryScroll: 0, ticketQuestionsScroll: 0, ticketActionsScroll: null,
  ticketQuestionSelected: 0, ticketChoice: 0, ticketTab: 'chat', ticketMessage: '', message: '',
};
const CLOSED_TICKET = { ticket: null, ...OPENED_TICKET, ticketChatLog: null, ticketChatScroll: null, ticketChatMessage: '' };

// The ticket screen's chat (ASS-35): its log scrolls on the Chat tab (see ticketView), and closing leaves the ticket screen.
const TICKET_LOG = {
  log: 'ticketChatLog', scroll: 'ticketChatScroll', draft: 'ticketChatDraft', cursor: 'ticketChatCursor', message: 'ticketChatMessage',
  send: (state, text) => ({ ticketChatSend: { project: state.projects[state.project]?.id, key: state.ticket.key, text } }),
  close: CLOSED_TICKET,
  last: (state, size) => ticketView(state, size).pane?.last ?? 0,
  get: state => ({ draft: state.ticketChatDraft, cursor: state.ticketChatCursor }),
  set: (state, { draft, cursor }) => ({ ...state, ticketChatDraft: draft, ticketChatCursor: cursor }),
};

// y records the ticket action being asked about (its decide, for main.js); any other key gives it up.
export function confirmTicket(state, key) {
  const yes = key.sequence === 'y' || key.name === 'y';
  return { ...state, ticketConfirm: null, decide: yes ? state.ticketConfirm.decide : null, decideCloses: yes && state.ticketConfirm.closes === true };
}

// decided(state, error, closes) — main.js, once a ticket screen's decide has
// run: on success, one that closes (Delete ticket, ASS-104) closes the screen,
// back where the ticket was opened from — the dashboard or the backlog — as
// esc does; otherwise the screen stays, saying what went wrong, if anything.
export const decided = (state, error, closes) => (!error && closes ? { ...state, ...CLOSED_TICKET } : { ...state, ticketMessage: error ?? '' });

// The engine's blocked state: the step with is-blocked-state: true.
const blockedStep = steps => steps.find(s => s['is-blocked-state'] === true);

// A ticket's questions (ASS-101): the project's asked on it, whatever their
// answer status — its own file's and the project's global ones (ASS-103).
const ticketQuestions = state => (state.projects[state.project]?.questions ?? [])
  .filter(q => (q['asked-on-ticket'] ?? '').toLowerCase() === (state.ticket?.key ?? '').toLowerCase());

// gateStepsOf(engines, name, steps) — the steps of engine `name` (`steps`) a
// variation can be gated on leaving: no quarantine, none done, in sequence,
// each id "<engine>/<step>"; beneath a state-engine step, `depth` one more,
// its own engine's in turn (ASS-67), an engine never inside itself.
const gateStepsOf = (engines, name, steps, depth = 0, above = [name]) => steps
  .filter(s => s.area !== 'quarantine' && !s['is-done']).toSorted((a, b) => a.sequence - b.sequence)
  .flatMap(s => {
    const sub = s.action?.type === 'state-engine' && !above.includes(s.action.engine) ? s.action.engine : null;
    return [{ ...s, id: `${name}/${s.id}`, depth }, ...(sub ? gateStepsOf(engines, sub, engines[sub]?.steps ?? [], depth + 1, [...above, sub]) : [])];
  });

// The sprint ticket open on its screen and what its columns are drawn from
// (see ticketView): the variation on show — or the ticket's only one left once
// a variation was selected — its status text and the names of its engine's
// steps, its states and their counts for the History tab, the agents on it, and for the Actions tab the
// human actions: a human gate's choices (see humanGate), sending it to the
// blocked state (see blockedStep) unless it is there, setting its manual
// priority (see editPriority) and the states its variation is gated on leaving
// (see editGates, over `gateSteps`: the steps it can leave, see gateStepsOf).
// `missing` in place of it all for a ticket no longer in the sprint.
function sprintTicketParts(state) {
  const back = 'the sprint';
  const { tickets, steps } = sprintTickets(state);
  const same = tickets.filter(x => x.key === state.ticket.key);
  const t = same.find(x => x.variation.name === state.ticket.variation) ?? (same.length === 1 ? same[0] : undefined);
  if (!t) return { back, missing: `${state.ticket.key} is not in this sprint` };
  const { gate } = t;
  const engines = enginesOf(state.workflows), engineName = state.projects[state.project]?.stateEngine;
  const blocked = blockedStep(steps);
  const block = blocked && stateOf(t.variation) !== blocked.id
    ? [{ decision: 'Block this ticket', leadsTo: blocked.name, command: 'ticket:change-state', args: [blocked.id], confirm: `Block ${t.shownKey}?` }] : [];
  const paused = t.variation['is-paused'] === true;
  const review = t.variation['human-review'];
  // At Human Review, the variation's demo plan when it has a demo (ASS-76), and its review (ASS-118).
  const reviewing = gate?.step.id === 'human-review';
  const plan = reviewing ? state.projects[state.project]?.demoPlans?.[t.key]?.[t.variation.name] : undefined;
  // Every ticket an overlap could be stored on — sprint, backlog and the sprint tickets' backlog
  // entries — so overlapsOf shows one stored on the other side too (ASS-196).
  const pool = [...tickets, ...backlogTickets(state), ...(state.projects[state.project]?.backlogOfSprint ?? [])];
  return {
    back, t, steps, gate, demo: plan?.demo === true ? plan : null,
    review: reviewing ? width => reviewLines(state.projects[state.project]?.reviews?.[t.key], { variation: t.variation.name, mrs: t.variation['merge-request'], demo: plan, width }) : null,
    status: statusText(t, steps),
    stepName: id => steps.find(s => s.id === id)?.name ?? id,
    overlaps: overlapsOf(t, pool),
    // Its backlog entry's refinement history, shown before its development history (ASS-42).
    refinement: refinementHistory(state.projects[state.project]?.backlogOfSprint?.find(b => b.key.toUpperCase() === t.key.toUpperCase()), t.variation.name, engines),
    // A gate-when-leaving-state entry, "<engine>/<step>": that engine's step's name.
    gateName: entry => stepOf(engineSteps(engines, entry.slice(0, entry.lastIndexOf('/'))), entry.slice(entry.lastIndexOf('/') + 1))?.name ?? entry,
    prompted: id => steps.find(s => s.id === id)?.action?.type === 'prompt',
    agents: ticketAgents(liveAssignments(state), t).map(a => a['agent-name']),
    current: stateOf(t.variation),
    counts: stateCounts(t.variation, steps),
    recorded: gate && review?.state === gate.step.id ? review : null,
    gateSteps: gateStepsOf(engines, engineName, steps),
    choices: [
      ...(gate?.choices ?? []), ...(plan?.demo === true ? [{ decision: 'Demo', leadsTo: 'the VM\'s desktop', form: 'demo' }] : []),
      ...block, { decision: 'Set manual priority', form: 'priority' },
      ...(t.variation.name ? [{ decision: 'Gate when leaving states', form: 'gates' }] : []),
      ...handBack(state, t),
      ...(t.variation.name ? [paused
        ? { decision: 'Unpause this ticket', decide: ['ticket:set-paused', state.projects[state.project].id, t.key, t.variation.name, 'false'] }
        : { decision: 'Pause this ticket', decide: ['ticket:set-paused', state.projects[state.project].id, t.key, t.variation.name, 'true'] }] : []),
      ...deleteChoice(state, t.key, same.map(x => x.variation)),
    ],
  };
}

// Hand back to control (ASS-166), offered on a ticket worked by hand, sprint
// or backlog: ticket:set-manual off clears its worked-manually.
const handBack = (state, t) => (workedByHand(t) ? [{ decision: 'Hand back to control', decide: ['ticket:set-manual', state.projects[state.project].id, t.key, 'off'] }] : []);

// Delete ticket (ASS-104): ticket:delete, a soft delete, offered on a ticket
// — sprint or backlog, Jira's or off-board — unless its work has merged (a
// merge request Merged, by its build-status or status, on a live variation:
// ticket:delete refuses it). It asks first (confirm), naming the open merge
// requests it closes and what it stops: the agents on the ticket or its runs,
// the runs (those working for it, and theirs: contextOf) and the VMs; once
// it has run the screen closes (closes, see decided).
function deleteChoice(state, key, variations) {
  const mrs = variations.flatMap(v => v['merge-request'] ?? []);
  if (mrs.some(m => m['build-status'] === 'Merged' || m.status === 'Merged')) return [];
  const project = state.projects[state.project].id;
  const runs = state.transientEngines.filter(r => r.project === project && contextOf(r, state.transientEngines).workItem === key);
  const agents = state.assignments.filter(a => a.project === project && (a['work-item'] === key || runs.some(r => r.id === a['transient-state-engine'])));
  const vms = variations.map(v => v.vm?.name).filter(Boolean);
  const open = mrs.filter(m => m.status === 'Open' && m.url).map(m => m.key ?? m.url);
  const what = [
    open.length && `closes ${open.join(', ')}`,
    agents.length && `stops ${agents.map(a => a['agent-name']).join(', ')}`,
    runs.length && `ends ${runs.length === 1 ? 'run' : 'runs'} ${runs.map(r => r['state-engine']).join(', ')}`,
    vms.length && `stops VM ${vms.join(', ')}`,
  ].filter(Boolean);
  const confirm = `Delete ${key}? ${what.length ? `It ${what.join('; ')}.` : 'Nothing runs on it.'}`;
  return [{ decision: 'Delete ticket', confirm, closes: true, decide: ['ticket:delete', project, key] }];
}

// The backlog ticket open on its screen and what its columns are drawn from
// (ASS-20): the step of its refinement engine it is at as its status, named
// from that engine (refinementOf, ASS-150), the engine its harness-status names
// — the project's (refinementSteps) when none does — and that engine's steps
// for the History tab and its history (names alone: refinement keeps no visits), and as its
// human actions, at a human step, that step's exits a human chooses, read from
// the engine JSON (humanGate; one with asks-for-reason asks for the reason
// typed beneath, see editReason — ticket:human-review, which moves it at
// once) — then, whatever
// its step, setting its manual backlog priority (ASS-100, see editPriority);
// at a human step that shows the split proposal ("shows": "split-proposal",
// ASS-252), the tickets proposed (splitProposalLines) beneath the choices. Its
// manual-backlog-priority stands in the screen's manual-priority, which the
// details and the priority form read: the only manual priority it has.
function backlogTicketParts(state) {
  const back = 'the backlog';
  const found = backlogTickets(state).find(x => x.key === state.ticket.key);
  if (!found) return { back, missing: `${state.ticket.key} is not in the backlog` };
  const variation = found.variations?.find(v => v.name === state.ticket.variation) ?? {};
  const t = { ...found, 'manual-priority': found['manual-backlog-priority'] ?? null, icon: ({ Bug: ICONS.bugs, Spike: ICONS.spikes }[found['issue-type']] ?? ICONS.features), variation, shownKey: found.key, step: undefined };
  const engines = enginesOf(state.workflows), status = statusOf(engines, undefined, variation), { state: at, step } = status;
  const steps = engines[status.chain[0]?.['state-engine']]?.steps ?? refinementSteps(state);
  const gate = step ? humanGate({ ...t, step }, steps, { project: state.projects[state.project].id }) : null;
  // A gate whose step shows the split proposal (ASS-252): the tickets Split's agent proposed, beneath its choices.
  const proposing = gate?.step?.shows === 'split-proposal';
  // Every ticket an overlap could be stored on — sprint, backlog and the sprint tickets' backlog
  // entries — so overlapsOf shows one stored on the other side too (ASS-196).
  const pool = [...backlogTickets(state), ...sprintTickets(state).tickets, ...(state.projects[state.project]?.backlogOfSprint ?? [])];
  return {
    back, t, steps, gate,
    review: proposing ? width => splitProposalLines(state.projects[state.project]?.reviews?.[found.key]?.split, width) : null,
    reviewTitle: 'Split proposal',
    status: refinementName(status) ?? NONE, stepName: id => steps.find(s => s.id === id)?.name ?? id, prompted: () => false,
    overlaps: overlapsOf(t, pool),
    agents: projectAssignments(state).filter(a => a['work-item'] === found.key).map(a => a['agent-name']),
    current: at, counts: null,
    recorded: null, gateSteps: [],
    choices: [...(gate?.choices ?? []), { decision: 'Set manual priority', form: 'priority' }, ...handBack(state, found), ...deleteChoice(state, found.key, (found.variations ?? []).filter(v => !v['is-deleted']))],
  };
}

// The ticket screen (ASS-184), under what the keys do: the open tab
// (ticketTab, TABS) left of the quick-details panel (quickLines: where the
// ticket stands, what needs the operator — needsYou — never focused or
// scrolled), each tab keeping its own place —
//   Actions: the human actions (ticketActions), with below them what the
//     decision is about: at Human Review the review (ASS-118), at a backlog
//     ticket's split decision the split proposal (ASS-252), with a pending
//     requirements change the current and new descriptions (pendingChange);
//   Details: every field of the ticket (ticketLines);
//   History: its states (statesColumn — a sprint ticket's execution-engine
//     steps with their visits and dispatches, stateCounts, its quarantine
//     states after; a backlog ticket's refinement steps), the one it stands on
//     in reverse video and centred, beside its state history;
//   Questions: its questions (ticketQuestionLines), the selected one's details
//     and the answer being written (questionDetails), what the last save said;
//   Chat (ASS-35): what sending last said, the log — JSON event lines left
//     out, each tool result folded to one line (ASS-40) — and the prompt's
//     rows (promptRows), taking lines from the log down to one (fitRows, ASS-43).
// `pane` is the open tab's main pane — its lines, scroll, the lines it shows
// (`content`), the history's entry starts and the chat's `last` — for the
// keys to move; `paged` the pane PgUp/PgDn scroll (ASS-185 AC3: the Actions
// tab's, the History tab's states, the Questions tab's) and the state field
// keeping its place; `panel` the ticket, choices and gate for recording one. A
// ticket no longer on its screen's list gets the message alone, in one box.
// runningOn(state, t) — what ticket `t`'s running agents have spent so far
// (ASS-270), { ticket, variation }: every variation's and the one on show's,
// each agent's from its session's usage.json (state.usage, read every second
// beside its log — the dashboard never asks control) by spend.js usageSpend —
// its finished turns exact and the unfinished one estimated, 0 on a
// subscription. An agent counts as control's runningSpend counts it: its
// assignment names the ticket and a variation, whose dispatch its cost goes to.
function runningOn(state, t) {
  const on = liveAssignments(state).filter(a => a['work-item'] === t.key && a.variation != null);
  const sum = list => list.reduce((usd, a) => usd + usageSpend(state.usage?.[a['agent-name']]), 0);
  return { ticket: sum(on), variation: sum(on.filter(a => a.variation === t.variation?.name)) };
}
const STATES_WIDTH = 28;   // the History tab's states pane, borders included — at most half the tabs on a narrow screen
const ticketParts = state => (state.ticket.backlog ? backlogTicketParts(state) : sprintTicketParts(state));
const openQuestions = state => ticketQuestions(state).filter(isOpenQuestion).length;
function ticketView(state, size) {
  const { columns = 0, rows = Infinity, now = 0 } = size;
  const bottom = below(state) + platform(state, columns, now).length;
  const boxHeight = Math.max(9, rows - headerLines(state, columns, now).length - bottom - 2);
  const parts = ticketParts(state);
  if (parts.missing) return { head: [`esc returns to ${parts.back}`, ''], list: [parts.missing], width: columns, boxHeight, height: boxHeight - 2 };
  const { t, steps, choices, gateSteps } = parts;
  const side = panelWidth(columns);
  const tab = state.ticketTab, height = boxHeight - 2 - (side ? 0 : 3), width = tabWidth(columns), text = width - 4, statesWidth = Math.min(STATES_WIDTH, Math.floor(width / 2));
  const centre = (lines, at, content) => clamp(at - Math.floor(content / 2), 0, Math.max(0, lines.length - content));
  const spend = chatSpend(state.projects[state.project]?.collaborations, t.key);
  const running = runningOn(state, t);
  let head = [ticketKeys(state, parts.back), ''], panes, paged;
  if (tab === 'actions') {
    const [hint, actions, at] = ticketActions(state, parts, text);
    head = hint;
    const rule = title => `── ${title} ${'─'.repeat(Math.max(0, text - visible(title) - 4))}`;
    const about = state.gatesDraft != null ? [] : [
      ...(parts.review ? ['', rule(parts.reviewTitle ?? 'Human Review'), ...parts.review(text)] : []),
      ...(t['pending-requirements-change'] ? ['', rule('Pending requirements change'), ...pendingChange(t, text)] : []),
    ];
    const lines = [...actions, ...about];
    // Scrolled by hand (PgUp/PgDn) it stays put, unless a form is being typed or checked.
    const scroll = at == null && state.ticketActionsScroll != null ? state.ticketActionsScroll : centre(lines, at ?? Math.max(0, lines.findIndex(line => line.includes('▸'))), height);
    panes = [{ lines, scroll }];
    paged = { field: 'ticketActionsScroll', content: height };
  } else if (tab === 'details' || tab === 'history') {
    const { details, history, starts } = ticketLines(t, {
      status: parts.status, stepName: parts.stepName, gateName: parts.gateName, prompted: parts.prompted, agents: parts.agents,
      columns: tab === 'details' ? text : width - statesWidth - 3, steps, chatSpend: spend, spendLimit: spendLimit(t, state.projects[state.project]?.spendLimit ?? null), refinement: parts.refinement,
      running: running.variation, ticketRunning: running.ticket,
      overlaps: parts.overlaps,
    });
    if (tab === 'details') panes = [{ lines: details, scroll: state.ticketScroll }];
    else {
      const states = statesColumn(steps, { current: parts.current, counts: parts.counts, width: statesWidth - 4 });
      panes = [
        { head: ['States'], lines: states, width: statesWidth, scroll: state.ticketStatesScroll ?? centre(states, Math.max(0, states.findIndex(line => line.includes('\x1b[7m'))), height - 1) },
        { lines: history, starts, scroll: state.ticketHistoryScroll },
      ];
      paged = { field: 'ticketStatesScroll', content: height - 1 };
    }
  } else if (tab === 'questions') {
    const asked = ticketQuestions(state);
    const chosen = asked[state.ticketQuestionSelected];
    const lines = [
      ...ticketQuestionLines(asked, { selected: state.ticketQuestionSelected, focused: true, columns: text }),
      ...(chosen ? ['', ...questionDetails(chosen, state.draft, text, t.url)] : []),
      ...(state.message ? ['', red(state.message)] : []),   // what the last answer's save said
    ];
    panes = [{ lines, scroll: state.ticketQuestionsScroll }];
    paged = { field: 'ticketQuestionsScroll', content: height };
  } else {
    const log = foldResults(state.ticketChatLog?.filter(line => !line.startsWith('{"type":'))) ?? ['no messages yet: type one, enter sends it'];
    const said = state.ticketChatMessage ? [red(state.ticketChatMessage)] : [];
    // The prompt has the tab's lines less what sending said and one for the log (ASS-43).
    const prompt = fitRows(promptRows(state.ticketChatDraft, state.ticketChatCursor, true, text), height - said.length - 1);
    const content = height - said.length - prompt.length;
    panes = [{ head: said, lines: log, foot: prompt, wrap: true, scroll: state.ticketChatScroll ?? Infinity, last: scrollLast(log, { width, height: content + 2, wrap: true }) }];
  }
  const main = panes.at(-1);
  const open = openQuestions(state);
  const project = state.projects[state.project];
  const screenshots = ticketScreenshots(t, project?.dir && join(project.dir, 'work', t.key, 'screenshots'), Object.values(project?.reviews?.[t.key]?.screenshots ?? {}).flat());
  const documents = ticketDocuments(t, project?.reviews?.[t.key]);   // ASS-261: read with the reviews, nothing read here
  const facts = { status: parts.status, agents: parts.agents, needs: needsYou(parts.gate, open), chatSpend: spend, running: running.variation, documents, screenshots };
  const panel = side ? quickLines(t, { ...facts, now: now ?? new Date(), width: side - 4 }) : stripLines(t, { ...facts, width: columns });
  return {
    head, boxHeight, gateSteps,
    pane: { ...main, content: height - (main.head?.length ?? 0) - (main.foot?.length ?? 0) },
    paged: paged && { ...paged, lines: panes[0].lines, scroll: panes[0].scroll },
    panel: { t, choices, gate: parts.gate },
    lines: ticketTabs({ tab, panes, panel, columns, height, badges: { gate: gateWaits(parts.gate), open }, tabs: shownTabs(state) }),
  };
}

// The human actions and what the keys do above them: the choices
// (gateLines), with the manual priority or the rejection reason being typed
// under them, or in their place the states the variation is gated on leaving,
// each checked off; `at` the line to keep in view while one is being typed or
// checked.
function ticketActions(state, { t, choices, gate, recorded, gateSteps, back, demo }, width) {
  if (state.gatesDraft != null) {
    const { ids, at } = state.gatesDraft;
    const above = [...wrap('Gate this ticket when it leaves each state checked: it waits there, once its work is done, for you to approve the move on.', width), ''];
    const rows = gateSteps.map((s, i) => {
      const text = `${'  '.repeat(s.depth ?? 0)}[${ids.includes(s.id) ? 'x' : ' '}] ${s.name}`;
      return i === at ? `  ▸ \x1b[7m${text}\x1b[0m` : `    ${text}`;
    });
    return [['↑/↓ move   space checks or unchecks   enter saves   esc cancels', ''], [...above, ...rows], above.length + at];
  }
  const lines = gateLines({
    title: gate?.title, choices, selected: state.ticketChoice, focused: true, past: state.day != null,
    recorded, held: gate?.held, message: state.ticketMessage, width,
  });
  if (state.ticketConfirm) lines.push('', ...wrap(`${state.ticketConfirm.decision} y/n`, width).map(red));
  if (demo) lines.push(...demoLines(demo, state.demos[`${t.key}.${t.variation.name}`], width));
  if (state.priorityDraft != null) {
    lines.push('', `Manual priority: ${state.priorityDraft}█`);
    return [['type a whole number from 1   enter saves it, empty clears it   esc cancels', ''], lines, lines.length - 1];
  }
  if (state.reasonDraft != null) {
    lines.push('', `Reason: ${state.reasonDraft}█`);
    return [['type why it is rejected   enter rejects it   esc cancels', ''], lines, lines.length - 1];
  }
  if (state.returnDraft != null) {
    lines.push('', 'Return to:', ...RETURN_STEPS.map(([, name], i) => `${i === state.returnDraft.at ? '▸' : ' '} ${name}`));
    return [['↑/↓ choose the step it goes back to   enter rejects it   esc cancels', ''], lines, lines.length - RETURN_STEPS.length + state.returnDraft.at];
  }
  return [[ticketKeys(state, back), ''], lines, null];
}

// demoLines(plan, run, width) — under the human actions at Human Review
// (ASS-76): how the demo is viewed in the VM (its browser at the address, a
// terminal with the commands, or the plan's words), how the Demo action last
// asked here went (run: { status: starting, ready or failed, message }), and
// the plan's what to look at.
const DEMO_STATUS = {
  starting: 'starting: the VM restarts with a window onto its desktop, then the setup runs and the ready-check is polled…',
  ready: 'ready: its desktop is open on the Mac, the tool on it.',
};
function demoLines(plan, run, width) {
  const { view } = plan;
  const how = view.with === 'browser' ? [`Demo in the VM's browser at ${view.address}`]
    : view.with === 'terminal' ? ['Demo in a terminal at /repos/:', ...view.commands.map(c => `$ ${c}`)]
    : [`Demo: ${view.how}`];
  const said = run && (run.status === 'failed' ? color('31')(`failed: ${run.message}`) : DEMO_STATUS[run.status]);
  return [
    '', ...how.flatMap(line => wrap(line, width)), ...(said ? wrap(said, width) : []),
    '', 'Look at:', ...plan['look-at'].flatMap(item => wrap(`• ${item}`, width)),
  ];
}

// What the keys do while an answer is being written (see editAnswer).
const ANSWER_HINT = 'type   tab next field   enter saves   esc cancels';
// What the keys do on each of a ticket screen's tabs (ASS-184 AC3).
const TICKET_HINTS = {
  actions: '↑/↓ choose   enter records the choice   PgUp/PgDn scroll', details: '↑/↓ scroll the details', history: '↑/↓ entry by entry   PgUp/PgDn scroll the states',
  questions: '↑/↓ choose a question   enter answers it   PgUp/PgDn scroll', chat: 'type a message, enter sends it   ←/→ move the cursor   ↑/↓ scroll the chat',
};
// The tabs shown (ASS-262): Chat only with its flag, ticket-chat-tab, on.
const shownTabs = state => tabsOf(featureOn(state, 'ticket-chat-tab'));
const ticketKeys = (state, back) => `esc returns to ${back}   ${state.ticketTab === 'chat' ? 'tab switches tabs' : `tab or 1-${shownTabs(state).length} switch tabs`}   ${state.draft != null ? ANSWER_HINT : TICKET_HINTS[state.ticketTab]}`;

// Opening a ticket's screen: its chat asked for (ticketChatOpen, for main.js to start or catch up), shown afresh —
// only with the Chat tab shown (ASS-262): without it, no chat is started or briefed.
const openChat = (state, key) => ({ ticketChatOpen: { project: state.projects[state.project]?.id, key }, ticketChatLog: null, ticketChatScroll: null, ticketChatDraft: '', ticketChatCursor: 0, ticketChatMessage: '' });
// openTicket(state, ticket) — the screen of `ticket` ({ key, variation, backlog }) opened afresh, on defaultTab's tab (ASS-184 AC4).
export function openTicket(state, ticket) {
  const chat = featureOn(state, 'ticket-chat-tab');
  const opened = { ...state, ...(chat ? openChat(state, ticket.key) : {}), ...OPENED_TICKET, ticket };
  const { gate } = ticketParts(opened);
  return { ...opened, ticketTab: defaultTab(gate, openQuestions(opened), chat) };
}

// A key on the ticket screen: escape returns to the dashboard or the backlog;
// tab opens the next tab (shownTabs), shift-tab the one before, and 1–5 (1–4
// without Chat, ASS-262) a tab by its number (ASS-184 AC3: not while typing — the chat's keys are in
// viewTicketChat, the forms' their own). ↑/↓ do the open tab's job: on
// Actions they move the choice, and enter asks for it to be recorded as
// `decide`, the agent-cli command and its arguments — or, for a choice with a
// form, opens it; for one with a confirm (Block this ticket), asks first
// (ticketConfirm) — not on a past day: the only tab an action is taken on. On
// Questions they choose one, the tab scrolling to keep it in view, and enter
// opens the answer form (editAnswer) on it. On Details they scroll, and on
// History step entry by entry (ASS-145), no further than its lines go.
// PgUp/PgDn page the open tab's `paged` pane (ASS-185 AC3) — nothing on
// Details or Chat.
const TICKET_SCROLLS = { details: 'ticketScroll', history: 'ticketHistoryScroll' };
// A choice names its whole command (decide), or one run at its step (at: a gate's, its detailed step) or the variation's state.
const decideOf = (state, t, choice) => choice.decide ?? [choice.command, state.projects[state.project].id, t.key, t.variation.name, choice.at ?? stateOf(t.variation), ...choice.args];
export function viewTicket(state, key, size) {
  if (key.name === 'escape') return { ...state, ...CLOSED_TICKET };
  const { pane, panel, paged } = ticketView(state, size);
  if (!panel) return state;
  const paging = { pageup: -1, pagedown: 1 }[key.name];
  if (paging) {
    if (!paged) return state;
    const scroll = clamp(paged.scroll + paging * Math.max(1, paged.content), 0, Math.max(0, paged.lines.length - paged.content));
    return scroll === state[paged.field] ? state : { ...state, [paged.field]: scroll };
  }
  const ids = shownTabs(state).map(([id]) => id);
  if (key.name === 'tab') return { ...state, ticketTab: ids[(ids.indexOf(state.ticketTab) + (key.shift ? -1 : 1) + ids.length) % ids.length] };
  if (/^[1-9]$/.test(key.sequence ?? '') && Number(key.sequence) <= ids.length && !key.ctrl) return { ...state, ticketTab: ids[Number(key.sequence) - 1] };
  const onActions = state.ticketTab === 'actions';
  if (key.name === 'return' && onActions) {
    const choice = panel.choices[state.ticketChoice];
    if (!choice || state.day) return state;
    const { t } = panel;
    if (choice.form === 'priority') return { ...state, priorityDraft: String(t['manual-priority'] ?? ''), ticketMessage: '' };
    if (choice.form === 'reason') return { ...state, reasonDraft: '', ticketMessage: '' };
    if (choice.form === 'demo') {
      const at = `${t.key}.${t.variation.name}`;
      if (state.demos[at]?.status === 'starting') return state;
      return { ...state, demoRun: ['vm:demo', state.projects[state.project].id, t.key, t.variation.name], demos: { ...state.demos, [at]: { status: 'starting' } }, ticketMessage: '' };
    }
    if (choice.form === 'gates') return { ...state, gatesDraft: { ids: t.variation['gate-when-leaving-state'] ?? [], at: 0 }, ticketMessage: '' };
    if (choice.confirm) return { ...state, ticketConfirm: { decision: choice.confirm, decide: decideOf(state, t, choice), closes: choice.closes === true }, ticketMessage: '' };
    // A gate's choice recorded, nothing is left selected (ASS-131): the gate's
    // choices go once control moves the ticket on, and what slides into their place must not be under the cursor.
    return { ...state, decide: decideOf(state, t, choice), ticketMessage: '', ticketChoice: panel.gate?.choices.includes(choice) ? -1 : state.ticketChoice };
  }
  if (key.name === 'return' && state.ticketTab === 'questions') {
    const question = ticketQuestions(state)[state.ticketQuestionSelected];
    const draft = { field: FORM[0], ...Object.fromEntries(FORM.map(field => [field, question?.[field] ?? ''])) };
    return question ? { ...state, draft, message: '' } : state;
  }
  const step = { up: -1, down: 1 }[key.name];
  if (!step) return state;
  if (onActions) {
    const ticketChoice = clamp(state.ticketChoice + step, 0, Math.max(0, panel.choices.length - 1));
    return ticketChoice === state.ticketChoice ? state : { ...state, ticketChoice, ticketActionsScroll: null };   // the choice back in view
  }
  if (state.ticketTab === 'questions') {
    const ticketQuestionSelected = clamp(state.ticketQuestionSelected + step, 0, Math.max(0, ticketQuestions(state).length - 1));
    if (ticketQuestionSelected === state.ticketQuestionSelected) return state;
    const { lines, content } = ticketView({ ...state, ticketQuestionSelected }, size).pane;
    const at = Math.max(0, lines.findIndex(line => line.includes('▸')));
    return { ...state, ticketQuestionSelected, ticketQuestionsScroll: clamp(at - Math.floor(content / 2), 0, Math.max(0, lines.length - content)) };
  }
  const field = TICKET_SCROLLS[state.ticketTab];
  if (!field) return state;
  // No further than its last lines on show, and always at least a line, so ↑/↓ answer on a tab that fits.
  const end = Math.max(1, pane.lines.length - pane.content);
  // The history moves to the next or previous entry's first row (ASS-145), whatever their heights; the details a line.
  const to = !pane.starts ? pane.scroll + step
    : step > 0 ? pane.starts.find(at => at > pane.scroll) ?? end : pane.starts.findLast(at => at < pane.scroll) ?? 0;
  const scroll = clamp(to, 0, end);
  return scroll === state[field] ? state : { ...state, [field]: scroll };
}

// A key while the ticket's Chat tab is open (ASS-35): tab and shift-tab
// switch tabs, as on the rest of the screen; every other key as on a session
// view (viewLog) — printable keys are the message's text, digits, space, !, /,
// ? and Q too; enter asks for it to be sent as `ticketChatSend`; ↑/↓ scroll
// its log; esc clears it, then leaves the ticket screen.
export function viewTicketChat(state, key, size) {
  if (key.name === 'tab' || ticketParts(state).missing) return viewTicket(state, key, size);
  return viewLog(state, key, size, TICKET_LOG);
}

// A key while the manual priority is typed: digits are typed; enter asks for
// it to be saved as `decide`, a ticket:set-manual-priority — on a backlog
// ticket ticket:set-manual-backlog-priority (ASS-100) — empty clears it;
// escape gives up.
export function editPriority(state, key) {
  const draft = state.priorityDraft;
  if (key.name === 'escape') return { ...state, priorityDraft: null };
  if (key.name === 'backspace') return { ...state, priorityDraft: draft.slice(0, -1) };
  if (key.name === 'return' || key.name === 'enter') {
    return { ...state, priorityDraft: null, ticketMessage: '', decide: [state.ticket.backlog ? 'ticket:set-manual-backlog-priority' : 'ticket:set-manual-priority', state.projects[state.project].id, state.ticket.key, draft] };
  }
  return /^[0-9]$/.test(key.sequence ?? '') ? { ...state, priorityDraft: draft + key.sequence } : state;
}

// A key while the reason a ticket is rejected for is typed: text is typed;
// enter asks for the rejection to be recorded as `decide`, the chosen
// Reject's command with the reason last — ticket:human-review, at Human
// Review Rejected (ASS-118) or an exit that asks for a reason (a backlog
// ticket's Reject, ASS-144) — not with no reason; a choice with returnSteps
// (ASS-228) asks the step to return to first (editReturn); escape gives up.
export function editReason(state, key, size) {
  const draft = state.reasonDraft;
  if (key.name === 'escape') return { ...state, reasonDraft: null };
  if (key.name === 'backspace') return { ...state, reasonDraft: [...draft].slice(0, -1).join('') };
  if (key.name === 'return' || key.name === 'enter') {
    if (!draft.trim()) return state;
    const { panel } = ticketView(state, size);
    const choice = panel?.choices[state.ticketChoice];
    if (!choice) return { ...state, reasonDraft: null };
    if (choice.returnSteps) return { ...state, reasonDraft: null, returnDraft: { reason: draft.trim(), at: 0 } };
    return { ...state, reasonDraft: null, ticketMessage: '', ticketChoice: -1, decide: [...decideOf(state, panel.t, choice), draft.trim()] };   // a gate's choice: nothing left selected (ASS-131)
  }
  const text = key.sequence ?? '';
  return [...text].length === 1 && text >= ' ' && text !== '\x7f' ? { ...state, reasonDraft: draft + text } : state;
}

// A key while the step a Human Review rejection returns to is chosen (ASS-228):
// ↑/↓ move through RETURN_STEPS, Write Execution Plan first; enter asks for the
// rejection to be recorded as `decide`, the chosen Reject's command with the
// reason and the step's id last; escape gives up.
export function editReturn(state, key, size) {
  const draft = state.returnDraft;
  if (key.name === 'escape') return { ...state, returnDraft: null };
  const step = { up: -1, down: 1 }[key.name];
  if (step) return { ...state, returnDraft: { ...draft, at: clamp(draft.at + step, 0, RETURN_STEPS.length - 1) } };
  if (key.name !== 'return' && key.name !== 'enter') return state;
  const { panel } = ticketView(state, size);
  const choice = panel?.choices[state.ticketChoice];
  if (!choice) return { ...state, returnDraft: null };
  return { ...state, returnDraft: null, ticketMessage: '', ticketChoice: -1, decide: [...decideOf(state, panel.t, choice), draft.reason, RETURN_STEPS[draft.at][0]] };
}

// A key while the states a variation is gated on leaving are set (see
// ticketView's gateSteps): ↑/↓ move, space checks or unchecks; enter asks for
// them to be saved as `decide`, a ticket:set-gate-when-leaving-state, in step
// order (any checked that are not offered after); escape gives up.
export function editGates(state, key, size) {
  const { ids, at } = state.gatesDraft;
  const { gateSteps, panel } = ticketView(state, size);
  if (key.name === 'escape') return { ...state, gatesDraft: null };
  const step = { up: -1, down: 1 }[key.name];
  if (step) return { ...state, gatesDraft: { ids, at: clamp(at + step, 0, Math.max(0, gateSteps.length - 1)) } };
  const id = gateSteps[at]?.id;
  if (key.name === 'space' && id) return { ...state, gatesDraft: { ids: ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id], at } };
  if (key.name === 'return' || key.name === 'enter') {
    const ordered = [...new Set(gateSteps.map(s => s.id).filter(x => ids.includes(x))), ...ids.filter(x => !gateSteps.some(s => s.id === x))];   // an engine under two steps listed twice, saved once
    const { t } = panel;
    return { ...state, gatesDraft: null, ticketMessage: '', decide: ['ticket:set-gate-when-leaving-state', state.projects[state.project].id, t.key, t.variation.name, ...ordered] };
  }
  return state;
}

// Its body: the tabs beside the quick-details panel (ASS-184), or the one box saying it is no longer there.
export function view(state, size) {
  const view = ticketView(state, size);
  if (!view.lines) return [...view.head, ...scrollBox(view.list, { width: view.width, height: view.boxHeight, scroll: state.ticketScroll })];
  return [...view.head, ...view.lines];
}
