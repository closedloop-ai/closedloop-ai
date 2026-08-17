import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BranchCloudHydrationStatus,
  encodeBranchId,
} from "@repo/api/src/types/branch";
import {
  type NormalizedPersistedRepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import {
  eligibleBranchKeys,
  filterEligibleBranchRows,
  isEligibleBranchKey,
  resolveBranchDefaultEligibilitySnapshot,
} from "../src/main/branch/shared-branches-default-eligibility.js";
import {
  BranchDefaultEligibilityOutcome,
  BranchDefaultExclusionCause,
} from "../src/main/database/branch-default-eligibility.js";

const baseRepository = "acme/web";

test("legacy callers remain permissive only when no eligibility source exists", async () => {
  const rows = [
    { repoFullName: baseRepository, branchName: "feature" },
    { repoFullName: baseRepository, branchName: "feature" },
  ];
  const snapshot = await resolveBranchDefaultEligibilitySnapshot(
    rows,
    undefined,
    { scope: "list" }
  );

  assert.equal(snapshot, null);
  assert.deepEqual(filterEligibleBranchRows(rows, snapshot), rows);
  assert.equal(isEligibleBranchKey(rows[0]!, snapshot), true);
  assert.deepEqual(eligibleBranchKeys(rows, snapshot), [rows[0]]);
});

test("an empty candidate corpus resolves without calling the authority source", async () => {
  let resolveEligibilityInputsCalls = 0;
  const resolveEligibilityInputs = () => {
    resolveEligibilityInputsCalls += 1;
    return Promise.reject(
      new Error("empty corpora must not resolve authority")
    );
  };
  const snapshot = await resolveBranchDefaultEligibilitySnapshot(
    [],
    {
      resolveRepositoryDefaultEligibilityInputs: resolveEligibilityInputs,
    },
    { scope: "detail" }
  );

  assert.equal(resolveEligibilityInputsCalls, 0);
  assert.deepEqual([...snapshot!.eligibleBranchIds], []);
  assert.deepEqual([...snapshot!.exclusionsByKey], []);
  assert.equal(snapshot?.authoritative, true);
  assert.equal(snapshot?.coverageComplete, true);
});

test("one snapshot retains exact base, fork, malformed, and unavailable decisions", async () => {
  const rows = [
    { repoFullName: null, branchName: "missing-repository" },
    { repoFullName: baseRepository, branchName: "feature" },
    { repoFullName: baseRepository, branchName: "private-fork" },
    { repoFullName: baseRepository, branchName: "partial-fork" },
    { repoFullName: baseRepository, branchName: "fork-main" },
  ];
  const snapshot = await resolveBranchDefaultEligibilitySnapshot(
    rows,
    {
      resolveRepositoryDefaultEligibilityInputs: async () => ({
        status: BranchCloudHydrationStatus.Fresh,
        rowHydrationResult: { status: BranchCloudHydrationStatus.Fresh },
        authorities: [
          availableAuthority("base-id", baseRepository, "main"),
          availableAuthority("fork-id", "contributor/web", "fork-main"),
        ],
        overlays: {
          [`${baseRepository}::private-fork`]: {
            headRepositoryUnavailableReason:
              RepositoryDefaultReason.PermissionDenied,
          },
          [`${baseRepository}::partial-fork`]: {
            headRepositoryProvider: VcsProviderKind.GitHub,
          },
          [`${baseRepository}::fork-main`]: {
            headRepositoryProvider: VcsProviderKind.GitHub,
            headRepositoryProviderId: "fork-id",
            headRepositoryFullName: "contributor/web",
          },
        },
      }),
    },
    { forceRefresh: true, scope: "list" }
  );

  assert.ok(snapshot);
  assert.equal(snapshot.coverageComplete, false);
  assert.equal(isEligibleBranchKey(rows[1]!, snapshot), true);
  assert.deepEqual(
    filterEligibleBranchRows(rows, snapshot).map((row) => row.branchName),
    ["feature"]
  );
  assert.deepEqual(
    exclusion(snapshot, rows[0]!),
    unavailable(RepositoryDefaultReason.NotReported)
  );
  assert.deepEqual(
    exclusion(snapshot, rows[2]!),
    unavailable(RepositoryDefaultReason.PermissionDenied)
  );
  assert.deepEqual(
    exclusion(snapshot, rows[3]!),
    unavailable(RepositoryDefaultReason.Unknown)
  );
  const forkDefaultDecision = exclusion(snapshot, rows[4]!);
  assert.equal(
    forkDefaultDecision?.outcome,
    BranchDefaultEligibilityOutcome.Excluded
  );
  if (
    forkDefaultDecision?.outcome !== BranchDefaultEligibilityOutcome.Excluded
  ) {
    assert.fail("the authoritative fork default must be excluded");
  }
  assert.equal(
    forkDefaultDecision.cause,
    BranchDefaultExclusionCause.DefaultBranch
  );
});

test("legacy no-PR overlays use base authority while partial authority fails closed", async () => {
  const legacy = { repoFullName: baseRepository, branchName: "legacy-feature" };
  const unresolved = {
    repoFullName: "acme/partial",
    branchName: "feature",
  };
  const snapshot = await resolveBranchDefaultEligibilitySnapshot(
    [legacy, unresolved],
    {
      resolveRepositoryDefaultEligibilityInputs: async () => ({
        status: BranchCloudHydrationStatus.Fresh,
        rowHydrationResult: { status: BranchCloudHydrationStatus.Fresh },
        authorities: [
          availableAuthority("base-id", baseRepository, "main"),
          {
            repository: {
              provider: VcsProviderKind.GitHub,
              providerRepositoryId: "partial-id",
              fullName: "acme/partial",
            },
            evidence: {
              availability: RepositoryDefaultAvailability.Unavailable,
              completeness: RepositoryDefaultCompleteness.Partial,
              reason: RepositoryDefaultReason.Capped,
            },
          },
        ],
        overlays: {
          [`${baseRepository}::legacy-feature`]: { prNumber: null },
        },
      }),
    },
    { scope: "list" }
  );

  if (!snapshot) {
    assert.fail("an authority source must produce an eligibility snapshot");
  }
  assert.equal(isEligibleBranchKey(legacy, snapshot), true);
  assert.deepEqual(
    exclusion(snapshot, unresolved),
    unavailable(RepositoryDefaultReason.Capped)
  );
});

function availableAuthority(
  providerRepositoryId: string,
  fullName: string,
  defaultBranch: string
): NormalizedPersistedRepositoryDefaultAuthority {
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId,
      fullName,
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch,
    },
  };
}

