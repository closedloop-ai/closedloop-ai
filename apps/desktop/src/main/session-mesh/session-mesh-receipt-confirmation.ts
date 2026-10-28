import type { Ledger } from "./session-mesh-delivery-ledger.js";
import type { SessionMeshEngagement } from "./session-mesh-engagement.js";
import {
  recordSessionMeshDeliveredEvidence,
  type SessionMeshEvidenceObserver,
} from "./session-mesh-evidence-observer.js";
import type { SessionMeshHookResult } from "./session-mesh-hook-contract.js";
import {
  receiptOverlapsDelivery,
  rememberDeliveredLocally,
  takeSessionMeshReceipt,
} from "./session-mesh-receipts.js";

/**
 * What a confirmed delivery receipt fans out to.
 *
 * Split out of `session-mesh-runtime.ts` (ISS-11755), which had reached the
 * 1,000-line ceiling. The receipt is the exact turn boundary at which peer
 * context entered the model, so it is what every per-delivery observer has to
 * be told about, and keeping that fan-out in one place is why this module
 * exists. The runtime still owns the ledger, the enqueue and the persist.
 */
export type SessionMeshReceiptConfirmation = {
  ledger: Ledger;
  sourceKey: string;
  /** The receipt id the hook reported, as it arrived on the event. */
  receiptKey: unknown;
  engagement: SessionMeshEngagement;
  evidence: SessionMeshEvidenceObserver;
  deliveredLocally: Map<string, number>;
  readyContext: Map<
    string,
    { result: SessionMeshHookResult; createdAt: number }
  >;
  now: () => number;
  enqueue: (path: string, body: unknown, id: string) => void;
};

/**
 * Claim the receipt and fan it out, or do nothing when it is absent or belongs
 * to another account. Returns whether anything was claimed, so the caller knows
 * whether the ledger needs persisting.
 */
export function confirmSessionMeshReceipt(
  input: SessionMeshReceiptConfirmation
): boolean {
  const key = typeof input.receiptKey === "string" ? input.receiptKey : "";
  const delivered = takeSessionMeshReceipt(input.ledger, input.sourceKey, key);
  if (!delivered) {
    return false;
  }
  const { agentId } = delivered;
  input.engagement.markPrompted(
    input.sourceKey,
    agentId,
    (delivered.promptedMessageIds ?? []).map((messageId) => ({ messageId }))
  );
  // Operator ruling 2026-10-01, #8289 warning decision 2: "yes wire it into the
  // hook pipeline; we need it for the round trip."
  recordSessionMeshDeliveredEvidence(input.evidence, {
    sourceKey: input.sourceKey,
    agentId,
    messageIds: delivered.messageIds,
    seeds: delivered.evidence,
  });
  for (const messageId of delivered.messageIds) {
    input.engagement.recordDelivery({
      sourceKey: input.sourceKey,
      agentId,
      messageId,
      summary: delivered.summaries?.[messageId] ?? "",
      paths: delivered.paths?.[messageId] ?? [],
    });
    rememberDeliveredLocally(
      input.deliveredLocally,
      `${input.sourceKey}:${agentId}:${messageId}`,
      input.now()
    );
    input.enqueue(
      "/session-mesh/inbox/disposition",
      {
        agentId,
        messageId,
        status: "delivered",
        reason: "Native hook context stdout flushed",
      },
      `${key}:${messageId}`
    );
  }
  for (const [cacheKey, value] of input.readyContext) {
    const pending = value.result.receipt
      ? input.ledger.receipts[value.result.receipt]
      : undefined;
    if (
      value.result.receipt === key ||
      receiptOverlapsDelivery(pending, delivered, input.sourceKey)
    ) {
      input.readyContext.delete(cacheKey);
    }
  }
  return true;
}
