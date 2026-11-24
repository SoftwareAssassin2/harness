// A project's sandbox declaration (ASS-534): data/projects/<project>/sandbox/,
// gitignored as every project folder is — a project's services, versions and
// config overrides are its own private details and never enter the harness
// repo. Its services.yaml says what the project's Substrate sandbox image
// carries besides the golden definition (git.sh and provision.sh): each
// service's files, copied out of the image the project's own dev stack pins
// (by tag and digest) rather than built from source, so a sandbox runs the
// very versions the project's compose and dev container run.
//
//   architectures: [amd64]          # the image's builds, amd64 and/or arm64 (required)
//   base: { image: debian:trixie, digest: sha256:… }   # optional; the golden VM's distribution by default
//   provision: provision.sh         # optional: a file of this folder run instead of the golden
//                                   # definition's provision.sh (one that cannot run in a container
//                                   # or for another architecture); the golden one by default
//   packages: [libicu76]            # optional: Debian packages the services' files need
//   files:                          # optional: config overrides, files of this folder put in the image
//     - { from: files/Caddyfile, to: /etc/sandbox/caddy/Caddyfile }
//   services:
//     - name: postgres              # [a-z0-9-], unique
//       kind: service               # service (started, kept running) | job (run once, in order) |
//                                   # toolchain (files only, nothing to start); service by default
//       version: "18.6"             # the version it is (required: the declaration says what runs)
//       image: <registry>/<path>:<tag>   # the pinned image its files come from: name and tag ... (ASS-542:
//                                        # a service or job run from what the image has already — a
//                                        # repository's dev server — declares no image, digest or paths)
//       digest: sha256:<64 hex>          # ... and digest (both required; an image pinned only as
//                                        # `latest` is still pinned by its digest)
//       architectures: [amd64]      # optional: the platforms the image offers; an image
//                                   # architectures: lists but this one does not is an error
//       paths:                      # what to take (required): an absolute path, copied to the same
//         - /usr/lib/postgresql/18  # path, or { from, to } — `from: /` takes the whole filesystem;
//                                   # services declaring the very same copy (image, digest, path)
//                                   # share it: it is copied once
//         - { from: /, to: /opt/sandbox/rootfs/postgres }
//       packages: [libxml2]         # optional, as above
//       env: { PGDATA: /var/lib/sandbox/postgres }   # optional, its start's environment
//       user: agent                 # optional: who it runs as (agent by default)
//       workdir: /                  # optional: where it starts
//       start: "postgres -D $PGDATA"   # how it starts: a shell command or an argv list
//                                      # (required for a service or job; none for a toolchain)
//       ready: "pg_isready -h 127.0.0.1"   # optional: a service is up once this exits 0
//       after: [other-service]      # optional: what starts (or, a job, finishes) first
//       ports: [5432]               # optional: what it listens on; one port, one service
//       aliases: [db]               # optional (ASS-542): more names it answers to — the project's own
//                                   # names for it (a compose service name, say) — mapped to 127.0.0.1
//       ready-seconds: 300          # optional (ASS-542): how long its ready check may take (180 by default)
//
// ASS-542: the stack a ticket's sandbox runs — every service and job above,
// started in `after` order when the sandbox first starts (sandbox-services up)
// — and how it is reached and used, also declared here:
//
//   hosts: [app.example.internal]   # optional: the project's local hostnames, mapped to 127.0.0.1 in
//                                   # the sandbox (/etc/hosts) with every service's name and aliases
//   ca:                             # optional: the project's local CA, trusted in the sandbox (the
//     cert: /var/lib/sandbox/proxy/root.crt   # system's store, NODE_EXTRA_CA_CERTS, the agent's NSS
//     after: proxy                  # database for Chromium) once the service that makes it is up
//   app:                            # optional: the app's real local URL, which must answer (any
//     url: https://app.example.internal/   # status below 500, the CA trusted) for the stack to be up
//     after: [web]                  # what serves it; ready-seconds (600) how long it may take
//   login:                          # optional: how an agent's browser signs in (sandbox-login):
//     url: https://app.example.internal/   # where it starts; it fills the sign-in form it lands on
//     username: dev@example.local   # the seeded user (a local stack's own, never a real account)
//     password: …
//     click-first: "button"         # optional: clicked first when the page shows it (an auth proxy's
//                                   # own "Sign in with ..." page before the identity server's form)
//     username-field: "#username"   # optional selectors, a Keycloak form's by default:
//     password-field: "#password"   #   #username, #password, #kc-login
//     submit: "#kc-login"
//     signed-in: https://app.example.internal/   # optional: the URL prefix it lands at, signed in
//                                   # (the url's origin by default)
//     env: { PATH: …, NODE_PATH: … }   # optional: where node and the playwright package are
//   prepare:                        # optional: run in the image at build time, as agent, after the
//     - name: web-deps              # repositories (a sandbox has no egress: what a step needs from
//       workdir: /repos/web         # the network is fetched here). npm: true gives it the project's
//       run: pnpm install --frozen-lockfile   # GitLab npm registries (vm-credentials.json gitlab's
//       npm: true                   # npm-registries, its token) as a BuildKit secret user config,
//       env: { PATH: … }            # NPM_CONFIG_USERCONFIG: no token reaches a layer
//   suites:                         # optional: the project's test suites that ran under compose, run
//     - name: api-e2e               # against the sandbox's own stack (sandbox-services suite <name>)
//       workdir: /repos/web
//       run: pnpm nx e2e api-e2e
//       env: { BASE_URL: https://api.example.internal }
//       after: [api]                # what must be up first
//       docker: true                # a `docker` on its PATH that stands in for compose against the
//                                   # stack (image/sandbox-docker: up/ps/wait check, exec runs locally)
//       timeout-seconds: 1800
//
// validateServices(declaration, { folder, exists }) returns the problems, one
// string each naming its entry — "services[3] (keycloak): digest must be
// sha256:<64 hex>" — as registry:arm64-build names an arm64-images entry;
// normalizeServices gives the declaration with every default filled in, each
// path { from, to } and each start an argv (a shell command as bash -c: not a login shell, whose profile would reset the declared env's PATH).
// readServices(folder) reads and checks a folder's services.yaml, throwing an
// Error listing every problem. src/substrate/services-cli.js is the bash
// commands' way in (sandbox-image.bash sandbox_definition).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, isAbsolute } from 'node:path';

