// The real data/agent-names.json (ASS-29, ASS-27): a list of { name, franchise-name },
// each name a path segment (agents' session folders are named after them), none twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const names = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'data', 'agent-names.json'), 'utf8'));
const of = franchise => names.filter(n => n['franchise-name'] === franchise).map(n => n.name);

test('agent-names.json: every name letters, digits and hyphens, none twice, each with a franchise and nothing else', () => {
  assert.ok(Array.isArray(names) && names.length >= 186);
  for (const n of names) {
    assert.deepEqual(Object.keys(n), ['name', 'franchise-name'], JSON.stringify(n));
    assert.match(n.name, /^[A-Za-z0-9-]+$/);
    assert.ok(n['franchise-name'].trim(), n.name);
  }
  assert.equal(new Set(names.map(n => n.name)).size, names.length);
});

test('agent-names.json has the Super Smash Bros. fighters and StarCraft\'s main characters (ASS-27)', () => {
  for (const name of ['Samus', 'Kirby', 'Fox', 'Captain-Falcon', 'Mr-Game-and-Watch', 'King-K-Rool', 'Banjo-Kazooie', 'Pyra', 'Mythra', 'Sora', 'Kazuya', 'Steve']) assert.ok(of('Super Smash Bros.').includes(name), name);
  for (const name of ['Jim-Raynor', 'Sarah-Kerrigan', 'Arcturus-Mengsk', 'Zeratul', 'Artanis', 'Tassadar', 'Nova']) assert.ok(of('StarCraft').includes(name), name);
  assert.ok(of('Super Mario').includes('Mario') && !of('Super Smash Bros.').includes('Mario'));   // a fighter already there stays as it was
});
