// A ticket's chat on its screen (ASS-35): one Claude session for the ticket's
// whole life, run on the chat screen's runner (chatRunner, ASS-33), kept in
// data/projects/<project>/work/<KEY>/collaboration.json — { session-id, briefed,
// spend-usd, raised } — written only through the agent-cli (collaboration:*).
// Its first prompt is a briefing (prompts/ticket-expert) telling it where every
// fact lives; each later opening sends what changed since (catchUp), and when
// something is off with the ticket (problems, ASS-36), asks it what.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tokenSpend, humanGate } from './ticket.js';
import { stateOf, isUnopened, unopenedAs, mrShown } from './status.js';
import { dataDir } from '../data-folder.js';
import { isOpenQuestion } from '../control/engine.js';

// chatId(project, key) — the ticket's chat on the runner: its log in data/chats/<project>/<key>/.
export const chatId = (project, key) => `${project}/${key}`;

// snapshot(ticket, questions) — what a briefing told the agent, to work out
// later what changed (catchUp): the title and description; per variation its
// acceptance criteria, how many state changes, its merge requests (key and
// build status) and agents' spend (tokenSpend); and the ticket's questions
// (its questions-and-answers.json's, as loadQuestions gives them).
export function snapshot(ticket, questions = []) {
  return {
    title: ticket.title ?? null,
    description: ticket.description ?? null,
    variations: Object.fromEntries((ticket.variations ?? []).map(v => [v.name, {
      criteria: (v['acceptance-criteria'] ?? []).map(c => c.description ?? ''),
      changes: v['state-changes']?.length ?? 0,
      mrs: (v['merge-request'] ?? []).map(m => (isUnopened(m) ? `MR ${m.id} ${unopenedAs(m)}` : `${m.key} ${mrShown(m) ?? ''}`.trim())),
      spend: tokenSpend(v),
    }])),
    questions: questions.map(q => ({ question: q.question ?? '', status: q.status ?? '', answer: q.answer ?? '' })),
  };
}

// catchUp(briefed, ticket, questions) — "Since your last briefing on <KEY>:"
// and a line per change from the snapshot `briefed`: the title, the
// description, and per variation a new one, its acceptance criteria, each
// state change since (from → to at its time), each new or changed merge
// request and its spend; each new or changed question. Null when nothing did.
export function catchUp(briefed, ticket, questions = []) {
  const now = snapshot(ticket, questions);
  const lines = [
    ...(now.title !== briefed.title ? [`Title: ${now.title}`] : []),
    ...(now.description !== briefed.description ? ['The description changed: read it again.'] : []),
    ...(ticket.variations ?? []).flatMap(v => {
      const was = briefed.variations?.[v.name], is = now.variations[v.name];
      if (!was) return [`${v.name}: a new variation`];
      return [
        ...(JSON.stringify(is.criteria) !== JSON.stringify(was.criteria) ? [`${v.name}: the acceptance criteria changed: read them again.`] : []),
        ...(v['state-changes'] ?? []).slice(was.changes).map(c => `${v.name}: ${c['from-state']} → ${c['to-state']} at ${c.timestamp}`),
        ...is.mrs.filter(m => !was.mrs.includes(m)).map(m => `${v.name}: merge request ${m}`),
        ...(is.spend !== was.spend ? [`${v.name}: spend ${is.spend ?? '$0.00'} (was ${was.spend ?? '$0.00'})`] : []),
      ];
    }),
    ...now.questions.flatMap((q, i) => (JSON.stringify(q) === JSON.stringify(briefed.questions?.[i])
      ? [] : [`Question ${i} (${q.status}): ${q.question}${q.answer ? ` — ${q.answer}` : ''}`])),
  ];
  return lines.length ? [`Since your last briefing on ${ticket.key}:`, ...lines.map(l => `- ${l}`), 'Read the files again where you need more.'].join('\n') : null;
}

// briefing(root, { project, ticket, sprint }) — prompts/ticket-expert/prompt.txt
// with absolute paths filled in: the project's folder, the ticket's work
// folder, the file it is in (the active sprint's sprint.json when `sprint`,
// else backlog.json), agent.sh and each variation's worktree folder.
export function briefing(root, { project, ticket, sprint }) {
  const folder = join(dataDir(root), 'projects', project);
  const worktrees = (ticket.variations ?? []).map(v => v.build?.['worktree-folder']).filter(Boolean);
  const values = {
    project, ticket: ticket.key, 'project-folder': folder, 'ticket-folder': join(folder, 'work', ticket.key),
    'ticket-file': sprint ? join(folder, 'sprints', `sprint-${sprint.number}`, 'sprint.json') : join(folder, 'backlog.json'),
    'backlog-file': join(folder, 'backlog.json'), 'agent-sh': join(root, 'agent.sh'), worktree: worktrees.join(', ') || 'none yet',
  };
  return readFileSync(join(root, 'prompts', 'ticket-expert', 'prompt.txt'), 'utf8').trim().replace(/\{([\w-]+)\}/g, (match, name) => values[name] ?? match);
}