let YAML;
try { YAML = await import('yaml'); } catch (error) {
  throw new Error(`the yaml package is missing (${error.code ?? error.message}): run \`npm ci\` in the harness folder (ASS-524)`);
}

export const SERVICES_FILE = 'services.yaml';
export const ARCHITECTURES = ['amd64', 'arm64'];
export const KINDS = ['service', 'job', 'toolchain'];
// The golden VMs are Debian trixie cloud images (each project's template.yaml);
// a sandbox starts from the same distribution, pinned by the index's digest.
export const DEFAULT_BASE = { image: 'debian:trixie', digest: 'sha256:9c6e381421d0f48d1b8133e573f33c185ee16cbf505eda9c4a8a4791b25ea8a6' };

const TOP_KEYS = ['architectures', 'base', 'provision', 'packages', 'files', 'services', 'hosts', 'ca', 'app', 'login', 'prepare', 'suites'];
const SERVICE_KEYS = ['name', 'kind', 'version', 'image', 'digest', 'architectures', 'paths', 'packages', 'env', 'user', 'workdir', 'start', 'ready', 'after', 'ports', 'aliases', 'ready-seconds'];
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
// <registry>/<path>:<tag>, no digest in it (that is `digest`), the tag required.
const IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const PACKAGE = /^[a-z0-9][a-z0-9+.-]+$/;
const USER = /^[a-z_][a-z0-9_-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A host name: DNS labels of lower-case letters, digits and -.
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const LOGIN_KEYS = ['url', 'username', 'password', 'click-first', 'username-field', 'password-field', 'submit', 'signed-in', 'env'];
const SUITE_KEYS = ['name', 'workdir', 'run', 'env', 'after', 'docker', 'timeout-seconds'];
const PREPARE_KEYS = ['name', 'workdir', 'run', 'env', 'npm'];
const isUrl = v => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } };
const isEnv = v => isObject(v) && Object.entries(v).every(([k, x]) => ENV_NAME.test(k) && ['string', 'number'].includes(typeof x));
const isSeconds = v => Number.isInteger(v) && v > 0 && v <= 86400;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = v => typeof v === 'string' && v.length > 0;
// An absolute path with no . or .. part and no trailing slash (but /).
const cleanAbsolute = p => isString(p) && isAbsolute(p) && !p.split('/').some(s => s === '..' || s === '.') && (p === '/' || (!p.endsWith('/') && normalize(p) === p));
// A relative path inside the sandbox folder.
const cleanRelative = p => isString(p) && !isAbsolute(p) && !p.split('/').some(s => s === '..' || s === '.' || s === '') && normalize(p) === p;

