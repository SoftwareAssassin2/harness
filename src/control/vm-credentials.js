// The one Node reader of ~/.harness/vm-credentials.json (ASS-307: used to be
// inline in vm-lifecycle.js's declaredVmKind): declaredCredentials(env, id) →
// the project's object, or null when the file, or the project, is not there or
// cannot be read. The file's shape and the kinds it holds are documented in
// src/agent-cli/vm-credentials.bash. One Node reader, so "which file holds the
// token's name" stays a single place to audit.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function declaredCredentials(env, id) {
  try {
    const file = join(env?.HARNESS_HOME ?? join(homedir(), '.harness'), 'vm-credentials.json');
    return JSON.parse(readFileSync(file, 'utf8'))?.[id] ?? null;
  } catch { return null; }
}
