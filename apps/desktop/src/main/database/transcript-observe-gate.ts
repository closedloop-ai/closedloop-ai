/**
 * @file transcript-observe-gate.ts
 * @description The observe path's ISS-7096 foreign-ownership gate helpers,
 * split out of `transcript-sync-store.ts` so the store stays under the
 * file-size ceiling (cr PR #5377 review). The gate itself — when a row is
 * withheld, withdrawn, or recorded idle — lives in the store's `observe`;
 * these are its building blocks.
 */
import { TranscriptSyncStatus } from "../../shared/transcript-sync-status-contract.js";
import {
  isForeignOwnedSession,
  type SignedInUserIdentity,
} from "../util/user-identity.js";
import type { Prisma } from "./generated/client.js";
import {
  CLEARED_LANE_STALL,
  CLEARED_UPLOAD_LEASE,
} from "./transcript-sync-settle.js";
import type { TranscriptObserveInput } from "./transcript-sync-store.js";

/**
 * ISS-7096: the DB-reading wrapper over the canonical `isForeignOwnedSession`
 * predicate (`util/user-identity.ts`): true only when the session row EXISTS
 * with a FULL identity pair that differs from the signed-in one.
 */
export async function sessionIsForeignOwned(
  client: Prisma.TransactionClient,
  externalSessionId: string,
  identity: SignedInUserIdentity
): Promise<boolean> {
  const owner = await client.session.findUnique({
    where: { id: externalSessionId },
    select: { userId: true, organizationId: true },
  });
  return isForeignOwnedSession(owner, identity);
}

/**
 * cr-81036: the create-row identity/observation fields shared by the general
 * upsert and the foreign-owned idle record — one list, so a new observed
 * field reaches both.
 */
export function observedFileIdentity(
  input: TranscriptObserveInput,
  mtime: bigint | null,
  size: bigint | null
) {
  return {
    externalSessionId: input.externalSessionId,
    fileKey: input.fileKey,
    sourceHarness: input.sourceHarness,
    sourcePath: input.sourcePath,
    sourcePathHash: input.sourcePathHash,
    lastMtimeMs: mtime,
    lastSize: size,
  };
}

/**
 * cr-81036: the idle no-verdict state a foreign-owned row is held in.
 *
 * ISS-7097: this is the FOURTH writer of an idle/withdrawn row, alongside
 * `settleUpdateData`'s `idle` arm, its `cloudUploaded` arm, and
 * `revivedRowData` — so it owes the same two releases they do. A withdrawn row
 * is not uploading, so it must not keep a claim; and it is not stalling, so it
 * must not keep a stall origin that a later revive would inherit and be judged
 * past the ceiling on.
 */
export const FOREIGN_IDLE_STATE = {
  status: TranscriptSyncStatus.Idle,
  retryCount: 0,
  missingSourceCount: 0,
  nextAttemptAt: null,
  lastError: null,
  ...CLEARED_UPLOAD_LEASE,
  ...CLEARED_LANE_STALL,
} as const;
