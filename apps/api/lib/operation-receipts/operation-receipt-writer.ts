import "server-only";

import {
  formatOperationId,
  type OperationKind,
  type OperationReceipt,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { v7 } from "uuid";
import type { OperationReceiptRequest } from "./operation-receipt-request";

/** What a write did, as recorded on its receipt. */
export type OperationReceiptWrite = {
  operationKind: OperationKind;
  outcome:
    | typeof OperationReceiptOutcome.Committed
    | typeof OperationReceiptOutcome.NoOp;
  targetArtifactId?: string;
  createdArtifactId?: string;
  versionNumber?: number;
  commentId?: string;
  linkId?: string;
  changedFields?: readonly string[];
  contentDigestBefore?: string;
  contentDigestAfter?: string;
};

/**
 * ISS-12552: record the receipt for a committed or no-op write on the write's
 * own transaction, so the receipt exists exactly when the write does. Returns
 * the public `operationReceipt` for the response; null when the request gets
 * no receipt (a browser or Desktop session).
 */
export async function recordOperationReceipt(params: {
  tx: TransactionClient;
  request: OperationReceiptRequest | null;
  write: OperationReceiptWrite;
}): Promise<OperationReceipt | null> {
  const { tx, request, write } = params;
  if (!request) {
    return null;
  }
  const row = await tx.artifactOperationReceipt.create({
    data: {
      organizationId: request.organizationId,
      principalUserId: request.principalUserId,
      apiKeyId: request.apiKeyId,
      source: request.source,
      operationKind: write.operationKind,
      targetArtifactId: write.targetArtifactId,
      outcome: write.outcome,
      createdArtifactId: write.createdArtifactId,
      versionNumber: write.versionNumber,
      commentId: write.commentId,
      linkId: write.linkId,
      changedFields: [...(write.changedFields ?? [])],
      contentDigestBefore: write.contentDigestBefore,
      contentDigestAfter: write.contentDigestAfter,
      clientCallId: request.clientCallId,
      requestFingerprint: request.requestFingerprint,
      requestedAt: request.requestedAt,
      committedAt: new Date(),
      route: request.route,
    },
    select: { id: true, outcome: true },
  });
  return { operationId: formatOperationId(row.id), outcome: row.outcome };
}

/**
 * Record a rejected MCP write after its transaction rolled back. Only an MCP
 * request carrying a call id writes one, and the partial unique
 * `artifact_operation_receipts_rejected_call_key` keeps one row per owner and
 * call id, so replaying a denied call cannot multiply rows. Prisma drops the
 * partial predicate from the generated client, hence the raw
 * `ON CONFLICT ... WHERE` (packages/database/AGENTS.md).
 */
export async function recordRejectedOperationReceipt(params: {
  request: OperationReceiptRequest | null;
  operationKind: OperationKind;
  targetArtifactId?: string;
}): Promise<void> {
  const { request, operationKind, targetArtifactId } = params;
  if (
    request?.source !== OperationSource.Mcp ||
    request.clientCallId === undefined
  ) {
    return;
  }
  await withDb((db) =>
    db.$executeRaw(Prisma.sql`
      INSERT INTO "artifact_operation_receipts" (
        "id", "organization_id", "principal_user_id", "api_key_id", "source",
        "operation_kind", "target_artifact_id", "outcome", "client_call_id",
        "request_fingerprint", "requested_at", "route"
      ) VALUES (
        ${v7()}::uuid, ${request.organizationId}::uuid,
        ${request.principalUserId}::uuid, ${request.apiKeyId ?? null}::uuid,
        ${request.source}, ${operationKind}, ${targetArtifactId ?? null}::uuid,
        ${OperationReceiptOutcome.Rejected}, ${request.clientCallId},
        ${request.requestFingerprint ?? null}, ${request.requestedAt},
        ${request.route ?? null}
      )
      ON CONFLICT ("organization_id", "principal_user_id", "client_call_id")
        WHERE ((outcome = 'rejected'::text) AND (client_call_id IS NOT NULL))
        DO NOTHING
    `)
  );
}
