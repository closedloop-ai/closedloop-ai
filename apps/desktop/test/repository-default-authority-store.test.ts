import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  type RepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import {
  MAX_REPOSITORY_DEFAULT_AUTHORITY_BATCH_SIZE,
  readRepositoryDefaultAuthorities,
  writeRepositoryDefaultAuthorities,
} from "../src/main/database/repository-default-authority-store.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeRecordingQueue, openTestPrisma } from "./prisma-test-utils.js";

const tempDirs: string[] = [];
const OBSERVED_AT = "2026-08-11T01:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

test("stores canonical custom and fork defaults under qualified identities only", async () => {
  const queue = makeRecordingQueue();
  const database = await openTestPrisma(queue);
  try {
    await database.prisma.write((client) =>
      client.repo.create({
        data: {
          id: "local-repo",
          gitDir: "/synthetic/acme-web",
          repoFullName: "acme/web",
          defaultBranch: "local-only",
          createdAt: OBSERVED_AT,
          lastSeenAt: OBSERVED_AT,
        },
      })
    );
    const beforeStoreWrites = queue.runs;

    const result = await writeRepositoryDefaultAuthorities(
      database.prisma,
      "account-a",
      [
        availableAuthority("repo-acme", "Acme/Web", "trunk"),
        availableAuthority("repo-customer", "customer/web", "develop"),
        availableAuthority("repo-fork", "contributor/web", "fork-default"),
        availableAuthority("repo-gitlab", "acme/web", "gitlab-default", {
          provider: VcsProviderKind.GitLab,
        }),
      ]
    );

    assert.deepEqual(result, { accepted: 4, skipped: 0 });
    assert.equal(queue.runs, beforeStoreWrites + 1);
    const accountRows = await readRepositoryDefaultAuthorities(
      database.prisma,
      "account-a",
      [
        readIdentity("repo-acme"),
        readIdentity("repo-customer"),
        readIdentity("repo-fork"),
        readIdentity("repo-gitlab", VcsProviderKind.GitLab),
      ]
    );
    assert.deepEqual(
      accountRows.map((row) => [
        row.repository.provider,
        row.repository.providerRepositoryId,
        row.repository.fullName,
        "defaultBranch" in row.evidence
          ? row.evidence.defaultBranch
          : undefined,
      ]),
      [
        [VcsProviderKind.GitHub, "repo-acme", "acme/web", "trunk"],
        [VcsProviderKind.GitHub, "repo-customer", "customer/web", "develop"],
        [
          VcsProviderKind.GitHub,
          "repo-fork",
          "contributor/web",
          "fork-default",
        ],
        [VcsProviderKind.GitLab, "repo-gitlab", "acme/web", "gitlab-default"],
      ]
    );
    assert.deepEqual(
      await readRepositoryDefaultAuthorities(database.prisma, "account-b", [
        readIdentity("repo-acme"),
      ]),
      []
    );
    assert.equal(
      (
        await database.prisma.client.repo.findUniqueOrThrow({
          where: { id: "local-repo" },
        })
      ).defaultBranch,
      "local-only"
    );
  } finally {
    await database.close();
  }
});

