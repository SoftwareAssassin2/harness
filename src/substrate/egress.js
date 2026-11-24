// ASS-538: a project's Substrate sandboxes reach the outside only through Substrate's egress gateway, which is
// default-deny (ASS-532 section 8), and get their credentials there: no Claude, Anthropic, GitLab or GitHub token
// ever sits inside a sandbox. This module says what a project's sandboxes may reach and what the gateway puts into
// their requests; agent-cli/substrate/egress.js prints it for the bash commands, and control reads it to tell when
// a cluster's copy is out of date (src/control/substrate.js).
//
// The allowlist (allowlist): the hosts a project's sandboxes may reach, each over HTTPS on 443 through the gateway
// (an `https` rule: the gateway terminates the sandbox's TLS, decides each request against the policy and
// re-originates it, so it can read and change headers; the sandbox trusts the gateway's CA through the trust bundle
// its template projects: on-machine substrate.sh sandbox-template). By default, what its repositories and
// credentials need:
//   - each repository's forge host (project.json repositories[].url: https, ssh:// or git@host: — git in a sandbox
//     always uses HTTPS, as no other TCP passes the gateway); on github.com, the hosts git and npm reach behind it too
//     (api.github.com, codeload.github.com, *.githubusercontent.com);
//   - the model API, api.anthropic.com, always (an agent turn needs it, whichever login the project declares);
//   - the declared GitLab's host (~/.harness/vm-credentials.json gitlab.host, gitlab.com by default), where its npm
//     registries (gitlab.npm-registries) live too; GitHub's hosts when github is declared;
//   - the public npm registry, registry.npmjs.org (the package registry every JavaScript project's installs reach);
// plus the project's own additions, project.json's dev-environments.substrate.egress.allow (host names, or a
// wildcard first label, as Substrate's hostnames take them: egressErrors checks each). Anything else is refused: a
// name with no rule gets NXDOMAIN from the sandbox's DNS relay, which Substrate does not log (the gap is documented
// in README's "Credentials through the egress gateway"); a refusal the gateway decides (a listed name on another
// port, an address dialled directly) is logged by its ext-proc, which substrate:health reads into substrate.json's
// egress.denied and control logs (src/control/substrate.js).
//
// The credentials (injections): for the kinds the project declares, the gateway replaces a header the sandbox sends
// with a placeholder by the token, read by the k8s.io credential provider from a Kubernetes Secret in the project's
// namespace (harness-<project>; SECRETS below), which substrate:credentials keeps in step with the keychain item
// (the same item vm:credentials reads). The gateway replaces a header only when the request carries it, and one
// header has one value per host, so each host gets one scheme per header:
//   api.anthropic.com   x-api-key ← anthropic's key (Claude Code with ANTHROPIC_API_KEY);
//                       Authorization ← "Bearer " + claude's token (Claude Code with CLAUDE_CODE_OAUTH_TOKEN)
//   <gitlab host>       Authorization ← "Basic " + base64("oauth2:" + token): git over HTTPS, and npm through
//                       _auth (the gateway prefixes, it never encodes, so the Secret holds the encoded value:
//                       ASS-532); PRIVATE-TOKEN ← the token (glab and the API)
//   github.com          Authorization ← "Basic " + base64("x-access-token:" + token): git over HTTPS
//   api.github.com      Authorization ← "Bearer " + the token (gh)
// The sandbox holds only placeholders (placeholderScript): the env names Claude Code, git, gh, glab and npm read,
// each set to PLACEHOLDER's value, a git credential helper per forge answering with a placeholder password, and
// insteadOf rules turning SSH remotes into HTTPS.
//
// The policy: a sandbox's EgressPolicy is one object per actor (Substrate's singleton "default"), which more than one
// part of the harness gives rules to. ASS-536 made each part's rules a named set on the cluster's machine (on-machine
// substrate.sh sandbox-egress <actor> <set>), the policy always their union: ASS-536's set is `mac` (the Mac's
// forwarder and Hindsight, at host.docker.internal or harness-mac.<namespace>.svc.cluster.local), this ticket's is
// `credentials` (credentialRules; EGRESS_SETS, egressPolicy). Two sets must never decide one host and port: the
// allowlist refuses the `mac` set's names (MAC_HOSTS), and egressPolicy refuses a tie between the sets it composes.
import { createHash } from 'node:crypto';

