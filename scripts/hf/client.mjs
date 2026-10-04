/**
 * The hf CLI's connection to the Gateway: one small fetch wrapper that turns
 * every failure into a GatewayError with a *kind* the caller can render
 * helpfully (network / timeout / auth / http), plus the persisted "current
 * workspace/job/workflow" state.
 *
 * Node's built-in fetch, no dependencies - Node 22 is already a hard
 * requirement of the Gateway itself, so the CLI can rely on it.
 */

import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync
} from "node:fs";
import {
    homedir
} from "node:os";
import path from "node:path";

// --- state ----------------------------------------------------------------

/**
 * Same file and format the original bash hf.sh used (~/.hexforge/state.env,
 * plain KEY="value" lines), so switching between the two never loses your
 * current workspace. HF_STATE_DIR overrides the location - used by tests so
 * they never touch a real home directory.
 */
export function stateFile(env = process.env) {
    return path.join(env.HF_STATE_DIR || path.join(homedir(), ".hexforge"), "state.env");
}

export function readState(env = process.env) {
    const file = stateFile(env);
    if (!existsSync(file)) return {};
    const state = {};
    for (const line of readFileSync(file, "utf8").split("\n")) {
        const m = line.match(/^([A-Z][A-Z0-9_]*)=(?:"(.*)"|(.*))$/);
        if (m) state[m[1]] = m[2] ?? m[3] ?? "";
    }
    return state;
}

/** Sets or removes (value === undefined) one key, preserving every other line - including ones this CLI doesn't know about. */
export function saveState(key, value, env = process.env) {
    const file = stateFile(env);
    mkdirSync(path.dirname(file), {
        recursive: true
    });
    const kept = existsSync(file) ?
        readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "" && !l.startsWith(`${key}=`)) :
        [];
    if (value !== undefined) kept.push(`${key}="${String(value).replace(/["\\$`]/g, "\\$&")}"`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, kept.join("\n") + (kept.length ? "\n" : ""));
  renameSync(tmp, file);
}

// --- errors ---------------------------------------------------------------

export class GatewayError extends Error {
  /**
   * @param {string} message
   * @param {{ kind: "network"|"timeout"|"auth"|"http", status?: number, body?: unknown, url?: string }} info
   */
  constructor(message, { kind, status, body, url }) {
    super(message);
    this.name = "GatewayError";
    this.kind = kind;
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

/** Turns the Gateway's error bodies - a string, or zod's flattened { formErrors, fieldErrors } - into one readable line. */
export function describeErrorBody(body) {
  if (body == null) return "";
  if (typeof body === "string") return body.slice(0, 300);
  const err = body.error ?? body;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const parts = [...(err.formErrors ?? [])];
    for (const [field, msgs] of Object.entries(err.fieldErrors ?? {})) parts.push(`${field}: ${[].concat(msgs).join(", ")}`);
    if (parts.length) return parts.join("; ");
  }
  return JSON.stringify(err).slice(0, 300);
}

// --- client ---------------------------------------------------------------

export function createClient({ baseUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const root = String(baseUrl).replace(/\/+$/, "");

  async function request(method, urlPath, body, { timeout = timeoutMs } = {}) {
    const url = root + urlPath;
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        throw new GatewayError(`No response from ${root} within ${Math.round(timeout / 1000)}s`, { kind: "timeout", url });
      }
      const reason = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
      throw new GatewayError(`Couldn't reach the Gateway at ${root} (${reason})`, { kind: "network", url });
    }

    const text = await res.text();
    let parsed = text;
    try {
        parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
        /* not JSON - keep the raw text for the error message */
    }

    if (res.ok) return parsed;
    const detail = describeErrorBody(parsed);
    throw new GatewayError(detail || `HTTP ${res.status}`, {
        kind: res.status === 401 ? "auth" : "http",
        status: res.status,
        body: parsed,
        url,
    });
}

return {
    baseUrl: root,
    request,
    get: (p, o) => request("GET", p, undefined, o),
    post: (p, body, o) => request("POST", p, body ?? {}, o),
    put: (p, body, o) => request("PUT", p, body, o),
    delete: (p, o) => request("DELETE", p, undefined, o),
};
}