test("orders by observedAt, preserves eventAt, and does not churn exact replays", async () => {
  const database = await openTestPrisma();
  try {
    const first = availableAuthority("repo-order", "acme/order", "D1", {
      observationKey: "rest:D1",
      observedAt: "2026-08-11T01:00:00.000Z",
      eventAt: "2026-08-11T05:00:00.000Z",
    });
    const newer = availableAuthority("repo-order", "acme/order", "D2", {
      observationKey: "graphql:D2",
      observedAt: "2026-08-11T02:00:00.000Z",
      eventAt: "2026-08-10T20:00:00.000Z",
      source: RepositoryDefaultSource.RepositoryGraphql,
    });
    await writeRepositoryDefaultAuthorities(database.prisma, "account-order", [
      first,
      newer,
      first,
    ]);
    assert.deepEqual(
      authoritySummary(
        await readOne(database.prisma, "account-order", "repo-order")
      ),
      { availability: RepositoryDefaultAvailability.Available, branch: "D2" }
    );
    assert.equal(
      (await readOne(database.prisma, "account-order", "repo-order")).provenance
        .eventAt,
      "2026-08-10T20:00:00.000Z"
    );

    await database.prisma.write((client) =>
      client.repositoryDefaultAuthority.update({
        where: {
          identityKey_provider_providerRepositoryId: {
            identityKey: "account-order",
            provider: VcsProviderKind.GitHub,
            providerRepositoryId: "repo-order",
          },
        },
        data: { updatedAt: "replay-sentinel" },
      })
    );
    await writeRepositoryDefaultAuthorities(database.prisma, "account-order", [
      newer,
    ]);
    assert.equal(
      (
        await database.prisma.client.repositoryDefaultAuthority.findUniqueOrThrow(
          {
            where: {
              identityKey_provider_providerRepositoryId: {
                identityKey: "account-order",
                provider: VcsProviderKind.GitHub,
                providerRepositoryId: "repo-order",
              },
            },
          }
        )
      ).updatedAt,
      "replay-sentinel"
    );

    const poorer = unavailableAuthority("repo-order", "acme/order", {
      observationKey: "rest:permission",
      observedAt: "2026-08-11T03:00:00.000Z",
      reason: RepositoryDefaultReason.PermissionDenied,
    });
    await writeRepositoryDefaultAuthorities(database.prisma, "account-order", [
      poorer,
    ]);
    const stale = await readOne(database.prisma, "account-order", "repo-order");
    assert.deepEqual(authoritySummary(stale), {
      availability: RepositoryDefaultAvailability.Stale,
      branch: "D2",
    });
    assert.equal(
      stale.evidence.completeness,
      RepositoryDefaultCompleteness.Partial
    );
    assert.equal(
      "reason" in stale.evidence && stale.evidence.reason,
      RepositoryDefaultReason.PermissionDenied
    );
    assert.equal(stale.provenance.observationKey, "rest:permission");
  } finally {
    await database.close();
  }
});

test("equal-time authority converges for every three-conflict permutation", async () => {
  const database = await openTestPrisma();
  try {
    await writeRepositoryDefaultAuthorities(database.prisma, "account-equal", [
      unavailableAuthority("repo-equal", "acme/equal", {
        observationKey: "poor",
        reason: RepositoryDefaultReason.ProviderError,
      }),
      availableAuthority("repo-equal", "acme/equal", "trunk", {
        observationKey: "available",
      }),
    ]);
    assert.deepEqual(
      authoritySummary(
        await readOne(database.prisma, "account-equal", "repo-equal")
      ),
      {
        availability: RepositoryDefaultAvailability.Available,
        branch: "trunk",
      }
    );
    const variants = [
      availableAuthority("repo-permutation", "acme/permutation", "rest", {
        observationKey: "z-rest",
        source: RepositoryDefaultSource.RepositoryRest,
      }),
      availableAuthority("repo-permutation", "acme/permutation", "push", {
        observationKey: "m-push",
        source: RepositoryDefaultSource.PushWebhook,
      }),
      availableAuthority(
        "repo-permutation",
        "acme/permutation",
        "installation",
        {
          observationKey: "a-installation",
          source: RepositoryDefaultSource.InstallationWebhook,
        }
      ),
    ];
    const permutations = ["012", "021", "102", "120", "201", "210"];

    for (const [index, order] of permutations.entries()) {
      const identityKey = `account-permutation-${index}`;
      await writeRepositoryDefaultAuthorities(
        database.prisma,
        identityKey,
        [...order].map((position) => variants[Number(position)])
      );
      const conflict = await readOne(
        database.prisma,
        identityKey,
        "repo-permutation"
      );
      assert.equal(
        "reason" in conflict.evidence && conflict.evidence.reason,
        RepositoryDefaultReason.Conflicting
      );
      assert.equal("defaultBranch" in conflict.evidence, false);
      assert.equal(
        conflict.provenance.source,
        RepositoryDefaultSource.InstallationWebhook
      );
      assert.equal(conflict.provenance.observationKey, "a-installation");
    }
  } finally {
    await database.close();
  }
});

