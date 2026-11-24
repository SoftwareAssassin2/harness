// An acli for the tests (ASS-576): fakeAcli(env) — an `acli` first on the PATH
// of the env it returns (`env`, process.env by default, extended, its
// ACLI_DISABLED removed so ticket-system.bash runs it). Each call is appended
// to its log, one line of argv joined by spaces (calls() lists them). It
// prints what reply(text, code) last set, to stdout, and exits with code:
// success() as acli does (`✓ Success`, 0), failure(code) its refused
// transition (`✗ Failure: … unauthorized …`, exit 0 as acli gives it, or code),
// error() the ticket's wording (`✗ Error: unauthorized…`, 0). Default: success.
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ACLI_SUCCESS = '✓ Success: Work item ABC-3 transitioned';
export const ACLI_FAILURE = "✗ Failure: ABC-3 can't be transitioned: unauthorized: use 'acli [product] auth login' to authenticate";
export const ACLI_ERROR = "✗ Error: unauthorized: use 'acli [product] auth login' to authenticate";
export const ACLI_SUCCESS_MID_ERROR = '✓ Success: Work item ABC-3 transitioned (no Error: here)';   // "Error:" mid-line: still a success

export function fakeAcli(base = process.env) {
  const dir = mkdtempSync(join(tmpdir(), 'acli-'));
  const bin = join(dir, 'bin'), log = join(dir, 'acli.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'acli'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${log}'
cat '${join(dir, 'out')}'
exit "$(cat '${join(dir, 'code')}')"
`);
  chmodSync(join(bin, 'acli'), 0o755);
  const { ACLI_DISABLED, ...rest } = base;
  const env = { ...rest, PATH: `${bin}:${base.PATH}` };
  const reply = (text, code = 0) => { writeFileSync(join(dir, 'out'), `${text}\n`); writeFileSync(join(dir, 'code'), String(code)); };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  reply(ACLI_SUCCESS);
  return {
    dir, bin, env, calls, reply,
    success: () => reply(ACLI_SUCCESS),
    failure: (code = 0) => reply(ACLI_FAILURE, code),
    error: () => reply(ACLI_ERROR),
  };
}
