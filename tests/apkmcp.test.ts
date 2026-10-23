import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apkMcpHandler,
  clearToolListCache,
  pickToolName,
  TOOL_NAMES,
} from "../src/modules/mcp/agents/apkmcp.agent.js";
import type { McpTask } from "../src/core/types.js";

// The agent talks to MT Manager over HTTP, so these tests stand in a fake MT
// server by replacing global fetch: it answers initialize, tools/list and
// tools/call, and records every tools/call so a test can see which MT tool
// the agent really asked for.
type Call = { name: string; arguments: Record<string, unknown> };

const NEW_TOOLS = [
  "mt_apk_list_available_apks",
  "mt_apk_workspace_open",
  "mt_apk_workspace_list",
  "mt_apk_list",
  "mt_apk_read_text",
  "mt_apk_search",
  "mt_apk_dex_read_class_outline",
  "mt_apk_workspace_delete",
];
const OLD_TOOLS = [
  "mt_apk_list_available_apks",
  "mt_apk_open",
  "mt_apk_list",
  "mt_apk_read_text",
  "mt_apk_search",
  "mt_apk_outline_class",
  "mt_apk_close",
];

function fakeMt(options: {
  tools: string[];
  savedWorkspaces?: string[];
  listFails?: boolean;
  toolsListFails?: boolean;
}) {
  const calls: Call[] = [];
  let toolsListCalls = 0;

  const reply = (id: unknown, result: unknown) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      headers: { "content-type": "application/json", "mcp-session-id": "s1" },
    });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const message = JSON.parse(init.body);
      if (message.method === "initialize") return reply(message.id, { capabilities: {} });
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === "tools/list") {
        toolsListCalls++;
        if (options.toolsListFails) {
          const error = { code: -1, message: "tools/list is down" };
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, error }));
        }
        return reply(message.id, { tools: options.tools.map((name) => ({ name })) });
      }
      const { name, arguments: args } = message.params as Call;
      calls.push({ name, arguments: args });
      if (name === "mt_apk_workspace_list") {
        if (options.listFails) throw new Error("MT busy");
        const items = (options.savedWorkspaces ?? []).map((workspaceId) => ({ workspaceId }));
        return reply(message.id, { structuredContent: { ok: true, data: { items } } });
      }
      return reply(message.id, { structuredContent: { ok: true, data: { called: name } } });
    }),
  );
  return { calls, toolsListCalls: () => toolsListCalls };
}

const run = (operation: string, payload: Record<string, unknown> = {}) =>
  apkMcpHandler({
    id: "t1",
    workspaceId: "ws1",
    agent: "apkmcp",
    operation,
    payload,
    status: "running",
    createdAt: "",
    updatedAt: "",
  } as McpTask);

beforeEach(() => clearToolListCache());
afterEach(() => vi.unstubAllGlobals());

describe("pickToolName", () => {
  it("takes the first candidate MT has, newest first", () => {
    const both = new Set(["mt_apk_open", "mt_apk_workspace_open"]);
    expect(pickToolName(TOOL_NAMES.open, both)).toBe("mt_apk_workspace_open");
    expect(pickToolName(TOOL_NAMES.open, new Set(["mt_apk_open"]))).toBe("mt_apk_open");
    expect(pickToolName(TOOL_NAMES.open, new Set(["something_else"]))).toBeUndefined();
  });
});