// parseServices(text, file) — the YAML mapping; throws "<file>: <reason>" when it does not parse or is no mapping.
export function parseServices(text, file = SERVICES_FILE) {
  const doc = YAML.parseDocument(text, { prettyErrors: true, uniqueKeys: true, version: '1.2', schema: 'core' });
  const [error] = doc.errors;
  if (error) {
    const { line = 1, col = 1 } = error.linePos?.[0] ?? {};
    throw new Error(`${file}:${line}:${col}: ${error.message.replace(/ at line \d+, column \d+:[\s\S]*$/, '').trim()}`);
  }
  const value = doc.toJS({ maxAliasCount: 100 });
  if (!isObject(value)) throw new Error(`${file}: a sandbox declaration is a mapping (architectures: …, services: …)`);
  return value;
}

// paths(service) — its paths as { from, to }, or null for a bad entry (named by validateServices).
const pathsOf = service => (service.paths ?? []).map(p => (typeof p === 'string' ? { from: p, to: p } : isObject(p) ? { from: p.from, to: p.to ?? p.from } : null));

// validateServices(d, { folder, exists }) — every problem of the declaration d, each naming its entry.
// folder is the sandbox folder (files' and provision's sources are checked to be files in it); exists
// a test's stand-in for existsSync.
export function validateServices(d, { folder = null, exists = f => existsSync(f) && statSync(f).isFile() } = {}) {
  const problems = [];
  if (!isObject(d)) return ['the declaration is not a mapping'];
  for (const key of Object.keys(d)) if (!TOP_KEYS.includes(key)) problems.push(`has an unknown key "${key}" (known: ${TOP_KEYS.join(', ')})`);
  const archs = d.architectures;
  if (!Array.isArray(archs) || archs.length === 0 || !archs.every(a => ARCHITECTURES.includes(a)) || new Set(archs).size !== archs.length)
    problems.push(`architectures must list the image's builds, each once: ${ARCHITECTURES.join(' and/or ')}`);
  if (d.base !== undefined && !(isObject(d.base) && IMAGE.test(d.base.image ?? '') && DIGEST.test(d.base.digest ?? '') && Object.keys(d.base).every(k => ['image', 'digest'].includes(k))))
    problems.push('base must be { image: <name>:<tag>, digest: sha256:<64 hex> }');
  if (d.provision !== undefined) {
    if (!cleanRelative(d.provision)) problems.push(`provision must be a file of the sandbox folder, a relative path: ${JSON.stringify(d.provision)}`);
    else if (folder && !exists(join(folder, d.provision))) problems.push(`provision names no file of the sandbox folder: ${d.provision}`);
  }
  const packages = (where, list) => {
    if (list !== undefined && !(Array.isArray(list) && list.every(p => typeof p === 'string' && PACKAGE.test(p)))) problems.push(`${where}packages must be a list of Debian package names`);
  };
  packages('', d.packages);
  // to → { who copies there, from what }. The very same copy (one image at one digest, one path) is fine:
  // several instances of one program (three PostgREST APIs, say) declare the same files, copied once.
  const targets = new Map();
  const claim = (to, who, source = who) => {
    const had = targets.get(to);
    if (had && had.source !== source) problems.push(`${who}: ${to} is copied to by ${had.who} too`);
    else if (!had) targets.set(to, { who, source });
  };
  if (d.files !== undefined) {
    if (!Array.isArray(d.files)) problems.push('files must be a list of { from, to }');
    else d.files.forEach((f, i) => {
      const who = `files[${i}]`;
      if (!isObject(f) || !Object.keys(f).every(k => ['from', 'to'].includes(k))) return problems.push(`${who} must be { from: <file of the sandbox folder>, to: <absolute path> }`);
      if (!cleanRelative(f.from)) problems.push(`${who}: from must be a relative path inside the sandbox folder: ${JSON.stringify(f.from)}`);
      else if (folder && !exists(join(folder, f.from))) problems.push(`${who}: from names no file of the sandbox folder: ${f.from}`);
      if (!cleanAbsolute(f.to) || f.to === '/') problems.push(`${who}: to must be an absolute file path: ${JSON.stringify(f.to)}`);
      else claim(f.to, who);
    });
  }
  if (!Array.isArray(d.services)) {
    problems.push('services must be a list (an empty one for none)');
    return problems;
  }
  const names = new Map(), ports = new Map();
  d.services.forEach((s, i) => {
    const who = `services[${i}]${isObject(s) && isString(s.name) ? ` (${s.name})` : ''}`;
    const bad = what => problems.push(`${who}: ${what}`);
    if (!isObject(s)) return bad('must be a mapping (name, version, image, digest, paths, start, …)');
    for (const key of Object.keys(s)) if (!SERVICE_KEYS.includes(key)) bad(`has an unknown key "${key}" (known: ${SERVICE_KEYS.join(', ')})`);
    if (!isString(s.name) || !NAME.test(s.name)) bad('name must be lower-case letters, digits and -');
    else if (names.has(s.name)) bad(`name ${s.name} is services[${names.get(s.name)}]'s too`);
    else names.set(s.name, i);
    const kind = s.kind ?? 'service';
    if (!KINDS.includes(kind)) bad(`kind must be one of ${KINDS.join(', ')}`);
    if (!(isString(s.version) || typeof s.version === 'number')) bad('version must say which version it is');
    // ASS-542: a service or job of what the image has already (a repository's own dev server, a script of it, run
    // with the toolchains) declares no image, digest or paths at all; anything else declares all three.
    const own = kind !== 'toolchain' && s.image === undefined && s.digest === undefined && s.paths === undefined;
    if (!own && (!isString(s.image) || !IMAGE.test(s.image))) bad(`image must be the pinned image's name and tag, <registry>/<path>:<tag> (its digest in digest): ${JSON.stringify(s.image)}`);
    if (!own && (!isString(s.digest) || !DIGEST.test(s.digest))) bad(`digest must be sha256:<64 hex>: ${JSON.stringify(s.digest)}`);
    if (s.architectures !== undefined) {
      if (!Array.isArray(s.architectures) || s.architectures.length === 0 || !s.architectures.every(a => ARCHITECTURES.includes(a))) bad(`architectures must list its image's platforms: ${ARCHITECTURES.join(' and/or ')}`);
      else if (Array.isArray(archs)) for (const a of archs) if (ARCHITECTURES.includes(a) && !s.architectures.includes(a)) bad(`its image offers ${s.architectures.join(', ')} only, but the image is built for ${a} (architectures)`);
    }
    if (own) { /* nothing copied */ } else if (!Array.isArray(s.paths) || s.paths.length === 0) bad('paths must list what to take from its image: absolute paths, or { from, to }');
    else pathsOf(s).forEach((p, j) => {
      if (!p || (typeof s.paths[j] !== 'string' && !Object.keys(s.paths[j]).every(k => ['from', 'to'].includes(k)))) return bad(`paths[${j}] must be an absolute path or { from, to }`);
      if (!cleanAbsolute(p.from)) bad(`paths[${j}]: from must be an absolute path: ${JSON.stringify(p.from)}`);
      if (!cleanAbsolute(p.to) || (p.to === '/' && p.from !== '/')) bad(`paths[${j}]: to must be an absolute path: ${JSON.stringify(p.to)}`);
      else if (p.to === '/') bad(`paths[${j}]: a whole filesystem goes to a folder of its own (to: /opt/sandbox/rootfs/${s.name ?? '<name>'}), never over the image's /`);
      else claim(p.to, `${who} paths[${j}]`, `${s.image}@${s.digest}:${p.from}`);
    });
    packages(`${who}: `, s.packages);
    if (s.env !== undefined && !(isObject(s.env) && Object.entries(s.env).every(([k, v]) => ENV_NAME.test(k) && ['string', 'number'].includes(typeof v)))) bad('env must map variable names to strings');
    if (s.user !== undefined && !(isString(s.user) && USER.test(s.user))) bad('user must be a user name');
    if (s.workdir !== undefined && !cleanAbsolute(s.workdir)) bad('workdir must be an absolute path');
    const start = s.start;
    const startOk = isString(start) || (Array.isArray(start) && start.length > 0 && start.every(isString));
    if (kind === 'toolchain') {
      for (const key of ['start', 'ready', 'after', 'ports']) if (s[key] !== undefined) bad(`a toolchain starts nothing: no ${key}`);
    } else if (!startOk) bad('start must say how it starts: a shell command, or an argv list');
    if (s.ready !== undefined && (kind !== 'service' || !isString(s.ready))) bad('ready must be a shell command, and only a service has one');
    if (s.ports !== undefined) {
      if (!Array.isArray(s.ports) || !s.ports.every(p => Number.isInteger(p) && p > 0 && p < 65536)) bad('ports must list port numbers');
      else for (const p of s.ports) {
        if (ports.has(p)) bad(`port ${p} is ${ports.get(p)}'s too: one port, one service`);
        else ports.set(p, who);
      }
    }
    if (s.after !== undefined && !(Array.isArray(s.after) && s.after.every(isString))) bad('after must list service names');
    if (s.aliases !== undefined && !(Array.isArray(s.aliases) && s.aliases.every(h => isString(h) && HOST.test(h)))) bad('aliases must list host names');
    if (s['ready-seconds'] !== undefined && !(isSeconds(s['ready-seconds']) && kind === 'service')) bad('ready-seconds must be a number of seconds, and only a service has one');
  });
  // after names services declared, never itself, and makes no cycle.
  const declared = new Map(d.services.filter(s => isObject(s) && isString(s.name)).map(s => [s.name, s]));
  d.services.forEach((s, i) => {
    if (!isObject(s) || !Array.isArray(s.after)) return;
    const who = `services[${i}]${isString(s.name) ? ` (${s.name})` : ''}`;
    for (const a of s.after) {
      if (a === s.name) problems.push(`${who}: after names itself`);
      else if (!declared.has(a)) problems.push(`${who}: after names no service: ${a}`);
      else if (declared.get(a).kind === 'toolchain') problems.push(`${who}: after names ${a}, a toolchain, which starts nothing`);
    }
  });
  stackProblems(d, declared, problems);
  const cycle = findCycle(declared);
  if (cycle) problems.push(`services: after makes a cycle: ${cycle.join(' → ')}`);
  return problems;
}

