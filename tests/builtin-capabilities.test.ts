import { describe, expect, it } from "vitest";
import { builtinDescriptors } from "../src/capabilities/builtin.js";
import { CapabilityRegistry } from "../src/capabilities/registry.js";
import type { AdapterDescriptor } from "../src/capabilities/types.js";

// The built-in descriptors are plain data, so these tests only need a fresh
// registry - no orchestrator, agents, or mocks.
function loadAll() {
  const registry = new CapabilityRegistry();
  for (const [kind, descriptor] of Object.entries(builtinDescriptors)) {
    registry.register({ ...descriptor, kind });
  }
  return registry;
}

describe("built-in capability descriptors", () => {
  it("cover all eight built-in agents and pass registry validation", () => {
    expect(() => loadAll()).not.toThrow();
    expect(Object.keys(builtinDescriptors).sort()).toEqual(
      ["adb", "ai", "apkid", "apkmcp", "apktool", "filesystem", "frida", "jadx"].sort(),
    );
  });

  it("expose the capabilities the roadmap's later adapters will compete for", () => {
    const ids = loadAll().listCapabilities();
    expect(ids).toEqual(
      expect.arrayContaining(["java.decompile", "android.decode", "android.rebuild"]),
    );
  });

  it("group frida's server operations under one capability", () => {
    const [provider] = loadAll().providersOf("instrument.server");
    expect(provider?.adapter.kind).toBe("frida");
    expect(provider?.operations.map((op) => op.name)).toEqual([
      "push-server",
      "start-server",
      "stop-server",
    ]);
  });

  it("only declare outputs for operations that return a tracked path", () => {
    const entries = Object.entries(builtinDescriptors) as [
      string,
      Omit<AdapterDescriptor, "kind">,
    ][];
    const withOutputs = entries.flatMap(([kind, descriptor]) =>
      descriptor.operations.filter((op) => op.outputs?.length).map((op) => `${kind}.${op.name}`),
    );
    expect(withOutputs.sort()).toEqual(["apktool.build", "apktool.decode", "jadx.decompile"]);
  });
});
