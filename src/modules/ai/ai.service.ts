import * as aiProvider from "../../providers/ai.provider.js";
import * as knowledgeService from "../knowledge/knowledge.service.js";
import type { KnowledgeEntry } from "../../core/types.js";
import type { ChatMessage } from "../../providers/ai.provider.js";

export const isAiConfigured = aiProvider.isAiConfigured;

const SUMMARIZE_SYSTEM_PROMPT =
  "You are HexForge's analysis assistant. Summarize the following knowledge base entry " +
  "concisely and factually for a reverse-engineering workspace. Do not speculate beyond " +
  "what's given.";

const CHAT_SYSTEM_PROMPT =
  "You are HexForge's assistant, helping analyze reverse-engineering work in this workspace " +
  "(APKs, decompiled code, jobs and workflows that have run, and anything in the knowledge base). " +
  "Be direct and concrete. If you don't have enough context to answer something specific, say so " +
  "rather than guessing.";

// How many prior turns to feed back as context. Each turn is 2 knowledge
// entries (user + assistant), so this is *turns*, not entries. Capped
// rather than unbounded so a long-running chat doesn't quietly grow the
// prompt (and therefore cost/latency) on every single message.
const MAX_CHAT_HISTORY_TURNS = 20;

/**
 * Generates an AI summary of an existing KnowledgeEntry and stores it as a
 * new "summary" entry, linked back to the original via `relatedEntryIds`.
 * This is Data Flow step 7 in HexForge_Architecture_v2.md ("AI generates
 * insights") - it sits on top of the Knowledge Engine rather than inside
 * it, the same way the Knowledge Indexer sits on top of the Workflow
 * Engine: this module reaches into knowledge.service directly (a normal
 * call, not an event) because summarization is a request-driven action a
 * caller waits on, not a reaction to something happening elsewhere.
 */
export async function summarizeEntry(entryId: string): Promise<KnowledgeEntry> {
  const entry = await knowledgeService.getEntry(entryId);
  if (!entry) throw new Error(`Knowledge entry ${entryId} not found`);

  const summaryText = await aiProvider.complete({
    system: SUMMARIZE_SYSTEM_PROMPT,
    prompt: `Title: ${entry.title}\n\n${entry.content}`,
    maxTokens: 512,
  });

  return knowledgeService.createEntry({
    workspaceId: entry.workspaceId,
    type: "summary",
    title: `Summary: ${entry.title}`,
    content: summaryText,
    source: "system",
    sourceId: entry.id,
    relatedEntryIds: [entry.id],
  });
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

/**
 * Sends one message in a workspace's ongoing chat and returns the reply.
 * Uses the `"chat"` KnowledgeEntryType that's been in the schema since
 * the Knowledge Engine was built but had no writer yet - each turn
 * (both the user's message and the assistant's reply) is stored as its
 * own entry, `source: "user"` vs `source: "system"` distinguishing which
 * side said it, reusing the field that already exists rather than adding
 * a new one just for this.
 *
 * History is loaded from those same entries on every call rather than
 * held in memory, so a chat survives a Gateway restart and multiple
 * clients (the CLI, a future web UI) share one conversation per
 * workspace rather than each keeping their own.
 */
export async function chat(workspaceId: string, message: string): Promise<{ reply: string; entryId: string }> {
  const recent = await knowledgeService.listEntriesForWorkspace(workspaceId, { type: "chat" });
  // listEntriesForWorkspace returns newest-first; take the most recent
  // turns, then reverse into chronological order for the provider.
  const history: ChatMessage[] = recent
    .slice(0, MAX_CHAT_HISTORY_TURNS * 2)
    .reverse()
    .map((entry) => ({ role: entry.source === "user" ? "user" : "assistant", content: entry.content }));

  await knowledgeService.createEntry({
    workspaceId,
    type: "chat",
    title: "You",
    content: message,
    source: "user",
  });

  const reply = await aiProvider.complete({
    system: CHAT_SYSTEM_PROMPT,
    prompt: message,
    history,
    maxTokens: 1024,
  });

  const replyEntry = await knowledgeService.createEntry({
    workspaceId,
    type: "chat",
    title: "HexForge AI",
    content: reply,
    source: "system",
  });

  return { reply, entryId: replyEntry.id };
}
