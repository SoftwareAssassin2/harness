// ticket:fix-resume-step's choice (fix-resume-step.sh), in node to share
// control's reading of an engine (src/control/engine.js returnTo,
// whyNotResume) rather than restate it in jq:
//
//   node fix-resume-step.js < input.json
//
// Input, gathered by the .sh: { project, ticket, variation (the variation's
// JSON), engine (the project's execution engine's name), engineFiles (every
// state-engine.json the project sees, engines/'s first, its own after),
// fix (the key it waits on, or null), declared (the fix ticket's resume-at,
// or null), changed (the files its "<KEY>:" commits changed, repository
// paths), workFolder (data/projects/<project>/work/<ticket>) }.
//
// Prints { resume-at, resume-source, resume-why, resume-ignored } (ASS-343):
// the top-level step the blocked variation resumes at once its fix has
// landed — the fix ticket's own resume-at when it declares one control may
// take (declared); else the earliest step at or before the blocked one that
// what the fix changed maps to (commits: its commits' files; data: files of
// the ticket's work folder changed since the wait began); else the step it
// blocked at (none). A step inside a group is lifted to the group's
// top-level step. resume-ignored lists each step named but not taken, with
// why. Never fails: a missing or unreadable input is no step found.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { returnTo, whyNotResume } from '../../control/engine.js';
import { levelChanges } from '../../control/moves.js';

// Files of the work folder no exit names, mapped to the step that writes them; {variation} filled.
const KNOWN_DATA = [{ file: 'automated-tests-{variation}.json', step: 'generate-automated-tests' }];

// engines(files) — { [name]: its JSON }, each file's folder its name, a later file over an earlier one.
function engines(files = []) {
  const all = {};
  for (const file of files) try { all[basename(dirname(file))] = JSON.parse(readFileSync(file, 'utf8')); } catch { /* unreadable: left out */ }
  return all;
}

// reach(all, top) — for each engine the top engine runs, at any depth, the top-level step ids that run it.
function reach(all, top) {
  const via = new Map();
  const walk = (name, at, seen) => {
    if (seen.has(name)) return;
    seen.add(name);
    via.set(name, [...new Set([...(via.get(name) ?? []), at])]);
    for (const s of all[name]?.steps ?? []) if (s.action?.type === 'state-engine') walk(s.action.engine, at, seen);
  };
  for (const s of all[top]?.steps ?? []) if (s.action?.type === 'state-engine') walk(s.action.engine, s.id, new Set());
  return via;
}

// fileUpdates(condition) — the files a condition's file-updated leaves name, at any depth.
const fileUpdates = c => (c == null || typeof c !== 'object' ? [] : Object.entries(c).flatMap(([k, v]) => (k === 'file-updated' ? [v?.file] : Array.isArray(v) ? v.flatMap(fileUpdates) : fileUpdates(v)))).filter(Boolean);
// ownFile(file, values) — a file-updated file as the variation's own (facts.js ticketFacts): -{variation} before its extension unless it names {variation}; placeholders filled.
const ownFile = (file, values) => (file.includes('{variation}') ? file : file.replace(/(\.[^.]*)?$/, '-{variation}$1')).replace(/\{(variation|ticket|project)\}/g, (_, k) => values[k]);

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// waitBegan(variation) — when the variation entered await-fix (its latest change into it, at any depth), in ms; undefined when its history does not say.
function waitBegan(variation) {
  const into = c => { for (let s = c; s; s = s['sub-state-change']) if (s['to-state'] === 'await-fix') return true; return false; };
  const at = Date.parse((variation?.['state-changes'] ?? []).findLast(into)?.timestamp ?? '');
  return Number.isNaN(at) ? undefined : at;
}

