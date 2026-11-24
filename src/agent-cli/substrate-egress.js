// The bash commands' reading of a project's sandbox egress (ASS-538), in node to share src/substrate/egress.js with
// control rather than restate it in jq. The project's ~/.harness/vm-credentials.json entry comes on stdin
// (vm-credentials.bash declared_credentials' JSON: keychain service names and settings, never a token; empty or
// `null` for none declared), so the declaration file is read in one place:
//
//   node substrate-egress.js <projects folder> <project> policy        { policy, hash, kinds, secrets, allow }: the
//        sandboxes' EgressPolicy rules, its hash, the injected kinds declared and each one's Secret, the allowlist
//   node substrate-egress.js <projects folder> <project> placeholders  the bash script that writes the sandbox's
//        placeholders (placeholderScript), run as root in the sandbox
//
// Exits 1, the reason on stderr, without the project or when its substrate settings are wrong.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowlist, egressPolicy, placeholderScript, policyHash, INJECTED, SECRETS } from '../substrate/egress.js';
import { namespaceOf, substrateErrors } from '../control/substrate-config.js';

try {
  const [dir, project, what] = process.argv.slice(2);
  if (!/^[A-Za-z0-9_-]+$/.test(project ?? '')) throw new Error(`invalid project '${project}'`);
  const json = JSON.parse(readFileSync(join(dir, project, 'project.json'), 'utf8'));
  const errors = substrateErrors(json);
  if (errors.length) throw new Error(`project.json: ${errors.join('; ')}`);
  const input = readFileSync(0, 'utf8').trim();
  const decl = input ? JSON.parse(input) : null;
  if (what === 'policy') {
    const namespace = namespaceOf(project), policy = egressPolicy(json, decl, namespace);
    const kinds = INJECTED.filter(k => decl?.[k]?.['keychain-service']);
    process.stdout.write(`${JSON.stringify({ policy, hash: policyHash(policy), namespace, kinds, secrets: Object.fromEntries(kinds.map(k => [k, SECRETS[k]])), allow: allowlist(json, decl) })}\n`);
  } else if (what === 'placeholders') {
    process.stdout.write(placeholderScript(json, decl));
  } else throw new Error(`usage: substrate-egress.js <projects folder> <project> policy|placeholders`);
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