// stackProblems(d, declared, problems) — ASS-542: the stack's own keys (hosts, ca, app, login, prepare, suites)
// and the host map: a host name is mapped once — a service's name, its aliases and hosts: never two of them.
function stackProblems(d, declared, problems) {
  const services = name => declared.has(name) && declared.get(name).kind !== 'toolchain';
  const names = (where, list) => {
    if (list === undefined) return;
    if (!Array.isArray(list) || !list.every(isString)) return problems.push(`${where} must list service names`);
    for (const a of list) if (!services(a)) problems.push(`${where} names no service: ${a}`);
  };
  const mapped = new Map();
  const host = (h, who) => {
    if (mapped.has(h)) problems.push(`${who}: host ${h} is ${mapped.get(h)}'s too: one name, one entry`);
    else mapped.set(h, who);
  };
  d.services.forEach((s, i) => {
    if (!isObject(s) || !isString(s.name)) return;
    const who = `services[${i}] (${s.name})`;
    if (s.kind !== 'toolchain') host(s.name, who);
    if (Array.isArray(s.aliases)) for (const a of s.aliases) if (isString(a)) host(a, who);
  });
  if (d.hosts !== undefined) {
    if (!Array.isArray(d.hosts)) problems.push('hosts must list host names');
    else d.hosts.forEach((h, i) => (isString(h) && HOST.test(h) ? host(h, `hosts[${i}]`) : problems.push(`hosts[${i}] must be a host name: ${JSON.stringify(h)}`)));
  }
  if (d.ca !== undefined) {
    if (!isObject(d.ca) || !Object.keys(d.ca).every(k => ['cert', 'after'].includes(k))) problems.push('ca must be { cert: <absolute path>, after: <service> }');
    else {
      if (!cleanAbsolute(d.ca.cert) || d.ca.cert === '/') problems.push(`ca: cert must be an absolute file path: ${JSON.stringify(d.ca.cert)}`);
      if (d.ca.after !== undefined && !(isString(d.ca.after) && services(d.ca.after))) problems.push(`ca: after names no service: ${d.ca.after}`);
    }
  }
  if (d.app !== undefined) {
    if (!isObject(d.app) || !Object.keys(d.app).every(k => ['url', 'after', 'ready-seconds'].includes(k))) problems.push('app must be { url, after: [service…], ready-seconds }');
    else {
      if (!isUrl(d.app.url)) problems.push(`app: url must be an http(s) URL: ${JSON.stringify(d.app.url)}`);
      names('app: after', d.app.after);
      if (d.app['ready-seconds'] !== undefined && !isSeconds(d.app['ready-seconds'])) problems.push('app: ready-seconds must be a number of seconds');
    }
  }
  if (d.login !== undefined) {
    if (!isObject(d.login)) problems.push('login must be a mapping: { url, username, password, … }');
    else {
      for (const key of Object.keys(d.login)) if (!LOGIN_KEYS.includes(key)) problems.push(`login has an unknown key "${key}" (known: ${LOGIN_KEYS.join(', ')})`);
      if (!isUrl(d.login.url)) problems.push(`login: url must be an http(s) URL: ${JSON.stringify(d.login.url)}`);
      for (const key of ['username', 'password']) if (!isString(d.login[key])) problems.push(`login: ${key} must be the seeded user's`);
      for (const key of ['click-first', 'username-field', 'password-field', 'submit']) if (d.login[key] !== undefined && !isString(d.login[key])) problems.push(`login: ${key} must be a CSS selector`);
      if (d.login['signed-in'] !== undefined && !isUrl(d.login['signed-in'])) problems.push(`login: signed-in must be an http(s) URL prefix: ${JSON.stringify(d.login['signed-in'])}`);
      if (d.login.env !== undefined && !isEnv(d.login.env)) problems.push('login: env must map variable names to strings');
    }
  }
  const list = (key, keys, check) => {
    if (d[key] === undefined) return;
    if (!Array.isArray(d[key])) return problems.push(`${key} must be a list`);
    const seen = new Map();
    d[key].forEach((e, i) => {
      const who = `${key}[${i}]${isObject(e) && isString(e.name) ? ` (${e.name})` : ''}`;
      if (!isObject(e)) return problems.push(`${who} must be a mapping (${keys.join(', ')})`);
      for (const k of Object.keys(e)) if (!keys.includes(k)) problems.push(`${who} has an unknown key "${k}" (known: ${keys.join(', ')})`);
      if (!isString(e.name) || !NAME.test(e.name)) problems.push(`${who}: name must be lower-case letters, digits and -`);
      else if (seen.has(e.name)) problems.push(`${who}: name ${e.name} is ${key}[${seen.get(e.name)}]'s too`);
      else seen.set(e.name, i);
      if (!isString(e.run)) problems.push(`${who}: run must be a shell command`);
      if (e.workdir !== undefined && !cleanAbsolute(e.workdir)) problems.push(`${who}: workdir must be an absolute path`);
      if (e.env !== undefined && !isEnv(e.env)) problems.push(`${who}: env must map variable names to strings`);
      check(e, who);
    });
  };
  list('prepare', PREPARE_KEYS, (e, who) => { if (e.npm !== undefined && typeof e.npm !== 'boolean') problems.push(`${who}: npm must be true or false`); });
  list('suites', SUITE_KEYS, (e, who) => {
    names(`${who}: after`, e.after);
    if (e.docker !== undefined && typeof e.docker !== 'boolean') problems.push(`${who}: docker must be true or false`);
    if (e['timeout-seconds'] !== undefined && !isSeconds(e['timeout-seconds'])) problems.push(`${who}: timeout-seconds must be a number of seconds`);
  });
}

