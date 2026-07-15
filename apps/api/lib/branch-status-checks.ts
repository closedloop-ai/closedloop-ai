import { mapNullableRollupStateToChecksStatus } from "@repo/api/src/github-checks-status";
import type {
  BranchViewCheck,
  BranchViewCheckProjection,
  BranchViewChecksProviderState as BranchViewChecksProviderStateValue,
} from "@repo/api/src/types/branch-view";
import {
  BranchViewCheckKind,
  BranchViewChecksProviderState,
} from "@repo/api/src/types/branch-view";
import type { StatusCheckRollupFailureReason } from "@repo/api/src/types/github";
import { StatusCheckRollupFailureReason as StatusCheckRollupFailureReasonValue } from "@repo/api/src/types/github";
import { Prisma, type TransactionClient } from "@repo/database";
import type {
  StatusCheckRollupCheck,
  StatusCheckRollupResult,
} from "@repo/github";
import { getCheckRunRetryResetData } from "@/lib/branch-status-check-retry";
import {
  type GitHubFetchProvenance,
  gitHubFetchProvenanceData,
} from "@/lib/github-fetch-provenance";

type PersistBranchStatusChecksInput = {
  branchArtifactId: string;
  organizationId: string;
  headSha: string;
  rollup: StatusCheckRollupResult;
  fetchProvenance?: GitHubFetchProvenance;
};

export type PersistBranchStatusChecksResult =
  | {
      status: "updated";
      checksStatusChanged: boolean;
      previousChecksStatus: string | null;
      nextChecksStatus: string | null;
    }
  | { status: "skipped"; reason: "missing_or_stale_branch" };

type BranchStatusChecksProjectionInput = {
  artifactId: string;
  headSha: string | null;
  checksDetailHeadSha: string | null;
  checksDetailTotalCount: number;
  checksDetailTruncated: boolean;
  checksDetailProviderState: string | null;
  checksDetailUnavailableReason: string | null;
  checksDetailUpdatedAt: Date | null;
  statusChecks?: BranchStatusCheckRow[];
};

type BranchStatusCheckRow = {
  providerKey: string;
  headSha: string;
  kind: string;
  name: string;
  status: string | null;
  conclusion: string | null;
  targetUrl: string | null;
  position: number;
};

/**
 * Persist a current-head provider rollup into BranchDetail metadata and bounded
 * BranchStatusCheck rows. The transaction re-reads the branch by org and head
 * so stale webhook/sync writers cannot publish previous-commit details.
 */
