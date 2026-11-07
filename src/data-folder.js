// The harness's live data (ASS-55): everything it writes while it runs —
// assignments.json, chats.json, harness.json, agent-names.json,
// agent-names-last-used.json, last-model-used and the projects, agents and
// chats folders — lives in the repo's own data/ folder, apart from the code
// (src, engines, prompts, personas) beside it. Every default path to it, in
// JS and in the agent-cli's bash, is under this folder; the env overrides
// (ASSIGNMENTS_FILE, PROJECTS_DIR, …) are unchanged.
import { join } from 'node:path';

// dataDir(root) — the data folder of the checkout at `root`.
export const dataDir = root => join(root, 'data');
