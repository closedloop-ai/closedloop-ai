/**
 * @file component-invocation-artifact-link-attribution.ts
 * @description The branch/repository attribution an invocation takes from the
 * session's own `session_artifact_links` rows.
 *
 * Split out of `component-invocations.ts` (grandfathered shrink-only under the
 * root AGENTS.md line-count contract) when ISS-11238 added the code-review
 * findings stamp beside it: this is the same shape of concern — a whole
 * candidate set, enriched from evidence the derivation itself cannot see —
 * so it belongs in its own module rather than inside the materializer.
 *
 * THE WINNER IS THE LATEST LINK AT OR BEFORE THE INVOCATION. A link observed
 * AFTER the invocation ran cannot describe the branch it ran on, and ties are
 * broken by `identityKey` so a session with two links at one instant resolves
 * the same way on every re-import.
 */

import type { AgentComponentInvocationCandidate } from "./component-invocation-row-writer.js";
import { BRANCH_WRITE_METHOD_VALUES, sqlStringList } from "./db-constants.js";
import type { Prisma } from "./generated/client.js";

type InvocationArtifactAttribution = {
  branchName: string;
  identityKey: string;
  repositoryFullName: string | null;
  observedAt: string;
};

export function loadInvocationArtifactAttributions(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<InvocationArtifactAttribution[]> {
  return tx.$queryRawUnsafe<InvocationArtifactAttribution[]>(
    `SELECT a.branch_name AS "branchName",
            a.identity_key AS "identityKey",
            a.repo_full_name AS "repositoryFullName",
            sal.observed_at AS "observedAt"
       FROM session_artifact_links sal
       JOIN artifacts a ON a.id = sal.artifact_id
      WHERE sal.session_id = $1
        AND sal.relation = 'created'
        AND sal.method IN (${sqlStringList(BRANCH_WRITE_METHOD_VALUES)})
        AND a.kind = 'branch'
        AND a.branch_name IS NOT NULL
      ORDER BY sal.observed_at ASC, a.identity_key ASC`,
    sessionId
  );
}

export function applyArtifactLinkAttribution(
  candidates: AgentComponentInvocationCandidate[],
  attributions: readonly InvocationArtifactAttribution[]
): void {
  for (const candidate of candidates) {
    const invokedAtMs = parseFiniteTimestamp(candidate.invokedAt);
    let attribution: InvocationArtifactAttribution | null = null;
    let attributionObservedAtMs = Number.NEGATIVE_INFINITY;
    for (const entry of attributions) {
      const observedAtMs = parseFiniteTimestamp(entry.observedAt);
      if (
        invokedAtMs === null ||
        observedAtMs === null ||
        observedAtMs > invokedAtMs ||
        observedAtMs < attributionObservedAtMs
      ) {
        continue;
      }
      if (
        observedAtMs === attributionObservedAtMs &&
        attribution &&
        entry.identityKey <= attribution.identityKey
      ) {
        continue;
      }
      attribution = entry;
      attributionObservedAtMs = observedAtMs;
    }
    candidate.gitBranch = attribution?.branchName ?? null;
    candidate.repositoryFullName = attribution?.repositoryFullName ?? null;
  }
}

function parseFiniteTimestamp(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
