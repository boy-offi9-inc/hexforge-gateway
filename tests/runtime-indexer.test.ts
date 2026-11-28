import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  indexRuntimeEvents,
  normalizeEvent,
  parseCapture,
  toEntitiesAndEdges,
  urlEntityName,
} from "../src/graph/runtime-indexer.js";
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
  JSON.stringify({
    hook: "Java.com.acme.Crypto.encrypt",
    category: "crypto",
    target: "com.acme.Crypto.encrypt(String)",
    durationMs: 3.2,
  }),
  JSON.stringify({
    hook: "Java.com.acme.Api.send",
    category: "network",
    url: "https://api.acme.com/v1/login?token=SECRET",
  }),
  JSON.stringify({ hook: "Java.com.acme.Crypto.encrypt" }),
  "not json at all",
  "",
  JSON.stringify({ hook: "DROP TABLE; --" }),
].join("\n");

describe("urlEntityName", () => {
  it("keeps scheme, host and path - never the query values", () => {
    expect(urlEntityName("https://api.acme.com/v1/login?token=SECRET")).toBe("https://api.acme.com/v1/login");
    expect(urlEntityName("ftp://x.co/a")).toBeNull();
    expect(urlEntityName("junk")).toBeNull();
  });
});

describe("normalizeEvent", () => {
  it("normalizes a crypto hook observation", () => {
    const e = normalizeEvent(JSON.parse(jsonl.split("\n")[0]))!;
    expect(e.hook).toBe("Java.com.acme.Crypto.encrypt");
    expect(e.category).toBe("crypto");
    expect(e.targets).toEqual(["com.acme.Crypto.encrypt(String)"]);
    expect(e.durationMs).toBe(3);
    expect(e.count).toBe(1);
  });

  it("drops query values from urls", () => {
    const e = normalizeEvent(JSON.parse(jsonl.split("\n")[1]))!;
    expect(e.urls).toEqual(["https://api.acme.com/v1/login"]);
    expect(JSON.stringify(e)).not.toContain("SECRET");
  });

  it("rejects junk hooks and junk shapes", () => {
    expect(normalizeEvent(null)).toBeNull();
    expect(normalizeEvent({})).toBeNull();
    expect(normalizeEvent({ hook: "" })).toBeNull();
    expect(normalizeEvent({ hook: "DROP TABLE; --" })).toBeNull();
    expect(normalizeEvent({ hook: "x".repeat(201) })).toBeNull();
    expect(normalizeEvent({ hook: "ok", category: "nonsense" })).toMatchObject({ category: undefined });
  });
});

describe("parseCapture", () => {
  it("aggregates by hook and skips junk lines", () => {
    const { events, truncated } = parseCapture(jsonl);
    expect(events).toHaveLength(2);
    const crypto = events.find((e) => e.hook === "Java.com.acme.Crypto.encrypt")!;
    expect(crypto.count).toBe(2);
    expect(truncated).toBe(false);
  });

  it("unions urls and targets across sightings of the same hook", () => {
    const log = [
      JSON.stringify({ hook: "h", url: "https://a.co/one" }),
      JSON.stringify({ hook: "h", url: "https://b.co/two", target: "com.acme.X.y()" }),
      JSON.stringify({ hook: "h", url: "https://a.co/one" }),
    ].join("\n");
    const { events } = parseCapture(log);
    const e = events[0]!;
    expect(e.count).toBe(3);
    expect(e.urls.sort()).toEqual(["https://a.co/one", "https://b.co/two"]);
    expect(e.targets).toEqual(["com.acme.X.y()"]);
  });

  it("marks truncation at the cap", () => {
    const many = Array.from({ length: 5 }, (_, i) => JSON.stringify({ hook: `h${i}` })).join("\n");
    const { events, truncated } = parseCapture(many, 3);
    expect(events).toHaveLength(3);
    expect(truncated).toBe(true);
  });
});

describe("toEntitiesAndEdges", () => {
  it("creates runtime-event entities with maps-to edges to method and url entities", () => {
    const { events } = parseCapture(jsonl);
    const { entities, edges } = toEntitiesAndEdges(events);
    expect(entities.map((e) => e.type)).toEqual(["runtime-event", "runtime-event"]);
    const crypto = entities.find((e) => e.name === "Java.com.acme.Crypto.encrypt")!;
    expect(crypto.attributes).toMatchObject({ count: 2, category: "crypto", durationMs: 3 });
    expect(edges).toHaveLength(2);
    expect(edges[0]!.to).toEqual({ type: "method", name: "com.acme.Crypto.encrypt(String)" });
    expect(edges.every((e) => e.relation === "maps-to")).toBe(true);
  });
});

describe("indexRuntimeEvents", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "runtime-events-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.mocked(graphService.getEntity).mockClear();
    vi.mocked(graphService.addEdge).mockClear();
  });

  it("indexes a jsonl log, skipping edges whose far end does not exist yet", async () => {
    const file = path.join(dir, "events.jsonl");
    await writeFile(file, jsonl);
    const result = await indexRuntimeEvents({
      id: "a1",
      workspaceId: "w1",
      kind: "runtime-events",
      path: file,
      pathType: "file",
    } as never);
    expect(result).not.toBeNull();
    expect(result!.entities.created).toBe(1);
    expect(result!.edges.created).toBe(0);
    expect(result!.edges.existing).toBe(2); // both method and url entities absent
  });

  it("adds edges when both ends exist", async () => {
    vi.mocked(graphService.getEntity).mockResolvedValue({ id: "x" } as never);
    const file = path.join(dir, "events.jsonl");
    await writeFile(file, jsonl);
    const result = await indexRuntimeEvents({
      id: "a1",
      workspaceId: "w1",
      kind: "runtime-events",
      path: file,
      pathType: "file",
    } as never);
    expect(result!.edges.created).toBe(2);
  });

  it("returns null for unreadable, empty or junk-only artifacts", async () => {
    expect(
      await indexRuntimeEvents({
        id: "a1",
        workspaceId: "w1",
        kind: "runtime-events",
        path: path.join(dir, "missing.jsonl"),
        pathType: "file",
      } as never),
    ).toBeNull();
    const empty = path.join(dir, "empty.jsonl");
    await writeFile(empty, "\n\n");
    expect(
      await indexRuntimeEvents({
        id: "a1",
        workspaceId: "w1",
        kind: "runtime-events",
        path: empty,
        pathType: "file",
      } as never),
    ).toBeNull();
    expect(
      await indexRuntimeEvents({
        id: "a1",
        workspaceId: "w1",
        kind: "runtime-events",
        path: empty,
        pathType: "directory",
      } as never),
    ).toBeNull();
  });
});