describe("apkmcp tool names", () => {
  it("calls the current names on a current MT Manager", async () => {
    const mt = fakeMt({ tools: NEW_TOOLS, savedWorkspaces: [] });

    await run("open", { path: "mt://current-apk", temporary: true });
    await run("outline_class", { workspaceId: "w1", locator: "dex_class:Lcom/a/B;" });
    await run("close", { workspaceId: "w1" });

    expect(mt.calls.map((c) => c.name)).toEqual([
      "mt_apk_workspace_open",
      "mt_apk_dex_read_class_outline",
      "mt_apk_workspace_list",
      "mt_apk_workspace_delete",
    ]);
  });

  it("falls back to the old names on an older MT Manager", async () => {
    const mt = fakeMt({ tools: OLD_TOOLS });

    await run("open", { path: "x.apk" });
    await run("outline_class", { workspaceId: "w1", locator: "dex_class:Lcom/a/B;" });
    await run("close", { workspaceId: "w1" });

    // No safe-delete check for the old close: only mt_apk_workspace_delete is guarded.
    expect(mt.calls.map((c) => c.name)).toEqual([
      "mt_apk_open",
      "mt_apk_outline_class",
      "mt_apk_close",
    ]);
  });

  it("names what was looked for and what MT offers when neither exists", async () => {
    fakeMt({ tools: ["mt_apk_list", "mt_apk_search", "mt_file_list"] });

    await expect(run("open", { path: "x.apk" })).rejects.toThrow(
      /no tool for "open": looked for mt_apk_workspace_open or mt_apk_open\. It offers 2 mt_apk_\* tools/,
    );
  });

  it("tries the newest name when tools/list can't be read", async () => {
    const mt = fakeMt({ tools: [], toolsListFails: true });

    await run("open", { path: "x.apk" });

    expect(mt.calls[0]?.name).toBe("mt_apk_workspace_open");
  });

  it("reads tools/list once and remembers it between tasks", async () => {
    const mt = fakeMt({ tools: NEW_TOOLS });

    await run("open", { path: "a.apk" });
    await run("open", { path: "b.apk" });
    await run("outline_class", { workspaceId: "w1", locator: "dex_class:Lcom/a/B;" });

    expect(mt.toolsListCalls()).toBe(1);
  });

  it("keeps sending the arguments MT requires for the wrapped calls", async () => {
    const mt = fakeMt({ tools: NEW_TOOLS });

    await run("open", { path: "mt://current-apk" });
    await run("list", { workspaceId: "w1", view: "dex_classes" });
    await run("search", { workspaceId: "w1", query: "token" });

    const [open, list, search] = mt.calls;
    expect(open?.arguments).toEqual({ path: "mt://current-apk", temporary: false });
    expect(Object.keys(list?.arguments ?? {}).sort()).toEqual(
      ["editSessionId", "limit", "prefix", "view", "workspaceId"].sort(),
    );
    expect(Object.keys(search?.arguments ?? {}).sort()).toEqual(
      [
        "caseSensitive",
        "editSessionId",
        "includeMatchOffsets",
        "limit",
        "matchMode",
        "prefix",
        "query",
        "queryType",
        "snippetMaxChars",
        "target",
        "workspaceId",
      ].sort(),
    );
  });
});

describe("apkmcp close", () => {
  it("deletes a temporary workspace", async () => {
    const mt = fakeMt({ tools: NEW_TOOLS, savedWorkspaces: ["someone-else"] });

    await run("close", { workspaceId: "tmp1" });

    expect(mt.calls.at(-1)).toEqual({
      name: "mt_apk_workspace_delete",
      arguments: { workspaceId: "tmp1" },
    });
  });

  it("refuses to delete a saved workspace, and deletes nothing", async () => {
    const mt = fakeMt({ tools: NEW_TOOLS, savedWorkspaces: ["keep-me"] });

    await expect(run("close", { workspaceId: "keep-me" })).rejects.toThrow(
      /saved \(non-temporary\) workspace.*"force": true/,
    );
    expect(mt.calls.map((c) => c.name)).not.toContain("mt_apk_workspace_delete");
  });

  it("deletes a saved workspace when force is set, without the list check", async () => {
    const mt = fakeMt({ tools: NEW_TOOLS, savedWorkspaces: ["keep-me"] });

    await run("close", { workspaceId: "keep-me", force: true });

    expect(mt.calls.map((c) => c.name)).toEqual(["mt_apk_workspace_delete"]);
  });

  it("refuses when MT can't say whether the workspace is saved", async () => {
    const mt = fakeMt({ tools: NEW_TOOLS, listFails: true });

    await expect(run("close", { workspaceId: "w1" })).rejects.toThrow(/couldn't confirm/);
    expect(mt.calls.map((c) => c.name)).not.toContain("mt_apk_workspace_delete");
  });
});
