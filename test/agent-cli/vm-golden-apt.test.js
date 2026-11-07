// The golden-image scripts that run apt besides desktop.sh — each project's
// provision.sh and the shared git.sh — run apt as desktop.sh does (ASS-76):
// debconf prompts off on apt's own command line, sudo's env_reset dropping
// the exported DEBIAN_FRONTEND; apt's output kept quiet, but printed in full
// when it fails. Fakes on PATH: sudo as the VM's (only what its command line
// sets reaches the command), apt-get logging the frontend it ran under and
// failing, curl giving git.sh a release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');

function fakes() {
  const bin = mkdtempSync(join(tmpdir(), 'apt-')), log = join(bin, 'log');
  const fake = (name, body) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  fake('sudo', 'exec env -i PATH="$PATH" "$@"');
  fake('apt-get', `echo "apt-get $* frontend=\${DEBIAN_FRONTEND:-}" >> '${log}'; echo "Reading package lists..."; echo "E: Unable to locate package $*"; exit 100`);
  fake('curl', 'echo "git-2.51.0.tar.xz"');
  return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, log: () => readFileSync(log, 'utf8').trim().split('\n') };
}

for (const script of ['data/projects/harness/golden-image/provision.sh', 'src/agent-cli/vm/golden-image/git.sh']) {
  test(`${script} runs apt-get with debconf prompts off, through sudo, and fails with apt's own output`, async () => {
    const f = fakes();
    await assert.rejects(run('bash', ['-c', readFileSync(join(ROOT, script), 'utf8'), script.split('/').pop()], { env: f.env }), e => {
      assert.match(e.stderr, new RegExp(`${script.split('/').pop()}: apt-get \\w+ failed:\\nReading package lists\\.\\.\\.\\nE: Unable to locate package`));
      return true;
    });
    for (const line of f.log()) assert.match(line, / -y .*frontend=noninteractive$/);
  });
}
