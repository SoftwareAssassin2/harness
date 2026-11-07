// How much of a Claude login's 5-hour session window is used (ASS-47), and of
// its 7-day weekly window (ASS-65), from one reading: the
// call Claude Code's /usage makes, with the login's own OAuth token. The token
// is only read — never refreshed or rewritten; Claude refreshes it whenever it
// runs for that config dir, so an expired one makes a reading unavailable for
// a while.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

// keychainService(configDir) — the macOS keychain item (a generic password)
// Claude Code keeps a login's credentials in: `Claude Code-credentials` for
// the shared ~/.claude (no configDir), with `-<first 8 hex of
// sha256(configDir)>` for another CLAUDE_CONFIG_DIR.
export const keychainService = configDir => `Claude Code-credentials${configDir ? `-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}` : ''}`;

// The keychain item's password, or null when there is none; `security` only reads it.
const keychain = service => run('security', ['find-generic-password', '-s', service, '-w'], { timeout: 30_000 })
  .then(({ stdout }) => stdout, () => null);
const fileOrNull = path => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

// sessionUsage(configDir, options) — { percent, resetsAt, weekly } of the
// login's 5-hour window as the endpoint reports it (percent raw, resetsAt ISO
// 8601 UTC; nulls when it reports none), weekly the same { percent, resetsAt }
// of its 7-day window (seven_day) — null when the response has no seven_day or
// its resets_at is null: a plan with no weekly cap, not a failed reading. configDir is the login's
// CLAUDE_CONFIG_DIR, undefined for ~/.claude. Its token is the credentials'
// claudeAiOauth.accessToken: on macOS from the keychain (keychainService),
// elsewhere from <config dir>/.credentials.json. Throws, saying why: no
// token, the token expired (expiresAt passed; not sent), refused (a 401),
// unavailable (another status), or the endpoint unreachable. Options replace
// what it reaches out to, for tests: platform, now (ms), home, readKeychain
// (service → text or null), readFile (path → text or null), fetch.
export async function sessionUsage(configDir, {
  platform = process.platform, now = Date.now(), home = homedir(),
  readKeychain = keychain, readFile = fileOrNull, fetch = globalThis.fetch,
} = {}) {
  const text = platform === 'darwin' ? await readKeychain(keychainService(configDir)) : readFile(join(configDir ?? join(home, '.claude'), '.credentials.json'));
  let oauth;
  try { oauth = JSON.parse(text).claudeAiOauth; } catch { /* none */ }
  if (!oauth?.accessToken) throw new Error('no token');
  if (oauth.expiresAt != null && oauth.expiresAt <= now) throw new Error('the token has expired');
  let response;
  try {
    response = await fetch(ENDPOINT, { headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error('the usage endpoint is unreachable');
  }
  if (response.status === 401) throw new Error('the token was refused (401)');
  if (!response.ok) throw new Error(`the usage endpoint is unavailable (${response.status})`);
  const body = await response.json();
  const weekly = body?.seven_day?.resets_at == null ? null : reading(body.seven_day);
  return { ...reading(body?.five_hour), weekly };
}

// A window ({ utilization, resets_at }) as { percent, resetsAt }.
function reading(window) {
  const resets = Date.parse(window?.resets_at);
  return {
    percent: typeof window?.utilization === 'number' ? window.utilization : null,
    resetsAt: Number.isNaN(resets) ? null : new Date(resets).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}