export function fixResumeStep({ project, ticket, variation = {}, engine: name, engineFiles = [], fix = null, declared = null, changed = [], workFolder } = {}) {
  const all = engines(engineFiles), top = all[name] ?? { steps: [] }, via = reach(all, name);
  const back = returnTo('blocked', top, levelChanges(variation));
  const order = id => top.steps.findIndex(s => s.id === id);
  const ignored = [];
  // lift(engineName, stepId) — the top-level steps a step runs under.
  const lift = (engineName, stepId) => (engineName === name ? [stepId] : via.get(engineName) ?? []);
  // Every step of the engines the top one reaches, with its engine's name.
  const everyStep = [name, ...via.keys()].flatMap(e => (all[e]?.steps ?? []).map(step => ({ engine: e, step })));
  const take = (source, candidates) => {
    let best;
    for (const c of candidates) {
      const why = back == null ? 'the step it blocked at cannot be told' : whyNotResume(top, back, c.step);
      if (why) { ignored.push({ step: c.step, source, why }); continue; }
      if (!best || order(c.step) < order(best.step)) best = c;
    }
    return best && { 'resume-at': best.step, 'resume-source': source, 'resume-why': best.why };
  };
  const unique = list => list.filter((x, i) => list.findIndex(y => y.step === x.step && y.source === x.source) === i);
  const result = chosen => ({ ...(chosen ?? { 'resume-at': back, 'resume-source': 'none', 'resume-why': back == null ? 'the step it blocked at cannot be told' : `nothing the fix changed maps to a step at or before ${back}: resumes at the step it blocked at` }), 'resume-ignored': ignored });

  // Declared: the fix ticket's resume-at, a step inside a group lifted to its group.
  if (typeof declared === 'string' && declared !== '') {
    const at = everyStep.filter(({ step }) => step.id === declared);
    const tops = at.some(({ engine }) => engine === name) ? [declared] : [...new Set(at.flatMap(({ engine, step }) => lift(engine, step.id)))];
    const chosen = take('declared', (tops.length ? tops : [declared]).map(step => ({ step, why: `${fix ?? 'the fix ticket'} declares resume-at ${declared}${step === declared ? '' : ` (in ${step})`}` })));
    if (chosen) return result(chosen);
  }

  // Commits: each file the fix's commits changed, mapped to the steps that run it.
  const fromCommits = [];
  for (const file of changed) {
    const prompt = file.match(/^prompts\/([^/]+)\//)?.[1];
    const command = file.match(/^src\/agent-cli\/([^/]+)\/([^/]+)\.(sh|js)$/);
    const sub = file.match(/^engines\/([^/]+)\//)?.[1];
    const runs = everyStep.filter(({ step }) => (prompt && step.action?.prompt === prompt)
      || (command && typeof step.action?.command === 'string' && new RegExp(`agent\\.sh ${escape(`${command[1]}:${command[2]}`)}(\\s|$)`).test(step.action.command)));
    for (const { engine, step } of runs) for (const t of lift(engine, step.id)) fromCommits.push({ step: t, why: `${fix}'s commits change ${file}, which ${engine}/${step.id} runs` });
    if (sub && sub !== name) for (const t of via.get(sub) ?? []) fromCommits.push({ step: t, why: `${fix}'s commits change ${file}, the ${sub} engine ${t} runs` });
  }

  // Data: files of the work folder changed since the wait began, mapped to the step that writes them.
  const fromData = [];
  const began = waitBegan(variation);
  if (began != null && workFolder) {
    const values = { variation: variation.name, ticket, project };
    const writes = [
      ...KNOWN_DATA.flatMap(d => everyStep.filter(({ step }) => step.id === d.step).map(({ engine, step }) => ({ file: ownFile(d.file, values), engine, step }))),
      ...everyStep.flatMap(({ engine, step }) => (step['exit-events'] ?? []).flatMap(e => fileUpdates(e.condition)).map(file => ({ file: ownFile(file, values), engine, step }))),
    ];
    let files = [];
    try { files = readdirSync(workFolder).filter(f => statSync(join(workFolder, f)).mtimeMs > began); } catch { /* no work folder */ }
    for (const file of files) for (const w of writes.filter(w => w.file === file)) for (const t of lift(w.engine, w.step.id))
      fromData.push({ step: t, why: `${file} changed in the work folder since the wait began; ${w.engine}/${w.step.id} writes it` });
  }
  // Derived: the earliest of either; on a tie, the commits' reason.
  const commits = take('commits', fromCommits), data = take('data', fromData);
  return result(commits && data ? (order(data['resume-at']) < order(commits['resume-at']) ? data : commits) : commits ?? data);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let out;
  try { out = fixResumeStep(JSON.parse(readFileSync(0, 'utf8'))); } catch (error) { out = { 'resume-at': null, 'resume-source': 'none', 'resume-why': `no step found: ${error.message}`, 'resume-ignored': [] }; }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
