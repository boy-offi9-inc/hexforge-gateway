# Plugin System

`src/plugins/` - the Plugin System that allows official and community
extensions without changing the core. A plugin is a folder under
`plugins/installed/<name>/index.ts` that
default-exports a `HexForgePlugin`:

```ts
import type { HexForgePlugin } from "../../types.js";

const plugin: HexForgePlugin = {
  name: "my-plugin",
  version: "0.1.0",
  register(ctx) {
    ctx.registerAgent("my-agent", async (task) => ({ ok: true }));
    ctx.on("job.completed", (payload) => ctx.log.info(`job ${payload.job.id} done`));
    ctx.app.get("/plugins/my-plugin/ping", async () => "pong");
  },
};

export default plugin;
```

`ctx` (`PluginContext`, in `plugins/types.ts`) is the entire surface a
plugin gets - it never imports the orchestrator, Event Bus, or Fastify
app directly:

- `ctx.registerAgent(kind, handler, descriptor?)` — adds a new MCP agent kind, usable in Tasks/Jobs/Workflows exactly like the built-ins. The optional descriptor declares what it can do (see below)
- `ctx.on(event, listener)` — subscribes to any Event Bus event
- `ctx.app` — the live Fastify instance, for plugin-owned routes
- `ctx.log` — prefixed console logger (`[plugin:<name>] ...`)

### Declaring capabilities (optional)

An agent can describe itself so the Gateway knows what it provides,
independent of which tool does the work. Pass a descriptor as the third
argument; leave it out and the agent works exactly as before.

```ts
ctx.registerAgent("strings", handler, {
  description: "Extract printable strings from a file",
  backends: [{ tool: "strings" }],
  permissions: ["fs:workspace"],
  operations: [
    {
      name: "extract",
      capability: "binary.strings",
      inputs: { required: ["filePath"] },
      outputs: ["strings"],
    },
  ],
});
```

Capability ids are dotted and lowercase (`java.decompile`,
`android.rebuild`). Several adapters can offer the same capability; the
one with the higher `priority` (default 0) wins, and an adapter's optional
`isAvailable()` probe lets the registry skip a backend that isn't
usable. An invalid descriptor makes `registerAgent` throw before anything
is registered, which the plugin loader logs and skips like any other load
failure. The registry itself lives in `src/capabilities/`.

Because a plugin's agent kind isn't known ahead of time, the `agent`
field on Task/Job/Workflow-step request schemas is an open string, not a
fixed enum - a misspelled or unloaded agent still fails cleanly with
`"No handler registered for agent ..."` on that specific Task.

`plugins/loader.ts` discovers every folder under `plugins/installed/` at
startup (after all core routes/indexers are registered) and calls each
plugin's `register()`. One plugin throwing is logged and skipped - it
can't take down the Gateway or another plugin. Restrict which load with
`PLUGINS_ENABLED=name-one,name-two` in `.env` (unset = load everything
found). `GET /plugins` lists what actually loaded; `plugin.loaded` /
`plugin.failed` fire on the Event Bus either way.

Two working reference plugins ship in `plugins/installed/`:

- **`example-strings/`** — adds a `strings` MCP agent (runs the
  `strings` utility on any file), subscribes to `job.completed` to log
  its own runs, and adds a `GET /plugins/example-strings/info` route.
  Demonstrates the "new agent" pattern.

  ```bash
  curl -X POST http://localhost:8080/workspaces/<id>/jobs \
    -H "Content-Type: application/json" \
    -d '{"agent": "strings", "operation": "extract", "payload": {"filePath": "/absolute/path/to/some/file"}}'
  ```

- **`webhook-notifier/`** — demonstrates the event-only pattern: no new
  agent or route. Set `WEBHOOK_NOTIFIER_URL` and it POSTs a small JSON
  body whenever a Job or Workflow completes or fails, so you don't have
  to poll a long-running decompile to know when it's done. Unset, it
  still loads successfully but stays idle. No retries if your endpoint
  is down.

Copy either folder as a starting point for a real plugin.

