import { randomUUID } from "node:crypto";
import type { SessionMeshInboxResponse } from "@repo/api/src/types/session-mesh";
import type { Ledger } from "./session-mesh-delivery-ledger.js";
import type { SessionMeshEvidenceSeed } from "./session-mesh-evidence-observer.js";

/**
 * Delivery-receipt bookkeeping over the ledger: minting one when peer context is
 * handed to a hook, and claiming it when that hook reports stdout flushed.
 *
 * Split out of `session-mesh-runtime.ts` (ISS-11435), which had reached the
 * 1,000-line ceiling. Both functions are total over the ledger they are handed
 * and neither talks to the cloud, so the runtime keeps the decisions and the
 * persistence.
 */
const MAX_OUTSTANDING_RECEIPTS = 500;
const RECEIPT_TTL_MS = 300_000;
// Matching is token-based, so a few hundred characters and a handful of paths
// are enough. The ledger is rewritten SYNCHRONOUSLY on the main process on every
// enqueue, drain and poll, so storing four 4,000-char summaries and 800
// 1,000-char paths per receipt would make each hook pay a multi-MB write.
const MAX_SUMMARY = 400;
const MAX_PATHS = 20;
const MAX_DELIVERED_LOCALLY = 4000;

type Message = SessionMeshInboxResponse["messages"][number]["message"];

/**
 * Record a receipt for the messages about to be printed, and return its id.
 *
 * The delivered SUBJECT TEXT is stored alongside the ids so engagement can be
 * matched against it later; the ledger field is optional, so a receipt written by
 * an older build simply carries none and its delivery records as not engaged.
 */
export function mintSessionMeshReceipt(
  ledger: Ledger,
  input: {
    sourceKey: string;
    agentId: string;
    selected: readonly Message[];
    now: number;
    /** Engaged deliveries whose value prompt this context carries, marked asked
     * only when the hook confirms this receipt. */
    promptedMessageIds?: readonly string[];
    /** Per-message usefulness evidence seeds; see the ledger's `evidence`. */
    evidence?: Record<string, SessionMeshEvidenceSeed>;
  }
): string {
  for (const [key, value] of Object.entries(ledger.receipts)) {
    if (input.now - value.createdAt > RECEIPT_TTL_MS) {
      delete ledger.receipts[key];
    }
  }
  if (Object.keys(ledger.receipts).length >= MAX_OUTSTANDING_RECEIPTS) {
    throw new Error("Session Mesh outstanding receipt limit reached");
  }
  const receiptId = randomUUID();
  ledger.receipts[receiptId] = {
    sourceKey: input.sourceKey,
    agentId: input.agentId,
    messageIds: input.selected.map((message) => message.id),
    createdAt: input.now,
    summaries: Object.fromEntries(
      input.selected.map((message) => [
        message.id,
        message.summary.slice(0, MAX_SUMMARY),
      ])
    ),
    paths: Object.fromEntries(
      input.selected.map((message) => [message.id, messagePaths(message)])
    ),
    ...(input.promptedMessageIds?.length
      ? { promptedMessageIds: [...input.promptedMessageIds] }
      : {}),
    ...(input.evidence && Object.keys(input.evidence).length
      ? { evidence: { ...input.evidence } }
      : {}),
  };
  return receiptId;
}

/**
 * Claim the receipt `key` for `sourceKey`, returning what it recorded, or `null`
 * when it is absent or belongs to another account. The caller persists.
 */
export function takeSessionMeshReceipt(
  ledger: Ledger,
  sourceKey: string,
  key: string
): Ledger["receipts"][string] | null {
  const delivered = ledger.receipts[key];
  if (delivered?.sourceKey !== sourceKey) {
    return null;
  }
  delete ledger.receipts[key];
  return delivered;
}

/** Whether a still-pending receipt covers any of the messages just delivered. */
export function receiptOverlapsDelivery(
  pending: Ledger["receipts"][string] | undefined,
  delivered: Ledger["receipts"][string],
  sourceKey: string
): boolean {
  return Boolean(
    pending?.agentId === delivered.agentId &&
      pending.sourceKey === sourceKey &&
      pending.messageIds.some((id) => delivered.messageIds.includes(id))
  );
}

/**
 * Remember a locally delivered message so the next poll does not re-present it,
 * evicting the oldest entry at the cap. External input, so growth is bounded.
 */
export function rememberDeliveredLocally(
  delivered: Map<string, number>,
  key: string,
  now: number
): void {
  if (delivered.size >= MAX_DELIVERED_LOCALLY) {
    delivered.delete(delivered.keys().next().value ?? "");
  }
  delivered.set(key, now);
}

/** Forget local delivery marks older than the receipt TTL. */
export function pruneDeliveredLocally(
  delivered: Map<string, number>,
  now: number
): void {
  for (const [key, at] of delivered) {
    if (now - at > RECEIPT_TTL_MS) {
      delivered.delete(key);
    }
  }
}

function messagePaths(message: Message): string[] {
  return Array.isArray(message.paths)
    ? message.paths
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, MAX_PATHS)
    : [];
}
