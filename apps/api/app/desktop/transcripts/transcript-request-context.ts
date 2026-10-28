import { SyncLane } from "@closedloop-ai/telemetry-contract/sync";
import { Prisma } from "@repo/database";
import { computeTargetsService } from "@/app/compute-targets/service";
import { reportComputeTargetOwnershipRefusal } from "@/app/compute-targets/service/ownership-refusal-telemetry";
import type { AuthContext as RouteAuthContext } from "@/lib/auth/with-auth";
import {
  projectTranscriptIdentity,
  reportTranscriptIndexKeyProjections,
} from "./transcript-index-keys";
import { resolveTranscriptObjectKey } from "./transcript-plan";
import type { TranscriptRateLimiter } from "./transcript-rate-limit";
import type { TranscriptS3Port } from "./transcript-s3-port";
import { TranscriptSyncErrorReason } from "./transcript-sync-error-reason";

/**
 * Per-request context shared by all three transcript lanes (plan / complete /
 * skip): the file's identity, the advisory lock derived from it, the Prisma
 * `where` that resolves it, and the ownership + policy + rate-limit front door
 * that turns an authenticated request into an S3 object key.
 *
 * Extracted from `service.ts` (ISS-8125) because that file reached the 1000-line
 * ceiling. The seam is a real one — every export here is about identifying and
 * admitting ONE request, and nothing here touches the upload state machine the
 * service still owns.
 */

export type AuthContext = {
  organizationId: string;
  userId: string;
  clerkUserId: string | null;
  /** ISS-11426 telemetry only: which credential authenticated the request. */
  authMethod?: RouteAuthContext["authMethod"];
};

export type ResolvedDeps = {
  s3: TranscriptS3Port;
  now: () => number;
  rateLimiter: TranscriptRateLimiter;
};

export type FileIdentity = {
  computeTargetId: string;
  externalSessionId: string;
  fileKey: string;
};

export function lockKey(identity: FileIdentity): string {
  return `transcript:${identity.computeTargetId}:${identity.externalSessionId}:${identity.fileKey}`;
}

// Advisory-lock key (PRD-536 D12): all per-file transcript lock sites derive
// the same key via lockKey() and route through this ONE helper so they stay
// consistent. The 64-bit hashtextextended widens the 32-bit hashtext space so
// unrelated files no longer share a slot and serialize under load. Matches the
// two-arg idiom in dirty-scope-service.ts.
//
// DEPLOY-TRANSITION (transitional): we take BOTH the legacy 32-bit hashtext()
// lock AND the new 64-bit hashtextextended() lock, in a fixed order (old then
// new) within the same transaction. During a rolling API deploy, in-flight
// handlers from the PREVIOUS release still hold the 32-bit-keyed lock while
// new-release handlers take the 64-bit key; different keys would give NO mutual
// exclusion during the mixed-version window, re-opening the TOCTOU race for the
// same file. Holding both keys excludes both other new-release handlers (new
// key) and still-running old-release handlers (old key). The fixed old→new
// ordering (identical here and in agent-sessions/service.ts) avoids any
// deadlock between mixed handlers.
//
// FOLLOW-UP: once the pre-D12 release is fully drained in every environment,
// drop the legacy hashtext() acquisition here and at the session site and keep
// only the 64-bit lock. Tracked as a follow-up FEAT (noted in the PR body).
export const advisoryLockKeySql = (key: string) =>
  Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${key})), pg_advisory_xact_lock(hashtextextended(${key}, 0::bigint))`;

export function identityWhere(identity: FileIdentity) {
  // ISS-8125: this table's identity IS the
  // `(compute_target_id, external_session_id, file_key)` UNIQUE btree, so both
  // strings are projected before they reach a column or a `where`. Every lookup
  // and every upsert in this file routes through here, so a projected row is
  // never invisible to the request that wrote it.
  const projected = projectTranscriptIdentity(identity);
  return {
    computeTargetId_externalSessionId_fileKey: {
      computeTargetId: projected.computeTargetId,
      externalSessionId: projected.externalSessionId,
      fileKey: projected.fileKey,
    },
  };
}

/**
 * Shared front door for both routes: verify compute-target ownership FIRST,
 * then rate-limit keyed on the now-verified target (so an unauthorized caller
 * can't drain another tenant's abuse-control budget), then resolve the object
 * key. Returns the object key on success or a typed error reason.
 */
export async function authorizeTranscriptRequest(
  input: AuthContext & { request: FileIdentity },
  deps: ResolvedDeps
): Promise<{ objectKey: string } | { error: TranscriptSyncErrorReason }> {
  const { request } = input;
  const target = await computeTargetsService.findOwnedById(
    request.computeTargetId,
    input.organizationId,
    input.userId,
    input.clerkUserId
  );
  if (!target) {
    await reportComputeTargetOwnershipRefusal({
      lane: SyncLane.TranscriptArchive,
      computeTargetId: request.computeTargetId,
      organizationId: input.organizationId,
      userId: input.userId,
      authMethod: input.authMethod,
    });
    return { error: TranscriptSyncErrorReason.Forbidden };
  }
  if (!deps.rateLimiter.attempt(request.computeTargetId, deps.now())) {
    return { error: TranscriptSyncErrorReason.RateLimited };
  }
  // ISS-8125: the S3 key is DERIVED from the same two strings the index tuple
  // holds, so it is minted from the projected identity rather than the raw wire
  // values. Deriving it from the raw pair would bound the columns and leave the
  // key over S3's own 1024-byte limit — the row would land and the bytes still
  // would not.
  const projected = projectTranscriptIdentity(request);
  reportTranscriptIndexKeyProjections(input.organizationId, projected);
  const objectKey = resolveTranscriptObjectKey({
    organizationId: input.organizationId,
    computeTargetId: projected.computeTargetId,
    externalSessionId: projected.externalSessionId,
    fileKey: projected.fileKey,
  });
  return { objectKey };
}
