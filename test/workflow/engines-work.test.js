// ASS-258: every engine under engines/ works — whatever its steps say and
// however many it has. Engine and prompt files are designed to change, so
// nothing here pins what they contain: each engine loads and passes the
// harness's own validator (src/workflow/validate.js); every step, sub-engine
// and prompt it names exists; and no step can strand a ticket — from each one
// a way out is reachable, and every place a sub-engine can end is handled by
// the step that runs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { ROOT, loadEngines, EXAMPLE_ENGINES } from '../support/engine-walk.js';

const engines = loadEngines();
// Every list of steps an engine holds: `steps` and each top-level `*-steps` / `*-trigger`.
const listsOf = engine => Object.entries(engine).filter(([key, list]) => Array.isArray(list) && (key === 'steps' || /-(steps|trigger)$/.test(key)));
const stepsOf = engine => listsOf(engine).flatMap(([, list]) => list);
const exitsOf = step => step['exit-events'] ?? [];
const leaves = (condition, out = []) => {
  const [[key, value]] = Object.entries(condition);
  if (key === 'all') value.forEach(c => leaves(c, out));
  else if (key === 'not') leaves(value, out);
  else out.push([key, value]);
  return out;
};
// A step that rests for good by design, its ticket going nowhere after it — the reason why.
const RESTS_FOR_GOOD = {
  'harness-backlog-refinement/superseded': 'the original of an accepted split: replaced by the new tickets, it never goes on to Ready',
  'example-github-backlog-refinement/superseded': 'ASS-265: the original of a split the operator chose at Too Large and accepted, as the harness\'s',
};

test('every folder under engines/ holds a state engine that loads', () => {
  const folders = readdirSync(join(ROOT, 'engines')).filter(d => statSync(join(ROOT, 'engines', d)).isDirectory());
  assert.ok(folders.length > 0);
  for (const name of folders) {
    const file = join(ROOT, 'engines', name, 'state-engine.json');
    assert.ok(existsSync(file), `${name}: no state-engine.json`);
    const engine = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(engine.steps) && engine.steps.length > 0, `${name}: no steps`);
  }
});

