// The rules that hold a host agent not working a ticket's code (ASS-108):
// Claude Code settings the harness writes in its own folder, which let it
// write only temp (ASS-182: the harness's data only through agent.sh) — refused anywhere else by
// Claude Code's permissions (Edit/Write) and sandbox (Bash), not by
// instruction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { confineHostAgent, hostAgentSettings } from '../../src/agents/confinement.js';
import { editAllowed, bashWriteAllowed } from '../support/claude-rules.js';

const TMP = realpathSync(tmpdir());

// The rules for a harness at a Mac path outside temp (temp is writable, so a
// harness in it would prove nothing), its agent in data/projects/p.
function rules() {
  const root = '/Volumes/Data/src/harness', data = join(root, 'data');
  return { root, data, cwd: join(data, 'projects', 'p'), settings: join(data, 'projects', 'p', 'host-agent-settings.json'), json: hostAgentSettings(root) };
}

// A harness in a temp folder, with a project p, and its agent confined.
function confined() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-')));
  mkdirSync(join(root, 'data', 'projects', 'p'), { recursive: true });
  const { cwd, settings } = confineHostAgent({ root, project: 'p' });
  return { root, cwd, settings, json: JSON.parse(readFileSync(settings, 'utf8')) };
}

test('ASS-182 AC2: a confined host agent writes only temp: the harness\'s data (its own working folder, data/projects/<id>, among it), archive/ and src/off-board/ change only through agent.sh and off-board.sh, and anywhere else — a project\'s checkout, the harness\'s own code, home — is refused to its Edit/Write tools and its shell alike', () => {
  const { root, data, cwd, json } = rules();
  const writes = path => [editAllowed(json, path), bashWriteAllowed(json, path, { cwd, tmp: TMP })];
  for (const allowed of [join(TMP, 'scratch.txt'), '/tmp/x', '/private/tmp/x']) assert.deepEqual(writes(allowed), [true, true], allowed);
  for (const refused of [
    join(cwd, 'notes.md'),                                              // its own working folder, though the sandbox allows a command its cwd
    join(data, 'projects', 'p', 'work', 'ABC-1', 'notes.md'),           // a ticket's folder
    join(data, 'projects', 'p', 'work', 'ABC-1', 'acceptance-criteria.json'),
    join(data, 'projects', 'q', 'backlog.json'),
    join(data, 'agents', 'Hulk-20261024T120000Z', 'inbox.jsonl'),
    join(data, 'chats', 'c1', 'session.txt'),
    join(data, 'assignments.json'), join(data, 'assignments.json.lock'), join(data, 'assignments.json.Ab12Cd'), join(data, 'harness.json'),
    join(root, 'archive', 'x.json'),
    join(root, 'src', 'off-board', 'harness', 'ASS-1.md'),              // the harness's own tickets: off-board.sh's
    '/Volumes/Data/src/example-project/libs/users/ada/docs/todo.md',   // a project checkout's file (ASS-93's stray note)
    join(root, 'src', 'control', 'dispatch.js'), join(root, 'agent.sh'), join(root, 'engines', 'x', 'state-engine.json'),
    join(root, 'assignments.json'), join(root, 'projects', 'p', 'x'),   // the root's old data paths
    `${process.env.HOME}/.zshrc`, `${process.env.HOME}/.harness/vm-credentials.json`,
  ]) assert.deepEqual(writes(refused), [false, false], refused);
});

test('a confined host agent cannot rewrite its own rules or any project\'s Claude login: the settings file and every data/projects/<id>/.claude are refused', () => {
  const { data, cwd, settings, json } = rules();
  for (const path of [settings, join(data, 'projects', 'p', '.claude', 'settings.json'), join(data, 'projects', 'q', '.claude', '.claude.json'), join(data, 'projects', 'q', 'host-agent-settings.json')]) {
    assert.equal(editAllowed(json, path), false, path);
    assert.equal(bashWriteAllowed(json, path, { cwd, tmp: TMP }), false, path);
  }
});

test('the rules are Claude Code\'s own: nothing is asked (dontAsk refuses what no rule allows), the sandbox is on, refuses to start without it, and never retries a command outside it', () => {
  const { json } = rules();
  assert.equal(json.permissions.defaultMode, 'dontAsk');
  assert.deepEqual([json.sandbox.enabled, json.sandbox.failIfUnavailable, json.sandbox.allowUnsandboxedCommands], [true, true, false]);
  assert.notEqual(json.sandbox.autoAllowBashIfSandboxed, false);                       // sandboxed commands run without asking
  for (const tool of ['Bash', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']) assert.ok(json.permissions.allow.includes(tool), tool);   // what it may still do, unasked
  assert.ok(json.permissions.allow.includes('WebFetch(domain:*)'));                     // its sandboxed commands reach the network, as before
  assert.ok(!json.permissions.allow.some(r => /^(Edit|Write|NotebookEdit)$/.test(r)));  // no bare write tool: only the paths
  for (const rule of [...json.permissions.allow, ...json.permissions.deny].filter(r => r.startsWith('Edit('))) assert.match(rule, /^Edit\(\/\//, rule);   // every path absolute (//), never relative to wherever it runs
});

test('the harness\'s own commands and the forge CLIs run outside the sandbox, by their full command line only; nothing else does', () => {
  const { root, json } = rules();
  const excluded = json.sandbox.excludedCommands;
  for (const command of [`${root}/agent.sh *`, `${root}/off-board.sh *`, 'gh *', 'glab *', 'acli *']) assert.ok(excluded.includes(command), command);
  assert.ok(!excluded.some(c => /^(bash|sh|zsh|node|python3?|git|npm|sed|tee|cp|mv|docker|docker exec) \*$/.test(c)), excluded.join(', '));   // nothing that writes files on its own say

  // ASS-182 AC2: no filter either — jq, head, tail, grep, wc, cut run sandboxed, so none can redirect into data/ (a pipe from an agent.sh write runs it sandboxed too).
  assert.deepEqual(excluded.filter(c => !/agent\.sh \*$|off-board\.sh \*$|^(gh|glab|acli) \*$|^docker (ps|inspect|images|logs|compose ps|compose ls) \*$/.test(c)), []);
});

test('the settings are written in the harness\'s own folder, data/projects/<id>/host-agent-settings.json, and the agent runs in data/projects/<id>; nothing is written anywhere else', () => {
  const { root, cwd, settings } = confined();
  assert.equal(settings, join(root, 'data', 'projects', 'p', 'host-agent-settings.json'));
  assert.equal(cwd, join(root, 'data', 'projects', 'p'));
  assert.deepEqual(readdirSync(root, { recursive: true }).toSorted(), ['data', join('data', 'projects'), join('data', 'projects', 'p'), join('data', 'projects', 'p', 'host-agent-settings.json')]);
  assert.equal(confineHostAgent({ root, project: 'p' }).settings, settings);           // written again, the same file
});

test('ASS-62: a confined agent may use its project\'s memory — every tool of the hindsight MCP server, unasked — whatever dontAsk refuses', () => {
  const json = hostAgentSettings('/h');
  assert.ok(json.permissions.allow.includes('mcp__hindsight'), json.permissions.allow.join(' '));
});
