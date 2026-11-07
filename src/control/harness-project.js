// The harness project (ASS-106): the one project whose code is the harness
// itself, named by harness.json's harness-project — as
// src/agent-cli/harness-project.bash answers it for the agent-cli.
// isHarnessProject(harness, id) — whether project `id` is it; with none named, none is.
export const isHarnessProject = (harness, id) => Boolean(id) && harness?.['harness-project'] === id;
// harnessProject(harness) — its name; undefined when harness.json names none.
export const harnessProject = harness => harness?.['harness-project'] || undefined;
