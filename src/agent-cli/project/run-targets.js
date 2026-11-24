// project:set-run-targets' and project:migrate-run-targets' check (ASS-540), in node to share control's rules
// (src/control/run-targets.js, dev-environments.js) rather than restate them in jq:
//
//   node run-targets.js set <project.json> <target>…   # prints the project.json with dev-environments.run-targets set to
//                                                      # the targets (in their order) and its mode removed; exits 1, each
//                                                      # error on stderr naming the field, when the result would be wrong
//                                                      # (devEnvironmentsErrors: an unknown or repeated target, workstation
//                                                      # or cloud-vm with no machine of that kind, a substrate target with
//                                                      # no cluster on that kind of host)
//   node run-targets.js migrate <project.json>          # prints { changed, from, targets, json }: run-targets from its mode
//                                                      # (MODE_TARGETS; vm when unset) and the mode removed; changed false
//                                                      # (json as it was) when it has run-targets and no mode already
import { readFileSync } from 'node:fs';
import { devEnvironmentsErrors } from '../../control/dev-environments.js';
import { MODE_TARGETS } from '../../control/run-targets.js';

const [how, file, ...targets] = process.argv.slice(2);
const json = JSON.parse(readFileSync(file, 'utf8'));
const withTargets = list => {
  const { mode, ...d } = json['dev-environments'] ?? {};
  return { ...json, 'dev-environments': { ...d, 'run-targets': list } };
};
if (how === 'set') {
  const next = withTargets(targets);
  const errors = devEnvironmentsErrors(next);
  if (errors.length) { for (const e of errors) process.stderr.write(`${e}\n`); process.exit(1); }
  process.stdout.write(`${JSON.stringify(next)}\n`);
} else if (how === 'migrate') {
  const d = json['dev-environments'];
  if (d?.['run-targets'] !== undefined && d.mode === undefined) process.stdout.write(`${JSON.stringify({ changed: false, json })}\n`);
  else {
    const from = d?.mode ?? null, list = d?.['run-targets'] ?? MODE_TARGETS[from ?? 'vm'];
    if (!list) { process.stderr.write(`dev-environments.mode ${JSON.stringify(from)} is not one of ${Object.keys(MODE_TARGETS).join(', ')}\n`); process.exit(1); }
    process.stdout.write(`${JSON.stringify({ changed: true, from, targets: list, json: withTargets(list) })}\n`);
  }
} else { process.stderr.write('usage: node run-targets.js set <project.json> <target>… | migrate <project.json>\n'); process.exit(1); }