export const PLACEHOLDER = 'harness-placeholder';
// The placeholders shaped as the tokens are, so a client checking a token's form before sending it is satisfied.
export const PLACEHOLDERS = Object.freeze({
  claude: 'sk-ant-oat01-harness-placeholder', anthropic: 'sk-ant-api03-harness-placeholder', gitlab: `glpat-${PLACEHOLDER}`, github: `ghp_${PLACEHOLDER}`,
});
export const MODEL_API = 'api.anthropic.com';
export const NPM_REGISTRY = 'registry.npmjs.org';
export const GITHUB_HOSTS = Object.freeze(['github.com', 'api.github.com', 'codeload.github.com', '*.githubusercontent.com']);
export const TRUST_BUNDLE = '/run/ate/egress-trust-bundle/trust-bundle.pem';
// The kinds whose tokens go through the gateway, and the Secret each is kept in: { name, keys } — the keys the
// Secret holds (basic: the pre-encoded Basic value, with its user).
export const SECRETS = Object.freeze({
  claude: { name: 'harness-credential-claude', keys: ['token'] },
  anthropic: { name: 'harness-credential-anthropic', keys: ['key'] },
  gitlab: { name: 'harness-credential-gitlab', keys: ['token', 'basic'], user: 'oauth2' },
  github: { name: 'harness-credential-github', keys: ['token', 'basic'], user: 'x-access-token' },
});
export const INJECTED = Object.freeze(Object.keys(SECRETS));
const at = 'dev-environments.substrate.egress';
// ASS-536's `mac` set's names: never in this set (a tie on a host and port is refused at admission).
export const MAC_HOSTS = Object.freeze(['host.docker.internal', '*.svc.cluster.local']);
const macHost = h => h === 'host.docker.internal' || h.endsWith('.svc.cluster.local');
// Substrate's hostname pattern: a lowercase DNS name, or one with "*" as its whole first label.
const HOSTNAME = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const validHost = h => typeof h === 'string' && h.length <= 253 && HOSTNAME.test(h) && h !== '*';

// egressErrors(json) — what is wrong with project.json `json`'s dev-environments.substrate.egress, each naming the
// field: not an object, allow not a list, an entry not a host name (Substrate's pattern), an unknown field. [] when
// there is none or nothing is wrong (substrate-config.js substrateErrors includes these).
export function egressErrors(json) {
  const e = json?.['dev-environments']?.substrate?.egress;
  if (e === undefined || e === null) return [];
  if (typeof e !== 'object' || Array.isArray(e)) return [`${at} is not an object`];
  const errors = [];
  if (e.allow !== undefined) {
    if (!Array.isArray(e.allow)) errors.push(`${at}.allow is not a list`);
    else for (const [i, h] of e.allow.entries()) {
      if (!validHost(h)) errors.push(`${at}.allow[${i}] ${JSON.stringify(h)} is not a host name (lower case, no scheme, port or path; "*." only as its first label)`);
      else if (macHost(h)) errors.push(`${at}.allow[${i}] ${JSON.stringify(h)} is the Mac's, which the sandbox reaches through its own rule set (ASS-536's "mac"), never this list`);
    }
  }
  for (const f of Object.keys(e)) if (f !== 'allow') errors.push(`${at}.${f} is not an egress setting (allow)`);
  return errors;
}

// hostOf(url) — a repository URL's host, lower case: https://host/…, ssh://user@host:port/…, user@host:path; null
// for anything else.
export function hostOf(url) {
  const s = String(url ?? '').trim();
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(s) ?? /^[^@/:]+@([^/:]+):/.exec(s);
  const h = m?.[1]?.toLowerCase();
  return h && validHost(h) ? h : null;
}

const gitlabHost = decl => (decl?.gitlab ? (typeof decl.gitlab.host === 'string' && decl.gitlab.host.trim() ? decl.gitlab.host.trim().toLowerCase() : 'gitlab.com') : null);
const declares = (decl, kind) => Boolean(decl?.[kind]?.['keychain-service']);

// allowlist(json, decl) — the hosts the project's sandboxes may reach (see the module comment), each { host, why },
// sorted by host, no host twice (its reasons joined). `decl` is the project's ~/.harness/vm-credentials.json entry
// (null: none declared).
export function allowlist(json, decl) {
  const hosts = new Map();
  const add = (host, why) => { if (validHost(host) && !macHost(host)) hosts.set(host, [...new Set([...(hosts.get(host) ?? []), why])]); };
  for (const r of Array.isArray(json?.repositories) ? json.repositories : []) {
    const h = hostOf(r?.url);
    if (!h) continue;
    add(h, 'a repository');
    if (h === 'github.com') for (const g of GITHUB_HOSTS) add(g, 'a repository on GitHub');
  }
  add(MODEL_API, 'the model API');
  const gl = gitlabHost(decl);
  if (gl && declares(decl, 'gitlab')) add(gl, decl.gitlab['npm-registries'] && Object.keys(decl.gitlab['npm-registries']).length ? 'the gitlab credential and its npm registries' : 'the gitlab credential');
  if (declares(decl, 'github')) for (const g of GITHUB_HOSTS) add(g, 'the github credential');
  add(NPM_REGISTRY, 'the npm registry');
  const extra = json?.['dev-environments']?.substrate?.egress?.allow;
  for (const h of Array.isArray(extra) ? extra : []) add(h, `${at}.allow`);
  return [...hosts].map(([host, why]) => ({ host, why: why.join(', ') })).sort((a, b) => a.host.localeCompare(b.host));
}

