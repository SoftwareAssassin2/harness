// ticket:raise-bug — the one way the harness raises a bug in a Jira project
// (ASS-164): created in the board's active sprint at the project's bug
// priority, assigned to the signed-in user, moved to To Do, every step read
// back from the ticket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

// A stateful fake acli on PATH: create (--from-json) makes ABC-7 at Backlog,
// assigned to the project's default assignee; edit --assignee @me assigns it
// to "me"; transition sets its status; list-sprints prints the active sprint
// (FAKE_SPRINTS); view prints the ticket in the REST shape; search answers
// `assignee = currentUser()`. FAKE_FAIL=<subcommand> makes that one fail;
// FAKE_PRIORITIES lists the priorities the scheme takes (default: any);
// FAKE_IGNORE=<subcommand> makes it succeed without doing anything;
// FAKE_DROP=1 makes create take the ticket but drop its sprint and priority.
function setup(project = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'raise-bug-'));
  const bin = join(dir, 'bin'), state = join(dir, 'state'), log = join(dir, 'acli.log');
  mkdirSync(bin);
  mkdirSync(state);
  mkdirSync(join(dir, 'projects', 'p'), { recursive: true });
  writeFileSync(join(dir, 'projects', 'p', 'project.json'), JSON.stringify({
    'work-sources': [{ type: 'jira', url: 'https://x.atlassian.net/jira/software/c/projects/ABC/boards/42' }], ...project }));
  writeFileSync(join(bin, 'acli'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${log}'
s='${state}'
sub="$2 $3"; [[ "$2" == workitem ]] && sub="$3"
[[ "\${FAKE_FAIL:-}" == "$sub" ]] && { echo "acli: $sub refused" >&2; exit 1; }
[[ "\${FAKE_IGNORE:-}" == "$sub" ]] && { echo "done"; exit 0; }
arg() { local want="$1"; shift; while [[ $# -gt 0 ]]; do [[ "$1" == "$want" ]] && { echo "$2"; return; }; shift; done; }
case "$sub" in
  create)
    f="$(arg --from-json "$@")"; jq -c . "$f" >> '${log}'
    p="$(jq -r '.additionalAttributes.priority.name // empty' "$f")"
    if [[ -n "$p" && -n "\${FAKE_PRIORITIES:-}" && ",$FAKE_PRIORITIES," != *",$p,"* ]]; then echo "Error: priority: Specify a valid priority" >&2; exit 1; fi
    jq "if env.FAKE_DROP then .additionalAttributes = {} else . end" "$f" | jq '{ fields: { assignee: { displayName: "Default" }, status: { name: "Backlog" },
          priority: { name: (.additionalAttributes.priority.name // "Medium") },
          customfield_10020: (if .additionalAttributes.customfield_10020 then [{ id: .additionalAttributes.customfield_10020 }] else null end),
          customfield_10021: (if .additionalAttributes.customfield_10021 then [{ id: .additionalAttributes.customfield_10021 }] else null end) } }' > "$s/ABC-7.json"
    echo "✓ Work item ABC-7 created: https://x.atlassian.net/browse/ABC-7" ;;
  edit)
    [[ "$(arg --assignee "$@")" == @me ]] && jq '.fields.assignee = { displayName: "Me" }' "$s/$(arg --key "$@").json" > "$s/t" && mv "$s/t" "$s/$(arg --key "$@").json"
    echo "✓ edited" ;;
  transition)
    jq --arg st "$(arg --status "$@")" '.fields.status = { name: $st }' "$s/$(arg --key "$@").json" > "$s/t" && mv "$s/t" "$s/$(arg --key "$@").json"
    echo "✓ transitioned" ;;
  "board list-sprints")
    active='{"sprints":[{"id":901,"name":"Sprint 9","state":"active"}]}'; echo "\${FAKE_SPRINTS-$active}" ;;
  view)
    jq --arg k "$4" '{ key: $k } + .' "$s/$4.json" ;;
  search)
    k="$(arg --jql "$@" | sed -E 's/^key = ([A-Z0-9-]+).*/\\1/')"
    jq -c --arg k "$k" 'if .fields.assignee.displayName == "Me" then [{ key: $k }] else [] end' "$s/$k.json" ;;
