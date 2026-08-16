# Security

Codexa executes untrusted code submitted by anyone with a share link. This
document states what protects the host, what does not, and what is knowingly
accepted.

It is written to be read by someone deciding whether to deploy this. If you are
that person: read §4 before you do.

---

## 1. Threat model

| Adversary                       | Goal                                                | Primary control                                    |
| ------------------------------- | --------------------------------------------------- | -------------------------------------------------- |
| Any signed-in user              | Reach the host as the API's user                    | **Not prevented** — §2. Bounded by §4.1            |
| Any signed-in user              | Mine cryptocurrency / send spam / scan the internet | **Not prevented** — no network isolation (§2)      |
| Any signed-in user              | Exhaust CPU or disk, or never terminate             | Wall clock, output cap, concurrency limit, janitor |
| Any signed-in user              | Read the server's secrets from its environment      | A run inherits `PATH`/`HOME`/`TEMP` only           |
| Any signed-in user              | Read another project's code                         | Per-event role checks (§3)                         |
| Anyone with a leaked share link | Gain more than the intended role                    | Share tokens can never confer ownership            |
| Anyone                          | Enumerate project ids                               | Missing role returns 404, never 403                |
| A malicious filename            | Write outside the workspace onto the host           | `paths.ts`, validated twice (§5)                   |
| Anyone with the sign-in form    | Guess a password online                             | 20 tries / 15 min per IP, 64 MiB of scrypt each    |
| Anyone with the sign-in form    | Learn which emails have accounts                    | One failure message, equal work either way (§3)    |
| Anyone holding a database dump  | Recover passwords, or replay a live session         | Salted scrypt; sessions stored only as SHA-256     |

The first two rows say "not prevented" deliberately. This project runs submitted
code without a sandbox; §2 explains why, and §4.1 explains what to do about it.

Out of scope: a hostile MongoDB, denial of service against the host from outside
the application, a compromised end-user device, and — see §2 — anything a
submitted program does that does not escape its own OS user.

---

## 2. Execution: what is bounded, and what is not

**There is no sandbox.** Submitted code runs as a child process of the API, as
the same OS user, with that user's filesystem and network access. This is stated
first because everything below is easy to mistake for isolation, and it is not.

Docker was removed rather than kept as an option. A second engine meant a second
security model and a second set of failure modes, for a path that could not run
on the hosts this project targets — a laptop with virtualisation disabled in
firmware, or a managed container platform that will not hand a container the
host's daemon socket. One engine that is exercised beats two, one of which is
not.

### What is still enforced — `apps/api/src/execution/localEngine.ts`

| Control      | Setting                                   | Stops                                                  |
| ------------ | ----------------------------------------- | ------------------------------------------------------ |
| Wall clock   | 20s compile + 10s run, then `SIGKILL`     | Infinite loops                                         |
| Process tree | `taskkill /T`, or the POSIX process group | A compiler's children outliving the timeout            |
| Output       | 1 MB, then truncate and kill              | A print loop exhausting the API's memory               |
| Rate         | 20 runs/min, 300/hour per user            | Sustained abuse                                        |
| Concurrency  | 4 simultaneous runs, queued beyond        | Overcommitting the box                                 |
| Workspace    | per-run `0700` directory, removed after   | Runs reading each other's files                        |
| Environment  | `PATH` / `HOME` / `TEMP` only             | Inheriting the Mongo URI and the metrics password      |
| Java heap    | `-Xmx` from `EXEC_MEMORY_MB`              | A JVM allocation becoming a readable error, not an OOM |

### What is not enforced

- **Network.** A program can open sockets — exfiltrate, mine, or scan.
- **Memory.** No portable per-process ceiling exists outside a container; only
  the JVM is bounded.
- **Filesystem beyond the run directory.** The process can read anything its
  user can read.

### No shell injection is possible

Every command is an argv array — `spawn(cmd, [...args])` with `shell: false`.
Filenames are passed as opaque arguments, so there is no string for a
`; rm -rf /` to hide inside. This is stronger than the container path it
replaced, which handed a script to `/bin/sh` and had to be careful about
quoting.

### Accepted risk

This is safe for **you and people you invited, on a machine you control** — the
collaborative pair-programming case the project is for. It is not safe for a
link posted publicly.

The API refuses to enable execution under `NODE_ENV=production` unless
`EXEC_LOCAL_ALLOW_UNSANDBOXED=1` is set, and `EXEC_DISABLED=1` turns the Run
button off entirely while leaving the rest of the IDE working.

---

## 3. Authentication and authorisation

### Who you are

Codexa issues its own credentials. There is no identity provider behind it, no
publishable or secret key to leak, and — since a session is a row rather than a
signed assertion — nothing to forge offline.

