import type { AuditChainHead } from "@repo/api/src/types/audit";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { auditLedgerService } from "../audit-ledger-service";

/**
 * GET /audit/head — the caller organization's audit-chain head `(seq, hash)`
 * (FEA-3862 Slice 1d). Org-scoped via the authenticated context; an empty chain
 * returns the genesis sentinel (`seq: "0"`, zero-hash). `read` scope suffices.
 */
export const GET = withAnyAuth<AuditChainHead, "/audit/head">(
  async ({ user }) => {
    try {
      const head = await auditLedgerService.readHead(user.organizationId);
      return successResponse(head);
    } catch (error) {
      return errorResponse("Failed to read audit chain head", error);
    }
  },
  { requiredScopes: ["read"] }
);
