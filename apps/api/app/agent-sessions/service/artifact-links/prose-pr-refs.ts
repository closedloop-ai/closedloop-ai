import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
/**
 * @file prose-pr-refs.ts
 * @description ISS-5823: turn the PR references the desktop extractor read out
 * of assistant PROSE (ISS-5764) into session→PR refs the link lane can persist,
 * under a WEAK link kind that no metric- or cost-bearing reader picks up.
 *
 * Derived on the CLOUD from `artifactRefs`, deliberately, rather than by adding
 * a field to the `prRefs` wire array:
 *
 *  1. **No version skew.** A prose `pull_request` artifactRef already carries its
 *     `method` and has shipped since ISS-5764, so every already-installed desktop
 *     build is a complete producer for this. Widening the `prRefs` wire contract
 *     instead would mean an OLD cloud, which strips unknown keys, persisting the
 *     same refs under the STRONG kind — i.e. the exact metric corruption this
 *     ticket exists to prevent, on the one deploy ordering nobody controls.
 *  2. **`prRefs` stays the adjudicating carrier.** Every non-`CREATED` entry in
 *     that array ADJUDICATES its PR number for
 *     `resolveSessionPrAdmissionIdentity`, so a mention placed there would flip a
 *     genuinely authored PR from "unadjudicated → KEEP" to "adjudicated, not
 *     authored → REJECT" — see `PROSE_MENTION_REF_METHODS`. Deriving here leaves
 *     that invariant, and the desktop Local lane that shares it, untouched.
 */
import {
  ArtifactRefTargetKind,
  PROSE_MENTION_REF_METHODS,
  SessionPrRelationType,
  type SyncedArtifactRef,
  type SyncedSessionPrRef,
  sessionPrIdentityKey,
} from "@repo/api/src/types/session-artifact-link";

/**
 * A session→PR ref plus the `ArtifactRefMethod` that produced it. The wire type
 * carries no method (see the file header); the cloud stamps one on the refs it
 * derives so the persist lane can mark the identity and choose the link kind.
 */
export type SessionPrRefWithMethod = SyncedSessionPrRef & { method?: string };

/**
 * The prose-derived session→PR refs in `artifactRefs`, minus any identity
 * `commandDerivedRefs` already declares.
 *
 * The subtraction is not an optimization. Both arrays feed one per-branch
 * aggregation, so an identity present in both would merge into a single
 * persisted ref, and whichever `method` landed last would decide whether a
 * command-derived PR counts. Dropping the weak twin makes strong evidence win by
 * construction instead of by ordering.
 */
export function proseDerivedSessionPrRefs(
  artifactRefs: readonly SyncedArtifactRef[] | undefined,
  commandDerivedRefs: readonly SyncedSessionPrRef[] | undefined
): SessionPrRefWithMethod[] {
  if (!artifactRefs || artifactRefs.length === 0) {
    return [];
  }
  const claimed = new Set(
    (commandDerivedRefs ?? []).map((ref) =>
      sessionPrIdentityKey(ref.repositoryFullName, ref.prNumber)
    )
  );
  const byIdentity = new Map<string, SessionPrRefWithMethod>();
  for (const ref of artifactRefs) {
    if (
      ref.kind !== ArtifactRefTargetKind.PullRequest ||
      !PROSE_MENTION_REF_METHODS.has(ref.method)
    ) {
      continue;
    }
    const identity = sessionPrIdentityKey(ref.repositoryFullName, ref.prNumber);
    if (claimed.has(identity) || byIdentity.has(identity)) {
      continue;
    }
    byIdentity.set(identity, {
      repositoryFullName: ref.repositoryFullName,
      prNumber: ref.prNumber,
      // A mention is never authorship — the extractor mints these `referenced`
      // and this lane must not upgrade them.
      relationType: SessionPrRelationType.Referenced,
      method: ref.method,
    });
  }
  return [...byIdentity.values()];
}

export function withProseDerivedPrRefs(
  session: SyncedAgentSession
): SessionPrRefWithMethod[] | undefined {
  if (session.prRefs === undefined) {
    return undefined;
  }
  return [
    ...session.prRefs,
    ...proseDerivedSessionPrRefs(session.artifactRefs, session.prRefs),
  ];
}
