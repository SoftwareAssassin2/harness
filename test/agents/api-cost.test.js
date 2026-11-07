// monthCost (ASS-153): the Anthropic API organization's month-to-date spend,
// from the Cost Admin API with the admin key in the keychain. The keychain is
// a fake `security` on PATH and the endpoint a stub server (its base URL
// from ANTHROPIC_ADMIN_API_URL) — no test reads the real key or calls out.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monthCost } from '../../src/agents/api-cost.js';

const KEY = 'sk-ant-admin01-FAKEKEY';

// A fake `security` that prints `key` for the harness-anthropic-admin-key
// item of account `me` (and records its argv), else fails as the real one
// does for a missing item.
function keychain(key = KEY) {
  const bin = mkdtempSync(join(tmpdir(), 'sec-'));
  const script = key == null
    ? '#!/bin/sh\necho "$@" >> "$(dirname "$0")/argv"\necho "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2\nexit 44\n'
    : `#!/bin/sh\necho "$@" >> "$(dirname "$0")/argv"\n[ "$*" = "find-generic-password -s harness-anthropic-admin-key -a me -w" ] || exit 44\necho '${key}'\n`;
  writeFileSync(join(bin, 'security'), script);
  chmodSync(join(bin, 'security'), 0o755);
  return { bin, argv: () => (existsSync(join(bin, 'argv')) ? readFileSync(join(bin, 'argv'), 'utf8') : '') };
}

// A stub cost endpoint answering each request with the next of `pages`
// ({ status, body }), recording each request's url and headers.
const servers = [];
after(() => servers.forEach(s => s.close()));
async function endpoint(pages) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    const { status = 200, body } = pages.shift() ?? { status: 500, body: {} };
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
const env = (bin, url) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, USER: 'me', ANTHROPIC_ADMIN_API_URL: url });
const bucket = (day, ...amounts) => ({ starting_at: `${day}T00:00:00Z`, ending_at: `${day}T23:59:59Z`, results: amounts.map(amount => ({ amount, currency: 'USD' })) });

test('monthCost: sums every result\'s amount (cents) across all buckets and pages, from the start of the UTC month, with the admin key and API version headers', async () => {
  const { bin } = keychain();
  const { url, requests } = await endpoint([
    { body: { data: [bucket('2026-10-01', '123.45', '100'), bucket('2026-10-02')], has_more: true, next_page: 'page-2' } },
    { body: { data: [bucket('2026-10-03', '1010.5')], has_more: false, next_page: null } },
  ]);
  const got = await monthCost({ now: new Date('2026-10-26T13:00:00Z'), env: env(bin, url) });
  assert.deepEqual(got, { month: '2026-10', usd: 12.34 });                    // 1233.95 cents, to the cent
  assert.equal(requests.length, 2);
  const first = new URL(requests[0].url, url);
  assert.equal(first.pathname, '/v1/organizations/cost_report');
  assert.equal(first.searchParams.get('starting_at'), '2026-10-01T00:00:00Z');
  assert.equal(first.searchParams.get('bucket_width'), '1d');
  assert.equal(first.searchParams.get('limit'), '31');
  assert.equal(first.searchParams.get('page'), null);
  assert.equal(new URL(requests[1].url, url).searchParams.get('page'), 'page-2');
  assert.equal(requests[0].headers['x-api-key'], KEY);
  assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
});

test('monthCost: the month is the UTC one — a minute into November UTC asks from November 1st, a minute before from October 1st', async () => {
  const { bin } = keychain();
  const { url, requests } = await endpoint([{ body: { data: [], has_more: false } }, { body: { data: [bucket('2026-10-31', '5')], has_more: false } }]);
  assert.deepEqual(await monthCost({ now: new Date('2026-11-01T00:01:00Z'), env: env(bin, url) }), { month: '2026-11', usd: 0 });
  assert.deepEqual(await monthCost({ now: new Date('2026-10-31T23:59:00Z'), env: env(bin, url) }), { month: '2026-10', usd: 0.05 });
  assert.deepEqual(requests.map(r => new URL(r.url, url).searchParams.get('starting_at')), ['2026-11-01T00:00:00Z', '2026-10-01T00:00:00Z']);
});

test('monthCost: with no admin key in the keychain it throws without calling the endpoint', async () => {
  const { bin } = keychain(null);
  const { url, requests } = await endpoint([]);
  await assert.rejects(monthCost({ env: env(bin, url) }), { message: 'no admin key in the keychain' });
  assert.equal(requests.length, 0);
});

test('monthCost: a refused key, another status or an unreachable endpoint throws saying so — the key in no message; the key is read from security\'s output, never its arguments', async () => {
  const { bin, argv } = keychain();
  const { url } = await endpoint([{ status: 401, body: { error: { message: `bad key ${KEY}` } } }, { status: 500, body: { error: KEY } }]);
  const failures = [];
  for (const base of [url, url, 'http://127.0.0.1:1']) {
    try { await monthCost({ env: env(bin, base) }); } catch (error) { failures.push(error.message); }
  }
  assert.deepEqual(failures, ['the admin key was refused (401)', 'the cost endpoint is unavailable (500)', 'the cost endpoint is unreachable']);
  assert.ok(!argv().includes(KEY));
});
