// Where a project's tickets run (ASS-431): project.json's dev-environments —
// { mode, workstations } — says whether its ticket variations run in Lima VMs
// of their own (vm, today's behavior and the default when it, or its mode, is
// missing), on GCP Cloud Workstations reached over SSH (workstation), or on
// both (vm+workstation: a free workstation seat first, a VM seat otherwise,
// ASS-469 seat-kinds.js — each workstation listed is one seat);
// and which existing workstations it may use: each { id, gcp-project, region,
// cluster, config } and an optional gcloud-config, the CLOUDSDK_CONFIG folder
// its gcloud login lives in ("~/.config/example/gcloud" or "$HOME/…": a
// leading ~ or $HOME expanded). A workstation's live state (which variation
// holds it, whether it runs) is live data, never project.json (ASS-58).
// Everything that needs a project's mode or workstations reads them here, or
// in bash through agent-cli/dev-environments.bash (which runs this file's
// devEnvironments through agent-cli/dev-environments.js), never project.json
// itself.
//
// ASS-481: plain GCP Compute Engine VMs ("cloud VMs") beside the
// workstations: an optional `cloud-vms` list, each { id, gcp-project, zone }
// with an optional gcloud-config (as a workstation's, ~ expanded) and an
// optional ssh-user (the OS Login user; without it, the one of the gcloud
// login's account: agent-cli/cloud-vm.bash cvm_user). A cloud VM is a remote
// machine as a workstation is — one remote seat each, claimed per step, set
// up, reached over one SSH connection (the workstation:* commands take
// either) — so devEnvironments returns the project's whole remote pool as its
// `workstations`: its workstations first, then its cloud VMs, each in list
// order, a cloud VM marked kind 'cloud-vm' (a workstation has no kind). That
// is the order free seats are filled in (AC3). Ids are unique across the
// two lists (their live data shares workstations.json). vm+workstation and
// workstation modes want the pool non-empty; vm mode uses none of it. A
// project without cloud-vms reads exactly as before.
//
// ASS-529: a remote machine takes several of its project's tickets, as many as
// its own memory and CPU allow (remote-seats.js). Each workstation and cloud
// VM may say how much of itself the harness may use — `max-memory-percent`
// and `max-cpu-percent`, each a number above 0 and at most 100; without them
// harness.json's (90 and 90) apply. And the project says how its tickets'
// tests and CI checks keep apart on one machine, `ticket-isolation`:
// 'one-at-a-time' (the default, when unset: its in-machine test and CI steps,
// machine-steps.js runsTests, run one at a time per machine, and nothing else
// changes — no environment is added to its sessions, so a project that has not
// opted in runs exactly as before) or 'separate' (opt-in: each ticket's
// sessions get their own COMPOSE_PROJECT_NAME and HARNESS_PORT_OFFSET,
// workstation-variation.bash's slot.env, which the project's compose files and
// test scripts use, and its tests may run side by side).
//
// ASS-557: each workstation and cloud VM may also set its own disk hold —
// `disk-free-hold-gb` and `disk-free-warn-gb`, positive numbers of GB (10^9
// bytes), the hold at most the warn — for the disk its tickets' work lives on
// (remote-seats.js); without them harness.json's (15 and 50, as the Mac's).
//
// ASS-540: `run-targets` (run-targets.js) — the run targets the project has and
// allows, in its default order — replaces `mode`: when set, the mode read here
// is the one it amounts to (run-targets.js modeOf), so everything that still
// reads a mode (seats, the bash commands) follows it; unset, the mode as before.
// Its errors (an unknown or repeated target, workstation or cloud-vm with no
// machine of that kind, a substrate target with no cluster on that kind of
// host) are devEnvironmentsErrors', each naming the field, so control logs
// them once and uses none of the project's dev-environments meanwhile.
import { readFileSync, existsSync } from 'node:fs';
import { projectTargetErrors, modeOf, asList } from './run-targets.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MODES = ['vm', 'vm+workstation', 'workstation'];
// The fields every workstation names; gcloud-config is the one optional field.
export const WORKSTATION_FIELDS = ['id', 'gcp-project', 'region', 'cluster', 'config'];
// ASS-481 AC1: the fields every cloud VM names; gcloud-config and ssh-user are optional.
export const CLOUD_VM_FIELDS = ['id', 'gcp-project', 'zone'];
export const CLOUD_VM = 'cloud-vm';
// ASS-529: the optional per-machine limits, and the project's ticket isolation on a shared machine.
export const LIMIT_FIELDS = ['max-memory-percent', 'max-cpu-percent'];
export const ISOLATIONS = ['one-at-a-time', 'separate'];
// ASS-557: the optional per-machine disk hold and warn levels (GB).
export const DISK_FIELDS = ['disk-free-hold-gb', 'disk-free-warn-gb'];
const goodGb = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
// isolationOf(settings) — a project's ticket isolation (devEnvironments' settings), 'one-at-a-time' when unset.
export const isolationOf = settings => settings?.['ticket-isolation'] ?? 'one-at-a-time';
const goodPercent = v => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100;

