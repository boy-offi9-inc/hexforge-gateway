import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  binaryContains,
  collectSignals,
  findTextLine,
  resilienceHandler,
} from "../src/modules/mcp/agents/resilience.agent.js";

vi.mock("../../../core/config.js", () => ({
  config: { WORKSPACES_ROOT: "/tmp/hexforge-test-ws" },
}));

describe("findTextLine", () => {
  it("reports the 1-based line of the first case-insensitive hit", () => {
    const code = "package com.acme;\n\nif (System.getProperty(\"frida-server\") != null) {\n";
    expect(findTextLine(code, "frida-server")).toBe(3);
  });
  it("returns undefined when absent", () => {
    expect(findTextLine("clean", "frida")).toBeUndefined();
  });
});

describe("binaryContains", () => {
  it("finds ascii needles in binary buffers, case-insensitive", () => {
    expect(binaryContains(Buffer.from([0x00, 0x01, ...Buffer.from("ReFridaBinar")]), "frida")).toBe(true);
    expect(binaryContains(Buffer.from([0x00, 0x01, 0x02]), "frida")).toBe(false);
  });
});

describe("collectSignals", () => {
  it("returns only categories with hits, capped occurrences", () => {
    const hits = new Map([
      ["frida", Array.from({ length: 15 }, (_, i) => ({ file: `f${i}.smali`, line: i + 1 }))],
    ]);
    const signals = collectSignals(hits);
    expect(signals).toHaveLength(1);
    expect(signals[0].category).toBe("frida");
    expect(signals[0].occurrences).toHaveLength(10); // MAX_OCCURRENCES_PER_CATEGORY
  });
  it("keeps the category definition order", () => {
    const hits = new Map([
      ["emulator", [{ file: "a.smali" }]],
      ["root", [{ file: "b.smali" }]],
      ["frida", [{ file: "c.smali" }]],
    ]);
    expect(collectSignals(hits).map((s) => s.category)).toEqual(["frida", "root", "emulator"]);
  });
});

describe("resilienceHandler", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "resilience-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function task(target: string) {
    return { workspaceId: "ws-1", id: "task-1", payload: { target } } as never;
  }

  it("detects frida and root idioms in a decoded project and cites files", async () => {
    await mkdir(path.join(dir, "smali/com/acme"), { recursive: true });
    await mkdir(path.join(dir, "lib/armeabi-v7a"), { recursive: true });
    await writeFile(
      path.join(dir, "smali/com/acme/RootCheck.smali"),
      "const-string v0, \"/su\"\ninvoke-static {v0}, Ljava/io/File;<init>\n",
    );
    await writeFile(
      path.join(dir, "smali/com/acme/FridaCheck.smali"),
      "const-string v0, \"frida-server\"\n",
    );
    await writeFile(path.join(dir, "lib/armeabi-v7a/libnative.so"), Buffer.from("xx-frida-gadget-yy"));
    const result = (await resilienceHandler(task(dir))) as {
      signals: { category: string; occurrences: { file: string }[] }[];
      summary: { categoriesDetected: string[]; categoriesNotObserved: string[] };
      disclaimer: string;
      outputPath?: string;
    };
    const cats = result.signals.map((s) => s.category);
    expect(cats).toContain("root");
    expect(cats).toContain("frida");
    const frida = result.signals.find((s) => s.category === "frida")!;
    expect(frida.occurrences.map((o) => o.file)).toEqual(
      expect.arrayContaining(["smali/com/acme/FridaCheck.smali", "lib/armeabi-v7a/libnative.so"]),
    );
    expect(result.summary.categoriesDetected).toContain("frida");
    expect(result.summary.categoriesNotObserved).toContain("xposed");
    expect(result.disclaimer).toContain("not a guarantee");
  });

  it("warns instead of failing when the target is an APK", async () => {
    const apk = path.join(dir, "app.apk");
    await writeFile(apk, Buffer.from("not really an apk"));
    const result = (await resilienceHandler(task(apk))) as { warnings?: string[] };
    expect(result.warnings?.join("\n")).toContain("decoded project");
  });

  it("throws on a missing target", async () => {
    await expect(resilienceHandler(task(path.join(dir, "nope")))).rejects.toThrow("Target not found");
  });

  it("rejects junk targets", async () => {
    const f = path.join(dir, "file.txt");
    await writeFile(f, "x");
    await expect(resilienceHandler(task(f))).rejects.toThrow("must be an .apk file or a directory");
  });

  it("rejects a payload without a target", async () => {
    await expect(resilienceHandler({ workspaceId: "ws-1", id: "t", payload: {} } as never)).rejects.toThrow(
      'requires "target"',
    );
  });
});
