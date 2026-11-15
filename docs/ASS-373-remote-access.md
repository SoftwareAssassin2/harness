# ASS-373: Tailscale or ngrok for reaching the harness API from the iPhone

Spike findings, researched 2026-11-13. **Recommendation: Tailscale (Serve, tailnet only).**
This is advice; the operator makes the call (AC2), recorded at the end.

## The question

ASS-375 puts a JSON API on the Mac, bound to `127.0.0.1:7790`. ASS-376 pairs one iPhone and
accepts only requests signed by its Secure Enclave key, and the Mac signs every response.
ASS-379 makes the API reachable from the phone "as decided". ASS-381 sends push
notifications from the Mac straight to APNs. Which way does the phone reach the Mac?

- **Tailscale**: Mac and iPhone join the operator's private network (tailnet).
  `tailscale serve` proxies `https://<mac>.<tailnet>.ts.net` to `http://127.0.0.1:7790`,
  reachable only from the operator's own devices.
- **ngrok**: the ngrok agent on the Mac opens an outbound tunnel; a public HTTPS URL on
  ngrok's edge forwards to `127.0.0.1:7790`. Anyone can reach the URL.

Neither is installed on this Mac today (no `tailscale`, `ngrok` on the PATH, nothing in
/Applications; macOS 26.7).

## Summary

| | Tailscale (Serve) | ngrok |
|---|---|---|
| Cost | $0 (Personal plan: free, non-commercial, 6 users, unlimited devices) | $0 with tight limits; realistically Hobbyist $10/mo ($8/mo yearly) |
| On the iPhone | Tailscale app, signed in, VPN on (On Demand can turn it on for `*.ts.net`) | Nothing (unless the OAuth rule is used: a web login in the app) |
| Address | `https://<mac-name>.<tailnet>.ts.net`, stable while the machine name stays | Free: one assigned dev domain `<name>.ngrok-free.app`, stable across agent restarts. Paid: up to 10 ngrok-branded names |
| Who can reach the API | Only devices in the operator's tailnet (and ACLs) | The whole internet, unless an edge rule turns them away |
| Who can read the traffic | Nobody in between: WireGuard end to end, TLS terminated by tailscaled on the Mac. Relays (DERP) carry only encrypted packets | ngrok: TLS is terminated at ngrok's edge, so ngrok sees every request and response in plain text (raw TLS pass-through is not on the free plan) |
| Quotas | None that matter here | Free: 20k HTTP requests/month, 1 GB out/month, 4k req/min. Hobbyist: 100k req, 5 GB, then metered |
| Latency | Usually a direct peer-to-peer path; via a DERP relay when NAT traversal fails | Always phone, then ngrok edge, then Mac: one extra hop, tens of ms. Fine for this app either way |
| Push (APNs) | Unaffected | Unaffected |
| Main cost to the operator | A VPN app always on (or on demand) on the phone; one VPN slot; key expiry to turn off | A public endpoint to defend; plain-text traffic at a third party; quotas; OAuth awkward in a native app |

## Setup steps

### Tailscale

On the Mac (once):
1. Install the **Standalone** Tailscale app (tailscale.com/download/mac; Tailscale recommends it
   over the App Store build). Both GUI builds can Serve a port; only file serving needs the
   open-source build, which we don't need.
2. Sign in (Google, Apple, GitHub or Microsoft account). This creates the tailnet.
3. Turn on the CLI (app settings), or call `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
4. Admin console: MagicDNS on (default), **HTTPS Certificates on** (Serve asks for it on first
   use), and on the Mac's machine entry **Disable key expiry** (node keys otherwise expire after
   180 days and the Mac silently drops off the tailnet).
5. `tailscale serve --bg --https=443 http://127.0.0.1:7790`. With `--bg` the config persists
   across reboots and `tailscale down/up`. Check with `tailscale serve status --json`; the name
   is `Self.DNSName` in `tailscale status --json`. Off: `tailscale serve --https=443 off`.
