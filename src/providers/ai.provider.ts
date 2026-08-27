import { config, isAiConfigured } from "../core/config.js";

/**
 * AI Provider Layer, per HexForge_Architecture_v2.md's Provider Layer:
 * "Abstracts Supabase, AI providers, Redis, and future integrations."
 *
 * Everything above this file (the "ai" MCP agent, Knowledge Engine
 * summarization) only ever calls `complete()`. Swapping AI_PROVIDER later
 * (a different vendor, a local model) means adding one more branch in this
 * one file - nothing above it needs to change, same reason
 * `providers/supabase.client.ts` is the only file that imports
 * `@supabase/supabase-js`.
 */

export { isAiConfigured };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  system?: string;
  prompt: string; // the latest user message
  history?: ChatMessage[]; // prior turns, oldest first - omit for a single-shot completion
  maxTokens?: number;
}

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

async function completeWithAnthropic(req: CompletionRequest): Promise<string> {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set - AI provider is not configured.");
  }

  const messages = [...(req.history ?? []), { role: "user", content: req.prompt }];

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.ANTHROPIC_MODEL,
      max_tokens: req.maxTokens ?? 1024,
      system: req.system,
      messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Anthropic API error (${response.status}): ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as AnthropicMessagesResponse;
  const text = (data.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) throw new Error("Anthropic API returned no text content");
  return text;
}

interface OpenAiCompatibleChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Shared implementation for every provider that speaks the OpenAI Chat
 * Completions shape (still the most broadly-supported format even as
 * OpenAI itself pushes newer capabilities toward the Responses API) -
 * Groq, real OpenAI, and any generic "openai-compatible" local server
 * (LM Studio, llama.cpp's server, vLLM, text-generation-webui,
 * OpenRouter, ...) all reuse this instead of three near-identical copies.
 */