function exclusion(
  snapshot: NonNullable<
    Awaited<ReturnType<typeof resolveBranchDefaultEligibilitySnapshot>>
  >,
  row: { repoFullName: string | null; branchName: string }
) {
  return snapshot.exclusionsByKey.get(encodeBranchId(row));
}

function unavailable(reason: RepositoryDefaultReason) {
  return {
    outcome: BranchDefaultEligibilityOutcome.Excluded,
    cause: BranchDefaultExclusionCause.AuthorityUnavailable,
    reason,
  };
}

// ISS-5987 — a snapshot that decided nothing must say so. Excluding every
// candidate because the authority was unavailable produces the same
// `eligibleBranchIds` as "every candidate is a default branch", and consumers
// that report over the survivors would otherwise describe an unqualified
// population as an empty one.
test("a non-Fresh authority status yields a NON-authoritative snapshot", async () => {
  const rows = [{ repoFullName: baseRepository, branchName: "feature" }];
  const snapshot = await resolveBranchDefaultEligibilitySnapshot(
    rows,
    {
      resolveRepositoryDefaultEligibilityInputs: () =>
        Promise.resolve({
          // What an operator with no connected GitHub credential actually hits.
          status: BranchCloudHydrationStatus.CredentialMissing,
          authorities: [],
        }),
    },
    { scope: "list" }
  );

  assert.equal(snapshot?.authoritative, false);
  assert.equal(snapshot?.coverageComplete, false);
  assert.deepEqual([...snapshot!.eligibleBranchIds], []);
  assert.deepEqual(
    exclusion(snapshot!, rows[0]!),
    unavailable(RepositoryDefaultReason.Unknown)
  );
  assert.throws(
    () => filterEligibleBranchRows(rows, snapshot!),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "repository default eligibility unavailable");
      return true;
    }
  );
});

