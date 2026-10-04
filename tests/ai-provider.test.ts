import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest } from "../src/providers/ai.provider.js";

// Every provider config value (AI_PROVIDER, each *_API_KEY, each *_MODEL) is
// read from src/core/config.ts, which parses process.env once at import
// time - same situation as local-storage.provider.test.ts's DATA_DIR.
// loadWithEnv() sets the relevant vars and re-imports the module fresh so
// each test gets exactly the config it asked for.
//
// Values are always strings, never `undefined` - deleting a key instead
// would let dotenv/config (which only fills in keys *absent* from
// process.env) repopulate it from a developer's real local .env file,
// silently breaking a "not configured" test on their machine. An empty
// string is a defined-but-falsy value, which is what these "not
// configured" checks actually test for (`!config.SOME_API_KEY`).
type AiProviderModule = typeof import("../src/providers/ai.provider.js");

async function loadWithEnv(env: Record<string, string>): Promise<AiProviderModule> {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return import("../src/providers/ai.provider.js");
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function textErrorResponse(status: number, bodyText: string): Response {
  return {
    ok: false,
    status,
    json: async () => {
      throw new Error("response body is not JSON");
    },
    text: async () => bodyText,
  } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const req: CompletionRequest = { prompt: "hi" };

describe("ai.provider - Anthropic", () => {
  it("throws without calling fetch when ANTHROPIC_API_KEY is unset", async () => {
    const mod = await loadWithEnv({
      AI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "",
    });
    await expect(mod.complete(req)).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the expected request and joins multiple text blocks, skipping non-text ones", async () => {
    const mod = await loadWithEnv({
      AI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_MODEL: "claude-x",
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use" },
          { type: "text", text: "world" },
        ],
      }),
    );

    const result = await mod.complete({
      system: "be nice",
      prompt: "hi",
      history: [{ role: "user", content: "prev turn" }],
      maxTokens: 50,
    });

    expect(result).toBe("Hello\nworld");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers).toMatchObject({
      "x-api-key": "sk-test",
      "anthropic-version": "2023-06-01",
    });
    expect(JSON.parse(init.body)).toEqual({
      model: "claude-x",
      max_tokens: 50,
      system: "be nice",
      messages: [
        { role: "user", content: "prev turn" },
        { role: "user", content: "hi" },
      ],
    });
  });

  it("surfaces a non-ok response as an error with status and truncated body", async () => {
    const mod = await loadWithEnv({
      AI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-test",
    });
    fetchMock.mockResolvedValueOnce(textErrorResponse(500, "internal error"));

    await expect(mod.complete(req)).rejects.toThrow(/Anthropic API error \(500\).*internal error/s);
  });

  it("throws a clear error when the response has no text content (malformed/empty)", async () => {
    const mod = await loadWithEnv({
      AI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-test",
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { content: [] }));

    await expect(mod.complete(req)).rejects.toThrow(/Anthropic API returned no text content/);
  });
});

// Groq, OpenAI, DeepSeek, xAI, and Mistral are all one-line wrappers around
// the same completeWithOpenAiCompatibleShape() - testing Groq exercises
// that shared implementation; the other four only differ by base URL/env
// var names, which isn't worth a near-identical copy of every test below.
describe("ai.provider - OpenAI-compatible shape (via Groq)", () => {
  it("throws without calling fetch when GROQ_API_KEY is unset", async () => {
    const mod = await loadWithEnv({ AI_PROVIDER: "groq", GROQ_API_KEY: "" });
    await expect(mod.complete(req)).rejects.toThrow(/GROQ_API_KEY is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends system+history+prompt as one messages array with a Bearer token", async () => {
    const mod = await loadWithEnv({
      AI_PROVIDER: "groq",
      GROQ_API_KEY: "gsk-test",
      GROQ_MODEL: "llama-x",
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        choices: [{ message: { content: " Hello there " } }],
      }),
    );

    const result = await mod.complete({
      system: "be nice",
      prompt: "hi",
      history: [{ role: "assistant", content: "prev reply" }],
    });

    expect(result).toBe("Hello there"); // trimmed
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer gsk-test");
    expect(JSON.parse(init.body)).toEqual({
      model: "llama-x",
      messages: [
        { role: "system", content: "be nice" },
        { role: "assistant", content: "prev reply" },
        { role: "user", content: "hi" },
      ],
      max_tokens: 1024,
    });
  });

  it("surfaces a non-ok response as an error with status and truncated body", async () => {
    const mod = await loadWithEnv({
      AI_PROVIDER: "groq",
      GROQ_API_KEY: "gsk-test",
    });
    fetchMock.mockResolvedValueOnce(textErrorResponse(429, "rate limited"));

    await expect(mod.complete(req)).rejects.toThrow(/Groq API error \(429\).*rate limited/s);
  });

  it("throws a clear error when the response has no message content (malformed/empty)", async () => {
    const mod = await loadWithEnv({
      AI_PROVIDER: "groq",
      GROQ_API_KEY: "gsk-test",
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { choices: [] }));

    await expect(mod.complete(req)).rejects.toThrow(/Groq API returned no text content/);
  });

  it("wraps a network-level fetch failure in a friendlier reachability error", async () => {
    const mod = await loadWithEnv({
      AI_PROVIDER: "groq",
      GROQ_API_KEY: "gsk-test",
    });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(mod.complete(req)).rejects.toThrow(
      /Could not reach Groq at https:\/\/api\.groq\.com\/openai\/v1.*fetch failed/s,
    );
  });
});

