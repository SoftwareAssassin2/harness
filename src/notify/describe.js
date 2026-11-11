// The one-line description an Operator Needed notification carries (ASS-383
// AC3): written by a small, fast model from the ticket's key, title, step and
// reason alone (detect.js reasonOf), through the same Claude CLI the agents
// run (process.js CLAUDE's command), on the project's own login, the
// subscription first; a plain one built from the same reason when that fails.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { CLAUDE, billingOf, billed } from '../agents/process.js';

export const MODEL = 'claude-haiku-5-5';
export const TIMEOUT_MS = 20_000;
// How long the description may be, whatever the model answers: a notification shows two lines or so.
const LONGEST = 200;

// fallback(ticket) — the plain description: what the reason says first — a
// requirements change, the blocked state ("Blocked for Human: <ai-feedback-short>"),
// the gate's choice, a blocking question — else "<step> waits for you".
export function fallback({ step, reason = {} }) {
  const one = text => String(text).split('\n')[0].trim();
  const clip = text => (text.length > 120 ? `${text.slice(0, 119)}…` : text);
  if (reason.change != null) return 'Requirements changed: keep the current description or take the new one';
  if (reason.blocked) return clip(`Blocked for Human${reason.short ? `: ${one(reason.short)}` : reason.long ? `: ${one(reason.long)}` : ''}`);
  if (reason.gate) return clip(`${reason.gate}${reason.choices?.length ? `: ${reason.choices.join(' or ')}` : ''}`);
  if (reason.questions?.length) return clip(`Open question: ${one(reason.questions[0])}`);
  return `${step ?? 'A step'} waits for you`;
}

// promptOf(ticket) — what the model is given: the instruction, then the key,
// title, step and the reason's fields, those the ticket has; nothing else of it.
export function promptOf({ key, title, step, reason = {} }) {
  const lines = [
    ['Needs', reason.gate],
    ['Step instructions', reason.instructions],
    ['Choices', reason.choices?.join(' / ')],
    ['In the blocked state (Blocked for Human)', reason.blocked ? 'yes' : undefined],
    ['AI feedback (short)', reason.short],
    ['AI feedback (long)', reason.long],
    ...(reason.questions ?? []).map(q => ['Blocking question', q]),
    ['Pending requirements change, new description', reason.change],
  ].filter(([, value]) => value != null && value !== '').map(([name, value]) => `- ${name}: ${value}`);
  return [
    'Write the text of a macOS notification telling a software operator what they need to do for this ticket and why.',
    'Answer with one plain sentence of at most 15 words: no quotes, no markdown, no preamble.',
    '',
    `Ticket: ${key} — ${title}`,
    `Waiting at step: ${step ?? 'unknown'}`,
    'Why it waits on the operator:',
    ...lines,
  ].join('\n');
}

// tidy(text) — the model's answer as one line: its first non-empty line, quotes and markdown emphasis dropped; '' for none.
export function tidy(text) {
  const line = String(text ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? '';
  const bare = line.replace(/^["'“‘`*_]+|["'”’`*_]+$/g, '').trim();
  return bare.length > LONGEST ? `${bare.slice(0, LONGEST - 1)}…` : bare;
}

// The one-shot command (ASS-383): CLAUDE's own program and its -p, the model,
// stream-json out (its init event says the billing, its result the cost), no
// tools — the ticket's text can never make it run anything — no MCP servers and
// no session kept. The prompt goes in on stdin, never in a shell string.
export const oneShotArgs = (model = MODEL) => ['-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--no-session-persistence'];

// askClaude({ prompt, env, command, timeoutMs }) — runs `command` (CLAUDE's
// program by default) once with oneShotArgs in the temp folder (no repo's
// CLAUDE.md read), `prompt` on stdin; resolves { ok, text, usd, billing, priced }:
// the result's text, its cost (process.js billed: 0 on a subscription) and
// what it was billed to (billingOf its init event; null when it never said);
// priced once a result event came, so its cost is known. ok false — never a rejection — when it cannot start, exits without a
// result, reports an error or takes longer than `timeoutMs` (killed then); a
// result that came (priced) still has its cost, to record.
export function askClaude({ prompt, env = process.env, command = [CLAUDE[0]], timeoutMs = TIMEOUT_MS, model = MODEL }) {
  return new Promise(resolve => {
    const [file, ...args] = command;
    let child;
    try {
      child = spawn(file, [...args, ...oneShotArgs(model)], { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    } catch { resolve({ ok: false, text: '', usd: 0, billing: null, priced: false }); return; }
    const out = { ok: false, text: '', usd: 0, billing: null, priced: false };
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(out); };
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } out.ok = false; finish(); }, timeoutMs);
    createInterface({ input: child.stdout }).on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'system' && event.subtype === 'init') out.billing = billingOf(event);
      if (event.type === 'result') {
        out.priced = true;
        out.usd = billed({ billing: out.billing }, event.total_cost_usd ?? 0);
        out.text = event.is_error ? '' : tidy(event.result);
        out.ok = !event.is_error && out.text !== '';
      }
    });
    child.on('error', finish);
    child.on('close', finish);
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// describe(ticket, { envs, ask, record }) — the description of `ticket`
// (neededTickets'): askClaude on each of `envs` in turn — the project's
// subscription login, then its API key's (notifier.js loginEnvs) — within one
// TIMEOUT_MS between them, until one answers; the cost of each that came to
// a result (priced), an error's too, handed to record(usd, billing). The fallback when none
// answers. Never rejects.
export async function describe(ticket, { envs, ask = askClaude, record = () => {}, timeoutMs = TIMEOUT_MS, now = Date.now }) {
  const prompt = promptOf(ticket), until = now() + timeoutMs;
  for (const env of envs) {
    const left = until - now();
    if (left <= 0) break;
    const got = await ask({ prompt, env, timeoutMs: left });
    if (got.priced) record(got.usd, got.billing);
    if (got.ok) return got.text;
  }
  return fallback(ticket);
}