test("a failed eligibility source preserves its provider-error reason", async () => {
  const rows = [{ repoFullName: baseRepository, branchName: "feature" }];
  const snapshot = await resolveBranchDefaultEligibilitySnapshot(
    rows,
    {
      resolveRepositoryDefaultEligibilityInputs: () =>
        Promise.resolve({
          status: BranchCloudHydrationStatus.Failed,
          failure: "repository_default_authority_read_failed",
          authorities: [],
        }),
    },
    { scope: "list" }
  );

  assert.deepEqual(
    exclusion(snapshot!, rows[0]!),
    unavailable(RepositoryDefaultReason.ProviderError)
  );
});

test("fresh candidate-scoped uncertainty cannot publish an exact empty cohort", async () => {
  const rows = [{ repoFullName: baseRepository, branchName: "feature" }];
  const snapshot = await resolveBranchDefaultEligibilitySnapshot(
    rows,
    {
      resolveRepositoryDefaultEligibilityInputs: () =>
        Promise.resolve({
          status: BranchCloudHydrationStatus.Fresh,
          rowHydrationResult: { status: BranchCloudHydrationStatus.Fresh },
          authorities: [],
        }),
    },
    { scope: "list" }
  );

  assert.equal(snapshot?.authoritative, true);
  assert.equal(snapshot?.coverageComplete, false);
  assert.throws(() => filterEligibleBranchRows(rows, snapshot), {
    message: "repository default eligibility unavailable",
  });
});

test("a Fresh authority status yields an authoritative snapshot", async () => {
  const rows = [{ repoFullName: baseRepository, branchName: "feature" }];
  const rowHydrationResult = {
    status: BranchCloudHydrationStatus.Fresh,
  } as const;
  const snapshot = await resolveBranchDefaultEligibilitySnapshot(
    rows,
    {
      resolveRepositoryDefaultEligibilityInputs: () =>
        Promise.resolve({
          status: BranchCloudHydrationStatus.Fresh,
          rowHydrationResult,
          authorities: [availableAuthority("1", baseRepository, "main")],
        }),
    },
    { scope: "list" }
  );

  assert.equal(snapshot?.authoritative, true);
  assert.equal(snapshot?.coverageComplete, true);
  assert.equal(snapshot?.resolvedHydration, rowHydrationResult);
  assert.deepEqual(
    [...snapshot!.eligibleBranchIds],
    [encodeBranchId(rows[0]!)]
  );
});

test("eligibility readiness retains known siblings while enrichment remains failed", async () => {
  const known = { repoFullName: baseRepository, branchName: "feature" };
  const unresolved = {
    repoFullName: "acme/unavailable",
    branchName: "feature",
  };
  const snapshot = await resolveBranchDefaultEligibilitySnapshot(
    [known, unresolved],
    {
      resolveRepositoryDefaultEligibilityInputs: () =>
        Promise.resolve({
          status: BranchCloudHydrationStatus.Failed,
          eligibilityStatus: BranchCloudHydrationStatus.Fresh,
          failure: "cloud_pull_failed",
          pullRequestIncompleteReasons: {
            [baseRepository]: RepositoryDefaultReason.ProviderError,
          },
          authorities: [availableAuthority("base-id", baseRepository, "main")],
        }),
    },
    { scope: "list" }
  );

  assert.equal(snapshot?.authoritative, true);
  assert.equal(snapshot?.coverageComplete, false);
  assert.equal(snapshot?.pullRequestCoverageComplete, false);
  assert.equal(snapshot?.resolvedHydration, undefined);
  assert.deepEqual(filterEligibleBranchRows([known, unresolved], snapshot), [
    known,
  ]);
  assert.deepEqual(eligibleBranchKeys([known, unresolved], snapshot), [known]);
});
