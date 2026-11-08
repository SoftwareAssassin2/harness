// The forge a repository url is on (GitHub or GitLab, including a self-hosted
// GitLab) and the account a project's VM token pushes as (ASS-307). The
// control box in the dashboard's footer shows the provider, the repository or
// group (as a link) and the account, so the operator sees where a project's
// code goes and spots a wrong or broken token (ASS-298).
//
// providerOf(url) / repoPath(url) / commonOwner(urls) are pure url arithmetic
// the TUI and control share (frame.js forgeLines, push-account.js). pushAccount
// reads one keychain item (the service the project's vm-credentials.json entry
// names) with `security find-generic-password -s <service> -w` — the VMs' own
// argv (vm-credentials.bash read_tokens, src/agents/usage.js keychain), no -a,
// so an item saved under any account name is still found — and asks the forge
// once for its login: GitHub `GET /user` → login, GitLab `GET /api/v4/user` →
// username. The token lives in a local for the one request, held in a Bearer
// header, and is never put in a message, a logged line or a thrown error.
// Base URLs come from env.GITHUB_API_URL / env.GITLAB_API_URL (tests' stub
// endpoints) when set, else https://api.github.com / https://<host>.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// providerOf(url) → { provider: 'GitHub' | 'GitLab', host }. github.com → GitHub,
// anything else → GitLab (a self-hosted GitLab is the only other forge the repo
// knows, as src/downloader/merge-requests.js picks its adapter). Throws on a url
// `new URL` cannot parse; callers guard.
export function providerOf(url) {
  const { host } = new URL(url);
  return { provider: host === 'github.com' ? 'GitHub' : 'GitLab', host };
}

// repoPath(url) → owner/name, without leading/trailing slashes and without
// `.git` (as src/downloader/gitlab.js's own repoPath).
export function repoPath(url) {
  return new URL(url).pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
}

// commonOwner(urls) → the longest common owner path of the urls' pathnames
// with each repository's own name (the last segment) dropped: 'caselaw-group'
// for 26 urls under it, 'g/sub' for nested groups, '' when the urls share no
// prefix, the single url's own owner for one url, '' for [].
export function commonOwner(urls) {
  const owners = urls.map(url => repoPath(url).split('/').slice(0, -1)).filter(parts => parts.length);
  if (!owners.length) return '';
  const prefix = [];
  for (let i = 0; i < owners[0].length; i++) {
    if (owners.every(parts => parts[i] === owners[0][i])) prefix.push(owners[0][i]); else break;
  }
  return prefix.join('/');
}

// The keychain item's password (service), or null when there is none; `security`
// only reads it. Exactly read_tokens' argv (vm-credentials.bash:81), so a PAT
// saved under any account name is found as it is for the VM that pushes with
// it; whitespace is stripped as read_tokens strips it.
const keychain = (env, service) => run('security', ['find-generic-password', '-s', service, '-w'], { env, timeout: 30_000 })
  .then(({ stdout }) => stdout.replace(/\s/g, '') || null, () => null);

// pushAccount({ provider, host, service, env }) → the login the token in
// keychain item `service` pushes as. Throws, saying why and never with the
// token: `no token in the keychain`, `token rejected (401)`,
// `the forge is unavailable (<status>)`, `the forge is unreachable`,
// `the forge answered no account`.
export async function pushAccount({ provider, host, service, env = process.env }) {
  const token = await keychain(env, service);
  if (!token) throw new Error('no token in the keychain');
  const base = provider === 'GitHub'
    ? (env.GITHUB_API_URL ?? 'https://api.github.com')
    : (env.GITLAB_API_URL ?? `https://${host}`);
  const path = provider === 'GitHub' ? '/user' : '/api/v4/user';
  const headers = provider === 'GitHub'
    ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    : { Authorization: `Bearer ${token}` };
  let response;
  try {
    response = await fetch(new URL(path, base), { headers, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error('the forge is unreachable');
  }
  if (response.status === 401) throw new Error('token rejected (401)');
  if (!response.ok) throw new Error(`the forge is unavailable (${response.status})`);
  const body = await response.json().catch(() => ({}));
  const account = provider === 'GitHub' ? body?.login : body?.username;
  if (!account) throw new Error('the forge answered no account');
  return account;
}
