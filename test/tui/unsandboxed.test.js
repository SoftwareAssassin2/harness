// ASS-564 AC3: the worktree lines of the compute network screen (n; ASS-572: each machine card's "On it", the machine
// boxes' before, the footer's before ASS-566) mark a ticket whose agent there runs without Claude Code's sandbox (its
// session's sandbox.json, read into state.sandboxed by agent name): "🌿 <KEY> worktree · 🤖 <step> · unsandboxed", on a
// remote machine's card and the Mac's; a sandboxed one, or one not at work, unmarked.
// The ticket screen's mark is in test/tui/app.test.js; the session's record in test/control/worktree-sandbox.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState } from '../../src/tui/app.js';
import { ticketsOn } from '../../src/tui/machine-tickets.js';
import { readSandboxed } from '../../src/agents/session.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const steps = [
  { id: 'generate-solution', name: 'Generate Solution', sequence: 1, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 2, 'is-done': true },
];
const at = { 'harness-status': { state: 'generate-solution', 'state-engine': 'e' } };
const sprint = {
  number: 1, start: '2026-11-16', end: '2026-11-29', bugs: [], spikes: [],
  features: [
    { key: 'WT-1', title: 'T', priority: 1, variations: [{ name: 'A', ...at }] },
    { key: 'WT-2', title: 'T', priority: 1, variations: [{ name: 'A', ...at }] },
  ],
};
const ws = { id: 'ws-1', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'k' };
const holders = { 1: { ticket: 'WT-1', variation: 'A', folder: '/home/u/harness/worktrees/WT-1', slot: 1, worktree: true }, 2: { ticket: 'WT-2', variation: 'A', folder: '/home/u/harness/worktrees/WT-2', slot: 2, worktree: true } };
const remote = {
  id: 'p', name: 'P', environments: [], stateEngine: 'e', sprint, devEnvironments: { mode: 'workstation', workstations: [ws] },
  runTargets: ['workstation-worktree'], localSeats: [], seats: [], vms: {}, workstations: { 'ws-1': { state: 'running', connected: true, holders } }, seatBudget: { seats: 2 }, limits: { project: {}, harness: {} },
};
const local = { ...remote, devEnvironments: { mode: 'vm', workstations: [] }, workstations: {}, runTargets: ['local-worktree'], localSeats: [{ key: 'WT-1', variation: 'A', target: 'local-worktree' }, { key: 'WT-2', variation: 'A', target: 'local-worktree' }] };
const agents = [{ project: 'p', 'agent-name': 'X', 'work-item': 'WT-1', variation: 'A', model: 'opus-5' }, { project: 'p', 'agent-name': 'Y', 'work-item': 'WT-2', variation: 'A', model: 'opus-5' }];
const sandboxed = { X: { sandboxed: false, why: 'socat not installed', machine: 'ws-1' }, Y: { sandboxed: true, machine: 'ws-1' } };
const on = (project, machine) => ticketsOn({ ...initialState({ projects: [project], workflows: [{ name: 'e', steps }], assignments: agents, controls: { p: { pid: 1, startTime: '2026-11-23T08:00:00Z' } } }), sandboxed }, project, machine).map(e => strip(e.text));

test('ASS-564 AC3: a remote machine\'s worktree line says "unsandboxed" while its agent runs without the sandbox; a sandboxed one does not', () => {
  assert.deepEqual(on(remote, 'ws-1'), ['🌿 WT-1 worktree · 🤖 Generate Solution · unsandboxed', '🌿 WT-2 worktree · 🤖 Generate Solution']);
});

test('ASS-564 AC3: the local box\'s worktree line says "unsandboxed" the same way', () => {
  assert.deepEqual(on(local, 'mac'), ['🌿 WT-1 worktree · 🤖 Generate Solution · unsandboxed', '🌿 WT-2 worktree · 🤖 Generate Solution']);
});

test('ASS-564 AC3: readSandboxed reads a session\'s sandbox.json, null when none or malformed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ass564-'));
  assert.equal(readSandboxed(dir), null);
  writeFileSync(join(dir, 'sandbox.json'), '{"sandboxed":false,"why":"socat not installed","target":"workstation-worktree","machine":"ws-1"}\n');
  assert.deepEqual(readSandboxed(dir), { sandboxed: false, why: 'socat not installed', target: 'workstation-worktree', machine: 'ws-1' });
  writeFileSync(join(dir, 'sandbox.json'), '{"what":1}');
  assert.equal(readSandboxed(dir), null);
});
