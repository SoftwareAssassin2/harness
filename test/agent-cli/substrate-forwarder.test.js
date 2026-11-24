// ASS-536: an agent in a Substrate sandbox calls agent.sh on the Mac through the forwarder, and reaches its project's
// Hindsight, as an agent in a VM does — on the Mac's cluster and on a (fake) workstation's. substrate:sandbox-up issues
// the sandbox a forwarder token of its own (bound in vm-tokens.json, put in its /run/harness with the forwarder's URL
// and agent.sh) and gives it the egress rule set "mac": one rule for the forwarder's port and one for its project's
// Hindsight's, on the Mac's name as its cluster sees it (on a remote machine, through the machine's relay onto its
// SSH connection's reverse forwards); substrate:sandbox-delete revokes the token. The fake Substrate (fake-substrate.js)
// keeps the actor's egress policy, the relay container and the Service; through() below carries a sandbox's request
// the way the egress gateway, cluster DNS and the relay would — refusing what no rule of the sandbox allows — to the
// real forwarder (startForwarder) and a fake Hindsight on this machine's loopback, the Mac's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { ID } from './workstation-fixture.js';
import { sandboxed } from './sandbox-fixture.js';
import { startForwarder } from '../../src/control/forwarder.js';
import { macHost } from '../../src/control/machine-substrate.js';
import { memoryFor } from '../../src/control/dispatch.js';
import { fakeHindsight } from '../support/fake-hindsight.js';

const ROOT = join(import.meta.dirname, '..', '..');
const CLIENT = join(ROOT, 'src', 'agent-cli', 'vm', 'in-vm', 'agent.sh');
const FORWARDER = 7787;   // workstation-fixture.js's harness.json forwarder-port
const sha = text => createHash('sha256').update(text).digest('hex');
// The folders of the tools the sandbox's agent.sh needs, ahead on its PATH (a login shell's PATH on macOS may lack them).
const TOOLS = ['jq', 'curl', 'base64'].map(t => { try { return execFileSync('which', [t]).toString(); } catch { return ''; } });

// through(t, actor, url) — the URL on this machine that a request from the sandbox to `url` arrives at: its egress
// policy must have an http rule for the host and port (else it throws "denied", as the gateway refuses it); then
// host.docker.internal is the Mac's loopback (Docker Desktop's), and a cluster Service name its EndpointSlice's
// address, where the relay container listens on that port and relays to the machine's loopback.
function through(t, actor, url) {
  const u = new URL(url), port = Number(u.port || 80);
  const file = join(t.m.k8s(), `egress-harness-p-${actor}.json`);
  const rules = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).rules : [];
  if (!rules.some(r => r.http?.hostnames.includes(u.hostname) && (r.http.ports?.numbers ?? [80]).includes(port))) throw new Error(`denied: no rule allows ${u.host}`);
  if (u.hostname === 'host.docker.internal') return `http://127.0.0.1:${port}${u.pathname}`;
  const [, service, ns] = u.hostname.match(/^([a-z0-9-]+)\.([a-z0-9-]+)\.svc\.cluster\.local$/) ?? [];
  const slice = JSON.parse(readFileSync(join(t.m.k8s(), 'ns', ns, `endpointslice-${service}.json`), 'utf8'));
  assert.ok(slice.ports.some(p => p.port === port), `the Service ${service} has no port ${port}`);
  const address = slice.endpoints[0].addresses[0];
  const argv = readFileSync(join(t.m.dataRoot(), 'containers', 'harness-substrate-mac-relay', 'run.argv'), 'utf8').trim().split('\n');
  const [gw, ...ports] = argv.slice(argv.indexOf('relay') + 1);
  if (gw !== address || !ports.includes(String(port))) throw new Error(`refused: the relay does not listen on ${address}:${port}`);
  return `http://127.0.0.1:${port}${u.pathname}`;
}