6. Keep the Mac awake (Energy: prevent automatic sleeping on power adapter). True for ngrok too.

On the iPhone (once):
1. Install Tailscale from the App Store, sign in with the same account, allow the VPN profile.
2. Optional, recommended: in the app, VPN On Demand with "connect for `*.ts.net`", so opening
   the harness app or tapping a push brings the tunnel up by itself.
3. Disable key expiry for the phone too, or accept a re-login every 180 days.

### ngrok

On the Mac (once):
1. `brew install ngrok` (or download), sign up, `ngrok config add-authtoken <token>` (stored in
   plain text in ngrok.yml; the harness should pass it via `NGROK_AUTHTOKEN` from the Keychain
   instead).
2. Note the account's dev domain (dashboard, Domains), e.g. `foo-bar.ngrok-free.app`.
3. Write a traffic policy, one of:
   - OAuth (what the ticket proposed): `oauth` action with provider `google` (or github; Apple is
     not a provider) and a `deny` rule unless `actions.ngrok.oauth.identity.email` is the
     operator's. Free plan: 3 identities/month, 5 rules per policy, policy units paid from the
     one-time $5 credit (cheap since July 2026, $0.10 per 100k).
   - Or a shared-secret header: `deny` unless `req.headers['x-harness-gate']` matches a secret
     the phone got at pairing. Simpler for a native app, same effect (scanners never reach the Mac).
4. Run `ngrok http 7790 --url https://foo-bar.ngrok-free.app --traffic-policy-file policy.yml`
   as a child of the dashboard (started and stopped with the API), or as an `ngrok service`.

On the iPhone: nothing to install. With the OAuth rule the app must run the login in an
`ASWebAuthenticationSession`, keep ngrok's `session` cookie, attach it to every request and the
stream, and redo the login when ngrok's session times out.

## Cost

- **Tailscale**: $0. The free Personal plan covers one user with a Mac and a phone with room to
  spare. Non-commercial use only: if the harness counts as business use, the paid tiers apply
  (Tailscale's terms, worth the operator's own check).
- **ngrok free**: $0, one stable dev domain, no endpoint-hour charge for it. But 20k requests and
  1 GB out per month: polling every 10 s while the app is open, or a day of a live stream with
  full snapshots, eats that. Traffic policy (the lock) runs on the one-time $5 credit, valid a
  year. What happens when credit or quota runs out is not documented; plan for the endpoint
  refusing traffic.
- **ngrok Hobbyist**: $10/month or $96/year; 100k requests, 5 GB, $10 monthly credit, usage stops
  at the credit (no surprise bills). Comfortable for one phone.

## How the address stays stable

- **Tailscale**: the MagicDNS name `<machine>.<tailnet>.ts.net` is fixed while the Mac keeps its
  machine name and the tailnet its name. The HTTPS certificate is Let's Encrypt, renewed by
  tailscaled. Note: issuing it puts the name in public Certificate Transparency logs (the name
  only; the address behind it is a 100.x tailnet address, unreachable from outside).
- **ngrok**: the free dev domain is assigned once and "doesn't change when you restart the
  agent". A random URL (the old free behaviour) would have broken the QR code on every restart;
  that's no longer the case.

## How each one fails

| Situation | Tailscale | ngrok |
|---|---|---|
| Mac asleep / off / harness stopped | Connection times out (no Wake-on-LAN over the tailnet). If the harness is stopped but the Mac is up, Serve answers 502 | The edge answers with an ngrok error page (ERR_NGROK_3200 "endpoint offline") fast. Not signed by the Mac, so the app must treat it as "Mac unreachable" |
| Mac changes network (Wi-Fi to Ethernet, new IP) | WireGuard roams; peers re-find each other within seconds | The agent reconnects by itself; same URL |
| Phone changes network (Wi-Fi to 5G) | Roams; tunnel stays | Nothing to roam; plain HTTPS |
| Hostile or restrictive network (captive portal, UDP blocked) | Falls back to DERP relays over HTTPS (slower, still works) | Works anywhere HTTPS works |
| Phone's VPN slot taken (another VPN, work profile) | **Fails**: iOS runs one VPN at a time | Unaffected |
| Tailscale app turned off on the phone | "Mac unreachable" until it's on (On Demand avoids this) | n/a |
| Node key expired | Mac or phone drops off the tailnet. Avoided by disabling key expiry | n/a |
| Vendor outage | Existing direct connections keep working; new logins and coordination fail | Everything fails: all traffic goes through ngrok |
| Quota / credit spent | n/a | Requests refused until the month (or credit) resets |

