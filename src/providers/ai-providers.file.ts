import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Named AI providers loaded from a JSON file (AI_PROVIDERS_PATH). Every
 * entry speaks the OpenAI Chat Completions shape - they reuse
 * completeWithOpenAiCompatibleShape() in ai.provider.ts, so "adding a
 * provider" for a self-hosted or less-known endpoint is a file edit, not a
 * code change. apiKey is optional: absent means no Authorization header is
 * sent, which is what a local server (LM Studio, llama.cpp, vLLM behind a
 * LAN proxy) expects.
 */

export interface CustomAiProvider {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

const providerEntrySchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  model: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.coerce.number().int().positive().optional(),
});

const providersFileSchema = z.array(providerEntrySchema);

export function loadCustomAiProviders(filePath: string): CustomAiProvider[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `AI_PROVIDERS_PATH points at "${filePath}" but it could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `AI_PROVIDERS_PATH file "${filePath}" is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const result = providersFileSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map(
        (issue) =>
          `entry ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`,
      )
      .join("; ");
    throw new Error(`Invalid AI providers file "${filePath}": ${details}`);
  }

  const names = new Set<string>();
  for (const entry of result.data) {
    if (names.has(entry.name)) {
      throw new Error(
        `Invalid AI providers file "${filePath}": duplicate provider name "${entry.name}"`,
      );
    }
    names.add(entry.name);
  }

  return result.data;
}
