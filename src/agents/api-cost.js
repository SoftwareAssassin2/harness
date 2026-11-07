// What the Anthropic API organization has spent this month (ASS-153) — what
// Hindsight's API key (ASS-62), and any other, costs — from the Usage and Cost
// Admin API, with the organization's admin key. Anthropic has no endpoint for
// a credit balance or spend limit; this is the spend, the whole organization's.
//
// The admin key (sk-ant-admin…) lives only in the macOS keychain, a generic
// password: service harness-anthropic-admin-key (the harness org's), or the
// one a project's project.json names for its own org (ASS-221), account $USER. It is read
// with `security … -w` (the key is its output, never an argument), held in
// memory for the requests alone, and never written, logged or put in an error.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const KEYCHAIN_SERVICE = 'harness-anthropic-admin-key';

// The admin key in keychain item `service`, or null when the keychain has
// none. `security` runs with `env` (its PATH: tests put a fake first).
const adminKey = (env, service) => run('security', ['find-generic-password', '-s', service, '-a', env.USER ?? '', '-w'], { env, timeout: 30_000 })
  .then(({ stdout }) => stdout.trim() || null, () => null);

// monthCost({ now, env, service }) — { month: 'YYYY-MM', usd } of the UTC month `now`
// falls in: every result's amount (decimal strings, in cents) of every daily
// bucket from the month's start (GET <base>/v1/organizations/cost_report,
// starting_at, bucket_width 1d, limit 31, following has_more / next_page as
// `page`), summed and rounded to the cent, read with the admin key in
// keychain item `service` (KEYCHAIN_SERVICE without one). <base> is
// env.ANTHROPIC_ADMIN_API_URL (tests' stub), else https://api.anthropic.com.
// Throws, saying why and never with the key: no admin key in the keychain,
// the key refused (401), the endpoint unavailable (another status) or
// unreachable.
export async function monthCost({ now = new Date(), env = process.env, service = KEYCHAIN_SERVICE } = {}) {
  const key = await adminKey(env, service);
  if (!key) throw new Error('no admin key in the keychain');
  const month = now.toISOString().slice(0, 7);
  const base = env.ANTHROPIC_ADMIN_API_URL ?? 'https://api.anthropic.com';
  let cents = 0, page = null;
  do {
    const url = new URL('/v1/organizations/cost_report', base);
    url.search = new URLSearchParams({ starting_at: `${month}-01T00:00:00Z`, bucket_width: '1d', limit: '31', ...(page ? { page } : {}) });
    let response;
    try {
      response = await fetch(url, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error('the cost endpoint is unreachable');
    }
    if (response.status === 401) throw new Error('the admin key was refused (401)');
    if (!response.ok) throw new Error(`the cost endpoint is unavailable (${response.status})`);
    const body = await response.json();
    for (const bucket of body.data ?? []) for (const result of bucket.results ?? []) cents += Number(result.amount) || 0;
    page = body.has_more ? body.next_page : null;
  } while (page);
  return { month, usd: Math.round(cents) / 100 };
}
