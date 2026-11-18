import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

// Custom AI providers come from a JSON file read once at import time (same
// situation as the *_API_KEY vars in ai-provider.test.ts), so each test
// writes its file, sets AI_PROVIDERS_PATH, and re-imports the module graph
// fresh. All request-shape assertions mock fetch like ai-provider.test.ts.

type FileModule = typeof import("../src/providers/ai-providers.file.js");
type ProviderModule = typeof import("../src/providers/ai.provider.js");

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "hexforge-ai-providers-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function writeProvidersFile(entries: unknown): Promise<string> {
  const filePath = path.join(dataDir, "providers.json");
  await writeFile(filePath, JSON.stringify(entries), "utf-8");
  return filePath;
}

async function loadWithFile(filePath: string | undefined): Promise<ProviderModule> {
  vi.resetModules();
  if (filePath) vi.stubEnv("AI_PROVIDERS_PATH", filePath);
  vi.stubEnv("AI_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
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

const validEntry = {
  name: "lan-llama",
  baseUrl: "http://192.168.1.10:1234/v1",
  model: "qwen3-32b",
};

describe("ai-providers.file - loading and validation", () => {
  it("loads a valid file with optional fields", async () => {
    const filePath = await writeProvidersFile([
      { ...validEntry, apiKey: "secret-key", headers: { "X-Team": "re" }, timeoutMs: 5000 },
    ]);
    const mod: FileModule = await import("../src/providers/ai-providers.file.js");
    const providers = mod.loadCustomAiProviders(filePath);
    expect(providers).toEqual([
      { ...validEntry, apiKey: "secret-key", headers: { "X-Team": "re" }, timeoutMs: 5000 },
    ]);
  });

  it("rejects a file that is not valid JSON, naming the path", async () => {
    const filePath = path.join(dataDir, "broken.json");
    await writeFile(filePath, "{not json", "utf-8");
    const mod: FileModule = await import("../src/providers/ai-providers.file.js");
    expect(() => mod.loadCustomAiProviders(filePath)).toThrow(/broken\.json" is not valid JSON/s);
  });

  it("rejects an unreadable file", async () => {
    const mod: FileModule = await import("../src/providers/ai-providers.file.js");
    expect(() => mod.loadCustomAiProviders(path.join(dataDir, "missing.json"))).toThrow(
      /could not be read/,
    );
  });

  it("rejects a structurally invalid entry, naming the offending entry and field", async () => {
    const filePath = await writeProvidersFile([
      { ...validEntry },
      { name: "bad-one", baseUrl: "not-a-url" },
    ]);
    const mod: FileModule = await import("../src/providers/ai-providers.file.js");
    expect(() => mod.loadCustomAiProviders(filePath)).toThrow(
      /Invalid AI providers file.*entry 1\.baseUrl/,
    );
  });

  it("rejects duplicate provider names", async () => {
    const filePath = await writeProvidersFile([{ ...validEntry }, { ...validEntry }]);
    const mod: FileModule = await import("../src/providers/ai-providers.file.js");
    expect(() => mod.loadCustomAiProviders(filePath)).toThrow(/duplicate provider name/);
  });

  it("rejects a non-array file", async () => {
    const filePath = await writeProvidersFile({ name: "nope" });
    const mod: FileModule = await import("../src/providers/ai-providers.file.js");
    expect(() => mod.loadCustomAiProviders(filePath)).toThrow(/Invalid AI providers file/);
  });
});

describe("ai.provider - custom providers", () => {
  it("routes a completion to a named file provider", async () => {
    const filePath = await writeProvidersFile([validEntry]);
    const mod = await loadWithFile(filePath);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { choices: [{ message: { content: "from lan" } }] }),
    );

    const result = await mod.complete({ prompt: "hi" }, { provider: "lan-llama" });

    expect(result).toBe("from lan");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://192.168.1.10:1234/v1/chat/completions");
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      model: "qwen3-32b",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
    });
  });

  it("sends extra headers and the Bearer token when apiKey is set", async () => {
    const filePath = await writeProvidersFile([
      { ...validEntry, apiKey: "file-key", headers: { "X-Team": "re" } },
    ]);
    const mod = await loadWithFile(filePath);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { choices: [{ message: { content: "ok" } }] }),
    );

    await mod.complete({ prompt: "hi" }, { provider: "lan-llama" });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer file-key");
    expect(init.headers["X-Team"]).toBe("re");
  });

  it("honors per-entry timeoutMs (no retry after a timeout at the custom window)", async () => {
    const filePath = await writeProvidersFile([{ ...validEntry, timeoutMs: 2000 }]);
    const mod = await loadWithFile(filePath);
    vi.useFakeTimers();
    try {
      fetchMock.mockReturnValue(new Promise(() => {}));
      const outcome = expect(
        mod.complete({ prompt: "hi" }, { provider: "lan-llama" }),
      ).rejects.toThrow(/Timed out after 2000ms/);
      await vi.advanceTimersByTimeAsync(2_000);
      await outcome;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("AI_PROVIDER can name a file provider directly, and isAiConfigured counts it", async () => {
    const filePath = await writeProvidersFile([validEntry]);
    vi.resetModules();
    vi.stubEnv("AI_PROVIDERS_PATH", filePath);
    vi.stubEnv("AI_PROVIDER", "lan-llama");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { config, isAiConfigured } = await import("../src/core/config.js");
    const mod = await import("../src/providers/ai.provider.js");

    expect(config.AI_PROVIDER).toBe("lan-llama");
    expect(isAiConfigured).toBe(true);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { choices: [{ message: { content: "ok" } }] }),
    );
    await expect(mod.complete({ prompt: "hi" })).resolves.toBe("ok");
    expect(fetchMock.mock.calls[0][0]).toBe("http://192.168.1.10:1234/v1/chat/completions");
  });

  it("an unknown provider name errors listing available names", async () => {
    const filePath = await writeProvidersFile([validEntry]);
    const mod = await loadWithFile(filePath);
    await expect(mod.complete({ prompt: "hi" }, { provider: "no-such" })).rejects.toThrow(
      /Unsupported AI provider "no-such". Available:.*"anthropic".*"lan-llama"/s,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a bad providers file fails the boot", async () => {
    const filePath = await writeProvidersFile([{ name: "x", baseUrl: "nope" }]);
    vi.resetModules();
    vi.stubEnv("AI_PROVIDERS_PATH", filePath);

    await expect(import("../src/core/config.js")).rejects.toThrow(
      /Invalid AI providers file.*entry 0\.baseUrl/,
    );
  });
});