// agentSh(t, name, url, argv, stdin) — the sandbox's own agent.sh (/usr/local/bin/agent.sh) run in it, with its own
// token file (/run/harness/agent-token), sending to `url` (its agent-url, carried by through()).
function agentSh(t, name, url, argv, stdin = '') {
  const q = a => `'${String(a).replace(/'/g, `'\\''`)}'`;
  const path = TOOLS.filter(Boolean).map(p => p.trim().replace(/\/[^/]+$/, '')).join(':');
  return t.inMachine(name, `export PATH="${path}:$PATH"; AGENT_FORWARDER_URL=${q(url)} AGENT_TOKEN_FILE="$HARNESS_VM_ROOT/run/harness/agent-token" "$HARNESS_VM_ROOT/usr/local/bin/agent.sh" ${argv.map(q).join(' ')}`, { stdin });
}

for (const remote of [false, true]) {
  const where = remote ? 'on a workstation\'s cluster (the Mac reached over its SSH connection, through its relay)' : 'on the Mac\'s cluster (host.docker.internal)';
  test(`AC1, AC2, AC3, AC4: ${where} — a sandbox gets its own forwarder token when it starts; only the allowlisted commands, for its own ticket variation, work with it; one egress rule reaches the forwarder, a sandbox without it cannot; deleting the sandbox revokes the token`, async () => {
    const t = await sandboxed({ remote });
    const host = remote ? 'harness-mac.harness-p.svc.cluster.local' : 'host.docker.internal';
    const lines = [];
    const server = await startForwarder({ root: ROOT, env: t.s.env, port: 0, log: (phase, text) => lines.push(`${phase} ${text}`) });
    try {
      // AC1: issued at sandbox-up — bound to ABC-3 A under the sandbox's machine name; only its hash on the Mac.
      const up = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', t.machine);
      assert.equal(up.code, 0, up.err);
      const name = up.json.machine, root = t.root('abc-3-a');
      const token = readFileSync(join(root, 'run', 'harness', 'agent-token'), 'utf8').trim();
      assert.match(token, /^[0-9a-f]{64}$/);
      const binding = t.s.tokens()[name];
      assert.deepEqual([binding.project, binding.ticket, binding.variation, binding['token-sha256']], ['p', 'ABC-3', 'A', sha(token)]);
      assert.equal(binding['ticket-folder'], realpathSync(t.s.at('projects', 'p', 'work', 'ABC-3')));
      assert.ok(!readFileSync(join(t.s.w.harnessHome, 'vm-tokens.json'), 'utf8').includes(token), 'never the token itself');
      const url = readFileSync(join(root, 'run', 'harness', 'agent-url'), 'utf8').trim();
      assert.equal(url, `http://${host}:${FORWARDER}/run`);
      assert.equal(readFileSync(join(root, 'usr', 'local', 'bin', 'agent.sh'), 'utf8'), readFileSync(CLIENT, 'utf8'), 'the forwarder\'s client, installed');
      // AC2: one egress rule for the forwarder, in the sandbox's own rule set "mac" (no Hindsight here: p has none).
      // ASS-538's set "credentials" sits beside it in the union: its rules are https to the gateway's hosts, never the Mac's.
      const policy = JSON.parse(readFileSync(join(t.m.k8s(), 'egress-harness-p-abc-3-a.json'), 'utf8'));
      assert.deepEqual(policy.rules.filter(r => !r.https), [{ http: { hostnames: [host], ports: { numbers: [FORWARDER] } } }]);
      assert.ok(policy.rules.filter(r => r.https).every(r => !r.https.hostnames.includes(host)));
      // The forwarder's real port on this machine stands in for the Mac's forwarder-port.
      const reach = target => through(t, 'abc-3-a', target).replace(`:${FORWARDER}/`, `:${server.address().port}/`);
      const ok = await agentSh(t, name, reach(url), ['ticket:questions-answered', 'p', 'ABC-3']);
      assert.notEqual(ok.code, 77, ok.err);
      assert.match(ok.out, /"ticket":"ABC-3"/);
      // A write reaches the Mac's ticket folder, and the sandbox's /mnt/ticket copy has it when agent.sh returns.
      const wrote = await agentSh(t, name, reach(url), ['work:write', 'p', 'ABC-3', 'A', 'notes.md'], 'from the sandbox\n');
      assert.equal(wrote.code, 0, wrote.err);
      assert.equal(readFileSync(t.s.at('projects', 'p', 'work', 'ABC-3', 'notes-A.md'), 'utf8'), 'from the sandbox\n');
      assert.ok(existsSync(join(root, 'mnt', 'ticket', 'notes-A.md')), lines.join('\n'));
      assert.equal(readFileSync(join(root, 'mnt', 'ticket', 'notes-A.md'), 'utf8'), 'from the sandbox\n');
      // Only the allowlisted commands, and only for its own ticket variation; without its token, nothing.
      for (const [argv, why] of [[['project:clear-rate-limit', 'p'], /command not allowed: project:clear-rate-limit/], [['ticket:questions-answered', 'p', 'ABC-4'], /ticket "ABC-4" is not this VM's ABC-3/],
        [['work:write', 'p', 'ABC-3', 'B', 'notes.md'], /variation "B" is not this VM's A/]]) {
        const r = await agentSh(t, name, reach(url), argv);
        assert.equal(r.code, 77, argv.join(' '));
        assert.match(r.err, why);
      }
      const none = await t.inMachine(name, `AGENT_FORWARDER_URL='${reach(url)}' AGENT_TOKEN_FILE=/nonexistent "$HARNESS_VM_ROOT/usr/local/bin/agent.sh" ticket:questions-answered p ABC-3`);
      assert.match(none.err, /refused by the host: no token/);
      // Another variation's sandbox: its own token, which works for B alone — never for A.
      const b = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'B', t.machine);
      assert.equal(b.code, 0, b.err);
      const tokenB = readFileSync(join(t.root('abc-3-b'), 'run', 'harness', 'agent-token'), 'utf8').trim();
      assert.notEqual(tokenB, token);
      assert.equal(t.s.tokens()[b.json.machine].variation, 'B');
      assert.match((await agentSh(t, b.json.machine, reach(url), ['work:write', 'p', 'ABC-3', 'A', 'notes.md'])).err, /variation "A" is not this VM's B/);
      // A sandbox with no rule set "mac" has no way to the forwarder (egress is default deny).
      const egress = (actor, set, rules) => new Promise((resolve, reject) => {
        const child = spawn('bash', ['-c', `source "${join(ROOT, 'src', 'agent-cli', 'substrate', 'sandbox.bash')}"; e="$(substrate_entry t p "$0")"; substrate_on p "$0" "$e" sandbox-egress "$1" "$2"`, t.machine, actor, set], { env: t.s.env });
        let out = ''; child.stdout.on('data', d => { out += d; }); child.on('close', code => (code ? reject(new Error(out)) : resolve(out))); child.stdin.end(rules);
      });
      await egress('abc-3-b', 'mac', '[]');
      const left = JSON.parse(readFileSync(join(t.m.k8s(), 'egress-harness-p-abc-3-b.json'), 'utf8')).rules;
      assert.ok(left.length > 0 && left.every(r => r.https), 'only its other set (ASS-538\'s credentials) is left');
      await egress('abc-3-b', 'credentials', '[]');
      assert.ok(!existsSync(join(t.m.k8s(), 'egress-harness-p-abc-3-b.json')), 'its policy removed with its last rule set');
      assert.throws(() => through(t, 'abc-3-b', url), /denied/);
      assert.doesNotThrow(() => through(t, 'abc-3-a', url), 'A keeps its own');
      // Another part's rule set beside "mac" (ASS-538's credentials, say): the policy is the union; either kept apart.
      const forge = { http: { hostnames: ['gitlab.example.com'], ports: { numbers: [80] } } };
      await egress('abc-3-a', 'credentials', JSON.stringify([forge]));
      const rulesOf = () => JSON.parse(readFileSync(join(t.m.k8s(), 'egress-harness-p-abc-3-a.json'), 'utf8')).rules.filter(r => r.http);
      assert.equal(rulesOf().length, 2);
      assert.ok(rulesOf().some(r => r.http.hostnames[0] === 'gitlab.example.com') && rulesOf().some(r => r.http.hostnames[0] === host));
      await egress('abc-3-a', 'credentials', '[]');
      assert.deepEqual(rulesOf(), [{ http: { hostnames: [host], ports: { numbers: [FORWARDER] } } }]);
      // AC3: deleted — its binding gone; the token it held is refused (unknown), though the forwarder still runs.
      const del = await t.call('substrate:sandbox-delete', 'p', 'ABC-3', 'A');
      assert.equal(del.code, 0, del.err);
      assert.equal(t.s.tokens()[name], undefined);
      assert.ok(t.s.tokens()[b.json.machine], 'B\'s stays');
      const res = await fetch(`http://127.0.0.1:${server.address().port}/run`, { method: 'POST', body: JSON.stringify({ token, argv: ['ticket:questions-answered', 'p', 'ABC-3'] }) });
      assert.equal(res.status, 403);
      assert.match(await res.text(), /unknown token/);
      // A new sandbox-up issues a new token and replaces the binding (as every vm:start does).
      const again = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'B', t.machine);
      assert.equal(again.code, 0, again.err);
      assert.notEqual(t.s.tokens()[b.json.machine]['token-sha256'], sha(tokenB));
    } finally { server.close(); }
  });
}

