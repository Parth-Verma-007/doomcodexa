# Deploying Codexa

The goal this document serves: **you open a project, send someone a link, and
the two of you edit the same file at the same time.** That already works — it is
covered by `apps/web/e2e/collab.mjs`, which drives two independent browsers and
asserts convergence, live cursors and presence. The only thing standing between
that and your teammate is that it is running on `localhost`.

There are two ways to close the gap. The first takes two minutes and is enough
to code with a friend this afternoon. The second is a real deployment.

---

## 1. Right now: share your machine for a session

Run the stack locally as usual, then put a public URL in front of the web dev
server with any tunnel — [cloudflared](https://developers.cloudflare.com/cloudflare-tunnel/)
or [ngrok](https://ngrok.com):

Two tunnels are needed, because the browser talks to both the web app and the
API directly:

```bash
npm run db:local                                    # terminal 1
cloudflared tunnel --url http://localhost:4000      # terminal 2 → API URL
cloudflared tunnel --url http://localhost:5173      # terminal 3 → web URL
```

Then start the two servers, each told about the other's public URL. This is the
step that catches people out: once the page is served from a tunnel domain, the
browser's origin is no longer `localhost:5173`, and the API will reject it
unless that domain is in `CORS_ORIGINS`.

```bash
# terminal 4
AUTH_DEV_BYPASS=1 CORS_ORIGINS=https://<your-web-tunnel> npm run dev:api

# terminal 5 — or put these two in apps/web/.env.local
VITE_AUTH_DEV_BYPASS=1 VITE_API_URL=https://<your-api-tunnel> npm run dev:web
```

If the editor loads but never syncs, this is almost always why: open the browser
console and look for a CORS error on the socket connection.

Because Clerk is bypassed, everyone needs a distinct identity: append `?as=`
to the URL you send. You open `…/dashboard?as=you`, they open
`…/join?t=<token>&as=them`. The name sticks to their browser tab.

**This is a demo mode, not a deployment.** Authentication is off, so anyone with
the link is whoever they claim to be, and code runs unsandboxed on your laptop.
Fine for people you know; not for a link you post publicly.

---

## 2. Properly: three hosts

| Piece    | Where                     | Why there                                    |
| -------- | ------------------------- | -------------------------------------------- |
| Web      | Vercel                    | static bundle, `vercel.json` is committed    |
| API      | Render / Railway / Fly.io | needs one persistent process with WebSockets |
| Database | MongoDB Atlas             | free tier is plenty                          |

### Why the API cannot go on Vercel

Not a configuration problem — three things in the code rule it out:

- `apps/api/src/index.ts` creates an HTTP server and attaches Socket.IO to it.
  Serverless functions are invoked per request; you cannot host a WebSocket
  server on one.
- `realtime/docStore.ts` keeps the authoritative `Y.Doc` for every open file in
  an in-process LRU cache. Serverless gives you many isolated instances with no
  shared memory, so two editors could land on different ones and **never
  converge** — the exact failure the CRDT exists to prevent.
- `execution/localEngine.ts` spawns `gcc`, `javac` and `python3`. None of them
  exist in that runtime, the filesystem is read-only outside `/tmp`, and the
  timeout is shorter than a JVM cold start.

The same reasoning rules out Supabase Edge Functions. Supabase is also Postgres,
while this app is Mongoose throughout, so it is not a drop-in database either.

### Order of operations

**a. Database.** Create a free Atlas cluster, add a database user, and allow
access from anywhere (`0.0.0.0/0`) unless your API host publishes fixed egress
IPs. Copy the connection string.

**b. Auth.** Create a Clerk application. You need the publishable key for the
web app and the secret key for the API. The webhook is optional — the API
upserts a user on their first authenticated request and treats the webhook as
an optimisation.

**c. API.** Point your host at `apps/api/Dockerfile` with the repository root as
the build context. It is a complete image: Node, the compiled API, and `gcc`,
`g++`, `python3` and a JDK so the Run button works. CI builds it, boots it and
checks the toolchains on every push.

Set:

| Variable                | Value                                             |
| ----------------------- | ------------------------------------------------- |
| `NODE_ENV`              | `production`                                      |
| `MONGODB_URI`           | your Atlas connection string                      |
| `CLERK_SECRET_KEY`      | from Clerk                                        |
| `CLERK_PUBLISHABLE_KEY` | from Clerk                                        |
| `METRICS_PASSWORD`      | any long random string                            |
| `CORS_ORIGINS`          | your Vercel URL, e.g. `https://codexa.vercel.app` |

The image already sets `EXEC_LOCAL_ALLOW_UNSANDBOXED=1`. Read the warning below
before leaving that on.

**d. Web.** Import the repository into Vercel and keep **Root Directory at the
repository root** — the web app depends on the `@codexa/shared` workspace, which
must be built first, and `vercel.json` already encodes that. Set:

| Variable                     | Value                 |
| ---------------------------- | --------------------- |
| `VITE_API_URL`               | your API's public URL |
| `VITE_CLERK_PUBLISHABLE_KEY` | from Clerk            |

Do **not** set `VITE_AUTH_DEV_BYPASS`. The build refuses to produce a bundle
with it enabled, which is the intended behaviour.

**e. Close the loop.** Once Vercel gives you a domain, put it in `CORS_ORIGINS`
on the API and redeploy the API. Add the same domain to Clerk's allowed origins.

### Check it worked

Open the site in two different browsers — or one normal and one private window,
since they need separate sessions. Sign in as two different people, create a
project in one, use **Share → Edit → Create a share link**, and open that link
in the other. You should see their avatar appear in the header, their cursor
with their name in the editor, and both of your edits merge as you type.

That is precisely what `collab.mjs` asserts locally, so if it passes there and
fails in production, the difference is environment — check `CORS_ORIGINS` first,
then that WebSockets are reaching the API rather than falling back to polling.

---

## The sandbox warning, once more

Submitted code runs as child processes of the API, as an unprivileged user, with
wall-clock timeouts, an output cap and a concurrency limit — but with **no
network isolation and no memory ceiling**. The container the API ships in is a
packaging boundary, not a sandbox for code you did not write.

That is an acceptable trade for a project you share with people you know. It is
not acceptable for a link on the open internet. If you need real isolation, run
the API on a disposable VM you can rebuild, or put each run behind a sandbox
that this project does not currently provide.

To turn execution off entirely and keep everything else, set `EXEC_DISABLED=1`.
The Run button then explains why it is unavailable instead of failing.
