import type { McpTask } from "../../../core/types.js";
import * as aiProvider from "../../../providers/ai.provider.js";

interface SummarizePayload {
  content: string;
  instructions?: string;
}

function assertSummarizePayload(payload: Record<string, unknown>): SummarizePayload {
  const content = payload.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error('ai agent "summarize" operation requires a "content" string in the task payload');
  }
  const instructions = typeof payload.instructions === "string" ? payload.instructions : undefined;
  return { content, instructions };
}

const SUMMARIZE_SYSTEM_PROMPT =
  "You are HexForge's analysis assistant. Summarize reverse-engineering tool output " +
  "concisely and factually for a workspace's knowledge base. Do not speculate beyond " +
  "what's present in the content.";

/**
 * The "ai" MCP agent - matches the Job Engine example list in
 * HexForge_Architecture_v2.md ("Extract manifest, Decompile, Index source,
 * Generate embeddings, AI summary"). Registering AI calls as a regular
 * agent (like jadx/apktool) means "AI summary" steps get retries,
 * `job.*`/`workflow.*` events, and WebSocket broadcasts for free - no
 * separate code path needed in the Job or Workflow Engine.
 */
export async function aiHandler(task: McpTask): Promise<unknown> {
  if (task.operation !== "summarize") {
    throw new Error(`Unsupported ai operation "${task.operation}". Supported: "summarize"`);
  }

  const { content, instructions } = assertSummarizePayload(task.payload);

  const summary = await aiProvider.complete({
    system: SUMMARIZE_SYSTEM_PROMPT,
    prompt: instructions ? `${instructions}\n\n---\n\n${content}` : content,
    maxTokens: 512,
  });

  return { summary };
}
