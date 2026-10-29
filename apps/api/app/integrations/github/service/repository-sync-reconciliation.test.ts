/**
 * `bulkUpsertInstallationRepositories`'s in-memory dedup/reconciliation of
 * duplicate `githubRepoId` entries within a single sync/add call
 * (`dedupeRepositoryInputs`, `reconcileDuplicateRepositoryInput`,
 * `reconcileDifferentTimeRepositoryInput`, `chooseDeterministicAuthority`),
 * plus the write-diagnostics `continue` guard in
 * `emitRepositoryAuthorityWriteDiagnostics`. `service-repository-sync.test.ts`
 * exercises the sync/add entry points through `githubService`; this file
 * drives `bulkUpsertInstallationRepositories` directly with a fake
 * `TransactionClient` so the ISS-4618 reconciliation branches — none of which
 * are reachable without two inputs sharing a `githubRepoId` — are covered
 * without going through a real GitHub sync flow.
 *
 * The real `@repo/database` `Prisma.sql`/`Prisma.join` are used (not mocked):
 * they flatten into one `values` array in bind order, so the row's own 19
 * binds are always `values[0..18]` regardless of how large the surrounding
 * `ON CONFLICT` clause is. `repository-authority.test.ts` establishes this
 * same pattern for the write-diagnostics branches.
 */

import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import type { RepositoryDefaultAuthority } from "@repo/api/src/types/repository-default-identity";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { describe, expect, it, vi } from "vitest";
import type { RepositoryInput } from "@/app/integrations/github/service/repository-sync";
import { bulkUpsertInstallationRepositories } from "@/app/integrations/github/service/repository-sync";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const INSTALLATION_ID = "install-1";

