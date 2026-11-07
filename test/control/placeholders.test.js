// Filling a step's command template into an argv, one argument per word, a
// placeholder's value kept whole however many words it has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillArgs } from '../../src/control/placeholders.js';

test('fillArgs splits the command on whitespace and fills each {placeholder} from the values, a value with spaces staying one argument', () => {
  assert.deepEqual(fillArgs('./agent.sh code:create-branch {ticket}', { ticket: 'ABC-3' }), ['./agent.sh', 'code:create-branch', 'ABC-3']);
  assert.deepEqual(fillArgs('./agent.sh self-healing:start {ticket} {summary} {ticket-url}', { ticket: 'ABC-9', summary: 'the build is red', 'ticket-url': '-' }),
    ['./agent.sh', 'self-healing:start', 'ABC-9', 'the build is red', '-']);
  assert.deepEqual(fillArgs('  echo   {a}-{b} ', { a: 1, b: 'x' }), ['echo', '1-x']);
});

test('fillArgs fails on a placeholder with no value, naming it, and on a value that is null', () => {
  assert.throws(() => fillArgs('./agent.sh self-healing:start {ticket} {summary}', { ticket: 'ABC-9' }), /unfilled placeholder \{summary\}/);
  assert.throws(() => fillArgs('run {ticket}', { ticket: null }), /unfilled placeholder \{ticket\}/);
  assert.throws(() => fillArgs('run {ticket}', {}), /unfilled placeholder \{ticket\}/);
});
