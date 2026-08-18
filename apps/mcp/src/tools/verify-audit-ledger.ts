import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  AuditChainHead,
  AuditVerifyResult,
} from "@repo/api/src/types/audit";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

/**
 * MCP tool wrapping the audit-ledger verify + head REST surface (FEA-3862
 * Slice 1d). Runs `POST /audit/verify` to recompute the caller organization's
 * tamper-evident chain, and reports the head `(seq, hash)` — either from the
 * verify result (intact chain) or a follow-up `GET /audit/head` when the chain
 * is broken. Org-scoped by the API-key auth on `apiClient`; a caller can only
 * ever see its own organization's ledger.
 */
export function registerVerifyAuditLedger(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "verify-audit-ledger",
    {
      description:
        "Verify the organization's tamper-evident audit ledger chain and return " +
        "its head (seq, hash). Reports ok=true for an intact chain, or ok=false " +
        "with the first broken sequence number when a row fails integrity.",
    },
    () =>
      withErrorHandling(async () => {
        const result = await apiClient.post<AuditVerifyResult>(
          "/audit/verify",
          {}
        );

        const head: AuditChainHead = result.ok
          ? result.head
          : await apiClient.get<AuditChainHead>("/audit/head");

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...result, head }, null, 2),
            },
          ],
        };
      })
  );
}
