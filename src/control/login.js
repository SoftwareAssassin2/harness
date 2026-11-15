// The gcloud and glab login probes (ASS-28, ASS-61) and what their failures
// mean (ASS-429). A failing `gcloud auth print-access-token` or `glab auth
// status` used to count as an expired login, so a Mac offline or asleep —
// a client project, 2026-11-14: six hours of NameResolutionError for
// oauth2.googleapis.com — was held for credentials and told to run
// '<tool> auth login' with its login fine. Now a failure is read from what
// the tool printed (stdout and stderr together: glab prints its status on
// stderr):
//   - 'expired' only when the tool says so: gcloud's "Reauthentication
//     failed" (Google Cloud session control's ~16-hour sign-in), invalid_grant,
//     "Token has been expired or revoked", or no credentialed account; glab's
//     401 / unauthorized / invalid token / not authenticated or logged in;
//   - 'offline' when it only means the tool could not reach its server: a
//     name that did not resolve, a connection refused or reset, a timeout, a
//     5xx (from oauth2.googleapis.com for gcloud); the caller leaves the flag
//     as it is (triggers.js loginCheck);
//   - 'unknown' otherwise, with the output (trimmed, any token-looking word
//     redacted), which the caller logs and treats as expired, as before, so a
//     new kind of expiry is never missed.
// The expired patterns are tried first: an expiry wins over a network word
// in the same message.
import { execFile } from 'node:child_process';

const PATTERNS = {
  gcloud: {
    expired: /Reauthentication failed|invalid_grant|Token has been expired or revoked|no credentialed accounts|do not currently have an active account/i,
    offline: /NameResolutionError|Failed to resolve|nodename nor servname|Name or service not known|Temporary failure in name resolution|Connection ?refused|Connection ?reset|Connection aborted|Network is unreachable|timed out|Timeout|oauth2\.googleapis\.com[\s\S]*\b5\d\d\b|\b5\d\d\b[\s\S]*oauth2\.googleapis\.com/i,
  },
  glab: {
    expired: /\b401\b|unauthori[sz]ed|invalid[_ ]token|token (has )?(expired|been revoked|was revoked)|not (been )?authenticated|No GitLab instances have been authenticated|not logged in|no token/i,
    offline: /no such host|dial tcp|lookup [^\s:]+.*(no such host|server misbehaving)|connection refused|connection reset|network is unreachable|i\/o timeout|timeout|timed out|\b50[0-4]\b|bad gateway|service unavailable|gateway time-?out/i,
  },
};

// failure(tool, output) — 'expired', 'offline' or 'unknown' for a failed
// probe's output.
export function failure(tool, output) {
  const p = PATTERNS[tool];
  if (!p) return 'unknown';
  if (p.expired.test(output)) return 'expired';
  if (p.offline.test(output)) return 'offline';
  return 'unknown';
}

// shown(output) — a probe's output as a log line may carry it: whitespace
// collapsed, cut to 300 characters, and any token-looking word — a Google
// access token (ya29.…), a GitLab token (glpat-… and kin), a JWT, or a run
// of 40+ letters, digits, _ - + or = — redacted. The probes print a token
// only on success (print-access-token), which is never logged; this is for
// a failure that echoes one all the same.
export const shown = output => {
  const one = String(output ?? '')
    .replace(/\bya29\.[\w.-]+/g, '[token]')
    .replace(/\bgl[a-z]{1,4}-[\w-]{8,}/g, '[token]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]')
    .replace(/[A-Za-z0-9_\-+=]{40,}/g, '[token]')
    .replace(/\s+/g, ' ').trim();
  return one.length > 300 ? `${one.slice(0, 299)}…` : one;
};

// login(command, args) — a probe of a CLI's login, never prompting: 'live'
// when the command exits 0; 'unavailable' when it cannot be run or does not
// answer in 30 seconds; otherwise { login: failure(...), output: shown(...) }
// (ASS-429). Its stdout — gcloud's token — is read only to classify a
// failure, never returned on success.
export const login = (command, args) => () => new Promise(done => execFile(command, args, { timeout: 30_000 }, (error, stdout, stderr) => {
  if (!error) return done('live');
  if (error.code === 'ENOENT' || error.killed) return done('unavailable');
  const output = `${stderr ?? ''}\n${stdout ?? ''}`;
  done({ login: failure(command, output), output: shown(output) });
}));
