// How much of a Claude login's 5-hour session window is used (ASS-47), and of
// its 7-day weekly window (ASS-65), from one reading: the
// call Claude Code's /usage makes, with the login's own OAuth token. The token
// is only read here, never rewritten: Claude Code renews it itself whenever it
// runs for that config dir. ASS-571: a project whose agents all run elsewhere
// (remote machines, sandboxes) never runs Claude Code on the Mac, so its token
// lapsed unseen; refreshLogin has Claude Code renew it — the documented way
// (Claude Code renews its saved claude.ai login itself and coordinates the
// renewal between its processes; there is no documented refresh for a third
// party, and a refresh of our own could race Claude Code's and revoke the
// login) — and loginExpiry says when one is due.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

// The login's claudeAiOauth credentials (token and all), or undefined: from the
// keychain on macOS, else <config dir>/.credentials.json. Never logged or returned
// past this module but for its expiry.
async function oauthOf(configDir, { platform = process.platform, home = homedir(), readKeychain = keychain, readFile = fileOrNull } = {}) {
  const text = platform === 'darwin' ? await readKeychain(keychainService(configDir)) : readFile(join(configDir ?? join(home, '.claude'), '.credentials.json'));
  try { return JSON.parse(text).claudeAiOauth; } catch { return undefined; }
}

// loginExpiry(configDir, options) — ASS-571: when the login's access token
// expires (expiresAt, ms), null when it has none recorded; undefined when there
// is no token at all. Options as sessionUsage's.
export async function loginExpiry(configDir, options = {}) {
  const oauth = await oauthOf(configDir, options);
  if (!oauth?.accessToken) return undefined;
  return typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null;
}

// refreshLogin(configDir, { command, env, cwd, timeout }) — ASS-571: has Claude
// Code renew the login's token, as it does whenever it runs: one minimal
// non-interactive turn (`claude -p`, the smallest model, no tools, no MCP
// servers, no session saved) with configDir as CLAUDE_CONFIG_DIR, from a
// neutral folder (cwd, the system's temp folder: no project's CLAUDE.md read)
// and without the environment's ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or
// CLAUDE_CODE_OAUTH_TOKEN, which would take precedence over the saved login.
// Claude Code writes the renewed credentials back to the same keychain item
// itself. Resolves once it has run; throws, saying why in a line (its first
// stderr line, never its output), when it fails or takes longer than timeout.
// Whether the token was renewed is for the caller to read (loginExpiry).
export async function refreshLogin(configDir, { command = ['claude'], env = process.env, cwd = tmpdir(), timeout = 180_000 } = {}) {
  const [file, ...args] = command;
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !REFRESH_UNSET.has(k) && k !== 'CLAUDE_CONFIG_DIR'));
  try {
    await run(file, [...args, '-p', 'Reply with OK.', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json'],
      { env: configDir ? { ...clean, CLAUDE_CONFIG_DIR: configDir } : clean, cwd, timeout, maxBuffer: 4 << 20 });
  } catch (error) {
    const said = String(error.stderr ?? '').trim().split('\n')[0] || (error.killed ? `no answer within ${Math.round(timeout / 1000)}s` : error.code ?? error.message);
    throw new Error(`claude -p failed: ${String(said).slice(0, 160)}`);
  }
}
const REFRESH_UNSET = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);

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
  const oauth = await oauthOf(configDir, { platform, home, readKeychain, readFile });
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
