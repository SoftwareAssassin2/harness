import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState as flagged, handleKey, render, decided, fitRows, controlExited, controlDraining } from '../../src/tui/app.js';
// The chat screen and the ticket screen's Chat tab on (ASS-262: off in
// src/tui/features.json), so the tests from before their flags run as they
// did; the ASS-262 tests turn them off (flagsOff).
const CHAT_ON = { 'chat-screen': true, 'ticket-chat-tab': true };
const initialState = (options = {}) => flagged({ features: CHAT_ON, ...options });
const flagsOff = (s, features = {}) => ({ ...s, features });
import * as agentsScreen from '../../src/tui/screens/agents.js';
import { visible, link, clip, from } from '../../src/tui/text.js';
import { backlogPriorities, rankBacklog } from '../../src/control/rank.js';
import { ticketLines, PANEL, panelWidth } from '../../src/tui/ticket.js';
import { sprintTickets, statusText, timestamp } from '../../src/tui/screens/shared.js';
import { problems } from '../../src/tui/collaboration.js';
import * as frame from '../../src/tui/screens/frame.js';
import { headerLines, platform } from '../../src/tui/screens/frame.js';
import * as sprintFlow from '../../src/tui/screens/sprint-flow.js';
import * as backlogFlow from '../../src/tui/screens/backlog-flow.js';
import { blockText } from '../../src/tui/font.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { engineDir } from '../support/engine-walk.js';
// A harness-status at `state` of the example-development engine.
const hs = state => ({ state, 'state-engine': 'example-development' });

const key = (name, extra = {}) => ({ name, ...extra });
const screen = { columns: 120, rows: 40, now: new Date('2026-10-01T16:04:00Z') };
const wide = { ...screen, columns: 200, rows: 44 };
// A draft with one code point ([...multiByteDraft].length is 3) that is two UTF-16 units
// (.length is 4) — a cursor step, backspace or delete must treat it as one character, not two.
const multiByteDraft = 'a🤖b';
// A ticket's work fields live in its variations; most tickets have one.
const single = fields => ({ variations: [{ name: 'A', ...fields }] });
const sprint = {
  number: 10, start: '2026-09-18', end: '2026-10-01',
  features: [{
    key: 'ABC-1', title: 'New Feature', url: 'http://t/ABC-1', priority: 2, points: 3,
    'ticket-system-assignment': 'Ada Example',
    ...single({
      'harness-status': hs('code-review'),
      'ai-feedback-short': 'Healthy',
      build: { branch: 'change/ABC-1', 'branch-url': 'http://b/ABC-1', worktree: '.worktrees/ABC-1', 'worktree-folder': '/src/my repo/.worktrees/ABC-1' },
      'acceptance-criteria': [
        { 'dev-status': 'Passed', 'testing-status': 'Passed' },
        { 'dev-status': 'Passed', 'testing-status': 'Failed' },
        { 'dev-status': 'Incomplete', 'testing-status': 'Incomplete' },
      ],
      'merge-request': [
        { key: '!1827', 'build-status': 'Running', url: 'http://mr/1827' },
        { key: '!12', 'build-status': 'Merged', url: 'http://mr/12' },
      ],
    }),
  }],
  bugs: [{ key: 'ABC-2', title: 'New Bug', priority: 1, ...single({ 'harness-status': hs('backlog') }) }],
  spikes: [{ key: 'ABC-3', title: 'New Spike', priority: 3 }],
};
const assignment = (name, item, variation = null, project = 'example') => ({ project, 'agent-name': name, 'work-item': item, variation });
const assignments = [assignment('Daredevil', 'ABC-1'), assignment('Elektra', 'ABC-1'), assignment('Punisher', 'Other')];
const engine = { name: 'example-development', steps: [{ id: 'backlog', name: 'Backlog', sequence: 1 }, { id: 'code-review', name: 'Code Review', sequence: 13 }] };
const projects = [{ id: 'example', name: 'Example', stateEngine: 'example-development', sprint }, { id: 'assassin', name: 'Software Assassin', sprint: null }];
const state = initialState({ projects, workflows: [engine], assignments });
// A human's pause (the dashboard's space) and an AI's, with why and when it should be over.
// Each on all agents (assignments.json pauses, by scope).
const HUMAN = { all: { human: { since: '2026-10-01T16:00:00Z' } } };
const AI = { all: { ai: { since: '2026-10-01T16:00:00Z', reason: 'Rotating the GitLab token', eta: '2026-10-01T16:29:00Z', agent: 'Ripley', project: 'harness', run: 'hc' } } };
const combined = (...pauses) => ({ all: Object.assign({}, ...pauses.map(p => p.all)) });
// A rate limit the selected project records (control writes it to every project).
const LIMIT = { claude: { since: '2026-10-01T16:00:00Z', type: 'five_hour', 'resets-at': '2026-10-01T18:04:00Z' } };   // per credential kind (ASS-215)
const limited = (s, rateLimit = LIMIT) => ({ ...s, projects: [{ ...s.projects[0], rateLimit }, ...s.projects.slice(1)] });
// Drops the selected row's reverse video, for checks on its exact colors.
const unhighlight = l => l.replaceAll('\x1b[7m', '');
const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
// A raw line with the blue mark (ASS-242) before `text`, the selected row's reverse video aside: ● right
// before it on the backlog; ⦿ on the sprint, only the ⚉ column between them (ASS-259).
const blueDot = (l, text) => /\x1b\[34m[●⦿]/.test(l) && new RegExp(`[●⦿][ ⚉]*${text.replaceAll('.', '\\.')}`, 'u').test(strip(l));
// A sprint row's Ticket cell up to its text, plain (ASS-259): c1 ▮ step, c2 type, c3 ☛ by hand, c4 ↯
// fast-tracked, c5 ⦿, c6 ⚉ agent working — one cell each, a blank when it does not apply; a blank, then the text.
const cols = ({ step = '▮', type = '✦', hand = ' ', fast = ' ', dot = ' ', agent = ' ' } = {}) => `${[step, type, hand, fast, dot, agent].join('')} `;
// How many lines of the key under the sprint grid (ASS-259) follow line `bottom`, its bottom border.
const keyUnder = (out, bottom) => {
  const end = out.slice(bottom + 1).findIndex(l => !/^([▮✦✘⌕☛↯⦿⚉]|PAUSED) /.test(strip(l)));
  return end < 0 ? out.length - bottom - 1 : end;
};
const lines = (s, size = screen) => render(s, size).map(strip);
const centered = (line, text, columns = screen.columns) =>
  assert.equal(line, ' '.repeat(Math.floor((columns - text.length) / 2)) + text);

test('fills the screen exactly, one string per row', () => {
  assert.equal(render(state, screen).length, 40);
  assert.equal(render(state, { ...screen, rows: 5 }).length, 5);
});

test('no line is wider than the screen', () => {
  for (const pauses of [{}, HUMAN, AI, combined(HUMAN, AI)]) {
    for (const line of lines({ ...state, pauses }, { ...screen, columns: 30 })) assert.ok(line.length <= 30, line);
    for (const line of lines(limited({ ...state, pauses }), { ...screen, columns: 30 })) assert.ok(line.length <= 30, line);
  }
});

test('color codes do not count toward the width', () => {
  const out = lines({ ...state, pauses: HUMAN }, { ...screen, columns: 76 });
  assert.equal(out[0], '█████ █████ █   █ █████ █████ ████    ████  █   █   █   █ █   █ █   █ █████ ');
});

test("the selected project's name sits to the right of the day box, on the line above where the gcloud warning goes", () => {
  const out = lines(state, wide);
  const box = out.findIndex(l => l.includes('day 14 of 14'));
  assert.match(out[box], /day 14 of 14 +│ {5}Example( |$)/);
  assert.equal(out.filter(l => /│ {5}Example/.test(l)).length, 1);   // the menu names it too
  assert.ok(lines({ ...state, project: 1 }, wide).some(l => /No active sprint {5}Software Assassin( |$)/.test(l)));
  const needing = { ...state, projects: [{ ...projects[0], gcloudReauthentication: true }, ...projects.slice(1)] };
  const warned = lines(needing, wide);
  assert.equal(warned[box].indexOf('Example'), warned[box + 1].indexOf("run 'gcloud"));
});

test('while the selected project needs gcloud logging in again, the sprint header says so, in white on red, to the right of the day box — on a past day too', () => {
  const needing = { ...state, projects: [{ ...projects[0], gcloudReauthentication: true }, ...projects.slice(1)] };
  const out = lines(needing, wide);
  const box = out.findIndex(l => l.includes('day 14 of 14'));
  assert.match(out[box + 1], /sprint ends today +│ {5}run 'gcloud auth login' asap( |$)/);
  assert.equal(out.filter(l => l.includes('gcloud')).length, 1);
  assert.ok(render(needing, wide).some(l => l.includes("\x1b[41;97m run 'gcloud auth login' asap \x1b[0m")));
  assert.ok(!lines(state).some(l => l.includes('gcloud')));                                   // not needed
  assert.ok(!lines({ ...needing, project: 1 }).some(l => l.includes('gcloud')));              // another project
  const past = { ...needing, day: '2026-09-30', projects: [{ ...needing.projects[0], days: { '2026-09-30': needing.projects[0].sprint } }, ...projects.slice(1)] };
  assert.ok(lines(past, wide).some(l => l.includes("run 'gcloud auth login' asap")));
});

// The fixture's state with only these assignments (ASS-59).
const assigned = (list, extra = {}) => initialState({ projects, workflows: [engine], assignments: list, ...extra });
const IDLE = '\x1b[41;97m No work in progress \x1b[0m';

test('with no agent on a ticket of the active sprint, the sprint header says "No work in progress" in white on red, where the gcloud warning goes (ASS-59)', () => {
  const idle = assigned([assignment('Punisher', 'Other')]);
  const out = lines(idle, wide);
  const box = out.findIndex(l => l.includes('day 14 of 14'));
  assert.match(out[box + 1], /sprint ends today +│ {5}No work in progress( |$)/);
  assert.ok(render(idle, wide).some(l => l.includes(IDLE)));
  assert.equal(out.filter(l => l.includes('No work in progress')).length, 1);
  assert.ok(!lines(state, wide).some(l => l.includes('No work in progress')));             // ABC-1 is worked
});

test('any agent on a ticket of the active sprint clears "No work in progress", key in any case, whatever its status or variation (ASS-59)', () => {
  const warned = list => lines(assigned(list), wide).some(l => l.includes('No work in progress'));
  assert.ok(!warned([assignment('Elektra', 'abc-3')]));                                     // a spike, lowercase
  assert.ok(!warned([{ ...assignment('Elektra', 'ABC-2', 'B'), status: 'waiting' }]));      // a bug's variation, any status
  assert.ok(warned([]));
  assert.ok(warned([assignment('Elektra', 'ABC-1', null, 'assassin')]));                    // another project's agent
});

test('health checks and backlog refinement are not work in progress (ASS-59)', () => {
  const checker = { ...assignment('Worf', null), 'health-check': true };
  const refiner = assignment('Ripley', 'ABC-50');                                            // on a backlog ticket (ASS-144: no run)
  const backlog = [{ key: 'ABC-50', variations: [{ name: 'A', 'harness-status': { state: 'groom', 'state-engine': 'example-backlog-refinement' } }] }];
  assert.ok(lines(assigned([checker, refiner], { projects: [{ ...projects[0], backlog }, projects[1]] }), wide).some(l => l.includes('No work in progress')));
});

test('"No work in progress" never shows without an active sprint, on a past day, or for another project (ASS-59)', () => {
  const idle = assigned([]);
  assert.ok(!lines({ ...idle, project: 1 }, wide).some(l => l.includes('No work in progress')));   // no active sprint
  const past = { ...idle, day: '2026-09-30', projects: [{ ...projects[0], days: { '2026-09-30': sprint } }, ...projects.slice(1)] };
  assert.ok(!lines(past, wide).some(l => l.includes('No work in progress')));
});

test('"No work in progress" shows while paused, and when every sprint ticket is delivered (ASS-59)', () => {
  assert.ok(lines({ ...assigned([]), pauses: HUMAN }, wide).some(l => l.includes('No work in progress')));
  const empty = initialState({ projects: [{ ...projects[0], sprint: { ...sprint, features: [], bugs: [], spikes: [] } }], workflows: [engine], assignments });
  assert.ok(lines(empty, wide).some(l => l.includes('No work in progress')));
});

test('with gcloud to log in again and no work in progress, both warnings show on that line, gcloud first, each boxed in red, a space between (ASS-59)', () => {
  const both = assigned([], { projects: [{ ...projects[0], gcloudReauthentication: true }, ...projects.slice(1)] });
  const out = render(both, wide);
  const box = out.findIndex(l => l.includes('day 14 of 14'));
  assert.ok(out[box + 1].includes(`\x1b[41;97m run 'gcloud auth login' asap \x1b[0m ${IDLE}`));
  assert.equal(out.filter(l => l.includes('No work in progress') || l.includes('gcloud')).length, 1);
});

test("while glab needs logging in again, the sprint header says so in white on red, after the gcloud warning, before No work in progress — on a past day too (ASS-61)", () => {
  const GLAB = "\x1b[41;97m run 'glab auth login' asap \x1b[0m";
  const needing = { ...state, projects: [{ ...projects[0], glabReauthentication: true }, ...projects.slice(1)] };
  const out = lines(needing, wide);
  const box = out.findIndex(l => l.includes('day 14 of 14'));
  assert.match(out[box + 1], /sprint ends today +│ {5}run 'glab auth login' asap( |$)/);
  assert.ok(render(needing, wide).some(l => l.includes(GLAB)));
  assert.ok(!lines(state, wide).some(l => l.includes('glab')));                              // not needed
  assert.ok(!lines({ ...needing, project: 1 }, wide).some(l => l.includes('glab')));         // another project
  const past = { ...needing, day: '2026-09-30', projects: [{ ...needing.projects[0], days: { '2026-09-30': sprint } }, ...projects.slice(1)] };
  assert.ok(lines(past, wide).some(l => l.includes("run 'glab auth login' asap")));
  const all = assigned([], { projects: [{ ...projects[0], gcloudReauthentication: true, glabReauthentication: true }, ...projects.slice(1)] });
  assert.ok(render(all, wide).some(l => l.includes(`\x1b[41;97m run 'gcloud auth login' asap \x1b[0m ${GLAB} ${IDLE}`)));
});

test('while a project\'s background work is off, the sprint header says Background work off in white on red, after the login warnings, before No work in progress (ASS-127)', () => {
  const OFF = '\x1b[41;97m Background work off \x1b[0m';
  const off = assigned([], { projects: [{ ...projects[0], glabReauthentication: true, backgroundWorkOff: true }, ...projects.slice(1)] });
  assert.ok(render(off, wide).some(l => l.includes(`\x1b[41;97m run 'glab auth login' asap \x1b[0m ${OFF} ${IDLE}`)), render(off, wide).join('\n'));
  assert.ok(!lines(state, wide).some(l => l.includes('Background work off')));                // on
  assert.ok(!lines({ ...off, project: 1 }, wide).some(l => l.includes('Background work off'))); // another project
});

test('the footer\'s last updated is the selected project\'s own: switching project shows that project\'s time (ASS-10)', () => {
  const s = { ...state, focus: 'menu', menuHidden: false, updatedAt: { 'example': Date.parse('2026-10-01T16:00:00Z'), assassin: Date.parse('2026-10-01T15:00:00Z') } };
  centered(lines(s).at(-1), 'last updated: 2026-10-01 16:00:00 UTC (4m ago)');
  centered(lines(handleKey(s, key('right'))).at(-1), 'last updated: 2026-10-01 15:00:00 UTC (1h 4m ago)');
});

test('at the very bottom, under the bottom line: when the data on show last changed, and how long ago', () => {
  const out = lines({ ...state, updatedAt: Date.parse('2026-10-01T16:00:00Z') });
  centered(out.at(-1), 'last updated: 2026-10-01 16:00:00 UTC (4m ago)');
  assert.match(out.at(-2), /press \? for menu/);
  assert.equal(out.length, screen.rows);
  assert.match(render({ ...state, updatedAt: Date.parse('2026-10-01T16:00:00Z') }, screen).at(-1), /^ +\x1b\[90mlast updated: /);   // gray
  assert.ok(!lines(state).some(l => l.includes('last updated')));     // never loaded: no line
});

test('running: a one-line centered banner', () => {
  centered(lines(state)[0], 'RUNNING  agents are working — press space to pause Example — ! to pause every project');
});

test('under the banner, one centered line per health-check assignment in any project: robot, agent name, status update', () => {
  const team = [
    { ...assignment('Doctor-Strange', null), 'health-check': true, 'ai-status-update-short': 'All systems nominal' },
    { ...assignment('Wong', null, null, 'elsewhere'), 'health-check': true },
    { ...assignment('Daredevil', 'ABC-1'), 'health-check': false, 'ai-status-update-short': 'Busy' },
  ];
  const out = lines(initialState({ projects, assignments: team }));
  centered(out[0], 'RUNNING  agents are working — press space to pause Example — ! to pause every project');
  centered(out[1], '🤖 Doctor-Strange - All systems nominal');
  centered(out[2], '🤖 Wong');
  assert.equal(out[3], '');
  assert.ok(!out.some(l => l.includes('Busy')));
});

test('paused by a human: PAUSED BY HUMAN in block letters, centered, then how to release', () => {
  const out = lines({ ...state, pauses: HUMAN });
  const block = [
    '█████ █████ █   █ █████ █████ ████    ████  █   █   █   █ █   █ █   █ █████ █   █',
    '█   █ █   █ █   █ █     █     █   █   █   █  █ █    █   █ █   █ ██ ██ █   █ ██  █',
    '█████ █████ █   █ █████ █████ █   █   ████    █     █████ █   █ █ █ █ █████ █ █ █',
    '█     █   █ █   █     █ █     █   █   █   █   █     █   █ █   █ █   █ █   █ █  ██',
    '█     █   █ █████ █████ █████ ████    ████    █     █   █ █████ █   █ █   █ █   █',
  ];
  const pad = ' '.repeat(Math.floor((120 - 81) / 2));
  assert.deepEqual(out.slice(0, 6), [...block.map(l => pad + l), '']);
  centered(out[6], 'PAUSED BY HUMAN — control is asking every agent to commit and stop');
  centered(out[7], 'press space to pause Example too — ! to release every project');
});

test('paused by an AI: PAUSED BY AI, then why and its ETA — how long until, or how long overdue; space pauses them too, but cannot release the AI\'s pause', () => {
  const out = lines({ ...state, pauses: AI });
  assert.equal(out[0].trim(), '█████ █████ █   █ █████ █████ ████    ████  █   █   █████ █████');
  centered(out[6], 'PAUSED BY AI — control is asking every agent to commit and stop');
  centered(out[7], 'Why: Rotating the GitLab token');
  centered(out[8], 'ETA: Thu Oct 1 @ 4:29 PM UTC — in 25m 0s');
  centered(out[9], 'press space to pause Example too — ! to pause every project — only the AI can release its pause');
  const late = lines({ ...state, pauses: AI }, { ...screen, now: new Date('2026-10-01T16:35:00Z') });
  centered(late[8], 'ETA: Thu Oct 1 @ 4:29 PM UTC — 6m 0s overdue');
});

test('paused by both: PAUSED BY AI in block letters, + PAUSED BY HUMAN in plain text beside the block\'s first line; space releases the human\'s pause only', () => {
  const out = lines({ ...state, pauses: combined(HUMAN, AI) });
  const alone = lines({ ...state, pauses: AI });
  assert.equal(out[0], `${alone[0]}  + PAUSED BY HUMAN`);                       // the block stays centered where it was; the queue hangs off its right
  assert.deepEqual(out.slice(1, 5), alone.slice(1, 5));
  centered(out[6], 'PAUSED BY AI — control is asking every agent to commit and stop');
  centered(out[9], 'press space to pause Example too — ! to release every project — only the AI can release its pause');
});

test('self-healing: SELF HEALING, then what is being fixed, the ticket, linked, and just the tickets it paused; the rest work on; a human\'s pause still shows', () => {
  // One record per fix ticket (assignments.json self-healing); this one holds example's tickets.
  const fix = { since: '2026-10-01T16:00:00Z', summary: 'The dev container is broken', ticket: 'ABC-1200', 'ticket-url': 'https://jira.example.com/browse/ABC-1200', project: 'harness', paused: [{ project: 'example', ticket: 'ABC-1201', variation: 'A' }, { project: 'example', ticket: 'ABC-1201', variation: 'B' }, { project: 'example', ticket: 'ABC-1076', variation: 'A' }] };
  const selfHealing = { 'ABC-1200': fix };
  const out = lines({ ...state, selfHealing });
  assert.equal(out[0].trim(), '█████ █████ █     █████   █   █ █████ █████ █     █████ █   █ █████');
  centered(out[6], 'SELF HEALING — control pauses only the tickets the fix holds');
  centered(out[7], 'Fixing: The dev container is broken');
  centered(out[8], 'Ticket: ABC-1200');
  centered(out[9], 'Paused: ABC-1201 (example), ABC-1076 (example)');
  centered(out[10], 'press space to pause Example — ! to pause every project');
  assert.match(render({ ...state, selfHealing }, screen)[8], /\x1b\]8;;https:\/\/jira\.example\.com\/browse\/ABC-1200\x1b\\ABC-1200\x1b\]8;;\x1b\\/);
  centered(lines({ ...state, selfHealing: { 'ABC-1200': { ...fix, project: 'example', paused: [] } } })[9], 'Paused: none');   // a fix for this project, holding nothing
  // A fix holding no ticket of this project, nor for it, shows nothing here.
  assert.match(lines({ ...state, selfHealing: { 'ABC-1200': { ...fix, paused: [{ project: 'assassin', ticket: 'S-1', variation: 'A' }] } } })[0], /RUNNING/);
  const both = lines({ ...state, pauses: HUMAN, selfHealing });
  assert.equal(both[0], `${out[0]}  + PAUSED BY HUMAN`);
  centered(both[6], 'SELF HEALING — control pauses only the tickets the fix holds');
  centered(both[10], 'press space to pause Example too — ! to release every project');
  const withAi = lines({ ...state, pauses: AI, selfHealing });                  // an AI's own pause beside it
  centered(withAi[10], 'ETA: Thu Oct 1 @ 4:29 PM UTC — in 25m 0s');
  centered(withAi[11], 'press space to pause Example too — ! to pause every project — only the AI can release its pause');
});

test('a project on the wrong Claude account (ASS-26): SIGN IN in block letters, what it expects and what it is logged in as, and how to sign in; another project shows RUNNING', () => {
  const hold = { since: '2026-10-01T16:00:00Z', expected: 'work@example.com', actual: 'me@example.com', 'config-dir': '/h/projects/example/.claude' };
  const held = (h = hold) => ({ ...state, projects: [{ ...state.projects[0], accountHold: h }, ...state.projects.slice(1)] });
  const out = lines(held());
  assert.equal(out[5], '');
  centered(out[6], 'SIGN IN — control starts none of Example\'s agents: it expects work@example.com, logged in as me@example.com');
  centered(out[7], 'Sign in: CLAUDE_CONFIG_DIR=/h/projects/example/.claude claude, then /login as work@example.com');
  assert.match(render(held(), screen)[6], /\x1b\[31mSIGN IN\x1b\[0m/);
  centered(lines(held({ ...hold, actual: null, 'config-dir': null }))[6], 'SIGN IN — control starts none of Example\'s agents: it expects work@example.com, not logged in');
  centered(lines(held({ ...hold, actual: null, 'config-dir': null }))[7], 'Sign in: claude, then /login as work@example.com');
  assert.match(lines({ ...held(), project: 1 })[0], /RUNNING/);
});

test('rate limited: RATE LIMITED in block letters, the limit\'s window and when it resets, counting down; a human\'s pause shows beside it and space still holds only that', () => {
  const out = lines(limited(state));
  assert.equal(out[0].trim(), '█████ █████ █████ █████   █     █████ █   █ █████ █████ █████ ████');
  assert.equal(out[4].trim(), '█   █ █   █   █   █████   █████ █████ █   █ █████   █   █████ ████');
  assert.equal(out[5], '');
  centered(out[6], 'RATE LIMITED — control sends its claude agents nothing until it resets');
  centered(out[7], 'Limit: 5-hour window');
  centered(out[8], 'Resets: Thu Oct 1 @ 6:04 PM UTC — in 2h 0m');
  centered(out[9], 'press space to pause Example too — ! to pause every project — the limit lifts on its own');
  const later = lines(limited(state), { ...screen, now: new Date('2026-10-01T18:05:00Z') });
  centered(later[8], 'Resets: Thu Oct 1 @ 6:04 PM UTC — 1m 0s ago');
  centered(lines(limited(state, { claude: { ...LIMIT.claude, type: 'monthly' } }))[7], 'Limit: monthly');
  // ASS-215: two kinds held — the banner names both; Limit and Resets are the latest entry's.
  const kinds = lines(limited(state, { ...LIMIT, anthropic: { since: '2026-10-01T17:00:00Z', type: 'seven_day', 'resets-at': '2026-10-01T19:04:00Z' } }));
  centered(kinds[6], 'RATE LIMITED — control sends its anthropic and claude agents nothing until it resets');
  centered(kinds[7], 'Limit: 7-day window');
  centered(kinds[8], 'Resets: Thu Oct 1 @ 7:04 PM UTC — in 3h 0m');
  assert.match(lines(limited(state, {}))[0], /RUNNING/);   // an empty map holds nothing
  // ASS-217 AC4: an API cap holding the project's fallback is named on the Limit line.
  const capped = s => ({ ...s, projects: [{ ...s.projects[0], apiCapHold: { since: '2026-10-01T17:00:00Z', cap: 'day', 'spend-usd': 10.4, 'limit-usd': 10 } }, ...s.projects.slice(1)] });
  centered(lines(capped(limited(state)))[7], 'Limit: 5-hour window — no agent starts on the API key: its day cap is reached ($10.40 of $10)');
  const both = lines(limited({ ...state, pauses: HUMAN }));
  assert.ok(both[0].startsWith(out[0]) && both[0].endsWith('  + PAUSED BY HUMAN'), both[0]);
  centered(both[6], 'RATE LIMITED — control sends its claude agents nothing until it resets');
  // Every further reason queues beside the block, one per line from the top, strongest first, in one column.
  const all = lines(limited({ ...state, pauses: combined(HUMAN, AI), selfHealing: { 'ABC-1': { since: '2026-10-01T16:00:00Z', summary: 'S', ticket: 'ABC-1', 'ticket-url': null, project: 'example', paused: [] } } }));
  assert.ok(all[0].startsWith(out[0]) && all[0].endsWith('  + SELF HEALING'), all[0]);
  assert.ok(all[1].startsWith(out[1]) && all[1].endsWith('  + PAUSED BY HUMAN'), all[1]);
  assert.equal(all[0].indexOf('  + '), all[1].indexOf('  + '));
  assert.equal(all[2], out[2]);
  assert.match(render(limited({ ...state, pauses: HUMAN }), screen)[0], /\x1b\[0m  \x1b\[31m\+ PAUSED BY HUMAN\x1b\[0m$/);   // red, like the block
  centered(both[9], 'press space to pause Example too — ! to release every project — the limit lifts on its own');
  assert.match(render(limited(state), screen)[6], /\x1b\[31mRATE LIMITED\x1b\[0m/);
  // Another project's limit is not this one's: the second project shows RUNNING.
  const other = lines({ ...limited(state), project: 1 });
  assert.match(other[0], /RUNNING/);
});

test('the RUNNING banner is green; PAUSED BY in both places is red', () => {
  assert.match(render(state, screen)[0], /^ +\x1b\[32mRUNNING\x1b\[0m  agents are working/);
  const out = render({ ...state, pauses: HUMAN }, screen);
  for (const line of out.slice(0, 5)) assert.match(line, /^ +\x1b\[31m█[█ ]+\x1b\[0m$/);
  assert.match(out[6], /^ +\x1b\[31mPAUSED BY HUMAN\x1b\[0m — control/);
});

test('space holds or releases the human\'s pause on the selected project, ! on all agents — on the sprint, its flow, the backlog, its flow, control and agents screens only, leaving an AI\'s', () => {
  const bang = key('1', { shift: true, sequence: '!' });
  assert.deepEqual(handleKey(state, key('space')).pauses, { 'example': { human: {} } });
  assert.deepEqual(handleKey(handleKey(state, key('space')), key('space')).pauses, {});
  assert.deepEqual(handleKey(state, bang).pauses, { all: { human: {} } });
  assert.deepEqual(handleKey({ ...state, pauses: HUMAN }, bang).pauses, {});
  assert.deepEqual(handleKey({ ...state, pauses: HUMAN }, key('space')).pauses, { ...HUMAN, 'example': { human: {} } });   // the project's own beside all's
  assert.deepEqual(handleKey({ ...state, pauses: AI }, bang).pauses, combined(AI, { all: { human: {} } }));
  assert.deepEqual(handleKey({ ...state, pauses: combined(HUMAN, AI) }, bang).pauses, AI);
  for (const screen of ['s', 'S', 'b', 'B', 'c', 'a', 'A']) assert.ok(handleKey({ ...state, screen }, key('space')).pauses['example']?.human, screen);
  for (const screen of ['s', 'S', 'b', 'B', 'c', 'a', 'A']) assert.ok(handleKey({ ...state, screen }, bang).pauses.all?.human, screen);
  for (const screen of 'frmupo') assert.deepEqual([handleKey({ ...state, screen }, key('space')).pauses, handleKey({ ...state, screen }, bang).pauses], [{}, {}], screen);
});

test('the banner shows only the pauses that hold the selected project, saying whose agents they hold', () => {
  const own = { 'example': { human: { since: '2026-10-01T16:00:00Z' } } };
  const out = lines({ ...state, pauses: own });
  centered(out[6], 'PAUSED BY HUMAN — control is asking Example\'s agents to commit and stop');
  centered(out[7], 'press space to release Example — ! to pause every project');
  assert.match(lines({ ...state, pauses: { assassin: { human: {} } } })[0], /RUNNING/);           // another project's pause holds nothing here
  const all = lines({ ...state, pauses: HUMAN });
  centered(all[7], 'press space to pause Example too — ! to release every project');
});

test('the banner offers space only where it works, and keeps its height', () => {
  for (const pauses of [{}, HUMAN, AI]) {
    const at = screen => lines({ ...state, pauses, screen });
    for (const screen of ['s', 'b', 'c', 'a']) assert.ok(at(screen).some(l => l.includes('press space')), screen);
    for (const screen of 'frmu') assert.ok(!at(screen).some(l => l.includes('press space')), screen);
    const menuOrBox = l => l.includes('┌') || (l.includes('Example') && !l.includes('press space'));   // the banner's hint names the project too
    assert.equal(at('u').findIndex(menuOrBox), at('s').findIndex(menuOrBox));
  }
  centered(lines({ ...state, screen: 'f' })[0], 'RUNNING  agents are working');
});

test('the menu bar lists every project with the first selected', () => {
  const menu = render(state, screen)[2];
  assert.match(menu, /\x1b\[7m Example \x1b\[0m/);
  assert.match(strip(menu), /Example\s+Software Assassin/);
});

test('under each project in the menu, a robot and the count of its assignments', () => {
  const out = lines(state);
  const names = out[2], counts = out[3];
  assert.match(counts, /🤖x3 +🤖x0 *$/);                                 // all three fixture assignments name example
  const middle = (line, text) => visible(line.slice(0, line.indexOf(text))) + visible(text) / 2;
  assert.equal(Math.floor(middle(names, 'Example')), Math.floor(middle(counts, '🤖x3')));
  assert.equal(Math.floor(middle(names, 'Software Assassin')), Math.floor(middle(counts, '🤖x0')));
});

test('left and right move between projects, stopping at the ends', () => {
  const right = handleKey(state, key('right'));
  assert.equal(right.project, 1);
  assert.match(render(right, screen)[2], /\x1b\[7m Software Assassin \x1b\[0m/);
  assert.equal(handleKey(right, key('right')).project, 1);
  assert.equal(handleKey(right, key('left')).project, 0);
  assert.equal(handleKey(state, key('left')).project, 0);
});

test('the selected project\'s sprint shows in block letters, beside it a box of its day, the time and how to change the day, each centered', () => {
  const hint = 'press the left and right arrows to change the day';
  const width = hint.length + 2;
  const mid = text => {
    const left = Math.floor((width - text.length) / 2);
    return `│${' '.repeat(left)}${text}${' '.repeat(width - text.length - left)}│`;
  };
  const gap = ' '.repeat(12);
  assert.deepEqual(lines(state, { ...screen, columns: 140 }).slice(5, 11), [   // 120 columns clip the name; 140 fit no tiles
    `█████ █████ █████ █████ █   █ █████     █   █████${gap}┌${'─'.repeat(width)}┐`,
    `█     █   █ █   █   █   ██  █   █      ██   █   █${gap}${mid('day 14 of 14')}     Example`,
    `█████ █████ █████   █   █ █ █   █       █   █   █${gap}${mid('sprint ends today')}`,
    `    █ █     █  █    █   █  ██   █       █   █   █${gap}${mid('Thu Oct 1 @ 4:04 PM UTC')}`,
    `█████ █     █   █ █████ █   █   █      ███  █████${gap}${mid(hint)}`,
    `${' '.repeat(49)}${gap}└${'─'.repeat(width)}┘`,
  ]);
});

test('at the far right of the sprint header, boxed metrics with their labels beneath: operator needed tickets, delivered tickets and points', () => {
  const steps = [{ id: 'build', name: 'Build', sequence: 5 }, { id: 'done', name: 'Done', sequence: 10 }];
  const ticket = (key, points, ...statuses) => ({ key, title: 'T', points, variations: statuses.map((status, i) => ({ name: 'ABC'[i], 'harness-status': hs(status) })) });
  const work = { ...sprint, features: [ticket('A-1', 3, 'done'), ticket('A-2', undefined, 'done'), ticket('A-3', 5, 'build', 'done')], bugs: [ticket('A-4', 8, 'build')], spikes: [] };
  // An agent on A-4, so no warning takes the tiles' room (ASS-59).
  const s = initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'e', sprint: work }], workflows: [{ name: 'e', steps }], assignments: [assignment('Daredevil', 'A-4', null, 'p')] });
  const out = lines(s, { ...wide, columns: 216 });
  const tiles = [
    '┌─────────────────────────┐    ┌───────────────────┐    ┌──────────────────┐',
    '│            0            │    │         3         │    │        8         │',
    '└─────────────────────────┘    └───────────────────┘    └──────────────────┘',
    '  Operator Needed Tickets        Delivered Tickets        Delivered Points  ',
  ];
  assert.deepEqual(out.slice(6, 10).map(l => l.slice(-tiles[0].length)), tiles);
  assert.ok(out.slice(6, 10).every(l => l.length === 216));          // flush with the right edge
  assert.ok(!out[5].includes('Delivered') && !out[10].includes('Delivered'));
  // Short of room, tiles drop from the right; with none, all go.
  assert.ok(!out.some(l => l.includes('Gated Tickets')));            // no Gated Tickets tile (ASS-171)
  const narrower = lines(s, { ...wide, columns: 160 });
  assert.ok(narrower[9].endsWith('  Operator Needed Tickets  '));
  assert.ok(!narrower.some(l => l.includes('Delivered')));
  assert.ok(!lines(s).some(l => l.includes('Operator Needed')));      // no room at 120 columns
});

test('Operator Needed Tickets counts each ticket waiting on the operator once — blocked, at a gate, at a human step, or with an open question — on blue once there are any (ASS-171, ASS-242); never a backlog ticket, even in refinement waiting on them (ASS-254)', () => {
  const steps = [
    { id: 'stuck', name: 'Stuck', sequence: 0, area: 'quarantine', 'is-blocked-state': true },
    { id: 'review', name: 'Review', sequence: 3, action: { type: 'human' } },
    { id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } },
    { id: 'done', name: 'Done', sequence: 10 },
  ];
  const refinement = { name: 'r', steps: [{ id: 'groom', name: 'Groom', sequence: 1, action: { type: 'prompt' } }, { id: 'awaiting-answers', name: 'Awaiting Answers', sequence: 2, action: { type: 'human' } }] };
  const at = (state, extra = {}) => ({ 'harness-status': hs(state), ...extra });
  const gated = at('build', { 'gate-when-leaving-state': ['e/build'], 'state-changes': [{ 'to-state': 'build', 'work-is-done': true }] });
  const ticket = (key, variations, extra = {}) => ({ key, title: 'T', variations: variations.map((v, i) => ({ name: 'ABC'[i], ...v })), ...extra });
  const refining = (key, state, extra = {}) => ({ key, title: 'T', variations: [{ name: 'A', 'harness-status': { state, 'state-engine': 'r' } }], ...extra });
  const count = (features, { backlog = [], questions = [] } = {}) => {
    const project = { id: 'p', name: 'P', stateEngine: 'e', sprint: { ...sprint, features, bugs: [], spikes: [] }, backlog, questions };
    const out = render(initialState({ projects: [project], workflows: [{ name: 'e', steps }, refinement], assignments: [assignment('Daredevil', 'A-0', null, 'p')] }), { ...wide, columns: 200 });
    return { out, n: Number(strip(out[7]).match(/│ +(\d+) +│/)[1]) };
  };
  // The blue ● the sprint screen shows before a ticket's title (ASS-242): the
  // count's own test, so each row carrying one is a ticket the tile counts.
  const dots = (out, key) => out.filter(l => blueDot(l, key)).length;
  const rowsOf = (out, key) => out.filter(l => strip(l).includes(`${key}`)).length;
  const busy = ticket('A-0', [at('build')]);                                        // worked, so no warning takes the tiles' room (ASS-59)
  assert.equal(count([busy]).n, 0);
  assert.equal(dots(count([busy]).out, 'A-0'), 0);
  const one = (features, key, extra) => {
    const { out, n } = count(features, extra);
    assert.equal(n, 1, key);
    assert.equal(dots(out, `${key}: T`), 1, key);                                   // one blue ● before its title
    assert.equal(dots(out, 'A-0: T'), 0);
  };
  one([busy, ticket('A-1', [at('stuck')])], 'A-1');                                  // blocked for human
  one([busy, ticket('A-2', [gated])], 'A-2');                                        // held at a gate
  one([busy, ticket('A-3', [at('review')])], 'A-3');                                 // at a human step
  one([busy, ticket('A-4', [at('build')])], 'A-4', { questions: [{ 'asked-on-ticket': 'a-4', status: 'Asked' }] });   // an open question
  assert.equal(count([busy, ticket('A-4', [at('build')])], { questions: [{ 'asked-on-ticket': 'A-4', status: 'Answered' }] }).n, 0);
  assert.equal(dots(count([busy, ticket('A-4', [at('build')])], { questions: [{ 'asked-on-ticket': 'A-4', status: 'Answered' }] }).out, 'A-4'), 0);
  assert.equal(count([busy], { backlog: [refining('A-5', 'awaiting-answers'), refining('A-6', 'groom')] }).n, 0);   // backlog Awaiting Answers: not the sprint's (ASS-254)
  // Several kinds, on several variations, count the ticket once.
  const several = count([busy, ticket('A-7', [at('stuck'), gated, at('review')])], { questions: [{ 'asked-on-ticket': 'A-7', status: 'Asked' }] });
  assert.equal(several.n, 1);
  for (const row of several.out.filter(l => strip(l).includes('A-7.'))) assert.equal(row.split('⦿').length - 1, 1);   // one ⦿ per row, whatever its kinds
  assert.equal(dots(several.out, 'A-7.'), rowsOf(several.out, 'A-7.'));
  // Paused or worked by hand, it waits on no one.
  assert.equal(count([busy, ticket('A-8', [at('review', { 'is-paused': true })]), ticket('A-9', [at('stuck')], { 'is-paused': true }),
    ticket('A-10', [at('review')], { 'worked-manually': { by: 'Alice', since: '2026-10-01T00:00:00Z' } })],
  { questions: [{ 'asked-on-ticket': 'A-10', status: 'Asked' }], backlog: [refining('A-11', 'awaiting-answers', { 'is-paused': true })] }).n, 0);
  const held = count([busy, ticket('A-8', [at('review', { 'is-paused': true })]), ticket('A-9', [at('stuck')], { 'is-paused': true }),
    ticket('A-10', [at('review')], { 'worked-manually': { by: 'Alice', since: '2026-10-01T00:00:00Z' } })], { questions: [{ 'asked-on-ticket': 'A-10', status: 'Asked' }] }).out;
  assert.equal(held.filter(l => /A-(8|9|10):/.test(strip(l))).length, 3);
  assert.ok(!held.some(l => /[●⦿]/.test(l) && /A-(8|9|10):/.test(strip(l))));       // paused or by hand: no mark
  const { out } = count([busy, ticket('A-1', [at('stuck')]), ticket('A-3', [at('review'), at('review')])]);
  assert.match(strip(out[7]), /│            2            │/);
  assert.ok(out[7].includes('\x1b[44;97m            2            \x1b[0m'));   // on blue (ASS-242)
  assert.ok(!count([busy]).out[7].includes('\x1b[44'));
  for (const raw of [out, several.out, count([busy, ticket('A-2', [gated])]).out]) {
    assert.ok(!raw.some(l => /🔴|🔵/.test(l)));                                     // no emoji circle
    assert.ok(!raw.some(l => /\x1b\[31mA-\d/.test(l)));                              // no red row
  }
});

test('Operator Needed Tickets never counts, nor marks with a blue ●, a complete ticket — a variation at an is-done step or a ticket-system status of Done — whatever it waits on; an open ticket still counts (ASS-247)', () => {
  const steps = [
    { id: 'stuck', name: 'Stuck', sequence: 0, area: 'quarantine', 'is-blocked-state': true },
    { id: 'review', name: 'Review', sequence: 3, action: { type: 'human' } },
    { id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } },
    { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'human' } },
  ];
  const refinement = { name: 'r', steps: [{ id: 'groom', name: 'Groom', sequence: 1, action: { type: 'prompt' } }, { id: 'ready', name: 'Ready', sequence: 2, 'is-done': true, action: { type: 'human' } }] };
  const at = (state, extra = {}) => ({ 'harness-status': hs(state), ...extra });
  const gated = at('build', { 'gate-when-leaving-state': ['e/build'], 'state-changes': [{ 'to-state': 'build', 'work-is-done': true }] });
  const ticket = (key, variations, extra = {}) => ({ key, title: 'T', variations: variations.map((v, i) => ({ name: 'ABC'[i], ...v })), ...extra });
  const busy = ticket('A-0', [at('build')]);                                        // worked, so no warning takes the tiles' room (ASS-59)
  const asked = key => ({ 'asked-on-ticket': key.toLowerCase(), status: 'Asked' });
  const DONE = { 'ticket-system-status': 'Done' };
  // The tile's count, and the tickets wearing a blue ● on the sprint and backlog screens.
  const shown = (features, { backlog = [], questions = [] } = {}) => {
    const project = { id: 'p', name: 'P', stateEngine: 'e', sprint: { ...sprint, features, bugs: [], spikes: [] }, backlog, questions };
    const s = initialState({ projects: [project], workflows: [{ name: 'e', steps }, refinement], assignments: [assignment('Daredevil', 'A-0', null, 'p')] });
    const out = render(s, { ...wide, columns: 200 });
    const marked = [...out, ...render(handleKey(s, key('b')), wide)].filter(l => /\x1b\[34m[●⦿]/.test(l)).map(l => strip(l).match(/[●⦿][ ⚉]*(A-\d+)/u)?.[1]).filter(Boolean);   // not the key under the grid (ASS-259)
    return { n: Number(strip(out[7]).match(/│ +(\d+) +│/)[1]), marked: [...new Set(marked)].sort() };
  };
  const none = (label, features, extra) => assert.deepEqual(shown([busy, ...features], extra), { n: 0, marked: [] }, label);
  none('at Done with an open question', [ticket('A-1', [at('done')])], { questions: [asked('A-1')] });
  none('Done in the ticket system with an open question', [ticket('A-2', [at('build')], DONE)], { questions: [asked('A-2')] });
  none('a gate on a complete ticket', [ticket('A-3', [gated], DONE)]);
  none('a human step on a complete ticket', [ticket('A-4', [at('review')], DONE)]);
  none('a human step beside the variation that shipped', [ticket('A-5', [at('done'), at('review')])]);
  none('blocked on a complete ticket', [ticket('A-6', [at('stuck')], DONE)]);
  none('a backlog ticket at a terminal step', [], { backlog: [ticket('A-7', [{ 'harness-status': { state: 'ready', 'state-engine': 'r' } }])], questions: [asked('A-7')] });
  none('a backlog ticket Done in the ticket system', [], { backlog: [ticket('A-8', [{ 'harness-status': { state: 'groom', 'state-engine': 'r' } }], DONE)], questions: [asked('A-8')] });
  // An open ticket's open question still marks it, and counts it once if it is the sprint's — a backlog one never counts (ASS-254).
  assert.deepEqual(shown([busy, ticket('A-9', [at('build')]), ticket('A-1', [at('done')])], { questions: [asked('A-9'), asked('A-1')] }), { n: 1, marked: ['A-9'] });
  assert.deepEqual(shown([busy], { backlog: [ticket('A-10', [{ 'harness-status': { state: 'groom', 'state-engine': 'r' } }])], questions: [asked('A-10')] }), { n: 0, marked: ['A-10'] });
});

test('day x of y counts from the sprint start', () => {
  const out = lines(state, { ...screen, columns: 140, now: new Date('2026-09-18T09:30:00Z') });
  assert.match(out[6], / day 1 of 14 +│     Example$/);
  assert.match(out[7], / sprint ends in 13 days +│$/);
  assert.match(out[8], / Fri Sep 18 @ 9:30 AM UTC +│$/);
});

// A project with end-of-day snapshots: two in the sprint, one from an earlier sprint.
const snapshot = status => ({ ...sprint, features: [{ key: 'ABC-1', title: 'New Feature', priority: 2, ...single({ 'harness-status': hs(status) }) }], bugs: [], spikes: [] });
const withDays = {
  ...projects[0],
  repositories: [{ url: 'https://gitlab.com/group/backend', status: 'Active', 'work-space': {}, 'dev-container': {} }],
  days: { '2026-09-29': snapshot('backlog'), '2026-09-30': snapshot('code-review'), '2026-09-10': snapshot('backlog') },
};
const dayState = initialState({ projects: [withDays, projects[1]], workflows: [engine], assignments });
const press = (s, ...names) => names.reduce((s, name) => handleKey(s, key(name), wide), s);
// z, as node:readline gives it: the agents grid zooms a tile on the key's sequence,
// so a bare press(s, 'z') would not zoom. Enter on an agent tile types into it (ASS-189),
// so every zoom below is this key.
const zKey = key('z', { sequence: 'z' });
// The draft of the agent whose log is open: one per agent name from ASS-189, shared
// with that agent's tile input.
const openDraft = s => s.agentDraft[s.agent?.name] ?? '';
// A ticket screen on one of its tabs (ASS-184).
const onTab = (s, tab) => ({ ...s, ticketTab: tab });
const TAB_IDS = ['actions', 'details', 'history', 'questions', 'chat'];
const statusOf = (s, ticket) => lines(s, wide).find(l => l.includes(ticket))?.match(/ (Backlog|Code Review) /)?.[1];

test('the project menu has focus at first; tab moves it to the day, the ticket grid, then back', () => {
  assert.equal(dayState.focus, 'menu');
  assert.deepEqual(['tab', 'tab', 'tab', 'tab'].map((_, i) => press(dayState, ...Array(i + 1).fill('tab')).focus), ['day', 'tickets', 'menu', 'day']);
  assert.deepEqual([1, 2, 3].map(n => press({ ...dayState, screen: 'r' }, ...Array(n).fill('tab')).focus), ['day', 'repos', 'menu']);   // the repository grid on its own screen
  assert.deepEqual([1, 2, 3].map(n => press({ ...dayState, screen: 'p' }, ...Array(n).fill('tab')).focus), ['day', 'menu', 'day']);   // no grids on other screens
});

test('the focused component shows its selection in reverse video; an unfocused menu underlines its project', () => {
  const raw = s => render(s, wide);
  assert.ok(raw(dayState).some(l => l.includes('\x1b[7m Example ')));
  const onDay = press(dayState, 'tab');
  assert.ok(raw(onDay).some(l => l.includes('\x1b[4m Example ')));
  assert.ok(raw(onDay).some(l => /\x1b\[7mday 14 of 14\x1b\[0m +│/.test(l)));
  assert.ok(!raw(dayState).some(l => l.includes('\x1b[7mday')));
  assert.ok(raw(press(onDay, 'tab')).some(l => l.startsWith('│\x1b[7m') && l.includes('ABC-1:')));
  assert.ok(!raw(onDay).some(l => l.startsWith('│\x1b[7m')));
});

test('left and right move only the focused component: projects on the menu, days on the day', () => {
  assert.equal(press(dayState, 'right').project, 1);
  const onDay = press(dayState, 'tab');
  assert.deepEqual([press(onDay, 'left').project, press(onDay, 'left').day], [0, '2026-09-30']);
  const onGrid = press(onDay, 'tab');
  assert.deepEqual([press(onGrid, 'left').project, press(onGrid, 'left').day], [0, null]);
});

test('the day steps back through the sprint\'s snapshots and forward again to the current day', () => {
  const onDay = press(dayState, 'tab');
  assert.equal(onDay.day, null);
  assert.equal(statusOf(onDay, 'ABC-1:'), 'Code Review');                         // current: sprint.json
  const back1 = press(onDay, 'left'), back2 = press(onDay, 'left', 'left');
  assert.deepEqual([back1.day, back2.day, press(back2, 'left').day], ['2026-09-30', '2026-09-29', '2026-09-29']);   // never into another sprint
  assert.equal(statusOf(back2, 'ABC-1:'), 'Backlog');
  assert.deepEqual([press(back2, 'right').day, press(back2, 'right', 'right').day, press(back2, 'right', 'right', 'right').day], ['2026-09-30', null, null]);
});

test('a past day shows its own day, time left and end-of-day time — the end of that UTC day (ASS-294; this computer\'s, ASS-216 AC6)', () => {
  const out = lines(press(dayState, 'tab', 'left', 'left'), wide);
  const at = text => out.find(l => l.includes(text));
  assert.ok(at('day 12 of 14'));
  assert.ok(at('sprint ends in 2 days'));
  assert.ok(at('Tue Sep 29 @ 11:59 PM UTC'));   // 23:59 UTC that day, whatever this computer's zone
});

// ASS-187: on S and B, a one-line header — project, sprint, day x of y, time
// left and a red chip per non-running state — beside the menu and tiles; no
// banner, health-check lines, SPRINT letters or platform boxes.
const FLOWS = ['S', 'B'];
const at160 = { ...screen, columns: 160, rows: 45 };
const INFO = /(Example — sprint|Software Assassin — no active sprint)/;
const chip = title => `\x1b[41;97m ${title} \x1b[0m`;
// The info line, raw, and its index.
const infoOf = (s, size = at160) => {
  const out = render(s, size);
  const i = out.findIndex(l => INFO.test(strip(l)));
  return { out, i, raw: out[i] ?? '', text: strip(out[i] ?? '') };
};
const held = (s, h = { since: '2026-10-01T16:00:00Z', expected: 'work@example.com', actual: 'me@example.com', 'config-dir': null }) =>
  ({ ...s, projects: [{ ...s.projects[0], accountHold: h }, ...s.projects.slice(1)] });
const healingFix = { 'ABC-1200': { since: '2026-10-01T16:00:00Z', summary: 'The dev container is broken', ticket: 'ABC-1200', 'ticket-url': null, project: 'example', paused: [] } };

test('S and B: the header has one info line — project, sprint, day x of y, time left (ASS-187)', () => {
  for (const flow of FLOWS) {
    const out = strip(headerLines({ ...state, screen: flow }, 160, at160.now).join('\n')).split('\n');
    assert.equal(out.filter(l => l.includes('Example — sprint 10 — day 14 of 14 — sprint ends today')).length, 1, flow);
    assert.equal(out.filter(l => /day \d+ of \d+/.test(l)).length, 1, flow);
  }
});

test('S and B: no banner, SPRINT letters, health-check lines or platform boxes (ASS-187)', () => {
  const team = [
    { ...assignment('Doctor-Strange', null), 'health-check': true, 'ai-status-update-short': 'All systems nominal' },
    assignment('Daredevil', 'ABC-1'),
  ];
  const letters = blockText('SPRINT');
  for (const flow of FLOWS) {
    for (const s of [{ ...state, screen: flow }, initialState({ projects, workflows: [engine], assignments: team, screen: flow })]) {
      const out = lines({ ...s, screen: flow }, at160);
      assert.ok(!out.some(l => l.includes('RUNNING') || l.includes('press space')), flow);
      assert.ok(!out.some(l => letters.some(row => l.includes(row.trimEnd()))), flow);
      assert.ok(!out.some(l => l.includes('Doctor-Strange')), flow);
      assert.deepEqual(platform({ ...s, screen: flow }, 160, at160.now), [], flow);
      assert.ok(!out.some(l => /^\s*(control|models)( 🤖)?\s*$/.test(l) || /│ (control|models) /.test(l)), flow);
    }
  }
});

test('S and B: the project menu and all three metric tiles stay, at 160 and 200 columns (ASS-187)', () => {
  for (const flow of FLOWS) {
    for (const size of [at160, wide]) {
      const out = lines({ ...state, screen: flow }, size);
      assert.ok(out.some(l => /Example\s+Software Assassin/.test(l)), `${flow} ${size.columns}`);
      for (const label of ['Operator Needed Tickets', 'Delivered Tickets', 'Delivered Points']) assert.ok(out.some(l => l.includes(label)), `${flow} ${size.columns} ${label}`);
    }
  }
});

test('S and B: the info line sits beside the tiles\' value row (ASS-187)', () => {
  for (const flow of FLOWS) {
    const { out, i, text } = infoOf({ ...state, screen: flow });
    const plain = out.map(strip);
    assert.ok(i > 0, flow);
    assert.match(text, /Example — sprint 10.*│ +\d+ +│/, flow);
    assert.ok(plain[i - 1].includes('┌'), flow);
    assert.ok(plain[i + 1].includes('└'), flow);
    assert.ok(plain[i + 2].includes('Delivered Points'), flow);
  }
});

test('S and B: each non-running state alone is its own red chip on the info line (ASS-187)', () => {
  for (const flow of FLOWS) {
    const s = { ...state, screen: flow };
    for (const [held_, title] of [[limited(s), 'RATE LIMITED'], [held(s), 'SIGN IN'], [{ ...s, pauses: AI }, 'PAUSED BY AI'],
      [{ ...s, selfHealing: healingFix }, 'SELF HEALING'], [{ ...s, pauses: HUMAN }, 'PAUSED BY HUMAN']]) {
      assert.ok(infoOf(held_).raw.includes(chip(title)), `${flow} ${title}`);
    }
    assert.ok(!infoOf({ ...s, selfHealing: healingFix, pauses: AI }).raw.includes(chip('PAUSED BY AI')), flow);   // self healing replaces it
    assert.ok(infoOf({ ...s, selfHealing: healingFix, pauses: AI }).raw.includes(chip('SELF HEALING')), flow);
  }
});

test('S and B: several states show side by side, strongest first, one space apart (ASS-187)', () => {
  for (const flow of FLOWS) {
    const { raw } = infoOf(held(limited({ ...state, screen: flow, pauses: combined(HUMAN, AI) })), wide);
    assert.ok(raw.includes(['RATE LIMITED', 'SIGN IN', 'PAUSED BY AI', 'PAUSED BY HUMAN'].map(chip).join(' ')), flow);
  }
});

test('S and B: running shows no chip (ASS-187)', () => {
  for (const flow of FLOWS) {
    const { i, raw } = infoOf({ ...state, screen: flow });
    assert.ok(i >= 0, flow);
    assert.ok(!raw.includes('41;97m '), flow);
  }
});

test('S and B: no detail lines — no why, ETA, limit window, reset or space hint (ASS-187)', () => {
  for (const flow of FLOWS) {
    const out = lines(limited({ ...state, screen: flow, pauses: combined(HUMAN, AI) }), at160);
    for (const text of ['Rotating the GitLab token', 'ETA:', 'Why:', 'Limit:', 'Resets:', 'press space', 'control is asking', 'control sends']) {
      assert.ok(!out.some(l => l.includes(text)), `${flow} ${text}`);
    }
  }
});

test('S and B: only the state chips — no gcloud, glab, background-off or No work in progress warnings (ASS-187)', () => {
  const warned = { ...state, projects: [{ ...projects[0], gcloudReauthentication: true, glabReauthentication: true, backgroundWorkOff: true }, ...projects.slice(1)] };
  for (const flow of FLOWS) {
    for (const s of [warned, assigned([assignment('Punisher', 'Other')])]) {
      const out = lines({ ...s, screen: flow }, wide);
      for (const text of ['gcloud', 'glab', 'Background work off', 'No work in progress']) assert.ok(!out.some(l => l.includes(text)), `${flow} ${text}`);
    }
  }
});

test('heldTitles: the held states strongest first, SELF HEALING in place of PAUSED BY AI (ASS-187)', () => {
  assert.equal(typeof frame.heldTitles, 'function');
  assert.deepEqual(frame.heldTitles({ human: 1, ai: 1 }, false, 1, 1), ['RATE LIMITED', 'SIGN IN', 'PAUSED BY AI', 'PAUSED BY HUMAN']);
  assert.deepEqual(frame.heldTitles({ human: 1, ai: 1 }, true, 1, 1), ['RATE LIMITED', 'SIGN IN', 'SELF HEALING', 'PAUSED BY HUMAN']);
  assert.deepEqual(frame.heldTitles({ human: null, ai: null }, false, null, null), []);
});

test('S and B: the diagram gains the freed lines (ASS-187)', () => {
  const size = h => headerLines(h, 160, at160.now).length + platform(h, 160, at160.now).length;
  for (const [flow, module] of [['S', sprintFlow], ['B', backlogFlow]]) {
    const s = { ...state, screen: flow, flowchartView: 'tickets' };
    assert.ok(size(s) <= size({ ...state, screen: 's' }) - 10, `${flow}: ${size(s)}`);
    const view = module.view(s, at160);
    const top = view.findIndex(l => strip(l).startsWith('┌'));
    assert.ok(view.length - top >= 25, `${flow}: box ${view.length - top}`);
    const out = render(s, at160);
    assert.equal(out.length, 45, flow);
    for (const line of out.map(strip)) assert.ok(line.length <= 160, line);
  }
});

test('S and B: narrow and menu-hidden edges (ASS-187)', () => {
  for (const flow of FLOWS) {
    for (const line of lines(limited({ ...state, screen: flow, pauses: HUMAN }), { ...at160, columns: 60 })) assert.ok(line.length <= 60, line);
    const hidden = lines({ ...state, screen: flow, menuHidden: true }, at160);
    assert.ok(!hidden.some(l => l.includes('Software Assassin')), flow);
    assert.ok(hidden.some(l => l.includes('Example — sprint 10 — day 14 of 14')), flow);
  }
});

test('S and B: the day field takes focus in reverse video (ASS-187)', () => {
  for (const flow of FLOWS) {
    assert.ok(infoOf({ ...state, screen: flow, focus: 'day' }).raw.includes('\x1b[7mday 14 of 14\x1b[0m'), flow);
    assert.ok(!infoOf({ ...state, screen: flow, focus: 'menu' }).raw.includes('\x1b[7mday'), flow);
    assert.equal(press({ ...dayState, screen: flow }, 'tab').focus, 'day', flow);
  }
});

test('S and B: left and right change the day on show, and the info line follows (ASS-187)', () => {
  for (const flow of FLOWS) {
    const onDay = { ...dayState, screen: flow, focus: 'day' };
    const back = press(onDay, 'left');
    assert.equal(back.day, '2026-09-30', flow);
    assert.match(infoOf(back).text, /Example — sprint 10 — day 13 of 14 — sprint ends in 1 day/, flow);
    const again = press(back, 'right');
    assert.equal(again.day, null, flow);
    assert.match(infoOf(again).text, /Example — sprint 10 — day 14 of 14 — sprint ends today/, flow);
    assert.equal(press(onDay, 'right').day, null, flow);                                       // already on the current day
    assert.equal(press(onDay, 'left', 'left', 'left').day, '2026-09-29', flow);                // never before the first snapshot
  }
});

test('S and B with no active sprint: "<project> — no active sprint", plus any chips (ASS-187)', () => {
  const limitedOther = s => ({ ...s, projects: [s.projects[0], { ...s.projects[1], rateLimit: LIMIT }] });
  for (const flow of FLOWS) {
    const s = { ...state, screen: flow, project: 1 };
    const { text, raw } = infoOf(s);
    assert.ok(text.startsWith('Software Assassin — no active sprint'), `${flow}: ${text}`);
    assert.ok(!raw.includes('41;97m '), flow);
    const out = lines(s, at160);
    assert.ok(!out.some(l => l.includes('sprint 10') || /day \d+ of/.test(l)), flow);
    assert.ok(out.some(l => /Example\s+Software Assassin/.test(l)), flow);
    assert.ok(out.some(l => l.includes('Delivered Points')), flow);
    assert.ok(infoOf({ ...s, pauses: HUMAN }).raw.includes(chip('PAUSED BY HUMAN')), flow);
    assert.ok(infoOf(limitedOther({ ...s, pauses: HUMAN })).raw.includes(`${chip('RATE LIMITED')} ${chip('PAUSED BY HUMAN')}`), flow);
    const focused = infoOf({ ...s, focus: 'day' });
    assert.ok(focused.i >= 0, flow);
    assert.ok(!focused.raw.includes('\x1b[7m'), flow);
  }
});

test('every other screen keeps the banner, the SPRINT letters and the platform boxes (ASS-187)', () => {
  const letters = blockText('SPRINT 10')[0].trimEnd();
  for (const other of 'sbcfmruaxh') {
    const s = { ...state, screen: other };
    const out = strip(headerLines(s, 160, at160.now).join('\n'));
    assert.ok(out.includes('RUNNING'), other);
    assert.ok(out.includes(letters), other);
    assert.ok(out.includes('day 14 of 14'), other);
    assert.ok(platform(s, 160, at160.now).length > 0, other);
    assert.deepEqual(platform(s, 160, at160.now), platform({ ...state, screen: 's' }, 160, at160.now), other);
  }
  assert.ok(lines(assigned([assignment('Punisher', 'Other')]), wide).some(l => l.includes('No work in progress')));
  assert.ok(lines(limited(state), at160).some(l => l.includes('Resets:')));
});

test('the dashboard has no repository grid; a past day hides its agents and robots', () => {
  const current = lines(dayState, wide), past = press(dayState, 'tab', 'left');
  assert.ok(!current.some(l => /Repository/.test(l)));
  assert.ok(current.some(l => l.includes('🤖 Daredevil')));
  const out = lines(past, wide);
  assert.ok(!out.some(l => /Repository/.test(l)));
  assert.ok(!out.some(l => /🤖 \w/.test(l)));
  assert.ok(!out.some(l => l.startsWith('└🤖')));
  assert.equal(press(past, 'tab', 'tab').focus, 'menu');
});

test('under the dashboard\'s progress bar, each state\'s name where its shade begins', () => {
  const out = lines(state, wide);
  const bottom = out.findIndex(l => l.startsWith('└') && out[out.indexOf(l) - 1].startsWith('│█'));
  assert.match(out[bottom + 1], /^ (Code Review|Backlog)\b/);
  assert.ok(['Code Review', 'Backlog'].every(name => out[bottom + 1].includes(name)));
});

test('under the progress bar, a computer per variation at a script step, after the run\'s robots; none held at a gate, paused or worked by hand, or on a past day (ASS-237)', () => {
  const steps = [
    { id: 'plan', name: 'Plan', sequence: 1, action: { type: 'prompt' } },
    { id: 'lint', name: 'Lint', sequence: 2, action: { type: 'script' } },
    { id: 'done', name: 'Done', sequence: 3 },
  ];
  const at = (key, state, extra = {}, ticket = {}) => ({ key, title: 'T', priority: 1, ...ticket, ...single({ 'harness-status': { state, 'state-engine': 'e' }, ...extra }) });
  const held = { 'gate-when-leaving-state': ['e/lint'], 'state-changes': [{ 'to-state': 'lint', 'work-is-done': true, 'pending-move': { from: 'lint', to: 'done', reason: 'exit' } }] };
  const features = [
    at('S-1', 'plan'), at('S-2', 'lint'), at('S-3', 'lint'), at('S-4', 'lint', { 'is-paused': true }), at('S-5', 'lint', held),
    at('S-6', 'lint', {}, { 'worked-manually': { by: 'Alice', since: '2026-10-01T00:00:00Z' } }), at('S-7', 'lint', {}, { 'is-paused': true }),
  ];
  const project = { id: 'p', name: 'P', stateEngine: 'e', sprint: { ...sprint, features, bugs: [], spikes: [] } };
  const s = initialState({ projects: [project], workflows: [{ name: 'e', steps }], assignments: [assignment('Daredevil', 'S-1', null, 'p'), assignment('Elektra', 'S-2', null, 'p')] });
  const bottom = st => { const out = lines(st, wide); return out.find((l, i) => l.startsWith('└') && out[i - 1]?.startsWith('│')); };
  // Plan, a prompt step: its robot alone. Lint, a script step: S-2's robot, then S-2's and S-3's computers.
  assert.match(bottom(s), /^└🤖─+🤖💻💻─+┘$/);
  // A past day, the same tickets: nothing is running, so no robots and no computers.
  assert.match(bottom({ ...s, day: '2026-09-30', projects: [{ ...project, days: { '2026-09-30': project.sprint } }] }), /^└─+┘$/);
});

test('on a past day the ticket table takes all the space under the progress bar', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ key: `ABC-${100 + i}`, title: 'T', priority: i }));
  const project = { ...withDays, days: { '2026-09-30': { ...sprint, features: many, bugs: [], spikes: [] } } };
  const out = lines(press(initialState({ projects: [project], workflows: [engine] }), 'tab', 'left'), wide);
  const top = out.findIndex(l => /│ Priority │/.test(l)) - 1, bottom = out.findIndex((l, i) => i > top && l.startsWith('└'));
  assert.ok(out.some(l => l.includes('ABC-100')));
  assert.ok(keyUnder(out, bottom) > 0);                                // the key under it (ASS-259)
  assert.match(out[bottom + 1 + keyUnder(out, bottom)], /^ +┌/);      // then the platform boxes (the models box is always there)
});

test('shift-tab moves the focus back the other way', () => {
  const back = (s, n) => Array.from({ length: n }).reduce(st => handleKey(st, key('tab', { shift: true }), wide), s);
  assert.deepEqual([1, 2, 3, 4].map(n => back(dayState, n).focus), ['tickets', 'day', 'menu', 'tickets']);
});

test('r opens the repos screen with the repository grid focused; it shows the repositories as they are now, whatever the day', () => {
  const opened = handleKey(dayState, key('r'));
  assert.deepEqual([opened.screen, opened.focus], ['r', 'repos']);
  assert.ok(render(opened, wide).some(l => l.startsWith('│\x1b[7m') && l.includes('backend')));
  assert.ok(lines(press(dayState, 'tab', 'left', 'r'), wide).some(l => /^│ backend /.test(l)));
  assert.equal(handleKey({ ...opened, focus: 'repos' }, key('s')).focus, 'menu');   // the dashboard has no repository grid to keep it
});

test('a shows the agents: a table headed Agent, Working Location, Model, Account, Assignment, State, Time, Status, Health and Agents, saying so when none are running', () => {
  const out = lines(handleKey({ ...initialState({ projects, workflows: [engine] }), agentsTable: true }, key('a')), wide);
  const head = out.findIndex(l => /^│ +Agent +│/.test(l));
  assert.match(out[head], /^│ +Agent +│ Working Location │ Model │ Account │ Assignment │ State │ Time │ Status │ Last Activity │ Health │ Agents │$/);
  assert.equal(out[head].length, wide.columns);
  assert.match(out[head + 2], /^│ no dev agents running +│$/);
  assert.ok(out[head + 3].startsWith('└'));
});

test('the agents table has a row per assignment in the selected project, as they are now whatever the day: name, model, state, time since it started, assignment, status and its ai-feedback-short as Health; the Claude account\'s email, — without one', () => {
  const team = [
    { ...assignment('Daredevil', 'ABC-1', 'A'), model: 'opus-5', account: { email: 'me@example.com', org: 'Org', subscription: 'max' }, 'start-time': '2026-10-01T13:43:00Z', status: 'Running', state: 'generate-solution', 'working-in-dev-container': true, 'ai-feedback-short': 'On track', 'ai-feedback-long': 'The long story' },
    { ...assignment('Superman', null), repo: 'backend', model: 'sonnet-5', 'start-time': '2026-09-29T15:00:00Z', status: 'Paused' },
    { ...assignment('Flash', 'X-1', null, 'assassin'), model: 'opus-5', 'start-time': '2026-10-01T16:00:00Z', status: 'Running' },
  ];
  const st = { ...initialState({ projects: [withDays, projects[1]], workflows: [engine], assignments: team }), agentsTable: true };   // the old table, behind t (ASS-188)
  for (const s of [{ ...st, screen: 'a' }, press({ ...st, screen: 'a' }, 'tab', 'left')]) {   // the current day, then a past one
    const out = lines(s, wide);
    assert.match(out.find(l => l.includes('Daredevil')), /^│ Daredevil +Dev Container +opus-5 +me@example\.com +ABC-1\.A +generate-solution +2h 21m +Running +— +On track +— +│$/);
    assert.match(out.find(l => l.includes('Superman')), /^│ Superman +Local PC +sonnet-5 +— +repo: backend +— +2d 1h +Paused +— +— +— +│$/);
    assert.ok(!out.some(l => l.includes('The long story')));
    assert.ok(!out.some(l => l.includes('Flash')));
  }
});

test('Last Activity is when the agent\'s session log was last written, to the second, and how long ago', () => {
  const team = [assignment('Daredevil', 'ABC-1'), assignment('Spock', 'ABC-1')];
  const st = { ...initialState({ projects, workflows: [engine], assignments: team }), screen: 'a', agentsTable: true, sessionWritten: { Daredevil: Date.parse('2026-10-01T05:59:07Z') } };
  const out = lines(st, wide);
  assert.match(out.find(l => l.startsWith('│ Daredevil ')), / ABC-1 .* 2026-10-01 05:59:07 UTC \(10h 4m ago\) +— +— +│$/);
  assert.match(out.find(l => l.startsWith('│ Spock ')), / — +— +— +│$/);                     // no log
});

test('Assignment is the ticket (linked to it when it is in the sprint), else the MR, else Agent and the agent checked on, else repo: and the repository (linked to its url in project.json), else the local environment name, and control when control is true', () => {
  const team = [
    assignment('Daredevil', 'ABC-1', 'A'),
    assignment('Punisher', 'ABC-99'),
    { ...assignment('Swamp-Thing', null), agent: 'Daredevil' },
    { ...assignment('Superman', null), repo: 'backend' },
    { ...assignment('Wonder-Woman', null), repo: 'gone' },
    { ...assignment('Captain-Planet', null), 'local-environment': 'dev-container' },
    { ...assignment('Hulk', null), 'merge-request': '2386', 'merge-request-url': 'http://mr/2386' },
    { ...assignment('Banner', null), 'merge-request': '17' },
    { ...assignment('Watchman', null), control: true },
    { ...assignment('Vision', null), 'transient-state-engine': 'ead46679-0000-4000-8000-000000000001', 'state-engine': 'self-healing', state: 'analyze' },
    { ...assignment('Falcon', null), 'transient-state-engine': 'ead46679-0000-4000-8000-000000000002', 'state-engine': 'example-development/check-health-steps', state: 'check-health' },
    assignment('Idle', null),
  ];
  const withRepos = [{ ...projects[0], repositories: [{ url: 'https://gitlab.com/group/backend', status: 'Active' }] }, ...projects.slice(1)];
  const st = { ...initialState({ projects: withRepos, workflows: [engine], assignments: team }), screen: 'a', agentsTable: true };
  const out = lines(st, { ...wide, rows: 80 });                                   // tall enough for every row of the team
  const at = name => out.find(l => l.startsWith(`│ ${name} `));
  assert.match(at('Daredevil'), / ABC-1\.A {2,}/);
  assert.match(at('Punisher'), / ABC-99 {2,}/);
  assert.match(at('Swamp-Thing'), / Agent Daredevil {2,}/);
  assert.match(at('Superman'), / repo: backend {2,}/);
  assert.match(at('Hulk'), / MR !2386 {2,}/);
  assert.match(at('Banner'), / MR !17 {2,}/);
  assert.match(at('Watchman'), / control {2,}/);
  assert.match(at('Vision'), / run: self-healing {2,}/);                        // a trigger's run, on no ticket: named by its engine
  assert.match(at('Falcon'), / run: check-health-steps {2,}/);                  // a *-steps list, by the list
  assert.match(at('Idle'), /^│ Idle +Local PC( +—){9} +│$/);
  const raw = render(st, { ...wide, rows: 80 });
  assert.ok(raw.some(l => l.includes('\x1b]8;;http://t/ABC-1\x1b\\ABC-1.A\x1b]8;;\x1b\\')));
  assert.ok(!raw.some(l => l.includes('\x1b]8;;') && l.includes('ABC-99')));    // not in the sprint: no link
  assert.ok(raw.some(l => l.includes('\x1b]8;;http://mr/2386\x1b\\MR !2386\x1b]8;;\x1b\\')));
  assert.ok(!raw.some(l => l.includes('\x1b]8;;') && l.includes('MR !17')));   // no merge-request-url: no link
  assert.ok(raw.some(l => l.includes('\x1b]8;;https://gitlab.com/group/backend\x1b\\repo: backend\x1b]8;;\x1b\\')));
  assert.match(at('Wonder-Woman'), / repo: gone {2,}/);
  assert.match(at('Captain-Planet'), / Captain-Planet +Local PC +— +— +dev-container {2,}/);
  assert.ok(!raw.some(l => l.includes('\x1b]8;;') && l.includes('repo: gone')));   // not in project.json: no link
});

test('Working Location is Dev Container when working-in-dev-container is true, else Local PC', () => {
  const team = [true, false, undefined, 'yes'].map((inside, i) => ({ ...assignment(`Agent-${i}`, null), 'working-in-dev-container': inside }));
  const out = lines({ ...initialState({ projects, workflows: [engine], assignments: team }), screen: 'a', agentsTable: true }, wide);
  assert.deepEqual([0, 1, 2, 3].map(i => out.find(l => l.startsWith(`│ Agent-${i} `)).match(/Dev Container|Local PC/)[0]),
    ['Dev Container', 'Local PC', 'Local PC', 'Local PC']);
});

test('an agent\'s Agents cell lists the agents in the project assigned to check on it, one per line', () => {
  const checking = (name, agent, project = 'example') => ({ ...assignment(name, null, null, project), agent });
  const team = [
    assignment('Daredevil', 'ABC-1', 'A'),
    checking('Swamp-Thing', 'Daredevil'),
    checking('Constantine', 'Daredevil'),
    checking('Zatanna', 'Daredevil', 'assassin'),
  ];
  const out = lines({ ...initialState({ projects, workflows: [engine], assignments: team }), screen: 'a', agentsTable: true }, wide);
  const row = out.findIndex(l => /^│ Daredevil /.test(l));
  assert.match(out[row], / 🤖 Swamp-Thing +│$/);
  assert.match(out[row + 1], / 🤖 Constantine +│$/);
  assert.match(out.find(l => /^│ Swamp-Thing /.test(l)), / — +│$/);                 // nobody checks on the checker
  assert.ok(!out.some(l => l.includes('Zatanna')));
});

test('a focuses the agents table: ↑/↓ select an agent, shown in reverse video', () => {
  const team = ['Daredevil', 'Spock', 'Kaylee-Frye'].map(name => assignment(name, 'ABC-1'));
  const opened = handleKey({ ...initialState({ projects, workflows: [engine], assignments: team }), agentsTable: true }, key('a'));
  assert.equal(opened.focus, 'agents');
  const selected = s => render(s, wide).find(l => l.startsWith('│\x1b[7m'))?.match(/Daredevil|Spock|Kaylee-Frye/)[0];
  assert.equal(selected(opened), 'Daredevil');
  assert.equal(selected(press(opened, 'down')), 'Spock');
  assert.equal(selected(press(opened, 'down', 'down', 'down', 'up')), 'Spock');
  assert.equal(handleKey({ ...opened, focus: 'agents' }, key('s')).focus, 'menu');   // the dashboard has no agents table to keep it
});

test('enter opens the selected agent\'s session log in a box that follows its end; ↑/↓ scroll it, esc returns to the agents table as it was', () => {
  const team = [
    { ...assignment('Daredevil', 'ABC-1'), 'start-time': '2026-10-01T13:43:00Z' },
    { ...assignment('Spock', 'ABC-1'), 'start-time': '2026-10-01T13:44:00Z' },
  ];
  const onTable = press(handleKey({ ...initialState({ projects, workflows: [engine], assignments: team }), agentsTable: true }, key('a')), 'down');
  const opened = press(onTable, 'return');
  assert.deepEqual(opened.agent, { name: 'Spock', start: '2026-10-01T13:44:00Z' });
  const log = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const reading = { ...opened, agentLog: log };
  const shown = s => lines(s, wide).filter(l => /^│ line \d+ +[│█]$/.test(l)).map(l => Number(l.match(/line (\d+)/)[1]));
  assert.equal(shown(reading).at(-1), 99);                              // its end, newest last
  assert.ok(lines(reading, wide).some(l => l.endsWith('█')));          // with a scrollbar
  assert.equal(shown({ ...reading, agentLog: [...log, 'line 100'] }).at(-1), 100);   // still following as it grows
  const back = press(reading, 'up', 'up');
  assert.equal(shown(back).at(-1), 97);
  assert.equal(shown({ ...back, agentLog: [...log, 'line 100'] }).at(-1), 97);       // scrolled back, it stays put
  assert.equal(shown(press(back, 'down', 'down', 'down')).at(-1), 99);
  const returned = press(back, 'escape');
  assert.equal(returned.agent, null);
  assert.equal(returned.agentSelected, 1);
  assert.equal(returned.focus, 'agents');
  assert.ok(lines(returned, wide).some(l => /^│ +Agent +│/.test(l)));
});

test('on an agent\'s session log, typing writes a prompt under the box and enter asks for it to be sent through the agent-cli; esc clears it, then returns', () => {
  const team = [{ ...assignment('Daredevil', 'ABC-1'), 'start-time': '2026-10-01T13:43:00Z' }];
  const reading = { ...handleKey(handleKey(initialState({ projects, workflows: [engine], assignments: team }), key('a')), zKey, wide), agentLog: ['line 0'] };
  assert.ok(lines(reading, wide).some(l => l.startsWith('type a prompt, enter sends it   ←/→ move the cursor   ↑/↓ scroll   tab shows events   esc returns to the agents')));
  const typed = typing(reading, 'Run it again');
  assert.ok(!typed.pauses.human);                               // space is text here, not pause
  assert.ok(lines(typed, wide).some(l => /^> Run it again█$/.test(l)));
  assert.equal(openDraft(handleKey(typed, key('backspace'), wide)), 'Run it agai');
  const sent = handleKey(typed, key('return'), wide);
  assert.deepEqual(sent.agentPrompt, ['agent-interaction:resume-thread', 'Daredevil', 'Run it again']);
  assert.equal(openDraft(sent), '');
  assert.equal(handleKey(typing(reading, '  '), key('return'), wide).agentPrompt, null);   // nothing to send
  assert.ok(lines({ ...sent, agentPrompt: null, agentMessage: 'Daredevil is not running (process 1)' }, wide).some(l => l === 'Daredevil is not running (process 1)'));
  const cleared = handleKey(typed, key('escape'), wide);
  assert.deepEqual([openDraft(cleared), cleared.agent?.name], ['', 'Daredevil']);
  assert.equal(handleKey(cleared, key('escape'), wide).agent, null);
});

test('an agent\'s session log hides its JSON event lines; tab shows them, and tab again hides them', () => {
  const team = [{ ...assignment('Daredevil', 'ABC-1'), 'start-time': '2026-10-01T13:43:00Z' }];
  const log = ['said one', '{"type":"system","subtype":"thinking_tokens"}', '▶ Bash {"command":"ls"}', '  {"type":"not an event, indented output"}', '{"type":"tool_progress"}', 'said two'];
  const reading = { ...handleKey(handleKey(initialState({ projects, workflows: [engine], assignments: team }), key('a')), zKey, wide), agentLog: log };
  const shown = s => lines(s, wide).filter(l => /^│ /.test(l)).map(l => l.slice(2).replace(/ +[│█]$/, '')).filter(Boolean);
  assert.deepEqual(shown(reading), ['said one', '▶ Bash {"command":"ls"}', '  {"type":"not an event, indented output"}', 'said two']);
  const showing = handleKey(reading, key('tab'), wide);
  assert.deepEqual(shown(showing), log);
  assert.equal(openDraft(showing), '');                          // tab is not text
  assert.ok(lines(showing, wide).some(l => l.includes('tab hides events')));
  assert.deepEqual(shown(handleKey(showing, key('tab'), wide)), shown(reading));
});

// Session logs holding tool results, as session.js writes them (ASS-40's fold): '◀ ' then its output's
// lines each under a 2-space indent. The fold draws one line per result, so these feed the chat screen,
// the agents screen and the ticket chat alike — all three read the same lines from the same arrays.
const folding = ['> run the tests', '▶ Bash {"command":"npm test"}', '◀ pass 7', '  fail 0', '  done', '■ turn ended (success) after 1.0s, $0.01 so far'];
const oneLineResult = ['◀ pass 7', '■ turn ended (success) after 1.0s, $0.01 so far'];
const noResult = ['> hi', 'Hello!', '(thinking) hm'];
const errorResult = ['◀ error: no such file', '  at open()', '  giving up'];
const blankResult = ['◀ ', '  ', '  real output', '  more'];
const emptyResult = ['◀ '];
// A result followed in turn by every kind of line that opens the next event, and a plain assistant line.
const afterResult = ['◀ pass 7', '  fail 0', '▶ Bash {"command":"ls"}', '■ turn ended (success) after 1.0s, $0.01 so far', '(thinking) x', '> hi', 'said two'];
const twoResults = ['◀ a', '  b', '◀ c', '  d', '  e'];
const resultAtEnd = ['said one', '◀ pass 7', '  fail 0'];
const eventInResult = ['◀ pass 7', '{"type":"tool_progress"}', '  fail 0'];        // a JSON event line, filtered before the fold
const indentedInResult = ['◀ pass 7', '  {"type":"not an event, indented output"}', '  fail 0'];   // output that looks like one
const manyResults = Array.from({ length: 40 }, (_, i) => [`◀ result ${i}`, '  more', '  and more']).flat();
const longResult = [`◀ ${'x'.repeat(300)}`, '  fail 0'];

// The lines a log box draws, its border and padding off; and an agent's session log open on the agents screen.
const logLines = (s, size = wide) => lines(s, size).filter(l => /^│ /.test(l)).map(l => l.slice(2).replace(/ +[│█]$/, '')).filter(Boolean);
const agentReading = log => ({ ...handleKey(handleKey(initialState({ projects, workflows: [engine], assignments: [{ ...assignment('Daredevil', 'ABC-1'), 'start-time': '2026-10-01T13:43:00Z' }] }), key('a')), zKey, wide), agentLog: log });
// `folding` drawn folded: its result one line, everything else as it was.
const folded = ['> run the tests', '▶ Bash {"command":"npm test"}', '◀ pass 7 … (3 lines)', '■ turn ended (success) after 1.0s, $0.01 so far'];

test('tab on an agent\'s session log shows the full output with the JSON event lines, and tab again folds it', () => {
  const log = [...folding, '{"type":"tool_progress"}'];
  const reading = agentReading(log);
  assert.deepEqual(logLines(reading), folded);
  const showing = handleKey(reading, key('tab'), wide);
  assert.deepEqual(logLines(showing), log);                                   // the whole output, the event lines with it
  assert.ok(lines(showing, wide).some(l => l.includes('tab hides events')));
  assert.deepEqual(logLines(handleKey(showing, key('tab'), wide)), folded);
});

test('a folded error result keeps its error: prefix', () => {
  assert.deepEqual(logLines(agentReading(errorResult)), ['◀ error: no such file … (3 lines)']);
});

test('a result whose first lines are blank is summarised by its first non-blank line', () => {
  assert.deepEqual(logLines(agentReading(blankResult)), ['◀ real output … (4 lines)']);   // the count is the whole block, blanks in it
});

test('an empty result is drawn as it is', () => {
  const out = lines(agentReading(emptyResult), wide);
  assert.ok(out.some(l => /^│ ◀ +│$/.test(l)), out.join('\n'));
  assert.ok(!out.some(l => l.includes('…')));
});

test('the fold stops at the next event line', () => {
  assert.deepEqual(logLines(agentReading(afterResult)),
    ['◀ pass 7 … (2 lines)', '▶ Bash {"command":"ls"}', '■ turn ended (success) after 1.0s, $0.01 so far', '(thinking) x', '> hi', 'said two']);
});

test('two results in a row each fold', () => {
  assert.deepEqual(logLines(agentReading(twoResults)), ['◀ a … (2 lines)', '◀ c … (3 lines)']);
});

test('a result at the end of the log folds', () => {
  assert.deepEqual(logLines(agentReading(resultAtEnd)), ['said one', '◀ pass 7 … (2 lines)']);
});

test('a JSON event line between a result and its continuation does not break the fold', () => {
  const reading = agentReading(eventInResult);
  assert.deepEqual(logLines(reading), ['◀ pass 7 … (2 lines)']);              // the event line is out before the fold, so it is not counted
  assert.deepEqual(logLines(handleKey(reading, key('tab'), wide)), eventInResult);
});

test('an indented JSON line inside a result\'s output is part of the fold', () => {
  assert.deepEqual(logLines(agentReading(indentedInResult)), ['◀ pass 7 … (3 lines)']);
});

test('a folded log scrolls and follows its end on the folded lines', () => {
  const reading = agentReading(manyResults);
  const shown = s => logLines(s).map(l => l.match(/^◀ result (\d+) … \(3 lines\)$/)?.[1] ?? l);
  assert.equal(shown(reading).at(-1), '39');                                  // opens on the last fold
  assert.equal(shown(press(reading, 'up')).at(-1), '38');                     // back exactly one folded line
  assert.equal(press(reading, ...Array(100).fill('up')).agentLogScroll, 0);   // no further than the first
  assert.equal(press(reading, 'up', 'down').agentLogScroll, null);            // at the end again: following
  assert.equal(shown({ ...reading, agentLog: [...manyResults, '◀ result 40', '  more', '  and more'] }).at(-1), '40');
});

test('a folded line wider than the box wraps onto the next rows under the ◀ lead-in (ASS-63)', () => {
  const rows = lines(agentReading(longResult), screen).filter(l => l.includes('xxx') || l.includes('(2 lines)'));
  assert.equal(rows.length, 3);                                               // 300 x's and the count over a 116-column text width
  assert.ok(rows.every(r => r.length === screen.columns && !r.endsWith('… │')), rows.join('\n'));
  assert.ok(rows.slice(1).every(r => r.startsWith('│   ')));                 // hung under '◀ '
});

// A reply paragraph far wider than any of the boxes: logged as one line, read in full on screen (ASS-63).
const reply = `Here is what I found: ${Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')} — the end.`;
const shownText = rows => rows.map(r => r.trim()).join(' ');

test('the chat screen wraps a reply line wider than its box onto as many rows as it needs, no ellipsis; lines that fit look as they did (ASS-63)', () => {
  const rows = logLines(chatReading(['> hi', reply, '', 'short']));
  assert.equal(rows[0], '> hi');
  assert.equal(shownText(rows.slice(1, -1)), reply);
  assert.ok(rows.length > 3 && !rows.some(r => r.includes('…')), rows.join('\n'));
  assert.equal(rows.at(-1), 'short');
});

test('the agents screen\'s session log wraps the same way, through the same box (ASS-63)', () => {
  assert.deepEqual(logLines(agentReading(['> hi', reply, 'short'])), logLines(chatReading(['> hi', reply, 'short'])));
});

test('↑/↓ on a wrapping log scroll by row, no further than the last; following the end shows the last rows (ASS-63)', () => {
  const reading = agentReading([...Array.from({ length: 50 }, (_, i) => `line ${i}`), reply]);
  assert.ok(logLines(reading).at(-1).endsWith('— the end.'));                  // the reply's last row at the bottom
  const up = press(reading, 'up');
  assert.ok(!logLines(up).at(-1).endsWith('— the end.'));                      // one row back: the reply's last row is gone…
  assert.ok(logLines(up).at(-1).includes('word'));                             // …its row before it now at the bottom
  assert.equal(press(up, 'down').agentLogScroll, null);                        // back at the last row: following again
});
test('an agent\'s session log shows when it was last written, to the second, and how long ago', () => {
  const opened = handleKey(handleKey(initialState({ projects, workflows: [engine], assignments: [{ ...assignment('Daredevil', 'ABC-1'), 'start-time': '2026-10-01T13:43:00Z' }] }), key('a')), zKey, wide);
  const reading = { ...opened, agentLog: ['line 0'], sessionWritten: { Daredevil: Date.parse('2026-10-01T15:51:07Z') } };
  assert.ok(lines(reading, wide).includes('log last written 2026-10-01 15:51:07 UTC (12m ago)'));   // the screen's now is 16:04:00; whole minutes, as elsewhere
  assert.ok(!lines({ ...reading, agentLog: null, sessionWritten: {} }, wide).some(l => l.startsWith('log last written')));
});

test('an agent without a session log says so', () => {
  const opened = handleKey(handleKey(initialState({ projects, workflows: [engine], assignments: [assignment('Daredevil', 'ABC-1')] }), key('a')), zKey, wide);
  assert.ok(lines(opened, wide).some(l => /^│ no session log for Daredevil +│$/.test(l)));
});

// The live sprint's merge requests of interest: one on a sprint ticket, one on a ticket outside it, one on none.
const mr = (iid, ticket, fields = {}) => ({ iid, title: `MR ${iid}`, author: `author-${iid}`, url: `http://mr/${iid}`, ticket, 'review-status': 'Started', agent: `Agent-${iid}`, pipeline: 'success', ...fields });
const reviewing = {
  ...withDays,
  sprint: { ...sprint, 'last-merge-request-scan': '2026-10-01T15:03:00Z', 'merge-requests-of-interest': [
    mr(2386, 'ABC-1', { 'review-status': 'Feedback Provided' }),
    mr(2392, 'EX-9', { 'review-status': 'Approved', agent: 'Agent-2386' }),
    mr(2396, null, { 'review-status': 'Not Started', pipeline: undefined }),
  ] },
};

// Agents on the merge requests, by assignments.json's merge-request, as text or a number; one elsewhere.
const onMr = (name, mergeRequest, project = 'example') => ({ ...assignment(name, null, null, project), 'merge-request': mergeRequest });
const mrTeam = [onMr('Slowbro', '2386'), onMr('Psyduck', 2386), onMr('Kirishima', '2392'), onMr('Corphish', '2392', 'assassin')];

test('m shows the live sprint\'s merge requests of interest, whatever the day: Ticket, MR, Author, Review Status, Build and Agent, under when they were last scanned', () => {
  const st = initialState({ projects: [reviewing], workflows: [engine], assignments: mrTeam });
  for (const s of [handleKey(st, key('m')), press({ ...st, screen: 'm' }, 'tab', 'left')]) {   // the current day, then a past one
    const out = lines(s, wide);
    assert.ok(out.some(l => l.trim() === 'last scanned Thu Oct 1 @ 3:03 PM UTC'));
    const head = out.findIndex(l => /^│ +Ticket +│/.test(l));
    assert.match(out[head], /^│ +Ticket +│ +MR +│ +Author +│ +Review Status +│ +Build +│ +Agent +│$/);
    assert.equal(out[head].length, wide.columns);
    const row = out.findIndex(l => l.includes('!2386'));
    assert.match(out[row], /^│ ABC-1 +!2386 +author-2386 +Feedback Provided +success +🤖 Slowbro +│$/);
    assert.match(out[row + 1], /^│ +🤖 Psyduck +│$/);
    assert.match(out.find(l => l.includes('!2392')), /^│ EX-9 +!2392 +author-2392 +Approved +success +🤖 Kirishima +│$/);
    assert.match(out.find(l => l.includes('!2396')), /^│ — +!2396 +author-2396 +Not Started +— +— +│$/);
    assert.ok(!out.some(l => /Agent-\d|Corphish/.test(l)));                // not the merge request's own agent, nor another project's
  }
});

test('on the merge requests screen, a sprint ticket and every MR link to their urls; a ticket outside the sprint is plain', () => {
  const raw = render({ ...initialState({ projects: [reviewing], workflows: [engine] }), screen: 'm' }, wide);
  assert.ok(raw.some(l => l.includes('\x1b]8;;http://t/ABC-1\x1b\\ABC-1\x1b]8;;\x1b\\')));
  for (const iid of [2386, 2392, 2396]) assert.ok(raw.some(l => l.includes(`\x1b]8;;http://mr/${iid}\x1b\\!${iid}\x1b]8;;\x1b\\`)), iid);
  assert.ok(!raw.some(l => l.includes('\x1b]8;;') && l.includes('EX-9\x1b]8')));
});

test('without merge requests of interest the screen says so, and that they have not been scanned', () => {
  const out = lines({ ...initialState({ projects, workflows: [engine] }), screen: 'm' }, wide);
  assert.ok(out.some(l => l.trim() === 'not scanned yet'));
  assert.ok(out.some(l => /^│ No merge requests of interest +│$/.test(l)));
});

test('the menu offers m for merge requests after the sub-flows, counting the selected project\'s agents assigned to a merge request', () => {
  const after = s => menuOf(s).slice(5, 8);
  assert.deepEqual(after(initialState({ projects: [reviewing, projects[1]], workflows: [engine], assignments: mrTeam })), ['f sub-flows 🤖x0', 'm merge requests 🤖x3', 'r repos 🤖x0']);
  assert.deepEqual(after(state), ['f sub-flows 🤖x0', 'm merge requests 🤖x0', 'r repos 🤖x0']);
});

test('changing project goes back to the current day', () => {
  const past = press(dayState, 'tab', 'left');
  assert.equal(press({ ...past, focus: 'menu' }, 'right').day, null);
});

test('up and down move the selected repository when the repository grid has focus, scrolling to keep it in view', () => {
  const repositories = Array.from({ length: 30 }, (_, i) => ({ url: `https://gitlab.com/group/repo-${i}`, status: 'Active', 'work-space': {}, 'dev-container': {} }));
  const s = { ...initialState({ projects: [{ ...projects[0], repositories }], workflows: [engine] }), screen: 'r', focus: 'repos' };
  const shown = st => render(st, wide).filter(l => /repo-\d+/.test(l));
  const highlighted = st => shown(st).filter(l => l.includes('\x1b[7m')).map(l => strip(l).match(/repo-\d+/)[0]);
  assert.deepEqual(highlighted(s), ['repo-0']);
  const end = press(s, ...Array(40).fill('down'));
  assert.equal(end.repoSelected, 29);
  assert.deepEqual(highlighted(end), ['repo-29']);
  assert.ok(end.repoScroll > 0);
  assert.equal(press(end, 'up').repoSelected, 28);
  assert.equal(press({ ...s, screen: 's', focus: 'tickets' }, 'down').repoSelected, 0);
  assert.deepEqual(highlighted({ ...end, focus: 'menu' }), []);
});

test('a project without an active sprint says so', () => {
  assert.equal(lines(handleKey(state, key('right')))[5], 'No active sprint     Software Assassin');
});

test('agents on backlog refinement — on a backlog ticket, no run (ASS-144) — are counted beside b, not beside d or f', () => {
  const refiner = { ...assignment('Ripley', 'ABC-50', 'A'), 'state-engine': 'example-backlog-refinement', state: 'groom' };
  const backlog = [{ key: 'ABC-50', variations: [{ name: 'A', 'harness-status': { state: 'groom', 'state-engine': 'example-backlog-refinement' } }] }];
  const s = initialState({ projects: [{ ...projects[0], backlog }, projects[1]], workflows: [engine], assignments: [...assignments, refiner] });
  const menu = menuOf(s);
  assert.ok(menu.includes('b backlog 🤖x1'));
  assert.ok(menu.includes('s sprint 🤖x3'));                                              // the three on tickets, not the refiner
  assert.ok(menu.includes('f sub-flows 🤖x0'));
});

// The / key, as node:readline gives it: no name, only its sequence.
const slash = { sequence: '/' };

// The ? key, as node:readline gives it, and the ? menu (ASS-183) open over a
// screen: the dialog's entry rows — the rows that differ from the screen without
// it, each cut to where they differ, its border and padding dropped — spaces collapsed.
const questionMark = { sequence: '?' };
const menuOf = (s, size = wide) => {
  const shut = lines(s, size), open = lines(handleKey(s, questionMark, size), size);
  const cut = (l, under) => {
    let i = 0, j = 0;
    while (l[i] === under[i]) i++;
    while (j < l.length - i && l.at(-1 - j) === under.at(-1 - j)) j++;
    return l.slice(i, l.length - j);
  };
  return open.map((l, i) => (l === shut[i] ? null : cut(l, shut[i]).trim().replace(/^[┌│└] *| *[┐│┘]$/g, '').replace(/ +/g, ' ')))
    .filter(row => row && !/^[┌└─┐┘]*$/.test(row));
};

test('ASS-183: the bottom line reads press ? for menu', () => {
  centered(lines(state).at(-1), 'press ? for menu');
  centered(lines({ ...state, screen: 'r' }).at(-1), 'press ? for menu');
  centered(lines(menuOpened(state)).at(-1), 'press ? for menu');   // the dialog open too
});
const menuOpened = s => handleKey(s, questionMark, wide);

test('ASS-183: ? opens the menu: one entry per line — key, label, agent count — without "the"', () => {
  assert.equal(menuOpened(state).menuOpen, true);
  const menu = menuOf(state);
  assert.deepEqual(menu, [
    's sprint 🤖x3', 'S sprint flow', 'b backlog 🤖x0', 'B backlog flow', 'c control', 'f sub-flows 🤖x0', 'm merge requests 🤖x0',
    'r repos 🤖x0', 'u updates', 'a agents 🤖x0', 'x chat', 'h memory',
    'A agents for all projects',   // its own group (ASS-188, ASS-246)
    'space pause Example', '! pause every project', '/ hide project menu', 'Q quit',
    '⦿ needs you — counted on Operator Needed if a sprint ticket (backlog: ●)', '⦿ going on with an assumption — not counted (backlog: ●)',   // what the marks mean, a blank line apart (ASS-248)
    '⦿ a requirements change waits to be accepted or rejected', '⚉ an agent is working on it', '✦ feature ✘ bug ⌕ spike ☛ worked by hand ↯ fast-tracked',   // the sprint row's glyphs (ASS-259)
  ]);
  assert.ok(menu.every(entry => !/\bthe\b/.test(entry)));
});

test('ASS-183: the dialog is bordered and centered over the screen, which shows around it', () => {
  const shut = lines(state, wide), open = lines(menuOpened(state), wide);
  const rows = open.flatMap((l, i) => (l === shut[i] ? [] : [i]));
  const top = open[rows[0]], at = top.search(/┌─+┐/), width = top.match(/┌─+┐/)[0].length;   // here over the progress bar's top
  assert.match(open[rows.at(-1)].slice(at, at + width), /^└─+┘$/);
  assert.ok(Math.abs(at - (wide.columns - width - at)) <= 1);                                    // centered across
  assert.ok(Math.abs(rows[0] - (wide.rows - 1 - rows.at(-1))) <= 1);                             // and down
  const middle = rows[Math.floor(rows.length / 2)];                                             // a row the screen itself writes on: the dialog's top is over a blank one (ASS-188)
  assert.equal(open[middle].slice(0, at), shut[middle].slice(0, at));                           // the screen at its left
  assert.ok(shut[middle].slice(0, at).trim());
  assert.ok(open.every(l => visible(l) <= wide.columns));
});

test('ASS-183: ? opens the menu on every screen, the ticket screen too', () => {
  for (const s of 'sSbBcfmruaxh') assert.ok(menuOf({ ...state, screen: s }).includes('h memory'), s);
  assert.ok(menuOf(onTab(press(onGrid, 'return'), 'details')).includes('Q quit'));   // not on its Chat tab, where ? is text (ASS-184)
});

test('ASS-183: where space and ! pause, the menu lists them and says which each does: the selected project, or every project', () => {
  assert.ok(menuOf({ ...state, pauses: { 'example': { human: {} }, ...HUMAN } }).join('|').includes('space release Example|! release every project'));
  assert.ok(!menuOf({ ...state, screen: 'r' }).some(e => e.startsWith('space') || e.startsWith('!')));   // the repositories screen does not pause
  assert.ok(menuOf(handleKey(state, slash)).includes('/ show project menu'));
});

test('ASS-183: ?, esc or a menu key closes the menu, the screen redrawn as it was; any other key leaves it open', () => {
  const open = menuOpened(state);
  for (const k of [questionMark, key('escape')]) {
    const closed = handleKey(open, k, wide);
    assert.equal(closed.menuOpen, false);
    assert.deepEqual(render(closed, wide), render(state, wide));
  }
  assert.equal(handleKey(open, key('s', { sequence: 's' }), wide).menuOpen, false);
  assert.equal(handleKey(open, key('z', { sequence: 'z' }), wide), open);
  assert.equal(handleKey(open, key('down'), wide), open);
});

test('ASS-183: a menu key also does its action', () => {
  const open = menuOpened(state);
  assert.deepEqual([handleKey(open, key('b', { sequence: 'b' }), wide).screen, handleKey(open, key('b', { sequence: 'b' }), wide).menuOpen], ['b', false]);
  assert.equal(handleKey(open, key('b', { shift: true, sequence: 'B' }), wide).screen, 'B');
  assert.ok(handleKey(open, key('space', { sequence: ' ' }), wide).pauses['example'].human);
  assert.ok(handleKey(open, { sequence: '!' }, wide).pauses.all.human);
  assert.ok(handleKey(open, slash, wide).menuHidden);
  assert.ok(handleKey(open, key('q', { shift: true, sequence: 'Q' }), wide).quitting);
  assert.equal(handleKey(open, key('c', { ctrl: true }), wide).quit, true);                  // ctrl-c quits at once, as ever
});

test('ASS-183: ? is text while typing', () => {
  const team = [{ ...assignment('Daredevil', 'ABC-1'), 'start-time': '2026-10-01T13:43:00Z' }];
  const reading = handleKey(handleKey(initialState({ projects, workflows: [engine], assignments: team }), key('a')), zKey, wide);
  const typed = handleKey(reading, questionMark, wide);
  assert.equal(openDraft(typed), '?');
  assert.ok(!typed.menuOpen);
});

test('/ hides the project menu, and again shows it', () => {
  const hidden = handleKey(state, slash);
  const out = lines(hidden);
  assert.ok(!out.some(l => l.includes('Software Assassin')));
  assert.equal(out.findIndex(l => l.includes('day 14 of 14')), lines(state).findIndex(l => l.includes('day 14 of 14')) - 3);   // the menu's two lines and its blank are gone
  assert.deepEqual(lines(handleKey(hidden, slash)), lines(state));
});

test('a dashboard started with the menu hidden has the day focused', () => {
  const started = initialState({ projects, workflows: [engine], assignments, menuHidden: true });
  assert.equal(started.focus, 'day');
  assert.ok(!lines(started).some(l => l.includes('Example') && !l.includes('press space')));   // no menu (the banner's hint names it)
  assert.equal(handleKey(started, slash).focus, 'day');               // shown, the focus stays on the day
});

test('while the menu is hidden it cannot be focused: tab skips it, and it gives its focus to the day', () => {
  const hidden = handleKey(state, slash);                            // the menu had focus
  assert.equal(hidden.focus, 'day');
  assert.deepEqual([1, 2, 3].map(n => press(hidden, ...Array(n).fill('tab')).focus), ['tickets', 'day', 'tickets']);
  assert.deepEqual([1, 2].map(n => press({ ...hidden, screen: 'c' }, ...Array(n).fill('tab')).focus), ['day', 'day']);
  assert.equal(press({ ...hidden, focus: 'tickets' }, 'c').focus, 'day');   // a screen without the focused component
  assert.equal(handleKey(hidden, key('left')).project, state.project);      // no switching project
  assert.equal(handleKey(handleKey(hidden, slash), slash).focus, 'day');    // shown again, the focus stays
});

test('/ works on the ticket screen too, but is text while typing', () => {
  assert.ok(handleKey(onTab(press(onGrid, 'return'), 'details'), slash).menuHidden);
  assert.equal(handleKey(press(onGrid, 'return'), slash).ticketChatDraft, '/');   // on its Chat tab, text (ASS-184)
  const team = [{ ...assignment('Daredevil', 'ABC-1'), 'start-time': '2026-10-01T13:43:00Z' }];
  const reading = handleKey(handleKey(initialState({ projects, workflows: [engine], assignments: team }), key('a')), zKey, wide);
  const typed = handleKey(reading, slash, wide);
  assert.equal(openDraft(typed), '/');
  assert.ok(!typed.menuHidden);
});

test('the menu counts the selected project\'s agents beside s (on tickets), r (on repositories) and a (checking on agents), not other projects\'', () => {
  const onRepo = (name, repo, project = 'example') => ({ ...assignment(name, null, null, project), repo });
  const onAgent = (name, agent, project = 'example') => ({ ...assignment(name, null, null, project), agent });
  const team = [...assignments, onRepo('Superman', 'backend'), onRepo('Batman', 'frontend'), assignment('Flash', 'X-1', null, 'assassin'), onRepo('Robin', 'qa', 'assassin'),
    onAgent('Swamp-Thing', 'Superman'), onAgent('Zatanna', 'Flash', 'assassin'), onAgent('Constantine', 'Robin', 'assassin')];
  const counts = s => menuOf(s).filter(e => /^[sra] /.test(e));
  assert.deepEqual(counts(initialState({ projects, workflows: [engine], assignments: team })), ['s sprint 🤖x3', 'r repos 🤖x2', 'a agents 🤖x1']);
  assert.deepEqual(counts(handleKey(initialState({ projects, workflows: [engine], assignments: team }), key('right'))), ['s sprint 🤖x1', 'r repos 🤖x1', 'a agents 🤖x2']);
  assert.deepEqual(counts(initialState({ projects, workflows: [engine] })), ['s sprint 🤖x0', 'r repos 🤖x0', 'a agents 🤖x0']);
});

test('screen keys switch screens; the sprint is the default', () => {
  assert.equal(state.screen, 's');
  for (const k of 'srbmcfuaxh') assert.equal(handleKey(state, key(k)).screen, k);
  assert.equal(handleKey(state, key('z')), state);
  assert.equal(handleKey(state, key('s', { ctrl: true })), state);
});

test('the dashboard opens with the progress bar, full width', () => {
  const out = lines(state);
  const top = out.findIndex(l => l.startsWith('┌'));
  assert.ok(top > 0);
  assert.equal(out[top], `┌${'─'.repeat(118)}┐`);
  assert.match(out[top + 1], /^│█{118}│$/);
  assert.ok(!lines(handleKey(state, key('f'))).some(l => l.startsWith('┌')));
});

test('above the bottom line, with a blank line between: a control box and one box per environment, each field as field: value, without control start-time or environment type', () => {
  const project = {
    name: 'P', sprint: null,
    control: { status: 'Online', 'start-time': '2026-10-01T15:51:00Z', 'process-id': 44704, model: 'opus-5' },
    environments: [
      { name: 'local-pc', type: 'local-pc', folder: '/src/example', 'active-branch': 'master' },
      { name: 'dev-container', type: 'dev-container' },
    ],
  };
  const out = lines(initialState({ projects: [project] }));
  const boxes = out.slice(-12, -2);
  assert.match(out.at(-1), /press \? for menu/);
  assert.equal(out.at(-2), '');
  assert.match(boxes[0], /^ +┌─+┐ {4}┌─+┐ {4}┌─+┐ {4}┌─+┐$/);                 // the models box last, always there
  assert.match(boxes[1], /│ control +│ {4}│ local-pc +│ {4}│ dev-container +│ {4}│ models +│$/);
  assert.match(boxes[2], /│ status: Online +│ {4}│ folder: \/src\/example +│ {4}│ +│ {4}│ session: — +│$/);
  assert.match(boxes[3], /│ process-id: 44704 +│ {4}│ active-branch: master +│ {4}│ +│ {4}│ weekly: — +│$/);
  assert.match(boxes[4], /│ model: opus-5 +│ {4}│ +│ {4}│ +│ {4}│ account: — +│$/);
  assert.match(boxes[5], /│ uptime: 13m +│ {4}│ +│ {4}│ +│ {4}│ +│$/);
  assert.match(boxes[6], /│ disk free: unknown +│ {4}│ +│ {4}│ +│ {4}│ +│$/);   // ASS-292
  assert.match(boxes[7], /│ golden image: none +│ {4}│ +│ {4}│ +│ {4}│ +│$/);
  assert.match(boxes[8], /│ hindsight: none +│ {4}│ +│ {4}│ +│ {4}│ +│$/);   // ASS-293
  assert.match(boxes[9], /^ +└─+┘ {4}└─+┘ {4}└─+┘ {4}└─+┘$/);
  assert.ok(!boxes.join().includes('start-time'));
  assert.ok(!boxes.join().includes('type'));
  assert.equal(boxes[0].length - boxes[0].trimStart().length, Math.floor((120 - boxes[0].trim().length) / 2));
});

test('after the other platform boxes, a models box: one line per model in use in this project, most agents first, with its robot count', () => {
  const project = { id: 'p', name: 'P', sprint: null, control: { status: 'Online' }, environments: [{ name: 'local-pc', type: 'local-pc' }] };
  const agent = (model, projectId = 'p') => ({ project: projectId, model, 'agent-name': 'X', 'work-item': null });
  const team = [agent('opus-4.8'), agent('opus-5'), agent('opus-5'), agent('haiku-4'), agent('opus-5', 'other')];
  const out = lines(initialState({ projects: [project], assignments: team }));
  const top = out.findLastIndex(l => /^ +┌/.test(l));
  assert.match(out[top], /┐ {4}┌─+┐$/);
  assert.match(out[top + 1], /│ control +│ {4}│ local-pc +│ {4}│ models +│$/);
  assert.match(out[top + 2], /│ opus-5 🤖x2 +│$/);
  assert.match(out[top + 3], /│ haiku-4 🤖x1 +│$/);
  assert.match(out[top + 4], /│ opus-4\.8 🤖x1 +│$/);
});

test('the models box ends with the Claude session and weekly usage, each counting down each second, and the logged-in account; without a reading, dashes', () => {
  const usage = { email: 'me@example.com', session: { percent: 7.4, 'resets-at': '2026-10-01T18:00:00Z' }, weekly: { percent: 88.6, 'resets-at': '2026-10-03T03:00:00Z' }, 'as-of': '2026-10-01T16:00:00Z' };
  const project = { id: 'p', name: 'P', sprint: null, environments: [], claudeUsage: usage };
  const agent = model => ({ project: 'p', model, 'agent-name': 'X', 'work-item': null });
  const box = (s, size) => { const out = lines(s, size); const top = out.findLastIndex(l => /^ +┌/.test(l)); return out.slice(top + 1, out.findLastIndex(l => /^ +└/.test(l))); };
  const withAgents = box(initialState({ projects: [project], assignments: [agent('opus-5')] }));
  assert.match(withAgents[0], /│ models +│$/);
  assert.match(withAgents[1], /│ opus-5 🤖x1 +│$/);
  assert.match(withAgents[2], /│ session: 7% used, resets Thu Oct 1 @ 6:00 PM UTC \(in 1h 56m\) +│$/);   // whole percent shown
  assert.match(withAgents[3], /│ weekly: 89% used, resets Sat Oct 3 @ 3:00 AM UTC \(in 1d 10h\) +│$/);
  assert.match(withAgents[4], /│ account: me@example\.com +│$/);
  const later = box(initialState({ projects: [project] }), { ...screen, now: new Date('2026-10-01T17:59:58Z') });
  assert.equal(later.length, 4);                                          // no agents: the box, just the three lines
  assert.match(later[0], /│ models +│$/);
  assert.match(later[1], /session: 7% used, resets Thu Oct 1 @ 6:00 PM UTC \(in 2s\)/);
  assert.match(box(initialState({ projects: [project] }), { ...screen, now: new Date('2026-10-01T18:00:05Z') })[1], /\(5s ago\)/);
  assert.match(box(initialState({ projects: [project] }), { ...screen, now: new Date('2026-10-03T02:59:59Z') })[2], /weekly: 89% used, .*\(in 1s\)/);
  assert.match(box(initialState({ projects: [project] }), { ...screen, now: new Date('2026-10-03T03:00:07Z') })[2], /weekly: 89% used, .*\(7s ago\)/);
  const none = box(initialState({ projects: [{ ...project, claudeUsage: null }] }));
  assert.match(none[1], /│ session: — +│$/);
  assert.match(none[2], /│ weekly: — +│$/);
  assert.match(none[3], /│ account: — +│$/);
  const emailOnly = box(initialState({ projects: [{ ...project, claudeUsage: { email: 'me@example.com', session: { percent: null, 'resets-at': null }, weekly: null, 'as-of': '2026-10-01T16:00:00Z' } }] }));
  assert.match(emailOnly[1], /│ session: — +│$/);
  assert.match(emailOnly[2], /│ weekly: — +│$/);                       // weekly null: no weekly cap (ASS-65)
  assert.match(emailOnly[3], /│ account: me@example\.com +│$/);
});

test('the models box shows this month\'s Anthropic API spend just before the account (ASS-153), the project\'s own (ASS-221): with a budget its share of it, gold from 80% and red from 100%; nothing without data or for another month', () => {
  const project = { id: 'p', name: 'P', sprint: null, environments: [], claudeUsage: null };
  const raw = (apiCost, size = screen) => { const out = render(initialState({ projects: [{ ...project, apiCost }] }), size); const top = out.findLastIndex(l => /┌/.test(l)); return out.slice(top + 1, out.findLastIndex(l => /└/.test(l))); };
  const box = (apiCost, size) => raw(apiCost, size).map(strip);
  const cost = (usd, budget = null, month = '2026-10') => ({ month, usd, 'as-of': '2026-10-01T15:00:00Z', budget });
  assert.match(box(cost(12.34))[3], /│ API \$12\.34 this month +│$/);
  assert.match(box(cost(12.34))[4], /│ account: — +│$/);                     // the account last
  assert.match(box(cost(5))[3], /│ API \$5\.00 this month +│$/);
  assert.match(box(cost(12.34, 50))[3], /│ API \$12\.34 \/ \$50 this month +│$/);
  assert.match(box(cost(12.34, 50.5))[3], /│ API \$12\.34 \/ \$50\.50 this month +│$/);
  assert.ok(!raw(cost(39.99, 50))[3].includes('\x1b['));                    // under 80%: plain
  assert.ok(raw(cost(40, 50))[3].includes('\x1b[38;2;255;215;0m'));        // 80%: gold
  assert.ok(raw(cost(50, 50))[3].includes('\x1b[31m'));                    // the budget reached: red
  assert.ok(!raw(cost(500))[3].includes('\x1b['));                         // no budget: never coloured
  assert.equal(box(null).length, 4);                                       // no data: just the usage lines
  assert.ok(!box(null).join().includes('API'));
  assert.equal(box(cost(12.34, null, '2026-09')).length, 4);               // last month's: not this month's spend
});

test('ASS-221 AC1, AC2, AC4: the models box shows each project\'s billing — an API-key login its org and its own spend, or spend unknown; a subscription login its usage, and its own spend or none', () => {
  const usage = (authMethod, org = 'Example') => ({ email: 'me@example.com', session: { percent: 100, 'resets-at': '2026-10-01T18:00:00Z' }, weekly: { percent: 100, 'resets-at': '2026-10-03T03:00:00Z' }, 'auth-method': authMethod, org, 'as-of': '2026-10-01T15:00:00Z' });
  const box = (claudeUsage, apiCost = null) => {
    const out = render(initialState({ projects: [{ id: 'p', name: 'P', sprint: null, environments: [], claudeUsage, apiCost }] }), screen).map(strip);
    return out.slice(out.findLastIndex(l => /┌/.test(l)) + 1, out.findLastIndex(l => /└/.test(l))).map(l => l.replace(/^ *│ (.*?) *│$/, '$1'));
  };
  const own = { month: '2026-10', usd: 3.92, 'as-of': '2026-10-01T15:00:00Z', budget: 50 };
  // An API-key project with its own org's spend: no subscription usage.
  assert.deepEqual(box(usage('api_key'), own), ['models', 'billing: API key (Example)', 'API $3.92 / $50 this month', 'account: me@example.com']);
  // An API-key project with no admin key, or no reading this month: unknown, never another org's number.
  assert.deepEqual(box(usage('api_key')), ['models', 'billing: API key (Example)', 'API spend: unknown for Example', 'account: me@example.com']);
  assert.deepEqual(box(usage('api_key'), { ...own, month: '2026-09' })[2], 'API spend: unknown for Example');
  // A subscription project: its usage as before, with no API line unless it has its own spend.
  const subscription = box(usage('claude.ai', 'Ada Example'));
  assert.deepEqual(subscription.map(l => l.split(':')[0]), ['models', 'session', 'weekly', 'account']);
  assert.match(subscription[2], /^weekly: 100% used/);
  assert.deepEqual(box(usage('claude.ai'), own).map(l => l.split(':')[0]), ['models', 'session', 'weekly', 'API $3.92 / $50 this month', 'account']);
  assert.deepEqual(box(null).map(l => l.split(':')[0]), ['models', 'session', 'weekly', 'account']);   // nothing read yet: as before
});

test('an environment box title carries a robot when one of this project\'s agents is assigned to its local environment', () => {
  const project = { id: 'p', name: 'P', sprint: null, environments: [{ name: 'local-pc', type: 'local-pc' }, { name: 'dev-container', type: 'dev-container' }] };
  const watcher = (env, projectId = 'p') => ({ project: projectId, model: 'm', 'agent-name': 'X', 'work-item': null, 'local-environment': env });
  const titles = team => lines(initialState({ projects: [project], assignments: team })).find(l => l.includes('│ local-pc'));
  assert.match(titles([watcher('dev-container')]), /│ local-pc +│ {4}│ dev-container 🤖 +│/);
  assert.match(titles([watcher('local-pc'), watcher('dev-container')]), /│ local-pc 🤖 +│ {4}│ dev-container 🤖 +│/);
  assert.match(titles([watcher('dev-container', 'other'), watcher(null)]), /│ local-pc +│ {4}│ dev-container +│/);
});

test('the control box title carries a robot when one of this project\'s agents is assigned to control', () => {
  const project = { id: 'p', name: 'P', sprint: null, control: { status: 'Online' }, environments: [] };
  const agent = (control, projectId = 'p') => ({ project: projectId, model: 'm', 'agent-name': 'X', 'work-item': null, control });
  const title = team => lines(initialState({ projects: [project], assignments: team })).find(l => l.includes('│ control'));
  assert.match(title([agent(true)]), /│ control 🤖 +│/);
  assert.match(title([agent(false), agent(true, 'other')]), /│ control +│/);
});

test('a control exiting with 75 starts the restart, once; any other code, not while quitting, marks it down with its code and the line before its exit line (ASS-193)', () => {
  const project = { id: 'p', name: 'P', sprint: null, control: { status: 'Online' }, environments: [] };
  const logged = { ...initialState({ projects: [project] }), controlLog: [
    { text: 'ticking', project: 'p' }, { text: 'boom: no such file', project: 'p' }, { text: 'downloader  idle' }, { text: 'control exited (code 1)', project: 'p' },
  ] };
  const down = controlExited(logged, 'p', 1);
  assert.deepEqual(down.controlsDown, { p: { code: 1, line: 'boom: no such file' } });
  assert.equal(down.quitting, false);
  const box = lines(down).filter(l => l.includes('│ control') || l.includes('exited: ') || l.includes('last: '));
  assert.match(box[0], /│ control DOWN +│/);
  assert.ok(box.some(l => /│ exited: code 1 +│/.test(l)));
  assert.ok(box.some(l => /│ last: boom: no such file +│/.test(l)));
  assert.ok(render(down, screen).some(l => l.includes('\x1b[31mcontrol DOWN')));   // in red
  // Shown even once control's own record is gone, and the long line cut short.
  const gone = controlExited({ ...logged, projects: [{ ...project, control: undefined }], controlLog: [{ text: 'x'.repeat(200), project: 'p' }, { text: 'control exited (code 1)', project: 'p' }] }, 'p', 1);
  assert.ok(lines(gone).some(l => /│ control DOWN +│/.test(l)));
  assert.ok(lines(gone).every(l => !l.includes('x'.repeat(61))));
  // 75: a restart, the dashboard shutting down to exit with it; nothing marked down.
  const restarting = controlExited(logged, 'p', 75);
  assert.deepEqual([restarting.quitting, restarting.restart, restarting.controlsDown], [true, true, {}]);
  // While quitting or restarting, the controls being stopped are not down, and a second 75 changes nothing.
  assert.equal(controlExited(restarting, 'p', 75), restarting);
  assert.equal(controlExited(restarting, 'p', null), restarting);
  const quitting = handleKey(logged, key('Q', { sequence: 'Q' }));
  assert.equal(controlExited(quitting, 'p', 1), quitting);
});

test('a restart drains: each control\'s "restart waiting for N agents" line shows on the bottom line as "restarting: waiting for N agents", summed; the dashboard quits for it only once no control it named still runs (ASS-200)', () => {
  const projects = ['p', 'q'].map(id => ({ id, name: id.toUpperCase(), sprint: null, control: { status: 'Online' }, environments: [] }));
  const start = initialState({ projects });
  const bottom = state => render(state, screen).join('\n');
  assert.equal(controlDraining(start, 'p', '2026-10-27T20:00:00.000Z dispatch ABC-3 A plan'), start);             // any other line: nothing
  const p = controlDraining(start, 'p', '2026-10-27T20:00:00.000Z restart waiting for 2 agents to end their turns (up to 300s), dispatching none');
  assert.match(bottom(p), /restarting: waiting for 2 agents to end their turns/);
  const both = controlDraining(p, 'q', '2026-10-27T20:00:00.000Z restart waiting for 1 agent to end its turn (up to 300s), dispatching none');
  assert.match(bottom(both), /restarting: waiting for 3 agents to end their turns/);
  const fewer = controlDraining(both, 'p', '2026-10-27T20:00:05.000Z restart waiting for 1 agent to end its turn (up to 300s), dispatching none');
  assert.match(bottom(fewer), /restarting: waiting for 2 agents/);
  // p drained and exited with 75 while q, named too, still runs: the dashboard waits for it.
  const waiting = controlExited(fewer, 'p', 75, 1);
  assert.deepEqual([waiting.quitting, waiting.restart, waiting.draining, waiting.controlsDown], [false, true, { q: 1 }, {}]);
  assert.match(bottom(waiting), /restarting: waiting for 1 agent to end its turn/);
  assert.match(bottom(controlExited(start, 'p', 75, 1)), /restarting: waiting for every control to exit/);   // q named but yet to say it drains
  // q exits too: now it quits, to exit with 75.
  const done = controlExited(waiting, 'q', 75, 0);
  assert.deepEqual([done.quitting, done.restart], [true, true]);
  // A named control that ends otherwise while the restart waits is marked down, and no longer waited for.
  const crashed = controlExited(waiting, 'q', 1, 0);
  assert.deepEqual([crashed.quitting, crashed.restart, crashed.controlsDown.q?.code], [true, true, 1]);
});

test('uptime is the time since control started, in its two largest units', () => {
  const at = start => lines(initialState({ projects: [{ name: 'P', sprint: null, control: { 'start-time': start }, environments: [] }] }))
    .find(l => l.includes('│ uptime: '));
  assert.match(at('2026-10-01T16:03:30Z'), /│ uptime: 0m /);
  assert.match(at('2026-09-30T16:43:00Z'), /│ uptime: 23h 21m /);
  assert.match(at('2024-06-06T00:00:00Z'), /│ uptime: 847d 16h /);
  assert.ok(!lines(initialState({ projects: [{ name: 'P', sprint: null, control: { status: 'Online' }, environments: [] }] })).some(l => l.includes('uptime')));
});

test('the ticket table runs down to the platform boxes', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ key: `ABC-${100 + i}`, title: 'T', priority: i }));
  const project = { name: 'P', sprint: { ...sprint, features: many, bugs: [], spikes: [] }, control: { status: 'Online' }, environments: [] };
  const out = lines(initialState({ projects: [project] }), wide);
  const top = out.findIndex(l => l.includes('│ Priority │')) - 1, bottom = out.findIndex((l, i) => i > top && l.startsWith('└'));
  const boxes = out.findIndex(l => /^ +┌/.test(l));
  assert.ok(keyUnder(out, bottom) > 0);
  assert.equal(bottom + keyUnder(out, bottom), boxes - 1);           // the key between them (ASS-259)
});

test('the progress bar sizes each state by its tickets and shades it by sequence: Done #3A703A, darker each step back, black at the furthest; the table\'s squares match (ASS-48)', () => {
  const steps = [{ id: 'blocked', name: 'Blocked', sequence: 0 }, { id: 'build', name: 'Build', sequence: 5 }, { id: 'done', name: 'Done', sequence: 10 }];
  const ticket = (key, status) => ({ key, title: 'T', ...single({ 'harness-status': hs(status) }) });
  const tickets = [ticket('A-1', 'done'), ticket('A-2', 'done'), ticket('A-3', 'build'), ticket('A-4', 'blocked'), ticket('A-5', 'mystery')];
  const project = { name: 'P', stateEngine: 'e', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } };
  const state = initialState({ projects: [project], workflows: [{ name: 'e', steps }] });
  const bar = render(state, { ...screen, columns: 42 }).find(l => l.startsWith('│') && l.includes('█'));
  // [width, rgb] of each run.
  const runs = [...bar.matchAll(/\x1b\[38;2;([\d;]+)m(█+)/g)].map(([, rgb, run]) => [run.length, rgb]);
  assert.deepEqual(runs, [[10, '0;0;0'], [10, '29;56;29'], [20, '58;112;58']]);   // blocked 1, build 1, done 2 of 4 counted
  const out = render(state, { ...wide, rows: 80 }).map(unhighlight);
  const square = key => out.find(l => l.includes(key)).match(/^│ \x1b\[38;2;([\d;]+)m▮/)?.[1];
  assert.deepEqual(['A-1', 'A-3', 'A-4'].map(square), ['58;112;58', '29;56;29', '0;0;0']);
});

test('on the progress bar\'s bottom border, a robot per agent on a sprint ticket, where its variation\'s state starts', () => {
  const steps = [{ id: 'build', name: 'Build', sequence: 5 }, { id: 'done', name: 'Done', sequence: 10 }];
  const ticket = (key, status) => ({ key, title: 'T', ...single({ 'harness-status': hs(status) }) });
  const project = { id: 'example', name: 'P', stateEngine: 'e', sprint: { ...sprint, features: [ticket('A-1', 'done'), ticket('A-2', 'build')], bugs: [], spikes: [] } };
  const team = [
    assignment('Daredevil', 'A-2'), assignment('Elektra', 'A-2'), assignment('Punisher', 'A-1'),
    assignment('Superman', null), assignment('Flash', 'A-9'), assignment('Robin', 'A-1', null, 'assassin'),
  ];
  const out = lines(initialState({ projects: [project], workflows: [{ name: 'e', steps }], assignments: team }), { ...screen, columns: 42 });
  const bar = out.findIndex(l => l.startsWith('│█'));
  assert.equal(out[bar + 1], `└🤖🤖${'─'.repeat(16)}🤖${'─'.repeat(18)}┘`);   // runs of 20 and 20: build at column 0, done at 20
  assert.equal(out[bar + 2], ` Build${' '.repeat(15)}Done`);       // each state's name where its run starts
  assert.equal(out[bar + 3], '');                                  // then a blank line, and the ticket table
  assert.ok(out[bar + 4].startsWith('┌'));
});

test('without tickets in a known state, the progress bar is an empty box', () => {
  const out = lines(initialState({ projects: [{ name: 'P', sprint: null }] }));
  assert.ok(out.some(l => /^│ {118}│$/.test(l)));
});

test('below the progress bar, a full-width ticket table', () => {
  const out = lines(state, wide);
  const top = out.findIndex(l => l.startsWith('└')) + 3;            // past the state names and a blank line
  assert.equal(out[top], `┌${out[top].slice(1, -1)}┐`);
  assert.equal(out[top].length, wide.columns);
  assert.match(out[top + 1], /^│ +Ticket +│ Priority │ +Status +│ Points │ +Build +│ +Dev +│ +Testing +│ +MR +│ Total Token Spend │ +Assignee +│ +Health +│ +Agents +│$/);
});

test('one row per sprint ticket, with stacked build and MR lines', () => {
  const out = lines(state, wide);
  const first = out.findIndex(l => l.includes('ABC-1: New Feature'));
  assert.match(out[first], /ABC-1: New Feature +2 +Code Review +3 +branch: change\/ABC-1 +● ● ● +● ● ● +!1827 +Running +— +Ada Example +Healthy +🤖 Daredevil +│$/);
  assert.match(out[first + 1], /^│ +worktree: \.worktrees\/ABC-1 +!12 {4}Merged +🤖 Elektra +│$/);
  assert.match(out[first + 2], /^│( {3}-)+ +│$/);                                   // dashed between rows (ASS-243)
  assert.match(out[first + 3], /ABC-2: New Bug +1 +Backlog +— {20,}— +— +— +— +— +— +— +│$/);
});

test('rows run from closest to done to furthest, by step sequence, then priority', () => {
  const ticket = (key, status, priority) => ({ key, title: 'T', priority, ...single({ 'harness-status': hs(status) }) });
  const one = { name: 'P', stateEngine: 'example-development', sprint: {
    ...sprint,
    features: [ticket('A-1', 'backlog', 2), ticket('A-2', 'code-review', 5), ticket('A-3', 'mystery', 1)],
    bugs: [ticket('A-4', 'backlog', 1), ticket('A-5', 'code-review', 3)],
    spikes: [],
  } };
  const out = lines(initialState({ projects: [one], workflows: [engine] }), { ...wide, rows: 80 });
  assert.deepEqual(out.filter(l => /A-\d: T/.test(l)).map(l => l.match(/A-\d/)[0]), ['A-5', 'A-2', 'A-4', 'A-1', 'A-3']);
});

// A project's repositories, as loadProjects reads them from project.json.
const repo = (name, workSpace = {}, devContainer = {}, status = 'Active') => ({
  url: `https://gitlab.com/group/${name}`, status, 'ai-feedback-short': '',
  'work-space': { 'server-name': null, branch: 'master', folder: null, ...workSpace },
  'dev-container': { status: 'Stable', 'needs-rebuilt': false, 'server-name': null, 'base-image': null, ...devContainer },
});
const tableTop = (out, header) => out.findIndex(l => header.test(l)) - 1;

test('the ticket table takes all the space under the progress bar; the repos screen\'s table takes all the space under the header', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ key: `ABC-${100 + i}`, title: 'T', priority: i }));
  const repositories = Array.from({ length: 30 }, (_, i) => repo(`repo-${i}`));
  const project = { name: 'P', sprint: { ...sprint, features: many, bugs: [], spikes: [] }, repositories };
  const tall = { ...wide, rows: 60 };
  for (const pauses of [{}, HUMAN]) {
    const out = lines(initialState({ projects: [project], pauses }), tall);
    assert.equal(out.length, tall.rows);
    assert.ok(out.some(l => l.includes('ABC-100')));
    assert.ok(!out.some(l => l.includes('repo-0')));
    const boxes = out.findLastIndex(l => /^ +┌/.test(l)), bottom = out.findLastIndex((l, i) => i < boxes && l.startsWith('└'));
    assert.equal(bottom + keyUnder(out, bottom), boxes - 1);   // the ticket table ends above the key (ASS-259) and the platform boxes
    const repos = lines({ ...initialState({ projects: [project], pauses }), screen: 'r' }, tall);
    assert.equal(repos.length, tall.rows);
    assert.ok(repos.some(l => l.includes('repo-0')));
    assert.ok(!repos.some(l => l.includes('ABC-100')));
    assert.ok(repos[repos.findLastIndex(l => /^ +┌/.test(l)) - 1].startsWith('└'));
    assert.equal(repos.at(-2), '');
  }
});

test('r shows the repositories, one row each: its name linked to its url, then its work-space and dev-container fields', () => {
  const repositories = [
    repo('backend'),
    { ...repo('frontend', { 'server-name': 'ws-1', branch: 'develop', folder: '/src/frontend' }, { status: 'Broken', 'needs-rebuilt': true, 'server-name': 'dc-1', 'base-image': 'node:22' }), 'ai-feedback-short': 'Builds cleanly' },
  ];
  const project = { ...projects[0], repositories };
  const raw = render(handleKey(initialState({ projects: [project], workflows: [engine], assignments }), key('r')), { ...wide, rows: 60 });
  const out = raw.map(strip);
  const head = out.findIndex(l => /^│ +Repository +│/.test(l));
  assert.ok(head > 0);
  assert.ok(!out.some(l => l.includes('│ Priority │')));
  assert.match(out[head], /^│ +Repository +│ Branch +│ +Folder +│ Server │ Dev Container │ Needs Rebuilt │ Container Server │ Base Image │ +Health +│ +Agents +│$/);
  assert.equal(out[head].length, wide.columns);
  assert.match(out[head + 2], /^│ backend +master +— +— +Stable +no +— +— +— +— +│$/);
  assert.match(out[head + 4], /^│ frontend +develop +\/src\/frontend +ws-1 +Broken +yes +dc-1 +node:22 +Builds cleanly +— +│$/);
  assert.ok(raw[head + 2].includes('\x1b]8;;https://gitlab.com/group/backend\x1b\\backend'));
});

test('the repository Agents column lists each assignment to the repository in this project, one per line', () => {
  const repoAssignment = (name, repoName, project = 'example') => ({ ...assignment(name, null, null, project), repo: repoName });
  const onRepos = [
    ...assignments,
    repoAssignment('Superman', 'backend'),
    repoAssignment('Batman', 'backend'),
    repoAssignment('Flash', 'backend', 'assassin'),
    repoAssignment('Robin', 'qa'),
  ];
  const project = { ...projects[0], repositories: [repo('backend'), repo('frontend')] };
  const out = lines({ ...initialState({ projects: [project], workflows: [engine], assignments: onRepos }), screen: 'r' }, { ...wide, rows: 70 });
  const row = out.findIndex(l => /^│ backend /.test(l));
  assert.match(out[row], / — +🤖 Superman +│$/);
  assert.match(out[row + 1], / 🤖 Batman +│$/);
  assert.match(out.find(l => /^│ frontend /.test(l)), / — +— +│$/);
  for (const name of ['Flash', 'Robin']) assert.ok(!out.some(l => l.includes(name)), name);
  assert.ok(!out.some(l => /ABC-\d.*Superman/.test(l)));            // a repository assignment is not on any ticket
});

test('only Active repositories show', () => {
  const repositories = [repo('backend'), repo('frontend', {}, {}, 'Inactive'), repo('qa', {}, {}, 'Active')];
  const out = lines({ ...initialState({ projects: [{ ...projects[0], repositories }], workflows: [engine] }), screen: 'r' }, { ...wide, rows: 60 });
  assert.ok(out.some(l => /^│ backend /.test(l)));
  assert.ok(out.some(l => /^│ qa /.test(l)));
  assert.ok(!out.some(l => /^│ frontend /.test(l)));
});

test('a project without repositories says so', () => {
  const out = lines({ ...initialState({ projects: [{ ...projects[0] }], workflows: [engine] }), screen: 'r' }, wide);
  assert.ok(out.some(l => /^│ No repositories +│$/.test(l)));
});

test('up and down move the selected ticket, scrolling only to keep it in view', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ key: `ABC-${100 + i}`, title: 'T', priority: i }));
  const big = { ...initialState({ projects: [{ name: 'P', sprint: { ...sprint, features: many, bugs: [], spikes: [] } }, { name: 'Q', sprint: null }] }), focus: 'tickets' };
  const shown = s => render(s, wide).filter(l => /ABC-\d+:/.test(l));
  const keyOf = l => l.match(/ABC-\d+/)[0];
  const highlighted = s => shown(s).filter(l => l.includes('\x1b[7m')).map(keyOf);
  const press = (s, name, times = 1) => { for (let i = 0; i < times; i++) s = handleKey(s, key(name), wide); return s; };

  assert.deepEqual([big.selected, big.scroll], [null, null]);      // not scrolled yet (ASS-60): no Done row, so the top
  assert.deepEqual(highlighted(big), ['ABC-100']);
  assert.deepEqual(press(big, 'up'), { ...big, selected: 0, scroll: 0 });   // a key on the grid fixes where it is

  // Rows shown in full: the last one may be cut by the bottom border.
  const full = s => render(s, wide).map(strip).filter((l, i, all) => /ABC-\d+:/.test(l) && !all[i + 1].startsWith('└'));
  const visibleCount = full(big).length;
  const atBottom = press(big, 'down', visibleCount - 1);           // last fully visible row
  assert.deepEqual([atBottom.selected, atBottom.scroll], [visibleCount - 1, 0]);
  assert.deepEqual(highlighted(atBottom), [`ABC-${100 + visibleCount - 1}`]);

  const scrolled = press(atBottom, 'down');                         // one more: the table follows
  assert.deepEqual([scrolled.selected, scrolled.scroll], [visibleCount, 1]);
  assert.equal(keyOf(full(scrolled).at(-1)), `ABC-${100 + visibleCount}`);
  assert.deepEqual(highlighted(scrolled), [`ABC-${100 + visibleCount}`]);

  const end = press(big, 'down', 100);
  assert.equal(end.selected, 39);
  assert.deepEqual(highlighted(end), ['ABC-139']);
  const backUp = press(end, 'up', visibleCount - 1);                // top of the view, no scroll yet
  assert.equal(backUp.scroll, end.scroll);
  assert.equal(keyOf(shown(backUp)[0]), `ABC-${100 + backUp.selected}`);
  const upOnce = press(backUp, 'up');                               // one more: the table follows up
  assert.deepEqual([upOnce.selected, upOnce.scroll], [backUp.selected - 1, end.scroll - 1]);
  assert.deepEqual(highlighted(upOnce), [keyOf(shown(upOnce)[0])]);

  const other = handleKey({ ...end, focus: 'menu' }, key('right'), wide);         // another project starts at the top
  assert.deepEqual([other.selected, other.scroll], [null, null]);
  assert.equal(handleKey({ ...big, screen: 'p' }, key('down'), wide).selected, null);
  assert.equal(handleKey({ ...big, focus: 'menu' }, key('down'), wide).selected, null);   // only the focused grid moves
  assert.deepEqual(highlighted({ ...end, focus: 'menu' }), []);                      // and only it shows its selection
});

test('a ticket with several variations shows one full row per variation, keyed KEY.NAME, and no parent row', () => {
  const variation = (name, branch, mr) => ({ name, build: { branch }, 'acceptance-criteria': [{ 'dev-status': 'Passed', 'testing-status': 'Failed' }], 'merge-request': [{ key: mr, 'build-status': 'Passed', url: 'http://mr' }] });
  const tickets = [
    { key: 'ABC-7', title: 'Two ways', url: 'http://t/7', priority: 1, points: 5, 'ticket-system-assignment': 'Ada Example', variations: [variation('A', 'change/a', '!1'), variation('B', 'change/b', '!2')] },
    { key: 'ABC-8', title: 'One way', priority: 2, ...single({ build: { branch: 'change/one' } }) },
  ];
  const out = lines(initialState({ projects: [{ name: 'P', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } }] }), { ...wide, rows: 80 });
  const rows = out.filter(l => /ABC-\d/.test(l));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^│  ✦ {4} ABC-7\.A: Two ways +1 +— +5 +branch: change\/a +● +● +!1 +Passed +— +Ada Example +— +— +│$/);
  assert.match(rows[1], /^│  ✦ {4} ABC-7\.B: Two ways +1 +— +5 +branch: change\/b +● +● +!2 +Passed +— +Ada Example +— +— +│$/);
  assert.match(rows[2], /^│  ✦ {4} ABC-8: One way /);
  assert.ok(!out.some(l => /ABC-7: |Variation/.test(l)));
  assert.ok(render(initialState({ projects: [{ name: 'P', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } }] }), { ...wide, rows: 80 })
    .some(l => l.includes('\x1b]8;;http://t/7\x1b\\ABC-7.B: Two ways\x1b]8;;\x1b\\')));
});

test('each variation row has its own status and sort position; priority and points repeat', () => {
  const steps = [{ id: 'stuck', name: 'Blocked for Human', sequence: 0, 'warning-indicator': true }, { id: 'review', name: 'Code Review', sequence: 13 }, { id: 'done', name: 'Done', sequence: 29 }];
  const tickets = [
    { key: 'ABC-7', title: 'T', priority: 4, points: 5, variations: [{ name: 'A', 'harness-status': hs('stuck') }, { name: 'B', 'harness-status': hs('done') }] },
    { key: 'ABC-8', title: 'U', priority: 1, ...single({ 'harness-status': hs('review') }) },
  ];
  const project = { name: 'P', stateEngine: 'e', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } };
  const out = render(initialState({ projects: [project], workflows: [{ name: 'e', steps }] }), { ...wide, rows: 80 }).map(unhighlight);
  const rows = out.filter(l => /ABC-\d/.test(l)).map(strip);
  assert.deepEqual(rows.map(l => l.match(/ABC-[\d.AB]+/)[0]), ['ABC-7.B', 'ABC-8', 'ABC-7.A']);
  assert.match(rows[0], /ABC-7\.B: T +4 +Done +5 /);
  assert.match(rows[2], /^│ ▮✦ {4} ABC-7\.A: T +4 +Blocked for Human +5 /);
  assert.match(rows[0], /^│ ▮✦ {4} ABC-7\.B: /);   // the icon columns blank (ASS-259)
  const bar = out.find(l => l.startsWith('│') && l.includes('38;2'));
  assert.equal([...bar.matchAll(/\x1b\[(?:38;2;[\d;]+|32)m█/g)].length, 3);             // one run per variation status
});

test('each variation row can be selected', () => {
  const tickets = [{ key: 'ABC-7', title: 'T', priority: 1, variations: [{ name: 'A' }, { name: 'B' }] }];
  const s = handleKey({ ...initialState({ projects: [{ name: 'P', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } }] }), focus: 'tickets' }, key('down'), wide);
  assert.ok(render(s, wide).find(l => l.includes('ABC-7.B')).includes('\x1b[7m'));
});

test('Agents lists each assignment on its own line: robot, name and the agent\'s own ai-status-update-short, when it has one', () => {
  const updated = { ...state, assignments: state.assignments.map(a => (a['agent-name'] === 'Daredevil' ? { ...a, 'ai-status-update-short': 'Writing the fix', 'ai-feedback-short': 'Not this' } : a)) };
  const out = lines(updated, { ...wide, columns: 220 });
  const row = out.findIndex(l => l.includes('ABC-1: New Feature'));
  assert.match(out[row], / Healthy +🤖 Daredevil - Writing the fix +│$/);
  assert.match(out[row + 1], / 🤖 Elektra +│$/);                   // none yet: the name alone
  assert.ok(!out.some(l => l.includes('Punisher')));
  assert.match(out.find(l => l.includes('ABC-2: New Bug')), / — +— +│$/);
});

test('an Agents line longer than 40 columns is cut with an ellipsis', () => {
  const long = [assignment('Daredevil-of-Hells-Kitchen-and-Matt-Murdock', 'ABC-1')];
  // 220 columns, not wide's 200: with Ticket's floor taken first (ASS-207) the Agents cell is 29 wide there.
  const row = lines(initialState({ projects, workflows: [engine], assignments: long }), { ...wide, columns: 220 }).find(l => l.includes('🤖 Daredevil'));
  const cell = row.slice(row.indexOf('🤖 ')).replace(/ +│$/, '');
  assert.equal(visible(cell), 40);
  assert.ok(cell.endsWith('…'));
});

test('the grids show ai-feedback-short, never ai-feedback-long; an agent\'s shows only on the agents screen', () => {
  const long = { 'ai-feedback-long': 'The long story' };
  const tickets = [{ key: 'ABC-7', title: 'T', priority: 1, variations: [{ name: 'A', 'ai-feedback-short': 'Short ticket', ...long }] }];
  const project = { id: 'example', name: 'P', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] }, repositories: [{ ...repo('backend'), 'ai-feedback-short': 'Short repo', ...long }] };
  const said = { 'ai-feedback-short': 'Agent feedback', ...long };
  const team = [{ ...assignment('Daredevil', 'ABC-7'), ...said }, { ...assignment('Superman', null), repo: 'backend', ...said }, { ...assignment('Swamp-Thing', null), agent: 'Daredevil', ...said }];
  const st = initialState({ projects: [project], assignments: team });
  const on = screen => lines({ ...st, screen, agentsTable: true }, { ...wide, rows: 60 }).join('\n');
  const out = ['s', 'r', 'a'].map(on).join('\n');
  for (const text of ['Short ticket', 'Short repo', '🤖 Daredevil', '🤖 Superman', '🤖 Swamp-Thing']) assert.ok(out.includes(text), text);
  assert.ok(!out.includes('The long story'));
  assert.ok(on('a').includes('Agent feedback'));
  assert.ok(!on('s').includes('Agent feedback') && !on('r').includes('Agent feedback'));
});

test('Health shows each variation\'s ai-feedback-short, cut with an ellipsis past 40 columns', () => {
  const long = 'Two failing tests on the results grid and a stale merge request';
  const tickets = [{ key: 'ABC-7', title: 'T', priority: 1, variations: [{ name: 'A', 'ai-feedback-short': 'On course' }, { name: 'B', 'ai-feedback-short': long }] }];
  const out = lines(initialState({ projects: [{ name: 'P', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } }] }), { ...wide, rows: 80 });
  assert.match(out.find(l => l.includes('ABC-7.A')), / On course +— +│$/);
  const cell = out.find(l => l.includes('ABC-7.B')).match(/ {2}(Two failing.*?…)/)[1];
  assert.equal(visible(cell), 40);
});

test('an assignment shows on its variation of the ticket, or on every variation when it names none', () => {
  const tickets = [{ key: 'ABC-7', title: 'T', priority: 1, variations: [{ name: 'A' }, { name: 'B' }] }];
  const both = [assignment('Daredevil', 'ABC-7'), assignment('Elektra', 'ABC-7', 'B'), assignment('Punisher', 'ABC-7.B')];
  const out = lines(initialState({ projects: [{ id: 'example', name: 'P', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } }], assignments: both }), { ...wide, rows: 80 });
  const a = out.findIndex(l => l.includes('ABC-7.A')), b = out.findIndex(l => l.includes('ABC-7.B'));
  assert.match(out[a], / — +🤖 Daredevil +│$/);
  assert.ok(!out.slice(a, b).some(l => l.includes('Elektra')));
  assert.match(out[b], / — +🤖 Daredevil +│$/);
  assert.match(out[b + 1], /🤖 Elektra +│$/);
  assert.ok(!out.some(l => l.includes('Punisher')));
});

test('an assignment shows only on the dashboard of the project it names', () => {
  const twin = { id: 'example-2', name: 'Example 2', stateEngine: 'example-development', sprint };
  const mixed = [assignment('Daredevil', 'ABC-1'), assignment('Elektra', 'ABC-1', null, 'example-2')];
  const first = initialState({ projects: [projects[0], twin], workflows: [engine], assignments: mixed });
  const shows = s => lines(s, wide).filter(l => l.includes('🤖 ')).map(l => l.match(/🤖 (\w+)/)[1]);
  assert.deepEqual(shows(first), ['Daredevil']);
  assert.deepEqual(shows(handleKey(first, key('right'), wide)), ['Elektra']);
});

test('MR keys and build statuses are links', () => {
  const row = render(state, wide).find(l => l.includes('!1827'));
  assert.match(row, /\x1b\]8;;http:\/\/mr\/1827\x1b\\!1827\x1b\]8;;\x1b\\/);
  assert.match(row, /\x1b\]8;;http:\/\/mr\/1827\x1b\\Running\x1b\]8;;\x1b\\/);
});

test('the ticket cell links to the ticket; without a url it is plain', () => {
  const out = render(state, wide);
  assert.ok(out.some(l => l.includes('\x1b]8;;http://t/ABC-1\x1b\\ABC-1: New Feature\x1b]8;;\x1b\\')));
  assert.ok(out.some(l => /^│ \x1b\[(?:38;2;[\d;]+|32)m▮\x1b\[0m✘ {4} ABC-2: New Bug /.test(l)));
});

test('each ticket type has its own icon left of the name, and rows stay full width', () => {
  const out = lines(state, wide);
  for (const [icon, name] of [['✦', 'ABC-1: New Feature'], ['✘', 'ABC-2: New Bug'], ['⌕', 'ABC-3: New Spike']]) {   // one-cell glyphs (ASS-259)
    const row = out.find(l => l.includes(name.split(':')[0]));
    assert.match(row, new RegExp(`^│ (▮| )${icon} {3}(⚉| ) ${name.split(':')[0]}`));
    assert.equal(visible(row), wide.columns);
  }
});

test('Build is always two lines: branch, then worktree, each blank when missing', () => {
  const tickets = [
    { key: 'ABC-7', title: 'T', priority: 1, ...single({ build: { branch: 'change/abc-7' } }) },
    { key: 'ABC-8', title: 'U', priority: 2 },
  ];
  const out = lines(initialState({ projects: [{ name: 'P', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } }] }), wide);
  const seven = out.findIndex(l => l.includes('ABC-7')), eight = out.findIndex(l => l.includes('ABC-8'));
  assert.match(out[seven], / branch: change\/abc-7 /);
  assert.match(out[seven + 1], /^│ +│$/);
  assert.equal(eight, seven + 3);                                   // two lines, then the blank between rows
  assert.equal(out[eight].match(/—/g).length, 9);                  // Status, Points, Dev, Testing, MR, Total Token Spend, Assignee, Agents, Health — none in Build
  assert.match(out[eight + 1], /^│ +│$/);
});

test('the branch name links to its branch-url; without one it is plain', () => {
  assert.ok(render(state, wide).some(l => l.includes('branch: \x1b]8;;http://b/ABC-1\x1b\\change/ABC-1\x1b]8;;\x1b\\')));
  const plain = { name: 'P', sprint: { ...sprint, features: [{ key: 'ABC-9', title: 'T', ...single({ build: { branch: 'change/x' } }) }], bugs: [], spikes: [] } };
  assert.ok(render(initialState({ projects: [plain] }), wide).some(l => l.includes(' branch: change/x ')));
});

test('Dev shows a circle per AC: green Passed, red Failed, gray Incomplete', () => {
  const criteria = ['Passed', 'Failed', 'Incomplete'].map(status => ({ 'dev-status': status, 'testing-status': 'Passed' }));
  const one = { name: 'P', sprint: { ...sprint, features: [{ key: 'ABC-9', title: 'T', ...single({ 'acceptance-criteria': criteria }) }], bugs: [], spikes: [] } };
  const out = render(initialState({ projects: [one] }), wide).map(unhighlight);
  assert.ok(out.some(l => l.includes(' \x1b[32m●\x1b[0m \x1b[31m●\x1b[0m \x1b[90m●\x1b[0m ')));
});

test('Testing shows the same circles, by testing-status', () => {
  const criteria = ['Incomplete', 'Passed', 'Failed'].map(status => ({ 'dev-status': 'Passed', 'testing-status': status }));
  const one = { name: 'P', sprint: { ...sprint, features: [{ key: 'ABC-9', title: 'T', ...single({ 'acceptance-criteria': criteria }) }], bugs: [], spikes: [] } };
  const out = render(initialState({ projects: [one] }), wide).map(unhighlight);
  assert.ok(out.some(l => l.includes(' \x1b[90m●\x1b[0m \x1b[32m●\x1b[0m \x1b[31m●\x1b[0m ')));
});

test('the worktree name links to its worktree-folder as a file URL; without one it is plain', () => {
  assert.ok(render(state, wide).some(l => l.includes('worktree: \x1b]8;;file:///src/my%20repo/.worktrees/ABC-1\x1b\\.worktrees/ABC-1\x1b]8;;\x1b\\')));
  const plain = { name: 'P', sprint: { ...sprint, features: [{ key: 'ABC-9', title: 'T', ...single({ build: { worktree: 'wt' } }) }], bugs: [], spikes: [] } };
  assert.ok(render(initialState({ projects: [plain] }), wide).some(l => l.includes(' worktree: wt ')));
});

// A history: committed → code-review → backlog → code-review, three agents sent in since the last arrival.
const sent = n => Array.from({ length: n }, (_, i) => ({ 'dispatched-to': `Agent-${i}`, timestamp: '2026-09-30T10:00:00Z' }));
const history = [
  { 'from-state': 'committed', 'to-state': 'code-review', timestamp: '2026-09-29T10:00:00Z', 'agent-dispatch-log': sent(1) },
  { 'from-state': 'code-review', 'to-state': 'backlog', timestamp: '2026-09-29T12:00:00Z', 'agent-dispatch-log': [] },
  { 'from-state': 'backlog', 'to-state': 'code-review', timestamp: '2026-09-30T09:00:00Z', 'agent-dispatch-log': sent(3) },
];
const withHistory = [
  { key: 'H-1', title: 'Back again', priority: 1, ...single({ 'harness-status': hs('code-review'), 'state-changes': history }) },
  { key: 'H-2', title: 'Just in', priority: 2, ...single({ 'harness-status': hs('backlog'), 'state-changes': [] }) },
  { key: 'H-3', title: 'Started here', priority: 3, ...single({ 'harness-status': hs('backlog'), 'state-changes': [{ 'from-state': 'backlog', 'to-state': 'code-review', timestamp: '2026-09-29T10:00:00Z', 'agent-dispatch-log': sent(2) }, { 'from-state': 'code-review', 'to-state': 'backlog', timestamp: '2026-09-30T10:00:00Z', 'agent-dispatch-log': [] }] }) },
];
const historyState = initialState({ projects: [{ ...projects[0], sprint: { ...sprint, features: withHistory, bugs: [], spikes: [] } }], workflows: [engine] });

test('Status adds (times in this state, agents dispatched since arriving this time) from state-changes; without state-changes it is the name alone', () => {
  const out = lines(historyState, wide);
  assert.match(out.find(l => l.includes('H-1: Back again')), / Code Review \(2, 3\) /);
  assert.match(out.find(l => l.includes('H-2: Just in')), / Backlog \(1, 0\) /);         // its history starts here, nothing yet
  assert.match(out.find(l => l.includes('H-3: Started here')), / Backlog \(2, 0\) /);    // started here and came back
  assert.match(lines(state, wide).find(l => l.includes('ABC-1: New Feature')), / Code Review {3,}/);
});

test('Status counts visits since a human last resolved Blocked for Human, as control caps them; a retry is no resolution', () => {
  const human = { id: 'blocked-for-human', name: 'Blocked for Human', sequence: 0, 'is-blocked-state': true, action: { type: 'human' },
    'exit-events': [{ condition: { 'human-review': 'Resolved' }, 'follow-return-to-state': true }, { condition: { 'human-review': 'Have AI Try Again' }, 'move-to-state': 'blocked' }] };
  const blocking = { ...engine, steps: [human, { id: 'blocked', name: 'Blocked', sequence: 0 }, ...engine.steps] };
  const at = (from, to, n = 0) => ({ 'from-state': from, 'to-state': to, timestamp: '2026-09-30T10:00:00Z', 'agent-dispatch-log': sent(n) });
  const before = [...history, at('code-review', 'blocked-for-human')];
  const tickets = [
    { key: 'R-1', title: 'Resolved', priority: 1, ...single({ 'harness-status': hs('code-review'), 'state-changes': [...before, at('blocked-for-human', 'code-review', 1)] }) },
    { key: 'R-2', title: 'Retried', priority: 2, ...single({ 'harness-status': hs('code-review'), 'state-changes': [...before, at('blocked-for-human', 'blocked'), at('blocked', 'code-review', 1)] }) },
  ];
  const s = initialState({ projects: [{ ...projects[0], sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } }], workflows: [blocking] });
  const out = lines(s, wide);
  assert.match(out.find(l => l.includes('R-1: Resolved')), / Code Review \(1, 1\) /);
  assert.match(out.find(l => l.includes('R-2: Retried')), / Code Review \(3, 1\) /);
  assert.ok(lines({ ...s, screen: 'S', flowchartView: 'tickets' }, wide).some(l => /R-1: Resolved \(1, 1\)/.test(l)));
});

test('Status counts one pass through a group as one visit, and counts afresh once the ticket is reopened from Done, as control caps them (ASS-130)', () => {
  const finished = { ...engine, steps: [...engine.steps, { id: 'done', name: 'Done', sequence: 20, 'is-done': true }] };
  const at = (from, to, sub) => ({ 'from-state': from, 'to-state': to, timestamp: '2026-09-30T10:00:00Z', 'agent-dispatch-log': [], ...(sub ? { 'sub-state-change': sub } : {}) });
  const inner = (from, to) => at('code-review', 'code-review', { 'state-engine': 'review', 'from-state': from, 'to-state': to });
  const pass = [at('backlog', 'code-review'), inner(null, 'a'), inner('a', 'b'), inner('b', 'done')];
  const tickets = [
    { key: 'G-1', title: 'Grouped', priority: 1, ...single({ 'harness-status': hs('code-review'), 'state-changes': pass }) },
    { key: 'G-2', title: 'Reopened', priority: 2, ...single({ 'harness-status': hs('code-review'), 'state-changes': [...pass, at('code-review', 'done'), at('done', 'backlog'), ...pass] }) },
  ];
  const out = lines(initialState({ projects: [{ ...projects[0], sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } }], workflows: [finished] }), wide);
  assert.match(out.find(l => l.includes('G-1: Grouped')), / Code Review \(1, 0\) /);
  assert.match(out.find(l => l.includes('G-2: Reopened')), / Code Review \(1, 0\) /);
});

test('Status shows each sub-status after its parent, named from its own state engine, each with its stats from the changes made at its level', () => {
  const deep = { ...hs('code-review'), 'sub-status': { state: 'take-screenshots', 'state-engine': 'test', 'sub-status': { state: 'zoom', 'state-engine': 'gone' } } };
  // Changes within code-review: into take-screenshots (2 sent), then within it, into zoom (1 sent).
  const within = (sub, n) => ({ 'state-engine': 'example-development', 'from-state': 'code-review', 'to-state': 'code-review', 'sub-state-change': sub, timestamp: '2026-09-30T11:00:00Z', 'agent-dispatch-log': sent(n) });
  const nested = [...history,
    within({ 'state-engine': 'test', 'from-state': 'test', 'to-state': 'take-screenshots' }, 2),
    within({ 'state-engine': 'test', 'from-state': 'take-screenshots', 'to-state': 'take-screenshots', 'sub-state-change': { 'state-engine': 'gone', 'from-state': 'a', 'to-state': 'zoom' } }, 1),
  ];
  const tickets = [
    { key: 'S-1', title: 'Nested', priority: 1, ...single({ 'harness-status': deep, 'state-changes': nested }) },
    { key: 'S-2', title: 'No history', priority: 2, ...single({ 'harness-status': deep }) },
  ];
  const test = { name: 'test', steps: [{ id: 'take-screenshots', name: 'Take Screenshots', sequence: 2 }] };
  const out = lines(initialState({ projects: [{ ...projects[0], sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } }], workflows: [engine, test] }), { columns: 220, rows: 40 });
  // Code Review: 2 visits, its 3 + the 2 and 1 sent within it; Take Screenshots: 1 visit, its 2 + the 1 within it.
  assert.match(out.find(l => l.includes('S-1: Nested')), / Code Review \(2, 6\) › Take Screenshots \(1, 3\) › zoom \(1, 1\) /);
  assert.match(out.find(l => l.includes('S-2: No history')), / Code Review › Take Screenshots › zoom /);
});

// Grouped steps (ASS-67): build runs engine g, whose check runs engine h.
const groupedWorkflows = [
  { name: 'e', steps: [{ id: 'backlog', name: 'Backlog', sequence: 1 }, { id: 'build', name: 'Build', sequence: 5, color: '#112233', action: { type: 'state-engine', engine: 'g' } }, { id: 'done', name: 'Done', sequence: 10 }] },
  { name: 'g', steps: [
    { id: 'draft', name: 'Draft', sequence: 1, color: '#aabbcc', action: { type: 'prompt' } },
    { id: 'code', name: 'Generate Solution', sequence: 2, action: { type: 'prompt' }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'check' }] },
    { id: 'check', name: 'Check', sequence: 3, action: { type: 'state-engine', engine: 'h' } },
  ] },
  { name: 'h', steps: [{ id: 'inspect', name: 'Inspect', sequence: 1, color: '#ddeeff', action: { type: 'prompt' } }] },
];
const inBuild = (...levels) => ({ state: 'build', 'state-engine': 'e', ...(levels.length ? { 'sub-status': levels.reduceRight((sub, [engineName, state]) => ({ state, 'state-engine': engineName, ...(sub ? { 'sub-status': sub } : {}) }), undefined) } : {}) });
const groupedState = (features, extra = {}) => ({
  ...initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'e', sprint: { ...sprint, features, bugs: [], spikes: [] } }], workflows: groupedWorkflows, ...extra }),
  focus: 'tickets',
});
const grouped = [
  { key: 'G-1', title: 'Coding', priority: 1, ...single({ 'harness-status': inBuild(['g', 'code']) }) },
  { key: 'G-2', title: 'Drafting', priority: 2, ...single({ 'harness-status': inBuild(['g', 'draft']) }) },
  { key: 'G-3', title: 'Inspecting', priority: 3, ...single({ 'harness-status': inBuild(['g', 'check'], ['h', 'inspect']) }) },
  { key: 'G-4', title: 'Shipped', priority: 4, ...single({ 'harness-status': { state: 'done', 'state-engine': 'e' } }) },
];

test('a ticket inside a sub-engine shows its high-level state and its detailed step, "Build › Generate Solution", on the sprint table and its ticket screen (ASS-67)', () => {
  const out = lines(groupedState(grouped), wide);
  assert.match(out.find(l => l.includes('G-1: Coding')), / Build › Generate Solution /);
  assert.match(out.find(l => l.includes('G-3: Inspecting')), / Build › Check › Inspect /);
  const details = lines(onTab(press(groupedState(grouped), 'down', 'down', 'return'), 'details'), { ...wide, rows: 80 }).join('\n');   // G-1, third row
  assert.match(details, /Status\s+Build › Generate Solution/);
});

test('sprint rows sort by the group\'s sequence, then the detailed step\'s within it, level by level; the Ticket cell\'s square and the progress bar take the deepest step\'s color, falling back up the chain (ASS-67)', () => {
  const out = render(groupedState(grouped), { ...wide, rows: 80 }).map(unhighlight);
  const rows = out.filter(l => /G-\d: /.test(l));
  assert.deepEqual(rows.map(l => strip(l).match(/G-\d/)[0]), ['G-4', 'G-3', 'G-1', 'G-2']);
  const square = key => rows.find(l => l.includes(key)).match(/^│ (\x1b\[[\d;]+m)▮/)[1];
  assert.equal(square('G-3'), '\x1b[38;2;221;238;255m');          // Inspect's own
  assert.equal(square('G-1'), '\x1b[38;2;17;34;51m');             // Generate Solution has none: Build's
  assert.equal(square('G-2'), '\x1b[38;2;170;187;204m');          // Draft's own
  const bar = [...out.find(l => l.startsWith('│') && l.includes('38;2')).matchAll(/(\x1b\[(?:38;2;[\d;]+|32)m)█/g)].map(m => m[1]);
  assert.deepEqual(bar, ['\x1b[38;2;170;187;204m', '\x1b[38;2;17;34;51m', '\x1b[38;2;221;238;255m', '\x1b[38;2;58;112;58m']);   // one run per color, the grid's order reversed
});

test('(visits, dispatches) of a state-engine step count the sub-engine runs started from it, never its children\'s agents; each child its own, from zero on each entry (ASS-67, ASS-66\'s rule)', () => {
  const agents = n => Array.from({ length: n }, (_, i) => ({ 'dispatched-to': `Agent-${i}`, timestamp: '2026-09-30T10:00:00Z' }));
  const top = (from, to) => ({ 'state-engine': 'e', 'from-state': from, 'to-state': to, timestamp: '2026-09-30T09:00:00Z', 'agent-dispatch-log': [] });
  const within = (sub, n = 0) => ({ ...top('build', 'build'), 'sub-state-change': sub, 'agent-dispatch-log': agents(n) });
  const g = (from, to, below) => ({ 'state-engine': 'g', 'from-state': from, 'to-state': to, ...(below ? { 'sub-state-change': below } : {}) });
  const changes = [
    top('backlog', 'build'), within(g(null, 'draft'), 2), within(g('draft', 'code'), 1), within(g('code', 'draft'), 1), within(g('draft', 'code'), 3),   // the first run
    top('build', 'build'), within(g(null, 'draft'), 1), within(g('draft', 'code'), 2),                                                              // entered again
    within(g('code', 'check')), within(g('check', 'check', { 'state-engine': 'h', 'from-state': null, 'to-state': 'inspect' }), 4),
  ];
  const v = [{ key: 'G-5', title: 'Counted', priority: 1, ...single({ 'harness-status': inBuild(['g', 'check'], ['h', 'inspect']), 'state-changes': changes }) }];
  const row = lines(groupedState(v), { columns: 260, rows: 40 }).find(l => l.includes('G-5: Counted'));
  // Build: two visits, one run each — the latest's 1; Check: one visit, one run started; Inspect: one visit, its 4 agents.
  assert.match(row, / Build \(2, 1\) › Check \(1, 1\) › Inspect \(1, 4\) /);
  const coding = [{ ...v[0], ...single({ 'harness-status': inBuild(['g', 'code']), 'state-changes': changes.slice(0, 8) }) }];
  // Generate Solution counts within the second run alone: one visit, 2 agents — not the first run's two visits.
  assert.match(lines(groupedState(coding), { columns: 260, rows: 40 }).find(l => l.includes('G-5: Counted')), / Build \(2, 1\) › Generate Solution \(1, 2\) /);
  // The ticket screen's states, on its History tab: Build's dispatches are its runs, 2 in all.
  assert.ok(statesOf(lines(onTab(press(groupedState(v), 'return'), 'history'), { ...wide, rows: 80 })).includes('Build (2, 2)'));
});

test('a gate on a step inside a sub-engine (<engine>/<step>) once its work is done: the ticket shows a blue ● and its screen approves the move to the next step in that sub-engine, moving the run (ASS-67)', () => {
  const into = done => ({ 'state-engine': 'e', 'from-state': 'build', 'to-state': 'build', timestamp: '2026-10-01T10:00:00Z', 'agent-dispatch-log': [], 'work-is-done': done, 'sub-state-change': { 'state-engine': 'g', 'from-state': 'draft', 'to-state': 'code' } });
  const held = done => [{ key: 'G-6', title: 'Held', priority: 1, ...single({ 'harness-status': inBuild(['g', 'code']), 'gate-when-leaving-state': ['g/code'], 'state-changes': [into(done)] }) }];
  const runs = [{ id: 'run-1', project: 'p', 'state-engine': 'g', state: 'code', parent: { 'work-item': 'G-6', variation: 'A', 'state-engine': 'e', state: 'build' } }];
  const s = done => groupedState(held(done), { transientEngines: runs });
  assert.ok(blueDot(render(s(true), wide).find(l => l.includes('G-6')), 'G-6: Held'));
  assert.ok(!/[●⦿]/.test(render(s(false), wide).find(l => l.includes('G-6'))));
  const open = press(s(true), 'return');
  assert.match(actionsOf(lines(open, wide)).join('\n'), /Approve State Transition\s+→ Check/);
  assert.deepEqual(press(open, 'return').decide, ['transient-state-engine:change-state', 'run-1', 'code', 'check']);
});

test('a gate inside a sub-engine held with its pending move (ASS-132): Approve → the step in that sub-engine its exit was going to, approved with ticket:approve-gate, which moves the run with its output', () => {
  const into = { 'state-engine': 'e', 'from-state': 'build', 'to-state': 'build', timestamp: '2026-10-01T10:00:00Z', 'agent-dispatch-log': [], 'work-is-done': true, 'sub-state-change': { 'state-engine': 'g', 'from-state': 'draft', 'to-state': 'code' },
    'pending-move': { run: 'run-1', from: 'code', to: 'draft', reason: 'exit', output: { 'is-approved': false } } };
  const v = [{ key: 'G-6', title: 'Held', priority: 1, ...single({ 'harness-status': inBuild(['g', 'code']), 'gate-when-leaving-state': ['g/code'], 'state-changes': [into] }) }];
  const runs = [{ id: 'run-1', project: 'p', 'state-engine': 'g', state: 'code', parent: { 'work-item': 'G-6', variation: 'A', 'state-engine': 'e', state: 'build' } }];
  const open = press(groupedState(v, { transientEngines: runs }), 'return');
  assert.match(actionsOf(lines(open, wide)).join('\n'), /Approve\s+→ Draft/);
  assert.deepEqual(press(open, 'return').decide, ['ticket:approve-gate', 'p', 'G-6', 'A', 'build']);
});

// Build runs engine r, whose review is a human's.
const reviewWorkflows = [
  { ...groupedWorkflows[0], steps: groupedWorkflows[0].steps.map(s => (s.id === 'build' ? { ...s, action: { type: 'state-engine', engine: 'r' } } : s)) },
  { name: 'r', steps: [
    { id: 'prepare', name: 'Prepare', sequence: 1, 'return-to-state': 'rework', action: { type: 'none' } },
    { id: 'review', name: 'Review', sequence: 2, action: { type: 'human' }, 'exit-events': [{ condition: { 'human-review': 'Approved' }, 'move-to-state': 'finished' }, { condition: { 'human-review': 'Rejected' }, 'follow-return-to-state': true }] },
    { id: 'rework', name: 'Rework', sequence: 3, action: { type: 'none' } },
    { id: 'finished', name: 'Finished', sequence: 4, 'is-done': true },
  ] },
];

test('a human step inside a sub-engine: the ticket shows a blue ● and its screen offers the step\'s choices, recorded at the detailed step for control to move the run — one following the return-to-state named from the run\'s own history (ASS-67)', () => {
  const into = (from, to) => ({ 'state-engine': 'e', 'from-state': 'build', 'to-state': 'build', timestamp: '2026-10-01T10:00:00Z', 'agent-dispatch-log': [], 'work-is-done': false, 'sub-state-change': { 'state-engine': 'r', 'from-state': from, 'to-state': to } });
  const changes = [{ 'state-engine': 'e', 'from-state': 'backlog', 'to-state': 'build', timestamp: '2026-10-01T09:00:00Z', 'agent-dispatch-log': [] }, into(null, 'prepare'), into('prepare', 'review')];
  const features = [{ key: 'G-7', title: 'Reviewing', priority: 1, ...single({ 'harness-status': inBuild(['r', 'review']), 'state-changes': changes }) }];
  const runs = [{ id: 'run-7', project: 'p', 'state-engine': 'r', state: 'review', parent: { 'work-item': 'G-7', variation: 'A', 'state-engine': 'e', state: 'build' }, 'state-changes': [{ 'from-state': 'prepare', 'to-state': 'review' }] }];
  const s = groupedState(features, { workflows: reviewWorkflows, transientEngines: runs });
  assert.ok(blueDot(render(s, wide).find(l => l.includes('G-7')), 'G-7: Reviewing'));
  const open = press(s, 'return');
  const actions = actionsOf(lines(open, wide)).join('\n');
  assert.match(actions, /^Steer this ticket by hand\.\n\nChoose one:/);                         // no gate title (ASS-102 AC4)
  assert.ok(tabOf(lines(onTab(open, 'details'), wide)).some(l => /^Status\b.*Review/.test(l)));   // the gated step shows in Status instead
  assert.ok(panelOf(lines(open, wide)).includes('Needs you: Review — tab 1'));
  assert.match(actions, /Approved\s+→ Finished/);
  assert.match(actions, /Rejected\s+→ Rework/);                                                // prepare's return-to-state, from the run's history
  assert.deepEqual(press(open, 'return').decide, ['ticket:human-review', 'p', 'G-7', 'A', 'review', 'Approved', '']);
  assert.deepEqual(press(open, 'down', 'return').decide, ['ticket:human-review', 'p', 'G-7', 'A', 'review', 'Rejected', '']);
});

test('Gate when leaving states lists the steps of every engine the project\'s reaches, each indented under its parent step, saved as <engine>/<step> (ASS-67)', () => {
  const open = toGates(groupedState([grouped[0]]));
  const rows = actionsOf(lines(open, { ...wide, rows: 60 })).map(strip).filter(l => /\[[ x]\]/.test(l));
  assert.deepEqual(rows, ['  ▸ [ ] Backlog', '    [ ] Build', '      [ ] Draft', '      [ ] Generate Solution', '      [ ] Check', '        [ ] Inspect', '    [ ] Done']);
  assert.deepEqual(press(open, 'down', 'down', 'down', 'space', 'down', 'down', 'space', 'return').decide, ['ticket:set-gate-when-leaving-state', 'p', 'G-1', 'A', 'g/code', 'h/inspect']);
});

// ASS-245: on S and B, sub-flows drawn as boxes inside the steps that run them. Build's engine g gains
// Polish and a done exit, Finished; Check's engine h gains Magnify, which runs i: four levels.
const subflowWorkflows = groupedWorkflows.map(w => ({
  g: { ...w, steps: [...w.steps, { id: 'polish', name: 'Polish', sequence: 4, action: { type: 'prompt' } }, { id: 'finished', name: 'Finished', sequence: 5, 'is-done': true }] },
  h: { ...w, steps: [...w.steps, { id: 'magnify', name: 'Magnify', sequence: 2, action: { type: 'state-engine', engine: 'i' } }] },
}[w.name] ?? w)).concat({ name: 'i', steps: [{ id: 'zoom', name: 'Zoom', sequence: 1, action: { type: 'script' } }, { id: 'out', name: 'Zoomed Out', sequence: 2, 'is-done': true }] });
const atEachDepth = [
  { key: 'G-8', title: 'Waiting', priority: 8, ...single({ 'harness-status': inBuild() }) },                                           // Build, no sub-step yet
  grouped[0],                                                                                                                          // G-1 at Generate Solution
  grouped[2],                                                                                                                          // G-3 at Check › Inspect
  { key: 'G-9', title: 'Zooming', priority: 9, ...single({ 'harness-status': inBuild(['g', 'check'], ['h', 'magnify'], ['i', 'zoom']) }) },   // four levels down
  grouped[3],                                                                                                                          // G-4 at Done
];
const subflowState = (features = atEachDepth, extra = {}) => ({ ...groupedState(features, { workflows: subflowWorkflows, ...extra }), screen: 'S', flowchartView: 'tickets' });
const tall = { ...wide, rows: 80 };
// The box of the station or sub-flow named `name` on the floor (see flowchart.test.js): rows and columns.
function rectOf(out, name) {
  const r = out.findIndex(l => l.includes(`█ ${name} `));
  const col = out[r].indexOf(`█ ${name} `);
  const group = /┌─ \d+ $/.test(out[r].slice(0, col));
  const left = group ? out[r].lastIndexOf('┌', col) : col - 2;
  const top = group ? r : r - 1;
  return { top, left, right: out[top].indexOf('┐', left), bottom: out.findIndex((l, i) => i > top && l[left] === '└'), group };
}
const holds = (outer, inner) => outer.top < inner.top && inner.bottom < outer.bottom && outer.left < inner.left && inner.right < outer.right;
// The box's own lines, and the ticket lines under it — the ticket's key alone — to the first blank or border.
const boxOf = (out, r) => out.slice(r.top, r.bottom + 1).map(l => l.slice(r.left, r.right + 1));
function keysUnder(out, r) {
  const rest = out.slice(r.bottom + 1).map(l => l.slice(r.left, r.right + 1).replace('║', '').trim());
  return rest.slice(0, rest.findIndex(l => !l || /^[▼─┌│└]/.test(l)) >>> 0).map(l => l.split(':')[0]);
}

test('ASS-245 AC1: on S, a step running a sub-engine is a box titled with its name, holding its sub-engine\'s live steps as stations, nested four levels deep', () => {
  const out = lines(subflowState(), tall);
  const [build, check, magnify] = ['Build', 'Check', 'Magnify'].map(n => rectOf(out, n));
  assert.ok(build.group && check.group && magnify.group);
  assert.match(out[build.top].slice(build.left), /^┌─ 5 █ Build ─+ 4 tickets ─┐/);           // every ticket inside it, at any depth
  for (const n of ['Draft', 'Generate Solution', 'Polish']) assert.ok(holds(build, rectOf(out, n)), n);
  assert.ok(holds(build, check) && holds(check, rectOf(out, 'Inspect')) && holds(check, magnify) && holds(magnify, rectOf(out, 'Zoom')));
  assert.ok(!out.some(l => /Finished|Zoomed Out/.test(l)));                                 // a sub-engine's done exits are where its run ends: not drawn
  assert.match(out[magnify.top].slice(magnify.left), /^┌─ 2 █ Magnify ─+ 1 ticket ─┐/);
  for (const line of out) assert.ok(line.length <= tall.columns, line);
});

test('ASS-245 AC2: each ticket is listed once, under its deepest step, never at the stations above it', () => {
  const out = lines(subflowState(), tall);
  const under = n => keysUnder(out, rectOf(out, n));
  assert.deepEqual(under('Build'), ['G-8']);                                                  // in Build, at no sub-step yet
  assert.deepEqual(under('Generate Solution'), ['G-1']);
  assert.deepEqual(under('Inspect'), ['G-3']);
  assert.deepEqual(under('Zoom'), ['G-9']);
  assert.deepEqual(under('Done'), ['G-4']);
  for (const n of ['Check', 'Magnify', 'Draft', 'Polish']) assert.deepEqual(under(n), [], n);
  for (const k of ['G-1', 'G-3', 'G-4', 'G-8', 'G-9']) assert.equal(out.filter(l => l.includes(`${k}: `)).length, 1, k);
});

test('ASS-245 AC1: a station inside a sub-flow shows a 🤖 per live assignment and a 💻 per variation at a script step, as a main station does', () => {
  const out = lines(subflowState(atEachDepth, { assignments: [assignment('Daredevil', 'G-1', null, 'p'), assignment('Elektra', 'G-8', null, 'p')] }), tall);
  assert.equal(boxOf(out, rectOf(out, 'Generate Solution')).join('').split('🤖').length - 1, 1);
  assert.equal(boxOf(out, rectOf(out, 'Zoom')).join('').split('💻').length - 1, 1);
  assert.ok(boxOf(out, rectOf(out, 'Build'))[1].includes('🤖'));                              // G-8's, on Build's own line
  assert.ok(!boxOf(out, rectOf(out, 'Inspect')).join('').match(/🤖|💻/));
  const past = lines({ ...subflowState(), day: '2026-09-29', projects: [{ ...subflowState().projects[0], days: { '2026-09-29': { ...sprint, features: atEachDepth, bugs: [], spikes: [] } } }] }, tall);
  assert.ok(!past.some(l => l.includes('💻')));                                                // none on a past day
});

test('ASS-245 AC3: a sub-flow is open only with a ticket inside it, a closed one a normal station with its tickets; g opens every one, and again closes the empty ones', () => {
  const st = subflowState([grouped[0], grouped[3]]);                                          // G-1 at Generate Solution, G-4 at Done
  const out = lines(st, tall);
  assert.ok(rectOf(out, 'Build').group);
  const check = rectOf(out, 'Check');
  assert.ok(!check.group);
  assert.equal(check.right - check.left + 1, 32);
  assert.ok(!out.some(l => /Inspect|Magnify|Zoom/.test(l)));
  assert.ok(lines(st, tall).some(l => l.includes('g open every sub-flow')));
  const open = handleKey(st, key('g', { sequence: 'g' }), tall);
  const all = lines(open, tall);
  assert.ok(rectOf(all, 'Check').group && rectOf(all, 'Magnify').group && holds(rectOf(all, 'Magnify'), rectOf(all, 'Zoom')));
  assert.ok(all.some(l => l.includes('g close the empty sub-flows')));
  assert.ok(!rectOf(lines(handleKey(open, key('g', { sequence: 'g' }), tall), tall), 'Check').group);
  const none = lines(subflowState([grouped[3]]), tall);                                       // nothing in Build: closed
  assert.ok(!rectOf(none, 'Build').group && !none.some(l => l.includes('Draft')));
  assert.match(none.find(l => l.includes('┌─ 5 ')), /┌─ 5 ─+┐/);
});

test('ASS-245 AC3: on a narrow screen a sub-flow\'s stations wrap onto further rows inside its box, never past the screen\'s edge', () => {
  const narrow = { ...tall, columns: 100 };
  const out = lines(subflowState(), narrow);
  for (const line of out) assert.ok(line.length <= 100, line);
  const build = rectOf(out, 'Build');
  for (const n of ['Draft', 'Generate Solution', 'Check', 'Inspect', 'Magnify', 'Zoom', 'Polish']) assert.ok(holds(build, rectOf(out, n)), n);
  assert.equal(rectOf(out, 'Draft').top, rectOf(out, 'Generate Solution').top);
  assert.ok(rectOf(out, 'Check').top > rectOf(out, 'Generate Solution').top);
  assert.ok(rectOf(out, 'Polish').top > rectOf(out, 'Check').top);
  assert.deepEqual(keysUnder(out, rectOf(out, 'Zoom')), ['G-9']);
});

test('ASS-245 AC5: the shipped three-level harness-development-v2 draws Test › Local Testing › Take Screenshots as nested boxes, the ticket at Take Screenshots', () => {
  const shipped = ['harness-development-v2', 'v2-test', 'v2-local-testing', 'v2-steps-to-test'].map(name => {
    const loaded = JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'), 'utf8'));
    return { name, steps: loaded.steps.toSorted((a, b) => a.sequence - b.sequence), lists: {} };
  });
  const at = { state: 'test', 'state-engine': 'harness-development-v2', 'sub-status': { state: 'local-testing', 'state-engine': 'v2-test', 'sub-status': { state: 'take-screenshots', 'state-engine': 'v2-local-testing' } } };
  const st = { ...initialState({ projects: [{ id: 'h', name: 'H', stateEngine: 'harness-development-v2', sprint: { ...sprint, features: [{ key: 'V-1', title: 'Deep', priority: 1, ...single({ 'harness-status': at }) }], bugs: [], spikes: [] } }], workflows: shipped }), screen: 'S', flowchartView: 'tickets' };
  const out = lines(st, { ...wide, columns: 240, rows: 90 });
  const [test_, local] = [rectOf(out, 'Test'), rectOf(out, 'Local Testing')];
  assert.ok(test_.group && local.group && holds(test_, local) && holds(local, rectOf(out, 'Take Screenshots')));
  assert.ok(!rectOf(out, 'Steps to Test').group && holds(test_, rectOf(out, 'Steps to Test')));   // no ticket inside: closed
  assert.deepEqual(keysUnder(out, rectOf(out, 'Take Screenshots')), ['V-1']);
  assert.ok(!rectOf(out, 'Build').group);
});

test('ASS-245 AC4: no dot strip and no › headings: the boxes say where each ticket is', () => {
  for (const st of [subflowState(), handleKey(subflowState(), key('g', { sequence: 'g' }), tall)]) {
    const out = lines(st, tall);
    assert.ok(!out.some(l => / › /.test(l)));
    assert.ok(!out.some(l => /│ [·\d]( [·\d])+ +│/.test(l)));
    assert.ok(!out.some(l => l.includes('not started')));
  }
});

test('ASS-245: on a past day, the boxes open and the tickets sit where the day\'s snapshot had them', () => {
  const st = subflowState();
  const project = st.projects[0];
  const out = lines({ ...st, day: '2026-09-29', projects: [{ ...project, days: { '2026-09-29': { ...project.sprint, features: [grouped[1]] } } }] }, tall);   // G-2 at Draft
  assert.deepEqual(keysUnder(out, rectOf(out, 'Draft')), ['G-2']);
  assert.ok(!rectOf(out, 'Check').group);
});

test('ASS-245: the run-time metrics view keeps the boxes, its notes under the top-level stations, none under the sub-flows\' own', () => {
  const out = lines({ ...subflowState(), flowchartView: 'metrics' }, tall);
  assert.ok(rectOf(out, 'Build').group);
  const build = rectOf(out, 'Build');
  assert.match(out[build.bottom + 1].slice(build.left, build.right + 1).replace('║', '').trim().replace(/ +/g, ' '), /^tickets visited 4$/);
  assert.deepEqual(keysUnder(out, rectOf(out, 'Generate Solution')), []);
  assert.ok(!out.some(l => l.includes('G-1')));
});

test('the flowchart lists the same stats beside each ticket', () => {
  const out = lines({ ...historyState, screen: 'S', flowchartView: 'tickets' }, wide);
  assert.ok(out.some(l => /H-1: Back again \(2, 3\)/.test(l)));
  assert.ok(out.some(l => /H-2: Just in \(1, 0\)/.test(l)));
});

test('Status is the step name from the project\'s execution state engine; an unknown id shows as is', () => {
  const tickets = [{ key: 'ABC-7', title: 'T', ...single({ 'harness-status': hs('code-review') }) }, { key: 'ABC-8', title: 'U', ...single({ 'harness-status': hs('mystery') }) }];
  const project = { name: 'P', stateEngine: 'example-development', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } };
  const out = lines(initialState({ projects: [project], workflows: [engine, { name: 'other', steps: [{ id: 'code-review', name: 'Wrong' }] }] }), wide);
  assert.match(out.find(l => l.includes('ABC-7')), /ABC-7: T +— +Code Review +/);
  assert.match(out.find(l => l.includes('ABC-8')), /ABC-8: U +— +mystery +/);
  const noEngine = lines(initialState({ projects: [{ ...project, stateEngine: undefined }], workflows: [engine] }), wide);
  assert.match(noEngine.find(l => l.includes('ABC-7')), /ABC-7: T +— +code-review +/);
});

test('warning-indicator adds no box: only the status square leads the ticket', () => {
  const warned = { name: 'e', steps: [{ id: 'stuck', name: 'Blocked for Human', sequence: 0, 'warning-indicator': true }, { id: 'ok', name: 'Backlog', sequence: 1 }] };
  const tickets = [{ key: 'ABC-7', title: 'T', ...single({ 'harness-status': hs('stuck') }) }, { key: 'ABC-8', title: 'U', ...single({ 'harness-status': hs('ok') }) }];
  const project = { name: 'P', stateEngine: 'e', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } };
  const out = render(initialState({ projects: [project], workflows: [warned] }), wide).map(unhighlight);
  assert.match(out.find(l => l.includes('ABC-7')), /^│ \x1b\[(?:38;2;[\d;]+|32)m▮\x1b\[0m✦ {4} ABC-7: T /);
  assert.ok(!out.some(l => l.includes('\x1b[31m██')));
  assert.match(strip(out.find(l => l.includes('ABC-7'))), / Blocked for Human {2,}/);
  assert.match(out.find(l => l.includes('ABC-8')), /^│ \x1b\[(?:38;2;[\d;]+|32)m▮\x1b\[0m✦ {4} ABC-8: U /);
});

test('Dev adds the automated test tally beneath the circles', () => {
  const tests = { 'number-of-relevant-automated-tests': 83, 'number-of-passing-relevant-automated-tests': 37 };
  const criteria = [{ 'dev-status': 'Passed', 'testing-status': 'Passed' }];
  const tickets = [
    { key: 'ABC-7', title: 'T', priority: 1, ...single({ 'acceptance-criteria': criteria, 'local-testing': tests }) },
    { key: 'ABC-8', title: 'U', priority: 2, ...single({ 'local-testing': tests }) },
    { key: 'ABC-9', title: 'V', priority: 3, ...single({ 'acceptance-criteria': criteria }) },
  ];
  const out = render(initialState({ projects: [{ name: 'P', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } }] }), wide).map(unhighlight);
  const row = out.findIndex(l => l.includes('ABC-7'));
  assert.ok(out[row].includes(' \x1b[32m●\x1b[0m '));
  assert.ok(out[row + 1].includes(' 37/83 automated tests  '));
  const column = (line, text) => visible(strip(line).slice(0, strip(line).indexOf(text)));
  assert.equal(column(out[row], '●'), column(out[row + 1], '37/83'));
  assert.ok(out[row + 3].includes('ABC-8') && out[row + 3].includes(' 37/83 automated tests  '));
  assert.ok(out[row + 6].includes('ABC-9') && !out[row + 7].includes('automated tests'));
});

test('Dev shows no tally — never undefined/undefined — when local-testing has no counts: empty as ticket:sync makes it, or a verdict alone (ASS-45)', () => {
  const verdict = { 'is-approved': true, summary: 'All green', timestamp: '2026-10-14T10:00:00Z' };
  const criteria = [{ 'dev-status': 'Passed', 'testing-status': 'Passed' }];
  const tickets = [
    { key: 'ABC-7', title: 'T', priority: 1, ...single({ 'local-testing': {} }) },
    { key: 'ABC-8', title: 'U', priority: 2, ...single({ 'acceptance-criteria': criteria, 'local-testing': verdict }) },
    { key: 'ABC-9', title: 'V', priority: 3, ...single({ 'local-testing': { ...verdict, 'number-of-relevant-automated-tests': 83 } }) },
    { key: 'ABC-10', title: 'W', priority: 4, ...single({ 'acceptance-criteria': criteria }) },   // no local-testing at all
  ];
  const out = render(initialState({ projects: [{ name: 'P', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } }] }), wide).map(unhighlight);
  assert.ok(!out.some(l => l.includes('undefined')));
  assert.ok(!out.some(l => l.includes('automated tests')));
  const dash = out.find(l => l.includes('ABC-7'));
  assert.match(strip(dash), /ABC-7: T .* — /);   // no criteria, no counts: the empty value
  assert.ok(out.find(l => l.includes('ABC-8')).includes(' \x1b[32m●\x1b[0m '));
  assert.ok(!strip(out.find(l => l.includes('ABC-9'))).includes('/83'));   // one count alone is not a tally
  assert.ok(out.find(l => l.includes('ABC-10')).includes(' \x1b[32m●\x1b[0m '));   // local-testing missing: circles alone
});

test('a square left of each ticket name is shaded like its status in the progress bar', () => {
  const steps = [{ id: 'early', name: 'Early', sequence: 2 }, { id: 'done', name: 'Done', sequence: 10 }];
  const tickets = [
    { key: 'ABC-7', title: 'T', priority: 1, ...single({ 'harness-status': hs('done') }) },
    { key: 'ABC-8', title: 'U', priority: 2, ...single({ 'harness-status': hs('early') }) },
    { key: 'ABC-9', title: 'V', priority: 3, ...single({ 'harness-status': hs('mystery') }) },
  ];
  const project = { name: 'P', stateEngine: 'e', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } };
  const out = render(initialState({ projects: [project], workflows: [{ name: 'e', steps }] }), { ...wide, rows: 80 }).map(unhighlight);
  const bar = out.find(l => l.startsWith('│') && l.includes('38;2'));
  const barShades = [...bar.matchAll(/(\x1b\[(?:38;2;[\d;]+|32)m)█/g)].map(m => m[1]);   // early, then done
  const square = key => out.find(l => l.includes(key)).match(/^│ (\x1b\[(?:38;2;[\d;]+|32)m)▮\x1b\[0m✦ {4} /)?.[1];
  assert.equal(square('ABC-7'), barShades.at(-1));
  assert.equal(square('ABC-8'), barShades[0]);
  assert.notEqual(square('ABC-7'), square('ABC-8'));
  assert.ok(out.find(l => l.includes('ABC-9')).startsWith(`│ ${cols({ step: ' ' })}ABC-9: V `));   // no square, names still aligned
});

test('a step color from the state engine paints both its run in the bar and its square', () => {
  const steps = [{ id: 'stuck', name: 'Blocked for Human', sequence: 0, color: '#ff0000' }, { id: 'done', name: 'Done', sequence: 10 }];
  const tickets = [{ key: 'ABC-7', title: 'T', priority: 1, ...single({ 'harness-status': hs('stuck') }) }];
  const project = { name: 'P', stateEngine: 'e', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } };
  const out = render(initialState({ projects: [project], workflows: [{ name: 'e', steps }] }), { ...wide, rows: 80 }).map(unhighlight);
  assert.ok(out.find(l => l.startsWith('│') && l.includes('38;2')).includes('\x1b[38;2;255;0;0m█'));
  assert.match(out.find(l => l.includes('ABC-7')), /^│ \x1b\[38;2;255;0;0m▮\x1b\[0m/);
});

test('a ticket at a human gate shows a blue ● before its title and no red text; other tickets no ● (ASS-242)', () => {
  const steps = [{ id: 'gate', name: 'Payment Gate', sequence: 5, action: { type: 'human' } }, { id: 'work', name: 'Working', sequence: 6, action: { type: 'prompt' } }];
  const gated = {
    key: 'ABC-7', title: 'Gated', priority: 71, points: 72, 'ticket-system-assignment': 'Gate Keeper',
    ...single({
      'harness-status': hs('gate'), 'ai-feedback-short': 'GateHealth',
      build: { branch: 'change/gated', worktree: 'wt-gated' },
      'acceptance-criteria': [{ 'dev-status': 'Passed', 'testing-status': 'Failed' }],
      'local-testing': { 'number-of-passing-relevant-automated-tests': 7, 'number-of-relevant-automated-tests': 9 },
      'merge-request': [{ key: '!777', 'build-status': 'Running', url: 'http://mr/777' }],
    }),
  };
  const tickets = [gated, { key: 'ABC-8', title: 'Busy', priority: 2, ...single({ 'harness-status': hs('work') }) }];
  const project = { id: 'p', name: 'P', stateEngine: 'e', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } };
  const s = initialState({ projects: [project], workflows: [{ name: 'e', steps }], assignments: [assignment('Gatekeeper', 'ABC-7', null, 'p')] });
  const row = (key, iso = '2026-10-01T16:04:00Z') => render(s, { ...wide, rows: 80, now: new Date(iso) }).find(l => l.includes(key));
  assert.ok(blueDot(row('ABC-7'), 'ABC-7: Gated'));
  for (const v of ['ABC-7: Gated', '71', 'Payment Gate', '72', 'Gate Keeper', 'GateHealth', 'Gatekeeper']) assert.ok(row('ABC-7').includes(v) && !row('ABC-7').includes(`\x1b[31m${v}`), `${v} not red`);
  assert.equal(row('ABC-7', '2026-10-01T16:04:01Z'), row('ABC-7'));   // steady: no flashing
  assert.ok(!/[●⦿]/.test(row('ABC-8')));                            // not at a gate
});

test('the progress bar runs left to right in the reverse of the grid order, ties included', () => {
  const steps = [
    { id: 'human', name: 'Blocked for Human', sequence: 0, color: '#ff0000' },
    { id: 'blocked', name: 'Blocked', sequence: 0, color: '#ffd700' },
    { id: 'done', name: 'Done', sequence: 10 },
  ];
  const tickets = [
    { key: 'ABC-7', title: 'T', priority: 30, ...single({ 'harness-status': hs('human') }) },
    { key: 'ABC-8', title: 'U', priority: 29, ...single({ 'harness-status': hs('blocked') }) },
    { key: 'ABC-9', title: 'V', priority: 1, ...single({ 'harness-status': hs('done') }) },
  ];
  const project = { name: 'P', stateEngine: 'e', sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } };
  const out = render(initialState({ projects: [project], workflows: [{ name: 'e', steps }] }), { ...wide, rows: 80 }).map(unhighlight);
  const grid = out.filter(l => /ABC-\d/.test(l)).map(l => l.match(/^│ (\x1b\[(?:38;2;[\d;]+|32)m)/)[1]);
  const bar = [...out.find(l => l.startsWith('│') && l.includes('38;2')).matchAll(/(\x1b\[(?:38;2;[\d;]+|32)m)█/g)].map(m => m[1]);
  assert.deepEqual(bar, grid.toReversed());
  assert.equal(bar[0], '\x1b[38;2;255;0;0m');                               // Blocked for Human far left
});

test('MR build statuses are color coded', () => {
  const mrs = ['Merged', 'Running', 'Failed', 'Passed', 'Queued'].map((status, i) => ({ key: `!${i}`, 'build-status': status, url: `http://mr/${i}` }));
  const one = { name: 'P', sprint: { ...sprint, features: [{ key: 'ABC-9', title: 'T', ...single({ 'merge-request': mrs }) }], bugs: [] } };
  const out = render(initialState({ projects: [one] }), wide);
  const colorOf = status => out.find(l => l.includes(`\x1b\\${status}\x1b]8`)).match(new RegExp(`(\x1b\\[[0-9;]*m)?\x1b\\]8;;http://mr/\\d\x1b\\\\${status}`))[1];
  assert.equal(colorOf('Merged'), '\x1b[90m');
  assert.equal(colorOf('Running'), '\x1b[38;2;255;215;0m');
  assert.equal(colorOf('Failed'), '\x1b[31m');
  assert.equal(colorOf('Passed'), '\x1b[32m');
  assert.equal(colorOf('Queued'), undefined);
});

// Merge requests of every status (ASS-80): one planned (no key, link or build status yet), and an open, a merged and a closed one.
const plannedMr = (id, extra = {}) => ({ id, repository: 'https://gitlab.com/g/app', branch: `change/ABC-9-${id}`, contents: `part ${id}`, 'depends-on': [], status: 'Not Created', key: null, url: null, 'build-status': null, ...extra });
const everyStatus = [
  plannedMr(1),
  { id: 2, key: '!2', status: 'Open', 'build-status': 'Running', url: 'http://mr/2' },
  { id: 3, key: '!3', status: 'Merged', 'build-status': 'Merged', url: 'http://mr/3' },
  { id: 4, key: '!4', status: 'Closed', 'build-status': 'Failed', url: 'http://mr/4' },
];

test('the MR column marks a planned merge request (ASS-80) as planned, unlinked and without a build status; one no longer open shows its status', () => {
  const one = { name: 'P', sprint: { ...sprint, features: [{ key: 'ABC-9', title: 'T', ...single({ 'merge-request': everyStatus }) }], bugs: [] } };
  const raw = render(initialState({ projects: [one] }), wide);
  const text = raw.map(strip);
  assert.ok(text.some(l => /MR 1 planned/.test(l)), text.join('\n'));
  assert.ok(!raw.some(l => /\x1b\]8;;[^\x1b]*\x1b\\MR 1/.test(l)));   // no link
  assert.ok(text.some(l => /!2 +Running/.test(l)));
  assert.ok(text.some(l => /!3 +Merged/.test(l)));
  assert.ok(text.some(l => /!4 +Closed/.test(l)) && !text.some(l => /!4 +Failed/.test(l)));
  assert.match(raw.find(l => l.includes('Closed')), /\x1b\[90m\x1b\]8;;http:\/\/mr\/4\x1b\\Closed/);   // gray, linked
});

// One merge-request:create marked Closed without opening (ASS-81): its branch had no changes against its base, so it has no key, link or build status.
const unopenedMr = id => plannedMr(id, { status: 'Closed' });

test('the MR column shows a merge request closed without being opened (ASS-81) as not opened, unlinked, rather than failing to draw', () => {
  const one = { name: 'P', sprint: { ...sprint, features: [{ key: 'ABC-9', title: 'T', ...single({ 'merge-request': [unopenedMr(1), everyStatus[1]] }) }], bugs: [] } };
  const raw = render(initialState({ projects: [one] }), wide);
  const text = raw.map(strip);
  assert.ok(text.some(l => /MR 1 closed, not opened/.test(l)), text.join('\n'));
  assert.ok(!raw.some(l => /\x1b\]8;;[^\x1b]*\x1b\\MR 1/.test(l)));   // no link
  assert.ok(text.some(l => /!2 +Running/.test(l)));
});

test('a sprint without tickets says so', () => {
  const empty = initialState({ projects: [{ name: 'P', sprint: { number: 1, start: '2026-10-01', end: '2026-10-01' } }] });
  assert.ok(lines(empty, wide).some(l => /^│ No tickets in this sprint +│$/.test(l)));
});

test('f shows the project\'s state engine as a factory floor, with the tickets at each station on the day on show', () => {
  const floor = st => lines({ ...st, screen: 'S', flowchartView: 'tickets' }, wide);
  const out = floor(dayState);
  assert.ok(out.some(l => /┌─ 1 ─+ 1 ticket ─┐/.test(l)));        // ABC-2 in Backlog
  assert.ok(out.some(l => /┌─ 13 ─+ 1 ticket ─┐/.test(l)));       // ABC-1 in Code Review
  assert.ok(out.some(l => /│ █ Code Review +│/.test(l)));
  assert.ok(out.some(l => / {3}ABC-1: New Feature/.test(l)));       // listed under its station
  assert.ok(out.some(l => / {3}ABC-2: New Bug/.test(l)));
  const past = floor(press(dayState, 'tab', 'left', 'left'));        // 9/29: ABC-1 back in Backlog
  assert.ok(past.some(l => /┌─ 13 ─+┐/.test(l)));
  assert.ok(past.some(l => /┌─ 1 ─+ 1 ticket ─┐/.test(l)));
});

test('the flowchart opens on run-time metrics, with a choice of what each station shows at the top; tab reaches it and ←/→ switch to its tickets and back', () => {
  const opened = handleKey(dayState, key('S'));
  let out = lines(opened, wide);
  assert.ok(out.some(l => /Show: +Tickets +Run-time metrics *$/.test(l)));
  assert.ok(out.some(l => /tickets visited/.test(l)));
  assert.ok(!out.some(l => l.includes('ABC-1: New Feature')));
  const focused = press(opened, 'tab', 'tab');
  assert.equal(focused.focus, 'flowchart');
  assert.ok(render(focused, wide).some(l => l.includes('\x1b[7m Run-time metrics \x1b[0m')));
  const tickets = press(focused, 'left');
  out = lines(tickets, wide);
  assert.ok(out.some(l => / {3}ABC-1: New Feature/.test(l)));
  assert.ok(!out.some(l => /tickets visited/.test(l)));
  assert.ok(render(tickets, wide).some(l => l.includes('\x1b[7m Tickets \x1b[0m')));
  assert.ok(!lines(press(tickets, 'right'), wide).some(l => l.includes('ABC-1: New Feature')));
  assert.ok(lines(handleKey(press(tickets, 's'), shifted('s'), wide), wide).some(l => / {3}ABC-1: New Feature/.test(l)));   // the choice stays while elsewhere
});

test('run-time metrics: under each station, its finished visits from every ticket\'s state-changes and their averages; cost and tokens only for steps that prompt an agent', () => {
  const done = (timestamp, completed, cost, tokens) => ({ 'dispatched-to': 'Spock', timestamp, 'completed-timestamp': completed, 'cost-usd': cost, tokens });
  const changes = [
    { 'from-state': 'committed', 'to-state': 'code-review', timestamp: '2026-09-29T10:00:00Z', 'agent-dispatch-log': [done('2026-09-29T10:00:00Z', '2026-09-29T10:06:30Z', 1.8234, { input: 200, output: 9000, 'cache-read': 390000, 'cache-write': 32000 })] },
    { 'from-state': 'code-review', 'to-state': 'backlog', timestamp: '2026-09-29T12:14:00Z', 'agent-dispatch-log': [] },
    { 'from-state': 'backlog', 'to-state': 'code-review', timestamp: '2026-09-30T09:00:00Z', 'agent-dispatch-log': [] },
  ];
  const prompted = { ...engine, steps: [engine.steps[0], { ...engine.steps[1], action: { type: 'prompt', prompt: 'code-review' } }, { id: 'done', name: 'Done', sequence: 20 }] };
  const tickets = [{ key: 'M-1', title: 'Measured', ...single({ 'harness-status': hs('code-review'), 'state-changes': changes }) }];
  const st = initialState({ projects: [{ ...projects[0], sprint: { ...sprint, features: tickets, bugs: [], spikes: [] } }], workflows: [prompted] });
  const out = lines({ ...st, screen: 'S', flowchartView: 'metrics' }, { ...wide, columns: 60, rows: 80 });   // a station a row
  // A station's k-th line beneath it, without the belt running down beside it.
  const under = (top, k) => out[out.findIndex(l => l.includes(top)) + 4 + k].slice(1, -1).replace('║', '').trim().replace(/ +/g, ' ');   // inside the flowchart's box
  assert.ok(!out.some(l => l.includes('metrics are per ticket')));
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(k => under('┌─ 13 ', k)),
    ['tickets visited 1', 'visits per ticket 2', '↳ subset that visited 1', 'in state per visit 2h 14m', 'agent time per visit 6m 30s', 'dispatches per visit 1', 'cost per dispatch $1.82', 'tokens per dispatch 41k', 'cache reads per dispatch 390k']);
  assert.deepEqual([0, 1, 2, 3, 4].map(k => under('┌─ 1 ', k)), ['tickets visited 1', 'visits per ticket 1', '↳ subset that visited 1', 'in state per visit 20h 46m', '▼']);   // no action, so no spend; then the turn
  assert.deepEqual([0, 1, 2].map(k => under('┌─ 20 ', k)), ['tickets visited 0', 'visits per ticket —', 'no finished visits']);
});

test('on the flowchart, a ticket with a url links to it; one without is plain', () => {
  const raw = render({ ...dayState, screen: 'S', flowchartView: 'tickets' }, wide);
  assert.ok(raw.some(l => l.includes('\x1b]8;;http://t/ABC-1\x1b\\ABC-1: New Feature\x1b]8;;\x1b\\')));
  assert.ok(raw.some(l => l.includes('   ABC-2: New Bug')));          // no link opens right before it
});

// Questions on the sprint's tickets (ABC-1, ABC-2), on one outside it, and one already accepted.
const question = (text, ticket, fields = {}) => ({
  question: text, 'recomended-answer': `Recommended for ${text}`, answer: '', 'why-asked': `Why ${text}`, 'why-this-answer': '', scope: 'project',
  'asked-on-ticket': ticket, 'asked-time-stamp': '2026-09-22T14:05:12Z', 'answered-time-stamp': '', status: 'Asked',
  'ai-feedback-if-not-accepted': '', source: 'global', index: 0, ...fields,
});
const questions = [
  question('Bluebook or ALWD?', 'abc-1'),
  question('Import format?', 'abc-99', { source: 'abc-99', scope: 'ticket' }),
  question('Feature flag?', 'ABC-2', { index: 1, status: 'Answered', answer: 'Yes, flag it.', 'why-this-answer': 'Everyone sees it.' }),
  question('Staging database?', 'abc-1', { index: 2, status: 'Answer Accepted', answer: 'No.' }),
];
const asking = initialState({ projects: [{ ...projects[0], questions }, projects[1]], workflows: [engine] });
// ABC-1's screen with its questions focused: the questions screen is gone, a ticket's questions are answered there (ASS-103).
const onQuestions = { ...asking, ticket: { key: 'ABC-1', variation: 'A' }, ticketTab: 'questions' };
const typing = (s, text) => [...text].reduce((st, ch) => handleKey(st, { name: ch === ' ' ? 'space' : ch, sequence: ch }, wide), s);

test('ASS-103 AC4: a ticket screen lists the global questions asked on it, any case, beside its own, each global one marked; each is answered in its own file', () => {
  const mixed = [
    question('Own question?', 'ABC-1', { source: 'ABC-1', index: 0 }),
    question('Global question?', 'abc-1', { source: 'global', index: 7 }),
    question('Elsewhere?', 'abc-2', { source: 'global', index: 8 }),
  ];
  const open = { ...initialState({ projects: [{ ...projects[0], questions: mixed }], workflows: [engine] }), ticket: { key: 'ABC-1', variation: 'A' }, ticketTab: 'questions' };
  const out = lines(open, wide);
  const row = text => out.find(l => l.includes(text)) ?? '';
  assert.ok(row('Own question?') && !row('Own question?').includes('(global)'), 'its own, unmarked');
  assert.ok(row('(global) Global question?'), 'the global one asked on it, marked');
  assert.ok(!out.some(l => l.includes('Elsewhere?')), 'not one asked on another ticket');
  const answer = s => press(typing(press(s, 'return'), 'Yes'), 'return').submit;
  assert.deepEqual([answer(open).source, answer(open).index], ['ABC-1', 0]);
  assert.deepEqual([answer(press(open, 'down')).source, answer(press(open, 'down')).index], ['global', 7]);
});

test('a rejected answer\'s details on the ticket screen say why it was rejected; others have no such line', () => {
  const rejected = question('Which login?', 'abc-1', { index: 3, status: 'Answer Rejected', answer: 'Mine.', 'ai-feedback-if-not-accepted': 'Which of your two accounts?' });
  const s = { ...onQuestions, projects: [{ ...projects[0], questions: [rejected] }] };
  assert.ok(lines(s, wide).some(l => l.includes('Why rejected') && l.includes('Which of your two accounts?')));
  assert.ok(!lines(onQuestions, wide).some(l => l.includes('Why rejected')));
});

test('enter opens the answer form on the answer, starting from the question\'s answer, why-this-answer and scope', () => {
  assert.deepEqual(press(onQuestions, 'return').draft, { field: 'answer', answer: '', 'why-this-answer': '', scope: 'project' });
  assert.deepEqual(press(onQuestions, 'down', 'return').draft, { field: 'answer', answer: 'No.', 'why-this-answer': '', scope: 'project' });
});

test('in the form, typing takes every key as text into the field being edited; backspace deletes; escape gives up', () => {
  const typed = typing(press(onQuestions, 'return'), 'q d space');
  assert.equal(typed.draft.answer, 'q d space');
  assert.deepEqual([typed.screen, typed.pauses, typed.ticketTab], ['s', {}, 'questions']);   // no screen change, no pause
  assert.equal(handleKey(typed, key('backspace'), wide).draft.answer, 'q d spac');
  assert.ok(lines(typed, wide).some(l => l.includes('q d space█')));
  const gaveUp = handleKey(typed, key('escape'), wide);
  assert.deepEqual([gaveUp.draft, gaveUp.screen, gaveUp.submit, gaveUp.ticket?.key], [null, 's', null, 'ABC-1']);
});

test('tab moves through the form\'s fields, answer, why this answer, scope and round again; shift-tab goes back', () => {
  const back = s => handleKey(s, key('tab', { shift: true }), wide);
  const form = press(onQuestions, 'return');
  const why = typing(press(form, 'tab'), 'Courts');
  assert.deepEqual([why.draft.field, why.draft['why-this-answer'], why.draft.answer], ['why-this-answer', 'Courts', '']);
  const scope = handleKey(typing(press(why, 'tab'), 'X'), key('backspace'), wide);
  assert.deepEqual([scope.draft.field, scope.draft.scope], ['scope', 'project']);
  assert.equal(press(scope, 'tab').draft.field, 'answer');
  assert.equal(back(form).draft.field, 'scope');
  assert.equal(back(why).draft.field, 'answer');
  assert.ok(render(why, wide).some(l => l.includes('\x1b[7mWhy this answer') && l.includes('Courts█')));   // the field being edited
  assert.ok(lines(why, wide).some(l => l.includes('type   tab next field   enter saves   esc cancels')));
});

test('enter saves a non-blank answer as a request for the agent-cli, naming the file and place of the question', () => {
  const typed = typing(press(typing(press(typing(press(onQuestions, 'return'), '  CSV only  '), 'tab'), ' One format. '), 'tab'), '-wide');
  const saved = press(typed, 'return');
  assert.deepEqual(saved.submit, { project: 'example', source: 'global', index: 0, answer: 'CSV only', 'why-this-answer': 'One format.', scope: 'project-wide' });
  assert.equal(saved.draft, null);
  const blank = typing(press(onQuestions, 'return'), '   ');
  assert.equal(press(blank, 'return').submit, null);
  assert.equal(press(blank, 'return').draft.answer, '   ');
});

test('a failed save shows its message on the ticket screen', () => {
  assert.ok(lines({ ...onQuestions, message: 'update_json: timed out waiting for the lock' }, wide).some(l => l.includes('timed out waiting for the lock')));
});

test('c shows control\'s output in a box the width of the screen, each line with the time it came; error output in red', () => {
  const at = sec => new Date(`2026-10-06T14:31:${sec}Z`);
  const controlLog = [
    { text: 'Hello world!', stream: 'stdout', at: at('05') },
    { text: 'something broke', stream: 'stderr', at: at('06') },
    { text: 'Hello world!', stream: 'stdout', at: at('07') },
  ];
  const s = { ...state, screen: 'c', controlLog, controlLogFile: '/home/me/.harness/logs/control.log' };
  const out = lines(s, wide);
  const top = out.findIndex(l => l.startsWith('┌'));
  assert.match(out[top], /^┌─ control \(times UTC\) ─+┐$/);
  assert.equal(out[top].length, wide.columns);
  assert.deepEqual(out.slice(top + 1, top + 4).map(l => l.trimEnd()), [
    `│ 14:31:05  Hello world!${' '.repeat(wide.columns - 25)}│`,
    `│ 14:31:06  something broke${' '.repeat(wide.columns - 28)}│`,
    `│ 14:31:07  Hello world!${' '.repeat(wide.columns - 25)}│`,
  ]);
  assert.match(out[top + 4], /^│ +│$/);                                     // the box fills its space, blank below the output
  assert.ok(render(s, wide).some(l => l.includes('\x1b[31msomething broke')));
  const bottom = out.findIndex((l, i) => i > top && l.startsWith('└'));
  assert.equal(out[bottom + 1], 'log: /home/me/.harness/logs/control.log');
  assert.ok(render(s, wide)[render(s, wide).findIndex(l => l.startsWith('log: '))].includes('\x1b]8;;file:///home/me/.harness/logs/control.log'));
  assert.match(out[bottom + 2], /^( *$| +┌| +press \?)/);                   // then the platform boxes, or the bottom line
});

test('before control prints, its box says so', () => {
  const out = lines({ ...state, screen: 'c', controlLogFile: '/tmp/control.log' }, wide);
  assert.ok(out.some(l => /^│ control has not printed anything yet +│$/.test(l)));
  assert.ok(out.includes('log: /tmp/control.log'));
});

test('control\'s output keeps to its box, showing the newest lines; long lines are cut', () => {
  const controlLog = Array.from({ length: 200 }, (_, i) => ({ text: `line ${i}`, stream: 'stdout', at: new Date('2026-10-06T14:31:05Z') }));
  controlLog.push({ text: 'x'.repeat(400), stream: 'stdout', at: new Date('2026-10-06T14:31:06Z') });
  const out = lines({ ...state, screen: 'c', controlLog, controlLogFile: '/tmp/control.log' }, wide);
  assert.equal(out.length, wide.rows);
  const inside = out.slice(out.findIndex(l => l.startsWith('┌')) + 1, out.findIndex(l => l.startsWith('└')));
  assert.ok(inside.some(l => l.includes('line 199')));
  assert.ok(!inside.some(l => l.includes('line 0 ')));
  assert.match(inside.at(-1), /x… │$/);
  assert.ok(inside.every(l => l.length === wide.columns));
  assert.match(out.at(-1), /press \? for menu/);
});

// The sub-flows screen (ASS-7): every engine the project's execution engine reaches, a box each.
const healing = { name: 'self-healing', steps: [{ id: 'init', name: 'Initializing', sequence: 1, 'exit-events': [{ 'move-to-state': 'done' }] }, { id: 'done', name: 'Done', sequence: 2 }] };
const testing = { name: 'test', steps: [{ id: 'test', name: 'Test', sequence: 1, action: { type: 'state-engine', engine: 'shots' } }] };
const shots = { name: 'shots', steps: [{ id: 'shoot', name: 'Shoot', sequence: 1 }] };
const unused = { name: 'unused', steps: [{ id: 'x', name: 'X', sequence: 1 }] };
// The project's engine: local testing runs test (which runs shots); its check-health list runs self-healing.
const executing = { ...engine, steps: [...engine.steps, { id: 'local-testing', name: 'Local Testing', sequence: 5, action: { type: 'state-engine', engine: 'test' } }], lists: { 'check-health-steps': [{ id: 'check-health', sequence: 1, action: { type: 'state-engine', engine: 'self-healing' } }] } };
const subflows = (extra = {}, sprintExtra = {}) => ({ ...initialState({ projects: [{ ...projects[0], sprint: { ...projects[0].sprint, ...sprintExtra } }, projects[1]], workflows: [executing, healing, testing, shots, unused], assignments, ...extra }), screen: 'f', focus: 'subflows' });

test('f is the sub-flows screen, offered right after c in the menu', () => {
  assert.deepEqual(menuOf(state).slice(4, 6), ['c control', 'f sub-flows 🤖x0']);
  assert.equal(handleKey(state, key('f')).screen, 'f');
  assert.equal(handleKey(state, key('f')).focus, 'subflows');
});

test('the sub-flows screen boxes every engine the project\'s engine reaches — its steps, its lists, their engines in turn — each once, running or not; most run this sprint first', () => {
  const out = lines(subflows({}, { 'connected-flows': [{ name: 'shots', 'run-count': 1 }, { name: 'test', 'run-count': 4 }] }), wide);
  const top = out.findIndex(l => l.startsWith('┌'));
  assert.match(out[top], /^┌─ test ─+┐    ┌─ shots ─+┐    ┌─ self-healing ─+┐/);          // 4, 1, then 0 (self-healing never ran)
  assert.ok(!out.some(l => l.includes('unused')));                                            // not reached
  assert.ok(out.slice(top).some(l => /│ █ Initializing +│/.test(l)));
});

test('a run of an engine marks its step in that engine\'s box, with its agents there — name and status update; runs of one engine share its box', () => {
  const run = (id, at) => ({ id, project: 'example', 'state-engine': 'self-healing', state: at, 'start-time': '2026-10-01T14:00:00Z', parent: { trigger: 'check-health' } });
  const onEngine = (name, id, at, update) => ({ ...assignment(name, null), 'transient-state-engine': id, state: at, 'ai-status-update-short': update });
  const team = [...assignments, onEngine('She-Ra', 'r1', 'init', 'Running healthchecks'), onEngine('Hordak', 'r2', 'done'), onEngine('Bumblebee', 'other', 'init', 'Elsewhere')];
  const elsewhere = { id: 'other', project: 'assassin', 'state-engine': 'self-healing', state: 'init' };
  const out = lines(subflows({ assignments: team, transientEngines: [run('r1', 'init'), run('r2', 'done'), elsewhere] }), wide);
  assert.ok(out.some(l => /🤖 She-Ra - Running healthc…/.test(l)), out.join('\n'));
  assert.ok(out.some(l => /🤖 Hordak/.test(l)));
  assert.equal(out.filter(l => l.includes('◀ now')).length, 2);                            // both runs' steps marked
  assert.ok(!out.some(l => l.includes('Bumblebee')));                                         // another project's run
});

test('when the boxes do not fit, ←/→ scroll them sideways, with a scrollbar under them; ↑/↓ scroll every box together', () => {
  const narrow = { ...wide, columns: 80, rows: 30 };
  const s = subflows();
  const titles = st => (lines(st, narrow).find(l => l.startsWith('┌')) ?? '').match(/┌─ ([\w-]+)/g);
  const first = titles(s);
  const right = handleKey(s, key('right'), narrow);
  assert.notDeepEqual(titles(right), first);
  assert.deepEqual(titles(handleKey(right, key('left'), narrow)), first);
  assert.deepEqual(titles(handleKey(s, key('left'), narrow)), first);                       // stops at the start
  assert.ok(lines(s, narrow).some(l => /^◀ .*▶$/.test(l) && l.includes('█')), lines(s, narrow).join('\n'));
  const down = handleKey(s, key('down'), narrow);
  assert.equal(down.subflowScroll, 1);
});

test('tab reaches the box area after the menu and the day; ←/→ scroll the boxes only there, stopping at the right end; the view keeps its place as data changes', () => {
  const narrow = { ...wide, columns: 80, rows: 31 };
  const press = (st, ...names) => names.reduce((at, name) => handleKey(at, key(name), narrow), st);
  const s = subflows();
  assert.deepEqual(['tab', 'tab', 'tab'].map((_, i) => press(s, ...Array(i + 1).fill('tab')).focus), ['menu', 'day', 'subflows']);
  assert.equal(press(s, 'tab', 'right').subflowStart, 0);                                   // the menu: ←/→ switch project
  assert.equal(press(s, 'tab', 'tab', 'left').subflowStart, 0);                             // the day: ←/→ switch day
  const titles = st => (lines(st, narrow).find(l => l.startsWith('┌')) ?? '').match(/┌─ ([\w-]+)/g);
  const end = press(s, ...Array(20).fill('right'));
  assert.equal(titles(end).at(-1), '┌─ test');                                              // the last box (by name: none has run) in sight
  assert.deepEqual(press(end, 'right'), end);                                               // and no further
  assert.ok(lines(end, narrow).some(l => /^◀ .*█ ▶$/.test(l)));                             // the thumb at the right end
  const run = { id: 'r1', project: 'example', 'state-engine': 'test', state: 'test', 'start-time': '2026-10-01T14:00:00Z' };
  const changed = { ...end, transientEngines: [run], assignments: [...assignments, { ...assignment('She-Ra', null), 'transient-state-engine': 'r1', state: 'test' }] };
  assert.deepEqual(titles(changed), titles(end));                                           // a run starts: the same boxes in sight
  assert.ok(lines(changed, narrow).some(l => l.includes('She-Ra')));
  assert.equal(press(end, 'tab', 'right').subflowStart, 0);                                 // a new project starts at the first box
});

test('when the boxes are taller than the space, each carries a scrollbar thumb in its right border, moving as ↑/↓ scroll them together', () => {
  const short = { ...wide, rows: 29 };
  const s = subflows();
  const out = lines(s, short);
  const top = out.findIndex(l => l.startsWith('┌'));
  const bottom = out.findIndex((l, i) => i > top && l.startsWith('└'));
  const borders = [...out[top]].flatMap((c, i) => (c === '┐' ? [i] : []));     // every box's right border
  assert.ok(borders.length > 1);
  const thumb = st => lines(st, short).slice(top + 1, bottom).map(l => borders.map(at => [...l][at] === '█'));
  assert.ok(thumb(s)[0].every(Boolean), out.join('\n'));                     // at the top, on every box
  const end = Array(100).fill('down').reduce(at => handleKey(at, key('down'), short), s);
  assert.ok(thumb(end).at(-1).every(Boolean));                                // at the bottom once scrolled to the end
  assert.ok(!thumb(end)[0].some(Boolean));
  assert.ok(!lines(s, wide).some(l => l.endsWith('█')));                      // no thumb when every line fits
});

test('the control screen is control\'s log alone, the full width: no engine boxes on it any more', () => {
  const run = { id: 'a2c1', project: 'example', 'state-engine': 'self-healing', state: 'init', 'start-time': '2026-10-01T14:00:00Z' };
  const out = lines({ ...initialState({ projects, workflows: [engine, healing], assignments, transientEngines: [run] }), screen: 'c', controlLogFile: '/tmp/control.log' }, wide);
  const top = out.find(l => l.startsWith('┌'));
  assert.match(top, /^┌─ control \(times UTC\) ─+┐$/);
  assert.equal(visible(top), wide.columns);
  assert.ok(!out.some(l => l.includes('self-healing')));
});

test('the menu counts the selected project\'s agents on transient state engines beside f', () => {
  const onEngine = (name, id, project = 'example') => ({ ...assignment(name, null, null, project), 'transient-state-engine': id });
  const team = [...assignments, onEngine('She-Ra', 'a2c1'), onEngine('Bumblebee', '349b'), onEngine('Hordak', 'ffff', 'assassin')];
  assert.ok(menuOf(initialState({ projects, workflows: [engine], assignments: team })).includes('f sub-flows 🤖x2'));
  assert.ok(menuOf(handleKey(initialState({ projects, workflows: [engine], assignments: team }), key('right'))).includes('f sub-flows 🤖x1'));
});

test('without a transient state engine for the selected project, control keeps the whole width', () => {
  const s = { ...initialState({ projects, workflows: [engine], assignments, transientEngines: [{ id: 'x', project: 'assassin', 'state-engine': 'test', state: 'test', 'start-time': '2026-10-01T14:00:00Z' }] }), screen: 'c', controlLogFile: '/tmp/control.log' };
  const out = lines(s, wide);
  assert.match(out.find(l => l.startsWith('┌')), /^┌─ control \(times UTC\) ─+┐$/);
});

// A sprint with histories, and an engine whose last step is Done.
const doneEngine = { name: 'example-development', steps: [...engine.steps, { id: 'done', name: 'Done', sequence: 31 }] };
const moves = (...list) => list.map(([from, to, timestamp]) => ({ 'from-state': from, 'to-state': to, timestamp, 'agent-dispatch-log': [] }));
const progressing = { ...sprint, features: [
  { key: 'P-1', title: 'Shipped', priority: 1, ...single({ 'harness-status': hs('done'), 'state-changes': moves(['backlog', 'code-review', '2026-09-24T08:00:00Z'], ['code-review', 'done', '2026-09-25T10:00:00Z']) }) },
  { key: 'P-2', title: 'Reviewing a very long title that will need to wrap onto the next line of the screen when the bullet is drawn on a narrow terminal', priority: 2, ...single({ 'harness-status': hs('code-review'), 'state-changes': moves(['backlog', 'code-review', '2026-09-25T11:00:00Z']) }) },
], bugs: [], spikes: [] };
const updating = press(initialState({ projects: [{ ...projects[0], sprint: progressing }], workflows: [doneEngine] }), 'u');
const typed = (s, text) => [...text].reduce((st, ch) => handleKey(st, { name: ch, sequence: ch }, wide), s);
const setSince = (s, date, time) => press(typed(press(typed(press(s, 'return'), date), 'tab'), time), 'return');

test('u opens the updates screen focused, asking for a date and a time before it lists anything', () => {
  assert.equal(updating.focus, 'updates');
  const out = lines(updating, wide);
  assert.ok(out.some(l => /^Since +date YYYY-MM-DD +time HH:MM UTC/.test(l)));
  assert.ok(out.some(l => l.includes('Set a date and time to see the progress made since then.')));
  assert.ok(out.some(l => l.includes('enter sets the date and time')));
});

test('enter opens the date and time; tab moves between them; enter shows the progress since then', () => {
  const form = press(updating, 'return');
  assert.deepEqual(form.updatesForm, { field: 'date', date: '', time: '' });
  const dated = typed(form, '2026-09-25x');                                   // only digits, dashes and colons
  assert.equal(dated.updatesForm.date, '2026-09-25');
  assert.ok(render(dated, wide).some(l => l.includes('\x1b[7m2026-09-25█\x1b[0m')));
  assert.equal(press(dated, 'tab').updatesForm.field, 'time');
  assert.equal(handleKey(press(dated, 'tab'), key('tab', { shift: true }), wide).updatesForm.field, 'date');
  const set = setSince(updating, '2026-09-25', '09:00');
  assert.deepEqual([set.updatesSince, set.updatesForm], [Date.parse('2026-09-25T09:00:00Z'), null]);
  const out = lines(set, wide);
  assert.ok(out.some(l => /^Since +date 2026-09-25 +time 09:00 UTC/.test(l)));
  const at = text => out.findIndex(l => l.startsWith(text));
  assert.ok(at('2 tickets moved: 1 delivered, 1 moved forward') > 0);
  assert.ok(at('Delivered') > at('2 tickets moved'));
  assert.equal(out[at('Delivered') + 1], '• P-1: Shipped (Code Review → Done)');
  assert.ok(at('Moved forward') > at('Delivered'));
  assert.equal(press(set, 'return').updatesForm.date, '2026-09-25');                // reopening starts from what is set
});

test('a bullet too long for the screen wraps under its own text', () => {
  const out = lines(setSince(updating, '2026-09-25', '9:00'), { ...wide, columns: 80 });
  const first = out.findIndex(l => l.startsWith('• P-2: Reviewing'));
  assert.ok(out[first].length <= 80);
  assert.match(out[first + 1], /^ {2}\S/);
});

test('a date or time that is not real says so and keeps the form open; escape gives up', () => {
  for (const [date, time] of [['2026-02-30', '09:00'], ['2026-9-25', '09:00'], ['2026-09-25', '25:00'], ['2026-09-25', '9']]) {
    const bad = setSince(updating, date, time);
    assert.notEqual(bad.updatesForm, null, `${date} ${time}`);
    assert.equal(bad.updatesSince, null);
    assert.ok(lines(bad, wide).some(l => l.includes('date as YYYY-MM-DD and time as HH:MM')), `${date} ${time}`);
  }
  const gaveUp = press(typed(press(updating, 'return'), '2026'), 'escape');
  assert.deepEqual([gaveUp.updatesForm, gaveUp.updatesSince, gaveUp.screen], [null, null, 'u']);
});

test('up and down scroll a list longer than the screen, no further than its end', () => {
  const many = { ...progressing, features: Array.from({ length: 60 }, (_, i) => ({ key: `M-${i}`, title: 'T', priority: i, ...single({ 'harness-status': hs('code-review'), 'state-changes': moves(['backlog', 'code-review', '2026-09-25T11:00:00Z']) }) })) };
  const set = setSince(press(initialState({ projects: [{ ...projects[0], sprint: many }], workflows: [doneEngine] }), 'u'), '2026-09-25', '09:00');
  const shown = s => lines(s, wide).filter(l => l.startsWith('• M-')).map(l => l.match(/M-\d+/)[0]);
  assert.equal(shown(set)[0], 'M-0');
  assert.equal(shown(press(set, 'down'))[0], 'M-0');                              // the summary line scrolls off first
  const end = press(set, ...Array(200).fill('down'));
  assert.equal(shown(end).at(-1), 'M-59');
  assert.equal(press(end, 'down').updatesScroll, end.updatesScroll);
  assert.equal(press(end, ...Array(300).fill('up')).updatesScroll, 0);
});

test('on the updates screen, keys type into the form, not elsewhere', () => {
  const form = typed(press(updating, 'return'), 'dq');
  assert.deepEqual([form.screen, form.updatesForm.date], ['u', '']);
});

test('a highlighted ticket\'s number is marked wherever it shows on the sprint, its flow, the ticket screen\'s questions, updates, control and agents screens', () => {
  const marked = '\x1b[48;2;255;255;0m\x1b[30mABC-1\x1b[39;49m';
  const highlighted = { ...projects[0], sprint: progressing, highlights: [{ ticket: 'ABC-1', color: '#ffff00' }, { ticket: 'P-1', color: '#ffff00' }], questions };
  const s = initialState({ projects: [highlighted], workflows: [doneEngine] });
  const on = (screen, extra = {}) => render({ ...s, screen, ...extra }, wide);
  const dashboard = render(initialState({ projects: [{ ...projects[0], highlights: highlighted.highlights }], workflows: [engine] }), wide);
  assert.ok(dashboard.some(l => l.includes(`${marked}: New Feature`)));                   // the Ticket cell, inside its link
  assert.ok(!dashboard.some(l => l.includes('\x1b[48;2;255;255;0m\x1b[30mABC-2')));
  assert.ok(on('S', { flowchartView: 'tickets' }).some(l => l.includes('\x1b[48;2;255;255;0m\x1b[30mP-1\x1b[39;49m: Shipped')));
  const ticketScreen = render({ ...onQuestions, projects: [{ ...onQuestions.projects[0], highlights: highlighted.highlights }] }, wide);
  assert.ok(ticketScreen.some(l => l.includes(`on ${link(marked, 'http://t/ABC-1')}`)));  // the selected question's details, where it was asked, inside its link (ASS-86)
  assert.ok(on('u', { updatesSince: Date.parse('2026-09-25T09:00:00Z') }).some(l => l.includes('• \x1b[48;2;255;255;0m\x1b[30mP-1\x1b[39;49m: Shipped')));
  assert.ok(on('c', { controlLog: [{ text: 'Hello ABC-1!', stream: 'stdout', at: new Date() }] }).some(l => l.includes(`Hello ${marked}!`)));
  const agents = render({ ...initialState({ projects: [highlighted], workflows: [doneEngine], assignments: [assignment('Daredevil', 'ABC-1')] }), screen: 'a', agentsTable: true }, wide);
  assert.ok(agents.some(l => l.startsWith('│ Daredevil ') && l.includes(marked)));       // the agent's Work Item cell
  assert.ok(!on('f').some(l => l.includes(marked)));
});

test('ctrl-c quits; q and c do not', () => {
  assert.equal(handleKey(state, key('c', { ctrl: true })).quit, true);
  assert.equal(handleKey(state, key('q')).quit, false);
  assert.equal(handleKey(state, key('c')).quit, false);
});

test('Q starts the shut-down: the control screen shows it, the bottom line says so, and only ctrl-c does anything until it is over', () => {
  assert.equal(menuOf(state).at(-6), 'Q quit');   // the marks' legend under it (ASS-248, ASS-259)
  const quitting = handleKey(state, key('q', { shift: true, sequence: 'Q' }));
  assert.deepEqual([quitting.quitting, quitting.quit, quitting.screen], [true, false, 'c']);
  assert.ok(lines(quitting, { ...screen, columns: 400 }).at(-1).includes('shutting down: stopping control, the downloader and every agent — ctrl-c forces it'));
  assert.equal(handleKey(quitting, key('s')), quitting);                               // keys do nothing now
  assert.equal(handleKey(quitting, key('space')), quitting);
  assert.equal(handleKey(quitting, key('c', { ctrl: true })).quit, true);              // but ctrl-c still quits at once
  assert.deepEqual([handleKey(state, key('q', { sequence: 'q' })).quitting, handleKey(state, key('q', { sequence: 'q' })).screen], [false, 's']);   // q is nothing (ASS-103)
  const typing = { ...handleKey(handleKey(initialState({ projects, workflows: [engine], assignments: [{ ...assignment('Daredevil', 'ABC-1'), 'start-time': '2026-10-01T13:43:00Z' }] }), key('a')), zKey, wide), agentLog: [] };
  assert.equal(openDraft(handleKey(typing, key('q', { shift: true, sequence: 'Q' }))), 'Q'); // text where text is typed
});

// The ticket screen: enter on the focused ticket grid, esc back.
const detailed = {
  key: 'ABC-5', title: 'Detailed', url: 'http://t/ABC-5', priority: 4, points: 8,
  description: 'Every field this ticket has, so the ticket screen can show it.',
  'ticket-system-status': 'In Progress', 'ticket-system-assignment': 'Pat Owner', dependencies: ['ABC-1', 'ABC-2'], overlaps: ['ABC-3'], qa: { status: 'Passed' },
  ...single({
    'harness-status': hs('code-review'), 'ai-feedback-short': 'Short health', 'ai-feedback-long': 'Long health: the whole story.',
    build: { branch: 'change/ABC-5', 'branch-url': 'http://b/ABC-5', worktree: 'wt-5', 'worktree-folder': '/src/wt-5' },
    'local-testing': { 'number-of-passing-relevant-automated-tests': 3, 'number-of-relevant-automated-tests': 4 },
    'acceptance-criteria': [
      { 'criteria-number': 1, description: 'First criterion', 'dev-status': 'Passed', 'testing-status': 'Failed' },
      { 'criteria-number': 2, description: 'Second criterion', 'dev-status': 'Incomplete', 'testing-status': 'Incomplete' },
    ],
    'merge-request': [{ key: '!55', 'build-status': 'Passed', url: 'http://mr/55' }],
    'state-changes': [{
      'from-state': 'backlog', 'to-state': 'code-review', timestamp: '2026-09-29T10:00:00Z',
      'agent-dispatch-log': [{ 'dispatched-to': 'Peter-Pan', timestamp: '2026-09-29T10:00:00Z', 'cost-usd': 0.8589 }],
    }],
  }),
};
const detailProject = { id: 'example', name: 'Example', stateEngine: 'example-development', sprint: { ...sprint, features: [detailed], bugs: [sprint.bugs[0]], spikes: [] } };
const onGrid = { ...initialState({ projects: [detailProject], workflows: [engine], assignments: [assignment('Daredevil', 'ABC-5')] }), focus: 'tickets' };

test('enter on the focused ticket grid opens the selected ticket\'s screen; esc returns to the sprint as it was', () => {
  const open = press(onGrid, 'down', 'return');
  const out = lines(open, wide);
  assert.equal(panelOf(out)[1], 'New Bug');
  assert.ok(out.some(l => l.includes('esc returns to the sprint')));
  assert.ok(!out.some(l => l.includes('│ Priority │')));             // the grid is gone
  const back = press(open, 'escape');
  assert.deepEqual(render(back, wide), render(press(onGrid, 'down'), wide));
  assert.equal(back.focus, 'tickets');
});

test('enter opens no ticket unless the ticket grid has focus', () => {
  const menu = { ...onGrid, focus: 'menu' };
  assert.deepEqual(press(menu, 'return'), menu);
});

test('below Total Token Spend: Total Agent Time, Total Time Planning and Total Time Executing, in that order; — while there is nothing to show yet (HD-3)', () => {
  const steps = [
    { id: 'backlog', name: 'Backlog', sequence: 1, 'is-planning-stage': true }, { id: 'plan', name: 'Plan', sequence: 2, 'is-planning-stage': true },
    { id: 'build', name: 'Build', sequence: 13 }, { id: 'review', name: 'Review', sequence: 14 }, { id: 'done', name: 'Done', sequence: 15, 'is-done': true },
  ];
  const ran = (from, to) => ({ 'dispatched-to': 'Thor', timestamp: `2026-10-12T${from}:00Z`, 'completed-timestamp': `2026-10-12T${to}:00Z` });
  const change = (from, to, time, log = []) => ({ 'from-state': from, 'to-state': to, timestamp: `2026-10-12T${time}:00Z`, 'agent-dispatch-log': log });
  const shipped = { ...detailed, ...single({ 'harness-status': hs('done'), 'state-changes': [
    change('backlog', 'plan', '10:00', [ran('10:00', '10:30')]), change('plan', 'build', '12:00', [ran('12:00', '13:00')]), change('build', 'review', '13:00'), change('review', 'done', '15:30'),
  ] }) };
  const at = ticket => lines(onTab(press({ ...onGrid, workflows: [{ ...engine, steps }], projects: [{ ...detailProject, sprint: { ...detailProject.sprint, features: [ticket] } }] }, 'return'), 'details'), { ...wide, rows: 80 });
  const out = at(shipped);
  const row = label => out.findIndex(l => l.includes(label));
  assert.deepEqual(['Total Token Spend', 'Total Agent Time', 'Total Time Planning', 'Total Time Executing'].map(row).map((i, n, all) => i === all[0] + n), [true, true, true, true]);
  assert.match(out[row('Total Agent Time')], /Total Agent Time\s+1h 30m/);
  assert.match(out[row('Total Time Planning')], /Total Time Planning\s+2h 0m/);
  assert.match(out[row('Total Time Executing')], /Total Time Executing\s+2h 30m/);
  const fresh = at({ ...detailed, ...single({ 'harness-status': hs('backlog'), 'state-changes': [] }) });
  for (const label of ['Total Agent Time', 'Total Time Planning', 'Total Time Executing']) assert.match(fresh.find(l => l.includes(label)), new RegExp(`${label}\\s+—`));
});

test('Total Token Spend sums the cost-usd of every agent dispatched on the row\'s variation, in dollars; — when nothing is spent', () => {
  const dispatch = cost => ({ 'dispatched-to': 'Agent', timestamp: '2026-09-29T10:00:00Z', ...(cost == null ? {} : { 'cost-usd': cost }) });
  const change = (...costs) => ({ 'from-state': 'backlog', 'to-state': 'code-review', timestamp: '2026-09-29T10:00:00Z', 'agent-dispatch-log': costs.map(dispatch) });
  const spent = { ...detailed, ...single({ 'harness-status': hs('code-review'), 'state-changes': [change(1.5, 0.26), change(null), change(10)] }) };
  const s = { ...onGrid, projects: [{ ...detailProject, sprint: { ...detailProject.sprint, features: [spent] } }] };
  assert.match(lines(s, wide).find(l => l.includes('ABC-5')), /—\s+\$11\.76\s+Pat Owner/);   // between MR and Assignee
  assert.match(lines(onTab(press(s, 'return'), 'details'), { ...wide, rows: 80 }).join('\n'), /Total Token Spend\s+\$11\.76/);
  assert.match(lines(onTab(press(onGrid, 'down', 'return'), 'details'), { ...wide, rows: 80 }).join('\n'), /Ticket name +New Bug[\s\S]*Total Token Spend\s+—/);   // nothing dispatched
});

test('ASS-191 AC5: with a spending limit, the ticket screen shows the ticket\'s spend — every variation\'s — against it: the project\'s, or the ticket\'s own; none, no line', () => {
  const dispatch = cost => ({ 'dispatched-to': 'Agent', timestamp: '2026-09-29T10:00:00Z', 'cost-usd': cost });
  const change = (...costs) => ({ 'from-state': 'backlog', 'to-state': 'code-review', timestamp: '2026-09-29T10:00:00Z', 'agent-dispatch-log': costs.map(dispatch) });
  const two = { ...detailed, variations: [{ ...detailed.variations[0], 'state-changes': [change(5, 1.2)] }, { name: 'B', 'harness-status': hs('code-review'), 'state-changes': [change(2)] }] };
  const screen = (ticket, spendLimit) => lines(onTab(press({ ...onGrid, projects: [{ ...detailProject, spendLimit, sprint: { ...detailProject.sprint, features: [ticket] } }] }, 'return'), 'details'), { ...wide, rows: 80 }).join('\n');   // its Details tab (ASS-184)
  assert.match(screen(two, 10), /Spending limit\s+\$8\.20 of \$10/);
  assert.match(screen({ ...two, 'max-spend-usd': 12.5 }, 10), /Spending limit\s+\$8\.20 of \$12\.50/);
  assert.doesNotMatch(screen(two, null), /Spending limit/);
});

// ASS-270: the running agents' spend so far — each one's usage.json (state.usage, read every second) — on the ticket screen, marked as running.
test('ASS-270 AC3/AC4: the ticket screen\'s spend counts its running agents\' spend so far, marked as running — a subscription agent\'s as $0, another variation\'s in the ticket\'s limit alone', () => {
  const dispatch = cost => ({ 'dispatched-to': 'Agent', timestamp: '2026-09-29T10:00:00Z', 'cost-usd': cost });
  const change = (...costs) => ({ 'from-state': 'backlog', 'to-state': 'code-review', timestamp: '2026-09-29T10:00:00Z', 'agent-dispatch-log': costs.map(dispatch) });
  const two = { ...detailed, variations: [{ ...detailed.variations[0], 'state-changes': [change(5, 1.2)] }, { name: 'B', 'harness-status': hs('code-review'), 'state-changes': [change(2)] }] };
  const team = [assignment('Daredevil', 'ABC-5', 'A'), assignment('Elektra', 'ABC-5', 'B'), assignment('Punisher', 'ABC-5', 'A')];
  const usage = {
    Daredevil: { costUsd: 1.5, costExact: false, billing: 'api' },
    Elektra: { costUsd: 0.5, costExact: false, billing: 'api' },
    Punisher: { costUsd: 9, costExact: false, billing: 'subscription' },   // a subscription never charges
  };
  const at = (u, spendLimit = 10) => press({ ...initialState({ projects: [{ ...detailProject, spendLimit, sprint: { ...detailProject.sprint, features: [two] } }], workflows: [engine], assignments: team }), focus: 'tickets', usage: u }, 'return');
  const details = u => lines(onTab(at(u), 'details'), { ...wide, rows: 80 }).join('\n');
  assert.match(details(usage), /Spending limit\s+\$10\.20 of \$10 \(~\$2\.00 running\)/);
  assert.match(details(usage), /Total Token Spend\s+\$7\.70 \(~\$1\.50 running\)/);
  assert.match(lines(at(usage), wide).join('\n'), /Spend \$7\.70 \(~\$1\.50 running\)/);   // the quick-details panel
  // Nothing running, or only on the subscription: as before, no mark.
  assert.match(details({ Punisher: usage.Punisher }), /Spending limit\s+\$8\.20 of \$10(?! \()/);
  assert.match(details({}), /Total Token Spend\s+\$6\.20(?! \()/);
});

test('the ticket chat\'s spend (collaboration.json, ASS-35) — the sum of its turns (ASS-216 AC2) — counts toward the ticket\'s: on its screen, and on the dashboard once per ticket, on its first variation\'s row', () => {
  const two = { ...detailed, variations: [{ ...detailed.variations[0] }, { name: 'B', 'harness-status': hs('code-review') }] };
  const s = { ...onGrid, projects: [{ ...detailProject, sprint: { ...detailProject.sprint, features: [two] }, collaborations: { 'ABC-5': { 'session-id': 's', briefed: null, turns: [{ timestamp: '2026-09-29T10:00:00Z', billing: 'api', 'cost-usd': 1 }, { timestamp: '2026-09-29T11:00:00Z', 'cost-usd': 0.25 }] } } }] };
  const rows = lines(s, wide).filter(l => l.includes('ABC-5.'));
  assert.match(rows.find(l => l.includes('ABC-5.A')), /\$2\.11/);    // $0.86 dispatched + $1.25 chatting
  assert.match(rows.find(l => l.includes('ABC-5.B')), /—\s+Pat Owner/);   // not counted twice
  assert.match(lines(onTab(press(s, 'return'), 'details'), { ...wide, rows: 80 }).join('\n'), /Total Token Spend\s+\$2\.11/);
  assert.match(lines(onTab(press(s, 'down', 'return'), 'details'), { ...wide, rows: 80 }).join('\n'), /Variation +B[\s\S]*Total Token Spend\s+\$1\.25/);
});

test('the ticket screen shows every detail of the ticket and the row\'s variation', () => {
  const open = press(onGrid, 'return');
  const out = ['details', 'history'].map(tab => lines(onTab(open, tab), { ...wide, rows: 80 }).join('\n')).join('\n');
  for (const text of [
    '✨ ABC-5', 'Detailed', 'Every field this ticket has', 'In Progress', 'Pat Owner',
    'Code Review (1, 1)', 'Long health: the whole story.', 'change/ABC-5', 'wt-5', '3/4 passing', '🤖 Daredevil',
    'First criterion', 'Second criterion', 'Failed', 'Incomplete', '!55', 'Passed',
    '10:00 UTC  Backlog   →   Code Review 🤖 Peter-Pan $0.86',   // the History tab, its times UTC (ASS-294)
  ]) assert.ok(out.includes(text), `shows ${text}`);
  assert.match(out, /Priority\s+4/);
  assert.match(out, /Points\s+8/);
});

test('the ticket screen lists each merge request with its status: a planned one (ASS-80) with its repository, branch, contents and what it waits on', () => {
  const t = { ...detailed, ...single({ ...detailed.variations[0], 'merge-request': [plannedMr(1, { 'depends-on': [2] }), ...everyStatus.slice(1)] }) };
  const s = { ...onGrid, projects: [{ ...detailProject, sprint: { ...detailProject.sprint, features: [t] } }] };
  const out = lines(onTab(press(s, 'return'), 'details'), { ...wide, rows: 80 });
  assert.ok(out.some(l => /MR 1 +Not Created \(planned\) +app +change\/ABC-9-1 +part 1 +after MR 2/.test(l)), out.join('\n'));
  assert.ok(out.some(l => /!2 +Open +Running/.test(l)));
  assert.ok(out.some(l => /!3 +Merged +Merged/.test(l)));
  assert.ok(out.some(l => /!4 +Closed +Failed/.test(l)));
});

test('the ticket screen lists a merge request closed without being opened (ASS-81) with its repository, branch and contents', () => {
  const t = { ...detailed, ...single({ ...detailed.variations[0], 'merge-request': [unopenedMr(1)] }) };
  const s = { ...onGrid, projects: [{ ...detailProject, sprint: { ...detailProject.sprint, features: [t] } }] };
  const out = lines(onTab(press(s, 'return'), 'details'), { ...wide, rows: 80 });
  assert.ok(out.some(l => /MR 1 +Closed \(not opened\) +app +change\/ABC-9-1 +part 1/.test(l)), out.join('\n'));
});

test('history: each row shows the state left with its time and the agents that worked it, each with how long it ran, then the state entered and its agents so far; a prompt step left gets a bar of agent time and how idle it was', () => {
  const history = [
    { 'from-state': 'backlog', 'to-state': 'code-review', timestamp: '2026-09-29T10:00:00Z',
      'agent-dispatch-log': [{ 'dispatched-to': 'Peter-Pan', timestamp: '2026-09-29T10:05:00Z', 'completed-timestamp': '2026-09-29T11:05:00Z', 'cost-usd': 0.61 }] },
    { 'from-state': 'code-review', 'to-state': 'done', timestamp: '2026-09-29T12:24:00Z',
      'agent-dispatch-log': [{ 'dispatched-to': 'Daredevil', timestamp: '2026-09-29T12:25:00Z' }] },
  ];
  const prompted = { ...engine, steps: [engine.steps[0], { ...engine.steps[1], action: { type: 'prompt' } }, { id: 'done', name: 'Done', sequence: 20, action: { type: 'none' } }] };
  const timed = { ...detailed, ...single({ 'harness-status': hs('done'), 'state-changes': history }) };
  const project = { ...detailProject, sprint: { ...detailProject.sprint, features: [timed], bugs: [] } };
  const s = { ...initialState({ projects: [project], workflows: [prompted], assignments: [] }), focus: 'tickets' };
  const tall = { ...wide, columns: 300, rows: 80 };
  const drawn = lines(onTab(press(s, 'return'), 'history'), tall);   // wide enough for a whole history row in its pane
  const out = drawn.join('\n');
  // The history's first state has no arrival time, and backlog does not prompt: no time, no bar.
  assert.match(out, /│ {17}2026-09-29 10:00 UTC  Backlog   →   Code Review 🤖 Peter-Pan \$0\.61 /);
  assert.equal(out.match(/┌─{10}┐/g)?.length, 1);
  // 1h of agent time in 2h 24m: 4 of 10 cells, 58% idle; Daredevil is still running.
  // Every entry is as tall as one with a bar, its text on the bar's line, a ↓ under the bar between entries.
  const inBox = timelineOf(drawn, tall);                             // the History tab's timeline, beside its states
  const first = inBox.findIndex(l => l.includes('10:00 UTC  Backlog'));
  assert.deepEqual(inBox.slice(first - 1, first + 9).map(l => l.replace(/  20.*/, '  …')), [
    '', '                …', '', '', '        ↓', '  ┌──────────┐', '  │████░░░░░░│  …', '  └──────────┘', '    58% idle', '',
  ]);
  assert.match(out, /┌─{10}┐.*\n.*│█{4}░{6}│  2026-09-29 12:24 UTC  Code Review \(2h 24m\) 🤖 Peter-Pan \(1h 0m\) \$0\.61   →   Done 🤖 Daredevil +│.*\n.*└─{10}┘.*\n.* {4}58% idle/);
});

test('with more than one variation, the ticket screen shows the variation\'s AI\'s feedback above Agents, a blank line between; with one, it does not', () => {
  const two = { ...detailed, variations: [
    { name: 'A', 'harness-status': hs('code-review'), 'ai-variation-feedback': 'Not preferable to B: it re-ranks on every request.' },
    { name: 'B', 'harness-status': hs('code-review'), 'ai-variation-feedback': 'Recommended: it scales.' },
  ] };
  const s = { ...onGrid, projects: [{ ...detailProject, sprint: { ...detailProject.sprint, features: [two], bugs: [] } }] };
  const out = tabOf(lines(onTab(press(s, 'return'), 'details'), { ...wide, rows: 80 }));
  const at = out.findIndex(l => l.startsWith('AI\'s feedback'));
  assert.match(out[at], /^AI's feedback +Not preferable to B: it re-ranks on every request\.$/);   // the tab is wide enough for it whole
  assert.deepEqual([out[at - 1], out[at + 1]], ['', '']);            // a blank line above it and below it
  assert.match(out[at - 2], /^Gates/);
  assert.match(out[at + 2], /^Agents/);
  assert.ok(!lines(press(onGrid, 'return'), { ...wide, rows: 80 }).some(l => l.includes('AI\'s feedback')));   // one variation
});

test('the ticket screen\'s fields come in order, in groups, the health in its long form only', () => {
  const fields = tabOf(lines(onTab(press(onGrid, 'return'), 'details'), { ...wide, rows: 80 })).slice(0, 36);
  const labels = fields.map(l => l.match(/^(\S.*?)(?: {2,}|$)/)?.[1] ?? '');
  assert.deepEqual(labels, [
    'Ticket number', 'Variation', 'Ticket name', 'Description',   // whole on its line: the tab is wide (ASS-184)
    '',
    'Status', 'Status in ticketing system', 'Assignee', 'Points', 'Priority', 'Manual priority', '',
    'Dependencies', 'Overlaps', '',                                   // Overlaps right after Dependencies (ASS-196)
    'Branch', 'Worktree', '',
    'Total Token Spend', 'Total Agent Time', 'Total Time Planning', 'Total Time Executing', '',
    'Health', 'Automated tests', 'Gates', '',
    'Agents', '',
    'Acceptance criteria', '', '', '',                                // its two criteria, indented
    'QA', '',
    'Merge requests',
  ]);
  assert.match(fields[33], /QA +Passed$/);
  assert.match(fields[0], /✨ ABC-5$/);
  assert.match(fields[12], /ABC-1, ABC-2$/);
  assert.match(fields[13], /Overlaps +ABC-3$/);
  assert.match(fields[23], /Long health: the whole story\.$/);
  assert.ok(!TAB_IDS.some(tab => lines(onTab(press(onGrid, 'return'), tab), { ...wide, rows: 80 }).some(l => l.includes('Short health'))));
});

test('on the Details tab ↑/↓ scroll and other keys do nothing until esc; space still pauses', () => {
  const long = { ...detailed, ...single({ 'harness-status': hs('code-review'), 'acceptance-criteria': Array.from({ length: 80 }, (_, i) => ({ 'criteria-number': i + 1, description: `Criterion ${i + 1}` })) }) };
  const s = { ...onGrid, projects: [{ ...detailProject, sprint: { ...detailProject.sprint, features: [long] } }] };
  const open = onTab(press(s, 'return'), 'details');
  const first = s => tabOf(lines(s, wide))[0];   // the Details tab's first line
  assert.match(first(open), /Ticket number +✨ ABC-5/);
  assert.doesNotMatch(first(press(open, 'down')), /Ticket number/);
  assert.deepEqual(press(open, 'up'), open);                         // already at the top
  assert.deepEqual(press(open, 'f', 'left'), open);
  assert.ok(press(open, 'space').pauses['example']?.human);
  const bottom = press(open, ...Array(200).fill('down'));
  assert.ok(lines(bottom, wide).some(l => l.includes('Criterion 80')));
  assert.deepEqual(press(bottom, 'down'), bottom);                  // no further than the last line
});

// A ticket at a human gate: its screen splits, details left, the gate's choices right.
const gateSteps = [
  { id: 'gate', name: 'Payment Gate', sequence: 5, action: { type: 'human', instructions: 'Approve the token spend before work goes on.' }, 'exit-events': [
    { condition: { 'human-review': 'Approved' }, 'move-to-state': 'work' },
    { condition: { 'human-review': 'Rejected' }, 'follow-return-to-state': true },
    { condition: { 'ticket-system-status': 'Done' }, 'move-to-state': 'work' },
  ] },
  { id: 'work', name: 'Working', sequence: 6, action: { type: 'prompt' } },
];
const gated = (fields = {}) => ({ key: 'ABC-6', title: 'Gated', priority: 1, ...single({ 'harness-status': hs('gate'), ...fields }) });
const atGate = (fields, extra = {}) => ({
  ...initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'e', sprint: { ...sprint, features: [gated(fields)], bugs: [], spikes: [] } }], workflows: [{ name: 'e', steps: gateSteps }] }),
  focus: 'tickets', ...extra,
});

test('a human gate\'s ticket screen opens on its Actions tab: its human-review choices, never the step\'s instructions; the details on their own tab', () => {
  const open = press(atGate(), 'return');
  const out = lines(open, wide);
  assert.deepEqual(actionsOf(out).slice(0, 3), ['Steer this ticket by hand.', '', 'Choose one:']);
  assert.ok(!out.some(l => l.includes('Approve the token spend')));  // never the step's own instructions
  assert.ok(actionsOf(out).some(l => /Approved\s+→ Working/.test(l)));
  assert.ok(actionsOf(out).some(l => /Rejected\s+→ back where it came from/.test(l)));
  assert.ok(!actionsOf(out).some(l => /Done/.test(l)));               // not a human's choice
  assert.ok(out.some(l => l.includes('tab or 1-5 switch tabs')));
  assert.match(tabOf(lines(onTab(open, 'details'), wide))[0], /Ticket number +✨ ABC-6/);
  assert.ok(!lines(press(onGrid, 'return'), wide).some(l => l.includes('HUMAN GATE')));   // no gate
});

test('at a human gate ↑/↓ move the choice; shift-tab steps back a section, where ↑/↓ scroll instead; enter records the choice', () => {
  const open = press(atGate(), 'return');
  const chosen = s => render(s, wide).find(l => l.includes('\x1b[7m') && /Approved|Rejected/.test(strip(l)));
  assert.match(strip(chosen(open)), /Approved/);
  const down = press(open, 'down');
  assert.match(strip(chosen(down)), /Rejected/);
  const last = press(down, 'down', 'down', 'down', 'down');          // Set manual priority, Gate when leaving states, Pause this ticket and Delete ticket, after the gate's choices
  assert.deepEqual(press(last, 'down'), last);                       // no further than the last choice
  assert.equal(handleKey(down, key('tab', { shift: true }), wide).ticketTab, 'chat');   // the section before the actions (ASS-101)
  const back = { ...down, ticketTab: 'details' };
  assert.equal(chosen(back), undefined);                             // no reverse video while the details have focus
  assert.equal(press(back, 'down').ticketChoice, 1);                 // ↓ scrolls the details instead
  assert.deepEqual(press(open, 'return').decide, ['ticket:human-review', 'p', 'ABC-6', 'A', 'gate', 'Approved', 'work']);
  assert.deepEqual(press(down, 'return').decide, ['ticket:human-review', 'p', 'ABC-6', 'A', 'gate', 'Rejected', '']);   // no history: nowhere known to go back to
  assert.equal(press(back, 'return').decide, null);                  // enter only records from the actions
});

test('a choice already recorded at this gate shows under the choices; one from an earlier state does not', () => {
  const recorded = state => lines(press(atGate({ 'human-review': { state, decision: 'Approved', timestamp: '2026-10-01T15:00:00Z' } }), 'return'), wide).join('\n');
  assert.match(recorded('gate'), /Recorded: Approved at 2026-10-01 15:00 UTC/);
  assert.doesNotMatch(recorded('elsewhere'), /Recorded:/);
});

test('on a past day a human gate shows its choices but records none', () => {
  const past = atGate({}, { day: '2026-09-20' });
  past.projects[0].days = { '2026-09-20': past.projects[0].sprint };
  const open = press(past, 'return');
  assert.equal(press(open, 'return').decide, null);
  assert.ok(lines(open, wide).some(l => l.includes('a past day')));
});

// A ticket gated on leaving its state: once its work there is done, it waits for a human to approve the move.
const transitionSteps = [
  { id: 'gen', name: 'Generate Solution', sequence: 5, action: { type: 'prompt' }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'work' }] },
  { id: 'held', name: 'Blocked', sequence: 6, area: 'quarantine', action: { type: 'none' } },
  { id: 'work', name: 'Automated Testing', sequence: 7, action: { type: 'script' } },
];
const gatedOnLeaving = done => ({
  key: 'ABC-6', title: 'Held', priority: 1,
  ...single({ 'harness-status': hs('gen'), 'gate-when-leaving-state': ['e/gen'], 'state-changes': [{ 'from-state': 'work', 'to-state': 'gen', timestamp: '2026-10-01T10:00:00Z', 'agent-dispatch-log': [], 'work-is-done': done }] }),
});
const leaving = (done, extra = {}) => ({
  ...initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'e', sprint: { ...sprint, features: [gatedOnLeaving(done)], bugs: [], spikes: [] } }], workflows: [{ name: 'e', steps: transitionSteps }] }),
  focus: 'tickets', ...extra,
});

test('a ticket gated on leaving its state shows a blue ● once its work there is done, and not before', () => {
  const row = s => render(s, wide).find(l => l.includes('ABC-6'));
  assert.ok(blueDot(row(leaving(true)), 'ABC-6: Held'));
  assert.ok(!/[●⦿]/.test(row(leaving(false))));
});

test('its ticket screen asks for approval of the move to the next state, quarantine skipped; enter approves it with ticket:change-state', () => {
  const open = press(leaving(true), 'return');
  const out = lines(open, wide);
  const right = actionsOf(out).join('\n');
  assert.match(right, /Steer this ticket by hand\./);
  assert.doesNotMatch(right, /You asked to gate/);
  assert.match(right, /Approve State Transition\s+→ Automated\s+Testing/);
  assert.deepEqual(press(open, 'return').decide, ['ticket:change-state', 'p', 'ABC-6', 'A', 'gen', 'work']);
  assert.ok(!lines(press(leaving(false), 'return'), wide).some(l => l.includes('Approve State Transition')));   // work not done: no gate yet
});

test('a gate control held with its pending move (ASS-132): the ticket screen offers Approve → where the exit was going — Blocked here, not the next step by sequence — and enter approves it with ticket:approve-gate', () => {
  const held = leaving(true);
  held.projects[0].sprint.features[0].variations[0]['state-changes'][0]['pending-move'] = { from: 'gen', to: 'held', reason: 'max-visits' };
  const open = press(held, 'return');
  const right = actionsOf(lines(open, wide)).join('\n');
  assert.match(right, /Approve\s+→ Blocked/);
  assert.doesNotMatch(right, /Automated/);
  assert.deepEqual(press(open, 'return').decide, ['ticket:approve-gate', 'p', 'ABC-6', 'A', 'gen']);
});

test('a human step gated on leaving, its decision recorded and the move held at the gate (ASS-220 AC1): the ticket screen offers the gate\'s Approve, not the step\'s choices again, and says the decision is recorded and the move held; enter approves it with ticket:approve-gate', () => {
  const held = atGate({ 'gate-when-leaving-state': ['e/gate'], 'human-review': { state: 'gate', decision: 'Approved', timestamp: '2026-10-01T15:00:00Z' },
    'state-changes': [{ 'from-state': 'work', 'to-state': 'gate', timestamp: '2026-10-01T10:00:00Z', 'agent-dispatch-log': [], 'work-is-done': true, 'pending-move': { from: 'gate', to: 'work', reason: 'exit' } }] });
  const open = press(held, 'return');
  const right = actionsOf(lines(open, wide)).join(' ');
  assert.match(right, /Approve\s+→ Working/);
  assert.doesNotMatch(right, /Rejected/);
  assert.match(right, /Recorded: Approved at 2026-10-01 15:00 UTC — the move is held at the gate/);
  assert.deepEqual(press(open, 'return').decide, ['ticket:approve-gate', 'p', 'ABC-6', 'A', 'gate']);
});

// The engine's blocked state is whichever step has is-blocked-state: true.
const blockingSteps = [...engine.steps, { id: 'stuck', name: 'Stuck for Human', sequence: 0, area: 'quarantine', 'is-blocked-state': true, action: { type: 'human' } }];
const blockable = (status, extra = {}) => ({
  ...initialState({ projects: [{ ...detailProject, sprint: { ...sprint, features: [{ ...detailed, ...single({ 'harness-status': hs(status) }) }], bugs: [], spikes: [] } }], workflows: [{ ...engine, steps: blockingSteps }] }),
  focus: 'tickets', ...extra,
});

test('a ticket not at a gate offers on its Actions tab to send it to the blocked state; enter there sends it with ticket:change-state', () => {
  const open = press(blockable('code-review'), 'return');
  const out = lines(onTab(open, 'actions'), wide);
  assert.equal(actionsOf(out)[0], 'Steer this ticket by hand.');
  assert.ok(actionsOf(out).some(l => /Block this ticket\s+→ Stuck for Human/.test(l)));
  assert.deepEqual(handleKey(press({ ...open, ticketTab: 'actions' }, 'return'), key('y', { sequence: 'y' }), wide).decide, ['ticket:change-state', 'example', 'ABC-5', 'A', 'code-review', 'stuck']);   // once confirmed (ASS-131)
  assert.equal(press(open, 'return').decide, null);                  // it opens on Chat: enter only records from the actions
});

test('a ticket with a question waiting on the operator (Asked or Answer Rejected) shows a blue ● left of its key on the dashboard, never 🔴; others do not (ASS-242)', () => {
  for (const status of ['Asked', 'Answer Rejected', 'Unanswered']) {          // an unknown status is open (ASS-170)
    const s = blockable('code-review');
    s.projects[0].questions = [question('Which login?', 'abc-5', { status })];
    assert.ok(blueDot(render(s, wide).find(l => l.includes('ABC-5')), 'ABC-5: ') && lines(s, wide).find(l => l.includes('ABC-5')).includes(`│ ${cols({ dot: '⦿' })}ABC-5: `), status);
    assert.ok(!lines(s, wide).some(l => l.includes('🔴')), status);
  }
  for (const status of ['Answered', 'Answer Accepted']) {
    const s = blockable('code-review');
    s.projects[0].questions = [question('Which login?', 'abc-5', { status })];
    assert.ok(!/[●⦿]/.test(lines(s, wide).find(l => l.includes('ABC-5'))), status);
  }
});

test('a paused ticket\'s text starts "PAUSED " in blue on the dashboard, no ⏸️ (ASS-259); others do not', () => {
  const s = blockable('code-review');
  s.projects[0].sprint.features[0].variations[0]['is-paused'] = true;
  assert.ok(lines(s, wide).find(l => l.includes('ABC-5')).includes(`│ ${cols()}PAUSED ABC-5: `));
  assert.ok(unhighlight(render(s, wide).find(l => l.includes('ABC-5'))).includes('\x1b[34mPAUSED\x1b[0m '));
  assert.ok(!lines(s, wide).some(l => l.includes('⏸️')));
  assert.ok(!lines(blockable('code-review'), wide).some(l => /ABC-\d/.test(l) && (l.includes('⏸️') || l.includes('PAUSED'))));   // the key under the grid aside
});

test('ASS-83 AC4: a fast-tracked ticket shows ↯ in its own column on the dashboard (c4, ASS-259; was ⚡), PAUSED after the icons; others do not', () => {
  const s = blockable('code-review');
  s.projects[0].sprint.features[0]['fast-track'] = true;
  assert.ok(lines(s, wide).find(l => l.includes('ABC-5')).includes(`│ ${cols({ fast: '↯' })}ABC-5: `));
  s.projects[0].sprint.features[0].variations[0]['is-paused'] = true;
  assert.ok(lines(s, wide).find(l => l.includes('ABC-5')).includes(`│ ${cols({ fast: '↯' })}PAUSED ABC-5: `));
  assert.ok(!lines(blockable('code-review'), wide).some(l => /ABC-\d/.test(l) && (l.includes('↯') || l.includes('⚡'))));   // the key under the grid aside
});

// blockable with a pending requirements change on its ticket (ASS-77), and its variation `paused`.
const PENDING = { description: 'New requirements', 'detected-at': '2026-10-25T12:00:00Z', 'paused-variations': ['A'] };
const pending = (paused = false) => {
  const s = blockable('code-review');
  const t = s.projects[0].sprint.features[0];
  t['pending-requirements-change'] = PENDING;
  t.variations[0]['is-paused'] = paused;
  return s;
};

test('a ticket with a pending requirements change shows a red ⦿ in c5 on every variation row, paused or not — no 📝 (ASS-78 AC1, ASS-259); others do not', () => {
  const red = s => unhighlight(render(s, wide).find(l => l.includes('ABC-5'))).includes('\x1b[31m⦿\x1b[0m');
  assert.ok(lines(pending(), wide).find(l => l.includes('ABC-5')).includes(`│ ${cols({ dot: '⦿' })}ABC-5: `) && red(pending()));
  assert.ok(lines(pending(true), wide).find(l => l.includes('ABC-5')).includes(`│ ${cols({ dot: '⦿' })}PAUSED ABC-5: `) && red(pending(true)));
  const two = pending();
  const t = two.projects[0].sprint.features[0];
  t.variations = [t.variations[0], { ...t.variations[0], name: 'B' }];
  assert.deepEqual(lines(two, wide).filter(l => l.includes('ABC-5.')).map(l => l.includes(`│ ${cols({ dot: '⦿' })}ABC-5.`)), [true, true]);
  assert.deepEqual(render(two, wide).filter(l => l.includes('ABC-5.')).map(l => unhighlight(l).includes('\x1b[31m⦿\x1b[0m')), [true, true]);
  assert.ok(![pending(), pending(true), two].some(s => lines(s, wide).some(l => l.includes('📝'))));
  assert.ok(!red(blockable('code-review')) && !/[●⦿]/.test(lines(blockable('code-review'), wide).find(l => l.includes('ABC-5'))));
});

test('a ticket with a pending requirements change offers Keep current and Take new before anything else; enter sends ticket:keep-current or ticket:take-new (ASS-78 AC2)', () => {
  const open = { ...press(pending(), 'return'), ticketTab: 'actions' };
  const actions = actionsOf(lines(open, wide));
  assert.ok(actions.some(l => l.includes('Pending requirements change')));
  assert.deepEqual(actions.filter(l => /Keep current|Take new|Block this ticket/.test(l)).map(l => l.match(/Keep current|Take new|Block this ticket/)[0]), ['Keep current', 'Take new', 'Block this ticket']);
  assert.deepEqual(press(open, 'return').decide, ['ticket:keep-current', 'example', 'ABC-5']);
  assert.deepEqual(press(open, 'down', 'return').decide, ['ticket:take-new', 'example', 'ABC-5']);
});

test('the ticket screen offers to pause a ticket, or unpause a paused one; enter sends it with ticket:set-paused', () => {
  const open = onTab(press(blockable('code-review'), 'return'), 'actions');
  assert.ok(actionsOf(lines(open, wide)).some(l => l.includes('Pause this ticket')));
  assert.deepEqual(press({ ...open, ticketTab: 'actions' }, 'down', 'down', 'down', 'return').decide, ['ticket:set-paused', 'example', 'ABC-5', 'A', 'true']);
  const s = blockable('code-review');
  s.projects[0].sprint.features[0].variations[0]['is-paused'] = true;
  const reopen = onTab(press(s, 'return'), 'actions');
  assert.ok(actionsOf(lines(reopen, wide)).some(l => l.includes('Unpause this ticket')));
  assert.deepEqual(press({ ...reopen, ticketTab: 'actions' }, 'down', 'down', 'down', 'return').decide, ['ticket:set-paused', 'example', 'ABC-5', 'A', 'false']);
});

test('no blocking a ticket already in the blocked state, or in an engine with none; on a past day it shows but sends nothing', () => {
  const offered = s => lines(onTab(press(s, 'return'), 'actions'), wide).some(l => l.includes('Block this ticket'));
  assert.ok(!offered(blockable('stuck')));
  assert.ok(!offered(onGrid));
  const past = blockable('code-review', { day: '2026-09-20' });
  past.projects[0].days = { '2026-09-20': past.projects[0].sprint };
  assert.ok(offered(past));
  assert.equal(press({ ...press(past, 'return'), ticketTab: 'actions' }, 'return').decide, null);
});

test('at a human gate, blocking the ticket comes after the gate\'s choices', () => {
  const steps = [...gateSteps, { id: 'stuck', name: 'Stuck', sequence: 0, area: 'quarantine', 'is-blocked-state': true }];
  const open = press({ ...atGate(), workflows: [{ name: 'e', steps }] }, 'return');
  assert.deepEqual(handleKey(press(open, 'down', 'down', 'return'), key('y', { sequence: 'y' }), wide).decide, ['ticket:change-state', 'p', 'ABC-6', 'A', 'gate', 'stuck']);
});

// A ticket built several ways, at a human step that waits on choosing one.
const pickSteps = [
  { id: 'pick', name: 'Variation Selection', sequence: 5, action: { type: 'human', instructions: 'Choose the version to go with.' }, 'exit-events': [
    { condition: { 'variation-selected': true }, 'move-to-state': 'next' },
    { condition: { 'has-variations': false }, 'move-to-state': 'next' },
  ] },
  { id: 'next', name: 'Risk Assessment', sequence: 6, action: { type: 'prompt' } },
];
const twoWays = (...variations) => ({ key: 'ABC-7', title: 'Two ways', priority: 1, variations });
const choosing = ticket => ({
  ...initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'e', sprint: { ...sprint, features: [ticket], bugs: [], spikes: [] } }], workflows: [{ name: 'e', steps: pickSteps }] }),
  focus: 'tickets',
});

test('at a human step waiting on variation-selected, the ticket screen offers each variation to go with; enter selects it with ticket:select-variation', () => {
  const s = choosing(twoWays({ name: 'A', 'harness-status': hs('pick') }, { name: 'B', 'harness-status': hs('next') }));
  assert.ok(!lines(press(s, 'return'), wide).some(l => l.includes('Go with')));   // ABC-7.B, first as closest to done, is not at the step
  const open = press(s, 'down', 'return');                           // ABC-7.A is
  const right = actionsOf(lines(open, wide)).join('\n');
  assert.match(right, /Steer this ticket by hand\./);
  assert.doesNotMatch(right, /Choose the version to go with/);
  assert.match(right, /Go with ABC-7\.A\s+→ Risk Assessment/);
  assert.match(right, /Go with ABC-7\.B\s+→ Risk Assessment/);
  assert.deepEqual(press(open, 'down', 'return').decide, ['ticket:select-variation', 'p', 'ABC-7', 'A', 'pick', 'B', 'next']);
});

test('once one variation is left, its row is keyed by the ticket alone, and its open ticket screen stays open', () => {
  const before = choosing(twoWays({ name: 'A', 'harness-status': hs('pick') }, { name: 'B', 'harness-status': hs('pick') }));
  const open = press(before, 'down', 'return');                      // ABC-7.B
  assert.equal(panelOf(lines(open, wide))[0], '✨ ABC-7 · B of 2');
  const after = { ...open, projects: choosing(twoWays({ name: 'B', 'harness-status': hs('next') })).projects };   // reloaded after selecting B
  assert.equal(panelOf(lines(after, wide))[0], '✨ ABC-7 · B');
  assert.ok(!lines(after, wide).some(l => l.includes('ABC-7.')));
  const closed = press(after, 'escape');
  assert.ok(lines(closed, wide).some(l => l.includes('ABC-7: Two ways')));
  assert.ok(!lines(closed, wide).some(l => l.includes('ABC-7.')));
});

test('a ticket with one variation does not wait at a human step with a has-variations: false exit; without one, it does', () => {
  const s = choosing(twoWays({ name: 'A', 'harness-status': hs('pick') }));
  const at = iso => lines(s, { ...wide, columns: 210, now: new Date(iso) });
  assert.ok(!/[●⦿]/.test(render(s, wide).find(l => l.includes('ABC-7'))));      // no blue mark
  assert.ok(!lines(press(s, 'return'), wide).some(l => l.includes('Go with')));         // no choices
  assert.match(at('2026-10-01T16:04:00Z')[7], /│            0            │/);   // not waiting on the operator
  const only = { ...s, workflows: [{ name: 'e', steps: [{ ...pickSteps[0], 'exit-events': pickSteps[0]['exit-events'].slice(0, 1) }, pickSteps[1]] }] };
  assert.ok(lines(press(only, 'return'), wide).some(l => l.includes('Go with ABC-7.A')));
});

test('a human step that passes by itself (one variation) whose move is held at a leaving-gate offers the gate\'s Approve (ASS-220 AC4)', () => {
  const open = press(choosing(twoWays({ name: 'A', 'harness-status': hs('pick'), 'gate-when-leaving-state': ['e/pick'],
    'state-changes': [{ 'from-state': 'next', 'to-state': 'pick', timestamp: '2026-10-01T10:00:00Z', 'agent-dispatch-log': [], 'work-is-done': true, 'pending-move': { from: 'pick', to: 'next', reason: 'exit' } }] })), 'return');
  assert.match(actionsOf(lines(open, wide)).join('\n'), /Approve\s+→ Risk Assessment/);
  assert.deepEqual(press(open, 'return').decide, ['ticket:approve-gate', 'p', 'ABC-7', 'A', 'pick']);
});

test('a choice that goes back where the work came from names that step: the return-to-state of the step that sent it, past any pass-through and any change within a state', () => {
  const steps = [
    { id: 'build', name: 'Build', sequence: 3, 'return-to-state': 'build', action: { type: 'prompt' } },
    { id: 'blocked', name: 'Blocked', sequence: 0, area: 'quarantine', 'follow-return-to-state': true, action: { type: 'state-engine', engine: 'blocked' } },
    { id: 'held', name: 'Blocked for Human', sequence: 0, area: 'quarantine', action: { type: 'human' }, 'exit-events': [{ condition: { 'human-review': 'Resolved' }, 'follow-return-to-state': true }] },
  ];
  const change = (from, to) => ({ 'from-state': from, 'to-state': to, timestamp: '2026-10-01T10:00:00Z', 'agent-dispatch-log': [] });
  // Changes within a state (sub-state-change) are passed over.
  const within = id => ({ ...change(id, id), 'sub-state-change': { 'state-engine': 'sub', 'from-state': 'a', 'to-state': 'b' } });
  const ticket = { key: 'ABC-6', title: 'Stuck', priority: 1, ...single({ 'harness-status': hs('held'), 'state-changes': [change('backlog', 'build'), within('build'), change('build', 'blocked'), within('blocked'), change('blocked', 'held'), within('held')] }) };
  const s = { ...initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'e', sprint: { ...sprint, features: [ticket], bugs: [], spikes: [] } }], workflows: [{ name: 'e', steps }] }), focus: 'tickets' };
  const open = press(s, 'return');
  assert.ok(actionsOf(lines(open, wide)).some(l => /Resolved\s+→ Build/.test(l)));
  assert.deepEqual(press(open, 'return').decide, ['ticket:human-review', 'p', 'ABC-6', 'A', 'held', 'Resolved', 'build']);
});

test('going back follows the history past every step that follows the return-to-state, to a step with neither field: that step itself', () => {
  const steps = [
    { id: 'done', name: 'Done', sequence: 32, action: { type: 'none' } },
    { id: 'blocked', name: 'Blocked', sequence: 0, area: 'quarantine', 'follow-return-to-state': true, action: { type: 'state-engine', engine: 'blocked' } },
    { id: 'held', name: 'Blocked for Human', sequence: 0, area: 'quarantine', 'follow-return-to-state': true, action: { type: 'human' }, 'exit-events': [
      { condition: { 'human-review': 'Resolved' }, 'follow-return-to-state': true },
      { condition: { 'human-review': 'Try Again' }, 'move-to-state': 'blocked' },
    ] },
  ];
  const change = (from, to) => ({ 'from-state': from, 'to-state': to, timestamp: '2026-10-01T10:00:00Z', 'agent-dispatch-log': [] });
  const ticket = { key: 'ABC-6', title: 'Stuck', priority: 1, ...single({ 'harness-status': hs('held'), 'state-changes': [change('qa', 'done'), change('done', 'held'), change('held', 'blocked'), change('blocked', 'held')] }) };
  const s = { ...initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'e', sprint: { ...sprint, features: [ticket], bugs: [], spikes: [] } }], workflows: [{ name: 'e', steps }] }), focus: 'tickets' };
  const open = press(s, 'return');
  assert.ok(actionsOf(lines(open, wide)).some(l => /Resolved\s+→ Done/.test(l)));
  assert.deepEqual(press(open, 'return').decide, ['ticket:human-review', 'p', 'ABC-6', 'A', 'held', 'Resolved', 'done']);
});

// Every ticket can have its priority set by hand: manual-priority, which load.js makes its priority.
const prioritised = (manual, extra = {}) => ({
  ...initialState({ projects: [{ ...detailProject, sprint: { ...sprint, features: [{ ...detailed, 'manual-priority': manual }], bugs: [], spikes: [] } }], workflows: [engine] }),
  focus: 'tickets', ...extra,
});
const typeIn = (s, text) => [...text].reduce((st, ch) => handleKey(st, { name: ch, sequence: ch }, wide), s);

test('the ticket screen shows the manual priority, and offers on its Actions tab to set it', () => {
  const shown = s => lines(onTab(press(s, 'return'), 'details'), { ...wide, rows: 80 }).join('\n');
  assert.match(shown(prioritised(null)), /Manual priority\s+—/);
  assert.match(shown(prioritised(3)), /Manual priority\s+3/);
  const out = lines(onTab(press(prioritised(null), 'return'), 'actions'), wide);
  assert.ok(actionsOf(out).some(l => l.includes('▸ Set manual priority')));
});

test('enter on Set manual priority opens its field, filled with the one set; digits type, enter saves it with ticket:set-manual-priority, esc cancels', () => {
  const open = press({ ...press(prioritised(3), 'return'), ticketTab: 'actions' }, 'return');
  assert.equal(open.priorityDraft, '3');
  assert.ok(actionsOf(lines(open, wide)).some(l => /Manual priority: 3█/.test(l)));
  const typed = typeIn(press(open, 'backspace'), 'x1 2');             // only digits are typed
  assert.equal(typed.priorityDraft, '12');
  const saved = press(typed, 'return');
  assert.deepEqual(saved.decide, ['ticket:set-manual-priority', 'example', 'ABC-5', '12']);
  assert.equal(saved.priorityDraft, null);
  assert.deepEqual(press(open, 'backspace', 'return').decide, ['ticket:set-manual-priority', 'example', 'ABC-5', '']);   // empty clears it
  const cancelled = press(open, 'escape');
  assert.equal(cancelled.priorityDraft, null);
  assert.equal(cancelled.decide, null);
  assert.ok(cancelled.ticket);                                       // still on the ticket screen
  assert.equal(press({ ...press(prioritised(null), 'return'), ticketTab: 'actions' }, 'return').priorityDraft, '');
  assert.ok(!press(open, 'space').pauses.human);              // space is not a pause while typing
});

test('the Priority column marks a priority set by hand with 🪪', () => {
  const row = s => lines(s, wide).find(l => l.includes('ABC-5'));
  const set = prioritised(1);
  set.projects[0].sprint.features[0].priority = 1;                    // as load.js gives it
  assert.match(row(set), /Detailed\s+1 🪪\s+Code Review/);
  assert.doesNotMatch(row(prioritised(null)), /🪪/);
});

test('on a past day the manual priority cannot be set', () => {
  const past = prioritised(null, { day: '2026-09-20' });
  past.projects[0].days = { '2026-09-20': past.projects[0].sprint };
  assert.equal(press(past, 'return', 'tab', 'return').priorityDraft, null);
});

test('the priority set by hand is the ticket\'s Priority on the dashboard and its screen', () => {
  const s = prioritised(1);
  s.projects[0].sprint.features[0].priority = 1;                      // as load.js gives it
  assert.match(lines(s, wide).find(l => l.includes('ABC-5')), /Detailed\s+1 🪪\s+Code Review/);
  assert.match(lines(press(s, 'return'), { ...wide, rows: 80 }).join('\n'), /Priority\s+1/);
});

// The states a ticket variation is gated on leaving, checked off on its screen.
const gatingSteps = [...transitionSteps, { id: 'fin', name: 'Finished', sequence: 9, 'is-done': true }];
const gating = (extra = {}) => ({ ...leaving(false, extra), workflows: [{ name: 'e', steps: gatingSteps }] });
const toGates = s => press({ ...press(s, 'return'), ticketTab: 'actions' }, 'down', 'return');   // past Set manual priority

test('the ticket screen lists the states the variation is gated on leaving, and offers to change them', () => {
  const open = press(gating(), 'return');
  assert.match(lines(onTab(open, 'details'), { ...wide, rows: 80 }).join('\n'), /Gates\s+Generate Solution/);
  assert.ok(actionsOf(lines(onTab(open, 'actions'), wide)).some(l => l.includes('Gate when leaving states')));
});

test('Gate when leaving states checks off the steps a ticket can leave — no quarantine, nothing past done — the ones it has checked', () => {
  const open = toGates(gating());
  assert.deepEqual(open.gatesDraft, { ids: ['e/gen'], at: 0 });
  const right = actionsOf(lines(open, wide)).join('\n');
  assert.match(right, /▸ \[x\] Generate Solution/);
  assert.match(right, /  \[ \] Automated Testing/);
  assert.doesNotMatch(right, /Blocked|Finished/);
});

test('in the checklist ↑/↓ move, space checks and unchecks, enter saves with ticket:set-gate-when-leaving-state in step order, esc cancels', () => {
  const open = toGates(gating());
  const checked = press(open, 'down', 'space', 'up', 'space');
  assert.deepEqual(checked.gatesDraft, { ids: ['e/work'], at: 0 });
  assert.ok(!checked.pauses.human);                           // space is not a pause here
  assert.deepEqual(press(checked, 'down', 'down').gatesDraft.at, 1);  // no further than the last
  const both = press(open, 'down', 'space');
  const saved = press(both, 'return');
  assert.deepEqual(saved.decide, ['ticket:set-gate-when-leaving-state', 'p', 'ABC-6', 'A', 'e/gen', 'e/work']);
  assert.equal(saved.gatesDraft, null);
  assert.deepEqual(press(open, 'space', 'return').decide, ['ticket:set-gate-when-leaving-state', 'p', 'ABC-6', 'A']);   // none: cleared
  const cancelled = press(both, 'escape');
  assert.equal(cancelled.gatesDraft, null);
  assert.equal(cancelled.decide, null);
  assert.ok(cancelled.ticket);
});

test('on a past day neither an approval nor the states gated on leaving can be recorded', () => {
  const past = s => { s.projects[0].days = { '2026-09-20': s.projects[0].sprint }; return s; };
  assert.equal(press(past(leaving(true, { day: '2026-09-20' })), 'return', 'return').decide, null);   // Approve State Transition
  assert.equal(toGates(past(gating({ day: '2026-09-20' }))).gatesDraft, null);
});

test('each variation to go with links to its merge request', () => {
  const s = choosing(twoWays(
    { name: 'A', 'harness-status': hs('pick'), 'merge-request': [{ key: '!11', url: 'http://mr/11' }, { key: '!12', url: 'http://mr/12' }] },
    { name: 'B', 'harness-status': hs('pick'), 'merge-request': [{ key: '!21', url: 'http://mr/21' }] },
  ));
  const out = render(press(s, 'return'), wide).join('\n');
  assert.ok(out.includes(link('Go with ABC-7.A', 'http://mr/11')));   // its first merge request
  assert.ok(out.includes(link('Go with ABC-7.B', 'http://mr/21')));
  const none = render(press(choosing(twoWays({ name: 'A', 'harness-status': hs('pick') }, { name: 'B', 'harness-status': hs('pick') })), 'return'), wide).join('\n');
  assert.ok(none.includes('Go with ABC-7.A') && !none.includes('\x1b]8;;\x1b\\Go with'));   // no merge request: no link
});

test('the flowchart is boxed under its choice of view; ↑/↓ scroll it, focused or not (ASS-263), with a scrollbar thumb in the box\'s right border', () => {
  const tall = { ...wide, columns: 60, rows: 44 };                    // a station a row: taller than the box
  const steps = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, name: `Station ${i}`, sequence: i + 1 }));
  const st = { ...dayState, workflows: [{ name: 'example-development', steps }] };
  const press = (s, ...names) => names.reduce((at, name) => handleKey(at, key(name), tall), s);
  const opened = handleKey(st, key('S'));
  const out = lines(opened, tall);
  const head = out.findIndex(l => l.startsWith('Show:'));
  const top = out.findIndex((l, i) => i > head && l.startsWith('┌'));
  assert.equal(top, head + 3);                                        // the choice, its hint and a blank line, then the box
  assert.equal(out[top].length, tall.columns);
  const bottom = out.findIndex((l, i) => i > top && l.startsWith('└'));
  const thumb = st => lines(st, tall).slice(top + 1, bottom).map(l => l.at(-1) === '█');
  assert.equal(thumb(opened).indexOf(true), 0);
  const focused = press(opened, 'tab', 'tab');
  assert.ok(lines(focused, tall).some(l => l.includes('↑/↓ scroll')));
  const first = st => lines(st, tall)[top + 1];
  assert.notEqual(first(press(focused, 'down')), first(focused));
  assert.deepEqual(press(focused, 'up'), focused);                    // already at the top
  const end = press(focused, ...Array(300).fill('down'));
  assert.equal(thumb(end).lastIndexOf(true), bottom - top - 2);
  assert.deepEqual(press(end, 'down'), end);                          // no further than the last line
  assert.equal(press(opened, 'down').flowchartScroll, 1);             // the menu's focus too (ASS-263)
  assert.equal(press(end, 'tab', 'right').flowchartScroll, 0);        // a new project starts at the top
});

test('ASS-185 AC4: the Details tab shows the whole description — no 300-character cut', () => {
  const screenOf = description => {
    const s = { ...onGrid, projects: [{ ...detailProject, sprint: { ...detailProject.sprint, features: [{ ...detailed, description }] } }] };
    const fields = tabOf(lines(onTab(press(s, 'return'), 'details'), { ...wide, rows: 80 }));
    const from = fields.findIndex(f => f.startsWith('Description'));
    const shown = [];
    for (let i = from; fields[i] !== ''; i++) shown.push(fields[i].replace(/^Description/, '').trim());
    return shown.join(' ');
  };
  const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');          // 800-odd characters
  assert.equal(screenOf(long), long);
  assert.equal(screenOf(long.slice(0, 300)), long.slice(0, 300));
});

// The backlog screen (ASS-20): the selected project's backlog in refinement order, a grid you move through and open.
// The backlog refinement engine as the dashboard loads engines/example-backlog-refinement (load.js loadWorkflows), and
// the execution engine whose backlog-refinement-steps names it: where a backlog ticket sits (ASS-144); the History tab lists its steps.
const refinementEngine = (() => {
  const loaded = JSON.parse(readFileSync(join(engineDir('example-backlog-refinement'), 'state-engine.json'), 'utf8'));
  // ASS-258: the steps the tests below name shown by these names, whatever the engine calls them — these test the screen, not the engine's wording.
  const NAMES = { groom: 'Groom', 'awaiting-answers': 'Awaiting Answers', estimate: 'Estimate', 'awaiting-approval': 'Awaiting Approval', ready: 'Ready' };
  return { name: 'example-backlog-refinement', steps: loaded.steps.toSorted((a, b) => a.sequence - b.sequence).map(s => ({ ...s, name: NAMES[s.id] ?? s.name })), lists: {} };
})();
const refiningEngine = { ...engine, lists: { 'backlog-refinement-steps': [{ id: 'backlog-refinement', sequence: 1, name: 'Backlog Refinement', action: { type: 'state-engine', engine: 'example-backlog-refinement' } }] } };
const backlogTicket = (key, state, extra = {}) => ({ key, title: `Title ${key}`, priority: Number(key.split('-')[1]), 'manual-backlog-priority': null, 'ticket-system-assignment': 'Alice', variations: [{ name: 'A', 'harness-status': { state, 'state-engine': 'example-backlog-refinement' } }], ...extra });
const withBacklog = (tickets, extra = {}) => initialState({ projects: [{ ...projects[0], backlog: tickets }, projects[1]], workflows: [refiningEngine, refinementEngine], assignments, ...extra });

test('b shows the backlog as a grid in refinement order — ticket, priority, points, refinement, assignee, agents — focused, the selection in reverse video', () => {
  const s = handleKey(withBacklog([backlogTicket('ABC-60', 'groom'), backlogTicket('ABC-61', 'ready', { 'manual-backlog-priority': 1 }), backlogTicket('ABC-62', 'awaiting-approval'), backlogTicket('ABC-64', 'awaiting-answers')]), key('b'));
  assert.equal(s.focus, 'backlog');
  const out = lines(s, wide);
  const header = out.find(l => /│ +Ticket +│/.test(l));
  assert.ok(header && /Priority +│ +Points +│ +State/.test(header) && /Assignee/.test(header) && /Agents/.test(header), header);
  const rows = out.filter(l => /ABC-6\d/.test(l));
  assert.deepEqual(rows.map(l => l.match(/ABC-6\d/)[0]), ['ABC-61', 'ABC-62', 'ABC-64', 'ABC-60']);    // closest to Ready first (ASS-56)
  assert.match(rows.find(l => l.includes('ABC-64')), / Awaiting Answers /);                  // the step's name from its engine (ASS-150)
  assert.match(rows[0], / Ready /);
  assert.match(lines(handleKey(withBacklog([backlogTicket('ABC-60', 'groom', { points: 3 })]), key('b')), wide).find(l => l.includes('ABC-60')), / 60 +3 +Groom /);
  assert.match(rows.find(l => l.includes('ABC-62')), / Awaiting Approval /);
  assert.match(rows.find(l => l.includes('ABC-60')), / Groom /);
  const raw = st => render(st, wide).filter(l => /ABC-6\d/.test(l));
  assert.ok(raw(s)[0].includes('\x1b[7m'));                                                  // selected
  const down = press(s, 'down');
  assert.ok(raw(down).find(l => l.includes('ABC-62')).includes('\x1b[7m'));
});

test('the backlog grid shows a ticket\'s manual-backlog-priority with 🪪, never the sprint\'s manual-priority (ASS-100 AC5)', () => {
  const out = lines(handleKey(withBacklog([backlogTicket('ABC-60', 'groom', { priority: 2, 'manual-backlog-priority': 2 }), backlogTicket('ABC-61', 'groom', { priority: 1, 'manual-priority': 1 })]), key('b')), wide);
  assert.match(out.find(l => l.includes('ABC-60')), / 2 🪪/);
  assert.doesNotMatch(out.find(l => l.includes('ABC-61')), /🪪/);
});

test('the backlog screen\'s number for each ticket is its place in the list it shows, once control has renumbered it (ASS-84 AC2)', () => {
  const list = [backlogTicket('ABC-60', 'groom'), backlogTicket('ABC-61', 'ready', { 'sprint-tag': 'Sprint 2' }), backlogTicket('ABC-62', 'groom', { 'manual-backlog-priority': 2 }), backlogTicket('ABC-63', 'groom', { 'ticket-system-priority': 'High' })];
  const priorities = backlogPriorities(list);
  const out = lines(handleKey(withBacklog(list.map(t => ({ ...t, priority: priorities[t.key] }))), key('b')), wide);
  const numbers = out.filter(l => /ABC-6\d/.test(l)).map(l => Number(l.match(/ABC-6\d: Title ABC-6\d\s+(?:│\s+)?(\d+)/)[1]));
  assert.deepEqual(numbers, [1, 2, 3, 4]);
});

test('a backlog ticket\'s screen shows its manual-backlog-priority and offers Set manual priority in every refinement state, saved with ticket:set-manual-backlog-priority (ASS-100 AC5)', () => {
  for (const state of ['groom', 'awaiting-approval', 'ready']) {
    const opened = press(handleKey(withBacklog([backlogTicket('ABC-60', state, { 'manual-backlog-priority': 4, 'manual-priority': 9 })]), key('b')), 'return');
    const out = lines(onTab(opened, 'details'), { ...wide, rows: 80 });
    assert.ok(out.some(l => /Manual priority\s+4/.test(l)), out.join('\n'));
    assert.ok(panelOf(out).includes('Priority 4 🪪 · Points —'), state);
    assert.ok(actionsOf(lines(onTab(opened, 'actions'), wide)).some(l => l.includes('Set manual priority')), state);
    const open = press({ ...opened, ticketTab: 'actions', ticketChoice: state === 'awaiting-approval' ? 2 : 0 }, 'return');   // after Accept and Reject
    assert.equal(open.priorityDraft, '4', state);
    assert.deepEqual(press(typeIn(press(open, 'backspace'), '1'), 'return').decide, ['ticket:set-manual-backlog-priority', 'example', 'ABC-60', '1']);
  }
});

test('on the backlog, enter opens the ticket screen; esc returns with the same selection; one at Awaiting Approval offers its exits, Accept, and Reject, which asks for the reason — ticket:human-review, which moves it at once (ASS-34, ASS-144)', () => {
  const s = handleKey(withBacklog([backlogTicket('ABC-60', 'groom'), backlogTicket('ABC-62', 'awaiting-approval')]), key('b'));   // ABC-62 first (ASS-56)
  const opened = press(s, 'return');
  assert.deepEqual(opened.ticket, { key: 'ABC-62', variation: 'A', backlog: true });
  const out = lines(opened, wide);
  assert.ok(out.some(l => l.includes('esc returns to the backlog')), out.join('\n'));
  assert.ok(out.some(l => l.includes('Accept')) && out.some(l => l.includes('Reject')), out.join('\n'));
  const choosing = { ...opened, ticketTab: 'actions' };
  assert.deepEqual(press(choosing, 'return').decide, ['ticket:human-review', 'example', 'ABC-62', 'A', 'awaiting-approval', 'Accept', 'ready']);
  const asking = press(choosing, 'down', 'return');
  assert.equal(asking.decide, null);
  assert.ok(lines(asking, wide).some(l => l.includes('Reason: █')), lines(asking, wide).join('\n'));
  assert.equal(press(asking, 'return').decide, null);                                          // no reason: nothing sent
  const typed = [...'AC3 vague'].reduce((st, c) => handleKey(st, key(c === ' ' ? 'space' : c, { sequence: c }), wide), asking);
  assert.ok(lines(typed, wide).some(l => l.includes('Reason: AC3 vague█')));
  const rejected = press(press(typed, 'backspace'), 'return');
  assert.deepEqual([rejected.decide, rejected.reasonDraft], [['ticket:human-review', 'example', 'ABC-62', 'A', 'awaiting-approval', 'Reject', 'groom', 'AC3 vagu'], null]);
  assert.equal(press(typed, 'escape').reasonDraft, null);                                       // esc gives up
  const back = press(opened, 'escape');
  assert.deepEqual([back.screen, back.ticket, back.backlogSelected, back.focus], ['b', null, 0, 'backlog']);
  assert.ok(!lines(press(press(s, 'down'), 'return'), wide).some(l => l.includes('Accept')));   // grooming: nothing to decide
});

// ASS-252: the harness's refinement, at Awaiting Split Decision, shows the
// proposal Split's agent recorded and offers its exits: Accept, Reject (asking
// why) and Keep whole.
test('ASS-252 AC2, AC3: a backlog ticket at Awaiting Split Decision shows the proposed tickets — points, what they cover, their dependencies and criteria — and offers Accept, Reject with a reason, and Keep whole', () => {
  const loaded = JSON.parse(readFileSync(join(engineDir('harness-backlog-refinement'), 'state-engine.json'), 'utf8'));
  const harnessRefinement = { name: 'harness-backlog-refinement', steps: loaded.steps.toSorted((a, b) => a.sequence - b.sequence), lists: {} };
  const harnessRefining = { ...engine, lists: { 'backlog-refinement-steps': [{ id: 'backlog-refinement', sequence: 1, name: 'Backlog Refinement', action: { type: 'state-engine', engine: 'harness-backlog-refinement' } }] } };
  const proposal = { ticket: 'ABC-62', summary: 'two halves', tickets: [
    { title: 'First half', type: 'Story', points: 2, 'user-story': 'As the operator, I want the first half.', context: 'c', 'acceptance-criteria': ['First works'], covers: [1], 'depends-on': [] },
    { title: 'Second half', type: 'Story', points: 3, 'user-story': 'As the operator, I want the second half.', context: 'c', 'acceptance-criteria': ['Second works', 'AC2: tested'], covers: [2, 3], 'depends-on': [1, 'ABC-9'] },
  ] };
  const ticket = { ...backlogTicket('ABC-62', 'awaiting-split-decision'), variations: [{ name: 'A', 'harness-status': { state: 'awaiting-split-decision', 'state-engine': 'harness-backlog-refinement' } }] };
  const s = initialState({ projects: [{ ...projects[0], backlog: [ticket], reviews: { 'ABC-62': { split: proposal } } }, projects[1]], workflows: [harnessRefining, harnessRefinement], assignments });
  const opened = { ...press(handleKey(s, key('b')), 'return'), ticketTab: 'actions' };
  const out = actionsOf(lines(opened, { ...wide, rows: 80 }));
  const text = out.join('\n');
  for (const want of ['Accept', 'Reject', 'Keep whole', 'Split proposal', 'two halves', '1. First half · 2 points · covers AC1', '2. Second half · 3 points · covers AC2, AC3 · depends on 1, ABC-9', 'As the operator, I want the second half.', 'AC2: tested'])
    assert.ok(text.includes(want), `${want}\n${text}`);
  assert.deepEqual(press(opened, 'return').decide, ['ticket:human-review', 'example', 'ABC-62', 'A', 'awaiting-split-decision', 'Accept', 'create-split-tickets']);
  assert.deepEqual(press(opened, 'down', 'down', 'return').decide, ['ticket:human-review', 'example', 'ABC-62', 'A', 'awaiting-split-decision', 'Keep whole', 'keep-whole']);
  const asking = press(opened, 'down', 'return');
  assert.equal(asking.decide, null);
  const typed = [...'too fine'].reduce((st, c) => handleKey(st, key(c === ' ' ? 'space' : c, { sequence: c }), wide), asking);
  assert.deepEqual(press(typed, 'return').decide, ['ticket:human-review', 'example', 'ABC-62', 'A', 'awaiting-split-decision', 'Reject', 'split', 'too fine']);
  // No proposal recorded: the gate says so.
  const none = initialState({ projects: [{ ...projects[0], backlog: [ticket] }, projects[1]], workflows: [harnessRefining, harnessRefinement], assignments });
  assert.ok(actionsOf(lines({ ...press(handleKey(none, key('b')), 'return'), ticketTab: 'actions' }, wide)).some(l => l.includes('no proposal recorded yet')));
});

// ASS-264: the family's refinement rests a ticket estimated above its scale at Too Large: the ticket
// screen offers its exits as example's Awaiting Approval's — Accept, and Return, which asks for the
// operator's note — and its details and panel show the estimate noted (ticket:note-too-large).
test('ASS-264 AC2: a family ticket at Too Large offers Accept, to Ready, and Return with a note, to Groom, and shows the estimate it was given', () => {
  const loaded = JSON.parse(readFileSync(join(engineDir('family-backlog-refinement'), 'state-engine.json'), 'utf8'));
  const familyRefinement = { name: 'family-backlog-refinement', steps: loaded.steps.toSorted((a, b) => a.sequence - b.sequence), lists: {} };
  const familyRefining = { ...engine, lists: { 'backlog-refinement-steps': [{ id: 'backlog-refinement', sequence: 1, name: 'Backlog Refinement', action: { type: 'state-engine', engine: 'family-backlog-refinement' } }] } };
  const ticket = { ...backlogTicket('ABC-62', 'too-large', { points: null, 'too-large-estimate': { points: 13, 'noted-at': '2026-10-30T10:00:00Z' } }),
    variations: [{ name: 'A', 'harness-status': { state: 'too-large', 'state-engine': 'family-backlog-refinement' } }] };
  const s = initialState({ projects: [{ ...projects[0], backlog: [ticket] }, projects[1]], workflows: [familyRefining, familyRefinement], assignments });
  assert.match(lines(handleKey(s, key('b')), wide).find(l => l.includes('ABC-62')), / Too Large /);
  const opened = { ...press(handleKey(s, key('b')), 'return'), ticketTab: 'actions' };
  const out = actionsOf(lines(opened, { ...wide, rows: 80 }));
  assert.ok(out.some(l => l.includes('Accept')) && out.some(l => l.includes('Return')), out.join('\n'));
  assert.deepEqual(press(opened, 'return').decide, ['ticket:human-review', 'example', 'ABC-62', 'A', 'too-large', 'Accept', 'ready']);
  const asking = press(opened, 'down', 'return');
  assert.equal(asking.decide, null);
  assert.ok(lines(asking, wide).some(l => l.includes('Reason: █')), lines(asking, wide).join('\n'));
  const typed = [...'drop AC3'].reduce((st, c) => handleKey(st, key(c === ' ' ? 'space' : c, { sequence: c }), wide), asking);
  assert.deepEqual(press(typed, 'return').decide, ['ticket:human-review', 'example', 'ABC-62', 'A', 'too-large', 'Return', 'groom', 'drop AC3']);
  // The estimate noted: in the details, and beneath the points in the panel.
  const details = lines(onTab(opened, 'details'), { ...wide, rows: 80 });
  assert.ok(details.some(l => /Estimated too large\s+13 points/.test(l)), details.join('\n'));
  assert.ok(panelOf(details).some(l => l === 'Estimated too large: 13'), panelOf(details).join('\n'));
});

// ASS-265: the family's Too Large offers Split too, asking for no note; Split's proposal then rests at the
// family's Awaiting Split Decision, shown as ASS-252 shows the harness's, Accept applying it and Reject
// (asking why) going back to Too Large.
test('ASS-265 AC1, AC2: a family ticket at Too Large offers Split beside Accept and Return; at Awaiting Split Decision it shows the proposal and offers Accept and Reject, back to Too Large', () => {
  const loaded = JSON.parse(readFileSync(join(engineDir('family-backlog-refinement'), 'state-engine.json'), 'utf8'));
  const familyRefinement = { name: 'family-backlog-refinement', steps: loaded.steps.toSorted((a, b) => a.sequence - b.sequence), lists: {} };
  const familyRefining = { ...engine, lists: { 'backlog-refinement-steps': [{ id: 'backlog-refinement', sequence: 1, name: 'Backlog Refinement', action: { type: 'state-engine', engine: 'family-backlog-refinement' } }] } };
  const at = state => ({ ...backlogTicket('ABC-62', state, { points: null }), variations: [{ name: 'A', 'harness-status': { state, 'state-engine': 'family-backlog-refinement' } }] });
  const proposal = { ticket: 'ABC-62', summary: 'two halves', tickets: [
    { title: 'First half', type: 'Story', points: 2, 'user-story': 'As the operator, I want the first half.', context: 'c', 'acceptance-criteria': ['First works'], covers: [1], 'depends-on': [] },
    { title: 'Second half', type: 'Story', points: 3, 'user-story': 'As the operator, I want the second half.', context: 'c', 'acceptance-criteria': ['Second works'], covers: [2, 3], 'depends-on': [1] },
  ] };
  const open = (state, reviews = {}) => {
    const s = initialState({ projects: [{ ...projects[0], backlog: [at(state)], reviews }, projects[1]], workflows: [familyRefining, familyRefinement], assignments });
    return { ...press(handleKey(s, key('b')), 'return'), ticketTab: 'actions' };
  };
  // Too Large: Accept, Return, Split — Split at once, no note asked.
  const large = open('too-large');
  const choices = actionsOf(lines(large, { ...wide, rows: 80 }));
  for (const want of ['Accept', 'Return', 'Split']) assert.ok(choices.some(l => l.includes(want)), `${want}\n${choices.join('\n')}`);
  assert.deepEqual(press(large, 'down', 'down', 'return').decide, ['ticket:human-review', 'example', 'ABC-62', 'A', 'too-large', 'Split', 'split']);
  // Awaiting Split Decision: the proposal beneath Accept and Reject.
  const gate = open('awaiting-split-decision', { 'ABC-62': { split: proposal } });
  const text = actionsOf(lines(gate, { ...wide, rows: 80 })).join('\n');
  for (const want of ['Accept', 'Reject', 'Split proposal', 'two halves', '1. First half · 2 points · covers AC1', '2. Second half · 3 points · covers AC2, AC3 · depends on 1'])
    assert.ok(text.includes(want), `${want}\n${text}`);
  assert.ok(!text.includes('Keep whole'), text);
  assert.deepEqual(press(gate, 'return').decide, ['ticket:human-review', 'example', 'ABC-62', 'A', 'awaiting-split-decision', 'Accept', 'create-split-tickets']);
  const asking = press(gate, 'down', 'return');
  assert.equal(asking.decide, null);
  const typed = [...'too fine'].reduce((st, c) => handleKey(st, key(c === ' ' ? 'space' : c, { sequence: c }), wide), asking);
  assert.deepEqual(press(typed, 'return').decide, ['ticket:human-review', 'example', 'ABC-62', 'A', 'awaiting-split-decision', 'Reject', 'too-large', 'too fine']);
});

test('the backlog scrolls when its tickets do not all fit, with a scrollbar', () => {
  const many = Array.from({ length: 60 }, (_, i) => backlogTicket(`ABC-${100 + i}`, 'groom'));
  const s = handleKey(withBacklog(many), key('b'));
  assert.ok(lines(s, wide).some(l => l.endsWith('█')));
  const end = press(s, ...Array(80).fill('down'));
  assert.ok(lines(end, wide).some(l => l.includes('ABC-159')));
});

test('the control screen shows the selected project\'s control output only — and the downloader\'s — with that control\'s log file (ASS-9)', () => {
  const at = new Date('2026-10-06T14:31:05Z');
  const controlLog = [
    { text: 'steps ABC-3 A plan → build', stream: 'stdout', at, project: 'example' },
    { text: 'steps S-1 A plan → build', stream: 'stdout', at, project: 'assassin' },
    { text: 'downloader  synced 3 tickets', stream: 'stdout', at },
  ];
  const s = { ...state, screen: 'c', controlLog, controlLogFiles: { 'example': '/home/me/.harness/logs/control-example.log', assassin: '/home/me/.harness/logs/control-assassin.log' } };
  const out = lines(s, wide);
  assert.ok(out.some(l => l.includes('ABC-3 A plan → build')));
  assert.ok(!out.some(l => l.includes('S-1 A plan')));
  assert.ok(out.some(l => l.includes('downloader  synced 3 tickets')));
  assert.ok(out.some(l => l === 'log: /home/me/.harness/logs/control-example.log'), out.join('\n'));
  const other = lines(handleKey({ ...s, focus: 'menu', menuHidden: false }, key('right')), wide);
  assert.ok(other.some(l => l.includes('S-1 A plan')) && !other.some(l => l.includes('ABC-3 A plan')));
});

// Screen hotkeys (ASS-23): each list paired with its flow — s/S (ASS-103), b/B — and f the sub-flows.
// A shifted letter as node:readline gives it: the lower-case name, shift, the upper-case sequence.
const shifted = letter => key(letter, { shift: true, sequence: letter.toUpperCase() });
const plain = letter => key(letter, { sequence: letter });

test('ASS-103 AC1–AC3: the menu lists the screens s S b B c f m r u a x h — no questions, no p or o (ASS-262) — then space and !, / and Q', () => {
  assert.deepEqual(menuOf(state).map(e => e.split(' ')[0]), [...'sSbBcfmruaxh', 'A', 'space', '!', '/', 'Q', '⦿', '⦿', '⦿', '⚉', '✦']);   // A in its own group (ASS-188, ASS-246); the marks' legend (ASS-248, ASS-259)
});

test('ASS-103 AC1–AC3: s opens the sprint and S the sprint flow; d, D and q open nothing', () => {
  assert.equal(handleKey({ ...state, screen: 'b' }, plain('s')).screen, 's');
  assert.equal(handleKey(state, shifted('s')).screen, 'S');
  for (const k of [plain('d'), shifted('d'), plain('q')]) assert.equal(handleKey({ ...state, screen: 'b' }, k).screen, 'b', k.sequence);
});

// The feature flags (ASS-262): the chat screen (chat-screen) and the ticket
// screen's Chat tab (ticket-chat-tab), each there only with its flag on.
test('ASS-262 AC1: p and o are gone — in no menu, and pressing them opens nothing, the flags on or off', () => {
  for (const s of [state, flagsOff(state)]) {
    assert.ok(!menuOf(s).some(e => /^[po] /.test(e)), menuOf(s).join('|'));
    for (const k of 'po') assert.equal(handleKey({ ...s, screen: 'b' }, plain(k)).screen, 'b', k);
    assert.equal(handleKey({ ...s, menuOpen: true }, plain('p')).menuOpen, true);   // not a menu key either
  }
});

test('ASS-262 AC3: with chat-screen off, x is not in the menu and pressing it does nothing; with it on, x opens the chat screen, after a', () => {
  const off = flagsOff(state);
  assert.deepEqual(menuOf(off).map(e => e.split(' ')[0]), [...'sSbBcfmruah', 'A', 'space', '!', '/', 'Q', '⦿', '⦿', '⦿', '⚉', '✦']);
  assert.equal(handleKey({ ...off, screen: 'b' }, plain('x')).screen, 'b');
  assert.equal(handleKey({ ...off, menuOpen: true }, plain('x')).menuOpen, true);   // not a menu key either
  const on = flagsOff(state, { 'chat-screen': true });
  assert.deepEqual(menuOf(on).slice(0, 12).map(e => e.split(' ')[0]), [...'sSbBcfmruaxh']);
  assert.deepEqual([handleKey(on, plain('x')).screen, handleKey(on, plain('x')).focus], ['x', 'chats']);
  assert.equal(handleKey(flagsOff(state, { 'ticket-chat-tab': true }), plain('x')).screen, 's');   // each flag on its own
});

test('ASS-262 AC4: with ticket-chat-tab off, the ticket screen shows Actions, Details, History and Questions numbered 1–4, 5 does nothing, and its chat is never asked for', () => {
  const open = press(flagsOff(onGrid), 'return');
  assert.equal(open.ticketChatOpen, null);                   // no briefing sent (collaboration.js)
  assert.equal(open.ticketTab, 'details');                   // nothing waits: Details, in Chat's place
  const out = lines(open, wide);
  assert.match(out.find(l => l.startsWith('┌ 1 Actions')), /^┌ 1 Actions │ 2 Details │ 3 History │ 4 Questions ─+┬ Ticket ─+┐$/);
  assert.ok(out.some(l => l.includes('tab or 1-4 switch tabs')), out.join('\n'));
  assert.equal(handleKey(open, key('5', { sequence: '5' }), wide), open);
  assert.equal(handleKey(open, key('4', { sequence: '4' }), wide).ticketTab, 'questions');
  assert.equal(handleKey(onTab(open, 'questions'), key('tab'), wide).ticketTab, 'actions');                    // round again, past no Chat
  assert.equal(handleKey(onTab(open, 'actions'), key('tab', { shift: true }), wide).ticketTab, 'questions');
  assert.equal(press(handleKey(flagsOff(withBacklog([backlogTicket('ABC-60', 'groom')])), key('b')), 'return').ticketChatOpen, null);
  assert.equal(press(flagsOff(onGrid, { 'chat-screen': true }), 'return').ticketTab, 'details');   // each flag on its own
});

test('ASS-262 AC4: with ticket-chat-tab on, the Chat tab is fifth and opened on, and the ticket\'s chat asked for, as before', () => {
  const open = press(flagsOff(onGrid, { 'ticket-chat-tab': true }), 'return');
  assert.deepEqual(open.ticketChatOpen, { project: 'example', key: 'ABC-5' });
  assert.equal(open.ticketTab, 'chat');
  assert.match(lines(open, wide).find(l => l.startsWith('┌ 1 Actions')), /^┌ 1 Actions │ 2 Details │ 3 History │ 4 Questions │ 5 Chat ─+┬ Ticket ─+┐$/);
  assert.equal(handleKey(onTab(open, 'details'), key('5', { sequence: '5' }), wide).ticketTab, 'chat');
});

test('S opens the sprint flow and B the backlog flow, told apart from s and b; f opens the sub-flows; A the agents for all projects (ASS-246); w and every other shifted letter open nothing', () => {
  assert.equal(handleKey(state, shifted('s')).screen, 'S');
  assert.equal(handleKey(state, plain('s')).screen, 's');
  assert.equal(handleKey(state, shifted('b')).screen, 'B');
  assert.equal(handleKey(state, plain('b')).screen, 'b');
  assert.deepEqual([handleKey(state, plain('f')).screen, handleKey(state, plain('f')).focus], ['f', 'subflows']);
  for (const letter of 'wfcdomrpu') assert.equal(handleKey(state, shifted(letter)).screen, state.screen, letter.toUpperCase());
  assert.equal(handleKey(state, shifted('a')).screen, 'A');   // A beside a (ASS-246)
  assert.equal(handleKey(state, plain('w')).screen, state.screen);
  assert.ok(lines(handleKey(dayState, shifted('s')), wide).some(l => l.startsWith('Show:')));   // the old flowchart, unchanged
});

test('ASS-192 AC3: B marks a switched-off refinement step ("is-active": false) off in its station\'s top border, dimmed; the others are not', () => {
  const off = { ...refinementEngine, steps: refinementEngine.steps.map(st => (st.id === 'awaiting-answers' ? { ...st, 'is-active': false } : st)) };
  const s = handleKey(initialState({ projects: [{ ...projects[0], backlog: [backlogTicket('ABC-60', 'groom')] }, projects[1]], workflows: [refiningEngine, off], assignments }), shifted('b'));
  const n = off.steps.find(st => st.id === 'awaiting-answers').sequence;
  const tops = lines(s, wide).filter(l => l.includes('┌─ '));
  assert.deepEqual(tops.flatMap(l => [...l.matchAll(/┌─ (\d+) ─*( off ─)?/g)].filter(m => m[2]).map(m => Number(m[1]))), [n]);
  assert.ok(render(s, wide).some(l => l.includes('\x1b[2m┌─ ' + n + ' ')));
});

test('ASS-209 AC1: B and S mark a step the selected project\'s switched-off-steps lists off, as ASS-192\'s "is-active": false — for that project only', () => {
  const offAt = (s, k) => lines(handleKey(s, k), wide).filter(l => l.includes('┌─ ')).flatMap(l => [...l.matchAll(/┌─ (\d+) ─*( off ─)?/g)].filter(m => m[2]).map(m => Number(m[1])));
  const listed = ['example-backlog-refinement/awaiting-answers', 'example-development/code-review'];
  const of = switchedOffSteps => initialState({ projects: [{ ...projects[0], switchedOffSteps, backlog: [backlogTicket('ABC-60', 'groom')] }, projects[1]], workflows: [refiningEngine, refinementEngine], assignments });
  assert.deepEqual(offAt(of(listed), shifted('b')), [refinementEngine.steps.find(st => st.id === 'awaiting-answers').sequence]);
  assert.deepEqual(offAt(of(listed), shifted('s')), [13]);
  assert.deepEqual(offAt(of([]), shifted('b')), []);
  assert.deepEqual(offAt(of(undefined), shifted('s')), []);
});

test('B draws the backlog as the steps of its refinement engine, in sequence, as stations (ASS-144) — each with its tickets in backlog order and their priority; focused, scrolling on its own', () => {
  const s = handleKey(withBacklog([backlogTicket('ABC-60', 'groom'), backlogTicket('ABC-61', 'ready', { 'manual-backlog-priority': 1, url: 'http://t/ABC-61' }), backlogTicket('ABC-62', 'groom'), backlogTicket('ABC-63', 'awaiting-approval'), backlogTicket('ABC-64', 'awaiting-answers')]), shifted('b'));
  assert.equal(s.focus, 'backlogflow');
  const out = lines(s, wide);
  const names = out.find(l => l.includes('Groom'));
  assert.ok(/Groom .*═▶.*Awaiting Answers .*═▶.*Check the Answers/.test(names), names);
  assert.ok(out.some(l => /Ready .*◀═.*Awaiting Approval/.test(l)), out.join('\n'));
  assert.ok(out.some(l => /┌─ 7 /.test(l)) && !out.some(l => /┌─ 8 /.test(l)), out.join('\n'));     // numbered 1–7
  assert.ok(out.some(l => l.includes('ABC-64: Title ABC-64 64')));
  assert.ok(out.some(l => /┌─ 1 .*2 tickets/.test(l)) || out.some(l => /┌─ 1 /.test(l)), out.join('\n'));
  const at = id => out.findIndex(l => l.includes(id));
  assert.ok(at('ABC-60: Title ABC-60 60') > 0 && at('ABC-60') < at('ABC-62'));        // backlog order, priority after
  assert.ok(out.some(l => l.includes('ABC-61: Title ABC-61 1 🪪')));
  assert.ok(render(s, wide).some(l => l.includes('\x1b]8;;http://t/ABC-61\x1b\\')));
  assert.ok(!out.some(l => l.includes('↺n back to station n')));                         // no floor legend
  assert.ok(out.some(l => l.includes('↑/↓ scroll')));
  const many = handleKey(withBacklog(Array.from({ length: 60 }, (_, i) => backlogTicket(`ABC-${100 + i}`, 'groom'))), shifted('b'));
  const down = press(many, 'down', 'down');
  assert.equal(down.backlogFlowScroll, 2);
  assert.equal(handleKey(handleKey(down, shifted('s')), shifted('b')).backlogFlowScroll, 2);   // its place kept
  const empty = lines(handleKey(withBacklog([]), shifted('b')), wide);
  assert.ok(empty.some(l => /Groom .*Awaiting Answers .*Check the Answers/.test(l)));  // the stations, empty
});

test('B offers the same two views as S — Tickets and Run-time metrics — chosen with ←/→ when focused, its own choice; the metrics come from the backlog tickets\' refinement histories', () => {
  const moved = (from, to, at) => ({ 'state-engine': 'example-backlog-refinement', 'from-state': from, 'to-state': to, timestamp: at, 'agent-dispatch-log': [], 'work-is-done': true });
  const groomed = backlogTicket('ABC-70', 'awaiting-answers', { variations: [{ name: 'A', 'harness-status': { state: 'awaiting-answers', 'state-engine': 'example-backlog-refinement' },
    'state-changes': [moved('backlog', 'groom', '2026-10-01T10:00:00Z'), moved('groom', 'awaiting-answers', '2026-10-01T11:00:00Z')] }] });
  const s = handleKey(withBacklog([groomed]), shifted('b'));
  assert.equal(s.backlogFlowView, 'tickets');                                            // as B has always opened
  const head = render(s, wide).find(l => l.includes('Show:'));
  assert.ok(head && /Show: +.*Tickets.*Run-time metrics/.test(strip(head)), head);
  assert.ok(head.includes('\x1b[7m Tickets \x1b[0m'));                                   // focused: the choice reversed
  assert.ok(lines(s, wide).some(l => l.includes('←/→ choose what each station shows   ↑/↓ scroll')));
  assert.ok(lines(s, wide).some(l => l.includes('ABC-70: Title ABC-70')));
  const metrics = press(s, 'right');
  assert.equal(metrics.backlogFlowView, 'metrics');
  assert.equal(metrics.flowchartView, s.flowchartView);                                  // S keeps its own choice
  const out = lines(metrics, wide);
  assert.ok(out.some(l => /tickets visited/.test(l)), out.join('\n'));
  assert.ok(out.some(l => /in state per visit +1h 0m/.test(l)), out.join('\n'));         // the hour it spent in Groom
  assert.equal(press(metrics, 'right').backlogFlowView, 'metrics');                       // the last option stays
  assert.equal(press(metrics, 'left').backlogFlowView, 'tickets');
});

// A refinement engine of another shape (ASS-150): its own step ids, names, sequence and human exits — nothing
// the TUI knows — and the execution engine whose backlog-refinement-steps names it.
const triageEngine = { name: 'triage-refinement', lists: {}, steps: [
  { id: 'intake', sequence: 1, name: 'Intake', action: { type: 'prompt' }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'sign-off' }] },
  { id: 'sign-off', sequence: 2, name: 'Sign Off', action: { type: 'human' }, 'exit-events': [
    { condition: { 'human-review': 'Promote' }, 'move-to-state': 'shelf' },
    { condition: { 'human-review': 'Bin' }, 'move-to-state': 'intake', 'asks-for-reason': true },
  ] },
  { id: 'shelf', sequence: 3, name: 'On the Shelf', action: { type: 'none' }, 'is-done': true },
] };
const triaging = { ...engine, lists: { 'backlog-refinement-steps': [{ id: 'backlog-refinement', sequence: 1, name: 'Backlog Refinement', action: { type: 'state-engine', engine: 'triage-refinement' } }] } };
const triageTicket = (key, at) => backlogTicket(key, at, { variations: [{ name: 'A', 'harness-status': { state: at, 'state-engine': 'triage-refinement' } }] });
const withTriage = tickets => withBacklog(tickets, { workflows: [triaging, triageEngine] });

test('ASS-150 AC1: the backlog State column shows the step\'s name from the ticket\'s own refinement engine, any engine', () => {
  const out = lines(handleKey(withTriage([triageTicket('ABC-60', 'intake'), triageTicket('ABC-61', 'sign-off'), triageTicket('ABC-62', 'shelf')]), key('b')), wide);
  const row = k => out.find(l => l.includes(k));
  assert.match(row('ABC-60'), / Intake /);
  assert.match(row('ABC-61'), / Sign Off /);
  assert.match(row('ABC-62'), / On the Shelf /);
  assert.doesNotMatch(row('ABC-61'), /sign-off/);
  // A step its engine does not have shows as its id, as the sprint's Status does.
  assert.match(lines(handleKey(withTriage([triageTicket('ABC-63', 'gone')]), key('b')), wide).find(l => l.includes('ABC-63')), / gone /);
});

test('ASS-150 AC2: B lists a custom refinement engine\'s steps in sequence, each with the tickets at it', () => {
  const out = lines(handleKey(withTriage([triageTicket('ABC-60', 'sign-off'), triageTicket('ABC-61', 'intake'), triageTicket('ABC-62', 'sign-off')]), shifted('b')), wide);
  const names = out.find(l => l.includes('Intake'));
  assert.ok(/Intake .*═▶.*Sign Off .*═▶.*On the Shelf/.test(names), out.join('\n'));
  assert.ok(!out.some(l => /Groom|Awaiting|Ready/.test(l)), 'none of the shipped engines\' steps');
  assert.ok(out.some(l => /┌─ 3 /.test(l)) && !out.some(l => /┌─ 4 /.test(l)), out.join('\n'));   // numbered 1–3
  // Each ticket under its station's box: the column its station's name starts in.
  const top = out.findIndex(l => l.includes('Intake'));
  const column = name => out[top].indexOf(name);
  const under = k => { const l = out.find(x => x.includes(`${k}: Title`)); return l.indexOf(k); };
  assert.ok(Math.abs(under('ABC-61') - column('Intake')) < 4, out.join('\n'));
  assert.ok(Math.abs(under('ABC-60') - column('Sign Off')) < 4 && Math.abs(under('ABC-62') - column('Sign Off')) < 4, out.join('\n'));
});

test('ASS-245 AC1, AC5: B draws a refinement step running a sub-engine as a box of its stations, each ticket at its deepest; g opens every one', () => {
  const checks = { name: 'intake-checks', steps: [{ id: 'read', name: 'Read It', sequence: 1, action: { type: 'prompt' } }, { id: 'label', name: 'Label It', sequence: 2, action: { type: 'script' } }] };
  const triage = { ...triageEngine, steps: triageEngine.steps.map(s => (s.id === 'intake' ? { ...s, action: { type: 'state-engine', engine: 'intake-checks' } } : s)) };
  const inside = (key, at) => backlogTicket(key, 'intake', { variations: [{ name: 'A', 'harness-status': { state: 'intake', 'state-engine': 'triage-refinement', 'sub-status': { state: at, 'state-engine': 'intake-checks' } } }] });
  const st = withBacklog([inside('ABC-60', 'label'), triageTicket('ABC-61', 'sign-off')], { workflows: [triaging, triage, checks], assignments: [assignment('Daredevil', 'ABC-60')] });
  const out = lines(handleKey(st, shifted('b')), wide);
  const intake = rectOf(out, 'Intake');
  assert.ok(intake.group && holds(intake, rectOf(out, 'Read It')) && holds(intake, rectOf(out, 'Label It')));
  assert.deepEqual(keysUnder(out, rectOf(out, 'Label It')), ['ABC-60']);
  assert.deepEqual(keysUnder(out, intake), []);
  assert.ok(boxOf(out, rectOf(out, 'Label It')).join('').includes('🤖💻'));
  assert.ok(out.some(l => l.includes('g open every sub-flow')));
  const empty = withBacklog([triageTicket('ABC-61', 'sign-off')], { workflows: [triaging, triage, checks] });
  const closed = handleKey(empty, shifted('b'));
  assert.ok(!rectOf(lines(closed, wide), 'Intake').group);
  assert.ok(rectOf(lines(handleKey(closed, key('g', { sequence: 'g' }), wide), wide), 'Intake').group);
});

test('ASS-150 AC3: at a human step of a custom refinement engine, the choices are its exits; choosing one runs ticket:human-review', () => {
  const opened = press(handleKey(withTriage([triageTicket('ABC-60', 'sign-off')]), key('b')), 'return');
  const out = lines(opened, wide);
  assert.ok(tabOf(lines(onTab(opened, 'details'), wide)).some(l => /^Status\b.*Sign Off/.test(l)), out.join('\n'));
  const acts = actionsOf(out).join('\n');
  assert.ok(/Promote +→ On the Shelf/.test(acts) && /Bin +→ Intake/.test(acts), acts);
  assert.ok(!/Accept|Reject/.test(acts), acts);
  const choosing = { ...opened, ticketTab: 'actions' };
  assert.deepEqual(press(choosing, 'return').decide, ['ticket:human-review', 'example', 'ABC-60', 'A', 'sign-off', 'Promote', 'shelf']);
  const typed = [...'dup'].reduce((st, c) => handleKey(st, key(c, { sequence: c }), wide), press(choosing, 'down', 'return'));
  assert.deepEqual(press(typed, 'return').decide, ['ticket:human-review', 'example', 'ABC-60', 'A', 'sign-off', 'Bin', 'intake', 'dup']);
  assert.ok(!actionsOf(lines(onTab(press(handleKey(withTriage([triageTicket('ABC-61', 'intake')]), key('b')), 'return'), 'actions'), wide)).some(l => /Promote|Bin/.test(l)));   // not a human step: no exits
});

// ASS-56: the backlog grid orders tickets closest to done first — by the sequence of the step each sits at in its own
// refinement engine, highest first, as the sprint grid orders by step sequence; a step its engine lacks, or no step,
// last — and keeps rankBacklog's order within one step. Enter opens the row under the cursor. B is not reordered.
test('ASS-56 AC1–AC4, AC7: the backlog grid lists tickets closest to their refinement engine\'s done step first, rankBacklog\'s order within a step', () => {
  const triageTicket = (key, at, extra = {}) => backlogTicket(key, at, { ...extra, variations: [{ name: 'A', 'harness-status': { state: at, 'state-engine': 'triage-refinement' } }] });
  const list = [
    triageTicket('ABC-60', 'intake'), triageTicket('ABC-61', 'gone'), triageTicket('ABC-62', 'sign-off'), triageTicket('ABC-63', 'shelf'),
    triageTicket('ABC-64', 'intake', { 'sprint-tag': 'Sprint 2' }), triageTicket('ABC-65', 'sign-off'), backlogTicket('ABC-66', null, { variations: [{ name: 'A' }] }),
    triageTicket('ABC-67', 'shelf', { 'manual-backlog-priority': 1 }), triageTicket('ABC-68', 'shelf'),
  ];
  const ranked = rankBacklog(list).map(t => t.key);
  const within = keys => ranked.filter(k => keys.includes(k));
  const s = handleKey(withTriage(list), key('b'));
  const rows = lines(s, wide).filter(l => /ABC-6\d: Title/.test(l));
  const keys = rows.map(l => l.match(/ABC-6\d/)[0]);
  assert.deepEqual(keys.slice(0, 3), within(['ABC-63', 'ABC-67', 'ABC-68']));                   // On the Shelf, 3
  assert.deepEqual(keys.slice(3, 5), within(['ABC-62', 'ABC-65']));                             // Sign Off, 2
  assert.deepEqual(keys.slice(5, 7), within(['ABC-60', 'ABC-64']));                             // Intake, 1
  assert.deepEqual(keys.slice(5, 7), ['ABC-64', 'ABC-60']);                                     // the sprint tag outranks the number
  assert.deepEqual(keys.slice(7).toSorted(), ['ABC-61', 'ABC-66']);                             // a step the engine lacks, or none: last
  assert.match(rows[keys.indexOf('ABC-61')], / gone /);
  assert.doesNotMatch(rows[keys.indexOf('ABC-66')], /Intake|Sign Off|On the Shelf|gone/);
  const states = rows.slice(0, 7).map(l => l.match(/On the Shelf|Sign Off|Intake/)[0]);
  assert.deepEqual(states, ['On the Shelf', 'On the Shelf', 'On the Shelf', 'Sign Off', 'Sign Off', 'Intake', 'Intake']);
  for (let i = 0; i < keys.length; i++)                                                       // enter opens the row under the cursor
    assert.equal(press(press(s, ...Array(i).fill('down')), 'return').ticket.key, keys[i], `row ${i}`);
});

test('ASS-56 AC5: B still lists each station\'s tickets in backlog order', () => {
  const triageTicket = (key, at, extra = {}) => backlogTicket(key, at, { ...extra, variations: [{ name: 'A', 'harness-status': { state: at, 'state-engine': 'triage-refinement' } }] });
  const list = [triageTicket('ABC-60', 'sign-off'), triageTicket('ABC-61', 'intake'), triageTicket('ABC-62', 'sign-off', { 'manual-backlog-priority': 1 })];
  const out = lines(handleKey(withTriage(list), shifted('b')), wide);
  const at = k => out.findIndex(l => l.includes(`${k}: Title`));
  assert.ok(at('ABC-62') < at('ABC-60'), out.join('\n'));
});

test('ASS-150 AC4: the TUI names no refinement step — no step id or name of a shipped refinement engine is a string in its source', () => {
  const dir = join(import.meta.dirname, '..', '..', 'src', 'tui');
  const source = readdirSync(dir).filter(f => f.endsWith('.js')).map(f => readFileSync(join(dir, f), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')).join('\n')
    .replace("{ status: 'ready' }", '');   // a demo's status (main.js), not a step
  assert.doesNotMatch(source, /REFINEMENT/);
  for (const name of ['harness-backlog-refinement', 'example-backlog-refinement']) {
    for (const s of JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'), 'utf8')).steps) {
      for (const word of [s.id, s.name]) assert.ok(!new RegExp(`['"\`]${word}['"\`]`).test(source), `${name}: ${word}`);
    }
  }
});

test('a backlog ticket waiting on the operator — a question, or at a human step — shows a blue ● left of its key, never 🔴; one without does not (ASS-242)', () => {
  const s = handleKey(withBacklog([backlogTicket('ABC-60', 'awaiting-answers'), backlogTicket('ABC-61', 'groom')]), key('b'));
  s.projects[0].questions = [question('Which login?', 'abc-60', { status: 'Asked' }), question('Which card?', 'abc-61', { status: 'Answer Accepted' })];
  const out = lines(s, wide);
  assert.ok(blueDot(render(s, wide).find(l => l.includes('ABC-60')), 'ABC-60: ') && out.find(l => l.includes('ABC-60')).includes('✨ ● ABC-60: '));
  assert.equal(out.find(l => l.includes('ABC-60')).split('●').length - 1, 1);   // a question and Awaiting Answers: one ●
  assert.ok(!out.find(l => l.includes('ABC-61')).includes('●'));
  assert.ok(!out.some(l => l.includes('🔴')));
});

test('space pauses on S and B as on s and b; f does not; B marks highlighted tickets', () => {
  for (const screen of ['S', 'B']) assert.ok(handleKey({ ...state, screen }, key('space')).pauses['example']?.human, screen);
  assert.deepEqual(handleKey({ ...state, screen: 'f' }, key('space')).pauses, {});
  const marked = '\x1b[48;2;255;255;0m\x1b[30mABC-60\x1b[39;49m';
  const s = initialState({ projects: [{ ...projects[0], backlog: [backlogTicket('ABC-60', 'groom')], highlights: [{ ticket: 'ABC-60', color: '#ffff00' }] }], workflows: [refiningEngine, refinementEngine] });
  assert.ok(render({ ...s, screen: 'B', focus: 'backlogflow' }, wide).some(l => l.includes(marked)));
});

// The chat screen (ASS-33): the selected project's chats with a plain AI, apart from the agents screen.
const chatList = [
  { id: 'c1', project: 'example', title: 'Why is EX-1201 blocked?', created: '2026-10-01T15:00:00Z', 'session-id': 's1' },
  { id: 'c2', project: 'example', title: 'Explain the corpus API', created: '2026-10-01T16:00:00Z', 'session-id': null },
  { id: 'c3', project: 'assassin', title: 'Harness question', created: '2026-10-01T16:01:00Z', 'session-id': null },
];
const chatting = (extra = {}) => handleKey(initialState({ projects, workflows: [engine], assignments, chats: chatList, ...extra }), key('x'), wide);

test('x opens the chat screen, after a in the menu: + New chat, then the selected project\'s chats newest first — title, created, last activity, running or ended', () => {
  const s = chatting({ chatsRunning: ['c1'], chatsWritten: { c1: Date.parse('2026-10-01T15:30:00Z') } });
  assert.deepEqual([s.screen, s.focus], ['x', 'chats']);
  assert.deepEqual(menuOf(s).slice(9, 12).map(e => e.split(' ')[0]), ['a', 'x', 'h']);
  const out = lines(s, wide);
  const at = text => out.findIndex(l => l.includes(text));
  assert.ok(at('+ New chat') >= 0 && at('+ New chat') < at('Explain the corpus API') && at('Explain the corpus API') < at('Why is EX-1201 blocked?'), out.join('\n'));
  assert.match(out[at('Why is EX-1201 blocked?')], /2026-10-01 15:00 UTC .* 2026-10-01 15:30:00 UTC .* running/);
  assert.match(out[at('Explain the corpus API')], / — +ended /);
  assert.ok(!out.some(l => l.includes('Harness question')));                  // another project's
  assert.ok(!out.some(l => l.includes('Daredevil')));                          // never the agents screen's agents
  assert.ok(render(s, wide).some(l => l.startsWith('│\x1b[7m') && l.includes('+ New chat')));
});

test('enter on + New chat opens an empty chat; the first message asks for the chat to be made and sent, titled by it', () => {
  const opened = press(chatting(), 'return');
  assert.deepEqual(opened.chat, { id: null });
  assert.ok(lines(opened, wide).some(l => l.includes('no messages yet')));
  const sent = handleKey(typing(opened, 'Hello there'), key('return'), wide);
  assert.deepEqual(sent.chatSend, { project: 'example', id: null, text: 'Hello there' });
  assert.equal(sent.chatDraft, '');
  assert.equal(handleKey(typing(opened, '  '), key('return'), wide).chatSend, null);
});

test('enter on a chat opens its log with a prompt line; enter sends to it; esc clears the draft, then returns to the list as it was', () => {
  const s = { ...press(chatting(), 'down', 'down'), chatLog: ['> hi', 'Hello!'] };
  const opened = press(s, 'return');
  assert.deepEqual(opened.chat, { id: 'c1' });
  const out = lines({ ...opened, chatLog: ['> hi', 'Hello!'] }, wide);
  assert.ok(out.some(l => l.includes('Hello!')) && out.some(l => l.startsWith('> █')), out.join('\n'));
  assert.ok(out.some(l => l.includes('esc returns to the chats')));
  const typed = typing(opened, 'more');
  assert.deepEqual(handleKey(typed, key('return'), wide).chatSend, { project: 'example', id: 'c1', text: 'more' });
  const cleared = press(typed, 'escape');
  assert.equal(cleared.chatDraft, '');
  const back = press(cleared, 'escape');
  assert.deepEqual([back.chat, back.chatSelected, back.focus], [null, 2, 'chats']);
  assert.equal(handleKey(opened, key('space', { sequence: ' ' }), wide).chatDraft, ' ');                           // keys are text in a chat, space too
});

test('delete (or backspace) on a chat asks to confirm; y asks for it to be deleted, anything else keeps it; + New chat cannot be deleted', () => {
  const s = press(chatting(), 'down');
  const asking = press(s, 'delete');
  assert.equal(asking.chatConfirm, 'c2');
  assert.ok(lines(asking, wide).some(l => l.includes("Delete chat 'Explain the corpus API'? y/n")));
  assert.equal(handleKey(asking, key('y', { sequence: 'y' }), wide).chatDelete, 'c2');
  assert.equal(handleKey(asking, key('y', { sequence: 'y' }), wide).chatConfirm, null);
  const kept = handleKey(asking, key('n', { sequence: 'n' }), wide);
  assert.deepEqual([kept.chatConfirm, kept.chatDelete, kept.screen], [null, null, 'x']);
  assert.equal(press(s, 'backspace').chatConfirm, 'c2');
  assert.equal(press(chatting(), 'delete').chatConfirm, null);                    // + New chat
});

// A chat open on its log, holding `log` (ASS-40's fold draws it as the agents screen does).
const chatReading = log => ({ ...press(chatting(), 'down', 'down', 'return'), chatLog: log });

test('a chat\'s log draws each tool result as one line — its first line and how many lines the output has', () => {
  assert.deepEqual(logLines(chatReading(folding)), folded);
});

test('a one-line tool result is drawn as it is', () => {
  assert.deepEqual(logLines(chatReading(oneLineResult)), oneLineResult);          // no …, no (1 lines)
});

test('a log with no tool result is unchanged', () => {
  const reading = chatReading(noResult);
  assert.deepEqual(logLines(reading), noResult);
  assert.deepEqual(logLines(handleKey(reading, key('tab'), wide)), noResult);     // the same folded and unfolded
});

test('the agents screen\'s session log folds tool results the same way the chat screen does', () => {
  assert.deepEqual(logLines(agentReading(folding)), folded);
  assert.deepEqual(logLines(agentReading(folding)).filter(l => l.startsWith('◀')),
    logLines(chatReading(folding)).filter(l => l.startsWith('◀')));              // the two surfaces agree
});

test('tab on a chat\'s log unfolds it too', () => {
  const reading = chatReading(folding);
  assert.deepEqual(logLines(reading), folded);
  const showing = handleKey(reading, key('tab'), wide);
  assert.deepEqual(logLines(showing), folding);
  assert.deepEqual(logLines(handleKey(showing, key('tab'), wide)), folded);
});

// The ticket's chat (ASS-35): a third section on the ticket screen, below the human actions.
const chatType = (s, text) => [...text].reduce((at, c) => handleKey(at, key(c === ' ' ? 'space' : c, { sequence: c }), wide), s);
// The ticket screen's open tab fills the box left of the panel (ASS-184): the chat and the
// human actions are read from it, on their tabs (see tabOf).
const chatOf = out => tabOf(out);
const actionsOf = out => tabOf(out);

test('opening a ticket\'s screen, sprint or backlog, asks for its chat to be started or caught up (ticketChatOpen); nothing is started for a ticket not opened', () => {
  assert.equal(onGrid.ticketChatOpen, null);
  assert.deepEqual(press(onGrid, 'return').ticketChatOpen, { project: 'example', key: 'ABC-5' });
  const backlog = press(handleKey(withBacklog([backlogTicket('ABC-60', 'groom')]), key('b')), 'return');
  assert.deepEqual(backlog.ticketChatOpen, { project: 'example', key: 'ABC-60' });
});

test('on the Chat tab every printable key is its text — space, !, / and Q too; enter sends it as ticketChatSend; esc clears it, then leaves the ticket', () => {
  const chat = press(onGrid, 'return');
  assert.equal(chat.ticketTab, 'chat');
  const typed = chatType(chat, 'Q! /why');
  assert.equal(typed.ticketChatDraft, 'Q! /why');
  assert.deepEqual([typed.quitting, typed.menuHidden, typed.pauses], [false, chat.menuHidden, chat.pauses]);
  assert.ok(lines(typed, wide).some(l => l.includes('> Q! /why█')));
  const sent = press(typed, 'return');
  assert.deepEqual([sent.ticketChatSend, sent.ticketChatDraft], [{ project: 'example', key: 'ABC-5', text: 'Q! /why' }, '']);
  assert.equal(press(chat, 'return').ticketChatSend, null);                   // nothing typed: nothing sent
  const cleared = press(typed, 'escape');
  assert.deepEqual([cleared.ticketChatDraft, cleared.ticket?.key], ['', 'ABC-5']);
  assert.equal(press(cleared, 'escape').ticket, null);
  assert.equal(press(typed, 'tab').ticketTab, 'actions');                  // tab still switches tabs, round to the first
});

test('↑/↓ scroll the chat\'s log while it has focus, no further than its ends; reaching the end follows it again', () => {
  const log = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
  const chat = { ...press(onGrid, 'return'), ticketChatLog: log };
  assert.ok(chatOf(lines(chat, wide)).some(l => l.includes('line 60')));     // follows the end
  const up = press(chat, 'up');
  assert.ok(up.ticketChatScroll != null);
  assert.ok(!chatOf(lines(up, wide)).some(l => l.includes('line 60')));
  const top = press(chat, ...Array(100).fill('up'));
  assert.equal(top.ticketChatScroll, 0);
  assert.ok(chatOf(lines(top, wide)).some(l => /^line 1$/.test(l)));
  assert.equal(press(top, ...Array(100).fill('down')).ticketChatScroll, null);
  assert.equal(press(chat, 'up').ticketScroll, 0);                            // the details stay put
});

test('the Actions tab scrolls to keep the selected choice in view, so none is cut off, at Human Review with the review below the choices too (ASS-101, ASS-184)', () => {
  const short = { ...wide, rows: 36 };
  const open = handleKey(atHumanReview(DEMO), key('return'), short);
  assert.ok(actionsOf(render(open, short).map(strip)).some(l => l.includes('▸ Approved')));
  const last = Array(8).fill('down').reduce(s => handleKey(s, key('down'), short), open);
  assert.ok(actionsOf(render(last, short).map(strip)).some(l => l.includes('▸ Delete ticket')), actionsOf(render(last, short).map(strip)).join('\n'));
});

// A ticket's chat open on its log, holding `log` (ASS-40's fold, with no toggle to unfold it).
const ticketReading = log => ({ ...press(onGrid, 'return'), ticketChatLog: log });

test('the ticket chat wraps a long reply at its own narrower width, continuation rows hung under its lead-in (ASS-63)', () => {
  const chat = chatOf(lines(ticketReading([`> ${reply}`]), wide));
  const rows = chat.slice(chat.findIndex(l => l.startsWith('> Here')), chat.findIndex(l => l.endsWith('— the end.')) + 1);
  assert.ok(rows.length > 2, chat.join('\n'));
  assert.equal(shownText(rows), `> ${reply}`);
  assert.ok(rows.slice(1).every(r => r.startsWith('  ')) && !rows.some(r => r.includes('…')), rows.join('\n'));
});

test('the ticket chat folds tool results', () => {
  const right = chatOf(lines(ticketReading(folding), wide));
  assert.ok(right.some(l => l.includes('◀ pass 7 … (3 lines)')), right.join('\n'));
  assert.ok(!right.some(l => l.includes('fail 0')));
});

test('the ticket chat has no fold toggle and stays folded', () => {
  const moved = press(ticketReading(folding), 'tab');
  assert.equal(moved.ticketTab, 'actions');                                     // tab switches tabs, as everywhere on the screen
  assert.ok(!('ticketChatEvents' in moved));
  const right = chatOf(lines(handleKey(moved, key('tab', { shift: true }), wide), wide));
  assert.ok(right.some(l => l.includes('◀ pass 7 … (3 lines)')), right.join('\n'));
  assert.ok(!lines(ticketReading(folding), wide).some(l => /tab (shows|hides) events/.test(l)));
});

test('an empty or absent log still says so', () => {
  assert.deepEqual(logLines(agentReading(null)), ['no session log for Daredevil']);
  assert.deepEqual(logLines(chatReading(null)), ['no messages yet: type one, enter sends it']);
  assert.ok(chatOf(lines(ticketReading(null), wide)).some(l => l.includes('no messages yet: type one, enter sends it')));
});

// A cursor in a chat prompt line (ASS-41). The agents screen's prompt, the chat screen's and the
// ticket chat's run through one handler (viewLog) and one draw, so every behavior below is asserted
// on all three at once — that shared table is what proves AC4, not a separate comparison test.
const prompts = [
  { name: 'the agents screen', draft: 'agentDraft', cursor: 'agentCursor',
    held: s => [openDraft(s), s.agentCursor[s.agent?.name] ?? 0],
    open: () => agentReading(['line 0']), sent: s => s.agentPrompt?.[2] ?? null, closed: s => s.agent === null },
  { name: 'the chat screen', draft: 'chatDraft', cursor: 'chatCursor',
    open: () => chatReading(['hi']), sent: s => s.chatSend?.text ?? null, closed: s => s.chat === null },
  { name: 'the ticket chat', draft: 'ticketChatDraft', cursor: 'ticketChatCursor',
    open: () => press(onGrid, 'return'), sent: s => s.ticketChatSend?.text ?? null, closed: s => s.ticket === null },
];
// What a prompt holds: its draft and where the cursor is in it, in code points.
const at = (p, s) => (p.held ? p.held(s) : [s[p.draft], s[p.cursor]]);
// The prompt line as it is drawn, from its '> ' on, the colors still in it — the agents and chat
// screens draw it on its own row, the ticket chat beside the details box's bottom corner.
// its cell is padded out to its column, so the prompt ends where two spaces follow it.
const promptRow = s => { const row = render(s, wide).find(l => /(^|[│█] )> /.test(strip(l))); return row.slice(row.indexOf('> ')).replace(/ {2,}.*$/, ''); };
const ctrl = (name, sequence) => key(name, { ctrl: true, sequence });

test('←/→ move the cursor through a prompt\'s draft and stop at its ends, leaving the text alone', () => {
  for (const p of prompts) {
    const typed = typing(p.open(), 'hi');
    assert.deepEqual(at(p, typed), ['hi', 2], p.name);                        // a fresh draft types at its end
    assert.deepEqual(at(p, press(typed, 'right')), ['hi', 2], p.name);        // already at the end: no further
    assert.deepEqual(at(p, press(typed, 'left')), ['hi', 1], p.name);
    assert.deepEqual(at(p, press(typed, 'left', 'left')), ['hi', 0], p.name);
    assert.deepEqual(at(p, press(typed, 'left', 'left', 'left')), ['hi', 0], p.name);   // and no further back
    assert.deepEqual(at(p, press(typed, 'left', 'left', 'right')), ['hi', 1], p.name);
  }
});

test('a printable key inserts at the cursor instead of appending to the end', () => {
  for (const p of prompts) {
    const mid = press(typing(p.open(), 'word'), 'left', 'left');
    assert.deepEqual(at(p, typing(mid, 'X')), ['woXrd', 3], p.name);
    assert.deepEqual(at(p, typing(press(mid, 'home'), 'X')), ['Xword', 1], p.name);
  }
});

test('backspace deletes the character before the cursor and keeps the text after it', () => {
  for (const p of prompts) {
    const mid = press(typing(p.open(), 'word'), 'left', 'left');
    assert.deepEqual(at(p, press(mid, 'backspace')), ['wrd', 1], p.name);     // the tail survives
    assert.deepEqual(at(p, press(mid, 'home', 'backspace')), ['word', 0], p.name);   // nothing before the start
  }
});

test('home and end move the cursor to the start and the end of a prompt\'s draft', () => {
  for (const p of prompts) {
    const typed = typing(p.open(), 'hello');
    assert.deepEqual(at(p, press(typed, 'home')), ['hello', 0], p.name);
    assert.deepEqual(at(p, press(typed, 'home', 'end')), ['hello', 5], p.name);
    assert.deepEqual(at(p, press(typed, 'left', 'left', 'home')), ['hello', 0], p.name);
    assert.deepEqual(at(p, press(typed, 'left', 'left', 'end')), ['hello', 5], p.name);
  }
});

test('ctrl-a and ctrl-e reach the ends just as home and end do, and are not typed as text', () => {
  for (const p of prompts) {
    const mid = press(typing(p.open(), 'hello'), 'left', 'left');
    assert.deepEqual(at(p, handleKey(mid, ctrl('a', '\x01'), wide)), at(p, press(mid, 'home')), p.name);
    assert.deepEqual(at(p, handleKey(mid, ctrl('e', '\x05'), wide)), at(p, press(mid, 'end')), p.name);
    assert.deepEqual(at(p, handleKey(mid, ctrl('a', '\x01'), wide)), ['hello', 0], p.name);     // no 'a' in the draft
    assert.deepEqual(at(p, handleKey(mid, ctrl('e', '\x05'), wide)), ['hello', 5], p.name);
  }
});

test('delete removes the character under the cursor, leaving the cursor where it is', () => {
  for (const p of prompts) {
    const typed = typing(p.open(), 'hello');
    assert.deepEqual(at(p, press(typed, 'home', 'right', 'delete')), ['hllo', 1], p.name);
    assert.deepEqual(at(p, press(typed, 'delete')), ['hello', 5], p.name);    // nothing under it at the end
  }
});

test('the cursor keys on an empty draft do nothing', () => {
  for (const p of prompts) {
    const empty = p.open();
    assert.deepEqual(at(p, empty), ['', 0], p.name);
    for (const name of ['left', 'right', 'home', 'end', 'delete', 'backspace'])
      assert.deepEqual(at(p, press(empty, name)), ['', 0], `${p.name}: ${name}`);
    assert.deepEqual(at(p, handleKey(empty, ctrl('a', '\x01'), wide)), ['', 0], p.name);
    assert.deepEqual(at(p, handleKey(empty, ctrl('e', '\x05'), wide)), ['', 0], p.name);
  }
});

test('an empty draft and a cursor at the end of one draw as they do today', () => {
  for (const p of prompts) {
    assert.equal(promptRow(p.open()), '> █', p.name);
    assert.equal(promptRow(typing(p.open(), 'hi')), '> hi█', p.name);
  }
});

test('a cursor in the middle of a draft marks the character under it instead of trailing the text', () => {
  for (const p of prompts) {
    const mid = press(typing(p.open(), 'hi'), 'left');
    assert.equal(strip(promptRow(mid)), '> hi', p.name);                      // the text itself is unchanged
    assert.equal(promptRow(mid), '> h\x1b[7mi\x1b[0m', p.name);               // exactly the one character marked
  }
});

test('the ticket chat keeps its draft and cursor while another tab is open, and draws them again on coming back (ASS-184)', () => {
  const mid = press(typing(press(onGrid, 'return'), 'hi'), 'left');
  const away = press(mid, 'tab');
  assert.equal(away.ticketTab, 'actions');
  assert.deepEqual([away.ticketChatDraft, away.ticketChatCursor], ['hi', 1]);  // the draft and its cursor are kept
  assert.ok(!lines(away, wide).some(l => l.includes('> hi')));                 // the prompt is the Chat tab's alone
  assert.equal(promptRow(handleKey(away, key('tab', { shift: true }), wide)), '> h\x1b[7mi\x1b[0m');
});

test('←/→ do not switch project while a prompt line has focus', () => {
  for (const p of prompts) {
    const typed = typing(p.open(), 'hi');
    const moved = press(typed, 'left', 'right', 'left');
    assert.deepEqual([moved.project, moved.focus, moved.ticketTab], [typed.project, typed.focus, typed.ticketTab], p.name);
  }
});

test('enter sends the whole draft wherever the cursor is and puts it back at the start', () => {
  for (const p of prompts) {
    const mid = press(typing(p.open(), 'hello'), 'left', 'left');
    const sent = press(mid, 'return');
    assert.equal(p.sent(sent), 'hello', p.name);                              // the whole text, not the part before the cursor
    assert.deepEqual(at(p, sent), ['', 0], p.name);
    assert.equal(p.sent(press(typing(p.open(), '  '), 'home', 'return')), null, p.name);   // blank: nothing sent, as today
  }
});

test('esc clears a prompt\'s draft and its cursor, then closes the view as today', () => {
  for (const p of prompts) {
    const cleared = press(press(typing(p.open(), 'hello'), 'left', 'left'), 'escape');
    assert.deepEqual(at(p, cleared), ['', 0], p.name);
    assert.equal(p.closed(cleared), false, p.name);
    assert.equal(p.closed(press(cleared, 'escape')), true, p.name);
  }
});

test('a multi-code-point character is one step to move over and one key press to delete', () => {
  for (const p of prompts) {
    const typed = typing(p.open(), multiByteDraft);
    assert.deepEqual(at(p, typed), [multiByteDraft, 3], p.name);              // three code points, not four units
    const over = press(typed, 'home', 'right', 'right');                      // one → past the emoji, not half of it
    assert.deepEqual(at(p, typing(over, 'X')), ['a🤖Xb', 3], p.name);
    const before = press(typed, 'left', 'backspace');
    assert.deepEqual([at(p, before)[0], [...at(p, before)[0]].length, at(p, before)[1]], ['ab', 2, 1], p.name);
    const under = press(typed, 'home', 'right', 'delete');
    assert.deepEqual([at(p, under)[0], [...at(p, under)[0]].length, at(p, under)[1]], ['ab', 2, 1], p.name);
  }
});

test('moving, inserting, deleting either way and the ends all hold together over one draft', () => {
  for (const p of prompts) {
    let s = typing(p.open(), 'hello');
    s = press(s, 'left', 'left');
    assert.deepEqual(at(p, s), ['hello', 3], p.name);
    s = typing(s, 'p');
    assert.deepEqual(at(p, s), ['helplo', 4], p.name);
    s = press(s, 'backspace');
    assert.deepEqual(at(p, s), ['hello', 3], p.name);
    s = press(s, 'delete');
    assert.deepEqual(at(p, s), ['helo', 3], p.name);
    assert.deepEqual(at(p, press(s, 'home')), ['helo', 0], p.name);
    assert.deepEqual(at(p, press(s, 'home', 'end')), ['helo', 4], p.name);
    s = handleKey(handleKey(press(s, 'home'), ctrl('a', '\x01'), wide), ctrl('e', '\x05'), wide);
    assert.deepEqual(at(p, s), ['helo', 4], p.name);
    const sent = press(s, 'return');
    assert.equal(p.sent(sent), 'helo', p.name);
    assert.deepEqual(at(p, sent), ['', 0], p.name);
  }
});

// A prompt line wrapping its draft, shift+enter for a new line (ASS-43), over the same three prompts.
// The prompt's rows as drawn, stripped and trimmed: on the agents and chat screens the lines from its
// '> ' (or the overflow hint above it) down to the blank message line under them, on the ticket's Chat tab its rows from there down.
const HINT = /^\(\d+ more lines? above\)$/;
const draftRows = (s, size = wide) => {
  const cells = s.ticket ? chatOf(lines(s, size)) : lines(s, size);
  const hint = cells.findLastIndex(l => HINT.test(l));
  const rows = cells.slice(hint >= 0 ? hint : cells.findLastIndex(l => l.startsWith('> ')));
  return rows.slice(0, s.ticket ? rows.length : rows.indexOf('')).map(l => l.trimEnd());
};
// The width a prompt's rows have to fit: the terminal's, or the Chat tab's text width on the ticket screen (ASS-184).
const promptWidth = (s, size = wide) => (s.ticket ? size.columns - PANEL - 3 : size.columns);
const forty = { ...wide, columns: 40 };

test('a draft wider than the prompt wraps onto rows of its width less the lead-in and a cell kept for the cursor', () => {
  const s = typing(prompts[0].open(), 'a'.repeat(80));
  assert.deepEqual(draftRows(s, forty), [`> ${'a'.repeat(37)}`, `  ${'a'.repeat(37)}`, `  ${'a'.repeat(6)}█`]);
  for (const p of prompts) {
    const typed = typing(p.open(), 'abcdefghij'.repeat(30));
    const width = promptWidth(typed);
    const rows = draftRows(typed);
    assert.ok(rows.length > 1, p.name);
    assert.ok(rows.every(r => visible(r) <= width - 1), `${p.name}: no row reaches the last column`);
    assert.ok(rows.slice(0, -1).every(r => visible(r) === width - 1), `${p.name}: every row but the last full`);
    assert.equal(rows.map(r => r.slice(2)).join('').replace('█', ''), 'abcdefghij'.repeat(30), p.name);
    assert.ok(rows[0].startsWith('> ') && rows.slice(1).every(r => r.startsWith('  ')), p.name);
  }
});

test('a wrapped draft breaks before an emoji that does not fit whole, and the cursor is drawn on the row it falls on', () => {
  const s = typing(prompts[0].open(), `${'a'.repeat(36)}🤖b`);
  assert.deepEqual(draftRows(s, forty), [`> ${'a'.repeat(36)}`, '  🤖b█']);         // 36 + 2 is past the 37 a row holds
  const raw = render(press(s, 'left', 'left'), forty);
  assert.ok(raw.includes('  \x1b[7m🤖\x1b[0mb'), 'the emoji under the cursor, on the second row');
  assert.ok(raw.includes(`> ${'a'.repeat(36)}`));
});

// What node:readline hands a keypress for each way a terminal sends shift+enter, and ctrl+j:
// escape-return (iTerm2 and VS Code after /terminal-setup) is return with meta; kitty's CSI u comes
// whole and unnamed; xterm's modifyOtherKeys is cut after its second ';', the rest arriving as keys.
const SHIFT_ENTER = {
  'escape-return': [key('return', { meta: true, sequence: '\x1b\r' })],
  'kitty CSI u': [key('undefined', { sequence: '\x1b[13;2u', code: '[13;2u' })],
  'xterm modifyOtherKeys': [key('undefined', { sequence: '\x1b[27;2;', code: '[27;2;' }), key('1', { sequence: '1' }), key('3', { sequence: '3' }), key(undefined, { sequence: '~' })],
  'ctrl+j': [key('enter', { sequence: '\n' })],
};
const keys = (s, list) => list.reduce((at, k) => handleKey(at, k, wide), s);

test('shift+enter, by each sequence a terminal sends for it, and ctrl+j put a newline in the draft at the cursor, drawn as a new row', () => {
  for (const p of prompts) {
    for (const [name, list] of Object.entries(SHIFT_ENTER)) {
      const s = typing(keys(typing(p.open(), 'one'), list), 'two');
      assert.deepEqual(at(p, s), ['one\ntwo', 7], `${p.name}: ${name}`);
      assert.deepEqual(draftRows(s), ['> one', '  two█'], `${p.name}: ${name}`);
      assert.equal(p.sent(s), null, `${p.name}: ${name} sends nothing`);
      const mid = keys(press(typing(p.open(), 'ab'), 'left'), list);
      assert.deepEqual(at(p, mid), ['a\nb', 2], `${p.name}: ${name} at the cursor`);
    }
  }
});

test('a cursor on a newline is a reversed space at its row\'s end; ←/→ cross a newline as one character', () => {
  for (const p of prompts) {
    const s = typing(keys(typing(p.open(), 'ab'), SHIFT_ENTER['ctrl+j']), 'c');
    const on = press(s, 'left', 'left');
    assert.equal(at(p, on)[1], 2, p.name);
    const raw = render(on, wide);
    assert.ok(raw.some(l => l.includes('> ab\x1b[7m \x1b[0m')), p.name);
    assert.deepEqual(at(p, press(on, 'left', 'backspace')), ['b\nc', 0], p.name);
    assert.deepEqual(at(p, press(on, 'delete')), ['abc', 2], p.name);         // delete joins the rows
  }
});

test('enter sends the whole multi-line draft, trimmed at its ends with its inner newlines kept; a draft of only newlines and spaces sends nothing', () => {
  const nl = SHIFT_ENTER['ctrl+j'];
  for (const p of prompts) {
    const s = typing(keys(keys(typing(keys(typing(p.open(), '  first'), nl), 'second'), nl), nl), 'third  ');
    const sent = press(press(s, 'home'), 'return');
    assert.equal(p.sent(sent), 'first\nsecond\n\nthird', p.name);
    assert.deepEqual(at(p, sent), ['', 0], p.name);
    assert.equal(p.sent(press(typing(keys(typing(p.open(), ' '), nl), ' '), 'return')), null, p.name);
    assert.deepEqual(at(p, press(s, 'escape')), ['', 0], `${p.name}: esc clears it`);
  }
});

// The log rows a prompt's log box shows above it, in order, stripped: between the box's top border (on
// the ticket screen, the Chat tab's) and the prompt's rows.
const logShown = (s, size = wide) => {
  const cells = s.ticket ? chatOf(lines(s, size)) : lines(s, size);
  const hint = cells.findLastIndex(l => HINT.test(l));
  const prompt = hint >= 0 ? hint : cells.findLastIndex(l => l.startsWith('> '));
  const top = s.ticket ? cells.findLastIndex((l, i) => i < prompt && l.startsWith('Chat')) : cells.findLastIndex((l, i) => i < prompt && l.startsWith('┌'));
  return cells.slice(top + 1, s.ticket ? prompt : prompt - 1).map(l => l.replace(/^│ /, '').replace(/ *[│█]$/, '').trimEnd());
};
const LOGS = ['agentLog', 'chatLog', 'ticketChatLog'];
const longLog = Array.from({ length: 100 }, (_, i) => `line ${i}`);
// A prompt open on a long log with a draft of `n` rows: 'r1' … 'rn', one to a line.
const rowsDrafted = (p, i, n) => Array.from({ length: n - 1 }, (_, k) => k + 2).reduce((s, k) => typing(keys(s, SHIFT_ENTER['ctrl+j']), `r${k}`), typing({ ...p.open(), [LOGS[i]]: longLog }, 'r1'));

test('the log box gives up a line to each draft row past the first, keeps following the log\'s end, and grows back as rows go', () => {
  prompts.forEach((p, i) => {
    const room = logShown(rowsDrafted(p, i, 1)).length;                        // the log's rows under a one-row draft
    assert.ok(room > 4, p.name);
    for (const n of [2, 3, room]) {
      const s = rowsDrafted(p, i, n);
      assert.equal(logShown(s).length, room + 1 - n, `${p.name}: ${n} rows`);
      assert.equal(logShown(s).at(-1), 'line 99', `${p.name}: still at the log's end`);
      assert.deepEqual(draftRows(s), Array.from({ length: n }, (_, k) => `${k ? '  ' : '> '}r${k + 1}${k === n - 1 ? '█' : ''}`), p.name);
    }
    const back = press(rowsDrafted(p, i, 3), 'backspace', 'backspace', 'backspace');   // 'r3' and its newline gone
    assert.equal(logShown(back).length, room - 1, `${p.name}: grows back`);
    assert.equal(logShown(typing(press(back, 'escape'), 'z')).length, room, `${p.name}: and all the way once cleared`);
  });
});

test('past the room, the log box stays at one row and the prompt shows its last rows under a hint on its own line: (N more lines above)', () => {
  prompts.forEach((p, i) => {
    const room = logShown(rowsDrafted(p, i, 1)).length;                        // the box's rows and the prompt's share room + 1 lines
    const one = rowsDrafted(p, i, room + 1);                                    // one row too many: the hint takes a line, so two are hidden
    assert.equal(logShown(one).length, 1, p.name);
    assert.equal(logShown(one)[0], 'line 99', p.name);
    const rows = draftRows(one);
    assert.equal(rows.length, room, p.name);
    assert.equal(rows[0], '(2 more lines above)', p.name);
    assert.equal(rows.at(-1), `  r${room + 1}█`, `${p.name}: the cursor's row on show`);
    assert.equal(rows[1], '  r3', p.name);
    const single = rowsDrafted(p, i, room);                                     // fits exactly: no hint
    assert.ok(!draftRows(single).some(r => HINT.test(r)), p.name);
    // One hidden row only happens once the hint line is paid for: room rows + the hint's line − 1.
    const s = typing(press(one, 'backspace', 'backspace', 'backspace'), 'X');    // the last row's text replaced, no new row
    assert.equal(draftRows(s)[0], '(2 more lines above)', p.name);
    const more = rowsDrafted(p, i, room + 5);
    assert.equal(draftRows(more)[0], '(6 more lines above)', p.name);
  });
});

// The hint costs a line of the prompt's room, so it never hides a single row: at least two are hidden
// whenever it shows, and its singular, (1 more line above), cannot be drawn.
test('fitRows: rows that fit pass through; past the room the hint and the last rows; a room of one line shows the last row alone', () => {
  const rows = ['> a', '  b', '  c', '  d'];
  assert.deepEqual(fitRows(rows, 4), rows);                                    // they fit: no hint
  assert.deepEqual(fitRows(rows, 3), ['(2 more lines above)', '  c', '  d']);
  assert.deepEqual(fitRows(rows.slice(0, 2), 2), rows.slice(0, 2));
  assert.deepEqual(fitRows(['> a', '  b', '  c'], 2), ['(2 more lines above)', '  c']);
  assert.deepEqual(fitRows(rows, 1), ['  d']);                                 // no line to spare for a hint: the last row alone
});

test('a multi-row ticket chat draft keeps its rows, and the lines they take, across a switch to another tab and back', () => {
  const s = rowsDrafted(prompts[2], 2, 3);
  const away = press(s, 'tab');
  assert.equal(away.ticketTab, 'actions');
  const back = handleKey(away, key('tab', { shift: true }), wide);
  assert.deepEqual(draftRows(back), draftRows(s));
  assert.deepEqual(logShown(back), logShown(s));
});

test('a modifyOtherKeys sequence cut short is dropped and the key that cut it is read as itself', () => {
  for (const p of prompts) {
    const s = keys(typing(p.open(), 'a'), [key('undefined', { sequence: '\x1b[27;2;' }), key('1', { sequence: '1' }), key('b', { sequence: 'b' })]);
    assert.deepEqual(at(p, s), ['ab', 2], p.name);
  }
});

// ── The ticket screen's tabs (ASS-101's four columns, ASS-184's tabs). The test data ASS-101's plan
// (projects/harness/work/ASS-101/test-plan.md) needs beyond the fixtures above;
// each fixture names the acceptance criteria that reads it.

// Narrow and very narrow screens: under 100 columns the panel is a strip above tabs that take the
// whole width (ASS-185), their content wrapping.
const narrow = { ...screen, columns: 96, rows: 40 };
const veryNarrow = { ...screen, columns: 60, rows: 40 };

// A four-step pipeline (AC2), one of its names far wider than the History tab's states pane, so it has to wrap there (AC1).
const fourSteps = [
  { id: 'plan', name: 'Plan', sequence: 1, action: { type: 'prompt' } },
  { id: 'build', name: 'Build', sequence: 2, action: { type: 'prompt' } },
  { id: 'screenshots', name: 'Add Screenshots to Merge Request', sequence: 3, action: { type: 'prompt' } },
  { id: 'code-review', name: 'Code Review', sequence: 4, action: { type: 'prompt' } },
];
// The same pipeline with three quarantine steps, in their own sequence order, to append after it (AC11).
const quarantineSteps = [
  ...fourSteps,
  { id: 'blocked', name: 'Blocked', sequence: 0, area: 'quarantine', 'is-blocked-state': true, action: { type: 'human' } },
  { id: 'stuck', name: 'Stuck', sequence: 1, area: 'quarantine', action: { type: 'none' } },
  { id: 'self-healing', name: 'Self Healing', sequence: 2, area: 'quarantine', action: { type: 'none' } },
];
// Twenty steps: more than the states pane can show on a 30-row screen, so it opens scrolled to the current one (AC4).
const twentySteps = Array.from({ length: 20 }, (_, i) => ({ id: `step-${i + 1}`, name: `Step ${i + 1}`, sequence: i + 1, action: { type: 'prompt' } }));

// `detailed` on an engine and at a state of our choosing, its other work fields kept — as
// `blockable` does for the blocking engine, for the engines above.
const ticketOn = (steps, status, fields = {}, extra = {}) => ({
  ...initialState({
    projects: [{ ...detailProject, sprint: { ...sprint, features: [{ ...detailed, variations: [{ ...detailed.variations[0], 'harness-status': hs(status), ...fields }] }], bugs: [], spikes: [] } }],
    workflows: [{ ...engine, steps }], assignments: [assignment('Daredevil', 'ABC-5')],
  }),
  focus: 'tickets', ...extra,
});

// A history through the four-step pipeline and quarantine: plan arrived at once with two agents
// sent from it, blocked arrived at once with one sent from it, screenshots never visited (AC3/AC11).
const quarantineHistory = [
  { 'from-state': 'plan', 'to-state': 'build', timestamp: '2026-09-28T10:00:00Z', 'agent-dispatch-log': sent(2) },
  { 'from-state': 'build', 'to-state': 'blocked', timestamp: '2026-09-29T10:00:00Z', 'agent-dispatch-log': [] },
  { 'from-state': 'blocked', 'to-state': 'plan', timestamp: '2026-09-30T10:00:00Z', 'agent-dispatch-log': sent(1) },
];

// A ticket with none of the optional fields: no description, priority, assignee or acceptance
// criteria, and no history (AC1/AC6 edges).
const bare = { key: 'ABC-7', title: 'Bare', ...single({ 'harness-status': hs('code-review'), 'state-changes': [] }) };
const criteria = n => Array.from({ length: n }, (_, i) => ({ 'criteria-number': i + 1, description: `Criterion ${i + 1}` }));
// Short details over a long history, and the mirror: one tab fits while the other scrolls.
const longHistory = Array.from({ length: 60 }, (_, i) => ({ 'from-state': i % 2 ? 'plan' : 'build', 'to-state': i % 2 ? 'build' : 'plan', timestamp: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`, 'agent-dispatch-log': [] }));
const shortOverLong = { ...bare, ...single({ 'harness-status': hs('code-review'), 'state-changes': longHistory }) };
const longOverShort = { ...detailed, variations: [{ ...detailed.variations[0], 'acceptance-criteria': criteria(80) }] };
const bothLong = { ...longOverShort, variations: [{ ...longOverShort.variations[0], 'state-changes': longHistory }] };

// This ticket's questions, one of every answer status, beside one asked on another ticket and one
// attached to none: only ABC-5's four belong on its Questions tab (AC7).
const ticketQuestions = [
  question('Bluebook or ALWD?', 'ABC-5'),
  question('Feature flag?', 'ABC-5', { index: 1, status: 'Answered', answer: 'Yes, flag it.', 'why-this-answer': 'Everyone sees it.' }),
  question('Staging database?', 'ABC-5', { index: 2, status: 'Answer Accepted', answer: 'No.' }),
  question('Which citation style should the brief generator reach for, and why that one over the house style?', 'ABC-5', { index: 3, status: 'Answer Rejected', answer: 'ALWD.', 'ai-feedback-if-not-accepted': 'Bluebook is the house style.' }),
  question('Import format?', 'ABC-1', { index: 4 }),
  question('Who owns this?', '', { index: 5 }),
];
// The ticket grid with those questions on the project; `tickets` picks which ticket is there.
const asked = (tickets = [detailed], extra = {}) => ({
  ...initialState({
    projects: [{ ...detailProject, sprint: { ...sprint, features: tickets, bugs: [], spikes: [] }, questions: ticketQuestions }],
    workflows: [engine], assignments: [assignment('Daredevil', 'ABC-5')],
  }),
  focus: 'tickets', ...extra,
});

// A backlog ticket open on its screen, at a step of its refinement engine.
const onBacklogTicket = (status, extra = {}) => press(handleKey(withBacklog([backlogTicket('ABC-60', status)], {
  workflows: [refiningEngine, refinementEngine], ...extra,
}), key('b')), 'return');

// The ticket box's body rows in `out` (ASS-184): between the tab bar and the box's foot.
const ticketBody = (out) => {
  const top = out.findIndex(l => /^┌ 1 Actions/.test(strip(l)));
  const bottom = out.findIndex((l, i) => i > top && strip(l).startsWith('└'));
  return out.slice(top + 1, bottom);
};
// The open tab's text, each row cut at the tab box's inner width; the panel's, at its own.
const tabOf = (out, size = wide) => ticketBody(out).map(l => clip(from(l, 2), size.columns - PANEL - 3).trimEnd());
const panelOf = (out, size = wide) => ticketBody(out).map(l => clip(from(l, size.columns - PANEL + 2), PANEL - 4).trimEnd());
// The History tab's states pane (STATES_WIDTH 28: 24 of text) and its timeline beside it.
const statesPane = out => ticketBody(out).map(l => clip(from(l, 2), 24).trimEnd());
const timelineOf = (out, size = wide) => ticketBody(out).map(l => clip(from(l, 29), size.columns - PANEL - 30).trimEnd());
// The states under the pane's header, in order, each one's wrapped lines rejoined into one string.
const statesOf = out => statesPane(out).slice(1).join('\n').split(/\n↓\n/).map(e => e.trim().replace(/\s*\n\s*/g, ' ')).filter(Boolean);
// The state the pane shows in reverse video on the unstripped screen `raw`, its wrapped lines rejoined.
const currentOf = raw => ticketBody(raw).map(l => clip(from(l, 2), 24)).filter(c => c.includes('\x1b[7m')).map(c => strip(c).trim()).join(' ');

// ===== ASS-184: the ticket screen's tabs, left, beside a quick-details panel, right =====
// (ASS-101's four columns and ASS-102's section headers gave way to these.)
const digit = n => key(String(n), { sequence: String(n) });
const onHistory = s => onTab(s, 'history');
const tabBarRaw = (s, size = wide) => render(s, size).find(l => strip(l).startsWith('┌ 1 Actions'));

test('ASS-184 AC1: five numbered tabs fill the width left of a 40-column panel; no line wider than the screen at any width', () => {
  const open = press(ticketOn(fourSteps, 'code-review'), 'return');
  for (const size of [wide, screen, narrow]) {
    const out = lines(open, size);
    const top = out.find(l => l.startsWith('┌ 1 Actions'));
    assert.match(top, size === narrow ? /^┌ 1 Actions │ 2 Details │ 3 History │ 4 Questions │ 5 Chat ─+┐$/   // no panel under 100 columns (ASS-185)
      : /^┌ 1 Actions │ 2 Details │ 3 History │ 4 Questions │ 5 Chat ─+┬ Ticket ─+┐$/, `${size.columns}`);
    if (size === narrow) continue;
    assert.equal(top.indexOf('┬'), size.columns - PANEL, `${size.columns}`);
    for (const line of ticketBody(out)) assert.match(from(line, size.columns - PANEL), /^[│█] /, `${size.columns}: ${line}`);
  }
  for (const size of [wide, screen, narrow, veryNarrow]) {
    for (const tab of TAB_IDS) for (const line of render(onTab(open, tab), size)) assert.ok(visible(line) <= size.columns, `${size.columns} ${tab}: ${line}`);
  }
});

test('ASS-184 AC4: the screen opens on Actions when a gate waits, else on Questions when one is open, else on Chat — sprint or backlog; the tab bar highlights it', () => {
  const opened = s => press(s, 'return');
  assert.equal(opened(atGate()).ticketTab, 'actions');
  assert.equal(opened(leaving(true)).ticketTab, 'actions');                 // a gate on leaving, its work done
  assert.equal(opened(pending()).ticketTab, 'actions');                     // a pending requirements change
  assert.equal(opened(asked()).ticketTab, 'questions');
  const answered = asked();
  answered.projects[0].questions = ticketQuestions.filter(q => q.status !== 'Asked' && q.status !== 'Answer Rejected');
  assert.equal(opened(answered).ticketTab, 'chat');
  assert.equal(opened(onGrid).ticketTab, 'chat');
  const both = atGate();
  both.projects[0].questions = [question('Which way?', 'ABC-6')];
  assert.equal(opened(both).ticketTab, 'actions');                         // the gate comes first
  assert.equal(onBacklogTicket('awaiting-approval').ticketTab, 'actions');
  assert.equal(onBacklogTicket('groom').ticketTab, 'chat');
  for (const [s, label] of [[opened(atGate()), '1 Actions ●'], [opened(asked()), '4 Questions (2) ●'], [opened(onGrid), '5 Chat']]) {   // with their badges (ASS-185)
    assert.deepEqual([...tabBarRaw(s).matchAll(/\x1b\[7m(.*?)\x1b\[0m/g)].map(m => strip(m[1]).trim()), [label]);
  }
  assert.deepEqual([...tabBarRaw(onTab(opened(onGrid), 'history')).matchAll(/\x1b\[7m([^\x1b]*)\x1b\[0m/g)].map(m => m[1].trim()), ['3 History']);
});

test('ASS-184 AC3: tab and shift-tab switch tabs in order, round again, from Chat too; 1–5 jump to a tab except while typing', () => {
  const open = onTab(press(blockable('code-review'), 'return'), 'actions');
  const cycle = TAB_IDS.reduce((acc) => [...acc, handleKey(acc.at(-1), key('tab'), wide)], [open]).map(s => s.ticketTab);
  assert.deepEqual(cycle, [...TAB_IDS, 'actions']);
  assert.equal(handleKey(open, key('tab', { shift: true }), wide).ticketTab, 'chat');
  assert.equal(handleKey(onTab(open, 'chat'), key('tab', { shift: true }), wide).ticketTab, 'questions');
  for (const from of TAB_IDS.filter(t => t !== 'chat')) {
    assert.deepEqual([1, 2, 3, 4, 5].map(n => handleKey(onTab(open, from), digit(n), wide).ticketTab), TAB_IDS, from);
  }
  const chat = handleKey(onTab(open, 'chat'), digit(2), wide);              // typing: the digit is text
  assert.deepEqual([chat.ticketTab, chat.ticketChatDraft], ['chat', '2']);
  const answering = handleKey(press(asked(), 'return'), key('return'), wide);
  assert.ok(answering.draft);
  const typed = handleKey(answering, digit(2), wide);
  assert.deepEqual([typed.ticketTab, typed.draft.answer.endsWith('2')], ['questions', true]);
  const priority = press(onTab(press(prioritised(null), 'return'), 'actions'), 'return');
  assert.deepEqual([handleKey(priority, digit(3), wide).priorityDraft, handleKey(priority, digit(3), wide).ticketTab], ['3', 'actions']);
});

test('ASS-184 AC3: esc closes from every tab; space and ! still pause except on Chat, where they are text; ? opens the menu except on Chat', () => {
  const open = press(blockable('code-review'), 'return');
  for (const tab of TAB_IDS) assert.equal(press(onTab(open, tab), 'escape').ticket, null, tab);
  for (const tab of TAB_IDS.filter(t => t !== 'chat')) {
    assert.ok(press(onTab(open, tab), 'space').pauses['example']?.human, tab);
    assert.ok(handleKey(onTab(open, tab), key('!', { sequence: '!' }), wide).pauses.all?.human, tab);
    assert.equal(handleKey(onTab(open, tab), key('?', { sequence: '?' }), wide).menuOpen, true, tab);
  }
  const chat = chatType(onTab(open, 'chat'), ' !?');
  assert.deepEqual([chat.ticketChatDraft, chat.pauses, chat.menuOpen], [' !?', open.pauses, false]);
});

test('ASS-184 AC3: the keys line says how to switch tabs and what ↑/↓ do on the open one', () => {
  const open = press(blockable('code-review'), 'return');
  const hint = tab => lines(onTab(open, tab), wide).find(l => l.startsWith('esc returns to the sprint'));
  assert.match(hint('actions'), /tab or 1-5 switch tabs {3}↑\/↓ choose {3}enter records the choice/);
  assert.match(hint('details'), /tab or 1-5 switch tabs {3}↑\/↓ scroll the details/);
  assert.match(hint('history'), /↑\/↓ entry by entry/);
  assert.match(hint('questions'), /↑\/↓ choose a question {3}enter answers it/);
  assert.match(hint('chat'), /tab switches tabs {3}type a message, enter sends it/);
});

test('ASS-184 AC1: each tab keeps its own scroll position as the operator switches between them', () => {
  const s = { ...onGrid, projects: [{ ...detailProject, sprint: { ...detailProject.sprint, features: [bothLong] } }] };
  const details = press(onTab(press(s, 'return'), 'details'), 'down', 'down', 'down');
  const history = press(handleKey(details, digit(3), wide), 'down', 'down');
  const chat = { ...handleKey(history, key('tab'), wide), ticketChatLog: longLog };
  const scrolledChat = press(handleKey(chat, key('tab'), wide), 'up', 'up');
  assert.equal(scrolledChat.ticketTab, 'chat');
  const back = handleKey(handleKey(scrolledChat, key('tab'), wide), digit(2), wide);
  assert.deepEqual([back.ticketScroll, back.ticketHistoryScroll, back.ticketChatScroll], [3, history.ticketHistoryScroll, scrolledChat.ticketChatScroll]);
  assert.ok(history.ticketHistoryScroll > 0 && scrolledChat.ticketChatScroll != null);
  assert.deepEqual(tabOf(lines(back, wide)), tabOf(lines(details, wide)));   // the details as they were left
});

test('ASS-184 AC3/AC5: every action is reachable from the Actions tab and from no other — enter and ↑/↓ elsewhere record, ask or open nothing', () => {
  const s = blockable('code-review');
  s.projects[0].sprint.features[0]['worked-manually'] = { by: 'alice', since: '2026-10-27T10:05:00Z' };
  const open = press(s, 'return');
  const acting = onTab(open, 'actions');
  const choices = ['Block this ticket', 'Set manual priority', 'Gate when leaving states', 'Hand back to control', 'Pause this ticket', 'Delete ticket'];
  const shown = tabOf(lines(acting, wide)).join('\n');
  for (const c of choices) assert.ok(shown.includes(c), c);
  const did = st => st.decide ?? st.ticketConfirm ?? st.priorityDraft ?? st.gatesDraft ?? st.reasonDraft ?? st.demoRun;
  choices.forEach((c, i) => assert.ok(did(press(acting, ...Array(i).fill('down'), 'return')) != null, c));
  for (const tab of TAB_IDS.filter(t => t !== 'actions')) {
    const there = onTab(open, tab);
    assert.ok(!choices.some(c => tabOf(lines(there, wide)).join('\n').includes(c)), `${tab} shows no action`);
    for (const keys of [['return'], ['down', 'return'], ['down', 'down', 'return']]) {
      const after = press(there, ...keys);
      assert.equal(did(after) ?? null, null, `${tab}: ${keys}`);
      assert.equal(after.ticketChoice, open.ticketChoice, `${tab}: ${keys}`);
    }
  }
});

test('ASS-184 AC2: the panel shows the ticket\'s key facts in order, the same on every tab, never scrolled; Needs you when a gate or a question waits', () => {
  const open = press(onGrid, 'return');
  const panel = panelOf(lines(open, wide));
  assert.deepEqual(panel.slice(0, 17), [
    '✨ ABC-5 · A', 'Detailed', '', 'State: Code Review (1, 1)', '  since 09-29 10:00 UTC (2d 6h)', 'Agents: 🤖 Daredevil', '',
    'Priority 4 · Points 8', 'Jira: In Progress · Pat Owner', '', 'MRs: !55 Open Passed', 'Tests: 3/4 passing', 'Health: Long health: the whole stor…', '',
    'Spend $0.86 · Agent time —', 'Branch: change/ABC-5', '',
  ]);
  for (const tab of TAB_IDS) assert.deepEqual(panelOf(lines(press(onTab(open, tab), 'down', 'down'), wide)), panel, tab);
  assert.ok(panelOf(lines(press(atGate(), 'return'), wide)).includes('Needs you: Payment Gate — tab 1'));
  assert.ok(panelOf(lines(press(asked(), 'return'), wide)).includes('Needs you: 2 open questions — tab 4'));
  assert.match(render(press(atGate(), 'return'), wide).find(l => strip(l).includes('Needs you')), /\x1b\[31mNeeds you/);
  const backlog = panelOf(lines(onBacklogTicket('awaiting-approval'), wide));
  assert.equal(backlog[0], '✨ ABC-60 · A');
  assert.ok(backlog.includes('Needs you: Awaiting Approval — tab 1'), backlog.join('\n'));
});

test('ASS-184 AC1: the Actions tab shows, below the choices, what the decision is about — the requirements change\'s current and new descriptions; the Details tab no longer does', () => {
  const open = press(pending(), 'return');
  const actions = tabOf(lines(open, { ...wide, rows: 80 }), wide);
  const at = actions.findIndex(l => l.startsWith('── Pending requirements change'));
  assert.ok(at > actions.findIndex(l => l.includes('Delete ticket')), actions.join('\n'));
  assert.match(actions[at + 1], /detected 2026-10-25 12:00 UTC/);
  assert.match(actions[at + 2], /Current +│ New/);
  assert.match(actions[at + 3], /Every field this ticket has.* │ New requirements/);
  assert.ok(!tabOf(lines(onTab(open, 'details'), { ...wide, rows: 80 })).some(l => l.includes('Pending requirements change')));
});

test('ASS-101 AC2/AC3/AC11, ASS-184 AC1: the History tab lists the states beside the timeline — the pipeline in order, ↓ between, quarantine after, each with its visits and dispatches', () => {
  const open = onHistory(press(ticketOn(quarantineSteps, 'plan', { 'state-changes': quarantineHistory }), 'return'));
  const out = lines(open, { ...wide, rows: 80 });
  assert.equal(statesPane(out)[0], 'States');
  const states = statesOf(out);
  assert.deepEqual(states.map(e => e.replace(/ \(\d+, \d+\)$/, '')), [...fourSteps, ...quarantineSteps.slice(4)].map(s => s.name));
  assert.ok(states.includes('Plan (1, 2)') && states.includes('Blocked (1, 1)') && states.includes('Add Screenshots to Merge Request (0, 0)'), states.join('\n'));
  assert.equal(statesPane(out).filter(l => l.trim() === '↓').length, quarantineSteps.length - 1);
  assert.ok(!statesPane(out).join('\n').includes('…'), 'a long name wraps whole');
  assert.ok(timelineOf(out).some(l => /2026-09-28 10:00 UTC {2}Plan +→ {3}Build/.test(l)), timelineOf(out).join('\n'));
  const one = statesPane(lines(onHistory(press(ticketOn([{ id: 'only', name: 'Only Step', sequence: 1, action: { type: 'prompt' } }], 'only'), 'return')), wide));
  assert.deepEqual([one.filter(l => l.trim() === '↓').length, one.some(l => l.startsWith('Only Step'))], [0, true]);
});

test('ASS-101 AC2/AC3/AC11: a backlog ticket\'s History lists its refinement engine\'s steps, names alone, no quarantine', () => {
  const open = onHistory(onBacklogTicket('groom'));
  assert.deepEqual(statesOf(lines(open, { ...wide, rows: 80 })), refinementEngine.steps.map(s => s.name));
  for (const name of ['Stuck', 'Self Healing', '(']) assert.ok(!statesPane(lines(open, wide)).slice(1).join('\n').includes(name), name);
});

test('ASS-101 AC1/AC4/AC12/AC14: the History tab\'s states open centred on the current one, in reverse video on every line it wraps onto — sprint or backlog', () => {
  assert.equal(currentOf(render(onHistory(press(ticketOn(fourSteps, 'screenshots'), 'return')), wide)), 'Add Screenshots to Merge Request (0, 0)');
  assert.equal(currentOf(render(onHistory(press(ticketOn(fourSteps, 'plan'), 'return')), wide)), 'Plan (0, 0)');
  const short = { ...wide, rows: 30 };
  const deep = render(onHistory(handleKey(ticketOn(twentySteps, 'step-18'), key('return'), short)), short);
  assert.equal(currentOf(deep), 'Step 18 (0, 0)');
  assert.ok(!statesOf(deep.map(strip)).includes('Step 1 (0, 0)'), 'scrolled to it');
  for (const [at, step] of [['groom', 'Groom'], ['awaiting-answers', 'Awaiting Answers'], ['estimate', 'Estimate'], ['ready', 'Ready']]) {
    assert.equal(currentOf(render(onHistory(onBacklogTicket(at)), wide)), step, at);
  }
});

test('ASS-101 AC5/AC6, ASS-184 AC1: the Details tab holds the fields and no history; the History tab the history and no fields; each scrolls alone', () => {
  const open = press(onGrid, 'return');
  const details = tabOf(lines(onTab(open, 'details'), wide));
  assert.ok(details[0].startsWith('Ticket number'));
  assert.ok(!details.some(l => l.includes('  →  ')));
  const timeline = timelineOf(lines(onHistory(open), wide));
  assert.ok(timeline.some(l => l.includes('→')) && !timeline.some(l => l.startsWith('Ticket number')));
  const scrolledDetails = handleKey(onTab(open, 'details'), key('down'), wide);
  assert.deepEqual([scrolledDetails.ticketScroll, scrolledDetails.ticketHistoryScroll], [1, 0]);
  const s = { ...onGrid, projects: [{ ...detailProject, sprint: { ...detailProject.sprint, features: [shortOverLong] } }] };
  const scrolledHistory = handleKey(onHistory(press(s, 'return')), key('down'), wide);
  assert.ok(scrolledHistory.ticketHistoryScroll > 0);
  assert.equal(scrolledHistory.ticketScroll, 0);
});

test('ASS-64 AC4: scrolling the history reaches the last row of an entry wrapped onto extra rows, none of it cut with …', () => {
  const crowd = Array.from({ length: 12 }, (_, i) => ({ 'dispatched-to': i === 11 ? 'Last-Agent' : `Agent-${i}`, timestamp: '2026-09-29T10:00:00Z' }));
  const wrapped = [...longHistory, { 'from-state': 'build', 'to-state': 'plan', timestamp: '2026-09-30T10:00:00Z', 'agent-dispatch-log': crowd }];
  const open = onHistory(press(ticketOn(quarantineSteps, 'plan', { 'state-changes': wrapped }), 'return'));
  const end = Array(200).fill('down').reduce((s, k) => handleKey(s, key(k), wide), open);
  const out = timelineOf(lines(end, wide));
  const last = out.findIndex(l => l.includes('🤖 Last-Agent'));
  assert.ok(last >= 0, out.join('\n'));
  assert.ok(out.slice(last - 3, last + 1).some(l => /(^|│) +→   Plan 🤖 Agent-0/.test(l)), 'its → row above, at the text column');
  assert.ok(!out.some(l => l.includes('🤖') && l.includes('…')), out.join('\n'));
});

// ASS-145: History entries of different heights — every third crowded with agents, so it wraps onto extra rows.
const mixedHistory = longHistory.slice(0, 24).map((c, i) => (i % 3 ? c : { ...c, 'agent-dispatch-log': Array.from({ length: 6 + i % 4 }, (_, k) => ({ 'dispatched-to': `Agent-${k}`, timestamp: c.timestamp })) }));
// The history's lines and entry starts as the History tab lays them out: ticketLines at the timeline's inner width.
const historyAt = (steps, changes, size = wide) => ticketLines({ icon: '✨', key: 'ABC-5', title: 'T', variation: { 'local-testing': {}, 'state-changes': changes } }, {
  status: '', stepName: id => steps.find(s => s.id === id)?.name ?? id, prompted: id => steps.find(s => s.id === id)?.action?.type === 'prompt',
  agents: [], columns: size.columns - PANEL - 30,
});

test('ASS-145 AC1/AC2: ↓ on History moves to the next entry\'s first row whatever the heights, then to its last row; ↑ back to each entry\'s first row', () => {
  const open = onHistory(press(ticketOn(quarantineSteps, 'plan', { 'state-changes': mixedHistory }), 'return'));
  const { starts } = historyAt(quarantineSteps, mixedHistory);
  assert.ok(new Set(starts.slice(1).map((at, i) => at - starts[i])).size > 1, 'entries of different heights');
  const downs = [open];
  for (let s = handleKey(open, key('down'), wide); s !== downs.at(-1); s = handleKey(s, key('down'), wide)) downs.push(s);
  const scrolls = downs.slice(1).map(s => s.ticketHistoryScroll);
  const last = scrolls.at(-1);
  assert.ok(last > 0 && !starts.includes(last), `the end is not itself an entry start: ${last}`);
  assert.deepEqual(scrolls, [...starts.filter(at => at > 0 && at < last), last], 'each entry\'s first row, then the end');
  const ups = [downs.at(-1)];
  for (let s = handleKey(ups[0], key('up'), wide); s !== ups.at(-1); s = handleKey(s, key('up'), wide)) ups.push(s);
  assert.deepEqual(ups.slice(1).map(s => s.ticketHistoryScroll), starts.filter(at => at < last).toReversed(), 'from the end, the nearest entry start above, then each one back to the top');
});

test('ASS-101 AC7, ASS-184 AC1: the Questions tab lists only this ticket\'s questions, every answer status included, under Status, Scope and Question', () => {
  const open = press(asked(), 'return');
  const tab = tabOf(lines(open, wide)).join('\n');
  for (const text of ['Bluebook or ALWD', 'Feature flag', 'Staging database', 'citation style', 'Status', 'Scope', 'Question']) assert.ok(tab.includes(text), text);
  for (const text of ['Import format', 'Who owns this', 'Answer Status', 'All open (']) assert.ok(!tab.includes(text), text);
  const after = handleKey(open, key('right'), wide);
  assert.deepEqual([after.questionFilter, after.ticketTab], [open.questionFilter, 'questions']);
});

test('ASS-101 AC7: enter on the Questions tab opens the answer form', () => {
  const formed = handleKey({ ...press(asked(), 'return'), ticketQuestionSelected: 0 }, key('return'), wide);
  assert.equal(formed.draft?.field, 'answer');
});

test('ASS-101 AC7: an answer typed on the ticket screen is saved for the question the Questions tab has selected', () => {
  const open = press(asked(), 'return');
  const focused = { ...open, ticketQuestionSelected: 0, questionSelected: 2 };
  const typed = typing(press(typing(press(typing(press(focused, 'return'), '  Flag it  '), 'tab'), ' Safer. '), 'tab'), '-wide');
  const saved = press(typed, 'return');
  assert.deepEqual(saved.submit, { project: open.projects[open.project].id, source: 'global', index: 0, answer: 'Flag it', 'why-this-answer': 'Safer.', scope: 'project-wide' });
  assert.equal(saved.draft, null);
  assert.equal(saved.ticket?.key, 'ABC-5', 'still on the ticket screen');
});

test('ASS-35, ASS-184 AC1: the Chat tab is the chat alone — its log over the prompt line, the full width of the tabs', () => {
  const chat = tabOf(lines({ ...press(blockable('code-review'), 'return'), ticketChatLog: ['> hi', 'Hi: ABC-5 is in code review.'] }, wide));
  assert.deepEqual(chat.slice(0, 2), ['> hi', 'Hi: ABC-5 is in code review.']);
  assert.ok(chat.at(-1).startsWith('> '), chat.join('\n'));
  assert.ok(!chat.some(l => /Block this ticket|Ticket number|States/.test(l)));
});

test('ASS-101 AC9: enter on the Actions tab records the choice', () => {
  const onActions = { ...press(blockable('code-review'), 'return'), ticketTab: 'actions', ticketChoice: 0 };
  assert.ok(tabOf(lines(onActions, wide)).some(l => l.includes('Block this ticket')));
  assert.deepEqual(handleKey(handleKey(onActions, key('return'), wide), key('y', { sequence: 'y' }), wide).decide, ['ticket:change-state', 'example', 'ABC-5', 'A', 'code-review', 'stuck']);   // once confirmed (ASS-131)
});

test('ASS-51 AC5: a backlog ticket at Ready, its engine\'s done step, offers no Accept/Reject, and the backlog shows its step', () => {
  const open = onBacklogTicket('ready');
  assert.ok(!tabOf(lines(onTab(open, 'actions'), wide)).some(l => /Accept|Reject/.test(l)));
  assert.deepEqual(open.decide ?? null, null);
  assert.ok(statesPane(lines(onHistory(open), wide)).some(l => l.includes('Ready')), 'History lists Ready');
  assert.match(lines(handleKey(withBacklog([backlogTicket('ABC-60', 'ready')]), key('b')), wide).find(l => l.includes('ABC-60')), / Ready /);   // named (ASS-150)
});

test('the Actions tab draws with no decision to make: Set manual priority alone on a groomed backlog ticket whose work merged; a gate with no human exit says so', () => {
  // Grooming, its work merged: no decision, and no Delete ticket (ASS-104); only Set manual priority (ASS-100).
  const groom = press(handleKey(withBacklog([backlogTicket('ABC-60', 'groom', { variations: [{ name: 'A', 'harness-status': { state: 'groom', 'state-engine': 'example-backlog-refinement' }, 'merge-request': [{ key: '!1', 'build-status': 'Merged' }] }] })], { workflows: [refiningEngine, refinementEngine] }), key('b')), 'return');
  assert.deepEqual(actionsOf(lines(onTab(groom, 'actions'), wide)).filter(l => /Delete ticket|Accept|Reject|Set manual priority/.test(l)).map(l => l.trim()), ['▸ Set manual priority']);
  const quietSteps = [
    { id: 'gate', name: 'Quiet Gate', sequence: 5, action: { type: 'human' }, 'exit-events': [{ condition: { 'ticket-system-status': 'Done' }, 'move-to-state': 'work' }] },
    { id: 'work', name: 'Working', sequence: 6, action: { type: 'prompt' } },
  ];
  const quiet = press({ ...atGate(), workflows: [{ name: 'e', steps: quietSteps }] }, 'return');
  assert.equal(quiet.ticketTab, 'chat', 'nothing to choose there, so the screen does not open on Actions');
  assert.ok(actionsOf(lines(onTab(quiet, 'actions'), wide))[0].startsWith('Steer this ticket by hand.'));
});

// ── The dashboard grid opening scrolled to the not-done work (ASS-60). The test
// data its plan (projects/harness/work/ASS-60/test-plan.md) needs beyond the
// fixtures above; each fixture names the acceptance criteria that reads it. The
// grid body holds only ~7 rows on `wide`, so a test that needs the last Done row
// at the very top with every not-done row still in view sizes the not-done rows
// against the rendered row count (`full(s).length`), not a fixed number — the
// factories below take the counts so a test can build whichever case it needs.

// An engine whose Done step is the top sequence (sprintTickets' `done` =
// Math.max(...sequences)) with one step beneath it: a variation at `done` draws a
// Done row, one at `build` a not-done row. The Done-first sort puts every Done row
// above every not-done one (AC1, AC2, AC3, AC4, AC5).
const gridSteps = [
  { id: 'build', name: 'Build', sequence: 5 },
  { id: 'done', name: 'Done', sequence: 32, 'is-done': true },
];
// One grid row: a single-variation ticket at `step`. Done rows are keyed D-n and
// not-done rows N-n so a test can tell them apart, and `priority` fixes the order
// within a step (sprintTickets sorts by sequence desc, then priority asc).
const gridTicket = (key, step, priority = 0) => ({ key, title: 'T', priority, ...single({ 'harness-status': hs(step) }) });
// `doneCount` Done rows (D-0…) above `notDoneCount` not-done rows (N-0…), already
// in grid order. gridRows(0, 0) is the empty sprint (AC2 edge); gridRows(n, 0) has
// no not-done row, gridRows(0, n) no Done row (AC2); a count under the grid's ~7
// rows fits in full (AC2). (AC1, AC2, AC3, AC5)
const gridRows = (doneCount, notDoneCount) => [
  ...Array.from({ length: doneCount }, (_, i) => gridTicket(`D-${i}`, 'done', i)),
  ...Array.from({ length: notDoneCount }, (_, i) => gridTicket(`N-${i}`, 'build', i)),
];
// The dashboard on a sprint of those rows, grid focused, under gridSteps. `extra`
// overrides state (e.g. a resolved selected/scroll, or a smaller render size for
// AC5's resize) (AC1, AC2, AC3, AC5).
const gridState = (features, extra = {}) => ({
  ...initialState({
    projects: [{ name: 'P', stateEngine: 'e', sprint: { ...sprint, features, bugs: [], spikes: [] } }],
    workflows: [{ name: 'e', steps: gridSteps }],
  }),
  focus: 'tickets', ...extra,
});
// Two projects, each its own Done/not-done mix, for the menu ←/→ switch: the grid
// re-opens by the rule for whichever project's sprint is shown, independent of
// where the other was left (AC4).
const gridProjects = [
  { name: 'P', stateEngine: 'e', sprint: { ...sprint, features: gridRows(40, 2), bugs: [], spikes: [] } },
  { name: 'Q', stateEngine: 'e', sprint: { ...sprint, features: gridRows(2, 40), bugs: [], spikes: [] } },
];
const gridMenuState = { ...initialState({ projects: gridProjects, workflows: [{ name: 'e', steps: gridSteps }] }), focus: 'tickets' };
// A project with a past-day snapshot (within the sprint's 2026-09-18…10-01), each
// day its own Done/not-done mix, for the day ←/→ switch: each day's grid opens by
// the rule for that day's rows (AC4).
const gridDays = {
  name: 'P', stateEngine: 'e',
  sprint: { ...sprint, features: gridRows(40, 2), bugs: [], spikes: [] },
  days: { '2026-09-30': { ...sprint, features: gridRows(3, 40), bugs: [], spikes: [] } },
};
const gridDayState = { ...initialState({ projects: [gridDays], workflows: [{ name: 'e', steps: gridSteps }] }), focus: 'tickets' };

// The grid's rows as drawn (D-n / N-n keys), those shown in full (the last may be
// cut by the bottom border), and the highlighted one.
const gridKey = l => l.match(/[DN]-\d+/)[0];
const gridShown = (s, size = wide) => render(s, size).map(strip).filter(l => /[DN]-\d+:/.test(l)).map(gridKey);
const gridFull = (s, size = wide) => render(s, size).map(strip).filter((l, i, all) => /[DN]-\d+:/.test(l) && !all[i + 1].startsWith('└')).map(gridKey);
const gridHighlighted = (s, size = wide) => render(s, size).filter(l => /[DN]-\d+:/.test(l) && l.includes('\x1b[7m')).map(gridKey);
// How many rows the grid shows in full on `wide`.
const gridHolds = gridFull(gridState(gridRows(0, 60))).length;

test('ASS-60 AC1: with more Done rows than fit, the grid opens on the last Done ticket, selected, with the not-done work beneath', () => {
  const s = gridState(gridRows(40, gridHolds - 1));
  assert.deepEqual(gridFull(s), ['D-39', ...Array.from({ length: gridHolds - 1 }, (_, i) => `N-${i}`)]);
  assert.deepEqual(gridHighlighted(s), ['D-39']);
});

test('ASS-60 AC1: with fewer not-done rows than the grid holds, it opens scrolled to the end, still full, every not-done row in view', () => {
  const s = gridState(gridRows(40, 2));
  const firstDone = 42 - gridHolds;                  // as far up as still fills the grid
  assert.deepEqual(gridFull(s), [...Array.from({ length: gridHolds - 2 }, (_, i) => `D-${firstDone + i}`), 'N-0', 'N-1']);
  assert.deepEqual(gridHighlighted(s), [`D-${firstDone}`]);   // the view's first row, not the last Done one
});

test('ASS-60 AC2: with no Done row, no not-done row, every row fitting, or no rows, the grid opens at the top', () => {
  for (const [rows, first] of [[gridRows(0, 20), 'N-0'], [gridRows(20, 0), 'D-0'], [gridRows(1, 2), 'D-0']]) {
    const s = gridState(rows);
    assert.equal(gridShown(s)[0], first);
    assert.deepEqual(gridHighlighted(s), [first]);
  }
  const empty = gridState(gridRows(0, 0));
  assert.ok(lines(empty, wide).some(l => /No tickets in this sprint/.test(l)));
  assert.equal(handleKey(empty, key('return'), wide), empty);
});

test('ASS-60 AC3: the first ↓ or ↑ moves from the row the grid opened on, scrolling only as it must; return as the first key opens that row', () => {
  const s = gridState(gridRows(40, gridHolds - 1));
  const down = press(s, 'down');
  assert.deepEqual(gridHighlighted(down), ['N-0']);
  assert.deepEqual(gridFull(down), gridFull(s));      // N-0 is already in view
  const up = press(s, 'up');
  assert.deepEqual(gridHighlighted(up), ['D-38']);
  assert.deepEqual(gridShown(up)[0], 'D-38');         // the view follows up one row, not to the top
  assert.equal(handleKey(s, key('return'), wide).ticket.key, 'D-39');
});

test('ASS-60 AC4: a project or day change opens the new sprint\'s grid by the same rule', () => {
  const moved = press(gridMenuState, 'down', 3);                 // P scrolled by hand
  const q = handleKey({ ...moved, focus: 'menu' }, key('right'), wide);
  assert.deepEqual(gridShown({ ...q, focus: 'tickets' })[0], 'D-1');            // Q: 2 Done above 40 not-done
  const p = handleKey(q, key('left'), wide);
  assert.deepEqual(gridHighlighted({ ...p, focus: 'tickets' }), [`D-${42 - gridHolds}`]);   // P afresh, not where it was left

  const past = handleKey({ ...press(gridDayState, 'down', 3), focus: 'day' }, key('left'), wide);
  assert.equal(past.day, '2026-09-30');
  assert.deepEqual(gridHighlighted({ ...past, focus: 'tickets' }), ['D-2']);    // that day: 3 Done above 40 not-done
  const today = handleKey(past, key('right'), wide);
  assert.deepEqual(gridHighlighted({ ...today, focus: 'tickets' }), [`D-${42 - gridHolds}`]);
});

test('ASS-60 AC5: until the operator scrolls, a reload or a resize places the grid again; once scrolled, it stays put', () => {
  const s = gridState(gridRows(40, gridHolds - 1));
  const reloaded = { ...s, projects: [{ ...s.projects[0], sprint: { ...sprint, features: gridRows(41, gridHolds - 1), bugs: [], spikes: [] } }] };
  assert.deepEqual(gridHighlighted(reloaded), ['D-40']);             // the Done boundary followed
  const short = { ...wide, rows: wide.rows - 4 };
  const holds = gridFull(s, short).length;
  assert.ok(holds < gridHolds);
  assert.deepEqual(gridShown(s, short)[0], 'D-39');                  // still the last Done ticket on top
  assert.deepEqual(gridFull(gridState(gridRows(40, 2)), short)[0], `D-${42 - holds}`);   // pulled up to stay full

  const scrolled = press(s, 'up');                                   // D-38, a number now
  const after = { ...scrolled, projects: reloaded.projects };
  assert.deepEqual(gridHighlighted(after), ['D-38']);
  assert.deepEqual(gridShown(after)[0], 'D-38');
});

// The Demo action (ASS-76): at Human Review, a variation whose demo plan has
// demo: true is offered Demo (vm:demo, run by main.js), its plan's view and
// look-at list shown under the actions; demo: false or no plan, no Demo.
const reviewSteps = [
  { id: 'human-review', name: 'Human Review', sequence: 5, action: { type: 'human' }, 'exit-events': [
    { condition: { 'human-review': 'Approved' }, 'move-to-state': 'work' },
    { condition: { 'human-review': 'Rejected' }, 'move-to-state': 'work' },
  ] },
  { id: 'work', name: 'Working', sequence: 6, action: { type: 'prompt' } },
];
const DEMO = { demo: true, setup: ['make up'], 'ready-check': 'curl -f localhost:3000', view: { with: 'browser', address: 'http://localhost:3000/opinions' }, 'look-at': ['the citation reads 123 F.3d 456', 'the old Lexis cite is gone'] };
const atReview = (plan, status = 'human-review') => ({
  ...initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'e', demoPlans: plan ? { 'ABC-6': { A: plan } } : {}, sprint: { ...sprint, features: [gated({ 'harness-status': { state: status, 'state-engine': 'e' } })], bugs: [], spikes: [] } }], workflows: [{ name: 'e', steps: reviewSteps }] }),
  focus: 'tickets',
});

test('at Human Review a variation whose demo plan has demo: true is offered Demo after the gate\'s choices, with the plan\'s view and what to look at; enter asks main.js to run vm:demo and says it is starting', () => {
  const open = press(atReview(DEMO), 'return');
  const right = actionsOf(lines(open, wide)).join('\n');
  assert.match(right, /Rejected\s+→ Working\n\s+Demo\s+→ the VM's desktop/);
  assert.match(right, /Demo in the VM's browser at\s+http:\/\/localhost:3000\/opinions/);
  assert.match(right, /Look at:\n• the citation reads 123 F\.3d 456\n• the old Lexis cite is gone/);
  const asked = press(open, 'down', 'down', 'return');
  assert.deepEqual(asked.demoRun, ['vm:demo', 'p', 'ABC-6', 'A']);
  assert.equal(asked.decide, null);
  assert.deepEqual(asked.demos['ABC-6.A'], { status: 'starting' });
  assert.match(actionsOf(lines(asked, wide)).join(' '), /starting: the VM restarts with a window onto its desktop/);
  assert.equal(press({ ...asked, demoRun: null }, 'return').demoRun, null);   // not again while it starts
  const ready = { ...asked, demoRun: null, demos: { 'ABC-6.A': { status: 'ready' } } };
  assert.match(actionsOf(lines(ready, wide)).join(' '), /ready: its desktop is open on the Mac/);
  const failed = { ...asked, demoRun: null, demos: { 'ABC-6.A': { status: 'failed', message: 'vm:demo: the ready-check failed' } } };
  assert.match(actionsOf(lines(failed, wide)).join(' '), /vm:demo: the ready-check failed/);
});

// ASS-118: at Human Review the details column opens with everything to judge the variation by.
const REVIEW = { 'ABC-6': {
  explanations: { A: 'Opinions now cite the formal reporter.\nWhy: Lexis cites are not public.' },
  risks: { A: 'Verdict: low risk.\n- MR 1 src/cite.js:12 regex' }, preExisting: { A: ['suite a > slow clock'] },
  screenshots: { 1: ['/w/ABC-6/screenshots/1/criterion-1.png'], '': ['/w/ABC-6/screenshots/criterion-2.png'] },
} };
const MRS = [{ id: 1, key: '!12', url: 'https://gitlab.com/g/r/-/merge_requests/12', status: 'Open', 'is-draft': true }, { id: 2, repository: 'https://gitlab.com/g/r.git', branch: 'b', status: 'Not Created' }];
const atHumanReview = (plan, status = 'human-review', reviews = REVIEW) => {
  const s = atReview(plan, status);
  const [project] = s.projects;
  const [ticket] = project.sprint.features;
  return { ...s, projects: [{ ...project, reviews, sprint: { ...project.sprint, features: [{ ...ticket, variations: [{ ...ticket.variations[0], 'merge-request': MRS }] }] } }] };
};
const detailsOf = out => tabOf(out).join('\n');

test('ASS-118 AC2/AC3, ASS-184 AC1: at Human Review the Actions tab shows the review below the choices — the explanation, the risk profile, each created MR linked with its screenshots then the ticket\'s own, the tests failing on master too, and the demo', () => {
  const out = lines(press(atHumanReview(DEMO), 'return'), { ...wide, rows: 80 });   // on its Actions tab (ASS-184)
  const details = detailsOf(out);
  assert.ok(/^── Human Review ─+$/m.test(details), details);
  for (const part of ['Explanation\n  Opinions now cite the formal reporter.\n  Why: Lexis cites are not public.', 'Risk profile\n  Verdict: low risk.\n  - MR 1 src/cite.js:12 regex',
    'Merge requests and screenshots\n  !12  ', '      screenshot criterion-1.png\n  The ticket as a whole\n      screenshot criterion-2.png', 'Tests failing on master too\n  • suite a > slow clock',
    'Demo\n  choose Demo above to bring it up in its VM']) assert.ok(details.includes(part), `${part}\n---\n${details}`);
  assert.ok(details.indexOf('Delete ticket') < details.indexOf('── Human Review'), 'the review comes below the choices');
  assert.doesNotMatch(details, /MR 2/, 'a planned MR is not one to review');
  assert.doesNotMatch(tabOf(lines(onTab(press(atHumanReview(DEMO), 'return'), 'details'), { ...wide, rows: 80 })).join('\n'), /Explanation|Risk profile/, 'nor on the Details tab');
  // The screenshots and MRs are links (OSC 8): the MR's url, each screenshot's file.
  const raw = render(press(atHumanReview(DEMO), 'return'), { ...wide, rows: 80 }).join('\n');
  assert.ok(raw.includes('\x1b]8;;https://gitlab.com/g/r/-/merge_requests/12\x1b\\') && raw.includes('\x1b]8;;file:///w/ABC-6/screenshots/1/criterion-1.png\x1b\\'));
});

test('ASS-118 AC2/AC3: a ticket without a demo says so — why, or that no plan was written; what is not written yet says so; away from Human Review the Actions tab has no review', () => {
  const why = detailsOf(lines(press(atHumanReview({ demo: false, why: 'a refactor with nothing to see' }), 'return'), { ...wide, rows: 80 }));
  assert.match(why, /Demo\n {2}no demo: a refactor with nothing to see/);
  const none = detailsOf(lines(press(atHumanReview(null, 'human-review', {}), 'return'), { ...wide, rows: 80 }));
  for (const said of ['no demo: no demo plan was written', 'none yet: Explain the Change has not written it', 'none yet: Risk Assessment has not written it', 'no test results yet']) assert.ok(none.includes(said), said);
  const away = lines(onTab(press(atHumanReview(DEMO, 'work'), 'return'), 'actions'), { ...wide, rows: 80 });
  assert.doesNotMatch(detailsOf(away), /Human Review|Explanation|Risk profile/);
});

test('ASS-118 AC1: Rejected at Human Review asks why; enter records it with the reason (ticket:human-review … <reason>), not without one; Approved needs none', () => {
  const open = press({ ...atHumanReview(DEMO), ticketTab: 'actions' }, 'return');
  const asking = press({ ...open, ticketTab: 'actions' }, 'down', 'return');
  assert.equal(asking.reasonDraft, '');
  assert.match(actionsOf(lines(asking, wide)).join('\n'), /Reason:/);
  assert.equal(press(asking, 'return').decide, null);   // not with no reason
  const typed = [...'Too risky'].reduce((s, ch) => handleKey(s, { name: ch === ' ' ? 'space' : ch, sequence: ch }, wide), asking);
  const done = press(typed, 'return');
  assert.deepEqual(done.decide, ['ticket:human-review', 'p', 'ABC-6', 'A', 'human-review', 'Rejected', 'work', 'Too risky']);
  assert.equal(done.reasonDraft, null);
  assert.deepEqual(press({ ...open, ticketTab: 'actions' }, 'return').decide, ['ticket:human-review', 'p', 'ABC-6', 'A', 'human-review', 'Approved', 'work']);
});

// ASS-116 pair 2: the harness's Human Review is a human step inside v2-review's run, with the real engines.
test('ASS-116: at v2-review\'s Human Review, inside the Review group\'s run, the Actions tab shows the review and the choices are recorded at the detailed step for control to move the run — Approved → AI Token Expense Check, Rejected → Back to Plan, asking why', () => {
  const real = name => ({ name, steps: JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'), 'utf8')).steps });
  const into = (from, to) => ({ 'state-engine': 'harness-development-v2', 'from-state': 'review', 'to-state': 'review', timestamp: '2026-10-25T03:00:00Z', 'agent-dispatch-log': [], 'work-is-done': true, 'sub-state-change': { 'state-engine': 'v2-review', 'from-state': from, 'to-state': to } });
  const variation = { name: 'A', 'merge-request': MRS, 'harness-status': { state: 'review', 'state-engine': 'harness-development-v2', 'sub-status': { state: 'human-review', 'state-engine': 'v2-review' } },
    'state-changes': [{ 'state-engine': 'harness-development-v2', 'from-state': 'document', 'to-state': 'review', timestamp: '2026-10-25T02:00:00Z', 'agent-dispatch-log': [] }, into(null, 'explain-the-change'), into('explain-the-change', 'risk-assessment'), into('risk-assessment', 'human-review')] };
  const runs = [{ id: 'run-1', project: 'p', 'state-engine': 'v2-review', state: 'human-review', parent: { 'work-item': 'ABC-6', variation: 'A', 'state-engine': 'harness-development-v2', state: 'review' }, 'state-changes': [{ 'from-state': 'explain-the-change', 'to-state': 'risk-assessment' }, { 'from-state': 'risk-assessment', 'to-state': 'human-review' }] }];
  const s = { ...initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'harness-development-v2', reviews: REVIEW, sprint: { ...sprint, features: [{ key: 'ABC-6', title: 'Legend', priority: 1, variations: [variation] }], bugs: [], spikes: [] } }],
    workflows: [real('harness-development-v2'), real('v2-review')], transientEngines: runs }), focus: 'tickets' };
  const open = press(s, 'return'), out = lines(open, { ...wide, rows: 80 });
  assert.equal(open.ticketTab, 'actions');
  for (const part of ['Explanation\n  Opinions now cite the formal reporter.', 'Risk profile\n  Verdict: low risk.']) assert.ok(detailsOf(out).includes(part), part);
  const actions = actionsOf(out).join('\n');
  assert.match(actions, /Approved\s+→ AI Token Expense Check/);
  assert.match(actions, /Rejected\s+→ Back to Plan/);
  const acting = { ...open, ticketTab: 'actions' };
  assert.deepEqual(press(acting, 'return').decide, ['ticket:human-review', 'p', 'ABC-6', 'A', 'human-review', 'Approved', '']);
  const asking = press(acting, 'down', 'return');
  const typed = [...'No'].reduce((st, ch) => handleKey(st, { name: ch, sequence: ch }, wide), asking);
  // ASS-228 AC4: then the step to return to, Write Execution Plan first (the default), and the command run with both.
  const picking = press(typed, 'return');
  assert.equal(picking.decide, null);
  assert.deepEqual(picking.returnDraft, { reason: 'No', at: 0 });
  assert.match(actionsOf(lines(picking, wide)).join('\n'), /Return to:\n\s*▸ Write Execution Plan\n\s+Write Test Plan\n\s+Generate Solution/);
  assert.deepEqual(press(picking, 'return').decide, ['ticket:human-review', 'p', 'ABC-6', 'A', 'human-review', 'Rejected', '', 'No', 'write-execution-plan']);
  assert.deepEqual(press(picking, 'down', 'return').decide, ['ticket:human-review', 'p', 'ABC-6', 'A', 'human-review', 'Rejected', '', 'No', 'write-test-plan']);
  const solution = press(picking, 'down', 'down', 'down', 'return');
  assert.deepEqual([solution.decide, solution.returnDraft, solution.ticketChoice], [['ticket:human-review', 'p', 'ABC-6', 'A', 'human-review', 'Rejected', '', 'No', 'generate-solution'], null, -1]);
  const cancelled = press(picking, 'escape');
  assert.deepEqual([cancelled.decide, cancelled.returnDraft], [null, null]);   // esc gives up
});

test('a terminal demo shows its commands; no Demo for a plan with demo: false, no plan, or a step other than Human Review', () => {
  const terminal = actionsOf(lines(press(atReview({ ...DEMO, view: { with: 'terminal', commands: ['corpus ingest --dry-run'] } }), 'return'), wide)).join('\n');
  assert.match(terminal, /Demo in a terminal at \/repos\/:\n\$ corpus ingest --dry-run/);
  for (const s of [atReview({ demo: false, why: 'a refactor' }), atReview(null), atReview(DEMO, 'work')]) {
    const out = actionsOf(lines(press(s, 'return'), wide)).join('\n');
    assert.doesNotMatch(out, /Demo|Look at/);
  }
});

// ASS-131: recording a gate's choice leaves nothing selected, so the action
// sliding into its place once the gate is gone (Block, here) is not under the cursor.
test('recording a gate\'s choice clears the selection: once the gate is gone, enter records nothing until a choice is made', () => {
  const steps = [...transitionSteps, { id: 'stuck', name: 'Stuck', sequence: 0, area: 'quarantine', 'is-blocked-state': true }];
  const open = press({ ...leaving(true), workflows: [{ name: 'e', steps }] }, 'return');
  const approved = press(open, 'return');
  assert.deepEqual(approved.decide, ['ticket:change-state', 'p', 'ABC-6', 'A', 'gen', 'work']);
  assert.equal(approved.ticketChoice, -1);
  const variation = approved.projects[0].sprint.features[0].variations[0];
  variation['harness-status'] = hs('work');                   // control moved it on: the gate's choice is gone, Block first
  const moved = { ...approved, decide: null };
  assert.ok(!actionsOf(lines(moved, wide)).some(l => l.includes('▸')));
  assert.equal(press(moved, 'return').decide, null);
  assert.equal(press(moved, 'return').ticketConfirm, null);
  assert.equal(press(moved, 'down').ticketChoice, 0);          // the arrows choose again from the top
});

test('rejecting at Human Review with a reason clears the selection too', () => {
  const asking = press({ ...atHumanReview(DEMO), ticketTab: 'actions' }, 'return', 'down', 'return');   // Rejected: the reason form
  assert.equal(asking.ticketChoice, 1);
  const rejected = press(handleKey(asking, { name: 'n', sequence: 'n' }, wide), 'return');
  assert.ok(rejected.decide);
  assert.equal(rejected.ticketChoice, -1);
});

// ASS-104: Delete ticket, offered on every ticket whose work has not merged,
// asks first — naming the merge requests it closes and what it stops — and
// only y runs ticket:delete; once it has, the screen closes.
const ANSI = /\x1b\[[0-9;]*m/g;
const actionText = s => actionsOf(lines(s, wide)).join(' ').replace(ANSI, '').replace(/\s+/g, ' ');
const deletable = (fields = {}, extra = {}) => {
  const s = blockable('code-review', extra);
  const v = s.projects[0].sprint.features[0].variations[0];
  Object.assign(v, { 'merge-request': [{ key: '!55', status: 'Open', 'build-status': 'Passed', url: 'http://mr/55' }, { key: '!54', status: 'Closed', 'build-status': 'Failed', url: 'http://mr/54' }], vm: { name: 'abc-5-a' } }, fields);
  return { ...press(s, 'return'), ticketTab: 'actions' };
};

test('every sprint ticket offers Delete ticket; one with a merged merge request on a live variation does not', () => {
  assert.ok(actionText(deletable()).includes('Delete ticket'));
  assert.ok(!actionText(deletable({ 'merge-request': [{ key: '!55', status: 'Merged', 'build-status': 'Merged', url: 'http://mr/55' }] })).includes('Delete ticket'));
  assert.ok(!actionText(deletable({ 'merge-request': [{ key: '!55', status: 'Open', 'build-status': 'Merged', url: 'http://mr/55' }] })).includes('Delete ticket'));
});

test('Delete ticket asks first, naming the ticket, the open merge requests it closes and the agents, runs and VM it stops; y runs ticket:delete, any other key gives up', () => {
  const s = deletable({}, {
    assignments: [{ 'agent-name': 'Spock', project: 'example', 'work-item': 'ABC-5', variation: 'A' }, { 'agent-name': 'Hulk', project: 'example', 'transient-state-engine': 'r2' }, { 'agent-name': 'Thor', project: 'example', 'work-item': 'ABC-6' }],
    transientEngines: [{ id: 'r1', project: 'example', 'state-engine': 'test', parent: { 'work-item': 'ABC-5', variation: 'A' } }, { id: 'r2', project: 'example', 'state-engine': 'check-health', parent: { 'transient-state-engine': 'r1' } }, { id: 'r3', project: 'example', 'state-engine': 'self-healing', parent: { trigger: 'self-healing' } }],
  });
  // Enter on each action in turn, from the screen as it is, until one asks to delete.
  const asking = [...Array(12).keys()].map(i => press({ ...s, ticketChoice: i }, 'return')).find(t => t.ticketConfirm?.decision.startsWith('Delete')) ?? s;
  assert.ok(asking.ticketConfirm, 'Delete ticket asks');
  assert.equal(asking.decide, null);
  assert.match(actionText(asking), /Delete ABC-5\? It closes !55; stops Spock, Hulk; ends runs test, check-health; stops VM abc-5-a\. y\/n/);
  const yes = handleKey(asking, key('y', { sequence: 'y' }), wide);
  assert.deepEqual([yes.decide, yes.decideCloses], [['ticket:delete', 'example', 'ABC-5'], true]);
  for (const name of ['n', 'escape', 'return']) {
    const kept = press(asking, name);
    assert.deepEqual([kept.decide, kept.ticketConfirm], [null, null], name);
    assert.ok(kept.ticket, name);
  }
});

test('a backlog ticket offers Delete ticket too, saying when nothing runs on it', () => {
  const s = press(handleKey(withBacklog([backlogTicket('ABC-60', 'groom')]), key('b')), 'return');
  const acting = { ...s, ticketTab: 'actions', ticketChoice: 1 };   // after Set manual priority (ASS-100)
  assert.ok(actionText(acting).includes('Delete ticket'));
  const asking = press(acting, 'return');
  assert.match(actionText(asking), /Delete ABC-60\? Nothing runs on it\. y\/n/);
  assert.deepEqual(handleKey(asking, key('y', { sequence: 'y' }), wide).decide, ['ticket:delete', 'example', 'ABC-60']);
});

test('decided: once ticket:delete has run, the ticket screen closes, back where it was opened from; a failure stays on it, saying why', () => {
  const s = press(handleKey(withBacklog([backlogTicket('ABC-60', 'groom')]), key('b')), 'return');
  const closed = decided(s, null, true);
  assert.deepEqual([closed.ticket, closed.screen, closed.focus], [null, 'b', 'backlog']);
  const failed = decided(s, 'ticket:delete: ABC-60\'s work has merged', true);
  assert.deepEqual([failed.ticket, failed.ticketMessage], [s.ticket, 'ticket:delete: ABC-60\'s work has merged']);
  assert.equal(decided(s, null, false).ticket, s.ticket);
});

// ASS-131: Block this ticket asks first, as deleting a chat does: y blocks, any other key keeps it.
test('Block this ticket asks for confirmation: y sends it, any other key cancels', () => {
  const open = { ...press(blockable('code-review'), 'return'), ticketTab: 'actions' };
  const asking = press(open, 'return');
  assert.equal(asking.decide, null);
  assert.ok(asking.ticketConfirm);
  assert.ok(actionsOf(lines(asking, wide)).some(l => l.includes('Block ABC-5? y/n')));
  const yes = handleKey(asking, key('y', { sequence: 'y' }), wide);
  assert.deepEqual(yes.decide, ['ticket:change-state', 'example', 'ABC-5', 'A', 'code-review', 'stuck']);
  assert.equal(yes.ticketConfirm, null);
  for (const name of ['n', 'escape', 'return']) {
    const kept = press(asking, name);
    assert.deepEqual([kept.decide, kept.ticketConfirm], [null, null], name);
    assert.ok(kept.ticket, name);                               // still on the ticket screen
  }
});

test('ASS-86 AC2: a ticket screen\'s selected question says the ticket it was asked on as a link to its url — a sprint ticket\'s or a backlog one\'s — plain text without one', () => {
  const asked = raw => raw.find(l => strip(l).includes('on ABC-'));
  assert.ok(asked(render(onQuestions, wide)).includes(`on ${link('ABC-1', 'http://t/ABC-1')} at 2026-09-22 14:05 UTC`));
  const bug = { ...initialState({ projects: [{ ...projects[0], questions: [question('Flag?', 'abc-2')] }], workflows: [engine] }), ticket: { key: 'ABC-2', variation: 'A' }, ticketTab: 'questions' };
  const plain = asked(render(bug, wide));
  assert.ok(plain.includes('on ABC-2 at') && !plain.includes('\x1b]8;;'));   // the sprint has no url for it
  const backlog = withBacklog([backlogTicket('ABC-60', 'awaiting-answers', { url: 'file:///h/src/off-board/x/ABC-60.md' })]);
  backlog.projects[0].questions = [question('Which login?', 'abc-60')];
  const opened = { ...handleKey(handleKey(backlog, key('b')), key('return')), ticketTab: 'questions' };
  assert.ok(asked(render(opened, wide)).includes(`on ${link('ABC-60', 'file:///h/src/off-board/x/ABC-60.md')} at`));
});

test('ASS-86 AC3/AC5: the merge requests screen\'s Build links to the build-url, else to the merge request; none is plain; the links take no width', () => {
  const built = { ...reviewing, sprint: { ...reviewing.sprint, 'merge-requests-of-interest': [
    ...reviewing.sprint['merge-requests-of-interest'], mr(2400, null, { 'build-url': 'http://ci/2400' }),
  ] } };
  const raw = render({ ...initialState({ projects: [built], workflows: [engine] }), screen: 'm' }, wide);
  const row = iid => raw.find(l => l.includes(`!${iid}\x1b]8`));
  assert.ok(row(2386).includes(link('success', 'http://mr/2386')));
  assert.ok(row(2400).includes(link('success', 'http://ci/2400')));
  assert.ok(!/\x1b\]8;;[^\x1b]*\x1b\\—/.test(row(2396)));    // no pipeline: — unlinked
  for (const iid of [2386, 2396, 2400]) assert.equal(visible(row(iid)), wide.columns, iid);
});

test('ASS-86 AC3: a GitHub pull request links its key and build status like a GitLab merge request, on the sprint table and the ticket screen', () => {
  const pr = { key: '#42', 'build-status': 'Pending', url: 'https://github.com/o/r/pull/42', status: 'Open' };
  const github = { ...sprint, features: [{ ...sprint.features[0], variations: [{ ...sprint.features[0].variations[0], 'merge-request': [pr] }] }] };
  const s = initialState({ projects: [{ ...projects[0], sprint: github }], workflows: [engine] });
  for (const raw of [render(s, wide), render({ ...s, ticket: { key: 'ABC-1', variation: 'A' } }, { ...wide, rows: 90 })]) {
    const row = raw.find(l => l.includes('#42'));
    assert.ok(row.includes(link('#42', pr.url)) && row.includes(link('Pending', pr.url)), row);
  }
});

// ASS-42: refinement history — a backlog variation's state-changes — drawn by the ticket screen's one History renderer.
const refinementChanges = [
  { 'state-engine': 'example-backlog-refinement', 'from-state': 'groom', 'to-state': 'awaiting-approval', timestamp: '2026-09-20T10:00:00Z', 'agent-dispatch-log': [] },
  { 'state-engine': 'example-backlog-refinement', 'from-state': 'awaiting-approval', 'to-state': 'groom', timestamp: '2026-09-21T10:00:00Z', 'agent-dispatch-log': [], cause: 'operator', reason: 'AC3 is vague' },
];
const historyColumn = s => timelineOf(lines(onTab(s, 'history'), { ...wide, rows: 100 })).map(l => l.trim()).filter(Boolean);   // the History tab's timeline

test('ASS-42 AC3: the backlog ticket screen\'s History is its refinement history, step names from its engine, a cause where there is one', () => {
  const s = press(handleKey(withBacklog([backlogTicket('ABC-60', 'groom', { variations: [{ name: 'A', 'harness-status': { state: 'groom', 'state-engine': 'example-backlog-refinement' }, 'state-changes': refinementChanges }] })]), key('b')), 'return');
  assert.deepEqual(historyColumn(s), [
    '2026-09-20 10:00 UTC  Groom   →   Awaiting Approval',
    '↓',
    '2026-09-21 10:00 UTC  Awaiting Approval (1d 0h)   →   Groom   (operator: AC3 is vague)',   // whole on its row: the timeline is wide
  ]);
});

test('ASS-42 AC4: the sprint ticket screen\'s History lists its backlog entry\'s refinement history first, then its development history, each under its engine', () => {
  const dev = [{ 'state-engine': 'example-development', 'from-state': 'plan', 'to-state': 'build', timestamp: '2026-09-28T10:00:00Z', 'agent-dispatch-log': [] }];
  const backlogEntry = backlogTicket('ABC-5', 'ready', { variations: [{ name: 'A', 'harness-status': { state: 'ready', 'state-engine': 'example-backlog-refinement' }, 'state-changes': refinementChanges }] });
  const state = (backlogOfSprint) => ({
    ...initialState({
      projects: [{ ...detailProject, backlogOfSprint, sprint: { ...sprint, features: [{ ...detailed, variations: [{ ...detailed.variations[0], 'harness-status': hs('build'), 'state-changes': dev }] }], bugs: [], spikes: [] } }],
      workflows: [{ ...refiningEngine, steps: fourSteps }, refinementEngine], assignments: [],
    }),
    focus: 'tickets',
  });
  assert.deepEqual(historyColumn(press(state([backlogEntry]), 'return')), [
    'example-backlog-refinement',
    '2026-09-20 10:00 UTC  Groom   →   Awaiting Approval',
    '↓',
    '2026-09-21 10:00 UTC  Awaiting Approval (1d 0h)   →   Groom   (operator: AC3 is vague)',   // whole on its row: the timeline is wide
    'example-development',
    '2026-09-28 10:00 UTC  Plan   →   Build',
  ]);
  assert.deepEqual(historyColumn(press(state([]), 'return')), ['2026-09-28 10:00 UTC  Plan   →   Build'], 'no backlog entry: the development history alone');
});

// ASS-166: a ticket worked by hand (worked-manually) — ✋ and who since when on the grids, cleared from its screen.
const HAND = { by: 'alice', since: '2026-10-27T10:05:00Z', note: 'in the coordinator' };

test('ASS-166 AC3: the dashboard shows a ticket worked by hand with ☛ in c3, before ↯ (ASS-259; was ✋), and says who since when in its Health; others do not', () => {
  const s = blockable('code-review');
  Object.assign(s.projects[0].sprint.features[0], { 'worked-manually': HAND, 'fast-track': true });
  const row = lines(s, wide).find(l => l.includes('ABC-5'));
  assert.ok(row.includes(`│ ${cols({ hand: '☛', fast: '↯' })}ABC-5: `), row);
  assert.match(row, /worked by hand by alice since 2026-10-27 10:05/);
  assert.ok(!lines(blockable('code-review'), wide).some(l => /ABC-\d/.test(l) && (l.includes('☛') || l.includes('✋'))));   // the key under the grid aside
});

test('ASS-166 AC3: the backlog grid shows a ticket worked by hand with ✋ and who since when in its State', () => {
  const out = lines(handleKey(withBacklog([backlogTicket('ABC-60', 'groom', { 'worked-manually': HAND }), backlogTicket('ABC-61', 'groom')]), key('b')), wide);
  assert.match(out.find(l => l.includes('ABC-60')), /✋ ABC-60: .*Groom · worked by hand by alice since 2026-10-27 10:05/);
  assert.doesNotMatch(out.find(l => l.includes('ABC-61')), /✋|worked by hand/);
});

test('ASS-166 AC3: a ticket worked by hand offers Hand back to control on its screen, sprint or backlog — ticket:set-manual off; others do not', () => {
  const s = blockable('code-review');
  s.projects[0].sprint.features[0]['worked-manually'] = HAND;
  const open = { ...press(s, 'return'), ticketTab: 'actions' };
  const actions = actionsOf(lines(open, wide));
  const at = actions.filter(l => /▸|^ {2,}\S/.test(l)).findIndex(l => l.includes('Hand back to control'));
  assert.ok(at >= 0, actions.join('\n'));
  assert.deepEqual(press(open, ...Array(at).fill('down'), 'return').decide, ['ticket:set-manual', 'example', 'ABC-5', 'off']);
  assert.ok(!actionsOf(lines(press(blockable('code-review'), 'return'), wide)).some(l => l.includes('Hand back to control')));
  const backlog = { ...press(handleKey(withBacklog([backlogTicket('ABC-60', 'groom', { 'worked-manually': HAND })]), key('b')), 'return'), ticketTab: 'actions' };
  assert.ok(actionsOf(lines(backlog, wide)).some(l => l.includes('Hand back to control')));
  assert.deepEqual(press(backlog, 'down', 'return').decide, ['ticket:set-manual', 'example', 'ABC-60', 'off']);   // after Set manual priority
});

// ===== ASS-185: narrow terminals, tab badges, PgUp/PgDn on the secondary panes, the full description =====
const sized = columns => ({ ...screen, columns, rows: 40 });
const page = (s, name, n = 1, size = wide) => Array(n).fill(name).reduce(at => handleKey(at, key(name), size), s);

test('ASS-185 AC1: the panel is 40 wide from 120 columns up, 28 from 100 to 119; below 100 a 3-line strip sits above tabs that span the whole width', () => {
  const s = press(atGate(), 'return');
  for (const columns of [200, 120, 119, 100, 99, 96, 70]) {
    const size = sized(columns);
    const out = lines(s, size);
    const at = out.findIndex(l => l.startsWith('┌ 1 Actions'));
    const top = out[at];
    for (const line of render(s, size)) assert.ok(visible(line) <= columns, `${columns}: ${line}`);
    if (columns >= 100) {
      assert.equal(top.indexOf('┬'), columns - (columns >= 120 ? 40 : 28), `${columns}`);
      assert.equal(panelWidth(columns), columns >= 120 ? 40 : 28);
      assert.ok(!out.slice(0, at).some(l => l.startsWith('✨ ABC-6')), `${columns}: no strip`);
      continue;
    }
    assert.ok(!top.includes('┬') && top.endsWith('┐') && visible(top) === columns, `${columns}: ${top}`);
    assert.match(out[at - 3], /^✨ ABC-6 · A · /, `${columns}`);
    assert.match(out[at - 2], /^State: .* · Needs you: Payment Gate — tab 1/, `${columns}`);
    assert.match(out[at - 1], /^Priority .* · Agents: .* · Tests: .* · Spend /, `${columns}`);
    assert.match(out.find((l, i) => i > at && l.startsWith('└')), new RegExp(`^└─{${columns - 2}}┘$`));
  }
  const top96 = lines(s, narrow).find(l => l.startsWith('┌ 1 Actions'));
  assert.match(top96, /^┌ 1 Actions ● │ 2 Details │ 3 History │ 4 Questions │ 5 Chat ─+┐$/, 'full labels at 96 columns');
});

test('ASS-185 AC2: the Actions label shows a red ● while a gate waits and Questions (n) ● open questions; the labels stay whole on a narrow screen', () => {
  const bar = (s, size = wide) => strip(tabBarRaw(s, size));
  assert.match(bar(press(atGate(), 'return')), /^┌ 1 Actions ● │ 2 Details/);
  assert.match(tabBarRaw(press(atGate(), 'return')), /\x1b\[31m●/);
  assert.match(bar(press(asked(), 'return')), /^┌ 1 Actions │ 2 Details │ 3 History │ 4 Questions \(2\) ● │ 5 Chat /);
  assert.match(tabBarRaw(press(asked(), 'return')), /Questions \(2\) \x1b\[31m●/);
  assert.match(bar(press(asked(), 'return'), narrow), /^┌ 1 Actions │ 2 Details │ 3 History │ 4 Questions \(2\) ● │ 5 Chat ─+┐$/);
  assert.match(bar(press(onGrid, 'return')), /^┌ 1 Actions │ 2 Details │ 3 History │ 4 Questions │ 5 Chat /);
});

test('a backlog ticket at Awaiting Answers opens on Questions, its red ● there and none on Actions, Needs you naming tab 4', () => {
  const s = press(handleKey(initialState({
    projects: [{ ...projects[0], backlog: [backlogTicket('ABC-60', 'awaiting-answers')], questions: [question('Which flag?', 'ABC-60')] }, projects[1]],
    workflows: [refiningEngine, refinementEngine], assignments,
  }), key('b')), 'return');
  assert.equal(s.ticketTab, 'questions');
  assert.match(strip(tabBarRaw(s)), /^┌ 1 Actions │ 2 Details │ 3 History │ 4 Questions \(1\) ● │ 5 Chat /);
  assert.match(tabBarRaw(s), /Questions \(1\) \x1b\[31m●/);
  assert.ok(panelOf(render(s, wide).map(strip)).some(l => l.includes('Needs you: 1 open question — tab 4')));
});

test('ASS-185 AC3: on Actions PgUp/PgDn scroll the review past the box, ↑/↓ bring the choice back into view', () => {
  const short = { ...wide, rows: 30 };
  const open = handleKey(atHumanReview(DEMO), key('return'), short);
  const shown = st => actionsOf(render(st, short).map(strip));
  assert.ok(!shown(open).some(l => l.includes('Tests failing on master too')), shown(open).join('\n'));
  const down = page(open, 'pagedown', 10, short);
  assert.ok(shown(down).some(l => l.includes('choose Demo above')), shown(down).join('\n'));
  assert.equal(down.ticketChoice, open.ticketChoice);
  assert.ok(page(open, 'pagedown', 1, short).ticketActionsScroll > 0);
  const up = page(down, 'pageup', 10, short);
  assert.equal(up.ticketActionsScroll, 0);
  assert.ok(shown(up).some(l => l.startsWith('Steer this ticket by hand')), shown(up).join('\n'));
  const chose = handleKey(down, key('down'), short);
  assert.ok(shown(chose).some(l => l.includes('▸ Rejected')), shown(chose).join('\n'));
});

test('ASS-185 AC3: on History PgUp/PgDn scroll the states pane by hand, the timeline left where it was', () => {
  const short = { ...wide, rows: 40 };
  const open = onHistory(handleKey(ticketOn(twentySteps, 'step-1', { 'state-changes': longHistory }), key('return'), short));
  const states = st => statesOf(render(st, short).map(strip));
  assert.ok(!states(open).includes('Step 20 (0, 0)'));
  const down = page(open, 'pagedown', 10, short);
  assert.ok(states(down).includes('Step 20 (0, 0)'), states(down).join('\n'));
  assert.equal(down.ticketHistoryScroll, open.ticketHistoryScroll);
  const up = page(down, 'pageup', 10, short);
  assert.equal(up.ticketStatesScroll, 0);
  assert.equal(states(up)[0], 'Step 1 (0, 0)');
});

test('ASS-185 AC3: on Questions PgUp/PgDn scroll the selected question\'s details, the selection kept', () => {
  const short = { ...wide, rows: 30 };
  const open = handleKey(asked(), key('return'), short);
  const down = page(open, 'pagedown', 1, short);
  assert.ok(down.ticketQuestionsScroll > open.ticketQuestionsScroll);
  assert.equal(down.ticketQuestionSelected, open.ticketQuestionSelected);
  assert.notDeepEqual(tabOf(render(down, short).map(strip)), tabOf(render(open, short).map(strip)));
  assert.equal(page(down, 'pageup', 5, short).ticketQuestionsScroll, 0);
});

test('ASS-185 AC3: on Details and Chat PgUp/PgDn do nothing; ↑/↓ stay the only scroll there', () => {
  const s = { ...onGrid, projects: [{ ...detailProject, sprint: { ...detailProject.sprint, features: [longOverShort] } }] };
  const details = onTab(press(s, 'return'), 'details');
  const chat = { ...onTab(press(s, 'return'), 'chat'), ticketChatLog: longLog };
  for (const st of [details, chat]) {
    for (const name of ['pagedown', 'pageup']) assert.deepEqual(handleKey(st, key(name, { sequence: name === 'pageup' ? '\x1b[5~' : '\x1b[6~' }), wide), st, `${st.ticketTab} ${name}`);
  }
  assert.equal(press(details, 'down').ticketScroll, 1);
});

// ── The agents screen as a tile grid, plus `*` for every project (ASS-188). The test
// data its plan (projects/harness/work/ASS-188/test-plan.md) needs beyond the
// fixtures above; each fixture names the acceptance criteria that reads it.

// An engine whose two steps split by location: `plan` runs on the host, `build` in a
// VM (`runsInVm` reads `run-location: 'vm'` with a prompt action). Name matches
// `projects[0].stateEngine` so an assignment's state resolves to one of these.
// A tile's location reads 'host', 'VM' or (with `working-in-dev-container: true`)
// 'DC' (AC2).
const vmEngine = { name: 'example-development', steps: [
  { id: 'plan', name: 'Plan', sequence: 1, action: { type: 'prompt' } },
  { id: 'build', name: 'Build', sequence: 2, action: { type: 'prompt' }, 'run-location': 'vm' },
] };

// A paused ticket: its one variation has `is-paused: true`. Dropped into a sprint or
// a backlog as the test needs; an agent's tile on this ticket shows ⏸️ (AC2 paused).
const pausedTicket = { key: 'ABC-9', title: 'Paused', priority: 4, ...single({ 'harness-status': hs('code-review'), 'is-paused': true }) };

// A deterministic start-time: minute `n` of 2026-10-01T13:00Z, well before the
// fixtures' `screen.now` (16:04Z). Keeps the oldest-first order (AC1) and the
// session length rendering (AC2) predictable.
const started = n => `2026-10-01T13:${String(n).padStart(2, '0')}:00Z`;

// `n` running assignments on ABC-1 of `projects[0]`, oldest-started first (AC1
// grid-size, shrink-to-fit and paging). `Agent-0` is the oldest.
const teamOf = n => Array.from({ length: n }, (_, i) =>
  ({ ...assignment(`Agent-${i}`, 'ABC-1'), 'start-time': started(i), status: 'Running' }));

// A mix across both projects for `*`: three on example, two on assassin, oldest
// first by `started(i)` (AC1 `*` ordering, AC2 project column on `*`).
const bothProjectsTeam = [
  { ...assignment('Daredevil', 'ABC-1'), 'start-time': started(0) },
  { ...assignment('Flash', 'X-1', null, 'assassin'), 'start-time': started(1) },
  { ...assignment('Elektra', 'ABC-1'), 'start-time': started(2) },
  { ...assignment('Zoom', 'X-2', null, 'assassin'), 'start-time': started(3) },
  { ...assignment('Punisher', 'ABC-1'), 'start-time': started(4) },
];

// A session tail with every line class the tile-body filter touches: a plain line,
// an event JSON line (hidden), a tool-use line (kept), its tool result (folded by
// `foldResults`), and another plain line (AC2 body).
const tileTail = ['said one', '{"type":"system","subtype":"thinking_tokens"}', '▶ Bash {"command":"ls"}', '◀ out.txt', 'said two'];

// A session tail of an agent that has ended: the exit line exactly as
// `src/agents/process.js` writes it. A queued message still unread when this line
// shows flips to "not read" (ASS-189 AC3); `exitedTail(['> hi'])` puts delivery
// lines before it, for the delivered-before-exit case.
const exitedTail = (before = []) => [...before, '[agent exited (code 0)]'];

// The tiles a render draws (ASS-188), in reading order: each from its top border
// `┌─ <name> ─…┐` — its name, line and column, width and height (to the └ under
// its ┌), and the text inside its borders, a line each.
const tilesOf = (s, size = wide) => {
  const out = lines(s, size);
  return out.flatMap((l, row) => [...l.matchAll(/┌─ /g)].map(({ index: left }) => {
    const right = l.indexOf('┐', left);
    const bottom = out.findIndex((b, j) => j > row && b[left] === '└');
    return { name: l.slice(left + 3, right).replace(/[ ─]+$/, ''), row, left, width: right - left + 1, height: bottom - row + 1,
      text: out.slice(row + 1, bottom).map(b => b.slice(left + 1, right).trimEnd()) };
  }));
};
const tileNames = (s, size = wide) => tilesOf(s, size).map(t => t.name);
const tileRows = (s, size = wide) => new Set(tilesOf(s, size).map(t => t.row)).size;
const tileText = t => t.text.join('\n');
// The tile drawn in reverse video: the focused one.
const focusedTile = (s, size = wide) => {
  const raw = render(s, size), tiles = tilesOf(s, size);
  for (const [r, l] of raw.entries()) {
    const at = l.indexOf('\x1b[7m');
    if (at < 0) continue;
    const c = visible(l.slice(0, at));
    const t = tiles.find(t => r >= t.row && r < t.row + t.height && c >= t.left && c < t.left + t.width);
    if (t) return t.name;
  }
};
// The agents screen opened on these assignments, or `A` (ASS-246) (its key as node:readline gives it).
const star = key('a', { shift: true, sequence: 'A' });
const onAgents = (list, extra = {}, open = key('a')) => handleKey({ ...initialState({ projects, workflows: [engine, vmEngine].slice(1), assignments: list, ...extra }) }, open, wide);
const onStar = (list, extra = {}) => onAgents(list, extra, star);
const shiftTab = key('tab', { shift: true });
const tKey = key('t', { sequence: 't' });
const footer = s => lines(s, wide).find(l => /page \d+ of \d+/.test(l))?.match(/page \d+ of \d+/)[0];

// ── AC1: a tile per agent, oldest first; grid size; paging.

test('ASS-188 AC1: a shows a tile per selected-project assignment and running chat; * shows every project\'s', () => {
  const extra = { chats: chatList, chatsRunning: ['c1', 'c3'] };
  const a = tilesOf(onAgents(bothProjectsTeam, extra));
  assert.deepEqual(a.filter(t => !/\bchat\b/.test(tileText(t))).map(t => t.name), ['Daredevil', 'Elektra', 'Punisher']);
  assert.equal(a.filter(t => /\bchat\b/.test(tileText(t))).length, 1);                  // c1, not assassin's c3
  const all = tilesOf(onStar(bothProjectsTeam, { ...extra, agentsGrid: { agentsGridColumns: 4, agentsGridRows: 2 } }));
  assert.deepEqual(all.filter(t => !/\bchat\b/.test(tileText(t))).map(t => t.name), ['Daredevil', 'Flash', 'Elektra', 'Zoom', 'Punisher']);
  assert.equal(all.filter(t => /\bchat\b/.test(tileText(t))).length, 2);
});

test('ASS-188 AC1: tiles are oldest-started first — assignments by start-time, chats by created, interleaved', () => {
  const list = [{ ...assignment('Bravo', 'ABC-1'), 'start-time': started(30) }, { ...assignment('Alpha', 'ABC-1'), 'start-time': started(0) }];
  const chats = [{ id: 'k1', project: 'example', title: 'Mid chat', created: started(15), 'session-id': null }];
  const tiles = tilesOf(onAgents(list, { chats, chatsRunning: ['k1'] }));
  assert.equal(tiles.length, 3);
  assert.deepEqual([tiles[0].name, tiles[2].name], ['Alpha', 'Bravo']);
  assert.match(tileText(tiles[1]), /\bchat\b/);
});

test('ASS-188 AC1: a Starting assignment with no start-time or log, and a checking-on-agents one, still get tiles; a chat not running gets none', () => {
  const list = [{ ...assignment('Daredevil', 'ABC-1'), 'start-time': started(0) }, { ...assignment('Starter', 'ABC-1'), status: 'Starting' }, { ...assignment('Watcher', null), agent: 'Daredevil', state: 'check-on-agents', 'start-time': started(1) }];
  const names = tileNames(onAgents(list, { chats: chatList, chatsRunning: [] }));
  assert.deepEqual(names.toSorted(), ['Daredevil', 'Starter', 'Watcher']);
});

test('ASS-188 AC1: the grid is agents-grid-columns × agents-grid-rows — 3 × 2 by default', () => {
  const team = teamOf(8);
  const byDefault = tilesOf(onAgents(team));
  assert.equal(byDefault.length, 6);
  assert.equal(tileRows(onAgents(team)), 2);
  assert.equal(byDefault.filter(t => t.row === byDefault[0].row).length, 3);
  const custom = onAgents(team, { agentsGrid: { agentsGridColumns: 2, agentsGridRows: 3 } });
  assert.equal(tilesOf(custom).length, 6);
  assert.equal(tileRows(custom), 3);
  assert.equal(tilesOf(custom).filter(t => t.row === tilesOf(custom)[0].row).length, 2);
});

test('ASS-188 AC1: with fewer agents, the smallest grid that holds them', () => {
  const one = tilesOf(onAgents(teamOf(1)));
  assert.equal(one.length, 1);
  assert.ok(one[0].width >= wide.columns - 2, `one tile spans the grid: ${one[0].width}`);
  const four = onAgents(teamOf(4));
  assert.equal(tilesOf(four).length, 4);
  assert.equal(tileRows(four), 2);                                                         // no empty row
});

test('ASS-188 AC1: a tile is never smaller than 16 × 6 — columns drop on a narrow screen, rows on a short one', () => {
  const big = { agentsGrid: { agentsGridColumns: 10, agentsGridRows: 10 } };
  const atLeast = (s, size) => {
    const tiles = tilesOf(s, size);
    assert.ok(tiles.length > 0);
    for (const t of tiles) assert.ok(t.width >= 16 && t.height >= 6, `${t.name} ${t.width}×${t.height}`);
    return tiles;
  };
  const narrow = { ...wide, columns: 40 };
  assert.ok(atLeast(onAgents(teamOf(6)), narrow).filter((t, _, all) => t.row === all[0].row).length <= 2);
  const short = { ...wide, rows: 32 };
  atLeast(onAgents(teamOf(6)), short);
  assert.equal(tileRows(onAgents(teamOf(6)), short), 1);
  const clamped = { ...wide, columns: 80, rows: 60 };
  const tiles = atLeast(onAgents(teamOf(100), big), clamped);
  assert.ok(tiles.length < 100);
  assert.match(lines(onAgents(teamOf(100), big), clamped).join('\n'), /page 1 of \d+/);
});

test('ASS-188 AC1: a body narrower than a tile says the terminal is too narrow; no agents draws no tiles', () => {
  const tooNarrow = { ...wide, columns: 15 };
  assert.ok(lines(onAgents(teamOf(3)), tooNarrow).some(l => l.includes('terminal too')));
  const none = onAgents([]);
  assert.deepEqual(tilesOf(none), []);
  assert.ok(!lines(none, wide).some(l => /page \d+ of 0|NaN|undefined/.test(l)));
});

test('ASS-188 AC1: more agents than fit page: the footer says page x of y; PgDn and PgUp turn it, stopping at either end', () => {
  const first = onAgents(teamOf(7));
  assert.equal(footer(first), 'page 1 of 2');
  const second = handleKey(first, key('pagedown'), wide);
  assert.equal(footer(second), 'page 2 of 2');
  assert.deepEqual(tileNames(second), ['Agent-6']);
  assert.equal(footer(handleKey(second, key('pagedown'), wide)), 'page 2 of 2');
  assert.equal(footer(handleKey(second, key('pageup'), wide)), 'page 1 of 2');
  assert.equal(footer(handleKey(first, key('pageup'), wide)), 'page 1 of 2');
});

test('ASS-188 AC1: when agents leave, the page on show clamps to the last there is', () => {
  const second = handleKey(onAgents(teamOf(7)), key('pagedown'), wide);
  const fewer = { ...second, assignments: teamOf(3) };
  assert.deepEqual(tileNames(fewer), ['Agent-0', 'Agent-1', 'Agent-2']);
  assert.ok(focusedTile(fewer) != null);
});

test('ASS-188 AC1: changing project on a starts its grid at the first page and tile; * shows the same tiles whichever project is selected', () => {
  const onA = { ...handleKey(onAgents(teamOf(7)), key('pagedown'), wide), focus: 'menu' };
  const moved = handleKey(onA, key('right'), wide);
  assert.deepEqual([moved.agentPage, moved.agentTile], [0, 0]);
  const all = onStar(bothProjectsTeam);
  assert.deepEqual(tileNames(handleKey({ ...all, focus: 'menu' }, key('right'), wide)), tileNames(all));
});

test('ASS-188 AC1: no line of the a or * grid is wider than the screen', () => {
  const team = [...teamOf(7), { ...assignment('A-very-long-agent-name-that-will-not-fit', 'ABC-1', 'A'), 'ai-feedback-short': 'x' }];
  for (const s of [onAgents(team), onStar(team), { ...onAgents(team), sessionTails: { 'Agent-0': ['y'.repeat(500)] } }]) {
    assert.ok(tilesOf(s).length > 0);                                                    // tiles there to be too wide
    for (const size of [wide, screen, { ...wide, columns: 40 }, { ...wide, columns: 15 }]) {
      for (const line of render(s, size)) assert.ok(visible(line) <= size.columns, `${size.columns}: ${strip(line)}`);
    }
  }
});

// ── AC2: each tile's header and body.

// One agent's tile on a, or on *.
const tileOf = (a, extra = {}, open = key('a')) => tilesOf(onAgents([a], extra, open))[0];

test('ASS-188 AC2: the agent\'s name is in its tile\'s top border; a long one is clipped, the border intact', () => {
  assert.equal(tileOf({ ...assignment('Daredevil', 'ABC-1', 'A'), 'start-time': started(0) }).name, 'Daredevil');
  const long = 'L'.repeat(40);
  const two = tilesOf(onAgents([...teamOf(5), { ...assignment(long, 'ABC-1'), 'start-time': started(9) }], {}, key('a')), { ...wide, columns: 60 });
  const tile = two.find(t => t.name.startsWith('LLL'));
  assert.ok(tile.name.length < long.length);
  assert.ok(tile.width >= 16);
  assert.ok(lines(onAgents([...teamOf(5), { ...assignment(long, 'ABC-1'), 'start-time': started(9) }]), { ...wide, columns: 60 })[tile.row].slice(tile.left).match(/^┌─ L+…? ?─*┐/));
});

test('ASS-188 AC2: the header names the ticket — KEY.VARIATION and step, the key alone without a variation — or chat for a chat', () => {
  assert.match(tileText(tileOf({ ...assignment('Daredevil', 'ABC-1', 'A'), state: 'build', 'start-time': started(0) })), /ABC-1\.A build/);
  const bare = tileText(tileOf({ ...assignment('Daredevil', 'ABC-1'), state: 'build', 'start-time': started(0) }));
  assert.match(bare, /ABC-1 build/);
  assert.ok(!bare.includes('ABC-1.'));
  const chatTile = tilesOf(onAgents([], { chats: chatList, chatsRunning: ['c1'] }))[0];
  assert.match(tileText(chatTile), /\bchat\b/);
});

test('ASS-188 AC2: the project shows on * tiles, not on a', () => {
  const a = { ...assignment('Flash', 'X-1', null, 'assassin'), 'start-time': started(0) };
  assert.match(tileText(tileOf(a, {}, star)), /Software Assassin|assassin/);
  assert.match(tileText(tileOf({ ...a, project: 'example', 'agent-name': 'Daredevil' }, {}, star)), /Example|example/);
  assert.ok(!/Example|example/.test(tileText(tileOf({ ...assignment('Daredevil', 'ABC-1'), 'start-time': started(0) }))));
});

test('ASS-188 AC2: the session length is the time since its start-time; blank without one', () => {
  const text = tileText(tileOf({ ...assignment('Daredevil', 'ABC-1'), 'start-time': started(0) }));
  assert.ok(text.includes('3h 4m'), text);                                               // 13:00 to screen.now's 16:04
  assert.ok(!/\b\d+[dhm]\b/.test(tileText(tileOf({ ...assignment('Starter', 'ABC-1'), status: 'Starting' }))));
});

// ── ASS-190 AC2/AC3: context % and cost on the tile and the zoom header,
// through contextLabel/costLabel. state.usage holds each tile's usage.json by
// the tile's key (an agent's name), spread onto the state as sessionTails is.
const usageTeam = [{ ...assignment('Daredevil', 'ABC-1'), 'start-time': started(0) }];
const usageTile = (usage, tail = []) => tileText(tilesOf({ ...onAgents(usageTeam), usage, sessionTails: { Daredevil: tail } })[0]);

test('ASS-190 AC3: a tile with no usage entry shows no % or $, and the header takes no body line', () => {
  const tail = ['said one', 'said two', 'said three'];
  const noUsage = tilesOf({ ...onAgents(usageTeam), sessionTails: { Daredevil: tail } })[0];
  assert.ok(!tileText(noUsage).includes('%') && !tileText(noUsage).includes('$'), tileText(noUsage));
  const withUsage = tilesOf({ ...onAgents(usageTeam), usage: { Daredevil: { contextTokens: 84000, contextWindow: 200000, costUsd: 0.08, costExact: false } }, sessionTails: { Daredevil: tail } })[0];
  const body = t => t.text.map(l => l.trim()).filter(l => tail.includes(l)).length;
  assert.equal(body(withUsage), body(noUsage));                                           // same log lines: header stayed two lines
});

test('ASS-190 AC3: a tile shows ctx NN% and ~$x.xx while costExact is false, and $x.xx with no ~ once it is true', () => {
  const soft = usageTile({ Daredevil: { contextTokens: 84000, contextWindow: 200000, costUsd: 0.08, costExact: false } });
  assert.match(soft, /ctx 42%/);
  assert.match(soft, /~\$0\.08/);
  const exact = usageTile({ Daredevil: { contextTokens: 84000, contextWindow: 200000, costUsd: 0.08, costExact: true } });
  assert.match(exact, /\$0\.08/);
  assert.ok(!exact.includes('~$'), exact);
});

test('ASS-190 AC2/AC3: with no known window the tile shows the humanized raw count (metrics count), not a percentage or the raw number', () => {
  const t = usageTile({ Daredevil: { contextTokens: 412000, contextWindow: null, costUsd: null, costExact: false } });
  assert.match(t, /ctx 412k/);
  assert.ok(!t.includes('%') && !t.includes('412000'), t);
  assert.match(usageTile({ Daredevil: { contextTokens: 1_200_000, contextWindow: null } }), /ctx 1\.2M/);   // the shared count() humanizer, not a hand-rolled k
});

test('ASS-190 AC3: a known window with a null cost (an unpriced model mid-turn) shows ctx NN% and a blank cost', () => {
  const t = usageTile({ Daredevil: { contextTokens: 84000, contextWindow: 200000, costUsd: null, costExact: false } });
  assert.match(t, /ctx 42%/);
  assert.ok(!t.includes('$'), t);
});

test('ASS-190 AC3: the zoom header carries the same ctx %/cost pair on its second line, next to "log last written", with no extra line', () => {
  const opened = handleKey(handleKey(initialState({ projects, workflows: [engine], assignments: [{ ...assignment('Daredevil', 'ABC-1'), 'start-time': '2026-10-01T13:43:00Z' }] }), key('a'), wide), zKey, wide);
  const reading = { ...opened, agentLog: ['line 0'], sessionWritten: { Daredevil: Date.parse('2026-10-01T15:51:07Z') }, usage: { Daredevil: { contextTokens: 84000, contextWindow: 200000, costUsd: 0.08, costExact: false } } };
  const header = lines(reading, wide).find(l => l.startsWith('log last written'));
  assert.ok(header.includes('ctx 42%') && header.includes('~$0.08'), header);
  assert.equal(lines(reading, wide).filter(l => l.startsWith('log last written')).length, 1);   // still one header line, not a third
});

test('ASS-190 AC3: contextLabel and costLabel are exported from agents.js and blank on empty or zero usage', () => {
  assert.equal(agentsScreen.contextLabel(undefined), '');
  assert.equal(agentsScreen.contextLabel({}), '');
  assert.equal(agentsScreen.contextLabel({ contextTokens: 0 }), '');
  assert.equal(agentsScreen.costLabel(undefined), '');
  assert.equal(agentsScreen.costLabel({}), '');
});

test('ASS-188 AC2: the location is DC in a dev container, VM on a step that runs in one, else host — host for an unknown engine or step too', () => {
  const at = (fields, workflows = [vmEngine]) => tileText(tileOf({ ...assignment('Daredevil', 'ABC-1', 'A'), 'start-time': started(0), 'state-engine': 'example-development', ...fields }, { workflows }));
  assert.match(at({ state: 'plan', 'working-in-dev-container': true }), /\bDC\b/);
  assert.match(at({ state: 'build' }), /\bVM\b/);
  assert.match(at({ state: 'plan' }), /\bhost\b/);
  assert.match(at({ state: 'nowhere' }), /\bhost\b/);
  assert.match(at({ state: 'build', 'state-engine': 'no-such-engine' }), /\bhost\b/);
  assert.match(at({ state: 'build' }, []), /\bhost\b/);
});

test('ASS-188 AC2: ⏸️ marks a tile whose ticket variation is paused, in the sprint or the backlog, looked up in the tile\'s own project', () => {
  const inSprint = [{ ...projects[0], sprint: { ...sprint, features: [...sprint.features, pausedTicket] } }, projects[1]];
  const on = (a, list = inSprint, open = key('a')) => tileText(tilesOf(onAgents([{ ...a, 'start-time': started(0) }], { projects: list }, open))[0]);
  assert.ok(on(assignment('Daredevil', 'ABC-9', 'A')).includes('⏸'));
  assert.ok(!on(assignment('Daredevil', 'ABC-9', 'B')).includes('⏸'));                   // another variation
  assert.ok(!on(assignment('Daredevil', 'ABC-1', 'A')).includes('⏸'));
  const inBacklog = [{ ...projects[0], backlog: [pausedTicket] }, projects[1]];
  assert.ok(on(assignment('Daredevil', 'ABC-9', 'A'), inBacklog).includes('⏸'));
  const theirs = [projects[0], { ...projects[1], sprint: { ...sprint, features: [{ ...pausedTicket, key: 'X-9' }], bugs: [], spikes: [] } }];
  assert.ok(on(assignment('Flash', 'X-9', 'A', 'assassin'), theirs, star).includes('⏸'));   // assassin's, Example selected
  assert.ok(!on(assignment('Daredevil', 'X-9', 'A'), theirs, star).includes('⏸'));         // Example has no X-9
});

test('ASS-188 AC2: ⚠️ marks a tile whose assignment has an ai-feedback-short (the old table\'s Health); none without one', () => {
  const on = feedback => tileText(tileOf({ ...assignment('Daredevil', 'ABC-1', 'A'), 'start-time': started(0), 'ai-feedback-short': feedback }));
  assert.ok(on('Stuck on tests').includes('⚠'));
  assert.ok(!on(null).includes('⚠'));
  assert.ok(!on('').includes('⚠'));
});

// A message sent to Daredevil from its log, then back on the grid.
const queuedTeam = [{ ...assignment('Daredevil', 'ABC-1', 'A'), model: 'opus-5', 'start-time': started(0) }];
const sendFromLog = (s, ...texts) => texts.reduce((st, text) => ({ ...handleKey({ ...st, agentDraft: { [st.agent.name]: text }, agentCursor: { [st.agent.name]: [...text].length } }, key('return'), wide), agentPrompt: null }), s);
const queuedTile = s => tileText(tilesOf(s)[0]);

test('ASS-188 AC2 / ASS-189 AC3: "queued" marks a message sent from the TUI until its "> text" line shows in the agent\'s session log', () => {
  const reading = handleKey(onAgents(queuedTeam), zKey, wide);
  const back = handleKey(sendFromLog(reading, 'Run it again'), key('escape'), wide);
  assert.equal(back.agent, null);
  assert.ok(queuedTile(back).includes('queued'));
  assert.ok(queuedTile(agentsScreen.settlePending({ ...back, sessionTails: { Daredevil: ['said one'] } })).includes('queued'));   // not there yet
  const delivered = agentsScreen.settlePending({ ...back, sessionTails: { Daredevil: ['> Run it again', 'On it.'] } });
  assert.ok(!queuedTile(delivered).includes('queued'));
  assert.ok(!queuedTile(delivered).includes('not read'));                                 // read, so no mark at all
});

test('ASS-188 AC2: a multi-line message is matched on its first line; with two queued, one delivered keeps the mark', () => {
  const reading = handleKey(onAgents(queuedTeam), zKey, wide);
  const multi = handleKey(sendFromLog(reading, 'first line\nsecond line'), key('escape'), wide);
  assert.ok(!queuedTile(agentsScreen.settlePending({ ...multi, sessionTails: { Daredevil: ['> first line', 'second line'] } })).includes('queued'));
  const two = handleKey(sendFromLog(reading, 'one', 'two'), key('escape'), wide);
  assert.ok(queuedTile(agentsScreen.settlePending({ ...two, sessionTails: { Daredevil: ['> one'] } })).includes('queued'));
  assert.ok(!queuedTile(agentsScreen.settlePending({ ...two, sessionTails: { Daredevil: ['> one', '> two'] } })).includes('queued'));
});

test('ASS-189 AC3: an agent whose assignment is gone flips its queued mark to "not read"', () => {
  const back = handleKey(sendFromLog(handleKey(onAgents(queuedTeam), zKey, wide), 'Run it again'), key('escape'), wide);
  const gone = agentsScreen.settlePending({ ...back, assignments: [] });
  assert.equal(gone.pending.Daredevil?.notRead, true);
  assert.ok(queuedTile({ ...gone, assignments: queuedTeam }).includes('not read'));
  assert.ok(!queuedTile({ ...gone, assignments: queuedTeam }).includes('queued'));
});

test('ASS-188 AC2: under the header, the agent\'s latest log lines — event JSON hidden, tool results folded as on its log', () => {
  const on = tail => tilesOf({ ...onAgents(queuedTeam), sessionTails: { Daredevil: tail } })[0].text.map(l => l.trim()).filter(Boolean);
  const body = on(tileTail);
  for (const line of ['said one', '▶ Bash {"command":"ls"}', '◀ out.txt', 'said two']) assert.ok(body.includes(line), line);
  assert.ok(!body.some(l => l.includes('"type"')));
  assert.ok(on(folding).includes('◀ pass 7 … (3 lines)'));
  assert.ok(!on(folding).includes('fail 0'));
  const many = on(Array.from({ length: 100 }, (_, i) => `line ${i}`));
  assert.ok(many.includes('line 99'));
  assert.ok(!many.includes('line 0'));
});

test('ASS-188 AC2: a long log line is clipped at the tile\'s edge, not wrapped into its neighbour', () => {
  const s = { ...onAgents(teamOf(2)), sessionTails: { 'Agent-0': ['x'.repeat(300)] } };
  const [left, right] = tilesOf(s);
  assert.equal(left.row, right.row);
  const out = lines(s, wide);
  for (let r = left.row + 1; r < left.row + left.height - 1; r++) assert.equal(out[r][right.left], '│', out[r]);
  assert.ok(!right.text.some(l => l.includes('x')));
});

test('ASS-188 AC2: a tile with no log yet shows only its header', () => {
  const base = onAgents(queuedTeam);
  const nonblank = s => tilesOf(s)[0].text.map(l => l.trim()).filter(Boolean);
  const header = nonblank(base);
  assert.ok(header.length > 0);
  assert.deepEqual(nonblank({ ...base, sessionTails: { Daredevil: ['said one'] } }), [...header, 'said one']);
});

// ── AC3: focus, Tab, zoom and the table.

test('ASS-188 AC3: the arrows move the focused tile within the page, stopping at its edges; it is drawn in reverse video', () => {
  const s = onAgents(teamOf(6));
  assert.equal(focusedTile(s), 'Agent-0');
  assert.equal(focusedTile(press(s, 'right')), 'Agent-1');
  assert.equal(focusedTile(press(s, 'right', 'down')), 'Agent-4');
  assert.equal(focusedTile(press(s, 'right', 'down', 'left')), 'Agent-3');
  assert.equal(focusedTile(press(s, 'right', 'down', 'left', 'up')), 'Agent-0');
  assert.equal(focusedTile(press(s, 'left', 'up')), 'Agent-0');
  assert.equal(focusedTile(press(s, 'right', 'right', 'right')), 'Agent-2');
  assert.equal(focusedTile(press(s, 'down', 'down')), 'Agent-3');
  assert.equal(press(s, 'right').project, s.project);                                      // not the project menu's arrows
});

test('ASS-188 AC3: Tab and Shift-Tab step the tiles, wrapping onto the next and previous page', () => {
  const s = onAgents(teamOf(7));
  assert.equal(focusedTile(press(s, 'tab')), 'Agent-1');
  const lastOfFirst = press(s, ...Array(5).fill('tab'));
  assert.deepEqual([focusedTile(lastOfFirst), lastOfFirst.focus], ['Agent-5', 'agents']);
  const firstOfSecond = press(lastOfFirst, 'tab');
  assert.deepEqual([focusedTile(firstOfSecond), footer(firstOfSecond), firstOfSecond.focus], ['Agent-6', 'page 2 of 2', 'agents']);
  const backAgain = handleKey(firstOfSecond, shiftTab, wide);
  assert.deepEqual([focusedTile(backAgain), footer(backAgain), backAgain.focus], ['Agent-5', 'page 1 of 2', 'agents']);
});

test('ASS-188 AC3: Tab past the last tile of the last page moves on to the next component, Shift-Tab before the first to the previous; Tab back in lands on a tile', () => {
  const s = onAgents(teamOf(7));
  const past = press(s, ...Array(7).fill('tab'));
  assert.equal(past.focus, 'menu');
  assert.equal(handleKey(s, shiftTab, wide).focus, 'day');
  const one = onAgents(teamOf(1));
  assert.equal(press(one, 'tab').focus, 'menu');
  assert.equal(handleKey(one, shiftTab, wide).focus, 'day');
  const single = onAgents(teamOf(3));
  assert.equal(press(single, 'tab', 'tab').focus, 'agents');
  assert.equal(press(single, 'tab', 'tab', 'tab').focus, 'menu');
  const backIn = press(past, 'tab', 'tab');
  assert.equal(backIn.focus, 'agents');
  assert.ok(['Agent-0', 'Agent-6'].includes(focusedTile(backIn)), focusedTile(backIn));
});

test('ASS-188 AC3: z zooms the focused tile to its full-screen log; Esc returns to the grid, the same tile and page focused', () => {
  const onSecond = press(onAgents(teamOf(7)), ...Array(6).fill('tab'));
  for (const zoom of [zKey]) {
    const zoomed = handleKey(onSecond, zoom, wide);
    assert.deepEqual(zoomed.agent, { name: 'Agent-6', start: started(6) });
    assert.ok(lines({ ...zoomed, agentLog: ['line 0'] }, wide).some(l => l.includes('esc returns to the agents')));
    const back = handleKey(zoomed, key('escape'), wide);
    assert.equal(back.agent, null);
    assert.deepEqual([focusedTile(back), footer(back), back.focus], ['Agent-6', 'page 2 of 2', 'agents']);
  }
});

test('ASS-188 AC3: z and Enter on a chat tile open its chat view; Esc returns to the grid', () => {
  const s = onAgents(teamOf(1), { chats: chatList, chatsRunning: ['c1'] });
  const onChat = press(s, 'right');
  assert.match(tileText(tilesOf(onChat).find(t => t.name === focusedTile(onChat))), /\bchat\b/);
  for (const zoom of [key('return'), zKey]) {
    const zoomed = handleKey(onChat, zoom, wide);
    assert.deepEqual([zoomed.chat?.id, zoomed.agent, zoomed.screen], ['c1', null, 'a']);
    assert.ok(lines({ ...zoomed, chatLog: ['hello'] }, wide).some(l => l.includes('esc returns to the chats')));
    const back = handleKey(zoomed, key('escape'), wide);
    assert.deepEqual([back.chat, back.screen], [null, 'a']);
    assert.equal(tilesOf(back).length, 2);
  }
});

test('ASS-188 AC3: typing on the grid opens no prompt; z while zoomed is prompt text', () => {
  const s = onAgents(teamOf(2));
  const typed = handleKey(s, key('k', { sequence: 'k' }), wide);
  assert.deepEqual([typed.agent, openDraft(typed), typed.agentTyping], [null, '', false]);
  const zoomed = handleKey(s, zKey, wide);
  const again = handleKey(zoomed, zKey, wide);
  assert.deepEqual([again.agent?.name, openDraft(again)], ['Agent-0', 'z']);
});

test('ASS-188 AC3: Enter and z with no tiles do nothing', () => {
  const none = onAgents([]);
  for (const zoom of [key('return'), zKey]) {
    const after = handleKey(none, zoom, wide);
    assert.deepEqual([after.agent, after.chat], [null, null]);
  }
});

test('ASS-188 AC3: t shows the old table on a and *, and t again the grid; on * it lists every project, Enter opening the agent on its row', () => {
  const head = s => lines(s, wide).some(l => /^│ +Agent +│ Working Location │/.test(l));
  const a = onAgents(bothProjectsTeam);
  const table = handleKey(a, tKey, wide);
  assert.ok(head(table) && tilesOf(table).length === 0);
  assert.ok(lines(table, wide).some(l => l.startsWith('│ Daredevil ')));
  assert.ok(!lines(table, wide).some(l => l.startsWith('│ Flash ')));
  const grid = handleKey(table, tKey, wide);
  assert.ok(!head(grid) && tilesOf(grid).length > 0);
  const all = handleKey(onStar(bothProjectsTeam), tKey, wide);
  assert.ok(head(all));
  for (const name of ['Daredevil', 'Flash', 'Zoom']) assert.ok(lines(all, wide).some(l => l.startsWith(`│ ${name} `)), name);
  assert.equal(press(all, 'down', 'return').agent?.name, 'Flash');
  assert.ok(!head(handleKey(all, tKey, wide)));
});

// ── AC4: * pauses like a; the project menu does not filter it.

test('ASS-188 AC4: on *, space pauses the selected project and ! every project, again releasing, an AI\'s pause untouched; the banner offers space', () => {
  const bang = key('1', { shift: true, sequence: '!' });
  const s = onStar(bothProjectsTeam);
  assert.equal(s.screen, 'A');                                                           // the pauses below are the A screen's, not the one it opened over
  assert.ok(handleKey(s, key('space'), wide).pauses['example']?.human);
  assert.deepEqual(handleKey(handleKey(s, key('space'), wide), key('space'), wide).pauses, {});
  assert.ok(handleKey(s, bang, wide).pauses.all?.human);
  assert.deepEqual(handleKey({ ...s, pauses: AI }, bang, wide).pauses, combined(AI, { all: { human: {} } }));
  assert.deepEqual(handleKey({ ...s, pauses: combined(HUMAN, AI) }, bang, wide).pauses, AI);
  assert.ok(lines(s, wide).some(l => l.includes('press space to pause Example')));
});

test('ASS-188 AC4: on *, ←/→ on the project menu change the selected project, not the tiles', () => {
  const s = { ...onStar(bothProjectsTeam), focus: 'menu' };
  const moved = handleKey(s, key('right'), wide);
  assert.equal(moved.project, 1);
  assert.deepEqual(tileNames(moved), tileNames(s));
  assert.equal(tileNames(s).length, 5);
});

// ── AC5: A in the ? menu, in its own group.

test('ASS-188 AC5: the ? menu lists A agents for all projects in its own group, a blank line apart from the other screens', () => {
  const menu = menuOf(state);
  assert.ok(menu.includes('A agents for all projects'));
  assert.ok(menu.indexOf('A agents for all projects') > menu.indexOf('h memory'));
  const open = lines(menuOpened(state), wide);
  const at = open.findIndex(l => l.includes('A agents for all projects'));
  const left = open[at].lastIndexOf('│', open[at].indexOf('A agents')), right = open[at].indexOf('│', open[at].indexOf('A agents'));
  assert.match(open[at - 1].slice(left, right + 1), /^│ +│$/);                            // a blank row before it
  assert.match(open[at - 2], /h +memory/);                                                 // the screens' own keys stay lined up in their columns
});

test('ASS-188 AC5: A opens the all-projects screen with its grid focused, from the ? menu too; its ticket numbers are marked', () => {
  const opened = handleKey(state, star, wide);
  assert.deepEqual([opened.screen, opened.focus], ['A', 'agents']);
  const fromMenu = handleKey(menuOpened(state), star, wide);
  assert.deepEqual([fromMenu.screen, fromMenu.focus, fromMenu.menuOpen], ['A', 'agents', false]);
  const highlighted = [{ ...projects[0], highlights: [{ ticket: 'ABC-1', color: '#ffff00' }] }, projects[1]];
  const raw = render(onStar([{ ...assignment('Daredevil', 'ABC-1', 'A'), 'start-time': started(0) }], { projects: highlighted }), wide);
  assert.ok(raw.some(l => l.includes('\x1b[48;2;255;255;0m\x1b[30mABC-1')));
});

// ── ASS-246: A, beside a, opens the agents for all projects, in place of *.

const lowerA = key('a', { sequence: 'a' }), asterisk = key('8', { shift: true, sequence: '*' });

test('ASS-246 AC1, AC3: from the dashboard A opens the all-projects agents screen and a the selected project\'s; * opens nothing', () => {
  assert.equal(state.screen, 's');
  assert.deepEqual([handleKey(state, star, wide).screen, handleKey(state, star, wide).focus], ['A', 'agents']);
  assert.deepEqual([handleKey(state, lowerA, wide).screen, handleKey(state, lowerA, wide).focus], ['a', 'agents']);
  assert.equal(handleKey(state, asterisk, wide).screen, 's');
});

test('ASS-246 AC1–AC3: from every other screen A opens the all-projects agents and a the selected project\'s — no screen\'s own keys swallow A; * opens nothing', () => {
  for (const screen of [...'SbBcfmruaxh', 'A']) {
    const on = { ...state, screen };
    assert.equal(handleKey(on, star, wide).screen, 'A', `${screen} → A`);
    assert.equal(handleKey(on, lowerA, wide).screen, 'a', `${screen} → a`);
    assert.equal(handleKey(on, asterisk, wide).screen, screen, `${screen} → *`);
    const grid = { ...on, focus: 'agents' };
    assert.equal(handleKey(grid, star, wide).screen, 'A', `${screen} (agents focused) → A`);
  }
  const tiles = onAgents([{ ...assignment('Daredevil', 'ABC-1', 'A'), 'start-time': started(0) }]);
  assert.equal(handleKey(tiles, star, wide).screen, 'A');
  assert.equal(handleKey(onStar([{ ...assignment('Daredevil', 'ABC-1', 'A'), 'start-time': started(0) }]), lowerA, wide).screen, 'a');
});

test('ASS-246 AC2: the ? menu shows "A agents for all projects" beside "a agents", and no * entry', () => {
  const menu = menuOf(state);
  assert.ok(menu.includes('A agents for all projects'), menu.join('\n'));
  assert.ok(menu.some(e => /^a +agents\b/.test(e)), menu.join('\n'));
  assert.ok(!menu.some(e => e.startsWith('*')), menu.join('\n'));
  assert.ok(lines(menuOpened(state), wide).some(l => l.includes('A agents for all projects')));
});

// ===== ASS-207: the Ticket column keeps its key and 24 title characters; Health and Agents give up the width =====
// One ticket with a long title, a long Health and a long Agents line, the three
// that crowd each other on the sprint grid.
const squeezedTicket = {
  ...sprint.features[0], title: 'Sprint screen: the Ticket column is squeezed by Health',
  variations: [{ ...sprint.features[0].variations[0], 'ai-feedback-short': 'Two failing tests on the results grid and a stale merge request' }],
};
const squeezedState = initialState({
  projects: [{ ...projects[0], sprint: { ...sprint, features: [squeezedTicket] } }], workflows: [engine],
  assignments: [{ ...assignment('Daredevil-of-Hells-Kitchen-and-Matt-Murdock', 'ABC-1'), 'ai-status-update-short': 'Rewriting the allocation loop' }],
});
// Its row at `columns`, found by its type icon so a collapsed Ticket cell still matches.
const squeezedRow = columns => lines(squeezedState, { ...wide, columns }).find(l => l.includes('✦')) ?? '';
const TICKET_CELL = `${cols({ agent: '⚉' })}ABC-1: Sprint screen: the Ticke…`;   // the icon columns (ASS-259), the key and 24 characters of title

test('ASS-207 AC1: at 160 columns the Ticket cell keeps the key and 24 characters of title', () => {
  assert.equal(squeezedRow(160).slice(0, 2 + TICKET_CELL.length), `│ ${TICKET_CELL}`);
});

test('ASS-207 AC2: at 200 columns Health gives up its width first, then Agents, and the table still fits', () => {
  const row = squeezedRow(200);
  assert.match(row, / Ada Example {3}Two f… {3}🤖 Daredevil… │$/);   // Health cut hardest, Agents after it — two columns more now the icon columns widen Ticket's floor (ASS-259)
  assert.equal(visible(row), 200);
  assert.ok(row.includes(TICKET_CELL), row);
});

test('ASS-207 AC3: at 80 columns the Ticket cell still shows the key and 24 characters of title, the columns right of it clipped', () => {
  const row = squeezedRow(80);
  assert.equal(row.slice(0, 2 + TICKET_CELL.length), `│ ${TICKET_CELL}`);
  assert.equal(visible(row), 80);
  assert.ok(!row.includes('Two f'), row);                             // Health is off-screen, as today
});

test('ASS-207 AC4: with room to spare — 300 columns — the row is laid out as it is today: the whole title, Health and Agents at their 40-column caps', () => {
  const row = squeezedRow(300);
  assert.ok(row.startsWith(`│ ${cols({ agent: '⚉' })}ABC-1: Sprint screen: the Ticket column is squeezed by Health `), row);
  assert.match(row, /squeezed by Health {13}2 /);
  assert.match(row, / Two failing tests on the results grid a… {3}🤖 Daredevil-of-Hells-Kitchen-and-Matt-… │$/);
  assert.equal(visible(row), 300);
});

// ===== ASS-189: type to an agent from its tile =====
// Enter on the focused tile opens its one-row input (AC1); the fixtures above are
// ASS-188's, `exitedTail` the one this ticket adds.
const onTile = s => handleKey(s, key('return'), wide);
// The input row the focused tile draws: the row from its '> ' lead-in on, colors off.
const inputRow = (s, size = wide) => tilesOf(s, size).find(t => t.name === focusedTile(s, size))?.text.find(l => l.startsWith('> '));

// ── AC1: the one-row input, Enter sends, one Esc keeps the draft, a draft per agent.

test('ASS-189 AC1: Enter on a focused agent tile opens a one-row input in that tile, without zooming it', () => {
  const opened = onTile(onAgents(teamOf(2)));
  assert.equal(opened.agentTyping, true);
  assert.equal(opened.agent, null);                                                      // the grid, not the zoom
  assert.equal(focusedTile(opened), 'Agent-0');
  assert.ok(inputRow(opened) != null, tileText(tilesOf(opened)[0]));
  assert.ok(!tilesOf(opened)[1].text.some(l => l.startsWith('> ')));                     // only the focused tile
});

test('ASS-189 AC1: Enter on a chat tile still opens its chat; only an agent tile types', () => {
  const onChat = press(onAgents(teamOf(1), { chats: chatList, chatsRunning: ['c1'] }), 'right');
  const zoomed = onTile(onChat);
  assert.equal(zoomed.chat?.id, 'c1');
  assert.ok(!zoomed.agentTyping);
});

test('ASS-189 AC1: the input is one row — shift+enter, by every sequence a terminal sends for it, and ctrl+j are inert', () => {
  const typed = typing(onTile(onAgents(teamOf(2))), 'one');
  for (const [name, list] of Object.entries(SHIFT_ENTER)) {
    const after = keys(typed, list);
    assert.equal(after.agentDraft['Agent-0'], 'one', name);                              // no newline in the draft
    assert.equal(after.agentPrompt, null, `${name} sends nothing`);
    assert.equal(tilesOf(after)[0].text.filter(l => l.startsWith('> ')).length, 1, name); // and no second row
  }
});

test('ASS-189 AC1: printable keys go into the draft at the cursor the shared draft left it at', () => {
  const typed = typing(onTile(onAgents(teamOf(2))), 'hi');
  assert.deepEqual([typed.agentDraft['Agent-0'], typed.agentCursor['Agent-0']], ['hi', 2]);
  assert.equal(typing(typed, ' there').agentDraft['Agent-0'], 'hi there');
  // The zoom can leave the cursor mid-draft; the tile types in where it is, the arrows being the grid's.
  const mid = onTile({ ...onAgents(teamOf(2)), agentDraft: { 'Agent-0': 'word' }, agentCursor: { 'Agent-0': 2 } });
  assert.deepEqual([typing(mid, 'X').agentDraft['Agent-0'], typing(mid, 'X').agentCursor['Agent-0']], ['woXrd', 3]);
  assert.deepEqual([press(mid, 'left').agentCursor['Agent-0'], press(mid, 'right').agentCursor['Agent-0']], [2, 2]);   // ←/→ are not the cursor's here
});

// typeRow(text, cursor, room): the tile's one-row input — '> ' and a window over
// `text` `room` columns wide, lead-in included, the code point under the cursor in
// reverse video or a █ past the draft's end, sliding so the cursor stays in view.
test('ASS-189 AC1: the one-row input slides sideways to keep the cursor in view and never wraps', () => {
  const text = 'abcdefghij'.repeat(4);
  const end = agentsScreen.typeRow(text, 40, 20);
  assert.ok(!end.includes('\n'));
  assert.equal(visible(end), 20);
  assert.ok(strip(end).endsWith('█'));                                                   // the cursor at the draft's end
  assert.ok(strip(end).includes('fghij'), strip(end));                                   // its tail is what shows…
  assert.ok(!strip(end).includes('abcde'), strip(end));                                  // …not its head
  const start = agentsScreen.typeRow(text, 0, 20);
  assert.ok(strip(start).startsWith('> abc'), strip(start));                             // a cursor at the start slides it back
  assert.ok(start.includes('\x1b[7ma\x1b[0m'), strip(start));
  const mid = agentsScreen.typeRow(text, 25, 20);
  assert.ok(mid.includes('\x1b[7mf\x1b[0m'), strip(mid));                                // the 26th code point, in view
  assert.equal(visible(mid), 20);
});

test('ASS-189 AC1: at the narrowest tile the input is still one clipped row with the cursor in it', () => {
  const row = agentsScreen.typeRow('a long draft in a narrow tile', 29, 14);              // a 16-column tile, less its borders
  assert.equal(visible(row), 14);
  assert.ok(!row.includes('\n'));
  assert.ok(strip(row).endsWith('█'));
  const narrow = { ...wide, columns: 40 };
  const typed = typing(onTile(onAgents(teamOf(6))), 'a long draft in a narrow tile');
  assert.ok(inputRow(typed, narrow) != null);
  for (const line of render(typed, narrow)) assert.ok(visible(line) <= narrow.columns, strip(line));   // no overflow into its neighbour
});

test('ASS-189 AC1: a multi-line draft typed in the zoom shows in the tile as one row', () => {
  const row = agentsScreen.typeRow('one\ntwo', 7, 20);
  assert.ok(!row.includes('\n'));
  assert.ok(strip(row).startsWith('> one two'), strip(row));                             // the newline a space, as a wrapped prompt draws it
  const s = onTile({ ...onAgents(teamOf(2)), agentDraft: { 'Agent-0': 'one\ntwo' }, agentCursor: { 'Agent-0': 7 } });
  assert.equal(tilesOf(s)[0].text.filter(l => l.startsWith('> ')).length, 1);
  assert.ok(!tilesOf(s)[0].text.some(l => l.trim() === 'two'));
});

test('ASS-189 AC1: Enter sends the draft, clears that agent\'s alone, and queues the message', () => {
  const two = { ...onTile(onAgents(teamOf(2))), agentDraft: { 'Agent-1': 'theirs' }, agentCursor: { 'Agent-1': 6 } };
  const sent = handleKey(typing(two, 'Run it again'), key('return'), wide);
  assert.deepEqual(sent.agentPrompt, ['agent-interaction:resume-thread', 'Agent-0', 'Run it again']);
  assert.equal(sent.agentDraft['Agent-0'] ?? '', '');
  assert.equal(sent.agentCursor['Agent-0'] ?? 0, 0);
  assert.equal(sent.agentDraft['Agent-1'], 'theirs');                                    // another agent's draft is untouched
  assert.equal(sent.agentTyping, false);
  assert.deepEqual(sent.pending['Agent-0'].texts, ['Run it again']);
});

test('ASS-189 AC1: one Esc stops typing and keeps the draft; Enter again opens the input on it', () => {
  const typed = typing(onTile(onAgents(teamOf(2))), 'half a thought');
  const stopped = handleKey(typed, key('escape'), wide);
  assert.deepEqual([stopped.agentTyping, stopped.agent], [false, null]);                 // still the grid
  assert.equal(stopped.agentDraft['Agent-0'], 'half a thought');
  assert.equal(inputRow(stopped), undefined);
  assert.ok(inputRow(onTile(stopped)).includes('half a thought'));
});

test('ASS-189 AC1: a blank or whitespace-only draft sends nothing and is not cleared', () => {
  const blank = handleKey(onTile(onAgents(teamOf(2))), key('return'), wide);
  assert.equal(blank.agentPrompt, null);
  const spaces = handleKey(typing(onTile(onAgents(teamOf(2))), '   '), key('return'), wide);
  assert.equal(spaces.agentPrompt, null);
  assert.equal(spaces.agentDraft['Agent-0'], '   ');
  assert.deepEqual(spaces.pending, {});
});

test('ASS-189 AC1: backspace takes the code point before the cursor, delete the one under it, neither past the draft\'s ends', () => {
  const typed = typing(onTile(onAgents(teamOf(2))), 'word');
  assert.equal(press(typed, 'backspace').agentDraft['Agent-0'], 'wor');
  assert.equal(press(typed, 'delete').agentDraft['Agent-0'], 'word');                    // the cursor is at the end
  const start = onTile({ ...onAgents(teamOf(2)), agentDraft: { 'Agent-0': 'word' }, agentCursor: { 'Agent-0': 0 } });
  assert.equal(press(start, 'backspace').agentDraft['Agent-0'], 'word');                 // nothing before the start
  assert.deepEqual([press(start, 'delete').agentDraft['Agent-0'], press(start, 'delete').agentCursor['Agent-0']], ['ord', 0]);
});

test('ASS-189 AC1: each agent keeps its own draft, keyed by its name', () => {
  const first = typing(onTile(onAgents(teamOf(2))), 'to Agent-0');
  const moved = press(first, 'right');
  assert.equal(moved.agentTyping, false);
  const second = typing(onTile(moved), 'to Agent-1');
  assert.deepEqual([second.agentDraft['Agent-0'], second.agentDraft['Agent-1']], ['to Agent-0', 'to Agent-1']);
  assert.ok(inputRow(second).includes('to Agent-1'));
  assert.ok(!inputRow(second).includes('to Agent-0'));
});

test('ASS-189 AC1: a tile\'s draft is the zoom\'s — one draft per agent, read two ways', () => {
  const typed = typing(onTile(onAgents(teamOf(2))), 'from the tile');
  const zoomed = handleKey(handleKey(typed, key('escape'), wide), zKey, wide);
  assert.equal(zoomed.agent?.name, 'Agent-0');
  assert.equal(openDraft(zoomed), 'from the tile');
  assert.ok(promptRow({ ...zoomed, agentLog: ['line 0'] }).includes('from the tile'));
  const inZoom = typing(zoomed, ' and the zoom');
  assert.equal(inZoom.agentDraft['Agent-0'], 'from the tile and the zoom');
  // Esc in the zoom clears its draft first (ASS-41), so the grid is reached here with it kept.
  const again = onTile({ ...inZoom, ...agentsScreen.AGENT_LOG.close, agentTyping: false });
  assert.ok(inputRow(again).includes('and the zoom'));
});

test('ASS-189 AC1: a draft is dropped when its agent leaves assignments.json', () => {
  const flash = { ...assignment('Flash', 'X-1', null, 'assassin'), 'start-time': started(1) };
  const s = { ...onAgents(queuedTeam), agentDraft: { Daredevil: 'half a thought', Flash: 'theirs' }, agentCursor: { Daredevil: 14, Flash: 6 } };
  const settled = agentsScreen.settlePending({ ...s, assignments: [flash] });
  assert.ok(!('Daredevil' in settled.agentDraft), JSON.stringify(settled.agentDraft));
  assert.ok(!('Daredevil' in settled.agentCursor));
  assert.deepEqual([settled.agentDraft.Flash, settled.agentCursor.Flash], ['theirs', 6]);   // still assigned, still drafted
});

// ── AC2: text where text is typed; Tab/Shift-Tab/arrows still move the focus.

test('ASS-189 AC2: while typing, space, letters and digits are text — ?, Q, /, t and ! with them', () => {
  const typed = typing(onTile(onAgents(teamOf(2))), 'q?t/Q!7 x');
  assert.equal(typed.agentDraft['Agent-0'], 'q?t/Q!7 x');
  assert.deepEqual([typed.menuOpen, typed.menuHidden, typed.agentsTable, typed.quitting], [false, false, false, false]);
  assert.deepEqual(typed.pauses, {});
  assert.deepEqual([typed.screen, typed.agentTyping], ['a', true]);
});

test('ASS-189 AC2: Tab stops typing, keeps the draft and steps the tiles; Shift-Tab steps back', () => {
  const typed = typing(onTile(onAgents(teamOf(2))), 'kept');
  const tabbed = press(typed, 'tab');
  assert.deepEqual([tabbed.agentTyping, focusedTile(tabbed), tabbed.agentDraft['Agent-0']], [false, 'Agent-1', 'kept']);
  const second = typing(onTile(tabbed), 'theirs');
  const back = handleKey(second, shiftTab, wide);
  assert.deepEqual([back.agentTyping, focusedTile(back), back.agentDraft['Agent-1']], [false, 'Agent-0', 'theirs']);
  assert.equal(back.agentDraft['Agent-0'], 'kept');
});

test('ASS-189 AC2: Tab past the last tile while typing stops it, keeps the draft and carries the focus on', () => {
  const one = typing(onTile(onAgents(teamOf(1))), 'kept');
  const past = press(one, 'tab');
  assert.equal(past.focus, 'menu');                                                      // off the grid: app.js's focus cycle
  assert.equal(past.agentTyping, false);
  assert.equal(past.agentDraft['Agent-0'], 'kept');
});

test('ASS-189 AC2: the arrows stop typing, keep the draft and move the focused tile', () => {
  const six = onAgents(teamOf(6));
  const typed = typing(onTile(six), 'kept');
  for (const [name, tile] of [['right', 'Agent-1'], ['down', 'Agent-3'], ['left', 'Agent-0'], ['up', 'Agent-0']]) {
    const moved = press(typed, name);
    assert.deepEqual([moved.agentTyping, focusedTile(moved), moved.agentDraft['Agent-0']], [false, tile, 'kept'], name);
  }
  const middle = typing(onTile(press(typed, 'right', 'down')), 'theirs');                // a tile with room either way
  assert.equal(focusedTile(press(middle, 'left')), 'Agent-3');
  assert.equal(focusedTile(press(middle, 'up')), 'Agent-1');
  assert.equal(press(middle, 'up').agentDraft['Agent-4'], 'theirs');
});

test('ASS-189 AC2: tiles type the same on * as on a', () => {
  const typed = typing(onTile(onStar(bothProjectsTeam)), 'hello');
  assert.deepEqual([typed.screen, typed.agentTyping, typed.agentDraft.Daredevil], ['A', true, 'hello']);
  assert.ok(inputRow(typed).includes('hello'));
  assert.deepEqual(handleKey(typed, key('return'), wide).agentPrompt, ['agent-interaction:resume-thread', 'Daredevil', 'hello']);
});

test('ASS-189 AC2: the table (t) keeps Enter opening the selected agent\'s log', () => {
  const table = handleKey(onAgents(queuedTeam), tKey, wide);
  const opened = handleKey(table, key('return'), wide);
  assert.equal(opened.agent?.name, 'Daredevil');
  assert.ok(!opened.agentTyping);
});

// ── AC3: the queued, not read and refused marks.

test('ASS-189 AC3: a message sent from a tile marks it "queued" until its "> " line shows', () => {
  const sent = handleKey(typing(onTile(onAgents(queuedTeam)), 'Run it again'), key('return'), wide);
  assert.equal(sent.agent, null);                                                        // sent from the tile: still the grid
  assert.ok(queuedTile(sent).includes('queued'));
  assert.ok(!queuedTile(sent).includes('not read'));
  const read = agentsScreen.settlePending({ ...sent, sessionTails: { Daredevil: ['> Run it again', 'On it.'] } });
  assert.deepEqual(read.pending.Daredevil?.texts ?? [], []);
  assert.ok(!queuedTile(read).includes('queued') && !queuedTile(read).includes('not read'));
});

test('ASS-189 AC3: queuePending queues a message\'s first line under its agent', () => {
  const one = agentsScreen.queuePending({}, 'Daredevil', 'first line\nsecond line');
  assert.deepEqual(one.Daredevil.texts, ['first line']);
  assert.ok(!one.Daredevil.notRead);
  assert.deepEqual(agentsScreen.queuePending(one, 'Daredevil', 'again').Daredevil.texts, ['first line', 'again']);
  assert.deepEqual(agentsScreen.queuePending(undefined, 'Flash', 'hi').Flash.texts, ['hi']);
});

test('ASS-189 AC3: a queued message flips to "not read" when the agent exits with its "> " line never written', () => {
  const sent = handleKey(typing(onTile(onAgents(queuedTeam)), 'Run it again'), key('return'), wide);
  assert.equal(sent.agent, null);                                                        // sent from the tile: still the grid
  const exited = agentsScreen.settlePending({ ...sent, sessionTails: { Daredevil: exitedTail(['said one']) } });
  assert.equal(exited.pending.Daredevil.notRead, true);
  assert.ok(queuedTile(exited).includes('not read'));
  assert.ok(!queuedTile(exited).includes('queued'));
});

test('ASS-189 AC3: "not read" sticks — later ticks, and a late "> " line, leave it as long as the tile is shown', () => {
  const sent = handleKey(typing(onTile(onAgents(queuedTeam)), 'Run it again'), key('return'), wide);
  assert.equal(sent.agent, null);                                                        // sent from the tile: still the grid
  const exited = agentsScreen.settlePending({ ...sent, sessionTails: { Daredevil: exitedTail() } });
  assert.equal(agentsScreen.settlePending(exited).pending.Daredevil.notRead, true);
  const late = agentsScreen.settlePending({ ...exited, sessionTails: { Daredevil: exitedTail(['> Run it again']) } });
  assert.equal(late.pending.Daredevil.notRead, true);
  assert.ok(queuedTile(late).includes('not read'));
});

test('ASS-189 AC3: a message read before its agent exits leaves no mark, and one unread with the agent still running stays "queued"', () => {
  const sent = handleKey(typing(onTile(onAgents(queuedTeam)), 'Run it again'), key('return'), wide);
  assert.equal(sent.agent, null);                                                        // sent from the tile: still the grid
  const delivered = agentsScreen.settlePending({ ...sent, sessionTails: { Daredevil: exitedTail(['> Run it again', 'On it.']) } });
  assert.ok(!delivered.pending.Daredevil?.notRead);
  assert.ok(!queuedTile(delivered).includes('not read') && !queuedTile(delivered).includes('queued'));
  const waiting = agentsScreen.settlePending(agentsScreen.settlePending({ ...sent, sessionTails: { Daredevil: ['said one'] } }));
  assert.deepEqual(waiting.pending.Daredevil.texts, ['Run it again']);
  assert.ok(!waiting.pending.Daredevil.notRead);
  assert.ok(queuedTile(waiting).includes('queued'));
});

test('ASS-189 AC3: refused(pending, name) marks that agent not read, with or without a message queued', () => {
  const fresh = agentsScreen.refused({}, 'Daredevil');
  assert.equal(fresh.Daredevil.notRead, true);
  const kept = agentsScreen.refused({ Daredevil: { texts: ['hi'], notRead: false } }, 'Daredevil');
  assert.deepEqual([kept.Daredevil.notRead, kept.Daredevil.texts], [true, ['hi']]);
  assert.deepEqual(agentsScreen.refused({ Flash: { texts: ['x'], notRead: false } }, 'Daredevil').Flash, { texts: ['x'], notRead: false });
});

test('ASS-189 AC3: a refused send names the agent and its reason in the line under the grid, the tile showing only "not read"', () => {
  const refused = { ...onAgents(queuedTeam), pending: agentsScreen.refused({}, 'Daredevil'), agentMessage: 'Daredevil is not running (process 1)' };
  assert.ok(lines(refused, wide).some(l => l.trim() === 'Daredevil is not running (process 1)'), lines(refused, wide).at(-1));
  assert.ok(queuedTile(refused).includes('not read'));
  assert.ok(!queuedTile(refused).includes('not running'));                                // the reason is under the grid, not in the tile
});

test('ASS-189 AC3: the line under the grid shows a successful send too', () => {
  const s = { ...onAgents(queuedTeam), agentMessage: 'queued for Daredevil' };
  assert.ok(lines(s, wide).some(l => l.trim() === 'queued for Daredevil'));
  assert.ok(!lines(onAgents(queuedTeam), wide).some(l => l.includes('undefined')));       // no message, no line
});

test('ASS-189 AC3: a paused, unhealthy tile shows ⏸️ and ⚠️ with its message mark, in that order', () => {
  const inSprint = [{ ...projects[0], sprint: { ...sprint, features: [...sprint.features, pausedTicket] } }, projects[1]];
  const team = [{ ...assignment('Daredevil', 'ABC-9', 'A'), 'start-time': started(0), 'ai-feedback-short': 'Stuck on tests' }];
  const sent = handleKey(typing(onTile(onAgents(team, { projects: inSprint })), 'Run it again'), key('return'), wide);
  assert.equal(sent.agent, null);
  const queued = queuedTile(sent);
  assert.ok(queued.indexOf('⏸') < queued.indexOf('⚠') && queued.indexOf('⚠') < queued.indexOf('queued'), queued);
  const exited = queuedTile(agentsScreen.settlePending({ ...sent, sessionTails: { Daredevil: exitedTail() } }));
  assert.ok(exited.indexOf('⏸') < exited.indexOf('⚠') && exited.indexOf('⚠') < exited.indexOf('not read'), exited);
});

test('ASS-189 AC3: settlePending with no pending at all returns a well-formed state', () => {
  const s = onAgents(queuedTeam);
  assert.deepEqual(agentsScreen.settlePending({ ...s, pending: {} }).pending, {});
  assert.deepEqual(agentsScreen.settlePending({ ...s, pending: undefined }).pending, {});
  assert.ok(!queuedTile(agentsScreen.settlePending({ ...s, pending: {} })).includes('queued'));
});

// ── An agents grid with no tiles (ASS-223): the screen keys still switch screen,
// and the body says why it is empty.

const screenKeys = [...'sbcxru'].map(c => key(c, { sequence: c }));

test('ASS-223 AC1: on a or A with no agents, s b c x r u A switch screen on the first press, focus on the agents', () => {
  for (const open of [onAgents([]), onStar([])]) {
    assert.equal(open.focus, 'agents');
    for (const k of [...screenKeys, star]) assert.equal(handleKey(open, k, wide).screen, k.sequence, `${open.screen} → ${k.sequence}`);
  }
  assert.equal(handleKey(onAgents([]), star, wide).screen, 'A');
  assert.equal(handleKey(onStar([]), key('a', { sequence: 'a' }), wide).screen, 'a');
});

test('ASS-223 AC2: with no agents the body says "no agents running in <project>" (on *: "no agents running"), centred, with the t hint', () => {
  const centred = (out, text) => {
    const line = out.find(l => l.trim() === text);
    assert.ok(line, `${text} in:\n${out.join('\n')}`);
    assert.ok(Math.abs(line.indexOf(text) - (wide.columns - text.length) / 2) <= 1, line);
  };
  const a = lines(onAgents([]), wide);
  centred(a, 'no agents running in Example');
  centred(a, 'press t for the table');
  const all = lines(onStar([]), wide);
  centred(all, 'no agents running');
  centred(all, 'press t for the table');
});

test('ASS-223 AC3: too narrow for a tile, the screen keys still switch screen; t and tab behave as before', () => {
  const tooNarrow = { ...wide, columns: 15 };
  const s = handleKey({ ...initialState({ projects, workflows: [], assignments: teamOf(3) }) }, key('a'), tooNarrow);
  assert.ok(lines(s, tooNarrow).some(l => l.includes('terminal too')));
  for (const k of [...screenKeys, star]) assert.equal(handleKey(s, k, tooNarrow).screen, k.sequence);
  assert.equal(handleKey(s, tKey, tooNarrow).agentsTable, true);
  assert.notEqual(handleKey(s, key('tab'), tooNarrow).focus, 'agents');
});

// ASS-243: the sprint and backlog grids separate their rows with a dim gray dashed line, not a blank one.
test('ASS-243 AC1: the sprint and backlog grids put a dim gray dashed line between rows, none after the last', () => {
  const between = st => {
    const out = render(st, wide);
    const rows = out.flatMap((l, i) => (/ABC-\d+:/.test(l) ? [i] : []));
    assert.ok(rows.length >= 2, out.join('\n'));
    for (const i of rows.slice(1)) assert.match(out[i - 1], /^│\x1b\[90m {3}- {3}- .*-\s*\x1b\[0m│$/, out[i - 1]);
    assert.doesNotMatch(out[rows.at(-1) + 1], /-   -/);
  };
  between({ ...state, screen: 's' });
  between(handleKey(withBacklog([backlogTicket('ABC-60', 'groom'), backlogTicket('ABC-61', 'ready'), backlogTicket('ABC-62', 'groom')]), key('b')));
});

// ===== ASS-244: the ticket's screenshots in the panel =====
test('ASS-244 AC1/AC2/AC3: the ticket screen\'s panel lists the ticket\'s screenshots, recorded then not, linked to their files under the project\'s folder; below 100 columns a count linked to the folder; none without', () => {
  const base = atGate({ 'local-testing': { screenshots: [{ file: '1/criterion-1.png', 'criteria-number': 1, shows: 'the cite' }] } });
  const [project] = base.projects;
  const s = { ...base, projects: [{ ...project, dir: '/d/p', reviews: { 'ABC-6': { screenshots: { 1: ['/d/p/work/ABC-6/screenshots/1/criterion-1.png'], '': ['/d/p/work/ABC-6/screenshots/extra.png'] } } } }] };
  const open = press(s, 'return');
  const panel = lines(open, { ...wide, rows: 60 }).map(l => l.slice(-(PANEL - 1)).replace(/│$/, '').trim());
  const at = panel.indexOf('Screenshots');
  assert.deepEqual(panel.slice(at, at + 5), ['Screenshots', 'A', 'AC1 · the cite', 'Other', 'extra.png'], panel.join('\n'));
  const raw = render(open, { ...wide, rows: 60 }).join('\n');
  assert.ok(raw.includes('\x1b]8;;file:///d/p/work/ABC-6/screenshots/1/criterion-1.png\x1b\\') && raw.includes('\x1b]8;;file:///d/p/work/ABC-6/screenshots/extra.png\x1b\\'));
  const strip96 = lines(open, narrow);
  assert.ok(strip96.includes('Screenshots: 2 — open the folder'), strip96.join('\n'));
  assert.ok(render(open, narrow).join('\n').includes('\x1b]8;;file:///d/p/work/ABC-6/screenshots\x1b\\'));
  assert.ok(!lines(press(atGate(), 'return'), { ...wide, rows: 60 }).some(l => l.includes('Screenshots')));
});

// The harness's disk as control last read it (ASS-288: disk-space.json).
const GIB = 2 ** 30;
const diskAt = (level, gib) => ({ level, 'free-bytes': gib * GIB, 'warn-bytes': 50e9, 'hold-bytes': 15e9, 'held-since': level === 'hold' ? '2026-10-01T16:00:00Z' : null, volumes: [] });

test('ASS-288 AC2: below disk-free-warn-gb the header shows the free space under the banner in amber, not red, on every project; above it, or never read, nothing', () => {
  for (const disk of [undefined, null, diskAt('ok', 120)]) assert.ok(!lines({ ...state, disk }).some(l => /Disk|GiB free/.test(l)), JSON.stringify(disk));
  const out = render({ ...state, disk: diskAt('warn', 42) }, screen);
  centered(strip(out[1]), 'Disk low: 42.0 GiB free, below the 50 GB warning level — control deletes stopped VMs no ticket needs');
  assert.match(out[1], /\x1b\[38;2;255;176;0mDisk low: /);
  assert.doesNotMatch(out[1], /\x1b\[31m|\x1b\[41/);
  centered(lines({ ...state, disk: diskAt('warn', 42), project: 1 })[1], 'Disk low: 42.0 GiB free, below the 50 GB warning level — control deletes stopped VMs no ticket needs');
  for (const line of lines({ ...state, disk: diskAt('warn', 42) }, { ...screen, columns: 30 })) assert.ok(line.length <= 30, line);
});

test('ASS-288 AC4: below disk-free-hold-gb the header says "Disk nearly full — work held (N GiB free)", stronger than the warning (black on amber), and on the flow screens too', () => {
  const out = render({ ...state, disk: diskAt('hold', 12) }, screen);
  centered(strip(out[1]), ' Disk nearly full — work held (12.0 GiB free): nothing new starts until 50 GB is free ');
  assert.match(out[1], /\x1b\[1;30;48;2;255;176;0m Disk nearly full — work held \(12\.0 GiB free\)/);
  for (const flow of FLOWS) {
    const header = strip(headerLines({ ...state, screen: flow, disk: diskAt('hold', 12) }, 160, at160.now).join('\n'));
    assert.match(header, /Disk nearly full — work held \(12\.0 GiB free\)/, flow);
    assert.match(strip(headerLines({ ...state, screen: flow, disk: diskAt('warn', 42) }, 160, at160.now).join('\n')), /Disk low: 42\.0 GiB free/, flow);
    assert.doesNotMatch(strip(headerLines({ ...state, screen: flow, disk: diskAt('ok', 99) }, 160, at160.now).join('\n')), /Disk/, flow);
  }
});

// ===== ASS-292: the disk's free space and the project's golden image in the control box =====
const goldenBuilt = { name: 'golden-p', 'built-at': '2026-11-01T05:42:33Z' };
const controlBox = s => lines(s).filter(l => /│ (control|status|uptime|disk free|golden image|exited|last)/.test(l)).map(l => l.match(/│ ((control|status|uptime|disk free|golden image|exited|last)[^│]*?) +│/)?.[1]).filter(Boolean);

test('ASS-292 AC1: the control box ends with the disk\'s free space and the project\'s golden image, its name and the day it was built (UTC, ASS-294)', () => {
  const project = { id: 'p', name: 'P', sprint: null, control: { status: 'Online' }, environments: [], golden: goldenBuilt };
  const box = controlBox(initialState({ projects: [project], disk: diskAt('ok', 120) }));
  assert.deepEqual(box.slice(-2), ['disk free: 120.0 GiB', 'golden image: golden-p (built 2026-11-01 UTC)']);
  assert.equal(box[0], 'control');
});

test('ASS-292 AC1: below the warning level the disk free line is amber, as the low-disk line under the banner; at or above it, plain', () => {
  const project = { id: 'p', name: 'P', sprint: null, control: { status: 'Online' }, environments: [], golden: goldenBuilt };
  const at = disk => render(initialState({ projects: [project], disk }), screen).find(l => l.includes('disk free: '));
  assert.ok(at(diskAt('warn', 42)).includes('\x1b[38;2;255;176;0mdisk free: 42.0 GiB'), at(diskAt('warn', 42)));
  assert.ok(at(diskAt('hold', 12)).includes('\x1b[38;2;255;176;0mdisk free: 12.0 GiB'));
  assert.ok(!at(diskAt('ok', 120)).includes('\x1b[38;2;255;176;0m'));
});

test('ASS-292 AC1/AC3: a project without a golden image says none, one never built says so, and a disk control never read is unknown', () => {
  const box = (golden, disk) => controlBox(initialState({ projects: [{ id: 'p', name: 'P', sprint: null, control: { status: 'Online' }, environments: [], golden }], disk })).slice(-2);
  assert.deepEqual(box(null, null), ['disk free: unknown', 'golden image: none']);
  assert.deepEqual(box(undefined, diskAt('ok', 99)), ['disk free: 99.0 GiB', 'golden image: none']);
  assert.deepEqual(box({ name: 'golden-p', 'built-at': null }, null), ['disk free: unknown', 'golden image: golden-p (not built)']);
});

test('ASS-292 AC2: the red control DOWN box shows the same two lines', () => {
  const project = { id: 'p', name: 'P', sprint: null, control: { status: 'Online' }, environments: [], golden: goldenBuilt };
  const logged = { ...initialState({ projects: [project], disk: diskAt('ok', 120) }), controlLog: [{ text: 'boom', project: 'p' }, { text: 'control exited (code 1)', project: 'p' }] };
  const box = controlBox(controlExited(logged, 'p', 1));
  assert.equal(box[0], 'control DOWN');
  assert.deepEqual(box.slice(-2), ['disk free: 120.0 GiB', 'golden image: golden-p (built 2026-11-01 UTC)']);
});

// ===== ASS-293: the project's Hindsight, as the dashboard last checked it, in the control box =====
// p with a Hindsight on 9077 (project.json's hindsight) and the dashboard's last check of it (memoryHealth, tui/memory.js memoryChecked).
const withHindsight = { id: 'p', name: 'P', sprint: null, control: { status: 'Online' }, environments: [], golden: goldenBuilt, hindsight: { port: 9077 } };
const checked = (healthy, extra = {}) => ({ p: { port: 9077, healthy, since: Date.parse('2026-10-01T15:58:00Z'), ...extra } });
const memoryBox = s => lines(s).map(l => l.match(/│ ((control|status|uptime|disk free|golden image|hindsight|exited|last)[^│]*?) +│/)?.[1]).filter(Boolean);
const hindsightLine = s => render(s, screen).find(l => strip(l).includes('hindsight: '));
const since1558 = timestamp(new Date('2026-10-01T15:58:00Z'));

test('ASS-293 AC2: after the golden image line the control box ends with the project\'s Hindsight: up with its port, down with its port and since when, checking before the first check', () => {
  const box = memoryHealth => memoryBox({ ...initialState({ projects: [withHindsight] }), memoryHealth });
  assert.deepEqual(box(checked(true)).slice(-2), ['golden image: golden-p (built 2026-11-01 UTC)', 'hindsight: up (port 9077)']);
  assert.equal(box(checked(false)).at(-1), `hindsight: down (port 9077) since ${since1558}`);
  assert.equal(box(undefined).at(-1), 'hindsight: checking');
  assert.equal(box({}).at(-1), 'hindsight: checking');
  assert.equal(box(checked(true, { port: 9078 })).at(-1), 'hindsight: checking');   // a check of the port it had: the new one not yet checked
});

test('ASS-293 AC2: up is green, down red, checking and none plain', () => {
  const line = (memoryHealth, project = withHindsight) => hindsightLine({ ...initialState({ projects: [project] }), memoryHealth });
  assert.ok(line(checked(true)).includes('\x1b[32mhindsight: up (port 9077)'));
  assert.ok(line(checked(false)).includes(`\x1b[31mhindsight: down (port 9077) since ${since1558}`));
  assert.ok(!/\x1b\[(32|31)mhindsight/.test(line({})));
  assert.ok(!/\x1b\[(32|31)mhindsight/.test(line(checked(true), { ...withHindsight, hindsight: null })));
});

test('ASS-293 AC2: a project without a hindsight says none, whatever check is left', () => {
  const box = (project, memoryHealth) => memoryBox({ ...initialState({ projects: [project] }), memoryHealth }).at(-1);
  assert.equal(box({ ...withHindsight, hindsight: null }, checked(true)), 'hindsight: none');
  assert.equal(box({ ...withHindsight, hindsight: undefined }, undefined), 'hindsight: none');
});

test('ASS-293 AC3: the red control DOWN box shows the same line, still checked live', () => {
  const down = memoryHealth => {
    const logged = { ...initialState({ projects: [withHindsight] }), memoryHealth, controlLog: [{ text: 'boom', project: 'p' }, { text: 'control exited (code 1)', project: 'p' }] };
    return memoryBox(controlExited(logged, 'p', 1));
  };
  assert.equal(down(checked(true))[0], 'control DOWN');
  assert.equal(down(checked(true)).at(-1), 'hindsight: up (port 9077)');
  assert.equal(down(checked(false)).at(-1), `hindsight: down (port 9077) since ${since1558}`);
  assert.equal(down({}).at(-1), 'hindsight: checking');
});
