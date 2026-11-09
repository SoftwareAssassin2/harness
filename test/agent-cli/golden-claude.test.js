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
  const images = (existsSync(PROJECTS) ? readdirSync(PROJECTS) : []).map(p => join(PROJECTS, p, 'golden-image', 'provision.sh')).filter(existsSync);
  // Every project's image is on the operator's disk, none in git (ASS-277): a fresh clone has none to check.
  for (const file of images) {
    const text = readFileSync(file, 'utf8');
    assert.match(text, /npm install -g [^\n]*@anthropic-ai\/claude-code/, file);
    assert.match(text, /\bclaude --version\b/, file);
  }
});
