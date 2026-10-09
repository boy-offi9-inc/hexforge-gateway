FROM node:22-slim

WORKDIR /app

# Install with the committed lockfile for a reproducible build.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# For a local `docker build` / `docker run` of the MCP server over stdio.
# Glama does not use this file: it generates its own Dockerfile from the
# Build steps and CMD arguments set on the server's admin page, and runs
# that under mcp-proxy. Keep the two in step: `npm ci && npm run build`,
# then `node dist/mcp-server/index.js`.
#
# Introspection (initialize + tools/list) needs no live Gateway, real APK
# tooling (jadx/apktool/adb/frida) or device, since tools/list is served
# from the static table in src/mcp-server/tools.ts. Only `tools/call` needs
# a running Gateway (see docs/MCP_SERVER.md).
CMD ["node", "dist/mcp-server/index.js"]
