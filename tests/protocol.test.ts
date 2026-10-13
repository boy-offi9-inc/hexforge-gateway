import { beforeEach, describe, expect, it, vi } from "vitest";

// protocol.ts talks to the Gateway purely through gateway-client.ts's
// exported functions, so mocking that module lets these tests drive
// JSON-RPC dispatch and tool execution without a real running Gateway -
// same approach as job-engine.test.ts mocking orchestrator.js one layer
// down. Both transports (index.ts, http.ts) are thin framing on top of
// this file, so testing it directly covers their shared behavior without
// needing to spin up stdio or an HTTP server.
vi.mock("../src/mcp-server/gateway-client.js", () => ({
  getOrCreateWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  listKnowledge: vi.fn(),
  chat: vi.fn(),
  runJob: vi.fn(),
  listCapabilities: vi.fn(),
  listArtifacts: vi.fn(),
  listGraphEntities: vi.fn(),
  getGraphEntity: vi.fn(),
  listFindings: vi.fn(),
  createFinding: vi.fn(),
  updateFinding: vi.fn(),
}));

import * as gateway from "../src/mcp-server/gateway-client.js";
import {
  handleRequest,
  negotiateProtocolVersion,
  PROTOCOL_VERSION,
} from "../src/mcp-server/protocol.js";

const getOrCreateWorkspace = gateway.getOrCreateWorkspace as ReturnType<typeof vi.fn>;
const listWorkspaces = gateway.listWorkspaces as ReturnType<typeof vi.fn>;
const runJob = gateway.runJob as ReturnType<typeof vi.fn>;
const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

beforeEach(() => {
  getOrCreateWorkspace.mockReset();
  listWorkspaces.mockReset();
  runJob.mockReset();
  for (const fn of [
    gateway.listCapabilities,
    gateway.listArtifacts,
    gateway.listGraphEntities,
    gateway.getGraphEntity,
    gateway.listFindings,
    gateway.createFinding,
    gateway.updateFinding,
  ]) {
    mocked(fn).mockReset();
  }
});

describe("protocol - non-tool methods", () => {
  it("responds to initialize with protocol version and server info", async () => {
    const response = await handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
      },
    });
  });

  it.each([
    ["a version it supports, echoed back", "2024-11-05", "2024-11-05"],
    ["the newest version it supports, echoed back", "2025-03-26", "2025-03-26"],
    [
      "a version it doesn't know (a newer client), answered with its own newest",
      "2026-09-30",
      PROTOCOL_VERSION,
    ],
    ["a missing version, answered with its own newest", undefined, PROTOCOL_VERSION],
    ["a non-string version, answered with its own newest", 20250326, PROTOCOL_VERSION],
  ])(
    "negotiates the protocol version when the client requests %s",
    async (_label, requested, expected) => {
      expect(negotiateProtocolVersion(requested)).toBe(expected);

      const response = await handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: requested },
      });
      expect((response?.result as { protocolVersion: string }).protocolVersion).toBe(expected);
    },
  );

  it("returns undefined (no response sent) for a notification, even a recognized one", async () => {
    await expect(
      handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).resolves.toBeUndefined();
  });

  it("responds to tools/list with every tool definition, meta and agent-mapped alike", async () => {
    const response = await handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const tools = (response?.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("list_workspaces"); // a meta tool
    expect(tools.map((t) => t.name)).toContain("decompile_apk"); // an agent-mapped tool
  });

  it("returns a JSON-RPC error for an unrecognized method with an id", async () => {
    const response = await handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "not/a/real/method",
    });
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: {
        code: -32601,
        message: expect.stringContaining("not/a/real/method"),
      },
    });
  });

  it("swallows an unrecognized notification (no id) rather than erroring", async () => {
    await expect(
      handleRequest({ jsonrpc: "2.0", method: "not/a/real/notification" }),
    ).resolves.toBeUndefined();
  });
});

