// A temp copy of everything the control-facing agent-cli commands read and
// write: assignments.json, harness.json, last-model-used, agent-names.json and agent-names-last-used.json, an engines/ folder,
// a prompts/ tree of tiny templates, personas/, a projects/ folder with an
// active sprint, and an agents/ folder for session inboxes. Each test gets its
// own; `env` points every command at it (and disables acli).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const run = promisify(execFile);
export const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
export const ASSIGNMENT_ID = '11111111-1111-4111-8111-111111111111';
export const SELF_HEALING_ENGINE = 'aaaaaaaa-0000-4000-8000-000000000001';
export const TEST_ENGINE = 'aaaaaaaa-0000-4000-8000-000000000002';
export const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A harness-status at `state` of the example-development engine.
export const hs = state => ({ state, 'state-engine': 'example-development' });

// An id-less forge entry of a variation's `merge-request` array (ASS-321): a
// forge merge request matching no planned branch, as ticket/sync.sh appends
// one — the forge's own fields alone, no `id` and no `repository`, the shape
// every reader of the array must skip. `fields` overrides or adds any of them
// (status: 'Closed'; repository: null for an explicit null).
export const idless = (fields = {}) => ({ key: '!3296', url: 'https://gitlab.com/g/other/-/merge_requests/3296', 'build-status': null, status: 'Open', branch: 'feat/x', ...fields });
const change = (from, to, log = []) => ({ 'state-engine': 'example-development', 'from-state': from, 'to-state': to, timestamp: '2026-10-07T20:00:00Z', 'agent-dispatch-log': log, 'work-is-done': false });

const write = (file, content) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 4));
};

