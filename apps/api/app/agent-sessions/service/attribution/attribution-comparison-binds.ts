/**
 * ISS-12552: how the comparison report's bound
 * receipts were joined to their claims, so the fingerprint fallback is counted
 * apart from the call-id join. Read from each bound row and its
 * receipt: the claim's call id is the receipt's; else a shell claim, or a
 * claim whose fingerprint is not the receipt's, bound by an operation id it
 * printed or was returned; else the fingerprint matched. An MCP claim bound by
 * a returned operation id whose fingerprint also matched cannot be told apart
 * from a fingerprint bind, so it is counted as one.
 */
import { OperationSource } from "@repo/api/src/types/attribution-evidence";
import { Prisma, withDb } from "@repo/database";

export type ReceiptBindCounts = {
  callId: number;
  operationId: number;
  fingerprint: number;
};

export function emptyReceiptBindCounts(): ReceiptBindCounts {
  return { callId: 0, operationId: 0, fingerprint: 0 };
}

export async function countReceiptBinds(
  organizationId: string,
  sections: readonly { receiptBinds: ReceiptBindCounts }[]
): Promise<void> {
  // COALESCE: a null id compares as unknown, and NOT unknown filters nothing.
  const callIdMatch = Prisma.sql`COALESCE(
    e.provider_call_id = r.client_call_id, false)`;
  const fingerprintMatch = Prisma.sql`COALESCE(
    e.source <> ${OperationSource.Shell}
      AND e.request_fingerprint = r.request_fingerprint, false)`;
  const [row] = await withDb((db) =>
    db.$queryRaw<
      { callId: bigint; operationId: bigint; fingerprint: bigint }[]
    >(
      Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE ${callIdMatch}) AS "callId",
          COUNT(*) FILTER (WHERE NOT ${callIdMatch} AND NOT ${fingerprintMatch})
            AS "operationId",
          COUNT(*) FILTER (WHERE NOT ${callIdMatch} AND ${fingerprintMatch})
            AS "fingerprint"
        FROM agent_session_operation_evidence e
        JOIN artifact_operation_receipts r
          ON r.id = e.receipt_id AND r.organization_id = e.organization_id
        WHERE e.organization_id = ${organizationId}::uuid
      `
    )
  );
  for (const section of sections) {
    section.receiptBinds.callId += Number(row?.callId ?? 0n);
    section.receiptBinds.operationId += Number(row?.operationId ?? 0n);
    section.receiptBinds.fingerprint += Number(row?.fingerprint ?? 0n);
  }
}