for (const remote of [false, true]) {
  const where = remote ? 'on a (fake) workstation\'s cluster, through its relay' : 'on the Mac\'s cluster';
  test(`AC5: ${where} — an agent in a sandbox gets its project's Hindsight MCP endpoint and can retain and recall through it; nothing else on the Mac is reachable that way (no other port, no other project's Hindsight, not the registry)`, async () => {
    const h = await fakeHindsight();
    try {
      const t = await sandboxed({ remote, hindsight: h.port });
      const host = remote ? 'harness-mac.harness-p.svc.cluster.local' : 'host.docker.internal';
      const up = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', t.machine);
      assert.equal(up.code, 0, up.err);
      const name = up.json.machine;
      // The agent's --mcp-config, as control's dispatch gives it (memoryFor): the bank at the Mac's name for that cluster.
      assert.equal(macHost(name.slice('substrate:'.length)), host);
      const lines = [];
      const config = await memoryFor({ log: (...a) => lines.push(a.join(' ')) }, { id: 'p', json: { hindsight: { port: h.port } } }, name, t.s.at('session'));
      const url = config.mcpServers.hindsight.url;
      assert.equal(url, `http://${host}:${h.port}/mcp/p/`);
      assert.deepEqual(lines, [], 'no "memory unavailable"');
      // Its egress: exactly the forwarder's port and its project's Hindsight's, on that name.
      const policy = JSON.parse(readFileSync(join(t.m.k8s(), 'egress-harness-p-abc-3-a.json'), 'utf8'));
      assert.deepEqual(policy.rules.filter(r => r.http).map(r => [r.http.hostnames, r.http.ports.numbers]).sort(), [[[host], [FORWARDER]], [[host], [h.port]]].sort());
      assert.ok(policy.rules.filter(r => !r.http).every(r => r.https && !r.https.hostnames.includes(host)), 'beside it only ASS-538\'s https set, never the Mac');
      if (remote) {
        // The relay carries those two ports alone — not the registry's (9), which the SSH connection forwards too.
        const argv = readFileSync(join(t.m.dataRoot(), 'containers', 'harness-substrate-mac-relay', 'run.argv'), 'utf8').trim().split('\n');
        assert.deepEqual(argv.slice(argv.indexOf('relay') + 1), ['172.18.0.1', String(FORWARDER), String(h.port)]);
        assert.ok(argv.includes('--network') && argv.includes('host') && argv.includes('--restart=always'));
        assert.match(argv.find(a => a.includes('TCP-LISTEN')), /TCP-LISTEN:\$p,bind=\$gw,reuseaddr,fork" "TCP:127\.0\.0\.1:\$p"/);
        assert.match(argv.find(a => a.startsWith('docker.io/alpine/socat')), /@sha256:[0-9a-f]{64}$/);
        const svc = JSON.parse(readFileSync(join(t.m.k8s(), 'ns', 'harness-p', 'service-harness-mac.json'), 'utf8'));
        assert.deepEqual(svc.spec.ports.map(p => p.port), [FORWARDER, h.port]);
        assert.equal(svc.spec.selector, undefined, 'no selector: its EndpointSlice is the relay');
      }
      // retain and recall, from inside the sandbox, through the path its rules allow (MCP tools/call, JSON-RPC).
      const mcp = (tool, args) => t.inMachine(name, `curl -sS -X POST -H 'content-type: application/json' --data-binary @- '${through(t, 'abc-3-a', url)}'`,
        { stdin: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) });
      const kept = await mcp('retain', { content: 'Sandboxes reach Hindsight through their egress rule', document_id: 'ass-536-reach' });
      assert.equal(kept.code, 0, kept.err);
      const found = await mcp('recall', { query: 'sandboxes egress' });
      assert.match(JSON.parse(found.out).result.content[0].text, /Sandboxes reach Hindsight/);
      assert.deepEqual(h.banks.get('p').map(u => u.document_id), ['ass-536-reach']);
      // Nothing else of the Mac through that path: another port (the registry's, another project's Hindsight), another name.
      for (const other of [`http://${host}:9/v2/`, `http://${host}:${h.port + 1}/mcp/other/`, `http://host.docker.internal:22/`, `http://example.com/`]) {
        assert.throws(() => through(t, 'abc-3-a', other), /denied/, other);
      }
    } finally { await h.close(); }
  });
}
