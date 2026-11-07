// fakeForge() — glab and gh replaced on PATH (put `path` first) by one fake
// that logs each call's arguments (log('glab'), log('gh')) and answers from
// the routes a test gives: route(tool, /regex on the joined arguments/,
// { out, exit, when, touch, write }) — out printed (an object as JSON), exit its
// status (default 0); `when` names a flag the route waits for, `touch` one it
// raises, so a merge can change what a later view says; `write` [file, text]
// writes that file, as a concurrent command would mid-call. A call given
// `--input -` has its stdin kept, one entry per call: stdin(tool). The route added last
// is tried first; a call no route answers fails, naming itself. glab is
// logged in (auth status passes) until a route says otherwise.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function fakeForge() {
  const dir = mkdtempSync(join(tmpdir(), 'forge-')), bin = join(dir, 'bin');
  mkdirSync(bin);
  const script = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const dir = ${JSON.stringify(dir)}, tool = path.basename(process.argv[1]), args = process.argv.slice(2).join(' ');
fs.appendFileSync(path.join(dir, tool + '.log'), args + '\\n');
if (/(^| )--input -( |$)/.test(args)) fs.appendFileSync(path.join(dir, tool + '.stdin'), JSON.stringify(fs.readFileSync(0, 'utf8')) + '\\n');
const flag = name => path.join(dir, 'flag-' + name);
const r = JSON.parse(fs.readFileSync(path.join(dir, 'routes.json'), 'utf8'))
  .find(r => r.tool === tool && new RegExp(r.match).test(args) && (!r.when || fs.existsSync(flag(r.when))));
if (!r) { process.stderr.write('fake ' + tool + ': no route for: ' + args + '\\n'); process.exit(1); }
if (r.touch) fs.writeFileSync(flag(r.touch), '');
if (r.write) fs.writeFileSync(r.write[0], r.write[1]);
if (r.out !== undefined) process.stdout.write((typeof r.out === 'string' ? r.out : JSON.stringify(r.out)) + '\\n');
process.exit(r.exit ?? 0);
`;
  for (const tool of ['glab', 'gh']) { writeFileSync(join(bin, tool), script); chmodSync(join(bin, tool), 0o755); }
  let routes = [{ tool: 'glab', match: '^auth status$' }];
  const save = () => writeFileSync(join(dir, 'routes.json'), JSON.stringify(routes));
  save();
  return {
    path: `${bin}:${process.env.PATH}`,
    route(tool, match, response = {}) { routes = [{ tool, match: match.source, ...response }, ...routes]; save(); },
    log: tool => (existsSync(join(dir, `${tool}.log`)) ? readFileSync(join(dir, `${tool}.log`), 'utf8').trim().split('\n') : []),
    stdin: tool => (existsSync(join(dir, `${tool}.stdin`)) ? readFileSync(join(dir, `${tool}.stdin`), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []),
  };
}
