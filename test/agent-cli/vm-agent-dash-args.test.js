// The in-VM agent.sh (ASS-336) sends every argument as it is, a "--"-leading
// one (question:ask's --blocking) included: jq is given them after "--", so it
// never takes one as its own option and aborts, leaving an empty body the host
// refuses as bad json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLIENT = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'vm', 'in-vm', 'agent.sh');

// Runs the in-VM agent.sh with `env`, `input` on stdin: { code, stdout, stderr }.
function client(env, args, input = '') {
  return new Promise(resolve => {
    const child = execFile('bash', [CLIENT, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    child.stdin.end(input);
  });
}

// A stub forwarder that records each POSTed body, parsed, and answers exit 0;
// a body that is not JSON it records as null and refuses, as the host does.
async function stubForwarder() {
  const bodies = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let call = null;
      try { call = JSON.parse(raw); } catch { bodies.push(null); res.writeHead(400).end('{"refused":"bad json"}\n'); return; }
      bodies.push(call);
      res.end(`${JSON.stringify({ exit: 0 })}\n`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, bodies, close: () => new Promise(resolve => server.close(resolve)) };
}

test('ASS-336 AC1: question:ask with --blocking, to an unreachable forwarder, gives no "jq: Unknown option" and no "bad json"', async () => {
  const { stderr } = await client({ AGENT_FORWARDER_URL: 'http://127.0.0.1:9', AGENT_TOKEN_FILE: '/dev/null' },
    ['question:ask', 'p', 'ABC-3', 'A', '--blocking', 'q', 'why', 'rec']);
  assert.doesNotMatch(stderr, /jq: Unknown option/);
  assert.doesNotMatch(stderr, /bad json/);
});

test('ASS-336 AC2: the POSTed argv is the full argument list, in order, --blocking and other "--"-leading elements included; work:write sends its stdin too', async () => {
  const forwarder = await stubForwarder();
  const tokenFile = join(mkdtempSync(join(tmpdir(), 'vm-agent-dash-')), 'token');
  writeFileSync(tokenFile, 'tok\n');
  const env = { AGENT_FORWARDER_URL: forwarder.url, AGENT_TOKEN_FILE: tokenFile };
  try {
    const ask = ['question:ask', 'p', 'ABC-3', 'A', '--blocking', 'q', 'why', 'rec'];
    const asked = await client(env, ask);
    assert.equal(asked.code, 0, asked.stderr);
    assert.doesNotMatch(asked.stderr, /jq: /);

    const write = ['work:write', 'p', 'ABC-3', 'A', '--notes.md'];
    const wrote = await client(env, write, 'body\n');
    assert.equal(wrote.code, 0, wrote.stderr);

    const odd = ['question:ask', 'p', 'ABC-3', 'A', '--non-blocking', '--', '-x', '--args', 'q'];
    const sent = await client(env, odd);
    assert.equal(sent.code, 0, sent.stderr);

    assert.equal(forwarder.bodies.length, 3);
    assert.deepEqual(forwarder.bodies[0], { token: 'tok', argv: ask });
    assert.deepEqual(forwarder.bodies[1].argv, write);
    assert.equal(forwarder.bodies[1].token, 'tok');
    assert.equal(Buffer.from(forwarder.bodies[1].stdin, 'base64').toString(), 'body\n');
    assert.deepEqual(forwarder.bodies[2].argv, odd, 'a literal "--" and other option-like words are sent too');
  } finally {
    await forwarder.close();
  }
});