esac
`);
  chmodSync(join(bin, 'acli'), 0o755);
  const adf = join(dir, 'f.json');
  writeFileSync(adf, JSON.stringify({ type: 'doc', version: 1, content: [] }));
  const env = { ...process.env, PROJECTS_DIR: join(dir, 'projects'), ACLI_DISABLED: '', PATH: `${bin}:${process.env.PATH}` };
  return {
    dir, adf,
    raise: (args = ['p', 'Login fails', adf], extra = {}) => run(AGENT, ['ticket:raise-bug', ...args], { env: { ...env, ...extra } }),
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '').trim().split('\n').filter(Boolean),
    ticket: () => JSON.parse(readFileSync(join(state, 'ABC-7.json'), 'utf8')).fields,
  };
}
const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));

test('AC1: ticket:raise-bug creates the bug in the board\'s active sprint, assigns it by an edit, moves it to To Do, and prints its key', async () => {
  const a = setup();
  const { stdout } = await a.raise();
  assert.deepEqual(JSON.parse(stdout), { key: 'ABC-7', priority: null });
  const created = JSON.parse(a.calls().find(l => l.startsWith('{')));
  assert.deepEqual(created, { projectKey: 'ABC', type: 'Bug', summary: 'Login fails', description: { type: 'doc', version: 1, content: [] },
    additionalAttributes: { customfield_10020: 901 } });
  assert.equal(created.assignee, undefined, 'acli ignores "assignee" in --from-json: an edit assigns it');
  const calls = a.calls().filter(l => !l.startsWith('{'));
  assert.match(calls[0], /^jira board list-sprints --id 42 --state active --json$/);
  assert.match(calls[1], /^jira workitem create --from-json \S+$/);
  assert.match(calls[2], /^jira workitem edit --key ABC-7 --assignee @me --yes$/);
  assert.match(calls[3], /^jira workitem transition --key ABC-7 --status To Do --yes$/);
  const t = a.ticket();
  assert.deepEqual([t.assignee.displayName, t.status.name, t.customfield_10020[0].id], ['Me', 'To Do', 901]);
});

test('AC1/AC2: the sprint field comes from the jira work source (sprint-field) and the priority from project.json\'s raised-bug-priority', async () => {
  const a = setup({ 'raised-bug-priority': 'Critical', 'work-sources': [{ type: 'jira', url: 'https://x.atlassian.net/jira/software/projects/ABC/boards/42', 'sprint-field': 'customfield_10021' }] });
  const { stdout } = await a.raise(['p', 'Login fails', a.adf, 'Story']);
  assert.deepEqual(JSON.parse(stdout), { key: 'ABC-7', priority: 'Critical' });
  const created = JSON.parse(a.calls().find(l => l.startsWith('{')));
  assert.deepEqual([created.type, created.additionalAttributes], ['Story', { customfield_10021: 901, priority: { name: 'Critical' } }]);
  assert.match(a.calls().find(l => l.includes('workitem view')), /--fields status,priority,customfield_10021 --json/);
  assert.equal(a.ticket().priority.name, 'Critical');
});

test('AC2: a priority the scheme refuses falls back to the scheme\'s default, logged', async () => {
  const a = setup({ 'raised-bug-priority': 'Blocker' });
  const { stdout, stderr } = await a.raise(undefined, { FAKE_PRIORITIES: 'Critical,Medium' });
  assert.deepEqual(JSON.parse(stdout), { key: 'ABC-7', priority: null });
  assert.match(stderr, /p's scheme refused priority Blocker \(.*Specify a valid priority.*\); raising at the scheme's default/);
  const creates = a.calls().filter(l => l.startsWith('{')).map(l => JSON.parse(l).additionalAttributes);
  assert.deepEqual(creates, [{ customfield_10020: 901, priority: { name: 'Blocker' } }, { customfield_10020: 901 }]);
  assert.equal(a.ticket().priority.name, 'Medium');
});

test('AC3: a step that did not take fails the command, naming the key and what is still unset; the key still printed', async () => {
  for (const [extra, unset] of [
    [{ FAKE_FAIL: 'edit' }, /ABC-7 was raised but is still unset: assignee \(not the signed-in user\)$/m],
    [{ FAKE_IGNORE: 'edit' }, /ABC-7 was raised but is still unset: assignee/],
    [{ FAKE_FAIL: 'transition' }, /ABC-7 was raised but is still unset: status \(To Do\)$/m],
    [{ FAKE_IGNORE: 'transition' }, /ABC-7 was raised but is still unset: status \(To Do\)$/m],
    [{ FAKE_SPRINTS: '{"sprints":[]}' }, /ABC-7 was raised but is still unset: sprint \(no active sprint on board 42\)$/m],
    [{ FAKE_FAIL: 'board list-sprints', FAKE_IGNORE: 'edit' }, /ABC-7 was raised but is still unset: assignee \(not the signed-in user\), sprint \(no active sprint on board 42\)$/m],
  ]) {
    const a = setup();
    await assert.rejects(a.raise(undefined, extra), e => unset.test(e.stderr) && JSON.parse(e.stdout).key === 'ABC-7', JSON.stringify(extra));
  }
  // A sprint and a priority acli took but the ticket does not show.
  const a = setup({ 'raised-bug-priority': 'Critical' });
  await assert.rejects(a.raise(undefined, { FAKE_DROP: '1' }), e => /ABC-7 was raised but is still unset: sprint \(customfield_10020 901\), priority \(Critical\)$/m.test(e.stderr));
});

test('ticket:raise-bug fails, raising nothing, on a failed create, a project without a Jira board, or bad usage', async () => {
  const a = setup();
  await fails(a.raise(undefined, { FAKE_FAIL: 'create' }), /acli created no ticket in ABC: acli: create refused/);
  await fails(a.raise(['p', 'x', join(a.dir, 'missing.json')]), /no file/);
  await fails(a.raise(['p', 'x', a.adf, 'Epic']), /Bug or Story/);
  await fails(a.raise(['p', 'x']), /usage/);
  await fails(a.raise(['../p', 'x', a.adf]), /invalid project/);
  mkdirSync(join(a.dir, 'projects', 'q'));
  writeFileSync(join(a.dir, 'projects', 'q', 'project.json'), JSON.stringify({ 'work-sources': [{ type: 'off-board' }] }));
  await fails(a.raise(['q', 'x', a.adf]), /q has no jira work source/);
  assert.equal(a.calls().filter(l => l.includes('workitem create')).length, 1);
});

// The raising path: the grouped engines' create-ticket copy raises a Jira
// ticket through ticket:raise-bug alone; the flat engines keep create-ticket.
test('the grouped engines raise a Jira ticket through ticket:raise-bug; the flat engines keep create-ticket as it was', () => {
  const ROOT = join(import.meta.dirname, '..', '..');
  const read = path => readFileSync(join(ROOT, path), 'utf8');
  const engine = name => JSON.parse(read(`engines/${name}/state-engine.json`));
  const engineOf = (name, step) => engine(name).steps.find(s => s.id === step).action.engine;
  assert.deepEqual([engineOf('grouped-blocked', 'create-fix-ticket'), engineOf('check-ticket-health-grouped', 'create-ticket')], ['create-ticket-grouped', 'create-ticket-grouped']);
  const prompts = engine('create-ticket-grouped').steps.toSorted((a, b) => a.sequence - b.sequence).map(s => s.action.prompt).filter(Boolean);
  assert.ok(prompts.indexOf('find-existing-ticket') >= 0 && prompts.indexOf('find-existing-ticket') < prompts.indexOf('create-ticket-grouped'), prompts.join(' '));   // ASS-258: other steps may come between
  const grouped = read('prompts/create-ticket-grouped/prompt.txt');
  assert.match(grouped, /\{harness-folder\}\/agent\.sh ticket:raise-bug <name> "<title>" f\.json \[Story\]/);
  assert.doesNotMatch(grouped, /acli jira workitem create/);
  assert.equal(engineOf('blocked', 'create-fix-ticket'), 'create-ticket');
  assert.match(read('prompts/create-ticket/prompt.txt'), /acli jira workitem create --project <key>/);
});