const at = 'dev-environments';
const isText = v => typeof v === 'string' && v.trim() !== '';
// goodConfig(remote) — its gcloud-config, when given, is a folder from /, ~ or $HOME.
const goodConfig = w => w['gcloud-config'] === undefined || (isText(w['gcloud-config']) && /^(\/|~(\/|$)|\$HOME(\/|$)|\$\{HOME\}(\/|$))/.test(w['gcloud-config']));

// devEnvironmentsErrors(json) — what is wrong with project.json `json`'s
// dev-environments, each naming the field: not an object; an unknown mode;
// vm+workstation or workstation with no workstations (nor, ASS-481, cloud
// VMs); workstations (or cloud-vms) not a list; a workstation not an object,
// missing one of WORKSTATION_FIELDS (or one not a non-empty string), an id
// not a single name segment ([A-Za-z0-9_-], as its live data is kept by it),
// a gcloud-config that is not a path from / or ~ or $HOME; two with one id;
// a cloud VM alike with CLOUD_VM_FIELDS, its ssh-user not a user name, its id
// not one a workstation or an earlier cloud VM has. [] when there is none to
// check (today's projects) or nothing is wrong.
export function devEnvironmentsErrors(json) {
  const d = json?.[at];
  if (d === undefined || d === null) return [];
  if (typeof d !== 'object' || Array.isArray(d)) return [`${at} is not an object`];
  const errors = [];
  const own = asList(d['run-targets']);
  const mode = d.mode ?? (own?.length ? modeOf(own) : 'vm');
  errors.push(...projectTargetErrors(json));
  if (!MODES.includes(mode)) errors.push(`${at}.mode ${JSON.stringify(mode)} is not one of ${MODES.join(', ')}`);
  const list = d.workstations, vms = d['cloud-vms'];
  const vmCount = Array.isArray(vms) ? vms.length : 0;
  if (list !== undefined && !Array.isArray(list)) errors.push(`${at}.workstations is not a list`);
  else if (!own?.length && mode !== 'vm' && MODES.includes(mode) && !list?.length && !vmCount) errors.push(`${at}.workstations is ${list ? 'empty' : 'missing'}: mode ${mode} needs at least one workstation${vms === undefined ? '' : ' or cloud VM'}`);
  if (vms !== undefined && !Array.isArray(vms)) errors.push(`${at}.cloud-vms is not a list`);
  if (d['ticket-isolation'] !== undefined && !ISOLATIONS.includes(d['ticket-isolation'])) errors.push(`${at}.ticket-isolation ${JSON.stringify(d['ticket-isolation'])} is not one of ${ISOLATIONS.join(', ')}`);
  const limits = (w, field) => {
    for (const f of LIMIT_FIELDS) if (w[f] !== undefined && !goodPercent(w[f])) errors.push(`${field}.${f} is not a percentage above 0 and at most 100`);
    for (const f of DISK_FIELDS) if (w[f] !== undefined && !goodGb(w[f])) errors.push(`${field}.${f} is not a positive number of GB`);   // ASS-557
    if (goodGb(w['disk-free-hold-gb']) && goodGb(w['disk-free-warn-gb']) && w['disk-free-hold-gb'] > w['disk-free-warn-gb']) errors.push(`${field}.disk-free-hold-gb is above its disk-free-warn-gb`);
  };
  const seen = new Set();
  for (const [i, w] of (Array.isArray(list) ? list : []).entries()) {
    const field = `${at}.workstations[${i}]`;
    if (typeof w !== 'object' || w === null || Array.isArray(w)) { errors.push(`${field} is not an object`); continue; }
    for (const name of WORKSTATION_FIELDS) if (!isText(w[name])) errors.push(`${field}.${name} is ${w[name] === undefined ? 'missing' : 'not a non-empty string'}`);
    if (isText(w.id) && !/^[A-Za-z0-9_-]+$/.test(w.id)) errors.push(`${field}.id ${JSON.stringify(w.id)} has a character other than A-Z, a-z, 0-9, _ and -`);
    else if (isText(w.id) && seen.has(w.id)) errors.push(`${field}.id ${JSON.stringify(w.id)} is used by an earlier workstation too`);
    if (isText(w.id)) seen.add(w.id);
    if (!goodConfig(w)) errors.push(`${field}.gcloud-config is not a folder starting with /, ~ or $HOME`);
    limits(w, field);
  }
  const kinds = new Map([...seen].map(id => [id, 'workstation']));
  for (const [i, w] of (Array.isArray(vms) ? vms : []).entries()) {
    const field = `${at}.cloud-vms[${i}]`;
    if (typeof w !== 'object' || w === null || Array.isArray(w)) { errors.push(`${field} is not an object`); continue; }
    for (const f of CLOUD_VM_FIELDS) if (!isText(w[f])) errors.push(`${field}.${f} is ${w[f] === undefined ? 'missing' : 'not a non-empty string'}`);
    if (isText(w.id) && !/^[A-Za-z0-9_-]+$/.test(w.id)) errors.push(`${field}.id ${JSON.stringify(w.id)} has a character other than A-Z, a-z, 0-9, _ and -`);
    else if (isText(w.id) && kinds.has(w.id)) errors.push(`${field}.id ${JSON.stringify(w.id)} is used by ${kinds.get(w.id) === 'workstation' ? 'a workstation' : 'an earlier cloud VM'} too`);
    if (isText(w.id) && !kinds.has(w.id)) kinds.set(w.id, CLOUD_VM);
    if (!goodConfig(w)) errors.push(`${field}.gcloud-config is not a folder starting with /, ~ or $HOME`);
    if (w['ssh-user'] !== undefined && !(isText(w['ssh-user']) && /^[a-z_][a-z0-9_.-]*$/.test(w['ssh-user']))) errors.push(`${field}.ssh-user is not a user name (a-z, 0-9, _, . and -)`);
    limits(w, field);
  }
  return errors;
}