for (const [name, engine] of Object.entries(engines)) {
  test(`engines/${name} passes the harness's validator`, () => {
    assert.deepEqual(validateStateEngine(engine, ROOT, name, EXAMPLE_ENGINES), []);   // named: its steps' repositories are its projects' (ASS-119)
  });

  test(`engines/${name}: every step, sub-engine and prompt it names exists`, () => {
    const ids = new Set(stepsOf(engine).map(s => s.id));
    const prompt = (p, at) => {
      for (const file of ['prompt.txt', 'prompt.json']) assert.ok(existsSync(join(ROOT, 'prompts', p, file)), `${at}: prompt "${p}" has no ${file}`);
      const json = JSON.parse(readFileSync(join(ROOT, 'prompts', p, 'prompt.json'), 'utf8'));
      if (json.persona) assert.ok(existsSync(join(ROOT, 'personas', `${json.persona}.md`)), `${at}: prompt "${p}"'s persona "${json.persona}" does not exist`);
    };
    if (engine['ready-tickets-join-sprint-at'] !== undefined) assert.ok(ids.has(engine['ready-tickets-join-sprint-at']), 'ready-tickets-join-sprint-at');
    // The prompts an engine names for its agents' messages (receive-dispatch-prompt and the like).
    for (const [key, value] of Object.entries(engine)) if (key.endsWith('-prompt')) prompt(value, key);
    for (const step of stepsOf(engine)) {
      const at = `step "${step.id}"`, action = step.action ?? {};
      for (const key of ['on-max-visits', 'return-to-state']) if (step[key] !== undefined) assert.ok(ids.has(step[key]), `${at} ${key} "${step[key]}"`);
      if (action.type === 'prompt') prompt(action.prompt, at);
      const sub = action.type === 'state-engine' ? engines[action.engine] : undefined;
      if (action.type === 'state-engine') assert.ok(sub, `${at} runs engine "${action.engine}", which does not exist`);
      for (const exit of exitsOf(step)) {
        if (exit['move-to-state'] !== undefined) assert.ok(ids.has(exit['move-to-state']), `${at} moves to "${exit['move-to-state']}"`);
        const target = exit['move-to-state'] && stepsOf(engine).find(s => s.id === exit['move-to-state']);
        if (exit['start-sub-engine-at'] !== undefined) {
          const into = engines[target?.action?.engine];
          assert.ok(into && stepsOf(into).some(s => s.id === exit['start-sub-engine-at']), `${at} starts "${exit['move-to-state']}"'s sub-engine at "${exit['start-sub-engine-at']}"`);
        }
        for (const [key, value] of leaves(exit.condition))
          if (key === 'sub-engine-ended-at') assert.ok(sub && stepsOf(sub).some(s => s.id === value && s['is-done']), `${at} reads that its sub-engine ended at "${value}", not one of its done steps`);
      }
    }
  });

  test(`engines/${name}: no step strands a ticket — each has a way out, and every end of a sub-engine it runs is handled`, () => {
    for (const [key, list] of listsOf(engine)) {
      // A way out: a done step; the end of the run (an exit naming no step — a side list's run, over);
      // handing back where the ticket came from (follow-return-to-state); or a step resting for good by design.
      const out = new Set(list.filter(s => s['is-done'] || RESTS_FOR_GOOD[`${name}/${s.id}`]
        || exitsOf(s).some(x => x['move-to-state'] === undefined && !x['move-to-state-from-structured-output'] && !x['move-to-state-from-human-review'])
        || exitsOf(s).some(x => x['follow-return-to-state'] || x['follow-return-to'])).map(s => s.id));
      const next = s => [...exitsOf(s).map(x => x['move-to-state']), s['on-max-visits']].filter(Boolean);
      for (let grew = true; grew;) {
        grew = false;
        for (const s of list) if (!out.has(s.id) && next(s).some(t => out.has(t))) { out.add(s.id); grew = true; }
      }
      for (const s of list) {
        const at = `${key}: step "${s.id}"`;
        assert.ok(s['is-done'] || RESTS_FOR_GOOD[`${name}/${s.id}`] || exitsOf(s).length > 0, `${at} has no exit and is no done step`);
        assert.ok(out.has(s.id), `${at} reaches no done step, end of its run or hand-back`);
        if (s.action?.type !== 'state-engine') continue;
        // Its sub-engine's run rests at one of its done steps; the step must have an exit for each — one reading
        // is-done without naming where it ended, or one naming that step (sub-engine-ended-at).
        for (const end of engines[s.action.engine].steps.filter(x => x['is-done'])) {
          const handled = exitsOf(s).some(x => {
            const ls = leaves(x.condition);
            const ended = ls.filter(([k]) => k === 'sub-engine-ended-at').map(([, v]) => v);
            return ended.length ? ended.includes(end.id) : ls.some(([k, v]) => ['is-done', 'workflow-ended'].includes(k) && v === true);
          });
          assert.ok(handled, `${at}: its sub-engine "${s.action.engine}" can end at "${end.id}", which no exit of it handles`);
        }
      }
    }
  });
}

// ASS-277: a project's own engines (data/projects/<project>/engines, ASS-276) —
// kept on the operator's disk, never tracked — pass the validator as that
// project's, its own found before engines/, as control and the dashboard read them.
const PROJECTS = join(ROOT, 'data', 'projects');
for (const id of existsSync(PROJECTS) ? readdirSync(PROJECTS).toSorted() : []) {
  const own = join(PROJECTS, id, 'engines');
  if (!existsSync(own)) continue;
  for (const [name, engine] of Object.entries(loadEngines(ROOT, own)).filter(([n]) => existsSync(join(own, n, 'state-engine.json'))))
    test(`data/projects/${id}/engines/${name} passes the harness's validator as ${id}'s own`, () => {
      assert.deepEqual(validateStateEngine(engine, ROOT, name, own), []);
    });
}