describe("protocol - tools/call dispatch", () => {
  it("returns an error result for an unknown tool name, not a JSON-RPC error", async () => {
    const response = await handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "not_a_real_tool", arguments: {} },
    });
    expect(response?.error).toBeUndefined(); // this must be a normal result, not a protocol-level error
    expect(response?.result).toMatchObject({ isError: true });
    expect((response?.result as { content: { text: string }[] }).content[0].text).toContain(
      'Unknown tool "not_a_real_tool"',
    );
  });

  it("dispatches a meta tool (list_workspaces) straight to its gateway-client function", async () => {
    listWorkspaces.mockResolvedValue([
      { id: "ws1", name: "default", targetLabel: "default", status: "idle" },
    ]);

    const response = await handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "list_workspaces", arguments: {} },
    });

    expect(listWorkspaces).toHaveBeenCalledOnce();
    const result = response?.result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual([
      { id: "ws1", name: "default", targetLabel: "default", status: "idle" },
    ]);
  });

  it("resolves an agent tool's workspace by name, strips workspace/maxAttempts, and forwards the rest as the job payload", async () => {
    getOrCreateWorkspace.mockResolvedValue({
      id: "ws-abc",
      name: "my-app",
      targetLabel: "my-app",
      status: "idle",
    });
    runJob.mockResolvedValue({
      id: "job1",
      status: "completed",
      result: { outputDir: "/out" },
    });

    const response = await handleRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "decompile_apk",
        arguments: {
          workspace: "my-app",
          apkPath: "/tmp/app.apk",
          maxAttempts: 3,
        },
      },
    });

    expect(getOrCreateWorkspace).toHaveBeenCalledWith("my-app");
    expect(runJob).toHaveBeenCalledWith(
      "ws-abc",
      "jadx",
      "decompile",
      { apkPath: "/tmp/app.apk" },
      3,
    );
    const result = response?.result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({ outputDir: "/out" });
  });

  it('defaults to the "default" workspace when none is given', async () => {
    getOrCreateWorkspace.mockResolvedValue({
      id: "ws-default",
      name: "default",
      targetLabel: "default",
      status: "idle",
    });
    runJob.mockResolvedValue({ id: "job2", status: "completed", result: {} });

    await handleRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "decompile_apk", arguments: { apkPath: "/tmp/app.apk" } },
    });

    expect(getOrCreateWorkspace).toHaveBeenCalledWith("default");
  });

  it("surfaces a failed job as isError: true with the job's error message, not a JSON-RPC error", async () => {
    getOrCreateWorkspace.mockResolvedValue({
      id: "ws-abc",
      name: "my-app",
      targetLabel: "my-app",
      status: "idle",
    });
    runJob.mockResolvedValue({
      id: "job3",
      status: "failed",
      error: "jadx exited with code 1",
    });

    const response = await handleRequest({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "decompile_apk", arguments: { apkPath: "/tmp/app.apk" } },
    });

    expect(response?.error).toBeUndefined();
    const result = response?.result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("jadx exited with code 1");
  });

  it("catches a thrown/rejected gateway call and reports it as isError: true rather than crashing the request", async () => {
    getOrCreateWorkspace.mockRejectedValue(
      new Error("Gateway PUT /workspaces/by-name/my-app -> 500: internal error"),
    );

    const response = await handleRequest({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "decompile_apk",
        arguments: { workspace: "my-app", apkPath: "/tmp/app.apk" },
      },
    });

    expect(response?.error).toBeUndefined();
    const result = response?.result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("500: internal error");
  });

  it('rejects tools/call with a JSON-RPC error (not a tool result) when "name" itself is missing', async () => {
    const response = await handleRequest({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { arguments: {} },
    });
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 10,
      error: { code: -32602, message: expect.stringContaining("name") },
    });
  });
});

