// The shared golden-image step memory.sh (ASS-421), run with fakes on PATH:
// sudo as the VM's (env_reset: only what its command line sets reaches the
// command), and update-grub regenerating a grub.cfg as grub-mkconfig does —
// GRUB_CMDLINE_LINUX from /etc/default/grub, then each grub.d/*.cfg sourced
// after it — into folders of the test's own (GRUB_D, GRUB_CFG).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const MEMORY = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'vm', 'golden-image', 'memory.sh');

// fakes({ grub, applies }) — grub: whether update-grub is on PATH; applies: false, it regenerates nothing.
function fakes({ grub = true, applies = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-')), bin = join(dir, 'bin'), grubD = join(dir, 'grub.d'), cfg = join(dir, 'grub.cfg'), log = join(dir, 'log');
  mkdirSync(bin);
  mkdirSync(grubD);
  writeFileSync(join(grubD, '10_cloud.cfg'), 'GRUB_CMDLINE_LINUX="console=hvc0"\n');   // a cloud image's own setting, kept
  const fake = (name, body) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  fake('sudo', `echo "sudo $1" >> '${log}'; exec env -i PATH="$PATH" "$@"`);
  if (grub) fake('update-grub', `echo "update-grub" >> '${log}'; ${applies}
GRUB_CMDLINE_LINUX=""
for f in '${grubD}'/*.cfg; do . "$f"; done
echo "linux /boot/vmlinuz-6.12.116+deb13-arm64 root=PARTUUID=x ro $GRUB_CMDLINE_LINUX" > '${cfg}'
echo "Generating grub configuration file ..."; echo done`);
  return {
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, GRUB_D: grubD, GRUB_CFG: cfg },
    grubD, cfg, log: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
  };
}

test('ASS-421 AC2: memory.sh adds init_on_free=1 to the kernel command line through grub.d, keeping the image\'s own, and regenerates grub.cfg', async () => {
  const f = fakes();
  const { stdout } = await run('bash', [MEMORY], { env: f.env });
  assert.match(readFileSync(join(f.grubD, '90-harness-memory.cfg'), 'utf8'), /^GRUB_CMDLINE_LINUX="\$GRUB_CMDLINE_LINUX init_on_free=1"$/m);
  assert.match(readFileSync(f.cfg, 'utf8'), / ro console=hvc0 init_on_free=1$/m);
  assert.match(f.log(), /sudo tee\n(.*\n)*sudo update-grub/);   // written and regenerated as root
  assert.match(stdout, /init_on_free=1 from the next start/);
});

test('ASS-421 AC2: memory.sh run again writes the same setting once, not twice', async () => {
  const f = fakes();
  await run('bash', [MEMORY], { env: f.env });
  await run('bash', [MEMORY], { env: f.env });
  assert.equal(readFileSync(f.cfg, 'utf8').match(/init_on_free=1/g).length, 1);
});

test('ASS-421 AC2: memory.sh fails, naming grub.cfg, when update-grub leaves init_on_free=1 out of it', async () => {
  const f = fakes({ applies: 'exit 0' });
  writeFileSync(f.cfg, 'linux /boot/vmlinuz root=PARTUUID=x ro\n');
  await assert.rejects(run('bash', [MEMORY], { env: f.env }), e => {
    assert.match(e.stderr, /grub\.cfg has no init_on_free=1 after update-grub/);
    return true;
  });
});

test('ASS-421 AC2: an image without update-grub is left alone, saying so', async () => {
  const f = fakes({ grub: false });
  const { stdout } = await run('bash', [MEMORY], { env: f.env });
  assert.match(stdout, /no update-grub in this image; init_on_free not set/);
  assert.ok(!existsSync(join(f.grubD, '90-harness-memory.cfg')));
  assert.equal(f.log(), '');
});