// credentialUri(namespace, kind, key) — the k8s.io provider's URI of a Secret's key in the project's namespace.
export const credentialUri = (namespace, kind, key) => `ate-secret://k8s.io/default/${namespace}/${SECRETS[kind].name}/${key}`;

// injections(decl, namespace) — host → the replaceHeaders entries the gateway applies there, for the kinds declared
// (see the module comment).
export function injections(decl, namespace) {
  const by = new Map();
  const put = (host, header, kind, key, prefix) => by.set(host, [...(by.get(host) ?? []), { header, ...(prefix ? { prefix } : {}), credentialUri: credentialUri(namespace, kind, key) }]);
  if (declares(decl, 'anthropic')) put(MODEL_API, 'x-api-key', 'anthropic', 'key');
  if (declares(decl, 'claude')) put(MODEL_API, 'Authorization', 'claude', 'token', 'Bearer ');
  const gl = gitlabHost(decl);
  if (gl && declares(decl, 'gitlab')) { put(gl, 'Authorization', 'gitlab', 'basic', 'Basic '); put(gl, 'PRIVATE-TOKEN', 'gitlab', 'token'); }
  if (declares(decl, 'github')) {
    if (gl !== 'github.com') put('github.com', 'Authorization', 'github', 'basic', 'Basic ');
    put('api.github.com', 'Authorization', 'github', 'token', 'Bearer ');
  }
  return by;
}

// credentialRules(json, decl, namespace) — the `credentials` rule set: one https rule (port 443) per distinct set of
// injections, its hosts together; the allowed hosts with none in one rule of their own.
export function credentialRules(json, decl, namespace) {
  const inj = injections(decl, namespace), groups = new Map();
  for (const { host } of allowlist(json, decl)) {
    const effects = inj.get(host) ?? null;
    const k = JSON.stringify(effects);
    groups.set(k, { effects, hosts: [...(groups.get(k)?.hosts ?? []), host] });
  }
  return [...groups.values()].map(({ effects, hosts }) => ({ https: { hostnames: hosts, ports: { numbers: [443] }, ...(effects ? { effects: { replaceHeaders: effects } } : {}) } }));
}

// EGRESS_SETS — the rule sets made here, each (json, decl, namespace) → rules, applied as the sandbox's set of that
// name (ASS-536's `mac` is made by sandbox.bash and applied beside it).
export const EGRESS_SETS = { credentials: credentialRules };

// ruleKeys(rule) — each "<host>:<port>" a rule decides (all ports as "*").
const ruleKeys = rule => {
  const r = rule.http ?? rule.https ?? rule.tls_passthrough ?? rule.tlsPassthrough ?? {};
  const ports = r.ports?.all ? ['*'] : (r.ports?.numbers ?? [rule.http ? 80 : 443]);
  return (r.hostnames ?? []).flatMap(h => ports.map(p => `${h}:${p}`));
};

// egressPolicy(json, decl, namespace, sets) — { rules }: every set's rules, in EGRESS_SETS' order; throws, naming
// both sets, when two decide one host and port (Substrate refuses such a policy at admission).
export function egressPolicy(json, decl, namespace, sets = EGRESS_SETS) {
  const rules = [], owner = new Map();
  for (const [name, make] of Object.entries(sets)) {
    for (const rule of make(json, decl, namespace)) {
      for (const k of ruleKeys(rule)) {
        if (owner.has(k)) throw new Error(`egress rule sets ${owner.get(k)} and ${name} both decide ${k}`);
        owner.set(k, name);
      }
      rules.push(rule);
    }
  }
  return { rules };
}

// policyHash(policy) — a short hash of a policy, recorded with the cluster's credentials (substrate.json
// <machine>.credentials.policy-hash) so control sees the allowlist or the declaration change.
export const policyHash = policy => createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);