// findCycle(services by name) — a cycle of `after` as names, or null.
function findCycle(byName) {
  const state = new Map();
  const visit = (name, path) => {
    if (state.get(name) === 'done') return null;
    if (state.get(name) === 'open') return [...path.slice(path.indexOf(name)), name];
    state.set(name, 'open');
    for (const next of byName.get(name)?.after ?? []) {
      if (!byName.has(next) || next === name) continue;
      const found = visit(next, [...path, name]);
      if (found) return found;
    }
    state.set(name, 'done');
    return null;
  };
  for (const name of byName.keys()) {
    const found = visit(name, []);
    if (found) return found;
  }
  return null;
}

// normalizeServices(d) — a valid declaration with its defaults filled in: base, provision (null: the golden
// one), packages, files, and per service kind, architectures (null: not said), paths { from, to },
// packages, env, user, workdir, start (an argv; a shell command as bash -c: not a login shell, whose profile would reset the declared env's PATH), ready, after, ports;
// services in an order that starts each after what it names (declared order otherwise).
export function normalizeServices(d) {
  const services = d.services.map(s => ({
    name: s.name, kind: s.kind ?? 'service', version: String(s.version), image: s.image ?? null, digest: s.digest ?? null,
    architectures: s.architectures ?? null, paths: pathsOf(s), packages: s.packages ?? [],
    env: Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, String(v)])),
    user: s.user ?? 'agent', workdir: s.workdir ?? '/',
    start: s.start === undefined ? null : typeof s.start === 'string' ? ['bash', '-c', s.start] : s.start,
    ready: s.ready ?? null, after: s.after ?? [], ports: s.ports ?? [],
    aliases: s.aliases ?? [], 'ready-seconds': s['ready-seconds'] ?? null,
  }));
  const ordered = [], placed = new Set();
  while (ordered.length < services.length) {
    const next = services.find(s => !placed.has(s.name) && s.after.every(a => placed.has(a)));
    ordered.push(next); placed.add(next.name);
  }
  return {
    architectures: d.architectures, base: d.base ?? DEFAULT_BASE, provision: d.provision ?? null,
    packages: d.packages ?? [], files: d.files ?? [], services: ordered,
    // ASS-542: the host map (every service's name and aliases, then hosts), the CA, the app, the login, the
    // build-time steps and the suites, with their defaults.
    hosts: [...new Set([...services.filter(s => s.kind !== 'toolchain').flatMap(s => [s.name, ...s.aliases]), ...(d.hosts ?? [])])],
    ca: d.ca ? { cert: d.ca.cert, after: d.ca.after ?? null } : null,
    app: d.app ? { url: d.app.url, after: d.app.after ?? [], 'ready-seconds': d.app['ready-seconds'] ?? 600 } : null,
    login: d.login ? {
      url: d.login.url, username: d.login.username, password: d.login.password, 'click-first': d.login['click-first'] ?? null,
      'username-field': d.login['username-field'] ?? '#username', 'password-field': d.login['password-field'] ?? '#password',
      submit: d.login.submit ?? '#kc-login', 'signed-in': d.login['signed-in'] ?? new URL(d.login.url).origin,
      env: Object.fromEntries(Object.entries(d.login.env ?? {}).map(([k, v]) => [k, String(v)])),
    } : null,
    prepare: (d.prepare ?? []).map(p => ({ name: p.name, workdir: p.workdir ?? '/', run: p.run, npm: p.npm ?? false, env: Object.fromEntries(Object.entries(p.env ?? {}).map(([k, v]) => [k, String(v)])) })),
    suites: (d.suites ?? []).map(t => ({
      name: t.name, workdir: t.workdir ?? '/', run: t.run, after: t.after ?? [], docker: t.docker ?? false,
      'timeout-seconds': t['timeout-seconds'] ?? 3600, env: Object.fromEntries(Object.entries(t.env ?? {}).map(([k, v]) => [k, String(v)])),
    })),
  };
}

// readServices(folder) — the folder's services.yaml checked and normalized; null when the folder has
// none (the project declares no sandbox). Throws an Error naming the file and every problem.
export function readServices(folder) {
  const file = join(folder, SERVICES_FILE);
  if (!existsSync(file)) return null;
  const d = parseServices(readFileSync(file, 'utf8'), file);
  const problems = validateServices(d, { folder });
  if (problems.length) throw new Error(`${file}:\n${problems.map(p => `  - ${p}`).join('\n')}`);
  return normalizeServices(d);
}
