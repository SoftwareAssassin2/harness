// The TUI's feature flags (ASS-262): one tracked file of named flags, read at
// start, a flag it does not name counting as off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadFeatures, featureOn, FEATURES } from '../../src/tui/features.js';
import { initialState } from '../../src/tui/app.js';

test('ASS-262 AC2: src/tui/features.json is tracked and has chat-screen and ticket-chat-tab, both off', () => {
  assert.equal(FEATURES, join(import.meta.dirname, '..', '..', 'src', 'tui', 'features.json'));
  assert.deepEqual(loadFeatures(), { 'chat-screen': false, 'ticket-chat-tab': false });
  assert.equal(execFileSync('git', ['ls-files', '--error-unmatch', FEATURES], { cwd: import.meta.dirname, encoding: 'utf8' }).trim().endsWith('features.json'), true);
});

test('ASS-262 AC2: a flag the file does not name is off, as is every flag with the file missing or unreadable; only true turns one on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'features-'));
  try {
    const file = join(dir, 'features.json');
    writeFileSync(file, JSON.stringify({ 'chat-screen': true }));
    const features = loadFeatures(file);
    assert.equal(featureOn({ features }, 'chat-screen'), true);
    assert.equal(featureOn({ features }, 'ticket-chat-tab'), false);
    assert.deepEqual(loadFeatures(join(dir, 'missing.json')), {});
    writeFileSync(file, '{ half written');
    assert.deepEqual(loadFeatures(file), {});
    assert.equal(featureOn({ features: { 'chat-screen': 'yes' } }, 'chat-screen'), false);
    assert.equal(featureOn({}, 'chat-screen'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ASS-262 AC2: the TUI\'s state holds the flags it starts with — none, so every one off, when it is given none', () => {
  assert.deepEqual(initialState().features, {});
  assert.deepEqual(initialState({ features: { 'chat-screen': true } }).features, { 'chat-screen': true });
});