// expandHome(path, home) — `path` with a leading ~, $HOME or ${HOME} made `home`.
const expandHome = (path, home) => path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);

// devEnvironments(json, env) — project.json `json`'s { mode, workstations, ticket-isolation (ASS-529, when set) }:
// mode vm when missing, workstations [] when missing, each workstation its
// WORKSTATION_FIELDS and, when given, its gcloud-config expanded against env's
// HOME (else the user's home), absolute; then (ASS-481) each cloud VM, its
// CLOUD_VM_FIELDS, kind 'cloud-vm', its gcloud-config expanded and its
// ssh-user when given. Throws, naming every bad field
// (devEnvironmentsErrors), when they are wrong: nothing runs on a guess.
export function devEnvironments(json, env = process.env) {
  const errors = devEnvironmentsErrors(json);
  if (errors.length) throw new Error(`project.json: ${errors.join('; ')}`);
  const d = json?.[at] ?? {};
  const home = env.HOME || homedir();
  const limits = w => Object.fromEntries([...LIMIT_FIELDS, ...DISK_FIELDS].filter(f => w[f] !== undefined).map(f => [f, w[f]]));   // ASS-529, ASS-557
  const own = asList(d['run-targets']);
  return {
    mode: own?.length ? modeOf(own) : d.mode ?? 'vm',   // ASS-540
    workstations: [...(d.workstations ?? []).map(w => ({
      ...Object.fromEntries(WORKSTATION_FIELDS.map(name => [name, w[name]])),
      ...(w['gcloud-config'] !== undefined ? { 'gcloud-config': expandHome(w['gcloud-config'], home) } : {}),
      ...limits(w),
    })), ...(d['cloud-vms'] ?? []).map(w => ({
      kind: CLOUD_VM,
      ...Object.fromEntries(CLOUD_VM_FIELDS.map(name => [name, w[name]])),
      ...(w['gcloud-config'] !== undefined ? { 'gcloud-config': expandHome(w['gcloud-config'], home) } : {}),
      ...(w['ssh-user'] !== undefined ? { 'ssh-user': w['ssh-user'] } : {}),
      ...limits(w),
    }))],
    ...(d['ticket-isolation'] !== undefined ? { 'ticket-isolation': d['ticket-isolation'] } : {}),
  };
}

// projectDevEnvironments(projectsDir, project, env) — devEnvironments of
// <projectsDir>/<project>/project.json; throws without one, or when it is wrong.
export function projectDevEnvironments(projectsDir, project, env = process.env) {
  const file = join(projectsDir, project, 'project.json');
  if (!/^[A-Za-z0-9_-]+$/.test(project ?? '') || !existsSync(file)) throw new Error(`no project ${project}`);
  return devEnvironments(JSON.parse(readFileSync(file, 'utf8')), env);
}

// usesVms(mode), usesWorkstations(mode) — whether a project in `mode` runs
// tickets in VMs, and on workstations.
export const usesVms = mode => mode === 'vm' || mode === 'vm+workstation';
export const usesWorkstations = mode => mode === 'workstation' || mode === 'vm+workstation';

// workstationOf(settings, id) — the workstation `id` of devEnvironments'
// `settings`, or undefined when its list has none.
export const workstationOf = (settings, id) => settings.workstations.find(w => w.id === id);

// ASS-481: isCloudVm(remote) — a member of devEnvironments' pool is a cloud VM;
// cloudVmsOf(settings) and workstationsOf(settings) — the pool's cloud VMs, and
// its workstations proper, each in list order ([] for null settings).
export const isCloudVm = remote => remote?.kind === CLOUD_VM;
export const cloudVmsOf = settings => (settings?.workstations ?? []).filter(isCloudVm);
export const workstationsOf = settings => (settings?.workstations ?? []).filter(w => !isCloudVm(w));