test("same-looking keys from different sources are not replays", async () => {
  const database = await openTestPrisma();
  try {
    await writeRepositoryDefaultAuthorities(database.prisma, "account-source", [
      availableAuthority("repo-source", "acme/source", "old", {
        observationKey: "same-key",
        source: RepositoryDefaultSource.RepositoryRest,
      }),
      availableAuthority("repo-source", "acme/source", "new", {
        observationKey: "same-key",
        observedAt: "2026-08-11T02:00:00.000Z",
        source: RepositoryDefaultSource.RepositoryGraphql,
      }),
    ]);
    assert.deepEqual(
      authoritySummary(
        await readOne(database.prisma, "account-source", "repo-source")
      ),
      { availability: RepositoryDefaultAvailability.Available, branch: "new" }
    );
  } finally {
    await database.close();
  }
});

test("distinct future sources with one key do not false-replay", async () => {
  const database = await openTestPrisma();
  try {
    const base = availableAuthority("repo-future", "acme/future", "trunk", {
      observationKey: "shared-future-key",
    });
    await writeRepositoryDefaultAuthorities(database.prisma, "account-future", [
      {
        ...base,
        provenance: { ...base.provenance, source: "future_source_alpha" },
      },
      {
        ...base,
        provenance: {
          ...base.provenance,
          source: "future_source_beta",
          observedAt: "2026-08-11T02:00:00.000Z",
        },
      },
    ]);

    const stored = await readOne(
      database.prisma,
      "account-future",
      "repo-future"
    );
    assert.equal(stored.provenance.source, RepositoryDefaultSource.Unknown);
    assert.equal(stored.provenance.sourceIdentity, "future_source_beta");
    assert.equal(stored.provenance.observedAt, "2026-08-11T02:00:00.000Z");
    assert.equal(
      "reason" in stored.evidence && stored.evidence.reason,
      RepositoryDefaultReason.Unknown
    );
  } finally {
    await database.close();
  }
});

test("normalizes siblings independently and bounds accepted batches atomically", async () => {
  const database = await openTestPrisma();
  try {
    const observations = Array.from(
      { length: MAX_REPOSITORY_DEFAULT_AUTHORITY_BATCH_SIZE },
      (_, index) =>
        availableAuthority(`repo-${index}`, `acme/repo-${index}`, "custom")
    );
    const result = await writeRepositoryDefaultAuthorities(
      database.prisma,
      "account-batch",
      [{ malformed: true }, ...observations]
    );
    assert.deepEqual(result, { accepted: 100, skipped: 1 });
    assert.equal(
      (
        await readRepositoryDefaultAuthorities(
          database.prisma,
          "account-batch",
          observations.map((observation) => ({
            provider: observation.repository.provider,
            providerRepositoryId: observation.repository.providerRepositoryId,
          }))
        )
      ).length,
      100
    );

    await assert.rejects(
      writeRepositoryDefaultAuthorities(database.prisma, "account-overflow", [
        ...observations,
        availableAuthority("repo-overflow", "acme/overflow", "trunk"),
      ]),
      RangeError
    );
    assert.equal(
      await database.prisma.client.repositoryDefaultAuthority.count({
        where: { identityKey: "account-overflow" },
      }),
      0
    );
  } finally {
    await database.close();
  }
});

