# syntax=docker/dockerfile:1
#
# The API as a single self-contained image, for any host that runs a container
# with a persistent process: Render, Railway, Fly.io, a VPS.
#
# The toolchains are installed alongside Node deliberately. This image runs the
# *local* execution engine — compilers spawned as child processes — because a
# managed host will not give a container access to a Docker daemon to start
# sibling containers with. That trade is the whole reason the local engine
# exists; see the header of src/execution/localEngine.ts for what it costs.
#
# ─── Build ────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Manifests first, so a source-only change does not re-run the install layer.
# Every workspace's package.json must be present or npm cannot resolve the
# workspace graph, even for the two we actually install.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# Only the API and its shared contracts. The web app's dependencies — Monaco,
# Playwright, the animation libraries — are several hundred megabytes that this
# image would never load.
RUN npm ci --workspace=@codexa/shared --workspace=@codexa/api --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api

# The shared package emits the types the API compiles against, so it goes first.
RUN npm run build -w @codexa/shared \
  && npm run build -w @codexa/api \
  && npm prune --omit=dev

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# One layer, no recommended extras, apt lists dropped: these three lines are
# most of the image size, so they are worth keeping tight.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       gcc \
       g++ \
       python3 \
       openjdk-17-jdk-headless \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=4000 \
    # The local engine has no sandbox. It is opted into here because this image
    # is built for it; read the note above before pointing it at the internet.
    EXEC_LOCAL_ALLOW_UNSANDBOXED=1 \
    # Run workspaces live on the container's own writable layer.
    EXEC_WORKSPACE_ROOT=/tmp/codexa-workspaces

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist

# Compiling and running submitted code as root would make the missing sandbox
# considerably worse. `node` is an unprivileged user the base image provides.
USER node

EXPOSE 4000

# The liveness route deliberately does not touch Mongo, so a database blip does
# not get the container killed and restarted into the same blip.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/index.js"]