## What each adds to or removes from the API's security

The API's own defences are the same either way (ASS-376): API bound to 127.0.0.1, one paired
device, every request signed (method, path, body hash, timestamp, nonce), the Mac signing every
response with a pinned key, Face ID proof for dangerous actions (ASS-377).

**Tailscale**
- Removes internet exposure entirely: no one outside the tailnet can send a single packet to
  the API, so a bug in the signing code is not reachable from the internet.
- Removes the third party from the data path: ticket text, answers and approvals are encrypted
  end to end between phone and Mac.
- Adds an identity check for free: Serve adds `Tailscale-User-Login` to each proxied request
  (and strips forged ones), which the API can check as a second factor alongside the device
  signature.
- Adds a trust dependency on the operator's Tailscale account (and its identity provider): whoever
  controls it can add a device to the tailnet. They still can't pass the device signature.
- The Mac's response signing (ASS-376 AC1) is still worth keeping, but it's defence in depth
  rather than the thing standing between the phone and a decrypting middleman.

**ngrok**
- Adds a public endpoint: scanners and anyone with the URL reach the Mac's API unless the edge
  rule (OAuth or secret header) stops them first. The signed requests become the main defence,
  so they carry the whole weight.
- Adds a party that sees all traffic in plain text: ngrok terminates TLS. The Mac's response
  signature protects integrity (ngrok can't forge replies), not confidentiality (ngrok can read
  them, and a request's body). Project names, ticket text and operator answers transit ngrok.
- The OAuth rule adds a real lock in front, but in a native app it means a browser-sheet login,
  cookie handling and periodic re-login; a shared-secret header rule gets most of the benefit
  with none of that.
- The authtoken is a credential to keep in the Keychain, not in ngrok.yml.

**Both, a trap for ASS-375/376**: Serve and the ngrok agent both proxy from the Mac itself, so
every remote request reaches the API from `127.0.0.1`. ASS-375 AC3's "allow unauthenticated
localhost calls" development flag would therefore open the API to the phone side too (and, with
ngrok, to the internet). The flag must be refused while remote access is up, or must reject any
request carrying proxy headers (`Tailscale-User-Login`, `X-Forwarded-For`, ngrok's headers).

## Push notifications

Unaffected by either. ASS-381 sends from the Mac to `api.push.apple.com:443` over HTTP/2, an
outbound connection on the Mac's normal route: Tailscale only routes 100.x tailnet addresses (we
don't use an exit node), and ngrok only carries inbound traffic. On the phone, APNs delivery
doesn't go through the tunnel either. The one difference: tapping a push opens the app, which
then needs the API. With ngrok that just works; with Tailscale the tunnel must be up, so VPN On
Demand for `*.ts.net` (or always-on) should be in the setup, and the app's "Mac unreachable"
should say "Is Tailscale on?".

## The later tickets under each option

### ASS-376 (pairing, signed requests)
- **Tailscale**: QR holds `https://<mac>.<tailnet>.ts.net`, the code and the fingerprint, as
  written. Optional extra: store the operator's `Tailscale-User-Login` at pairing and refuse
  requests from any other login. No other change.
- **ngrok**: QR holds the `ngrok-free.app` URL. If the secret-header rule is used, the QR also
  carries that edge secret (or the API hands it over in the pairing reply). If OAuth is used,
  pairing itself must first get past the OAuth login. Response signing becomes essential (ngrok
  decrypts), as AC1 already anticipates.

### ASS-379 (make it reachable), proposed criteria
- **Tailscale**:
  1. `./harness.sh harness:remote-access` (name to taste) checks Tailscale is installed, logged
     in and HTTPS-enabled, reads the Mac's `DNSName`, and says plainly what's missing (key
     expiry, HTTPS certificates) with the admin-console steps.
  2. Starting the API runs `tailscale serve --bg --https=443 http://127.0.0.1:<port>`; stopping
     it turns that serve off. Nothing to install as a child process.
  3. The `p` screen shows the `ts.net` address and whether Tailscale is up and Serve points at the
     API; the QR uses it. The dev localhost flag is refused while Serve is on.
  4. README and install skill: the Mac and iPhone steps above. `npm test` with a stub `tailscale`.
- **ngrok**:
  1. The command checks ngrok is installed, the authtoken is in the Keychain, the dev (or
     reserved) domain, and writes the traffic policy (OAuth or secret header).
  2. The dashboard starts `ngrok http` as a child with the API and stops it with it; a crash shows
     as down on `p`.
  3. The `p` screen shows the public URL, up/down, and the month's request and data usage
     against the plan's quota. The dev localhost flag is refused while the tunnel is up.
  4. README and install skill; `npm test` with a stub `ngrok`.

### ASS-381 (actions, push)
- **Tailscale**: APNs as written. The app's notification tap path brings up the tunnel (On
  Demand) before calling the API; "Mac unreachable" hints at Tailscale.