**Passwords** are hashed with `scrypt` from `node:crypto`: N=65536, r=8, p=1,
which costs 64 MiB and roughly 150 ms per hash, over a 16-byte random salt per
user, producing a 64-byte key. The record is `scrypt$N$r$p$salt$hash`, so the
parameters travel with the hash and can be raised later without invalidating
existing passwords. Comparison is `timingSafeEqual`, and a malformed or
truncated record returns false rather than throwing, so it cannot be told apart
from a wrong password. Only `NODE_ENV=test` lowers the cost. The field is
`select: false` on the schema, so a route has to ask for the hash by name to
get it, and no DTO carries it.

**Sessions** are 32 bytes from `crypto.randomBytes`, base64url. The database
stores only the SHA-256 of that token: a leaked backup, or a token that reached
a log, yields nothing replayable. A plain hash rather than a password hash is
the right primitive — 256 bits of randomness has no dictionary to attack, and
paying scrypt's cost on every request would buy nothing. Sessions last 30 days,
enforced twice: a Mongo TTL index bounds how long a dead session is _stored_,
and an explicit expiry check on every lookup bounds how long one would be
_accepted_ (the TTL sweep only runs about once a minute). Signing out deletes
the row, so revocation is immediate rather than "whenever the token expires".

**The token travels as `Authorization: Bearer`, never as a cookie** — including
the socket handshake, which carries the same token in `auth.token`. A browser
does not attach that header to a cross-site request the way it attaches a
cookie, so CSRF does not apply to this API and there is no anti-CSRF machinery
to get wrong. The other half of that trade is that the client keeps the token in
`localStorage`, where script on the web origin can read it: an XSS in the SPA
would be a session compromise, and is not defended against by this choice.

**Failure is deliberately uninformative.** `POST /api/auth/signup` and
`/api/auth/login` are the only routes that mint a session, and the only place an
attacker gets free guesses, so they carry their own limit well below the global
one — 20 attempts per 15 minutes per IP in production, with successful sign-ins
not spending from that budget. (`/api/auth/logout` is unauthenticated as well,
on purpose: signing out with a token that has already expired should succeed
rather than 401, and it can only ever delete the session it names.) A failed sign-in returns one
message for both "no such account" and "wrong password", and a request for an
account that does not exist still performs a full scrypt hash against a fixed
dummy record, so neither the response nor the time it took says which addresses
are registered. Sign-up is the exception and says which of email or username is
taken: a registration form that will not tell you is unusable, and the unique
indexes — not a prior existence check — are what actually decide.

What is deliberately absent from all of this is listed in §4.5.

### What you may do here

Roles are per project: `owner` > `editor` > `viewer`.

**Every mutating socket event re-checks the role.** This is the part people get
wrong. A viewer's browser can emit `sync:update` — nothing client-side prevents
it — so the check lives at the event handler, not at room join. If it lived at
join, "read-only" would be decorative.

- `apps/api/src/realtime/socketAuth.ts` — `ensureRole` on every handler
- `apps/api/src/realtime/collab.test.ts` — proves a viewer's edit is dropped
  **and never relayed to the other client**, and that the stored document is
  unchanged afterwards

Other properties:

- A user with no role on a project gets **404, not 403**, so project and file
  ids are not enumerable.
- Share tokens are 32 bytes from `crypto.randomBytes`, base64url. Rotating
  overwrites the token, which invalidates every previously shared link
  immediately.
- A share token can never grant `owner` — the schema only accepts
  `editor | viewer`.
- Only an owner ever receives `shareToken` in an API response.
- Removing a member force-evicts their live sockets from the project room, so a
  connected tab stops receiving updates at once rather than at reconnect.
- Only the user who started a run may send it stdin or kill it.

---

## 4. Accepted risks

### 4.1 Submitted code runs unsandboxed, as the API's own user

**This is the most serious residual risk in the system**, and it is accepted
rather than mitigated away. §2 states it in full; this is what bounds the blast
radius.

Mitigations, in the order they matter:

1. **Run it as a user with nothing.** Under systemd the API runs as a dedicated
   unprivileged account (`infra/codexa-api.service`); in the container image it
   runs as `node`, not root. Submitted code inherits exactly that account's
   reach and no more.
2. **A stripped environment.** A run gets `PATH`, `HOME` and `TEMP` and nothing
   else, so the Mongo URI and the metrics password are not sitting in
   `process.env` for it to read.
3. **systemd hardening** where it applies: `NoNewPrivileges`,
   `ProtectSystem=strict`, `ProtectHome`, `ProtectKernelTunables`,
   `ProtectKernelModules`, with a single writable path for run workspaces.
4. **A production gate.** `NODE_ENV=production` refuses to enable execution
   unless `EXEC_LOCAL_ALLOW_UNSANDBOXED=1` is set deliberately.