// opening({ collaboration, running, ticket, questions, briefing, problems }) —
// what to send as the ticket's screen opens, the snapshot to keep as briefed
// and the problems to keep as raised: the `briefing` when it has never been
// briefed and no agent runs; once briefed, the catch-up (none when nothing
// changed). After either, when its `problems` (see problems) are not those
// collaboration.json last raised, the agent is asked about them (raising) and
// they are kept; healthy, what was raised is cleared ([]) and nothing asked.
// Null when there is nothing to send or keep, or while its first briefing is
// under way (running, not yet recorded).
export function opening({ collaboration, running, ticket, questions, briefing: text, problems: now = [] }) {
  const briefed = collaboration?.briefed;
  if (!briefed && running) return null;
  const change = briefed ? catchUp(briefed, ticket, questions) : text;
  const raise = JSON.stringify(now) !== JSON.stringify(collaboration?.raised ?? []);
  const send = [change, raise && now.length ? raising(ticket.key, now) : null].filter(Boolean).join('\n\n');
  if (!send && !raise) return null;
  return { text: send || null, ...(change ? { snapshot: snapshot(ticket, questions) } : {}), ...(raise ? { raised: now } : {}) };
}

// raising(key, reasons) — the prompt asking the agent about what is off: the reasons, then what to say.
const raising = (key, reasons) => [`Something is off with ${key}:`, ...reasons.map(r => `- ${r}`), 'Say what the problem is and what you need from the operator.'].join('\n');

// ticketChat(chats, { project, key, collaboration, cwd, env, confinedBy, record }) — the
// ticket's chat on `chats` (a chatRunner): send(text) to its agent, started
// first when none runs (in cwd, with env, confined by confinedBy), resuming the session collaboration
// names. record(args) runs the agent-cli: collaboration:set-session once a
// new session is named, collaboration:add-spend after each turn, with its
// cost and billing (ASS-216).
export function ticketChat(chats, { project, key, collaboration, cwd, env, confinedBy, record }) {
  const session = collaboration?.['session-id'] ?? null;
  return {
    send: text => chats.send({ id: chatId(project, key), 'session-id': session }, text, {
      cwd, env, confinedBy,
      onSession: id => { if (id !== session) record(['collaboration:set-session', project, key, id]); },
      onCost: (usd, billing) => record(['collaboration:add-spend', project, key, String(usd), ...(billing ? [billing] : [])]),
    }),
  };
}

// problems({ project, ticket, steps, questions, selfHealing }) — what is off
// with a ticket (ASS-36), decided by the code, never the AI: one reason per
// fact, [] when healthy. Per live variation (its name first): blocked — at
// the blocked state or a step with is-blocked-state; blocked-for-human, which
// is itself a human gate, so not named as one too; waiting at a human gate
// (humanGate, given the steps of its engine: the execution engine's for a
// sprint ticket, its refinement engine's for a backlog one, ASS-144); paused by a self-healing fix — assignments.json self-healing
// (`selfHealing`), a fix whose paused names it in `project` — else its own
// is-paused, and why when control pre-empted it for a fast-tracked ticket (ASS-83). A project's or every project's pause is not one. Then each of
// the ticket's open `questions` (isOpenQuestion).
export function problems({ project, ticket, steps, questions = [], selfHealing = {} }) {
  const live = (ticket.variations ?? []).filter(v => !v['is-deleted']);
  return [
    ...live.flatMap(v => {
      const state = stateOf(v), step = steps.find(s => s.id === state);
      const forHuman = state === 'blocked-for-human';
      const fix = Object.values(selfHealing).find(f => (f.paused ?? []).some(p => p.project === project && p.ticket.toUpperCase() === ticket.key.toUpperCase() && p.variation === v.name));
      const gate = !forHuman && step && humanGate({ ...ticket, variation: v, step }, steps) ? step.name : null;
      return [
        ...(forHuman ? [`blocked-for-human (${step?.name ?? state})`] : state === 'blocked' || step?.['is-blocked-state'] ? [`blocked (${step?.name ?? state})`] : []),
        ...(gate ? [`waiting at a human gate (${gate})`] : []),
        ...(fix ? [`paused by self-healing fix ${fix.ticket} (${fix.summary})`] : v['is-paused'] === true ? [v['paused-for-fast-track'] ? `paused to free a seat for fast-tracked ${v['paused-for-fast-track']}` : 'paused'] : []),
      ].map(reason => `${v.name}: ${reason}`);
    }),
    ...questions.flatMap((q, i) => (isOpenQuestion(q) ? [`Question ${i} (${q.status}): ${q.question}`] : [])),
  ];
}