describe("bulkUpsertInstallationRepositories reconciliation", () => {
  it("carries the existing side's authority onto the incoming side's scalar fields when incoming has none", async () => {
    const { executeRaw } = await upsertDuplicate(
      repo(
        "acme/existing",
        buildAvailable("key-existing", "2026-01-01T00:00:00.000Z")
      ),
      repo("acme/incoming", undefined)
    );

    // ISS-4618 doc comment: "Omitted by legacy producers so their writes
    // preserve stored authority" — the later delivery's scalar fields win,
    // but its missing authority does not blank out the stored one.
    expect(rowBinds(executeRaw)).toMatchObject({
      fullName: "acme/incoming",
      observationKey: "key-existing",
      availability: RepositoryDefaultAvailability.Available,
    });
  });

  it("keeps the incoming side with no authority when neither delivery carries one", async () => {
    const { executeRaw } = await upsertDuplicate(
      repo("acme/existing", undefined),
      repo("acme/incoming", undefined)
    );

    expect(rowBinds(executeRaw)).toMatchObject({
      fullName: "acme/incoming",
      observationKey: null,
      availability: null,
      defaultBranchName: null,
      reason: null,
    });
  });

  it("adopts the incoming side's authority when the existing side has none", async () => {
    const { executeRaw } = await upsertDuplicate(
      repo("acme/existing", undefined),
      repo(
        "acme/incoming",
        buildUnavailable(
          "key-incoming",
          "2026-01-01T00:00:00.000Z",
          RepositoryDefaultReason.RateLimited
        )
      )
    );

    expect(rowBinds(executeRaw)).toMatchObject({
      fullName: "acme/incoming",
      observationKey: "key-incoming",
      availability: RepositoryDefaultAvailability.Unavailable,
      reason: RepositoryDefaultReason.RateLimited,
    });
  });

  it("treats an identical observationKey as a replay and keeps the existing row entirely", async () => {
    const { executeRaw } = await upsertDuplicate(
      repo(
        "acme/existing",
        buildAvailable("same-key", "2026-01-01T00:00:00.000Z", "main")
      ),
      repo(
        "acme/incoming",
        buildAvailable("same-key", "2026-01-02T00:00:00.000Z", "develop")
      )
    );

    // pins current behavior: an identical observationKey short-circuits to
    // the existing row wholesale, even though incoming carries a strictly
    // later observedAt and a different branch. observationKey equality is
    // the intended redelivery guard, so this looks odd only until you read it
    // as "same observation, ignore the redelivery" rather than "same time".
    expect(rowBinds(executeRaw)).toMatchObject({
      fullName: "acme/existing",
      observationKey: "same-key",
      defaultBranchName: "main",
    });
  });

  it("keeps the existing side when it already recorded a sticky conflict at the same observedAt", async () => {
    const { executeRaw } = await upsertDuplicate(
      repo(
        "acme/existing",
        buildUnavailable(
          "key-a",
          "2026-01-01T00:00:00.000Z",
          RepositoryDefaultReason.Conflicting
        )
      ),
      repo(
        "acme/incoming",
        buildUnavailable(
          "key-b",
          "2026-01-01T00:00:00.000Z",
          RepositoryDefaultReason.RateLimited
        )
      )
    );

    expect(rowBinds(executeRaw)).toMatchObject({
      fullName: "acme/existing",
      observationKey: "key-a",
      reason: RepositoryDefaultReason.Conflicting,
    });
  });

  it("breaks an equal-time tie between two unavailable observations toward the lexicographically larger observationKey", async () => {
    const { executeRaw } = await upsertDuplicate(
      repo(
        "acme/existing",
        buildUnavailable(
          "a-key",
          "2026-01-01T00:00:00.000Z",
          RepositoryDefaultReason.PermissionDenied
        )
      ),
      repo(
        "acme/incoming",
        buildUnavailable(
          "z-key",
          "2026-01-01T00:00:00.000Z",
          RepositoryDefaultReason.RateLimited
        )
      )
    );

    expect(rowBinds(executeRaw)).toMatchObject({
      fullName: "acme/incoming",
      observationKey: "z-key",
      reason: RepositoryDefaultReason.RateLimited,
    });
  });

  it("breaks an equal-time tie toward the existing side when its observationKey is lexicographically larger", async () => {
    const { executeRaw } = await upsertDuplicate(
      repo(
        "acme/existing",
        buildUnavailable(
          "z-key",
          "2026-01-01T00:00:00.000Z",
          RepositoryDefaultReason.PermissionDenied
        )
      ),
      repo(
        "acme/incoming",
        buildUnavailable(
          "a-key",
          "2026-01-01T00:00:00.000Z",
          RepositoryDefaultReason.RateLimited
        )
      )
    );

    expect(rowBinds(executeRaw)).toMatchObject({
      fullName: "acme/existing",
      observationKey: "z-key",
      reason: RepositoryDefaultReason.PermissionDenied,
    });
  });

  it("keeps an available existing side over an unavailable incoming side observed at the same time", async () => {
    const { executeRaw } = await upsertDuplicate(
      repo(
        "acme/existing",
        buildAvailable("a-key", "2026-01-01T00:00:00.000Z", "main")
      ),
      repo(
        "acme/incoming",
        buildUnavailable(
          "b-key",
          "2026-01-01T00:00:00.000Z",
          RepositoryDefaultReason.RateLimited
        )
      )
    );

    expect(rowBinds(executeRaw)).toMatchObject({
      fullName: "acme/existing",
      availability: RepositoryDefaultAvailability.Available,
      defaultBranchName: "main",
      observationKey: "a-key",
    });
  });

  it("adopts an available incoming side over an unavailable existing side observed at the same time", async () => {
    const { executeRaw } = await upsertDuplicate(
      repo(
        "acme/existing",
        buildUnavailable(
          "a-key",
          "2026-01-01T00:00:00.000Z",
          RepositoryDefaultReason.RateLimited
        )
      ),
      repo(
        "acme/incoming",
        buildAvailable("b-key", "2026-01-01T00:00:00.000Z", "develop")
      )
    );

    expect(rowBinds(executeRaw)).toMatchObject({
      fullName: "acme/incoming",
      availability: RepositoryDefaultAvailability.Available,
      defaultBranchName: "develop",
      observationKey: "b-key",
    });
  });

  it("collapses two same-time available observations naming different default branches into a sticky conflict", async () => {
    const { executeRaw } = await upsertDuplicate(
      repo(
        "acme/existing",
        buildAvailable("m-key", "2026-01-01T00:00:00.000Z", "main")
      ),
      repo(
        "acme/incoming",
        buildAvailable("z-key", "2026-01-01T00:00:00.000Z", "develop")
      )
    );

    expect(rowBinds(executeRaw)).toMatchObject({
      fullName: "acme/incoming",
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Unavailable,
      reason: RepositoryDefaultReason.Conflicting,
      defaultBranchName: null,
      observationKey: "z-key",
    });
  });

  it("keeps the earlier existing side outright when the incoming observation is strictly older", async () => {
    const { executeRaw } = await upsertDuplicate(
      repo(
        "acme/existing",
        buildAvailable("a-key", "2026-02-01T00:00:00.000Z", "main")
      ),
      repo(
        "acme/incoming",
        buildAvailable("b-key", "2026-01-01T00:00:00.000Z", "develop")
      )
    );

    expect(rowBinds(executeRaw)).toMatchObject({
      fullName: "acme/existing",
      observationKey: "a-key",
      defaultBranchName: "main",
    });
  });

  it("adopts a newer incoming observation outright when the existing side was not available", async () => {
    const { executeRaw } = await upsertDuplicate(
      repo(
        "acme/existing",
        buildUnavailable(
          "a-key",
          "2026-01-01T00:00:00.000Z",
          RepositoryDefaultReason.ProviderError
        )
      ),
      repo(
        "acme/incoming",
        buildUnavailable(
          "b-key",
          "2026-01-02T00:00:00.000Z",
          RepositoryDefaultReason.RateLimited
        )
      )
    );

    expect(rowBinds(executeRaw)).toMatchObject({
      fullName: "acme/incoming",
      observationKey: "b-key",
      reason: RepositoryDefaultReason.RateLimited,
    });
  });

  it("adopts a newer incoming observation outright when it is itself available", async () => {
    const { executeRaw } = await upsertDuplicate(
      repo(
        "acme/existing",
        buildAvailable("a-key", "2026-01-01T00:00:00.000Z", "main")
      ),
      repo(
        "acme/incoming",
        buildAvailable("b-key", "2026-01-02T00:00:00.000Z", "develop")
      )
    );

    expect(rowBinds(executeRaw)).toMatchObject({
      fullName: "acme/incoming",
      availability: RepositoryDefaultAvailability.Available,
      defaultBranchName: "develop",
      observationKey: "b-key",
    });
  });

  it("demotes a newer but unavailable incoming observation to stale, keeping the existing default branch", async () => {
    const { executeRaw } = await upsertDuplicate(
      repo(
        "acme/existing",
        buildAvailable("a-key", "2026-01-01T00:00:00.000Z", "main")
      ),
      repo(
        "acme/incoming",
        buildUnavailable(
          "b-key",
          "2026-01-02T00:00:00.000Z",
          RepositoryDefaultReason.PermissionDenied
        )
      )
    );

    expect(rowBinds(executeRaw)).toMatchObject({
      fullName: "acme/incoming",
      availability: RepositoryDefaultAvailability.Stale,
      completeness: RepositoryDefaultCompleteness.Partial,
      defaultBranchName: "main",
      reason: RepositoryDefaultReason.PermissionDenied,
      observationKey: "b-key",
    });
  });

  it("falls back to a provider-error reason when a stale-demoted incoming observation carries no reason at all", async () => {
    const incomingAuthority = buildUnavailable(
      "b-key",
      "2026-01-02T00:00:00.000Z",
      RepositoryDefaultReason.PermissionDenied
    );
    // Every non-Available evidence variant is typed to always carry `reason`,
    // so reaching this fallback requires simulating a legacy/malformed group
    // that slipped past the type at a boundary this function does not
    // re-validate — the same class of "reachable at runtime, forbidden by
    // the type" input the repo's malformed-input rule expects covered.
    Reflect.deleteProperty(incomingAuthority.evidence as object, "reason");

    const { executeRaw } = await upsertDuplicate(
      repo(
        "acme/existing",
        buildAvailable("a-key", "2026-01-01T00:00:00.000Z", "main")
      ),
      repo("acme/incoming", incomingAuthority)
    );

    expect(rowBinds(executeRaw)).toMatchObject({
      fullName: "acme/incoming",
      availability: RepositoryDefaultAvailability.Stale,
      defaultBranchName: "main",
      reason: RepositoryDefaultReason.ProviderError,
    });
  });

  it("skips write-diagnostic logging for authority repos with no matching persisted row or no recorded observedAt", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(2),
      $queryRaw: vi.fn().mockResolvedValue([
        {
          githubRepoId: "diag-null-observed",
          defaultBranchObservedAt: null,
          defaultBranchReason: null,
        },
        // "diag-missing" is intentionally absent from the query result.
      ]),
    };
    const { log } = await import("@repo/observability/log");

    await bulkUpsertInstallationRepositories(tx as never, INSTALLATION_ID, [
      repo(
        "acme/missing",
        buildAvailable("key-x", "2026-01-01T00:00:00.000Z"),
        "diag-missing"
      ),
      repo(
        "acme/null-observed",
        buildAvailable("key-y", "2026-01-01T00:00:00.000Z"),
        "diag-null-observed"
      ),
    ]);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalledWith(
      "github_repository_default_authority_stale_rejected",
      expect.anything()
    );
    expect(log.error).not.toHaveBeenCalledWith(
      "github_repository_default_authority_conflict",
      expect.anything()
    );
  });
});