export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hf-'));
  const at = (name, ...rest) => join(dir, name, ...rest);
  const record = (name, rest) => ({
    'process-id': null, 'session-id': null, model: 'claude-opus-5', 'start-time': '2026-10-07T23:52:05Z', 'last-heartbeat': '2026-10-07T23:52:05Z',
    'agent-name': name, project: 'p', 'work-item': 'ABC-3', variation: 'A', 'state-engine': 'example-development', state: 'generate-solution', prompt: 'generate-solution',
    status: 'Running', 'is-lead': false, 'assignment-id': ASSIGNMENT_ID, 'agent-count': 2, 'pen-holder': 'Daredevil', approvals: {},
    'ai-feedback-short': null, 'ai-feedback-long': null, 'working-in-dev-container': true, 'ai-status-update-short': null, 'last-ai-status-update': null, ...rest,
  });
  write(at('assignments.json'), {
    status: 'Running',
    assignments: [
      record('Daredevil', { 'is-lead': true, 'process-id': process.pid }),
      record('Spock', {}),
      record('Leia', { 'work-item': undefined, variation: undefined, 'transient-state-engine': SELF_HEALING_ENGINE, 'state-engine': 'self-healing', state: 'analyze', prompt: 'find-existing-ticket', problem: 'the build is red', 'assignment-id': '22222222-2222-4222-8222-222222222222', 'agent-count': 1, 'pen-holder': 'Leia', 'is-lead': true, 'start-time': '2026-10-08T00:00:00Z' }),
    ],
    'transient-state-engines': [
      { id: SELF_HEALING_ENGINE, project: 'p', 'state-engine': 'self-healing', state: 'analyze', 'start-time': '2026-10-08T00:00:00Z', 'last-heartbeat': '2026-10-08T00:00:00Z', parent: { trigger: 'self-healing' }, 'is-done': false, 'structured-output': null },
      { id: TEST_ENGINE, project: 'p', 'state-engine': 'test', state: 'test', 'start-time': '2026-10-08T00:00:00Z', 'last-heartbeat': '2026-10-08T00:00:00Z', parent: { 'work-item': 'ABC-3', variation: 'B', 'state-engine': 'example-development', state: 'local-testing' }, 'is-done': false, 'structured-output': null },
    ],
    'self-healing': null,
    pauses: {},
  });
  write(at('harness.json'), {
    'agentic-command-line-interfaces': [
      { name: 'claude', models: ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8'] },
      { name: 'codex', models: ['gpt-6-astra'] },
    ],
    'max-agents': null,
  });
  write(at('last-model-used'), 'claude-opus-5');
  // Each name with when it was last used: Hulk, Thor and Yoda in that order, so they are handed out so; the rest never.
  write(at('agent-names.json'), [['Daredevil', 'Marvel'], ['Spock', 'Star Trek'], ['Leia', 'Star Wars'], ['Hulk', 'Marvel'], ['Thor', 'Marvel'], ['Yoda', 'Star Wars']].map(([name, franchise]) => ({ name, 'franchise-name': franchise })));
  write(at('agent-names-last-used.json'), { Hulk: '2026-10-01T00:00:00Z', Thor: '2026-10-02T00:00:00Z', Yoda: '2026-10-03T00:00:00Z' });

  write(at('engines', 'example-development', 'state-engine.json'), {
    'receive-dispatch-prompt': 'receive-dispatch', 'receive-pair-dispatch-prompt': 'receive-pair-dispatch', 'receive-message-prompt': 'receive-message-from-another-agent',
    'ask-for-status-update-prompt': 'ask-for-status-update', 'shut-down-prompt': 'shut-down',
    'check-health-steps': [{ id: 'check-health', sequence: 1, 'is-done': null, action: { type: 'state-engine', engine: 'check-health' } }, { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } }],
    steps: [
      { id: 'generate-solution', sequence: 1, 'is-done': null, action: { type: 'prompt', prompt: 'generate-solution', 'agent-count': 2, 'run-in-dev-container': true } },
      { id: 'local-testing', sequence: 2, 'is-done': null, action: { type: 'state-engine', engine: 'test' } },
      { id: 'done', sequence: 3, 'is-done': true, action: { type: 'none' } },
    ],
  });
  // No *-prompt keys: commands fall back to the project's execution engine's.
  write(at('engines', 'self-healing', 'state-engine.json'), { steps: [{ id: 'analyze', sequence: 1, 'is-done': null, action: { type: 'prompt', prompt: 'find-existing-ticket', 'agent-count': 1 } }, { id: 'apply-fix', sequence: 2, 'is-done': null, action: { type: 'prompt', prompt: 'apply-fix', 'agent-count': 1 } }, { id: 'done', sequence: 3, 'is-done': true, action: { type: 'none' } }] });
  write(at('engines', 'test', 'state-engine.json'), { steps: [{ id: 'test', sequence: 1, 'is-done': null, action: { type: 'prompt', prompt: 'test', 'agent-count': 1 } }, { id: 'take-screenshots', sequence: 2, 'is-done': null, action: { type: 'prompt', prompt: 'take-screenshots', 'agent-count': 1 } }, { id: 'done', sequence: 3, 'is-done': true, action: { type: 'none' } }] });

  write(at('prompts', 'receive-dispatch', 'prompt.txt'), 'LEAD update: {status-update-command} approve: {approve-command}\n{assignment}\n');
  write(at('prompts', 'receive-pair-dispatch', 'prompt.txt'), 'PAIR with {agent-names}; pen {pen-holder}; send: {send-message-command}; approve: {approve-command}; update: {status-update-command}\n{assignment}\n');
  write(at('prompts', 'receive-message-from-another-agent', 'prompt.txt'), 'FROM {agent-name}; reply: {reply-command}; approve: {approve-command}\n{message}\n');
  write(at('prompts', 'ask-for-status-update', 'prompt.txt'), '{minutes} minutes; update: {status-update-command}; approve: {approve-command}\n');
  write(at('prompts', 'shut-down', 'prompt.txt'), 'STOP NOW\n');
  write(at('prompts', 'generate-solution', 'prompt.txt'), 'Build {ticket} variation {variation} of {project} in {ticket-folder} with {agent-sh}. Keep {assignment} literal.\n');
  write(at('prompts', 'generate-solution', 'prompt.json'), { persona: 'developer', 'input-arguments': [{ name: 'ticket' }], output: '' });
  write(at('prompts', 'find-existing-ticket', 'prompt.txt'), 'Find a ticket in {project} for: {problem}\n');
  write(at('prompts', 'find-existing-ticket', 'prompt.json'), { persona: 'nobody', 'input-arguments': [{ name: 'project' }, { name: 'problem' }], output: {} });
  write(at('prompts', 'apply-fix', 'prompt.txt'), 'Fix {ticket}\n');
  write(at('personas', 'developer.md'), 'You are a developer.\n');

  write(at('projects', 'p', 'project.json'), { name: 'P', 'execution-state-engine': 'example-development', 'work-sources': [{ name: 'Jira', type: 'jira', url: 'https://x.atlassian.net/jira/software/c/projects/ABC/boards/1' }] });
  write(at('projects', 'p', 'sprints.json'), { list: [{ number: 10, 'is-active': true }] });
  write(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), {
    number: 10, bugs: [], spikes: [],
    features: [{
      key: 'ABC-3', 'ticket-system-status': 'In Progress',
      variations: [
        { name: 'A', 'harness-status': hs('generate-solution'), 'acceptance-criteria': [], 'state-changes': [change('backlog', 'enrich-ac', [{ 'dispatched-to': 'Thor', timestamp: '2026-10-07T19:00:00Z', 'completed-timestamp': '2026-10-07T19:30:00Z', 'cost-usd': 1, tokens: null }]), change('enrich-ac', 'generate-solution', [{ 'dispatched-to': 'Daredevil', timestamp: '2026-10-07T23:52:05Z', 'completed-timestamp': null, 'cost-usd': null, tokens: null }, { 'dispatched-to': 'Spock', timestamp: '2026-10-07T23:52:05Z', 'completed-timestamp': null, 'cost-usd': null, tokens: null }])] },
        { name: 'B', 'harness-status': { ...hs('local-testing'), 'sub-status': { state: 'test', 'state-engine': 'test' } }, 'state-changes': [change('generate-solution', 'local-testing')] },
        { name: 'C', 'harness-status': hs('local-testing') },
        { name: 'D', 'harness-status': hs('generate-solution'), 'is-deleted': true },
      ],
    }],
  });
  write(at('projects', 'q', 'project.json'), { name: 'Q', 'execution-state-engine': 'example-development', 'work-sources': [{ name: 'Local', type: 'off-board' }] });
  write(at('projects', 'q', 'sprints.json'), { list: [{ number: 1, 'is-active': true }] });
  write(at('projects', 'q', 'sprints', 'sprint-1', 'sprint.json'), { number: 1, features: [{ key: 'Q-1', variations: [{ name: 'A', 'harness-status': hs('backlog') }] }] });
  mkdirSync(at('agents'), { recursive: true });

  const env = {
    ...process.env,
    ASSIGNMENTS_FILE: at('assignments.json'), HARNESS_FILE: at('harness.json'), LAST_MODEL_USED_FILE: at('last-model-used'), AGENT_NAMES_FILE: at('agent-names.json'), AGENT_NAMES_LAST_USED_FILE: at('agent-names-last-used.json'),
    ENGINES_DIR: at('engines'), PROMPTS_DIR: at('prompts'), PERSONAS_DIR: at('personas'), PROJECTS_DIR: at('projects'), AGENTS_DIR: at('agents'),
    ACLI_DISABLED: '1', CLAUDE_USAGE_DISABLED: '1',
    // Control's API cost check never reads the admin key or calls the Cost Admin API; its file is the fixture's (ASS-153).
    ANTHROPIC_API_COST_DISABLED: '1', API_COST_FILE: at('api-cost.json'),
    // Control's push-account check never reads a forge token or calls a forge (ASS-307).
    PUSH_ACCOUNT_DISABLED: '1',
    // The learned context-window cache (ASS-190): harness:set-context-window writes here, not the real data folder.
    CONTEXT_WINDOWS_FILE: at('context-windows.json'),
    // Control's disk watch (ASS-288) is off, so a test's control never reads the real disk with df; its record is the fixture's.
    DISK_SPACE_DISABLED: '1', DISK_SPACE_FILE: at('disk-space.json'),
    // memory:up finds no Hindsight installed and no Python to install one, so a test's control never starts the real one (ASS-62).
    HINDSIGHT_DIR: at('hindsight-install'), HINDSIGHT_PYTHON: 'false',
  };
  const json = (...path) => JSON.parse(readFileSync(at(...path), 'utf8'));
  return {
    dir, env,
    agent: (...args) => run(AGENT, args, { env }),
    assignments: () => json('assignments.json'),
    harness: () => json('harness.json'),
    lastModelUsed: () => readFileSync(at('last-model-used'), 'utf8'),
    sprint: () => json('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'),
    variation: name => json('projects', 'p', 'sprints', 'sprint-10', 'sprint.json').features[0].variations.find(v => v.name === name),
    // Every file a command may write, as text, to show a failed one wrote nothing.
    snapshot: () => ['assignments.json', 'harness.json', 'last-model-used', join('projects', 'p', 'sprints', 'sprint-10', 'sprint.json')].map(f => readFileSync(at(f), 'utf8')).join('\n---\n'),
    // The prompts queued in an agent's session inbox (its folder named from its start-time), [] when none.
    inbox: (name, stamp = '20261007T235205Z') => {
      const file = at('agents', `${name}-${stamp}`, 'inbox.jsonl');
      return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l).prompt) : [];
    },
  };
}
