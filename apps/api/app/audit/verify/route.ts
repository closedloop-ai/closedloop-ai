import type { AuditVerifyResult } from "@repo/api/src/types/audit";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { auditLedgerService } from "../audit-ledger-service";

/**
 * POST /audit/verify — recompute and verify the caller organization's entire
 * audit chain (FEA-3862 Slice 1d). Returns `{ ok: true, head }` for an intact
 * chain, or `{ ok: false, brokenAtSeq, reason }` pointing at the first row that
 * fails linkage/recompute. Org-scoped; `verifyChain` never reads another org's
 * rows. POST because verification walks the whole chain (a non-trivial read),
 * matching the plan's contract.
 */
export const POST = withAnyAuth<AuditVerifyResult, "/audit/verify">(
  async ({ user }) => {
    try {
      const result = await auditLedgerService.verifyChain(user.organizationId);
      if (result.ok) {
        const head = await auditLedgerService.readHead(user.organizationId);
        return successResponse({ ok: true, head });
      }
      return successResponse({
        ok: false,
        brokenAtSeq: result.brokenAtSeq.toString(),
        reason: result.reason,
      });
    } catch (error) {
      return errorResponse("Failed to verify audit chain", error);
    }
  },
  // Read-only: verification recomputes and reads the org's chain, it never
  // writes. Without an explicit scope a POST defaults to the `write` fallback
  // (see `with-any-auth`), which would 403 a read-scoped API key — and the MCP
  // `verify-audit-ledger` tool calls this with the user's key. Mirrors
  // `GET /audit/head`.
  { requiredScopes: ["read"] }
);
