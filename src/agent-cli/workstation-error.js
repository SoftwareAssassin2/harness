// workstation.bash's reading of a failed gcloud call (ASS-433), in node to
// share control's login.js (ASS-429) rather than restate its patterns in bash:
//
//   node workstation-error.js < <what gcloud and ssh printed>
//
// prints "<kind>\t<message>": kind expired (the gcloud login needs
// reauthentication: Google Cloud session control's sign-in lapsed, a revoked
// token, no account), offline (the Mac could not reach Google: a network
// problem, never counted as an expiry) or unknown; message the output as a
// log line may carry it (login.js shown: one line, cut to 300 characters,
// any token-looking word redacted), so the live data and control's log never
// hold a token.
import { failure, shown } from '../control/login.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const output = Buffer.concat(chunks).toString('utf8');
process.stdout.write(`${failure('gcloud', output)}\t${shown(output)}\n`);
