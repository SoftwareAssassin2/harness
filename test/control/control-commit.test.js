// ASS-393 AC2: control records the commit it started from — git rev-parse
// HEAD of the checkout it runs — beside the projects folder, for
// ticket:fix-landed: control-commit-<project> for a project's control,
// control-commit for one without --project; a checkout git cannot read
// records nothing, removing an earlier record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlCommitFile, recordControlCommit } from '../../src/control/control-commit.js';

test('ASS-393 AC2: recordControlCommit writes the checkout\'s HEAD to data/control-commit-<project>; none readable removes it', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'control-commit-'));
  const repo = join(tmp, 'repo'), data = join(tmp, 'data'), paths = { projects: join(data, 'projects') };
  mkdirSync(paths.projects, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'first']);
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(controlCommitFile(paths, 'p'), join(data, 'control-commit-p'));
  assert.equal(controlCommitFile(paths, null), join(data, 'control-commit'));
  assert.equal(recordControlCommit(repo, paths, 'p'), head);
  assert.equal(readFileSync(join(data, 'control-commit-p'), 'utf8'), `${head}\n`);
  assert.equal(recordControlCommit(repo, paths, null), head);
  assert.equal(readFileSync(join(data, 'control-commit'), 'utf8'), `${head}\n`);
  const plain = join(tmp, 'plain');
  mkdirSync(plain);
  writeFileSync(join(data, 'control-commit-q'), 'stale\n');
  assert.equal(recordControlCommit(plain, paths, 'q'), null);
  assert.equal(existsSync(join(data, 'control-commit-q')), false);
});
