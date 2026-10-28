/**
 * ISS-12552: persist a session's operation claims. The claims
 * are extracted from the parsed session before the import opens a transaction,
 * and stored as one row per session, replaced only when their digest changes,
 * so the sync source sends a session's evidence once per change.
 */
import { createHash } from "node:crypto";
import {
  OPERATION_EVIDENCE_EXTRACTOR_VERSION,
  type SessionOperationEvidence,
} from "@repo/api/src/types/operation-claims";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { extractOperationClaims } from "@repo/lib/attribution/extract-operation-claims";
import {
  GitWriteAction,
  type GitWriteInput,
} from "@repo/lib/attribution/repository-write-claims";
import { z } from "zod";
import type { ArtifactRefRecord } from "../collectors/parsing/artifact-ref-record.js";
import { MonitoredSessionCliRefMethod } from "../collectors/parsing/monitored-session-activity.js";
import type { Harness, NormalizedSession } from "../collectors/types.js";
import type { Prisma } from "./generated/client.js";
import type { ImportSessionContext } from "./import-session-context.js";
import { advanceSessionSyncWatermark } from "./session-sync-watermark.js";

/** The session's claims and coverage, with the digest the sync source sends. */
export async function buildSessionOperationEvidence(
  session: NormalizedSession,
  harness: Harness,
  artifactRefs: readonly ArtifactRefRecord[]
): Promise<SessionOperationEvidence> {
  const { claims, coverage } = await extractOperationClaims(
    session,
    harness,
    gitWritesFromRefs(artifactRefs)
  );
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
        coverage,
        claims,
      })
    )
    .digest("hex");
  return {
    extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
    digest,
    coverage,
    claims,
  };
}

/**
 * Store the session's evidence unless the stored row already has its digest.
 * `claimsChanged` tells the caller whether the session owes a re-sync. With
 * no evidence (the attribution policy off) the session's row is deleted, so a
 * rebuild after the policy turns off clears what an earlier import stored.
 */
export async function importPhaseOperationClaims(
  tx: Prisma.TransactionClient,
  sessionId: string,
  evidence: SessionOperationEvidence | null,
  now: string
): Promise<{ claimsChanged: boolean }> {
  if (evidence === null) {
    const { count } = await tx.sessionOperationClaim.deleteMany({
      where: { sessionId },
    });
    return { claimsChanged: count > 0 };
  }
  const stored = await tx.sessionOperationClaim.findUnique({
    where: { sessionId },
    select: { digest: true },
  });
  if (stored?.digest === evidence.digest) {
    return { claimsChanged: false };
  }
  const row = {
    extractorVersion: evidence.extractorVersion,
    digest: evidence.digest,
    coverage: JSON.stringify(evidence.coverage),
    claims: JSON.stringify(evidence.claims),
    updatedAt: now,
  };
  await tx.sessionOperationClaim.upsert({
    where: { sessionId },
    create: { sessionId, ...row },
    update: row,
    select: { sessionId: true },
  });
  return { claimsChanged: true };
}

/** Commits are read by the claim extractor itself, so none are mapped here. */
const GIT_WRITE_ACTION_BY_METHOD: ReadonlyMap<string, GitWriteInput["action"]> =
  new Map([
    [MonitoredSessionCliRefMethod.GitPush, GitWriteAction.Push],
    [MonitoredSessionCliRefMethod.GhPrCreate, GitWriteAction.PullRequestCreate],
  ]);

const refEvidenceSchema = z
  .object({ toolIndex: z.number().int().nonnegative() })
  .loose();

/**
 * ISS-12552: the pushes and PR creates the artifact-ref extractor
 * found, as the write-to-commit join's input: each branch write names its
 * branch and, in its evidence, the tool call that made it.
 */
export function gitWritesFromRefs(
  refs: readonly ArtifactRefRecord[]
): GitWriteInput[] {
  return refs.flatMap((ref) => {
    const action = GIT_WRITE_ACTION_BY_METHOD.get(ref.method);
    const toolIndex = parseEvidence(ref.evidence)?.toolIndex;
    return ref.targetKind === ArtifactRefTargetKind.Branch &&
      ref.relation === ArtifactRefRelation.Created &&
      ref.branchName &&
      action !== undefined &&
      toolIndex !== undefined
      ? [{ toolIndex, branch: ref.branchName, action }]
      : [];
  });
}

function parseEvidence(evidence: string): { toolIndex: number } | undefined {
  try {
    return refEvidenceSchema.safeParse(JSON.parse(evidence)).data;
  } catch {
    return undefined;
  }
}

/**
 * ISS-12552 (PRD-800 "Rollout"): the session's evidence under the policy
 * it was parsed under, or `null` with the attribution policy off, when no
 * claim is extracted and none is kept.
 */
export function buildPolicyOperationEvidence(
  ctx: ImportSessionContext
): Promise<SessionOperationEvidence | null> {
  if (!ctx.parsePolicy.attributionEvidence) {
    return Promise.resolve(null);
  }
  return buildSessionOperationEvidence(
    ctx.session,
    ctx.harness,
    ctx.linkedArtifactRefs
  );
}

/**
 * ISS-12552 (PRD-800 "Rollout"): what a session stamped under the base
 * policy without a re-import must not keep: its operation claims and its
 * token-event owners. Advances the sync watermark when anything changed.
 */
export async function clearSessionAttributionEvidence(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string
): Promise<boolean> {
  const { count } = await tx.sessionOperationClaim.deleteMany({
    where: { sessionId },
  });
  const owners = await tx.$executeRawUnsafe(
    "UPDATE token_events SET agent_id = NULL WHERE session_id = $1 AND agent_id IS NOT NULL",
    sessionId
  );
  const changed = count > 0 || Number(owners) > 0;
  if (changed) {
    await advanceSessionSyncWatermark(tx, sessionId, now);
  }
  return changed;
}
