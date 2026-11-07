## User story

As the operator, I want golden-{project} rebuilt from its current inputs, so that a new VM of {project} starts with every repository it lists, without cloning one.

## Context

Raised by the health check (check-health-v2, ASS-149): golden-{project} is stale. Complete as raised: no questions.

- Project: {project}
- Image: golden-{project}
- What changed:
{why}
- Built: {built-at}, inputs {built-hash}
- Inputs now: {hash}
- Command: `./agent.sh vm:build-golden {project}`

## Acceptance criteria

1. golden-{project} is rebuilt with the current inputs hash, {hash}: `./agent.sh vm:golden-stale {project}` reports it not stale.
2. A new VM of {project} has every repository project.json lists without cloning one.
3. Ticket VMs already running are untouched by the rebuild.
