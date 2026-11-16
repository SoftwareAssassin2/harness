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
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MODES = ['vm', 'vm+workstation', 'workstation'];
// The fields every workstation names; gcloud-config is the one optional field.
export const WORKSTATION_FIELDS = ['id', 'gcp-project', 'region', 'cluster', 'config'];

const at = 'dev-environments';
const isText = v => typeof v === 'string' && v.trim() !== '';

// devEnvironmentsErrors(json) — what is wrong with project.json `json`'s
// dev-environments, each naming the field: not an object; an unknown mode;
// vm+workstation or workstation with no workstations; workstations not a
// list; a workstation not an object, missing one of WORKSTATION_FIELDS (or
// one not a non-empty string), an id not a single name segment
// ([A-Za-z0-9_-], as its live data is kept by it), a gcloud-config that is
// not a path from / or ~ or $HOME; two with one id. [] when there is none to
// check (today's projects) or nothing is wrong.
export function devEnvironmentsErrors(json) {
  const d = json?.[at];
  if (d === undefined || d === null) return [];
  if (typeof d !== 'object' || Array.isArray(d)) return [`${at} is not an object`];
  const errors = [];
  const mode = d.mode ?? 'vm';
  if (!MODES.includes(mode)) errors.push(`${at}.mode ${JSON.stringify(mode)} is not one of ${MODES.join(', ')}`);
  const list = d.workstations;
  if (list !== undefined && !Array.isArray(list)) errors.push(`${at}.workstations is not a list`);
  else if (mode !== 'vm' && MODES.includes(mode) && !list?.length) errors.push(`${at}.workstations is ${list ? 'empty' : 'missing'}: mode ${mode} needs at least one workstation`);
  const seen = new Set();
  for (const [i, w] of (Array.isArray(list) ? list : []).entries()) {
    const field = `${at}.workstations[${i}]`;
    if (typeof w !== 'object' || w === null || Array.isArray(w)) { errors.push(`${field} is not an object`); continue; }
    for (const name of WORKSTATION_FIELDS) if (!isText(w[name])) errors.push(`${field}.${name} is ${w[name] === undefined ? 'missing' : 'not a non-empty string'}`);
    if (isText(w.id) && !/^[A-Za-z0-9_-]+$/.test(w.id)) errors.push(`${field}.id ${JSON.stringify(w.id)} has a character other than A-Z, a-z, 0-9, _ and -`);
    else if (isText(w.id) && seen.has(w.id)) errors.push(`${field}.id ${JSON.stringify(w.id)} is used by an earlier workstation too`);
    if (isText(w.id)) seen.add(w.id);
    if (w['gcloud-config'] !== undefined && !(isText(w['gcloud-config']) && /^(\/|~(\/|$)|\$HOME(\/|$)|\$\{HOME\}(\/|$))/.test(w['gcloud-config']))) {
      errors.push(`${field}.gcloud-config is not a folder starting with /, ~ or $HOME`);
    }
  }
  return errors;
}

// expandHome(path, home) — `path` with a leading ~, $HOME or ${HOME} made `home`.
const expandHome = (path, home) => path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);

// devEnvironments(json, env) — project.json `json`'s { mode, workstations }:
// mode vm when missing, workstations [] when missing, each workstation its
// WORKSTATION_FIELDS and, when given, its gcloud-config expanded against env's
// HOME (else the user's home), absolute. Throws, naming every bad field
// (devEnvironmentsErrors), when they are wrong: nothing runs on a guess.
export function devEnvironments(json, env = process.env) {
  const errors = devEnvironmentsErrors(json);
  if (errors.length) throw new Error(`project.json: ${errors.join('; ')}`);
  const d = json?.[at] ?? {};
  const home = env.HOME || homedir();
  return {
    mode: d.mode ?? 'vm',
    workstations: (d.workstations ?? []).map(w => ({
      ...Object.fromEntries(WORKSTATION_FIELDS.map(name => [name, w[name]])),
      ...(w['gcloud-config'] !== undefined ? { 'gcloud-config': expandHome(w['gcloud-config'], home) } : {}),
    })),
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