test("rolls back a failed batch and survives close/reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "repository-authority-"));
  tempDirs.push(dir);
  const databasePath = path.join(dir, "agent-dashboard.sqlite");
  let database = await openDatabase(databasePath);
  try {
    await database.prisma.write((client) =>
      client.$executeRawUnsafe(
        `CREATE TRIGGER fail_repository_authority_insert
         BEFORE INSERT ON repository_default_authorities
         WHEN NEW.provider_repository_id = 'repo-fail'
         BEGIN SELECT RAISE(ABORT, 'forced authority failure'); END`
      )
    );
    await assert.rejects(
      writeRepositoryDefaultAuthorities(database.prisma, "account-rollback", [
        availableAuthority("repo-ok", "acme/ok", "trunk"),
        availableAuthority("repo-fail", "acme/fail", "main"),
      ])
    );
    assert.equal(
      await database.prisma.client.repositoryDefaultAuthority.count({
        where: { identityKey: "account-rollback" },
      }),
      0
    );
    await database.close();

    database = await openDatabase(databasePath);
    await writeRepositoryDefaultAuthorities(database.prisma, "account-reopen", [
      availableAuthority("repo-reopen", "acme/reopen", "production"),
    ]);
    await database.close();
    database = await openDatabase(databasePath);
    assert.deepEqual(
      authoritySummary(
        await readOne(database.prisma, "account-reopen", "repo-reopen")
      ),
      {
        availability: RepositoryDefaultAvailability.Available,
        branch: "production",
      }
    );
  } finally {
    await database.close();
  }
});

function availableAuthority(
  providerRepositoryId: string,
  fullName: string,
  defaultBranch: string,
  overrides: AuthorityOverrides = {}
): RepositoryDefaultAuthority {
  return authority(providerRepositoryId, fullName, overrides, {
    availability: RepositoryDefaultAvailability.Available,
    completeness: RepositoryDefaultCompleteness.Complete,
    defaultBranch,
  });
}

function unavailableAuthority(
  providerRepositoryId: string,
  fullName: string,
  overrides: AuthorityOverrides & { reason?: RepositoryDefaultReason } = {}
): RepositoryDefaultAuthority {
  return authority(providerRepositoryId, fullName, overrides, {
    availability: RepositoryDefaultAvailability.Unavailable,
    completeness: RepositoryDefaultCompleteness.Unavailable,
    reason: overrides.reason ?? RepositoryDefaultReason.NotReported,
  });
}

function authority(
  providerRepositoryId: string,
  fullName: string,
  overrides: AuthorityOverrides,
  evidence: RepositoryDefaultAuthority["evidence"]
): RepositoryDefaultAuthority {
  return {
    repository: {
      provider: overrides.provider ?? VcsProviderKind.GitHub,
      providerRepositoryId,
      fullName,
    },
    evidence,
    provenance: {
      source: overrides.source ?? RepositoryDefaultSource.RepositoryRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.SurfaceOpen,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey:
        overrides.observationKey ?? `observation:${providerRepositoryId}`,
      observedAt: overrides.observedAt ?? OBSERVED_AT,
      ...(overrides.eventAt === undefined
        ? {}
        : { eventAt: overrides.eventAt }),
    },
  };
}

type AuthorityOverrides = {
  provider?: VcsProviderKind;
  source?: RepositoryDefaultSource;
  observationKey?: string;
  observedAt?: string;
  eventAt?: string;
};

function readIdentity(
  providerRepositoryId: string,
  provider: VcsProviderKind = VcsProviderKind.GitHub
) {
  return { provider, providerRepositoryId };
}

async function readOne(
  prisma: Parameters<typeof readRepositoryDefaultAuthorities>[0],
  identityKey: string,
  providerRepositoryId: string
): Promise<RepositoryDefaultAuthority> {
  const rows = await readRepositoryDefaultAuthorities(prisma, identityKey, [
    readIdentity(providerRepositoryId),
  ]);
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error(`expected one authority row, received ${rows.length}`);
  }
  return row;
}

function authoritySummary(authority: RepositoryDefaultAuthority) {
  return {
    availability: authority.evidence.availability,
    branch:
      "defaultBranch" in authority.evidence
        ? authority.evidence.defaultBranch
        : undefined,
  };
}

function openDatabase(dataDir: string) {
  return openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered",
    resolveGitPath: () => "/usr/bin/git",
  });
}
