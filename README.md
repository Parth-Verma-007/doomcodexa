# Codexa

Codexa is a real-time collaborative web-based IDE that enables developers to code
together seamlessly in multiple programming languages, including C, C++, Java,
and Python, with live synchronization, code execution, and an intuitive
development environment.

Two people open the same file, type at the same time, see each other's cursors,
and press Run — and the program that comes back can read from stdin the way it
would in a terminal.

---

## What's interesting here

- **A hand-written Yjs provider over Socket.IO.** Yjs ships providers for raw
  WebSocket and WebRTC but not Socket.IO, so
  [`yjsProvider.ts`](apps/web/src/lib/yjsProvider.ts) implements the sync
  protocol directly against `y-protocols`. Because it is a CRDT, edits made
  while disconnected merge correctly on reconnect — for free.
- **The server holds an authoritative `Y.Doc`** per open file rather than
  relaying blindly, so a client joining an empty room gets correct state and
  there is one snapshot to persist. See
  [`docStore.ts`](apps/api/src/realtime/docStore.ts).
- **Interactive stdin.** Keystrokes in the terminal go straight to the running
  program, so `scanf`, `Scanner` and `input()` behave as they do in a shell.
  Compile and run are separate processes with separate pipes, so compiler
  diagnostics never get mixed into program output.
- **Execution is bounded, and honest about what it is not.** Wall-clock timeouts
  on both compile and run, a killed process tree, a 1 MB output cap and a
  concurrency limit — but no container, so no network isolation and no memory
  ceiling. Stated plainly in [docs/SECURITY.md](docs/SECURITY.md).
- **Read-only actually is.** A viewer's browser can emit a document update, so
  the role is checked on every event — and there is a test proving the edit is
  dropped and never reaches the other client.

---

## Stack

|           |                                                 |
| --------- | ----------------------------------------------- |
| Frontend  | React 19, Vite 6, Tailwind v4, Monaco, xterm.js |
| Backend   | Node 22, Express 5, Socket.IO 4                 |
| Database  | MongoDB 7 (Mongoose)                            |
| Auth      | Clerk                                           |
| Realtime  | Yjs CRDT over Socket.IO; WebRTC for voice/video |
| Execution | Compilers spawned as child processes of the API |

Everything is TypeScript in strict mode. `packages/shared` holds the socket
event contracts and Zod schemas used by both sides, so a rename on the server
breaks the client at compile time.

---

## Running it locally

**Requirements:** Node 22+. [Clerk](https://clerk.com) is optional — see the
note after the steps. Docker is not used.

```bash
git clone <this repo> && cd codexa
npm install

# 1. Configuration
cp .env.example .env                     # fill in your Clerk keys
cp .env.example apps/web/.env.local      # VITE_* values only

# 2. Database — either one, in its own terminal
npm run db:local

# 3. Shared contracts, then the app
npm run build -w @codexa/shared
npm run dev
```

The API listens on `http://localhost:4000`, the web app on
`http://localhost:5173`.

### Running code

Code runs as child processes of the API — no containers, no daemon. Whichever
toolchains are on `PATH` are the ones that work:

| Language | Needs                                                         |
| -------- | ------------------------------------------------------------- |
| C        | `gcc`, `clang` or `cc`                                        |
| C++      | `g++`, `clang++` or `c++`                                     |
| Java     | a JDK (`javac` and `java`)                                    |
| Python   | `python3` or `python` — the Windows Store stub does not count |

Anything missing produces a message naming the package to install, at the moment
you press Run. There is nothing to configure.

> **This path has no sandbox.** A container gave each run no network, a memory
> ceiling and a dropped capability set. A child process gets none of that: it
> runs as the same user as the API, with that user's files and network. Fine
> for you and people you invited on a machine you control; not fine for
> strangers. The server refuses to select it under `NODE_ENV=production`
> unless you set `EXEC_LOCAL_ALLOW_UNSANDBOXED=1`.
>
> Wall-clock timeouts, the output cap and the concurrency limit still apply.

To turn execution off entirely, set `EXEC_DISABLED=1`.

### Sharing it with someone else

Everything above runs on `localhost`, which is enough to build but not to
collaborate. [docs/DEPLOY.md](docs/DEPLOY.md) covers both ways to fix that: a
tunnel for an afternoon of pair programming, and a real three-host deployment
(Vercel for the web app, any container host for the API, Atlas for the
database). It also explains why the API cannot run on Vercel or Supabase.

### Running without Clerk

Set `AUTH_DEV_BYPASS=1` for the API and `VITE_AUTH_DEV_BYPASS=1` for the web
app. Every request resolves to a fixed dev identity, and the API refuses to
start with it set in production.

This is also how you demo collaboration on one machine: add `?as=alice` to any
URL and that **tab** becomes Alice for as long as it is open. Open a second tab
with `?as=bob`, share a link from the first, and you have two people editing
the same file.

---

## Commands

| Command             | What                                       |
| ------------------- | ------------------------------------------ |
| `npm run dev`       | API and web together, both with hot reload |
| `npm test`          | Every workspace's tests                    |
| `npm run typecheck` | Strict typecheck across all workspaces     |
| `npm run lint`      | ESLint                                     |
| `npm run format`    | Prettier, write mode                       |
| `npm run build`     | Shared → API → web, production builds      |

---

## Layout

```
apps/
  api/          Express + Socket.IO
    execution/  ExecutionEngine, toolchain discovery, output batching
    realtime/   collab · run · rtc namespaces, Y.Doc cache, awareness
    http/       REST routes, auth context, error envelope
    db/         Mongoose models
  web/          Vite + React SPA
    lib/        api client, socket manager, Yjs provider, Monaco setup
    features/   editor · filetree · terminal · presence · chat · rtc · share
packages/
  shared/       socket contracts, Zod schemas, path validation, limits
infra/          Caddyfile, systemd unit, compose for Mongo
docs/           PLAN.md · SECURITY.md · ARCHITECTURE.md · RUNBOOK.md
```

---

## Documentation

- **[docs/PLAN.md](docs/PLAN.md)** — the full engineering plan: goals, non-goals,
  data model, protocols, roadmap, risks
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the pieces fit, and the
  decisions worth defending
- **[docs/SECURITY.md](docs/SECURITY.md)** — threat model, sandbox controls, and
  accepted risks stated plainly
- **[docs/RUNBOOK.md](docs/RUNBOOK.md)** — deploying and operating it

---

## Status

The backend, the realtime layer, the execution engine and the full web client
are implemented, and 47 API tests plus 26 shared-package tests pass.

Two things have been verified by driving the real app, not just by unit tests:

- **Collaboration.** `apps/web/e2e/collab.mjs` opens two independent browser
  contexts, has one share an edit link with the other, types in both at once,
  and asserts convergence, presence and labelled remote cursors — then reloads
  one and checks the merged document came back from the server.
- **Execution.** `apps/web/e2e/run.mjs` creates a project, presses Run, answers
  the program's prompt, and checks the output. Against the local engine on a
  machine with only a JDK: Java compiles, runs, reads stdin and exits 0, while
  C++ and Python report exactly which package is missing.

Execution has no container path at all any more — Docker was removed rather
than carried as an option, because the machine this was built on cannot run it
(hardware virtualisation is disabled in firmware) and a managed container host
will not hand a container the daemon socket. What that costs is stated in
[docs/SECURITY.md §2](docs/SECURITY.md).

See [docs/PLAN.md §16](docs/PLAN.md) for what remains.
