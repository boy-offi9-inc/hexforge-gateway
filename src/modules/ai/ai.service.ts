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
// entries (user + assistant), so this is *turns*, not entries. This
// alone doesn't actually bound token cost though - 20 turns of long
// messages can still be huge - so it's paired with the two budgets below.
const MAX_CHAT_HISTORY_TURNS = 20;
// Total character budget for the history resent on every chat call
// (~4 chars/token, so this is a rough ~3000-token ceiling on context from
// history alone). This is what actually controls cost: a chat with short
// messages fits more turns in this budget; one with long messages fits
// fewer. Walking newest-first and stopping once the budget's spent means
// older turns are the ones dropped, not more recent (more relevant) ones.
const MAX_CHAT_HISTORY_CHARS = 12_000;
// Caps any single historical turn's content before it's resent as
// context - without this, one huge message (someone pasting a large
// summarize_text result, a big decompiled file, etc.) gets sent in full
// on every subsequent chat call for as long as it stays within the turn
// window, repeating that cost turn after turn. Only applies to *past*
// turns being resent as context; the live message being sent right now
// is never truncated, since silently cutting what someone just typed
// would produce confusing "why didn't it see the rest" behavior.
const MAX_HISTORY_MESSAGE_CHARS = 4_000;

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
 * Builds the history array sent to the AI provider from a workspace's
 * stored chat entries (newest-first, as returned by
 * listEntriesForWorkspace). Walks newest-to-oldest, truncating any
 * individual turn over MAX_HISTORY_MESSAGE_CHARS and stopping once
 * MAX_CHAT_HISTORY_CHARS total is spent - so cost scales with what's
 * actually in the conversation instead of a flat turn count that a few
 * long messages could blow through silently.
 *
 * Assumes each turn's two entries (user message, then assistant reply)
 * land adjacent in newest-first order, which holds for a single caller
 * chatting normally - the assistant entry is always created after its
 * user entry. Two concurrent chat() calls on the *same* workspace from
 * different clients could theoretically interleave and break that
 * adjacency; not handled here, since it's a narrow race in what's still
 * a single-operator tool, not a data-loss risk (worst case is one
 * imperfectly-paired turn near the trim boundary, not corruption).
 */
function buildChatHistory(recentEntriesNewestFirst: KnowledgeEntry[]): ChatMessage[] {
  const candidates = recentEntriesNewestFirst.slice(0, MAX_CHAT_HISTORY_TURNS * 2);
  const picked: ChatMessage[] = [];
  let remainingBudget = MAX_CHAT_HISTORY_CHARS;

  const truncate = (content: string) =>
    content.length > MAX_HISTORY_MESSAGE_CHARS
      ? `${content.slice(0, MAX_HISTORY_MESSAGE_CHARS)}\n[...truncated, ${
          content.length - MAX_HISTORY_MESSAGE_CHARS
        } more characters omitted from history]`
      : content;

  // Walk in pairs (assistant reply + its user message, newest-first),
  // never splitting one turn across the budget boundary - a message
  // array that starts or ends on the "wrong" role isn't just confusing,
  // several providers (Anthropic in particular) reject it outright since
  // they require strict user/assistant alternation.
  for (let i = 0; i + 1 < candidates.length; i += 2) {
    const [newer, older] = [candidates[i], candidates[i + 1]];
    const newerContent = truncate(newer.content);
    const olderContent = truncate(older.content);
    const pairLength = newerContent.length + olderContent.length;

    if (pairLength > remainingBudget) break;

    picked.push({ role: newer.source === "user" ? "user" : "assistant", content: newerContent });
    picked.push({ role: older.source === "user" ? "user" : "assistant", content: olderContent });
    remainingBudget -= pairLength;
  }

  return picked.reverse(); // was newest-first for the walk, provider wants chronological
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
  const history = buildChatHistory(recent);

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
