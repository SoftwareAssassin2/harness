// What a failed gcloud or glab login probe means (ASS-429, src/control/login.js):
// expired only when the tool says so, offline when it only could not reach its
// server, unknown otherwise; and its output as a log line may carry it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failure, shown } from '../../src/control/login.js';

test('ASS-429 AC1: gcloud\'s own words for an expiry are expired', () => {
  for (const said of [
    'ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.',
    "ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: ('invalid_grant: Bad Request', {'error': 'invalid_grant', 'error_description': 'Bad Request'})",
    'google.auth.exceptions.RefreshError: Token has been expired or revoked.',
    'ERROR: (gcloud.auth.print-access-token) You do not currently have an active account selected.',
    'No credentialed accounts.',
  ]) assert.equal(failure('gcloud', said), 'expired', said);
});

test('ASS-429 AC2: gcloud failing to reach Google is offline', () => {
  for (const said of [
    "HTTPSConnectionPool(host='oauth2.googleapis.com', port=443): Max retries exceeded with url: /token (Caused by NameResolutionError(\"<urllib3.connection.HTTPSConnection object at 0x1>: Failed to resolve 'oauth2.googleapis.com' ([Errno 8] nodename nor servname provided, or not known)\"))",
    "HTTPSConnectionPool(host='oauth2.googleapis.com', port=443): Max retries exceeded with url: /token (Caused by NewConnectionError('<urllib3.connection.HTTPSConnection object at 0x1>: Failed to establish a new connection: [Errno 61] Connection refused'))",
    "('Connection aborted.', ConnectionResetError(54, 'Connection reset by peer'))",
    "HTTPSConnectionPool(host='oauth2.googleapis.com', port=443): Read timed out. (read timeout=60)",
    "HTTPSConnectionPool(host='oauth2.googleapis.com', port=443): Max retries exceeded with url: /token (Caused by ResponseError('too many 503 error responses'))",
  ]) assert.equal(failure('gcloud', said), 'offline', said);
});

test('ASS-429 AC1: an expiry wins over a network word in the same message', () => {
  assert.equal(failure('gcloud', 'Reauthentication failed. cannot prompt during non-interactive execution (timed out)'), 'expired');
});

test('ASS-429 AC3: anything else is unknown', () => {
  assert.equal(failure('gcloud', 'ERROR: (gcloud.auth.print-access-token) Something new.'), 'unknown');
  assert.equal(failure('gcloud', ''), 'unknown');
  assert.equal(failure('glab', 'panic: runtime error'), 'unknown');
});

test('ASS-429 AC4: glab\'s expiry and network failures', () => {
  assert.equal(failure('glab', 'x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401 {message: 401 Unauthorized}'), 'expired');
  assert.equal(failure('glab', 'No GitLab instances have been authenticated with glab. Run `glab auth login` to authenticate.'), 'expired');
  assert.equal(failure('glab', 'x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: dial tcp: lookup gitlab.com: no such host'), 'offline');
  assert.equal(failure('glab', 'x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: dial tcp 1.2.3.4:443: connect: connection refused'), 'offline');
  assert.equal(failure('glab', 'x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 503 Service Unavailable'), 'offline');
});

test('ASS-429 AC3: shown trims the output and never carries a token', () => {
  assert.equal(shown('  ERROR:  a\n\n  b  \n'), 'ERROR: a b');
  assert.equal(shown('got ya29.a0AfH6SMBx-y_z and glpat-abcdefghijklmnop and eyJhbGciOi.eyJzdWIi.c2lnbmF0dXJl'), 'got [token] and [token] and [token]');
  assert.equal(shown(`key ${'A1b2'.repeat(12)} end`), 'key [token] end');
  assert.equal(shown("Failed to resolve 'oauth2.googleapis.com'"), "Failed to resolve 'oauth2.googleapis.com'");
  assert.equal(shown('x'.repeat(30) + ' ' + 'y '.repeat(200)).length, 300);
});