- **ngrok**: APNs as written. Every action and the stream count toward the request/data quota;
  the app should use the stream rather than polling. With OAuth, an expired ngrok session in
  the middle of a Face-ID-guarded action must re-login and retry cleanly.

(ASS-380 also changes slightly: under Tailscale the "Mac unreachable" screen needs a "Tailscale
off?" hint; under ngrok it must recognise ngrok's own error pages as "unreachable", since they
are unsigned.)

## Recommendation

**Tailscale, with `tailscale serve` (tailnet only, not Funnel).** The API never touches the
public internet, so the pairing and signing code is a second wall rather than the only one;
traffic is end to end encrypted rather than readable at ngrok; it's free with no quotas; the
address is stable; and ASS-379 shrinks to "run `tailscale serve --bg`, check it, show the
name". The price is on the phone: the Tailscale app must be on (On Demand makes this mostly
invisible), it takes iOS's single VPN slot, and some users report battery drain with the
tunnel always on. Choose **ngrok** instead if the operator needs another VPN on the phone at the
same time, or wants nothing installed on the phone; in that case budget for Hobbyist ($8-10/mo),
use a secret-header edge rule rather than OAuth, and accept that ngrok sees the traffic.

Tailscale Funnel (a public URL via Tailscale) was not considered further: it gives up the
reason to pick Tailscale and keeps ngrok's exposure.

## Decision (AC2)

_Operator's decision to be recorded here and on the ticket:_ ____

Then update ASS-379's acceptance criteria from the matching proposal above before it starts, and
add the dev-flag rule to ASS-375 or ASS-376.

## Sources

- Tailscale pricing: https://tailscale.com/pricing
- Tailscale Serve: https://tailscale.com/kb/1312/serve, CLI: https://tailscale.com/kb/1242/tailscale-serve
- macOS variants: https://tailscale.com/kb/1065/macos-variants
- iOS VPN On Demand: https://tailscale.com/kb/1291/ios-vpn-on-demand
- Battery reports: https://forum.tailscale.com/t/ios-iphone-battery-draining-issue/1021
- ngrok pricing: https://ngrok.com/pricing, free limits: https://ngrok.com/docs/pricing-limits/free-plan-limits
- ngrok charging: https://ngrok.com/docs/pricing-limits/how-ngrok-charges, 2026 changes: https://ngrok.com/blog/pricing-june-2026
- ngrok OAuth action: https://ngrok.com/docs/traffic-policy/actions/oauth/
- ngrok interstitial (browsers only, not API clients): https://ngrok.com/docs/errors/err_ngrok_6024
