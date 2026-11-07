// The shared golden-image step desktop.sh (ASS-76), run with fakes on PATH: sudo
// as the VM's (env_reset: only what its command line sets reaches the command),
// apt-get logging the debconf frontend it ran under, and the rest logging only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const DESKTOP = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'vm', 'golden-image', 'desktop.sh');

function fakes({ failPurge = false } = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'desktop-')), log = join(bin, 'log');
  const fake = (name, body) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  fake('sudo', 'exec env -i PATH="$PATH" "$@"');
  fake('apt-get', `echo "apt-get $* frontend=\${DEBIAN_FRONTEND:-}" >> '${log}'
if [[ " $* " == *" purge "* ]] && { [[ -z "\${DEBIAN_FRONTEND:-}" ]] || ${failPurge}; }; then
  echo "Removing linux-image-6.12.111+deb13-cloud-arm64 ..."; echo "E: Aborting removal of the running kernel"; exit 100
fi
echo "Setting up firefox-esr ..."`);
  fake('dpkg-query', `[[ "$*" == *cloud* ]] && printf 'ii  linux-image-6.12.111+deb13-cloud-arm64\\nii  linux-image-cloud-arm64\\nrc  linux-image-6.1.0-9-cloud-arm64\\n'; true`);
  fake('dpkg', 'echo arm64');
  for (const name of ['install', 'tee', 'systemctl', 'ls']) fake(name, `echo "${name} $*" >> '${log}'; cat >/dev/null 2>&1 </dev/null; true`);
  return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, log: () => readFileSync(log, 'utf8') };
}

test('desktop.sh swaps the cloud kernel for the generic one with debconf prompts off, through sudo', async () => {
  const f = fakes();
  await run('bash', [DESKTOP], { env: f.env });
  assert.match(f.log(), /apt-get .*purge linux-image-6\.12\.111\+deb13-cloud-arm64 linux-image-cloud-arm64 frontend=noninteractive/);
  assert.match(f.log(), /apt-get .*install .*linux-image-arm64 .*firefox-esr frontend=noninteractive/);
  assert.match(f.log(), /systemctl set-default multi-user\.target/);
});

test('desktop.sh fails with apt\'s own output when apt fails', async () => {
  const f = fakes({ failPurge: true });
  await assert.rejects(run('bash', [DESKTOP], { env: f.env }), e => {
    assert.match(e.stderr, /apt-get purge failed[\s\S]*Removing linux-image-6\.12\.111[\s\S]*E: Aborting removal of the running kernel/);
    return true;
  });
});