export async function persistBranchStatusChecksFromRollup(
  tx: TransactionClient,
  input: PersistBranchStatusChecksInput
): Promise<PersistBranchStatusChecksResult> {
  const branch = await tx.branchDetail.findFirst({
    where: {
      artifactId: input.branchArtifactId,
      artifact: { organizationId: input.organizationId },
      deletedAt: null,
      headSha: input.headSha,
    },
    select: { artifactId: true, checksStatus: true },
  });
  if (!branch) {
    return { status: "skipped", reason: "missing_or_stale_branch" };
  }

  if (!input.rollup.ok) {
    const fetchProvenance = gitHubFetchProvenanceData(input.fetchProvenance);
    const update = await tx.branchDetail.updateMany({
      where: guardedCurrentHeadWhere(input),
      data: {
        checksDetailHeadSha: input.headSha,
        checksDetailProviderState:
          BranchViewChecksProviderState.ProviderUnavailable,
        checksDetailUnavailableReason: input.rollup.reason,
        checksDetailUpdatedAt: new Date(),
        ...fetchProvenance,
      },
    });
    if (update.count === 0) {
      return { status: "skipped", reason: "missing_or_stale_branch" };
    }
    return {
      status: "updated",
      checksStatusChanged: false,
      previousChecksStatus: branch.checksStatus,
      nextChecksStatus: null,
    };
  }

  const nextChecksStatus = mapNullableRollupStateToChecksStatus(
    input.rollup.state
  );
  const providerState =
    input.rollup.state === null && input.rollup.checks.length === 0
      ? BranchViewChecksProviderState.NoChecks
      : BranchViewChecksProviderState.Available;
  const providerKeys = input.rollup.checks.map((check) => check.id);
  const fetchProvenance = gitHubFetchProvenanceData(input.fetchProvenance);

  const update = await tx.branchDetail.updateMany({
    where: guardedCurrentHeadWhere(input),
    data: {
      checksStatus: nextChecksStatus,
      checksDetailHeadSha: input.headSha,
      checksDetailTotalCount: input.rollup.totalCount,
      checksDetailTruncated: input.rollup.truncated,
      checksDetailProviderState: providerState,
      checksDetailUnavailableReason: null,
      checksDetailUpdatedAt: new Date(),
      ...fetchProvenance,
    },
  });
  if (update.count === 0) {
    return { status: "skipped", reason: "missing_or_stale_branch" };
  }

  await tx.branchStatusCheck.deleteMany({
    where: {
      branchArtifactId: input.branchArtifactId,
      headSha: input.headSha,
      providerKey: { notIn: providerKeys.length > 0 ? providerKeys : [""] },
    },
  });
  await upsertStatusChecks(
    tx,
    input.branchArtifactId,
    input.headSha,
    input.rollup.checks,
    input.fetchProvenance
  );

  return {
    status: "updated",
    checksStatusChanged: branch.checksStatus !== nextChecksStatus,
    previousChecksStatus: branch.checksStatus,
    nextChecksStatus,
  };
}

function guardedCurrentHeadWhere(input: PersistBranchStatusChecksInput) {
  return {
    artifact: { organizationId: input.organizationId },
    artifactId: input.branchArtifactId,
    deletedAt: null,
    headSha: input.headSha,
  };
}

/**
 * Clear current-head check details when an accepted branch head transition
 * occurs. Callers should run this in the same transaction as the head update.
 */
export async function invalidateBranchStatusChecksForHeadChange(
  tx: TransactionClient,
  branchArtifactId: string
): Promise<void> {
  await tx.branchStatusCheck.deleteMany({ where: { branchArtifactId } });
  await tx.branchDetail.update({
    where: { artifactId: branchArtifactId },
    data: getBranchStatusChecksResetData(),
  });
}

/**
 * Return the metadata reset patch for callers already updating BranchDetail in
 * the same write statement.
 */
export function getBranchStatusChecksResetData() {
  return {
    checksDetailHeadSha: null,
    checksDetailTotalCount: 0,
    checksDetailTruncated: false,
    checksDetailProviderState: null,
    checksDetailUnavailableReason: null,
    checksDetailUpdatedAt: null,
    ...getCheckRunRetryResetData(),
  };
}

/** Project persisted current-head check details into the Branch View API. */
export function projectBranchStatusChecks(
  branch: BranchStatusChecksProjectionInput
): BranchViewCheckProjection | undefined {
  if (
    !(
      branch.headSha &&
      branch.checksDetailHeadSha &&
      branch.checksDetailUpdatedAt &&
      branch.checksDetailHeadSha === branch.headSha
    )
  ) {
    return undefined;
  }

  const providerState = normalizeProviderState(
    branch.checksDetailProviderState
  );
  if (!providerState) {
    return undefined;
  }

  return {
    headSha: branch.checksDetailHeadSha,
    providerState,
    unavailableReason:
      providerState === BranchViewChecksProviderState.ProviderUnavailable
        ? normalizeFailureReason(branch.checksDetailUnavailableReason)
        : null,
    totalCount: branch.checksDetailTotalCount,
    truncated: branch.checksDetailTruncated,
    items:
      providerState === BranchViewChecksProviderState.ProviderUnavailable
        ? []
        : (branch.statusChecks ?? [])
            .filter(
              (row) =>
                row.headSha === branch.checksDetailHeadSha &&
                row.providerKey &&
                isKnownCheckKind(row.kind)
            )
            .sort((left, right) => left.position - right.position)
            .map(projectStatusCheckRow),
  };
}

