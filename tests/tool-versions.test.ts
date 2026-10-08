import { describe, expect, it, vi } from "vitest";
import { createToolVersionResolver, type Runner } from "../src/capabilities/tool-versions.js";

// The resolver takes its command runner as an argument, so these tests feed
// it canned output instead of spawning real tools.
const fake = (outputs: Record<string, string | Error>): Runner =>
  vi.fn(async (file: string) => {
    const out = outputs[file];
    if (out === undefined) throw new Error(`ENOENT ${file}`);
    if (out instanceof Error) throw out;
    return out;
  });

describe("createToolVersionResolver", () => {
  it("fills in versions for known backends, keeping the first line only", async () => {
    const resolve = createToolVersionResolver(
      fake({ jadx: "1.5.1\n", adb: "Android Debug Bridge version 1.0.41\nVersion 35.0.2\n" }),
    );

    await expect(resolve([{ tool: "jadx" }, { tool: "adb" }])).resolves.toEqual([
      { tool: "jadx", version: "1.5.1" },
      { tool: "adb", version: "Android Debug Bridge version 1.0.41" },
    ]);
  });

  it("leaves unprobed backends and failed probes without a version, and never throws", async () => {
    const resolve = createToolVersionResolver(fake({ apktool: new Error("boom") }));

    await expect(
      resolve([{ tool: "frida-server" }, { tool: "apktool" }, { tool: "jadx" }]),
    ).resolves.toEqual([{ tool: "frida-server" }, { tool: "apktool" }, { tool: "jadx" }]);
  });

  it("keeps a version the descriptor already declares", async () => {
    const run = fake({ jadx: "1.5.1" });
    const resolve = createToolVersionResolver(run);

    await expect(resolve([{ tool: "jadx", version: "pinned" }])).resolves.toEqual([
      { tool: "jadx", version: "pinned" },
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("probes a tool once after it succeeds, but retries after a failure", async () => {
    const run = vi
      .fn<Runner>()
      .mockRejectedValueOnce(new Error("not installed yet"))
      .mockResolvedValue("1.5.1");
    const resolve = createToolVersionResolver(run);

    expect(await resolve([{ tool: "jadx" }])).toEqual([{ tool: "jadx" }]);
    expect(await resolve([{ tool: "jadx" }])).toEqual([{ tool: "jadx", version: "1.5.1" }]);
    expect(await resolve([{ tool: "jadx" }])).toEqual([{ tool: "jadx", version: "1.5.1" }]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("returns undefined when there are no backends, and ignores empty output", async () => {
    const resolve = createToolVersionResolver(fake({ jadx: "  \n\n" }));

    await expect(resolve(undefined)).resolves.toBeUndefined();
    await expect(resolve([])).resolves.toBeUndefined();
    await expect(resolve([{ tool: "jadx" }])).resolves.toEqual([{ tool: "jadx" }]);
  });

  it("caps very long output at 100 characters", async () => {
    const resolve = createToolVersionResolver(fake({ jadx: "v".repeat(500) }));

    const [jadx] = (await resolve([{ tool: "jadx" }]))!;
    expect(jadx?.version).toHaveLength(100);
  });
});
