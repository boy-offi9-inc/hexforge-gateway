import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractStrings,
  extractUrls,
  indexUrlsAndStrings,
  parseUrlsAndStrings,
} from "../src/graph/url-string-indexer.js";

vi.mock("../src/events/event-bus.js", () => ({
  eventBus: { on: vi.fn(), emit: vi.fn() },
}));

describe("extractUrls", () => {
  it("finds http and https URLs with their file and line", () => {
    const obs = extractUrls(
      "java/com/acme/Api.java",
      "GET https://api.acme.com/v1\nPOST http://api.acme.com/v2\n",
    );
    expect(obs).toEqual([
      { url: "https://api.acme.com/v1", file: "java/com/acme/Api.java", line: 1 },
      { url: "http://api.acme.com/v2", file: "java/com/acme/Api.java", line: 2 },
    ]);
  });

  it("strips trailing sentence punctuation but keeps path characters", () => {
    const obs = extractUrls("a.txt", "see https://x.co/p?q=1.\nand https://y.co/a_b~c\n");
    expect(obs[0].url).toBe("https://x.co/p?q=1");
    expect(obs[1].url).toBe("https://y.co/a_b~c");
  });

  it("honors the cap", () => {
    const content = Array.from({ length: 20 }, (_, i) => `https://h${i}.co`).join("\n");
    expect(extractUrls("f", content, 5)).toHaveLength(5);
  });
});

describe("extractStrings", () => {
  it("keeps literals that look intentional: endpoints, flags, messages", () => {
    const code = `String url = "/api/v2/login";
String flag = "debug.mode.enabled";
String msg = "Authentication failed";
`;
    const obs = extractStrings("java/com/acme/Api.java", code);
    const names = obs.map((o) => o.url);
    expect(names).toContain("/api/v2/login");
    expect(names).toContain("debug.mode.enabled");
    expect(names).toContain("Authentication failed");
  });

  it("skips bare words, short literals, pure numbers and URLs", () => {
    const code = `String a = "name";
String b = "ab";
String c = "12345";
String d = "https://x.co";
`;
    expect(extractStrings("f", code)).toEqual([]);
  });

  it("keeps only the first observation per literal in parseUrlsAndStrings", () => {
    const obs = extractStrings("f.txt", '"debug.mode.enabled" // line 1');
    expect(obs).toHaveLength(1);
  });
});

describe("parseUrlsAndStrings", () => {
  it("makes one entity per unique URL and maps it to the file's class", () => {
    const { entities, edges } = parseUrlsAndStrings(
      [
        { url: "https://api.acme.com/v1", file: "java/com/acme/Api.java", line: 3 },
        { url: "https://api.acme.com/v1", file: "java/com/acme/Other.java", line: 9 },
        { url: "https://cdn.acme.com", file: "java/com/acme/Api.java", line: 7 },
      ],
      "url",
    );
    expect(entities.map((e) => e.name).sort()).toEqual([
      "https://api.acme.com/v1",
      "https://cdn.acme.com",
    ]);
    expect(entities[0]).toMatchObject({
      type: "url",
      attributes: { firstSeenIn: "java/com/acme/Api.java", firstSeenLine: 3 },
    });
    expect(edges).toHaveLength(3); // both classes observed the shared URL
    expect(edges).toContainEqual({
      from: { type: "url", name: "https://api.acme.com/v1" },
      to: { type: "class", name: "com.acme.Other" },
      relation: "maps-to",
    });
  });

  it("attaches nothing for non-class files (resources, smali)", () => {
    const { entities, edges } = parseUrlsAndStrings(
      [{ url: "https://x.co/e", file: "res/xml/network_config.xml", line: 2 }],
      "url",
    );
    expect(entities).toHaveLength(1); // entity still recorded
    expect(edges).toEqual([]); // but no class to map to
  });

  it("maps kotlin files through the kotlin source root", () => {
    const { edges } = parseUrlsAndStrings(
      [{ url: "endpoint.v1", file: "kotlin/com/acme/Kt.kt", line: 1 }],
      "string",
    );
    expect(edges).toContainEqual({
      from: { type: "string", name: "endpoint.v1" },
      to: { type: "class", name: "com.acme.Kt" },
      relation: "maps-to",
    });
  });
});

