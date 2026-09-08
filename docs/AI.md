# AI Provider Layer

`src/providers/ai.provider.ts` exposes one function, `complete()`, backed
by nine interchangeable providers - **Anthropic**, **Groq**, **Gemini**,
**Ollama**, **OpenAI**, **DeepSeek**, **xAI (Grok)**, **Mistral**, and a
generic **openai-compatible** option for anything else that speaks the
same shape (LM Studio, llama.cpp's server, vLLM, text-generation-webui,
OpenRouter, ...). Six of these - Groq, OpenAI, DeepSeek, xAI, Mistral,
and openai-compatible - share one implementation internally
(`completeWithOpenAiCompatibleShape`) since they're all the OpenAI Chat
Completions request/response shape against a different base URL; only
Anthropic, Gemini, and Ollama needed their own code. Adding a new
provider that speaks this shape is a ~10-line addition - see
`CONTRIBUTING.md`.

```bash
AI_PROVIDER=anthropic   # or "groq", "gemini", "ollama", "openai", "deepseek", "xai", "mistral", "openai-compatible"

# Only the settings matching AI_PROVIDER are required - the rest can stay blank.
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5          # optional, this is the default

GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile       # optional, this is the default

GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-2.0-flash            # optional, this is the default

OLLAMA_BASE_URL=http://localhost:11434   # optional, this is the default
OLLAMA_MODEL=llama3.3                    # optional, this is the default
OLLAMA_API_KEY=                          # only needed for cloud models

OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.4-mini                # optional, this is the default

DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-v4-flash         # optional, this is the default - note deepseek-chat/deepseek-reasoner (older docs' examples) were deprecated 2026-07-24

XAI_API_KEY=xai-...
XAI_MODEL=grok-4-6                       # optional, this is the default

MISTRAL_API_KEY=...
MISTRAL_MODEL=mistral-large-latest       # optional, this is the default - a Mistral-maintained alias, not a version that goes stale

OPENAI_COMPATIBLE_BASE_URL=http://localhost:1234/v1   # optional, LM Studio's default
OPENAI_COMPATIBLE_API_KEY=               # most local servers don't need one
OPENAI_COMPATIBLE_MODEL=                 # required - no sensible default, depends what you're running
```

Groq and Gemini both have usable free tiers, unlike a fresh
Anthropic/OpenAI/DeepSeek/xAI/Mistral account which needs paid credits
first - handy for testing without billing setup. **Ollama** and
**openai-compatible** need zero API keys and zero external network
calls - everything runs on your own machine. Ollama is the simpler path
(install, `ollama serve`, `ollama pull llama3.3`) and also covers
Ollama's *cloud* models through the same endpoint - point `OLLAMA_MODEL`
at a `-cloud`-suffixed name (e.g. `gpt-oss:120b-cloud`) and set
`OLLAMA_API_KEY`, no separate provider needed. See
https://docs.ollama.com/cloud. `openai-compatible` is for anything else -
LM Studio, llama.cpp's server - point `OPENAI_COMPATIBLE_BASE_URL` at it
and set `OPENAI_COMPATIBLE_MODEL`.

`GET /health` reports `aiProvider` and `aiConfigured`. For Ollama,
`aiConfigured` just means "selected" - local mode has no key to check, so
the Gateway can't confirm the server is reachable without making a call.
Same for `openai-compatible`: it just means `OPENAI_COMPATIBLE_MODEL` is set.

Three things sit on top of the provider:

**The `ai` MCP agent** (`modules/mcp/agents/ai.agent.ts`) - a normal
agent (`agent: "ai"`), registered exactly like `jadx`/`apktool`. AI calls
made via a Job or Workflow step get retries and `job.*`/`workflow.*`
events for free. Operation: `"summarize"`, payload `{ content, instructions? }`.

```bash
curl -X POST http://localhost:8080/workspaces/<id>/jobs \
  -H "Content-Type: application/json" \
  -d '{"agent": "ai", "operation": "summarize", "payload": {"content": "..."}}'
```

**`summarizeEntry()`** (`modules/ai/ai.service.ts`) - reads an existing
`KnowledgeEntry`, summarizes it, stores the result as a new `"summary"`
entry linked back via `relatedEntryIds`.

```bash
curl -X POST http://localhost:8080/knowledge/<entryId>/summarize
```

Returns `503` if the configured provider's key isn't set, `502` if the
provider's API call fails (e.g. Anthropic's "credit balance too low", or
an invalid key).

**`chat()`** (`modules/ai/ai.service.ts`) - real multi-turn conversation,
not a single-shot completion. `CompletionRequest` has a `history` field;
every provider builds its own multi-turn shape from it (Anthropic's
`messages` array, Gemini's `contents` with `role: "model"` instead of
`"assistant"` - the one real shape difference - and the OpenAI-style
`{role, content}` array everyone else uses). History loads from that
workspace's `"chat"`-type `KnowledgeEntries` on every call rather than
held in memory, so a conversation survives a Gateway restart.

History size is bounded three ways, not just a flat turn count - a flat
count alone doesn't actually control token cost, since a handful of long
messages (someone pasting a large `summarize_text` result, a decompiled
file) can blow past any reasonable count-based limit anyway:
- **Turn count**: at most the most recent 20 turns are ever considered.
- **Per-message length**: any single historical turn over ~4,000
  characters is truncated (with a clear marker noting how much was cut)
  before being resent - without this, one huge message gets sent in full
  on every subsequent chat call for as long as it stays in the window,
  repeating that cost turn after turn.
- **Total character budget**: history is walked newest-first and capped
  at a combined ~12,000 characters (a rough token budget), so a chat
  full of long messages naturally includes fewer old turns than one with
  short messages, rather than a fixed count regardless of size.

The budget walk moves in complete turn-pairs (a user message with its
paired assistant reply), never splitting one - several providers
(Anthropic in particular) reject a message array that starts or ends on
the "wrong" role, so trimming mid-pair isn't just messier, it can break
the request outright. The live message you're sending right now is never
truncated by any of this - only *past* turns being resent as context are
affected.

```bash
curl -X POST http://localhost:8080/workspaces/<id>/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What did the last jadx decompile find?"}'

curl http://localhost:8080/workspaces/<id>/chat   # full transcript, oldest-first
```

Or from the terminal with `hf chat` - see `docs/CLI.md`.

