// Filling a step's command template ("./agent.sh self-healing:start {ticket}
// {summary} {ticket-url}") for control to run. Pure.

// fillArgs(command, values) — the command split on whitespace into an argv,
// each {name} in a word replaced by values[name]: a value with spaces stays
// one argument, so a summary reaches the script whole. Throws, naming it, on
// a placeholder whose value is missing or null.
export function fillArgs(command, values = {}) {
  return command.trim().split(/\s+/).map(word => word.replace(/\{([\w-]+)\}/g, (match, name) => {
    if (values[name] == null) throw new Error(`unfilled placeholder {${name}}`);
    return String(values[name]);
  }));
}
