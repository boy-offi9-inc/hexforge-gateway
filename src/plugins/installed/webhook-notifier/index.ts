import type { HexForgePlugin } from "../../types.js";

// Reference plugin #2 - demonstrates the event-only extension pattern
// (no new agent, no new route): notify an external webhook whenever a Job
// or Workflow finishes, so you don't have to poll a long-running jadx
// decompile or AI summarize job to know when it's done.
//
// Configure via env (not through PluginContext - env vars are a Node
// global, not a core-internal concern the plugin contract needs to
// mediate):
//   WEBHOOK_NOTIFIER_URL=https://example.com/hooks/hexforge
//
// If unset, the plugin still loads successfully but does nothing beyond
// logging that it's idle - a plugin not being configured shouldn't count
// as a load failure.
//
// POSTs a small JSON body: { kind: "job"|"workflow", status, id, name?,
// agent?, operation?, error? }. No retries, no delivery guarantees - if
// your webhook endpoint is down, the notification is just lost. Add
// retry logic yourself if that matters for your use case.

interface NotifyBody {
  kind: "job" | "workflow";
  status: string;
  id: string;
  name?: string;
  agent?: string;
  operation?: string;
  error?: string;
}

const plugin: HexForgePlugin = {
  name: "webhook-notifier",
  version: "0.1.0",
  description: "POSTs to WEBHOOK_NOTIFIER_URL when a Job or Workflow completes or fails.",

  register(ctx) {
    const url = process.env.WEBHOOK_NOTIFIER_URL;
    if (!url) {
      ctx.log.info("WEBHOOK_NOTIFIER_URL not set - loaded, but idle. Set it in .env to enable notifications.");
      return;
    }

    const post = async (body: NotifyBody) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) ctx.log.warn(`webhook POST returned ${res.status} for ${body.kind} ${body.id}`);
      } catch (err) {
        ctx.log.warn(`webhook POST failed for ${body.kind} ${body.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    ctx.on("job.completed", (payload) =>
      post({ kind: "job", status: "completed", id: payload.job.id, agent: payload.job.agent, operation: payload.job.operation })
    );
    ctx.on("job.failed", (payload) =>
      post({
        kind: "job",
        status: "failed",
        id: payload.job.id,
        agent: payload.job.agent,
        operation: payload.job.operation,
        error: payload.job.error,
      })
    );
    ctx.on("workflow.completed", (payload) =>
      post({ kind: "workflow", status: "completed", id: payload.workflow.id, name: payload.workflow.name })
    );
    ctx.on("workflow.failed", (payload) =>
      post({ kind: "workflow", status: "failed", id: payload.workflow.id, name: payload.workflow.name, error: payload.workflow.error })
    );

    ctx.log.info(`notifying ${url} on job/workflow completion and failure`);
  },
};

export default plugin;
