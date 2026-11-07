// Every project's golden image carries the Claude Code CLI: the grouped and
// v2 engines run their agents in the ticket's VM (`claude -p`), so an image
// without it starts no agent ("claude: command not found", exit 127 — the
// example image of 2026-10-27, whose agents had run in its dev container
// under the flat engine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PROJECTS = join(import.meta.dirname, '..', '..', 'data', 'projects');

test('every project golden image installs the Claude Code CLI and checks its version', () => {
  const images = readdirSync(PROJECTS).map(p => join(PROJECTS, p, 'golden-image', 'provision.sh')).filter(existsSync);
  assert.ok(images.length >= 1, images.join(', '));   // the harness's own, tracked; any other project's on the operator's disk (ASS-277)
  for (const file of images) {
    const text = readFileSync(file, 'utf8');
    assert.match(text, /npm install -g [^\n]*@anthropic-ai\/claude-code/, file);
    assert.match(text, /\bclaude --version\b/, file);
  }
});
