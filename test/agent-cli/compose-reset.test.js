// ASS-353: compose-reset.js, whether a recorded automated test's run command
// starts its docker compose stack from fresh state — the check behind
// automated-tests:record's refusal and verify-success's exit 4. The commands
// are shaped as real recorded ones were: a pgTAP suite run against a database
// container brought up with `up -d --wait`, then a `run --rm` of the test
// container, inside cd's, exports, bash -c strings and traps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { reusesState, composeCalls } from '../../src/agent-cli/automated-tests/compose-reset.js';

const SCRIPT = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'automated-tests', 'compose-reset.js');
const PGTAP = `run --rm --entrypoint sh pgtap -c 'psql -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS pgtap;" >/dev/null && pg_prove --verbose /tests/417_example.sql'`;

test('ASS-353 AC1: a fixed COMPOSE_PROJECT_NAME bringing the stack up with no down -v first reuses the volume an earlier run left', () => {
  for (const command of [
    `cd shop/apps/shop-db-e2e && COMPOSE_PROJECT_NAME=ex100 docker compose up -d --wait api-db >/dev/null && COMPOSE_PROJECT_NAME=ex100 docker compose ${PGTAP}`,   // the incident's shape
    `cd shop/apps/shop-db-e2e && export COMPOSE_PROJECT_NAME=ex100 && docker compose build -q pgtap && docker compose ${PGTAP}`,   // run starts the database it depends on
    'cd e2e && docker compose up -d db && docker compose run --rm tests',                                  // no project name: the folder's, as fixed
    'cd e2e && docker compose -f compose.e2e.yml -p ex100 up -d db && docker-compose -p ex100 run --rm tests',
    'cd e2e && docker compose up -d db; docker compose run --rm tests; docker compose down -v',            // reset after, not before: the next run still finds it
    'cd e2e && docker compose down && docker compose up -d db',                                             // down without -v keeps the volumes
  ]) assert.equal(reusesState(command), true, command);
});

test('ASS-353 AC1: down -v (or --volumes) before the first bring-up, or a per-run-unique project name, starts fresh', () => {
  for (const command of [
    `cd e2e && export COMPOSE_PROJECT_NAME=ex100 && docker compose down -v >/dev/null 2>&1; docker compose up --no-build api-db && docker compose ${PGTAP}; rc=$?; docker compose down -v >/dev/null 2>&1; exit $rc`,
    `cd e2e && bash -c 'set -e; export COMPOSE_PROJECT_NAME=ex100; trap "docker compose down -v >/dev/null 2>&1" EXIT; docker compose down -v >/dev/null 2>&1 || true; docker compose up -d --wait api-db; docker compose ${PGTAP}'`,
    'cd e2e && docker compose -p ex100 down --volumes --remove-orphans && docker compose -p ex100 up -d db',
    'cd e2e && COMPOSE_PROJECT_NAME=ex100-$$ docker compose up -d db && COMPOSE_PROJECT_NAME=ex100-$$ docker compose run --rm tests',
    'cd e2e && export COMPOSE_PROJECT_NAME="ex-$(date +%s%N)" && docker compose up -d db',
    'cd e2e && docker compose -p "ex-${RANDOM}" up -d db',
    // No stack brought up: built, listed, or no compose at all; a project script resets on its own.
    'cd e2e && docker compose build pgtap && docker compose config --services',
    'node --test test/a.test.js', 'cd e2e && bash ../scripts/e2e-compose-test.sh --up api-db --run pgtap', 'grep -c docker-compose.yml README.md',
  ]) assert.equal(reusesState(command), false, command);
});

test('ASS-353: composeCalls reads each call\'s subcommand past its global options, and its -p project', () => {
  assert.deepEqual(composeCalls('docker compose -f a.yml --profile x -p ex1 up -d db && docker-compose --project-name=ex2 down -v'), [
    { subcommand: 'up', args: ['-d', 'db'], project: 'ex1' }, { subcommand: 'down', args: ['-v'], project: 'ex2' }]);
});

test('ASS-353: node compose-reset.js prints each entry\'s run command that reuses its stack, one per line, nothing when none does', () => {
  const reusing = 'COMPOSE_PROJECT_NAME=ex1 docker compose up -d db && echo ok';
  const tests = [{ list: 'echo a', run: reusing }, { list: 'echo b', run: 'docker compose down -v && docker compose up -d db' }, { list: 'echo c', run: 'node --test' }];
  assert.equal(execFileSync('node', [SCRIPT], { input: JSON.stringify(tests), encoding: 'utf8' }), `${reusing}\n`);
  assert.equal(execFileSync('node', [SCRIPT], { input: '[]', encoding: 'utf8' }), '');
});
