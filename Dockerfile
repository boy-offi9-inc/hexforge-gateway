FROM node:20-slim

WORKDIR /app

# Install with the committed lockfile for a reproducible build.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Glama's introspection check spawns this over stdio and talks JSON-RPC
# (initialize + tools/list) - it does not need a live Gateway behind it,
# real APK tooling (jadx/apktool/adb/frida), or a device to answer that
# handshake, since tools/list is served from the static table in
# src/mcp-server/tools.ts. Only `tools/call` would need a running
# Gateway (see docs/MCP_SERVER.md) - out of scope for this check.
CMD ["node", "dist/mcp-server/index.js"]
