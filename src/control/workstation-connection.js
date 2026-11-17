// A project's GCP workstations' one SSH connection each (ASS-433), as control,
// the TUI and the machine layer read and use it; the connection itself is
// opened, checked and closed by the workstation:* commands
// (agent-cli/workstation.bash, which says how: one OpenSSH master per
// workstation through gcloud workstations ssh, the forwarder, Hindsight and
// zot reverse-forwarded to its loopback). Each new connection needs a live
// Google token and an open one does not, so everything run on a workstation
// goes over that master as a session of its own: sshArgv gives the argv
// (ASS-435's machine backend spawns it as machine-lima.js spawns limactl
// shell; ASS-434's setup runs through workstation:ssh, the same ssh).
import { existsSync } from 'node:fs';
import { readJson } from './read.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The live data (AC5): data/projects/<project>/workstations.json, { "<id>": {
// state, state-at, connected, connected-at, checked-at, disconnected-at,
// started-at, forwards, last-error: { at, kind, message } | null, setup:
// ASS-434's { ok, version, checked-at, set-up-at, home, runtime, did, failed,
// error } } } (see workstation.bash and workstation/setup.sh), never project.json.
export const WORKSTATIONS_FILE = 'workstations.json';

// loadWorkstations(projectDir) — that file's entries by id; {} without it
// (its project folder there). ASS-457: never {} because the data could not be
// read — the folder gone (the drive dropped), an fs error, or the file still
// not parsing once read again (read.js readJson) — which would read as no
// workstation held or connected: that throws, for the tick to be skipped
// (tick.js) and the dashboard's reload to keep what it had.
export function loadWorkstations(projectDir) {
  try { return readJson(join(projectDir, WORKSTATIONS_FILE)) ?? {}; } catch (error) {
    if (error.code === 'ENOENT' && existsSync(projectDir)) return {};
    throw error;
  }
}

// controlPath(env, project, id) — the master's socket, as workstation.bash
// workstation_control_path names it: $HARNESS_HOME/workstations/<project>-<id>.sock
// (HARNESS_HOME ~/.harness by default).
export const controlPath = (env, project, id) => join(env.HARNESS_HOME || join(env.HOME || homedir(), '.harness'), 'workstations', `${project}-${id}.sock`);

// quote(arg) / remoteCommand(argv) — argv as one command line for the
// workstation's shell, each word single-quoted (POSIX), as ssh hands the
// remote side one string; workstation.bash ws_quote quotes alike.
export const quote = arg => `'${String(arg).replaceAll("'", `'\\''`)}'`;
export const remoteCommand = argv => argv.map(quote).join(' ');

// sshArgv(env, project, id, argv) — the argv to spawn on the Mac to run
// `argv` on the workstation over its open connection (a login shell without
// argv): stdin, stdout, stderr and the exit code are the remote command's;
// 255 when the connection is not open — ProxyCommand=false fails it at once
// rather than let ssh try a connection of its own. workstation.bash
// workstation_ssh runs the same.
export function sshArgv(env, project, id, argv = []) {
  return ['ssh', '-S', controlPath(env, project, id), '-o', 'ControlMaster=no', '-o', 'BatchMode=yes', '-o', 'ProxyCommand=false', `workstation-${id}`,
    ...(argv.length ? ['--', remoteCommand(argv)] : [])];
}

// loginExpired(entry) — the workstation's last connect failed because its
// gcloud login needs reauthentication (AC4: login.js's 'expired', never a
// network failure).
export const loginExpired = entry => entry?.['last-error']?.kind === 'expired';

// sameBoot(entry) — ASS-481 AC3: a cloud VM's live data records the boot it
// runs now (workstation:connect's boot-id, a cloud VM's alone) and its last
// setup ran under that boot. Its whole disk persists across a stop, and the
// runtime folder (/dev/shm) across everything but a restart, so a connect
// alone does not call for a setup again: only a new boot or a new version.
const sameBoot = entry => Boolean(entry?.['boot-id']) && entry.setup?.['boot-id'] === entry['boot-id'];

// setUp(entry, version) — ASS-434: the workstation's setup (workstation:setup,
// the live data's `setup`) succeeded since its connection last opened
// (checked-at not before connected-at: a connect may follow a restart, which
// only a setup run notices) — or, a cloud VM's, under the boot it runs now
// (sameBoot) — and, given the version workstation:setup
// --version prints now, for that version.
export const setUp = (entry, version) => entry?.setup?.ok === true && ((entry.setup['checked-at'] ?? '') >= (entry['connected-at'] ?? '') || sameBoot(entry))
  && (version === undefined || entry.setup.version === version);

// workstationUsable(entry, version) — whether anything may be dispatched to
// the workstation (ASS-433 AC4, ASS-434 AC3; ASS-435's placement asks it): its
// connection open, as last checked, its login not needing reauthentication,
// and set up since that connection opened (setUp).
export const workstationUsable = (entry, version) => entry?.connected === true && !loginExpired(entry) && setUp(entry, version);

// tildify(path, home) — `path` with a leading `home` shown as ~.
const tildify = (path, home = homedir()) => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

// loginCommand(config, home) — the gcloud login to run for a workstation
// whose gcloud-config is `config` (its CLOUDSDK_CONFIG; none: the Mac's own).
export const loginCommand = (config, home) => `${config ? `CLOUDSDK_CONFIG=${tildify(config, home)} ` : ''}gcloud auth login`;

// expiredLogins(settings, entries, home) — the gcloud logins the project's
// workstations wait on (AC4), one per CLOUDSDK_CONFIG: [{ ids, config,
// command }] for those whose last connect found their login expired;
// `settings` dev-environments.js's { mode, workstations } (null: none).
export function expiredLogins(settings, entries, home) {
  const byConfig = new Map();
  for (const w of settings?.workstations ?? []) {
    if (!loginExpired(entries?.[w.id])) continue;
    const config = w['gcloud-config'] ?? null;
    if (!byConfig.has(config)) byConfig.set(config, { ids: [], config, command: loginCommand(config, home) });
    byConfig.get(config).ids.push(w.id);
  }
  return [...byConfig.values()];
}
