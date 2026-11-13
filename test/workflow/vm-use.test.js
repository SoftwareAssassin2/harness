// ASS-418 AC2: a ticket's VM runs only while a step works in it. Every step of
// every grouped engine — every engine a grouped top-level engine
// (harness-development-grouped, harness-development-v2, the example
// project's example-development-grouped and example-github-development) runs
// beneath it, shared ones included — is
// listed with whether it needs the VM and the `vm` it runs under (its own, else
// the parent step's that runs its engine, as control's vmUse reads the deepest
// that sets one). A step that does not need the VM and leaves it running fails,
// so a step added later without a setting under a running group (Build, Plan…)
// is caught. A step needs the VM when:
// - it runs in it (run-location: vm, vm.js runsInVm);
// - its command does: its agent.sh command's script reaches the VM (limactl,
//   a vm: command, code.bash's in_project, vm.bash's vm_of / running_vm), or
//   re-runs a check that may (REACHES_VM_INDIRECTLY);
// - an exit condition's script does (vm:setup-complete probes the VM);
// - it is a pass-through: a host script or none step with no timer and no
//   person, which finishes at once, whose every way on within its engine (the
//   engine's own done steps aside) is a step that needs the VM — stopping the
//   VM there would only start it again seconds later.
// Everything else — forge polls, timers, waits, human steps, host agents —
// leaves it stopped. A group's done steps (passed through as the group's run
// ends) and state-engine steps (their sub-engine's step decides) are not judged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runsInVm } from '../../src/control/vm.js';
import { loadEngines, ROOT } from '../support/engine-walk.js';

const engines = loadEngines();
const TOPS = ['harness-development-grouped', 'example-development-grouped', 'harness-development-v2', 'example-github-development'];
// Commands whose script names no VM yet may reach it: ticket:recheck-block
// re-runs the check the ticket was blocked at, which may be a VM one
// (automated-tests:verify-success, run in the VM through in_project).
const REACHES_VM_INDIRECTLY = new Set(['ticket:recheck-block']);
const VM_MARKS = /\blimactl\b|\bin_project\b|\bvm_of\b|\brunning_vm\b|\bvm:(create|start|mark-setup-complete|setup-complete|refresh-repositories|image-recheck)\b/;

// commandReachesVm(command) — `./agent.sh <family>:<name> …`'s script reaches the VM.
function commandReachesVm(command) {
  const name = command?.match(/^\.\/agent\.sh (\S+)/)?.[1];
  if (!name) return false;
  if (REACHES_VM_INDIRECTLY.has(name)) return true;
  const file = join(ROOT, 'src', 'agent-cli', `${name.replace(':', '/')}.sh`);
  assert.ok(existsSync(file), `no script for ${name}`);
  return VM_MARKS.test(readFileSync(file, 'utf8'));
}

const conditionScripts = c => (c == null || typeof c !== 'object' ? [] : Object.entries(c).flatMap(([k, v]) => (k === 'script-succeeds' ? [v] : Array.isArray(v) ? v.flatMap(conditionScripts) : conditionScripts(v))));
const instant = s => (s.action?.type === 'script' && s.action.mode !== 'timer') || s.action?.type === 'none';

// needsVm(engine, step) — why the step needs the VM, or null.
function needsVm(engine, step, seen = new Set()) {
  if (runsInVm(step)) return 'runs in the VM';
  if (step.action?.type === 'script' && commandReachesVm(step.action.command)) return 'its command reaches the VM';
  if ((step['exit-events'] ?? []).flatMap(e => conditionScripts(e.condition)).some(commandReachesVm)) return 'an exit condition probes the VM';
  if (!instant(step) || seen.has(step.id)) return null;
  seen.add(step.id);
  const next = [...new Set((step['exit-events'] ?? []).map(e => e['move-to-state']))].map(id => engine.steps.find(s => s.id === id)).filter(s => s && !s['is-done']);
  return next.length && next.every(s => needsVm(engine, s, seen)) ? 'passes straight on to a step that needs it' : null;
}

// contexts() — every [engine name, inherited vm] a grouped top-level engine
// reaches, the inherited vm the deepest parent step's that sets one.
function contexts() {
  const out = [], walk = (name, inherited, path) => {
    out.push([name, inherited, path]);
    for (const s of engines[name].steps) if (s.action?.type === 'state-engine' && !path.includes(s.action.engine)) walk(s.action.engine, s.vm ?? inherited, [...path, s.action.engine]);
  };
  for (const top of TOPS) walk(top, undefined, [top]);
  return out;
}

test('ASS-418 AC2: every step of every grouped engine that leaves its VM running needs it — runs in it, its command or an exit condition reaches it, or it passes straight on to one that does', () => {
  const listing = [], wrong = [];
  for (const [name, inherited, path] of contexts()) for (const step of engines[name].steps) {
    if (step['is-done'] || step.action?.type === 'state-engine') continue;
    const vm = step.vm ?? inherited, why = needsVm(engines[name], step);
    listing.push(`${path.join(' > ')} / ${step.id}: ${why ?? 'needs no VM'}; vm ${vm ?? '(none)'}`);
    if (vm === 'running' && !why) wrong.push(`${path.join(' > ')} / ${step.id} (${step.name}) leaves the VM running and needs none: set "vm": "stopped"`);
  }
  assert.ok(listing.length > 100, listing.join('\n'));
  assert.deepEqual(wrong, [], listing.join('\n'));
});

test('ASS-418 AC2: the check catches a step added later without a vm setting under a running group, and the ticket\'s examples are judged as it says', () => {
  const build = engines['grouped-build'];
  const added = { id: 'await-something', name: 'Await Something', action: { type: 'script', command: './agent.sh merge-request:check {project} {ticket} {variation}', mode: 'timer', 'timer-minutes': 5 }, 'exit-events': [] };
  assert.equal(needsVm(build, added), null);
  assert.equal(added.vm ?? engines['harness-development-grouped'].steps.find(s => s.id === 'build').vm, 'running');   // so it would be flagged
  const of = (engine, id) => engines[engine].steps.find(s => s.id === id);
  for (const [engine, id] of [['grouped-build', 'await-dependencies'], ['grouped-merge', 'check'], ['grouped-merge', 'check-review'], ['grouped-blocked', 'await-fix'],
    ['grouped-blocked', 'await-rate-limit'], ['grouped-blocked', 'wait-on-fix-merge-request'], ['grouped-blocked', 'await-fix-merge-request'], ['grouped-plan', 'awaiting-plan-answer'],
    ['grouped-review', 'payment-gate'], ['grouped-review', 'variation-selection'], ['grouped-release-example', 'team-code-review']]) {
    assert.equal(needsVm(engines[engine], of(engine, id)), null, `${engine}/${id}`);
  }
  for (const [engine, id] of [['grouped-build', 'generate-solution'], ['grouped-build', 'automated-testing'], ['grouped-build', 'check-numbered-files'], ['grouped-build', 'refresh-repositories'],
    ['grouped-merge', 'address-merge-request-feedback'], ['grouped-blocked', 'troubleshoot'], ['grouped-blocked', 'repair-environment'], ['grouped-blocked', 'repair-project'], ['grouped-blocked', 'check-first'],
    ['grouped-blocked', 'find-where'], ['grouped-setup', 'check-setup-complete'], ['grouped-setup', 'mark-setup-complete']]) {
    assert.ok(needsVm(engines[engine], of(engine, id)), `${engine}/${id}`);
  }
});