describe("ai.provider - openai-compatible (generic escape hatch)", () => {
  it("throws without calling fetch when OPENAI_COMPATIBLE_MODEL is unset", async () => {
    const mod = await loadWithEnv({
      AI_PROVIDER: "openai-compatible",
      OPENAI_COMPATIBLE_MODEL: "",
    });
    await expect(mod.complete(req)).rejects.toThrow(/OPENAI_COMPATIBLE_MODEL is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits the Authorization header when no API key is configured (the common local-server case)", async () => {
    const mod = await loadWithEnv({
      AI_PROVIDER: "openai-compatible",
      OPENAI_COMPATIBLE_MODEL: "local-model",
      OPENAI_COMPATIBLE_API_KEY: "",
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { choices: [{ message: { content: "ok" } }] }),
    );

    await mod.complete(req);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:1234/v1/chat/completions"); // default OPENAI_COMPATIBLE_BASE_URL
    expect(init.headers.Authorization).toBeUndefined();
  });
});

describe("ai.provider - Gemini", () => {
  it("throws without calling fetch when GEMINI_API_KEY is unset", async () => {
    const mod = await loadWithEnv({
      AI_PROVIDER: "gemini",
      GEMINI_API_KEY: "",
    });
    await expect(mod.complete(req)).rejects.toThrow(/GEMINI_API_KEY is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps the assistant role to "model" and puts the API key in the URL', async () => {
    const mod = await loadWithEnv({
      AI_PROVIDER: "gemini",
      GEMINI_API_KEY: "g-key",
      GEMINI_MODEL: "gemini-x",
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: "Hello" }, { text: " world" }] } }],
      }),
    );

    const result = await mod.complete({
      system: "be nice",
      prompt: "hi",
      history: [{ role: "assistant", content: "prev reply" }],
    });

    expect(result).toBe("Hello world");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent?key=g-key",
    );
    const body = JSON.parse(init.body);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "be nice" }] });
    expect(body.contents).toEqual([
      { role: "model", parts: [{ text: "prev reply" }] },
      { role: "user", parts: [{ text: "hi" }] },
    ]);
  });

  it("surfaces a non-ok response as an error with status and truncated body", async () => {
    const mod = await loadWithEnv({
      AI_PROVIDER: "gemini",
      GEMINI_API_KEY: "g-key",
    });
    fetchMock.mockResolvedValueOnce(textErrorResponse(400, "bad request"));

    await expect(mod.complete(req)).rejects.toThrow(/Gemini API error \(400\).*bad request/s);
  });

  it("throws a clear error when the response has no text content (malformed/empty)", async () => {
    const mod = await loadWithEnv({
      AI_PROVIDER: "gemini",
      GEMINI_API_KEY: "g-key",
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { candidates: [] }));

    await expect(mod.complete(req)).rejects.toThrow(/Gemini API returned no text content/);
  });
});

describe("ai.provider - Ollama", () => {
  it("omits the Authorization header when OLLAMA_API_KEY is unset (the local-model case)", async () => {
    const mod = await loadWithEnv({
      AI_PROVIDER: "ollama",
      OLLAMA_API_KEY: "",
      OLLAMA_MODEL: "llama3.3",
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { message: { content: "ok" } }));

    await mod.complete(req);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/chat"); // default OLLAMA_BASE_URL
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body).stream).toBe(false);
  });

  it('wraps a network-level fetch failure in a friendlier "is ollama serve running" error', async () => {
    const mod = await loadWithEnv({ AI_PROVIDER: "ollama" });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(mod.complete(req)).rejects.toThrow(/Is "ollama serve" running.*fetch failed/s);
  });

  it("surfaces a non-ok response as an error with status and truncated body", async () => {
    const mod = await loadWithEnv({ AI_PROVIDER: "ollama" });
    fetchMock.mockResolvedValueOnce(textErrorResponse(500, "model not found"));

    await expect(mod.complete(req)).rejects.toThrow(/Ollama API error \(500\).*model not found/s);
  });

  it("throws a clear error when the response has no message content (malformed/empty)", async () => {
    const mod = await loadWithEnv({ AI_PROVIDER: "ollama" });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));

    await expect(mod.complete(req)).rejects.toThrow(/Ollama API returned no message content/);
  });
});
