import { describe, expect, it } from "vitest";
import {
  AGENT_TOOLS,
  ALL_TOOL_DEFINITIONS,
  META_TOOL_DEFINITIONS,
} from "../src/mcp-server/tools.js";

// tools.ts is pure data with no dependencies, so there's nothing to mock -
// these tests exist to stop the tool definitions quietly regressing. Glama's
// Tool Definition Quality Score marks down exactly the things checked here
// (missing annotations, undocumented parameters), and an AI client picks and
// calls tools from nothing but these definitions, so a vague or missing
// description is a functional problem, not a cosmetic one.

describe("tool definitions", () => {
  it("has no duplicate tool names", () => {
    const names = ALL_TOOL_DEFINITIONS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("exposes every meta tool and agent tool together", () => {
    expect(ALL_TOOL_DEFINITIONS).toHaveLength(
      META_TOOL_DEFINITIONS.length + AGENT_TOOLS.length,
    );
  });

  it.each(ALL_TOOL_DEFINITIONS.map((t) => [t.name, t] as const))(
    "%s has a real description",
    (_name, tool) => {
      // Long enough to say what it does, what it returns, and when to use
      // something else - a one-liner can't.
      expect(tool.description.length).toBeGreaterThan(120);
    },
  );

  it.each(ALL_TOOL_DEFINITIONS.map((t) => [t.name, t] as const))(
    "%s documents every parameter",
    (_name, tool) => {
      for (const [param, schema] of Object.entries(
        tool.inputSchema.properties,
      )) {
        expect(
          (schema as { description?: string }).description,
          `parameter "${param}"`,
        ).toBeTruthy();
      }
    },
  );

  it.each(ALL_TOOL_DEFINITIONS.map((t) => [t.name, t] as const))(
    "%s only requires parameters that exist",
    (_name, tool) => {
      for (const required of tool.inputSchema.required ?? []) {
        expect(Object.keys(tool.inputSchema.properties)).toContain(required);
      }
    },
  );

  describe("annotations", () => {
    it.each(ALL_TOOL_DEFINITIONS.map((t) => [t.name, t] as const))(
      "%s declares title, readOnlyHint and openWorldHint",
      (_name, tool) => {
        expect(tool.annotations?.title).toBeTruthy();
        expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
        expect(typeof tool.annotations?.openWorldHint).toBe("boolean");
      },
    );

    it.each(
      ALL_TOOL_DEFINITIONS.filter(
        (t) => t.annotations?.readOnlyHint === false,
      ).map((t) => [t.name, t] as const),
    )(
      "%s (a write tool) also declares destructiveHint and idempotentHint",
      (_name, tool) => {
        expect(typeof tool.annotations?.destructiveHint).toBe("boolean");
        expect(typeof tool.annotations?.idempotentHint).toBe("boolean");
      },
    );

    it.each(
      ALL_TOOL_DEFINITIONS.filter(
        (t) => t.annotations?.readOnlyHint === true,
      ).map((t) => [t.name, t] as const),
    )("%s (read-only) doesn't also claim to be destructive", (_name, tool) => {
      // destructiveHint/idempotentHint are only meaningful for tools that
      // aren't read-only - declaring one on a read-only tool contradicts it.
      expect(tool.annotations?.destructiveHint).toBeUndefined();
    });

    it("flags the tools that can change or delete things on the device or in prior work as destructive", () => {
      const destructive = ALL_TOOL_DEFINITIONS.filter(
        (t) => t.annotations?.destructiveHint,
      )
        .map((t) => t.name)
        .sort();
      // adb_shell runs arbitrary commands, adb_install can replace an installed
      // app, frida_trace injects code into a running app, and decode_apk
      // replaces the workspace's previous decode (including any edits to it).
      expect(destructive).toEqual([
        "adb_install",
        "adb_shell",
        "decode_apk",
        "frida_trace",
      ]);
    });
  });

  it("every agent tool maps to an agent and an operation", () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.agent, tool.name).toBeTruthy();
      expect(tool.operation, tool.name).toBeTruthy();
    }
  });
});
