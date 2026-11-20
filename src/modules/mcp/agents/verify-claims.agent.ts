import type { McpTask } from "../../../core/types.js";
import * as findingService from "../../../findings/finding.service.js";
import { verifyFinding } from "../../../findings/verifier.js";
import type { FindingStatus, VerificationReport } from "../../../findings/types.js";

interface VerifyClaimsPayload {
  /** "all" verifies every finding in the workspace; otherwise a list of finding ids. */
  findingIds?: string[];
  /** When true, the findings' status is updated to match the verification summary. */
  apply?: boolean;
}

function assertPayload(payload: Record<string, unknown>): VerifyClaimsPayload {
  const out: VerifyClaimsPayload = {};
  if (payload.findingIds !== undefined) {
    if (
      !Array.isArray(payload.findingIds) ||
      payload.findingIds.some((id) => typeof id !== "string")
    ) {
      throw new Error('verify-claims "findingIds" must be an array of finding id strings');
    }
    out.findingIds = payload.findingIds as string[];
  }
  if (payload.apply !== undefined) {
    if (typeof payload.apply !== "boolean") {
      throw new Error('verify-claims "apply" must be a boolean');
    }
    out.apply = payload.apply;
  }
  return out;
}

/** Finding status values the verification summary maps onto, when `apply` is set. */
const STATUS_BY_SUMMARY: Record<VerificationReport["summary"], FindingStatus> = {
  verified: "confirmed",
  partial: "confirmed", // every check ran; only some cited places couldn't be re-read
  unverified: "unverified",
  failed: "contradicted", // at least one cited place is provably wrong or missing
};

/**
 * The "verify-claims" MCP agent - the claim-verification workflow step. It
 * takes findings (every one in the workspace, or an explicit list) and runs
 * each through the evidence verifier (`findings/verifier.ts`), which checks
 * that every cited artifact exists, every cited location (file:line) is real
 * and in range, and every cited graph entity is still observed in the
 * artifact. A claim with no supporting evidence behind it comes back
 * "unverified" - flagged, not silently trusted.
 *
 * Read-only by default. With `apply: true` the findings' statuses are updated
 * to match: `verified`/`partial` -> `confirmed`, `unverified` -> stays
 * `unverified`, `failed` -> `contradicted`. This is the piece a workflow step composes: "AI summary" ->
 * "verify-claims" means the AI's output has to cite artifacts the verifier
 * can actually find before anything downstream trusts it.
 */
export async function verifyClaimsHandler(task: McpTask): Promise<unknown> {
  if (task.operation !== "verify") {
    throw new Error(`Unsupported verify-claims operation "${task.operation}". Supported: "verify"`);
  }
  const { findingIds, apply } = assertPayload(task.payload);

  let findings;
  if (findingIds) {
    findings = [];
    for (const id of findingIds) {
      const finding = await findingService.getFinding(id);
      if (!finding || finding.workspaceId !== task.workspaceId) {
        throw new Error(`finding ${id} does not exist in workspace ${task.workspaceId}`);
      }
      findings.push(finding);
    }
  } else {
    findings = await findingService.listFindingsForWorkspace(task.workspaceId);
  }

  const results = [];
  for (const finding of findings) {
    const report = await verifyFinding(finding);
    if (apply) {
      await findingService.updateFinding(finding.id, { status: STATUS_BY_SUMMARY[report.summary] });
    }
    results.push({ findingId: finding.id, summary: report.summary, report });
  }

  return {
    workspaceId: task.workspaceId,
    checkedAt: new Date().toISOString(),
    applied: apply === true,
    total: results.length,
    summaries: {
      verified: results.filter((r) => r.summary === "verified").length,
      partial: results.filter((r) => r.summary === "partial").length,
      unverified: results.filter((r) => r.summary === "unverified").length,
      failed: results.filter((r) => r.summary === "failed").length,
    },
    results,
  };
}
