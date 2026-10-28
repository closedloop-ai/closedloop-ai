import type { TransactionClient } from "@repo/database";
import { lockBranchRetryIdentities } from "./branch-materialization-retry";
import { BranchMaterializationRetryReason } from "./branch-materialization-retry-policy";
import type { BranchRefAggregate } from "./branch-ref-aggregate";

export async function deleteBranchMaterializationRetriesForAggregatesTx(
  tx: TransactionClient,
  input: {
    organizationId: string;
    sourceArtifactId: string;
    aggregates: readonly BranchRefAggregate[];
  }
): Promise<void> {
  const aggregates = input.aggregates.filter(
    (aggregate) =>
      aggregate.repositoryFullName.trim().length > 0 &&
      aggregate.branchName.trim().length > 0
  );
  if (aggregates.length === 0) {
    return;
  }
  await lockBranchRetryIdentities(
    tx,
    aggregates.map((aggregate) => ({
      organizationId: input.organizationId,
      sourceArtifactId: input.sourceArtifactId,
      aggregate,
      reason: BranchMaterializationRetryReason.AuthorityUnavailable,
    }))
  );
  await tx.$executeRaw`
    DELETE FROM branch_materialization_retries AS retry
    USING unnest(${aggregates.map((row) => row.repositoryFullName)}::text[], ${aggregates.map((row) => row.branchName)}::text[]) AS incoming(repository_full_name, branch_name)
    WHERE retry.organization_id = ${input.organizationId}::uuid
      AND retry.source_artifact_id = ${input.sourceArtifactId}::uuid
      AND retry.repository_full_name = incoming.repository_full_name
      AND retry.branch_name = incoming.branch_name
  `;
}
