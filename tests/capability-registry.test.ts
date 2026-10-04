import { beforeEach, describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../src/capabilities/registry.js";
import type { AdapterDescriptor } from "../src/capabilities/types.js";

// A fresh registry per test - the module-level singleton is for the Gateway,
// not for tests that need to start from empty.
let registry: CapabilityRegistry;

const adapter = (
  kind: string,
  capability: string,
  extra: Partial<AdapterDescriptor> = {},
): AdapterDescriptor => ({
  kind,
  operations: [{ name: "run", capability }],
  ...extra,
});

beforeEach(() => {
  registry = new CapabilityRegistry();
});

describe("CapabilityRegistry", () => {
  it("lists capabilities and orders providers by priority", () => {
    registry.register(adapter("jadx", "java.decompile"));
    registry.register(adapter("jadxai", "java.decompile", { priority: 10 }));
    registry.register(adapter("apktool", "android.decode"));

    expect(registry.listCapabilities()).toEqual(["android.decode", "java.decompile"]);
    expect(registry.providersOf("java.decompile").map((p) => p.adapter.kind)).toEqual([
      "jadxai",
      "jadx",
    ]);
  });

  it("groups every operation an adapter offers for one capability", () => {
    registry.register({
      kind: "frida",
      operations: [
        { name: "push-server", capability: "instrument.server" },
        { name: "start-server", capability: "instrument.server" },
        { name: "trace", capability: "instrument.trace" },
      ],
    });

    const [provider] = registry.providersOf("instrument.server");
    expect(provider?.operations.map((o) => o.name)).toEqual(["push-server", "start-server"]);
  });

  it("falls back to the next backend when the preferred one is unavailable", async () => {
    registry.register(
      adapter("jadxai", "java.decompile", { priority: 10, isAvailable: () => false }),
    );
    registry.register(adapter("jadx", "java.decompile"));

    expect((await registry.resolve("java.decompile"))?.adapter.kind).toBe("jadx");
  });

  it("treats a throwing or rejecting availability probe as unavailable", async () => {
    registry.register(
      adapter("a", "java.decompile", {
        priority: 2,
        isAvailable: () => {
          throw new Error("probe blew up");
        },
      }),
    );
    registry.register(
      adapter("b", "java.decompile", {
        priority: 1,
        isAvailable: () => Promise.reject(new Error("x")),
      }),
    );
    registry.register(adapter("c", "java.decompile"));

    expect((await registry.resolve("java.decompile"))?.adapter.kind).toBe("c");
  });

  it("resolves to undefined when nothing provides or nothing is available", async () => {
    expect(await registry.resolve("native.decompile")).toBeUndefined();

    registry.register(adapter("a", "native.decompile", { isAvailable: () => false }));
    expect(await registry.resolve("native.decompile")).toBeUndefined();
  });

  it("rejects malformed capability ids and duplicate operation names", () => {
    expect(() => registry.register(adapter("x", "Decompile"))).toThrow(/invalid capability id/);
    expect(() => registry.register(adapter("x", "decompile"))).toThrow(/invalid capability id/);
    expect(() =>
      registry.register({
        kind: "x",
        operations: [
          { name: "run", capability: "java.decompile" },
          { name: "run", capability: "java.search" },
        ],
      }),
    ).toThrow(/twice/);
    expect(registry.listAdapters()).toEqual([]);
  });

  it("re-registering a kind replaces it, and unregister removes it", () => {
    registry.register(adapter("jadx", "java.decompile"));
    registry.register(adapter("jadx", "java.search"));
    expect(registry.listCapabilities()).toEqual(["java.search"]);

    registry.unregister("jadx");
    expect(registry.getAdapter("jadx")).toBeUndefined();
    expect(registry.listCapabilities()).toEqual([]);
  });
});
