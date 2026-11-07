// The Claude account an agent runs on (ASS-25): what `claude auth status`
// reports for the config directory it will start with (CLAUDE_CONFIG_DIR,
// ASS-26), or the shared ~/.claude without one.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// accountOf({ command, configDir, env }) — { loggedIn, email, org, subscription, authMethod }
// from `<command> auth status` (`claude` by default), run with configDir as
// CLAUDE_CONFIG_DIR when given; nulls for what it does not say. Not logged
// in, claude exits 1 yet still prints its JSON, read as any other. Throws,
// saying "claude auth status failed", when the command cannot run or prints
// no JSON.
export async function accountOf({ command = ['claude'], configDir, env = process.env } = {}) {
  const [file, ...args] = command;
  let status;
  try {
    const { stdout } = await run(file, [...args, 'auth', 'status'], { env: configDir ? { ...env, CLAUDE_CONFIG_DIR: configDir } : env, timeout: 30_000 })
      .catch(error => (error.stdout?.trim().startsWith('{') ? { stdout: error.stdout } : Promise.reject(error)));
    status = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`claude auth status failed${configDir ? ` for ${configDir}` : ''}: ${(error.stderr || error.message || String(error)).trim().split('\n')[0]}`);
  }
  return { loggedIn: status?.loggedIn === true, email: status?.email ?? null, org: status?.orgName ?? null, subscription: status?.subscriptionType ?? null, authMethod: status?.authMethod ?? null };
}

// kindOfAccount(account) — the credential kind an account runs on (ASS-215):
// 'anthropic' for an Anthropic Console API key login (authMethod api_key),
// else 'claude'.
export const kindOfAccount = account => (account?.authMethod === 'api_key' ? 'anthropic' : 'claude');
