import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The agent talks to finding.service and the evidence verifier; both are
// mocked so the tests exercise the agent's own logic: payload validation,
// id scoping, summary tallies, and the status application mapping.
vi.mock("../src/findings/verifier.js", () => ({
  verifyFinding: vi.fn(),
}));
vi.mock("../src/findings/finding.service.js", () => ({
  getFinding: vi.fn(),
  listFindingsForWorkspace: vi.fn(),
  updateFinding: vi.fn(),
}));
vi.mock("../src/providers/ai.provider.js", () => ({ complete: vi.fn() }));

import { verifyClaimsHandler } from "../src/modules/mcp/agents/verify-claims.agent.js";
import { verifyFinding } from "../src/findings/verifier.js";
import {
  getFinding,
  listFindingsForWorkspace,
  updateFinding,
} from "../src/findings/finding.service.js";
import type { Finding } from "../src/findings/types.js";
import type { McpTask } from "../src/core/types.js";

const mockedVerify = vi.mocked(verifyFinding);
const mockedGet = vi.mocked(getFinding);
const mockedList = vi.mocked(listFindingsForWorkspace);
const mockedUpdate = vi.mocked(updateFinding);

function finding(id: string, workspaceId = "ws1"): Finding {
  return {
    id,
    workspaceId,
    claim: `Finding ${id}`,
    status: "unverified",
    evidence: [],
    source: "system",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function task(payload: Record<string, unknown> = {}): McpTask {
  return {
    id: "task1",
    workspaceId: "ws1",
    agent: "verify-claims",
    operation: "verify",
    payload,
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as McpTask;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedUpdate.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verify-claims agent", () => {
  it("rejects unknown operations", async () => {
    await expect(verifyClaimsHandler({ ...task(), operation: "nope" })).rejects.toThrow(
      'Unsupported verify-claims operation "nope"',
    );
  });

  it("rejects a findingIds that is not an array of strings", async () => {
    await expect(verifyClaimsHandler(task({ findingIds: [1, 2] }))).rejects.toThrow(
      '"findingIds" must be an array of finding id strings',
    );
    await expect(verifyClaimsHandler(task({ findingIds: "f1" }))).rejects.toThrow(
      '"findingIds" must be an array of finding id strings',
    );
  });

  it("rejects a non-boolean apply", async () => {
    await expect(verifyClaimsHandler(task({ apply: "yes" }))).rejects.toThrow(
      '"apply" must be a boolean',
    );
  });

  it("verifies all workspace findings when no ids are given and tallies summaries", async () => {
    mockedList.mockResolvedValue([finding("f1"), finding("f2"), finding("f3")]);
    mockedVerify.mockImplementation(async (f) => {
      const summary = f.id === "f1" ? "verified" : f.id === "f2" ? "partial" : "unverified";
      return { findingId: f.id, checkedAt: "t", summary, items: [] };
    });

    const result = (await verifyClaimsHandler(task())) as Record<string, unknown>;
    expect(mockedList).toHaveBeenCalledWith("ws1");
    expect(result.total).toBe(3);
    expect(result.applied).toBe(false);
    expect(result.summaries).toEqual({ verified: 1, partial: 1, unverified: 1, failed: 0 });
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("resolves explicit ids and fails on a finding from another workspace", async () => {
    mockedGet.mockResolvedValueOnce(finding("f1"));
    mockedGet.mockResolvedValueOnce(finding("f-other", "ws2"));

    await expect(verifyClaimsHandler(task({ findingIds: ["f1"] }))).resolves.toBeTruthy();
    expect(mockedList).not.toHaveBeenCalled();

    await expect(verifyClaimsHandler(task({ findingIds: ["f-other"] }))).rejects.toThrow(
      "does not exist in workspace ws1",
    );

    await expect(verifyClaimsHandler(task({ findingIds: ["missing"] }))).rejects.toThrow(
      "does not exist in workspace ws1",
    );
  });

  it("apply maps verified/partial to confirmed, unverified to unverified, failed to contradicted", async () => {
    mockedList.mockResolvedValue([finding("f1"), finding("f2"), finding("f3"), finding("f4")]);
    mockedVerify.mockImplementation(async (f) => {
      const summary = (
        { f1: "verified", f2: "partial", f3: "unverified", f4: "failed" } as Record<string, string>
      )[f.id] as "verified";
      return { findingId: f.id, checkedAt: "t", summary, items: [] };
    });

    const result = (await verifyClaimsHandler(task({ apply: true }))) as {
      applied: boolean;
    };
    expect(result.applied).toBe(true);
    expect(mockedUpdate).toHaveBeenCalledTimes(4);
    expect(mockedUpdate).toHaveBeenCalledWith("f1", { status: "confirmed" });
    expect(mockedUpdate).toHaveBeenCalledWith("f2", { status: "confirmed" });
    expect(mockedUpdate).toHaveBeenCalledWith("f3", { status: "unverified" });
    expect(mockedUpdate).toHaveBeenCalledWith("f4", { status: "contradicted" });
  });

  it("does not touch statuses without apply", async () => {
    mockedList.mockResolvedValue([finding("f1")]);
    mockedVerify.mockResolvedValue({
      findingId: "f1",
      checkedAt: "t",
      summary: "failed",
      items: [],
    });
    await verifyClaimsHandler(task());
    expect(mockedUpdate).not.toHaveBeenCalled();
  });
});
