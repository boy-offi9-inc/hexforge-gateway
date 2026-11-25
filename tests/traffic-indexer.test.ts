import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  eventName,
  indexTrafficCapture,
  normalizeEvent,
  parseCapture,
  queryKeysOf,
  toEntitiesAndEdges,
} from "../src/graph/traffic-indexer.js";
import * as graphService from "../src/graph/graph.service.js";

vi.mock("../src/events/event-bus.js", () => ({
  eventBus: { on: vi.fn(), emit: vi.fn() },
}));

vi.mock("../src/graph/graph.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/graph/graph.service.js")>();
  return {
    ...actual,
    indexBatch: vi.fn(async () => ({ entities: { created: 1, updated: 0 }, edges: { created: 0, existing: 0 } })),
    getEntity: vi.fn(async () => null),
    addEdge: vi.fn(async () => ({ created: true, edge: {} })),
  };
});

const jsonl = [
  JSON.stringify({ method: "get", url: "https://api.acme.com/v1/login?user=bob&token=SECRET", status: 200, durationMs: 34.6 }),
  JSON.stringify({ method: "POST", url: "http://api.acme.com/v1/login", status: 401 }),
  "not json at all",
  "",
].join("\n");

describe("queryKeysOf", () => {
  it("keeps key names only - never values", () => {
    expect(queryKeysOf("?user=bob&token=SECRET&user=again")).toEqual(["user", "token"]);
    expect(queryKeysOf("")).toBeUndefined();
    expect(queryKeysOf("?flag")).toEqual(["flag"]);
  });
});

describe("normalizeEvent", () => {
  it("uppercases the method and drops the query from the URL parts", () => {
    const e = normalizeEvent(JSON.parse(jsonl.split("\n")[0]))!;
    expect(e.method).toBe("GET");
    expect(e.host).toBe("api.acme.com");
    expect(e.path).toBe("/v1/login");
    expect(e.queryKeys).toEqual(["user", "token"]);
    expect(JSON.stringify(e)).not.toContain("SECRET");
    expect(JSON.stringify(e)).not.toContain("bob");
  });

  it("parses HAR entries", () => {
    const entry = {
      startedDateTime: "2026-11-25T10:00:00Z",
      time: 12.4,
      request: {
        method: "post",
        url: "https://x.co/api?key=s3cret",
        headers: [{ name: "Content-Type", value: "application/json; charset=utf-8" }],
      },
      response: { status: 201 },
    };
    const e = normalizeEvent(entry)!;
    expect(e.method).toBe("POST");
    expect(e.status).toBe(201);
    expect(e.contentType).toBe("application/json");
    expect(e.durationMs).toBe(12);
    expect(e.queryKeys).toEqual(["key"]);
    expect(JSON.stringify(e)).not.toContain("s3cret");
  });

  it("rejects junk", () => {
    expect(normalizeEvent(null)).toBeNull();
    expect(normalizeEvent({ method: "GET" })).toBeNull();
    expect(normalizeEvent({ url: "ftp://x.co", method: "GET" })).toBeNull();
  });
});

describe("parseCapture", () => {
  it("parses JSONL and skips malformed lines", () => {
    const events = parseCapture(jsonl);
    expect(events).toHaveLength(2);
    expect(events[0].method).toBe("GET");
    expect(events[1].status).toBe(401);
  });

  it("parses a HAR document", () => {
    const har = JSON.stringify({
      log: { entries: [{ request: { method: "GET", url: "https://h.co/a" }, response: { status: 200 } }] },
    });
    expect(parseCapture(har)).toHaveLength(1);
  });

  it("honors the cap", () => {
    const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify({ method: "GET", url: `https://h${i}.co/` }));
    expect(parseCapture(lines.join("\n"), 5)).toHaveLength(5);
  });
});

describe("toEntitiesAndEdges", () => {
  it("makes one entity per request shape and a maps-to edge to its url entity", () => {
    const events = parseCapture(jsonl);
    const { entities, edges } = toEntitiesAndEdges(events);
    expect(entities).toHaveLength(2);
    expect(entities[0].name).toBe("GET api.acme.com /v1/login");
    expect(entities[0].attributes).toMatchObject({ scheme: "https", status: 200, queryKeys: "user,token" });
    expect(edges).toHaveLength(2);
    expect(edges[0]).toEqual({
      from: { type: "traffic-event", name: "GET api.acme.com /v1/login" },
      to: { type: "url", name: "https://api.acme.com/v1/login" },
      relation: "maps-to",
    });
  });

  it("dedupes repeated requests to one entity", () => {
    const events = [
      { method: "GET", scheme: "https", host: "h.co", path: "/a" },
      { method: "GET", scheme: "https", host: "h.co", path: "/a", status: 500 },
    ];
    const { entities } = toEntitiesAndEdges(events);
    expect(entities).toHaveLength(1);
  });

  it("names events without any query string", () => {
    expect(eventName({ method: "GET", scheme: "https", host: "h.co", path: "/a", queryKeys: ["x"] })).toBe(
      "GET h.co /a",
    );
  });
});

describe("indexTrafficCapture", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "traffic-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function artifact(file: string) {
    return {
      id: "art-1",
      workspaceId: "ws-1",
      kind: "traffic-capture",
      path: file,
      pathType: "file" as const,
      source: { taskId: "t1", agent: "network", operation: "capture", capability: "network.capture" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  it("indexes entities and skips edges whose url entity does not exist yet", async () => {
    const file = path.join(dir, "capture.jsonl");
    await writeFile(file, jsonl);
    const result = await indexTrafficCapture(artifact(file));
    expect(result).not.toBeNull();
    const batch = vi.mocked(graphService.indexBatch).mock.calls[0][0];
    expect(batch.entities).toHaveLength(2);
    expect(batch.entities[0].name).toBe("GET api.acme.com /v1/login");
    expect(batch.edges).toEqual([]); // edges go through addEdge, not the batch
    expect(result!.edges.existing).toBe(2); // both edges skipped, url entities absent
    expect(vi.mocked(graphService.addEdge)).not.toHaveBeenCalled();
  });

  it("links the edge when the url entity exists", async () => {
    vi.mocked(graphService.getEntity).mockResolvedValue({
      id: "e1", workspaceId: "ws-1", type: "url", name: "x", attributes: {}, artifactIds: [],
      createdAt: "", updatedAt: "",
    });
    const file = path.join(dir, "capture.jsonl");
    await writeFile(file, jsonl);
    const result = await indexTrafficCapture(artifact(file));
    expect(result!.edges.created).toBe(2);
    vi.mocked(graphService.getEntity).mockResolvedValue(null as never);
  });

  it("returns null for a directory artifact or an empty capture", async () => {
    const a = artifact("/tmp");
    a.pathType = "directory";
    expect(await indexTrafficCapture(a)).toBeNull();
    const empty = path.join(dir, "empty.jsonl");
    await writeFile(empty, "\n\n");
    expect(await indexTrafficCapture(artifact(empty))).toBeNull();
  });
});
