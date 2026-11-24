// A stand-in for Substrate's egress gateway (ASS-538), over a fake cluster's state (fake-substrate.js: each actor's
// egress policy, the project's Secrets, the credential provider's namespace policy), for the tests to send a
// sandbox's request "out" and see what the upstream would get. It follows what Substrate documents and what the
// ASS-532 spike saw on the real gateway (docs/spikes/ASS-532-substrate.md section 8; Substrate's
// docs/guides/egress-credential-injection.md):
//   - a request goes out only when a rule of the actor's policy decides its host and port: the most specific
//     hostname (exact over a "*." wildcard) on a matching port (443 for https by default); a name no rule lists
//     does not resolve (NXDOMAIN from the sandbox's DNS relay, which logs nothing); a listed name on another port
//     is refused by the gateway, which logs "egress denied: no rule allows the destination" with the actor;
//   - the deciding rule's replaceHeaders replace a header only when the request carries it (by name, any case):
//     its value becomes prefix + the credential, read from the Secret its ate-secret://k8s.io/default/<ns>/<secret>/
//     <key> URI names — 403 when the atespace's namespace policy does not grant <ns> or the Secret or key is missing;
//   - a request without the header goes out untouched.
// The provider reads a Secret at request time (its cache, 10 s at most, is not modelled), so a Secret applied again
// reaches the next request, with no sandbox restarted.
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const read = f => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
const matches = (pattern, host) => (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) && !host.slice(0, -pattern.length + 1).includes('.') && host.length > pattern.length - 1 : pattern === host);

// fakeGateway(k8s, atespace) — { request(actor, { host, port, headers }) → { status, denied?, logged?, headers? } }.
export function fakeGateway(k8s, atespace) {
  const policyOf = actor => read(join(k8s, `egress-${atespace}-${actor}.json`));
  const grants = () => {
    const cm = read(join(k8s, 'configmaps', 'ate-system-k8s-credential-provider-namespace-policy.json'));
    const text = cm?.data?.['namespace-policy.yaml'] ?? '';
    const body = text.split('\n').filter(l => !/^\s*#/.test(l) && l.trim()).join('\n');
    try { return JSON.parse(body).policies ?? []; } catch { return []; }
  };
  const credential = uri => {
    const m = /^ate-secret:\/\/k8s\.io\/default\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
    if (!m) return { status: 500 };
    const [, ns, secret, key] = m;
    if (!grants().some(p => p.atespace === atespace && (p.allowedNamespaces ?? []).includes(ns))) return { status: 403 };
    const value = read(join(k8s, 'ns', ns, `secret-${secret}.json`))?.stringData?.[key];
    return value ? { value } : { status: 403 };
  };
  return {
    request(actor, { host, port = 443, headers = {} }) {
      const rules = policyOf(actor)?.rules ?? [];
      const candidates = rules.map(r => r.https ?? r.http).filter(Boolean).filter(r => r.hostnames.some(h => matches(h, host)));
      if (!candidates.length) return { status: 0, denied: 'NXDOMAIN: no rule lists the name (the DNS relay logs nothing)' };
      const onPort = candidates.filter(r => r.ports?.all || (r.ports?.numbers ?? [443]).includes(port));
      const rule = onPort.find(r => r.hostnames.includes(host)) ?? onPort[0];
      if (!rule) {
        // The gateway's ext-proc logs JSON (as seen on the real one in ASS-538's check).
        const line = JSON.stringify({ time: new Date().toISOString(), level: 'WARN', msg: 'egress denied: no rule allows the destination', actor: { type: '*ateapi.Actor', atespace, name: actor }, leg: 'egress_tls', host, dialedPort: port, rule: -1 });
        appendFileSync(join(k8s, 'egress.log'), `${line}\n`);
        return { status: 403, denied: 'no rule allows the destination', logged: line };
      }
      const out = { ...headers };
      for (const inj of rule.effects?.replaceHeaders ?? []) {
        const name = Object.keys(out).find(h => h.toLowerCase() === inj.header.toLowerCase());
        if (name === undefined) continue;
        const c = credential(inj.credentialUri);
        if (!c.value) return { status: c.status, denied: `credential ${inj.credentialUri} refused` };
        delete out[name];
        out[inj.header] = `${inj.prefix ?? ''}${c.value}`;
      }
      return { status: 200, headers: out };
    },
  };
}