// End to end on a real temp directory with real graph storage.
describe("indexUrlsAndStrings", () => {
  let dataDir: string;
  let outDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "hexforge-urlstr-data-"));
    outDir = await mkdtemp(path.join(tmpdir(), "hexforge-urlstr-out-"));
    vi.resetModules();
    vi.stubEnv("DATA_DIR", dataDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dataDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  async function modules() {
    return {
      artifacts: await import("../src/artifacts/artifact.service.js"),
      graph: await import("../src/graph/graph.service.js"),
      urls: await import("../src/graph/url-string-indexer.js"),
    };
  }

  it("indexes urls and strings from a decompile and links them to classes", async () => {
    const m = await modules();
    const javaDir = path.join(outDir, "java", "com", "acme");
    await mkdir(javaDir, { recursive: true });
    await writeFile(
      path.join(javaDir, "Api.java"),
      `package com.acme;
public class Api {
  String ENDPOINT = "https://api.acme.com/v2";
  String FLAG = "offline.mode.enabled";
}
`,
    );
    await writeFile(
      path.join(outDir, "resources.xml"),
      '<string name="u">https://cdn.acme.com</string>\n',
    );

    // seed what the java indexer would have created (it owns class entities)
    await m.graph.upsertEntity({ workspaceId: "ws1", type: "class", name: "com.acme.Api" });

    const artifact = await m.artifacts.recordArtifact({
      workspaceId: "ws1",
      kind: "java-sources",
      path: outDir,
      pathType: "directory",
      tools: [{ tool: "jadx" }],
    });

    const result = await m.urls.indexUrlsAndStrings(artifact);
    expect(result).not.toBeNull();
    expect(result!.entities.created).toBe(3); // 2 urls + 1 string

    const graph = m.graph;
    const urls = await graph.listEntities("ws1", { type: "url" });
    expect(urls.map((e) => e.name).sort()).toEqual([
      "https://api.acme.com/v2",
      "https://cdn.acme.com",
    ]);
    const strings = await graph.listEntities("ws1", { type: "string" });
    expect(strings.map((e) => e.name)).toEqual(["offline.mode.enabled"]);
    const cls = await graph.listEntities("ws1", { type: "class" });
    expect(cls.map((e) => e.name)).toContain("com.acme.Api");
    const edges = await graph.listEdges("ws1", { relation: "maps-to" });
    // string + api url map to com.acme.Api (the seeded class); the xml url
    // maps to nothing (no class entity exists for a bare resource file)
    expect(edges).toHaveLength(2);
    const nameOf = async (id: string) => (await graph.getEntity(id))?.name;
    const ends = new Set<string>();
    for (const e of edges) {
      ends.add((await nameOf(e.from))!);
      ends.add((await nameOf(e.to))!);
    }
    expect(ends).toEqual(
      new Set(["https://api.acme.com/v2", "offline.mode.enabled", "com.acme.Api"]),
    );
  });

  it("returns null for a file artifact or a directory with nothing scannable", async () => {
    const m = await modules();
    const fileArt = await m.artifacts.recordArtifact({
      workspaceId: "ws2",
      kind: "native-analysis",
      path: path.join(outDir, "x.json"),
      pathType: "file",
      tools: [],
      createdBy: "ghidra",
    });
    await writeFile(path.join(outDir, "x.json"), "{}");
    await expect(m.urls.indexUrlsAndStrings(fileArt)).resolves.toBeNull();

    const emptyDir = path.join(outDir, "empty");
    await mkdir(emptyDir);
    await writeFile(path.join(emptyDir, "blob.bin"), Buffer.from([0, 1, 2]));
    const dirArt = await m.artifacts.recordArtifact({
      workspaceId: "ws2",
      kind: "java-sources",
      path: emptyDir,
      pathType: "directory",
      tools: [{ tool: "jadx" }],
    });
    await expect(m.urls.indexUrlsAndStrings(dirArt)).resolves.toBeNull();
  });
});