describe("protocol - capability, artifact, graph and finding tools", () => {
  const workspace = { id: "ws-abc", name: "my-app", targetLabel: "my-app", status: "idle" };

  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    expect(response?.error).toBeUndefined();
    return response?.result as { content: { text: string }[]; isError: boolean };
  }

  beforeEach(() => {
    getOrCreateWorkspace.mockResolvedValue(workspace);
  });

  it("list_capabilities needs no workspace and returns the Gateway's answer", async () => {
    mocked(gateway.listCapabilities).mockResolvedValue({ capabilities: [], adapters: [] });

    const result = await call("list_capabilities");

    expect(getOrCreateWorkspace).not.toHaveBeenCalled();
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({ capabilities: [], adapters: [] });
  });

  it("list_artifacts resolves the workspace by name and passes the kind filter", async () => {
    mocked(gateway.listArtifacts).mockResolvedValue([{ id: "ar1", kind: "apk" }]);

    const result = await call("list_artifacts", { workspace: "my-app", kind: "apk" });

    expect(getOrCreateWorkspace).toHaveBeenCalledWith("my-app");
    expect(gateway.listArtifacts).toHaveBeenCalledWith("ws-abc", "apk");
    expect(JSON.parse(result.content[0].text)).toEqual([{ id: "ar1", kind: "apk" }]);
  });

  it("list_graph_entities passes the type and q filters", async () => {
    mocked(gateway.listGraphEntities).mockResolvedValue([]);

    await call("list_graph_entities", { workspace: "my-app", type: "class", q: "login" });

    expect(gateway.listGraphEntities).toHaveBeenCalledWith("ws-abc", {
      type: "class",
      q: "login",
    });
  });

  it("get_graph_entity needs an entityId and does not touch workspaces", async () => {
    const missing = await call("get_graph_entity", {});
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('"entityId" is required');

    mocked(gateway.getGraphEntity).mockResolvedValue({ entity: { id: "e1" }, edges: [] });
    const ok = await call("get_graph_entity", { entityId: "e1" });

    expect(gateway.getGraphEntity).toHaveBeenCalledWith("e1");
    expect(getOrCreateWorkspace).not.toHaveBeenCalled();
    expect(JSON.parse(ok.content[0].text)).toEqual({ entity: { id: "e1" }, edges: [] });
  });

  it("list_findings passes the status and entityId filters", async () => {
    mocked(gateway.listFindings).mockResolvedValue([]);

    await call("list_findings", { workspace: "my-app", status: "confirmed", entityId: "e1" });

    expect(gateway.listFindings).toHaveBeenCalledWith("ws-abc", {
      status: "confirmed",
      entityId: "e1",
    });
  });

  it("create_finding requires a claim and always records the finding as the AI's", async () => {
    const missing = await call("create_finding", { workspace: "my-app" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('"claim" is required');
    expect(gateway.createFinding).not.toHaveBeenCalled();

    mocked(gateway.createFinding).mockResolvedValue({ id: "f1" });
    const evidence = [{ artifactId: "ar1", entityId: "e1", location: "A.java:1" }];
    // A caller trying to label it as a human's finding is ignored.
    const result = await call("create_finding", {
      workspace: "my-app",
      claim: "Hardcoded key",
      status: "confirmed",
      evidence,
      source: "user",
    });

    expect(result.isError).toBe(false);
    expect(gateway.createFinding).toHaveBeenCalledWith("ws-abc", {
      claim: "Hardcoded key",
      status: "confirmed",
      confidence: undefined,
      reasoning: undefined,
      evidence,
      source: "ai",
    });
  });

  it("update_finding requires a findingId and forwards only the fields to change", async () => {
    const missing = await call("update_finding", { status: "confirmed" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('"findingId" is required');

    mocked(gateway.updateFinding).mockResolvedValue({ id: "f1", status: "contradicted" });
    const result = await call("update_finding", { findingId: "f1", status: "contradicted" });

    expect(result.isError).toBe(false);
    expect(getOrCreateWorkspace).not.toHaveBeenCalled();
    expect(gateway.updateFinding).toHaveBeenCalledWith("f1", {
      status: "contradicted",
      confidence: undefined,
      reasoning: undefined,
      evidence: undefined,
    });
  });

  it("reports a rejected finding as an error result with the Gateway's reason", async () => {
    mocked(gateway.createFinding).mockRejectedValue(
      new Error("Gateway POST /workspaces/ws-abc/findings -> 400: Evidence cites artifact(s) x"),
    );

    const result = await call("create_finding", {
      claim: "x",
      evidence: [{ artifactId: "nope" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Evidence cites artifact(s)");
  });
});
