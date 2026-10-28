import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import type {
  SyncedArtifactRef,
  SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import { isValidPullRequestNumber } from "@repo/api/src/types/session-artifact-link";
import { acquirePullRequestProviderIdentityLocksInTransaction } from "@/app/branches/pull-request-provider-lock";
import type { AgentSessionUpsertTx } from "../records";
import { collectProviderVerifiablePullRequestRefs } from "./shared";

/**
 * Acquire every provider-verifiable PR lock carried by one Session before any
 * PR activity or Session-edge lock is taken. Repeated acquisition in the same
 * transaction is harmless and protects direct lane callers too.
 */
export function acquireSessionPullRequestProviderLocks(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    artifactRefs?: SyncedArtifactRef[];
    prRefs?: SyncedSessionPrRef[];
  }
): Promise<void> {
  const identities = [
    ...collectProviderVerifiablePullRequestRefs(input.artifactRefs),
    ...(input.prRefs ?? []),
  ]
    .filter((ref) => isValidPullRequestNumber(ref.prNumber))
    .map((ref) => ({
      organizationId: input.organizationId,
      repositoryFullName: normalizeRepoFullName(ref.repositoryFullName),
      number: ref.prNumber,
    }));
  return acquirePullRequestProviderIdentityLocksInTransaction(tx, identities);
}
