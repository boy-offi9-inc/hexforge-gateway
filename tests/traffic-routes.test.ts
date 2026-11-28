import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

// Real traffic-indexer parse and real filesystem in a throwaway
// WORKSPACES_ROOT; workspace and artifact services mocked.
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "hexforge-traffic-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  vi.resetModules();
});

async function buildApp() {
  vi.resetModules();
  vi.stubEnv("WORKSPACES_ROOT", dataDir);
  const workspaces = {
    getWorkspace: vi.fn(async (id: string) => (id === "ws1" ? { id } : null)),
  };
  const recorded: unknown[] = [];
  const artifacts = {
    recordArtifact: vi.fn(async (input: Record<string, unknown>) => {
      recorded.push(input);
      return { id: "art1", ...input };
    }),
  };
  vi.doMock("../src/modules/workspace/workspace.service.js", () => workspaces);
  vi.doMock("../src/artifacts/artifact.service.js", () => artifacts);
  const { trafficRoutes } = await import("../src/api/v1/traffic.routes.js");
  const app = Fastify();
  await app.register(trafficRoutes);
  return { app, artifacts, recorded };
}

const jsonl = [
  JSON.stringify({ method: "GET", url: "https://api.acme.com/v1/login?token=SECRET", status: 200 }),
  JSON.stringify({ method: "POST", url: "http://api.acme.com/v1/submit", status: 201 }),
].join("\n");

describe("POST /workspaces/:id/traffic-captures", () => {
  it("records a JSONL capture and reports what it held", async () => {
    const { app, recorded } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/workspaces/ws1/traffic-captures",
      payload: { content: jsonl, source: "mitmproxy on the lab PC" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.events).toBe(2);
    expect(body.truncated).toBe(false);
    expect(body.path.endsWith(".jsonl")).toBe(true);

    // the file is written into the workspace and holds the capture as received
    const stored = await readFile(body.path, "utf8");
    expect(stored).toContain("api.acme.com");
    expect(path.dirname(body.path)).toContain(path.join(dataDir, "ws1", "traffic"));

    // the artifact is recorded with the producer provenance
    const input = recorded[0] as Record<string, any>;
    expect(input.kind).toBe("traffic-capture");
    expect(input.pathType).toBe("file");
    expect(input.workspaceId).toBe("ws1");
    expect(input.source.agent).toBe("traffic");
    expect(input.source.operation).toBe("capture.import");
    expect(input.source.capability).toBe("traffic.import");
  });

  it("records a HAR document with a .har extension", async () => {
    const { app } = await buildApp();
    const har = JSON.stringify({
      log: { entries: [{ request: { method: "GET", url: "https://x.co/a" }, response: { status: 200 } }] },
    });
    const res = await app.inject({
      method: "POST",
      url: "/workspaces/ws1/traffic-captures",
      payload: { content: har },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().path.endsWith(".har")).toBe(true);
  });

  it("refuses content with no parsable events without writing anything", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/workspaces/ws1/traffic-captures",
      payload: { content: "hello there\nnothing here" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("No parsable traffic events");
    const wsDir = path.join(dataDir, "ws1");
    await expect(readdir(wsDir)).rejects.toThrow();
  });

  it("404s on an unknown workspace", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/workspaces/ghost/traffic-captures",
      payload: { content: jsonl },
    });
    expect(res.statusCode).toBe(404);
  });

  it("validates the body shape", async () => {
    const { app } = await buildApp();
    const missing = await app.inject({
      method: "POST",
      url: "/workspaces/ws1/traffic-captures",
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    const tooBig = await app.inject({
      method: "POST",
      url: "/workspaces/ws1/traffic-captures",
      payload: { content: "x".repeat(5 * 1024 * 1024 + 1) },
    });
    expect(tooBig.statusCode).toBe(400);
    const badSource = await app.inject({
      method: "POST",
      url: "/workspaces/ws1/traffic-captures",
      payload: { content: jsonl, source: "" },
    });
    expect(badSource.statusCode).toBe(400);
  });

  it("keeps separate captures as separate artifacts", async () => {
    const { app, recorded } = await buildApp();
    await app.inject({ method: "POST", url: "/workspaces/ws1/traffic-captures", payload: { content: jsonl } });
    await app.inject({ method: "POST", url: "/workspaces/ws1/traffic-captures", payload: { content: jsonl } });
    expect(recorded).toHaveLength(2);
    const paths = recorded.map((r) => (r as Record<string, any>).path);
    expect(new Set(paths).size).toBe(2);
  });
});
