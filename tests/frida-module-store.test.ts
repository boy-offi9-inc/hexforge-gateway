import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/events/event-bus.js", () => ({ eventBus: { on: vi.fn(), emit: vi.fn() } }));

async function store() {
  return import("../src/modules/frida-modules/module-store.js");
}

describe("frida module store", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "hexforge-frida-modules-"));
    vi.resetModules();
    vi.stubEnv("DATA_DIR", dataDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("saves a draft, records test runs, promotes to an immutable version", async () => {
    await (
      await store()
    ).saveDraft({
      name: "ssl-pin-bypass",
      script: "Java.perform(() => {});",
      notes: "bypass okhttp pinning",
    });

    await (await store()).recordTestRun("ssl-pin-bypass", { taskId: "t1", target: "com.acme.app" });
    await (await store()).recordTestRun("ssl-pin-bypass", { taskId: "t2", target: "com.acme.app" });

    const published = await (await store()).promote("ssl-pin-bypass", "minor", "works on acme 2.x");
    expect(published.status).toBe("published");
    expect(published.version).toBe("1.0.0");
    expect(published.testRuns).toHaveLength(2);
    expect(published.notes).toBe("works on acme 2.x");
    expect(published.script).toBe("Java.perform(() => {});");

    // draft lives on with a clean history
    const draft = (await (await store()).listModules()).find(
      (m) => m.name === "ssl-pin-bypass" && m.status === "draft",
    );
    expect(draft?.testRuns).toHaveLength(0);
  });

  it("versions incrementally per bump and never mutates a published version", async () => {
    await (await store()).saveDraft({ name: "hooker", script: "v1" });
    await (await store()).promote("hooker", "patch"); // 1.0.0
    await (await store()).saveDraft({ name: "hooker", script: "v2" });
    await (await store()).promote("hooker", "minor"); // 1.1.0
    await (await store()).saveDraft({ name: "hooker", script: "v3" });
    await (await store()).promote("hooker", "major"); // 2.0.0

    const v1 = await (await store()).getModule("hooker", "1.0.0");
    expect(v1?.script).toBe("v1"); // frozen
    const v2 = await (await store()).getModule("hooker", "1.1.0");
    expect(v2?.script).toBe("v2");
    const latest = await (await store()).getModule("hooker");
    expect(latest?.version).toBe("2.0.0");

    // resolve by ref
    expect((await (await store()).resolveScript("hooker@1.0.0")).script).toBe("v1");
    expect((await (await store()).resolveScript("hooker")).script).toBe("v3"); // no version = latest
  });

  it("updates an existing draft instead of duplicating it", async () => {
    const first = await (await store()).saveDraft({ name: "root-detect", script: "a" });
    const second = await (await store()).saveDraft({ name: "root-detect", script: "b" });
    expect(second.id).toBe(first.id);
    expect(second.script).toBe("b");
    const drafts = (await (await store()).listModules()).filter(
      (m) => m.name === "root-detect" && m.status === "draft",
    );
    expect(drafts).toHaveLength(1);
  });

  it("enforces names, non-empty scripts, and refuses unknown refs", async () => {
    await expect((await store()).saveDraft({ name: "Bad_Name", script: "x" })).rejects.toThrow(
      /name/,
    );
    await expect((await store()).saveDraft({ name: "ok-name", script: "  " })).rejects.toThrow(
      /script/,
    );
    await expect((await store()).recordTestRun("ghost", { taskId: "t" })).rejects.toThrow(
      /No draft module/,
    );
    await expect((await store()).promote("ghost")).rejects.toThrow(/No draft module/);
    await expect((await store()).resolveScript("ghost")).rejects.toThrow(/No module/);
    await (await store()).saveDraft({ name: "real", script: "x" });
    await expect((await store()).resolveScript("real@9.9.9")).rejects.toThrow(
      /No module "real@9.9.9"/,
    );
  });
});