5. **An off switch.** `EXEC_DISABLED=1` removes the capability entirely; the
   Run button then explains itself instead of failing.

The honest summary: run this on a host you can rebuild, and only share the link
with people you would lend a laptop to.

**What would actually close it:** running containers under
[gVisor](https://gvisor.dev) (`--runtime=runsc`), which intercepts syscalls in
userspace and contains a container escape at the kernel boundary, for roughly
15% overhead. Or moving execution to a separate host that holds nothing else of
value. The `ExecutionEngine` interface exists precisely so the second option is
a new implementation rather than a rewrite.

For a portfolio deployment on a VPS holding nothing but Codexa, the residual
risk is a machine that can be rebuilt. For anything holding real data, do one of
the two above first.

### 4.2 WebRTC is STUN-only

There is no TURN server. Peers behind a symmetric NAT cannot establish a direct
connection and the call will fail for them.

This is **detected and reported** rather than left as a silent black tile: the
connection state transitions to `failed` and the UI says the network likely
requires a TURN relay. Running `coturn` is roughly a day of work plus relay
bandwidth, and was cut deliberately.

### 4.3 Single-node rate limiting and run queue

Both live in process memory. Correct for the single-node deployment this ships
as; a multi-node deployment would need Redis for both, and would otherwise let a
user multiply their rate limit by the number of nodes.

### 4.4 No antivirus or content scanning

Users can store any text they like, and there is no binary upload. Note that
stored content **is** executable by design — that is what the Run button does —
so this risk is subsumed by §2 and §4.1 rather than mitigated separately.

### 4.5 The account features that do not exist

Owning authentication means owning the gaps in it. These are absent, not
handled somewhere else:

- **No email verification.** An address is whatever was typed at sign-up, and
  nothing proves the person owns it. It follows that `ADMIN_EMAILS` — which is
  matched against exactly that unverified field — must only ever list addresses
  whose accounts already exist, since an entry nobody has registered yet is an
  admin slot waiting for whoever signs up with it first.
- **No password reset.** There is no mail path, so there is no "forgot
  password" flow; recovering an account means an operator changing the record.
- **No second factor.** A password is the only thing standing between an
  attacker and an account.
- **No account lockout.** Repeated failures are made expensive — the per-IP
  limit above, plus 64 MiB of scrypt per guess — but never stop. That is a
  choice rather than an omission: a lockout on a public sign-in form hands any
  stranger a way to lock a known user out of their own account.

The password rules match: a minimum of 8 characters and a 200-character
ceiling, with no composition requirements, because length is what costs an
attacker and "one uppercase, one symbol" mostly produces `Password1!`.

---

## 5. Input validation

Every request body is validated with a Zod schema from `@codexa/shared`, so the
client and server enforce identical rules.

Filenames get particular attention, because they become real directories on the
host before a run:

- Rejected: `..`, `.`, path separators, control characters (including NUL),
  NTFS-illegal characters, Windows device names (`CON`, `NUL`, `LPT1`…),
  reserved names (`.git`, `node_modules`), leading/trailing whitespace, trailing
  dots, and anything over 128 characters.
- Validated **twice**: on the way into the database, and again in
  `materialise()` immediately before `fs.writeFile`, which additionally asserts
  the resolved absolute path is inside the workspace directory.
- 26 unit tests in `packages/shared/src/paths.test.ts` cover the traversal cases
  specifically.

Mongoose runs with `sanitizeFilter: true`, so a body like
`{"name": {"$ne": null}}` cannot become a query operator even if it reached a
filter.

---

## 6. Transport and headers

- TLS terminated by Caddy, automatic certificates, HSTS with a one-year max-age.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin` via Helmet and Caddy.
- CORS is an explicit allowlist from `CORS_ORIGINS`; there is no wildcard.
- Socket.IO `maxHttpBufferSize` is 2 MB, matching the document ceiling, so an
  oversized frame is rejected by the transport before reaching a handler.
- `/metrics` is basic-auth'd with a constant-time comparison **and** restricted
  to loopback and private ranges by Caddy.

## 7. Secrets and logging

- Secrets come from the environment only; `.env` is git-ignored and
  `.env.example` contains placeholders. Authentication contributes nothing to
  that list: there is no signing key, because a session is a stored random
  token rather than something the server signs.
- Pino redacts the `authorization` header, `cookie` and `set-cookie`, and any
  field named `token`, `secretKey` or `shareToken` — which covers a session
  token however it reaches a log line.
- The API refuses to boot if `NODE_ENV=production` and `METRICS_PASSWORD` is
  missing. The development authentication bypass that used to need a production
  guard of its own is gone: there is one sign-in path now, and no flag that
  could be left switched on.
- Internal error messages are never returned to clients in production.

---

## 8. Reporting

Found something? Open a private security advisory on the repository rather than
a public issue.