// q(s) — a word single-quoted for bash.
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// placeholderScript(json, decl) — a bash script, run as root in the sandbox (its / under ${HARNESS_VM_ROOT-} in the
// tests), that writes what its tools need to go through the gateway, and no token:
//   /etc/profile.d/harness-credentials.sh   every login shell's (the command server's commands run in one): the
//       trust bundle for node, git, curl and Python; Claude Code's non-essential traffic off (only the model API is
//       allowed); the placeholder of each declared kind (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, GH_TOKEN,
//       GITLAB_TOKEN + GITLAB_HOST); NPM_CONFIG_USERCONFIG
//   /etc/harness/gitconfig (included from git's system config): the git identity when declared; per forge with a
//       declared credential a helper answering username + a placeholder password (git then sends Basic, which the
//       gateway replaces); for every forge host, insteadOf rules turning SSH remotes into HTTPS
//   /etc/harness/npmrc: the declared GitLab npm registries, their auth a placeholder Basic value (_auth)
export function placeholderScript(json, decl) {
  const lines = ['set -euo pipefail', 'R="${HARNESS_VM_ROOT-}"', 'mkdir -p "$R/etc/harness" "$R/etc/profile.d"'];
  const env = [
    '# Written by the harness (ASS-538, substrate:sandbox-up): no token here. Requests go out through Substrate\'s',
    '# egress gateway, which replaces each placeholder below by the real credential.',
    `if [ -r ${TRUST_BUNDLE} ]; then`,
    ...['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'GIT_SSL_CAINFO', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE'].map(v => `  export ${v}=${TRUST_BUNDLE}`),
    'fi',
    'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'export NPM_CONFIG_USERCONFIG=/etc/harness/npmrc',
  ];
  if (declares(decl, 'claude')) env.push(`export CLAUDE_CODE_OAUTH_TOKEN=${PLACEHOLDERS.claude}`);
  if (declares(decl, 'anthropic')) env.push(`export ANTHROPIC_API_KEY=${PLACEHOLDERS.anthropic}`);
  if (declares(decl, 'github')) env.push(`export GH_TOKEN=${PLACEHOLDERS.github}`);
  const gl = gitlabHost(decl);
  if (gl && declares(decl, 'gitlab')) env.push(`export GITLAB_TOKEN=${PLACEHOLDERS.gitlab}`, `export GITLAB_HOST=${gl}`);
  const git = [];
  const name = decl?.git?.['user-name'], email = decl?.git?.['user-email'];
  if (typeof name === 'string' && name && typeof email === 'string' && email) git.push('[user]', `\tname = ${JSON.stringify(name)}`, `\temail = ${JSON.stringify(email)}`);
  const helper = (user, kind) => `!f() { test "$1" = get && echo username=${user} && echo password=${PLACEHOLDERS[kind]}; }; f`;
  const forges = new Set(allowlist(json, decl).map(a => a.host).filter(h => h === gl || h === 'github.com' || (Array.isArray(json?.repositories) && json.repositories.some(r => hostOf(r?.url) === h))));
  for (const host of [...forges].filter(h => !h.startsWith('*.')).sort()) {
    const kind = host === gl && declares(decl, 'gitlab') ? 'gitlab' : host === 'github.com' && declares(decl, 'github') ? 'github' : null;
    if (kind) git.push(`[credential "https://${host}"]`, `\thelper = ${JSON.stringify(helper(SECRETS[kind].user, kind))}`);
    git.push(`[url "https://${host}/"]`, `\tinsteadOf = git@${host}:`, `\tinsteadOf = ssh://git@${host}/`);
  }
  const npm = [];
  if (gl && declares(decl, 'gitlab')) {
    const auth = Buffer.from(`${SECRETS.gitlab.user}:${PLACEHOLDERS.gitlab}`).toString('base64');
    for (const [scope, id] of Object.entries(decl.gitlab['npm-registries'] ?? {})) {
      if (!/^@[a-z0-9._-]+$/.test(scope) || !/^[0-9]+$/.test(String(id))) throw new Error(`invalid gitlab npm registry '${scope}': '${id}'`);
      npm.push(`${scope}:registry=https://${gl}/api/v4/projects/${id}/packages/npm/`, `//${gl}/api/v4/projects/${id}/packages/npm/:_auth=${auth}`);
    }
  }
  const file = (path, body) => lines.push(`printf '%s\\n' ${body.map(q).join(' ')} > "$R${path}"`, `chmod 0644 "$R${path}"`);
  file('/etc/profile.d/harness-credentials.sh', env);
  file('/etc/harness/gitconfig', git.length ? git : ['# no forge credential or identity declared']);
  file('/etc/harness/npmrc', npm.length ? npm : ['# no GitLab npm registry declared']);
  // Included from git's system config: /etc/gitconfig, and the one this git reads (a git built from source, as the
  // image's git.sh builds it, reads /usr/local/etc/gitconfig: seen in ASS-538's check).
  lines.push('sys="$(git var GIT_CONFIG_SYSTEM 2>/dev/null || true)"',
    'for f in /etc/gitconfig ${sys:+"$sys"}; do',
    '  mkdir -p "$R$(dirname "$f")" && touch "$R$f"',
    '  grep -qF "path = /etc/harness/gitconfig" "$R$f" || printf \'[include]\\n\\tpath = /etc/harness/gitconfig\\n\' >> "$R$f"',
    'done');
  return `${lines.join('\n')}\n`;
}
