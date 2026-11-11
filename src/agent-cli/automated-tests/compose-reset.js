// ASS-353: does a recorded automated test's run command start its docker
// compose stack from fresh state? A run command that brings a stack up (up,
// run, start, create, restart) under a fixed project name — COMPOSE_PROJECT_NAME
// set to a constant, -p/--project-name one, or none, the folder's name — with
// no `docker compose down -v` (or --volumes) before it reuses the named
// volumes an earlier run left: a postgres volume carrying migrations a later
// step renumbered then fails flyway ("Detected applied migration not resolved
// locally") before a test runs, a false block at Automated Testing that CI,
// with a fresh database per pipeline, never sees. A per-run-unique project
// name ($$, $RANDOM, $SRANDOM, $BASHPID, a $(…) or `…` substitution) starts
// fresh too. A stack brought up by a script the command calls is not seen
// here: the script is the project's, and resets or not on its own.
//
//   node compose-reset.js < automated-tests.json
//
// prints, one per line, each entry's run command that does not reset its
// stack (nothing when every one does, or none uses docker compose).
// automated-tests:record refuses such an entry; automated-tests:verify-success
// sends one already recorded back to Generate Automated Tests (exit 4) to be
// recorded again. Node, as test-results.js beside it: tokenising shell takes a
// parser, tested on its own (test/agent-cli/compose-reset.test.js).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const COMPOSE = /(?:^|[^\w/-])(?:docker\s+compose|docker-compose)(?=\s|$)/g;
// Global options that take a value as the next word, before the subcommand.
const VALUED = new Set(['-f', '--file', '-p', '--project-name', '--profile', '--env-file', '--project-directory', '--ansi', '--progress', '--parallel']);
const BRINGS_UP = new Set(['up', 'run', 'start', 'create', 'restart']);
const UNIQUE = /\$\$|\$\{?(?:RANDOM|SRANDOM|BASHPID)\b|\$\(|`/;
const VOLUMES = token => /^--volumes(?:=true)?$/.test(token) || /^-[a-zA-Z]*v[a-zA-Z]*$/.test(token);

// Each docker compose call in the command, in order: { subcommand, args, project }.
// A call's words run to the next shell separator; quotes are dropped from each.
export function composeCalls(command) {
  const calls = [];
  for (const match of command.matchAll(COMPOSE)) {
    const rest = command.slice(match.index + match[0].length).split(/[;&|\n()`]/)[0];
    const words = rest.split(/\s+/).map(w => w.replace(/["']/g, '')).filter(Boolean);
    let subcommand = null, project = null, i = 0;
    for (; i < words.length; i++) {
      const w = words[i];
      if (!w.startsWith('-')) { subcommand = w; break; }
      const [flag, value] = w.split(/=(.*)/s);
      if (flag === '-p' || flag === '--project-name') project = value ?? words[i + 1] ?? null;
      if (value === undefined && VALUED.has(flag)) i++;
    }
    calls.push({ subcommand, args: subcommand ? words.slice(i + 1) : [], project });
  }
  return calls;
}

// Whether the command brings a compose stack up without resetting it first.
export function reusesState(command) {
  const names = [...command.matchAll(/COMPOSE_PROJECT_NAME=(\S+)/g)].map(m => m[1]);
  const calls = composeCalls(command);
  names.push(...calls.map(c => c.project).filter(Boolean));
  if (names.some(name => UNIQUE.test(name))) return false;
  for (const { subcommand, args } of calls) {
    if (subcommand === 'down' && args.some(VOLUMES)) return false;
    if (BRINGS_UP.has(subcommand)) return true;
  }
  return false;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tests = JSON.parse(readFileSync(0, 'utf8'));
  for (const { run } of Array.isArray(tests) ? tests : []) if (typeof run === 'string' && reusesState(run)) console.log(run.replace(/\n/g, ' '));
}