async function completeWithOpenAiCompatibleShape(
  providerLabel: string,
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  req: CompletionRequest
): Promise<string> {
  const messages = [
    ...(req.system ? [{ role: "system", content: req.system }] : []),
    ...(req.history ?? []),
    { role: "user", content: req.prompt },
  ];

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages, max_tokens: req.maxTokens ?? 1024 }),
    });
  } catch (err) {
    throw new Error(
      `Could not reach ${providerLabel} at ${baseUrl}. (${err instanceof Error ? err.message : String(err)})`
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${providerLabel} API error (${response.status}): ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as OpenAiCompatibleChatResponse;
  const text = data.choices?.[0]?.message?.content?.trim();

  if (!text) throw new Error(`${providerLabel} API returned no text content`);
  return text;
}

async function completeWithGroq(req: CompletionRequest): Promise<string> {
  if (!config.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set - AI provider is not configured.");
  }
  return completeWithOpenAiCompatibleShape(
    "Groq",
    "https://api.groq.com/openai/v1",
    config.GROQ_API_KEY,
    config.GROQ_MODEL,
    req
  );
}

async function completeWithOpenAi(req: CompletionRequest): Promise<string> {
  if (!config.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set - AI provider is not configured.");
  }
  return completeWithOpenAiCompatibleShape("OpenAI", "https://api.openai.com/v1", config.OPENAI_API_KEY, config.OPENAI_MODEL, req);
}

async function completeWithDeepseek(req: CompletionRequest): Promise<string> {
  if (!config.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is not set - AI provider is not configured.");
  }
  return completeWithOpenAiCompatibleShape("DeepSeek", "https://api.deepseek.com/v1", config.DEEPSEEK_API_KEY, config.DEEPSEEK_MODEL, req);
}

async function completeWithXai(req: CompletionRequest): Promise<string> {
  if (!config.XAI_API_KEY) {
    throw new Error("XAI_API_KEY is not set - AI provider is not configured.");
  }
  return completeWithOpenAiCompatibleShape("xAI", "https://api.x.ai/v1", config.XAI_API_KEY, config.XAI_MODEL, req);
}

async function completeWithMistral(req: CompletionRequest): Promise<string> {
  if (!config.MISTRAL_API_KEY) {
    throw new Error("MISTRAL_API_KEY is not set - AI provider is not configured.");
  }
  return completeWithOpenAiCompatibleShape("Mistral", "https://api.mistral.ai/v1", config.MISTRAL_API_KEY, config.MISTRAL_MODEL, req);
}

/**
 * Generic escape hatch for anything else that speaks the same Chat
 * Completions shape - point it at LM Studio (default port 1234),
 * llama.cpp's built-in server, vLLM, text-generation-webui, OpenRouter,
 * or any other OpenAI-compatible endpoint. Unlike the named providers
 * above, there's no sensible default model - it varies entirely by what
 * you're running, so it's required rather than defaulted.
 */
async function completeWithOpenAiCompatible(req: CompletionRequest): Promise<string> {
  if (!config.OPENAI_COMPATIBLE_MODEL) {
    throw new Error(
      "OPENAI_COMPATIBLE_MODEL is not set - required for AI_PROVIDER=openai-compatible since there's no " +
        "sensible default across different local servers. Set it to whatever model name your server expects."
    );
  }
  return completeWithOpenAiCompatibleShape(
    "OpenAI-compatible endpoint",
    config.OPENAI_COMPATIBLE_BASE_URL,
    config.OPENAI_COMPATIBLE_API_KEY,
    config.OPENAI_COMPATIBLE_MODEL,
    req
  );
}

interface GeminiGenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

async function completeWithGemini(req: CompletionRequest): Promise<string> {
  if (!config.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set - AI provider is not configured.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.GEMINI_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`;

  // Gemini calls the assistant's role "model", not "assistant" - the only
  // shape difference from every other provider here, otherwise it's the
  // same "history + new turn" idea.
  const historyContents = (req.history ?? []).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: [...historyContents, { role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: { maxOutputTokens: req.maxTokens ?? 1024 },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Gemini API error (${response.status}): ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as GeminiGenerateResponse;
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();

  if (!text) throw new Error("Gemini API returned no text content");
  return text;
}

interface OllamaChatResponse {
  message?: { content?: string };
}

/**
 * Ollama's /api/chat handles both local and cloud models through the same
 * endpoint - which one you get depends only on OLLAMA_MODEL (cloud models
 * are named like "gpt-oss:120b-cloud") and whether OLLAMA_API_KEY is set
 * (required for cloud, ignored for local). No separate "ollama-cloud"
 * provider needed - see https://docs.ollama.com/cloud.
 */
async function completeWithOllama(req: CompletionRequest): Promise<string> {
  const messages = [
    ...(req.system ? [{ role: "system", content: req.system }] : []),
    ...(req.history ?? []),
    { role: "user", content: req.prompt },
  ];

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.OLLAMA_API_KEY) headers.Authorization = `Bearer ${config.OLLAMA_API_KEY}`;

  let response: Response;
  try {
    response = await fetch(`${config.OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: config.OLLAMA_MODEL, messages, stream: false }),
    });
  } catch (err) {
    throw new Error(
      `Could not reach Ollama at ${config.OLLAMA_BASE_URL}. Is "ollama serve" running? (${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Ollama API error (${response.status}): ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as OllamaChatResponse;
  const text = data.message?.content?.trim();

  if (!text) throw new Error("Ollama API returned no message content");
  return text;
}

/**
 * Runs a single text completion against the configured AI provider.
 * Throws if AI_PROVIDER isn't supported or the provider isn't configured -
 * callers should check `isAiConfigured` first if they want to fail softer
 * (e.g. a 503 instead of a 502) than just letting this throw.
 */
export async function complete(req: CompletionRequest): Promise<string> {
  switch (config.AI_PROVIDER) {
    case "anthropic":
      return completeWithAnthropic(req);
    case "groq":
      return completeWithGroq(req);
    case "gemini":
      return completeWithGemini(req);
    case "ollama":
      return completeWithOllama(req);
    case "openai":
      return completeWithOpenAi(req);
    case "deepseek":
      return completeWithDeepseek(req);
    case "xai":
      return completeWithXai(req);
    case "mistral":
      return completeWithMistral(req);
    case "openai-compatible":
      return completeWithOpenAiCompatible(req);
    default:
      throw new Error(
        `Unsupported AI_PROVIDER "${config.AI_PROVIDER}". Implemented: "anthropic", "groq", "gemini", "ollama", ` +
          `"openai", "deepseek", "xai", "mistral", "openai-compatible".`
      );
  }
}
