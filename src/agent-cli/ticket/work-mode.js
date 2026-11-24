// The work-mode commands' working out (ASS-556), in node to share control's reading (src/control/work-mode.js) rather
// than restate it in jq:
//
//   node work-mode.js capable <project.json>   # exit 0 when the project can build in a worktree (worktreeCapable), else 3
//   node work-mode.js decide < input.json      # ticket:choose-work-mode's decision, as JSON
//
// decide's input, gathered by choose-work-mode.sh: { output (the plan run's structured-output: work-mode,
// work-mode-reasons, work-mode-files), plan (execution-plan-<variation>.md's text, or ""), points (the ticket's, or
// null), json (project.json), current (the variation's work-mode, or null) }. Prints { mode, by, reasons, ai, forced,
// files, kept, config }: decideWorkMode's choice; ai, the AI's own { mode, reasons } (mode null when it gave none
// valid); files, those the AI named then those the plan names (planFiles), each once; config, what is wrong with the
// project's work-mode rules (projectWorkModeErrors: a broken rule is ignored, and said in the reasons).
import { readFileSync } from 'node:fs';
import { decideWorkMode, worktreeCapable, planFiles, projectWorkModeErrors, asReasons, WORK_MODES } from '../../control/work-mode.js';

const [what, file] = process.argv.slice(2);
if (what === 'capable') {
  let json = {};
  try { json = JSON.parse(readFileSync(file, 'utf8')); } catch { /* no project.json: not capable */ }
  process.exit(worktreeCapable(json) ? 0 : 3);
}
if (what !== 'decide') { process.stderr.write('usage: node work-mode.js capable <project.json> | decide < input.json\n'); process.exit(1); }
const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
const output = input.output && typeof input.output === 'object' ? input.output : {};
const ai = { mode: WORK_MODES.includes(output['work-mode']) ? output['work-mode'] : null, reasons: asReasons(output['work-mode-reasons']) };
const named = Array.isArray(output['work-mode-files']) ? output['work-mode-files'].filter(f => typeof f === 'string' && f.trim()) : [];
const files = [...new Set([...named, ...planFiles(input.plan)])];
const json = input.json && typeof input.json === 'object' ? input.json : {};
const config = projectWorkModeErrors(json);
const decided = decideWorkMode({ ai, files, points: typeof input.points === 'number' ? input.points : null, json, current: input.current ?? null });
const reasons = config.length ? [...decided.reasons, `project.json work-mode is invalid, its broken rules ignored: ${config.join('; ')}`] : decided.reasons;
process.stdout.write(`${JSON.stringify({ ...decided, reasons, ai, files, kept: decided.kept === true, config })}\n`);