function repo(
  fullName: string,
  defaultAuthority: RepositoryDefaultAuthority | undefined,
  githubRepoId = "dup-1"
): RepositoryInput {
  return {
    githubRepoId,
    fullName,
    name: fullName.split("/").at(-1) ?? fullName,
    owner: "acme",
    private: false,
    defaultAuthority,
  };
}

async function upsertDuplicate(
  existing: RepositoryInput,
  incoming: RepositoryInput
): Promise<{
  executeRaw: ReturnType<typeof vi.fn>;
}> {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  await bulkUpsertInstallationRepositories(tx as never, INSTALLATION_ID, [
    existing,
    incoming,
  ]);
  return { executeRaw: tx.$executeRaw };
}

function buildAvailable(
  observationKey: string,
  observedAt: string,
  defaultBranch = "main"
): RepositoryDefaultAuthority {
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: "dup-1",
      fullName: "acme/dup-1",
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch,
    },
    provenance: {
      source: RepositoryDefaultSource.InstallationRepositoriesRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey,
      observedAt,
    },
  };
}

function buildUnavailable(
  observationKey: string,
  observedAt: string,
  reason: RepositoryDefaultReason
): RepositoryDefaultAuthority {
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: "dup-1",
      fullName: "acme/dup-1",
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Unavailable,
      reason,
    },
    provenance: {
      source: RepositoryDefaultSource.InstallationRepositoriesRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey,
      observedAt,
    },
  };
}

const ROW_FULL_NAME_BIND = 3;
const ROW_DEFAULT_BRANCH_NAME_BIND = 7;
const ROW_AVAILABILITY_BIND = 8;
const ROW_COMPLETENESS_BIND = 9;
const ROW_REASON_BIND = 10;
const ROW_OBSERVATION_KEY_BIND = 16;

function rowBinds(executeRaw: ReturnType<typeof vi.fn>): {
  fullName: unknown;
  defaultBranchName: unknown;
  availability: unknown;
  completeness: unknown;
  reason: unknown;
  observationKey: unknown;
} {
  const statement = executeRaw.mock.calls.at(0)?.[0] as {
    values: unknown[];
  };
  const values = statement.values;
  return {
    fullName: values[ROW_FULL_NAME_BIND],
    defaultBranchName: values[ROW_DEFAULT_BRANCH_NAME_BIND],
    availability: values[ROW_AVAILABILITY_BIND],
    completeness: values[ROW_COMPLETENESS_BIND],
    reason: values[ROW_REASON_BIND],
    observationKey: values[ROW_OBSERVATION_KEY_BIND],
  };
}