async function upsertStatusChecks(
  tx: TransactionClient,
  branchArtifactId: string,
  headSha: string,
  checks: StatusCheckRollupCheck[],
  fetchProvenance: GitHubFetchProvenance | undefined
): Promise<void> {
  if (checks.length === 0) {
    return;
  }

  const provenance = gitHubFetchProvenanceData(fetchProvenance);
  const values = checks.map(
    (check) => Prisma.sql`(
      ${branchArtifactId}::uuid,
      ${headSha},
      ${check.id},
      ${check.kind},
      ${check.providerNodeId},
      ${check.name},
      ${check.status},
      ${check.conclusion},
      ${check.targetUrl},
      ${check.position},
      ${provenance.fetchCredentialType ?? null},
      ${provenance.fetchCredentialOwnerId ?? null}::uuid,
      ${provenance.fetchMechanism ?? null},
      ${provenance.fetchTrigger ?? null},
      ${provenance.fetchObservedAt ?? null},
      ${provenance.fetchResultReason ?? null},
      now(),
      now()
    )`
  );

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO branch_status_checks (
      branch_artifact_id,
      head_sha,
      provider_key,
      kind,
      provider_node_id,
      name,
      status,
      conclusion,
      target_url,
      position,
      fetch_credential_type,
      fetch_credential_owner_id,
      fetch_mechanism,
      fetch_trigger,
      fetch_observed_at,
      fetch_result_reason,
      created_at,
      updated_at
    )
    VALUES ${Prisma.join(values)}
    ON CONFLICT (branch_artifact_id, head_sha, provider_key)
    DO UPDATE SET
      kind = EXCLUDED.kind,
      provider_node_id = EXCLUDED.provider_node_id,
      name = EXCLUDED.name,
      status = EXCLUDED.status,
      conclusion = EXCLUDED.conclusion,
      target_url = EXCLUDED.target_url,
      position = EXCLUDED.position,
      fetch_credential_type = EXCLUDED.fetch_credential_type,
      fetch_credential_owner_id = EXCLUDED.fetch_credential_owner_id,
      fetch_mechanism = EXCLUDED.fetch_mechanism,
      fetch_trigger = EXCLUDED.fetch_trigger,
      fetch_observed_at = EXCLUDED.fetch_observed_at,
      fetch_result_reason = EXCLUDED.fetch_result_reason,
      updated_at = now()
  `);
}

function projectStatusCheckRow(row: BranchStatusCheckRow): BranchViewCheck {
  return {
    id: row.providerKey,
    kind:
      row.kind === BranchViewCheckKind.CheckRun
        ? BranchViewCheckKind.CheckRun
        : BranchViewCheckKind.StatusContext,
    name: row.name,
    status: row.status,
    conclusion: row.conclusion,
    targetUrl: sanitizeProjectedUrl(row.targetUrl),
  };
}

function isKnownCheckKind(value: string): boolean {
  return (
    value === BranchViewCheckKind.CheckRun ||
    value === BranchViewCheckKind.StatusContext
  );
}

export function normalizeProviderState(
  value: string | null
): BranchViewChecksProviderStateValue | null {
  if (
    value === BranchViewChecksProviderState.Available ||
    value === BranchViewChecksProviderState.NoChecks ||
    value === BranchViewChecksProviderState.ProviderUnavailable
  ) {
    return value;
  }
  return null;
}

export function normalizeFailureReason(
  value: string | null
): StatusCheckRollupFailureReason | null {
  if (
    value === StatusCheckRollupFailureReasonValue.InvalidInput ||
    value === StatusCheckRollupFailureReasonValue.RateLimited ||
    value === StatusCheckRollupFailureReasonValue.PermissionDenied ||
    value === StatusCheckRollupFailureReasonValue.GraphqlError
  ) {
    return value;
  }
  return null;
}

export function sanitizeProjectedUrl(value: string | null): string | null {
  if (!(value && value.length <= 2048)) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
