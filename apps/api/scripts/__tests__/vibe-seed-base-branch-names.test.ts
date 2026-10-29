/**
 * ISS-12135: the base seed's relabel renames its two branches to their Acme
 * names from the base seed's own names, and from the names a database seeded
 * before the topic-prefix rename holds, so a rerun over it still finds them.
 */
import type { PrismaClient } from "@repo/database";
import {
  PullRequestCommentProofFixture,
  pullRequestCommentProofIdentity,
} from "@repo/database/scripts/seed/pull-request-comment-proof-identity";
import { describe, expect, it, vi } from "vitest";
import { seedBranchOwners } from "@/app/branches/branch-owner-seed/branch-owner-seed";
import { generateSlug } from "@/lib/slug-generator";
import {
  ACME_COLLABORATOR_BRANCH,
  ACME_FEATURE_BRANCH,
  ACME_REPOSITORY,
  relabelBaseSeedGitHub,
} from "../vibe-seed/core/base-seed-github";
import { containsBannedWording } from "../vibe-seed/core/seed-integrity";
import type { VibeSeedContext } from "../vibe-seed/stage";

vi.mock("@/lib/slug-generator", () => ({
  generateSlug: vi.fn(() => Promise.resolve("SES-100")),
}));

vi.mock("@/app/branches/branch-owner-seed/branch-owner-seed", () => ({
  seedBranchOwners: vi.fn(() => Promise.resolve(1)),
}));

const ORGANIZATION_ID = "org-1";
/** The signed-in person's handle when such a database was seeded, as its rows hold it. */
const HANDLE = "jordanavery";

describe("relabelBaseSeedGitHub branch names", () => {
  it.each([
    ["the base seed", ["seed/feature-branch", "seed/collaborators-branch"]],
    [
      "a database seeded before the rename",
      [`${HANDLE}/saved-project-filters`, `${HANDLE}/project-activity-feed`],
    ],
  ])("renames the branches %s wrote", async (_source, names) => {
    const branches = names.map((branchName) => ({ branchName }));

    await relabelBaseSeedGitHub(context(branches));

    expect(branches.map((branch) => branch.branchName)).toEqual([
      ACME_FEATURE_BRANCH,
      ACME_COLLABORATOR_BRANCH,
    ]);
  });
});

it("relabels additive proof identities, attributes their push sessions, and keeps reruns stable", async () => {
  const identities = Object.values(PullRequestCommentProofFixture).map(
    (fixture) => ({
      ...pullRequestCommentProofIdentity(ORGANIZATION_ID, fixture),
      branchName: `seed/pr-comment-proof-${fixture}`,
      pullRequestId: `proof-pr-${fixture}`,
      pullRequestTitle: `Seed pull request: seed/pr-comment-proof-${fixture}`,
      repositoryFullName: "seed-org/seed-repo",
      headRefName: null as string | null,
      sessionName: `Seed PR Comment Proof Session (${fixture})`,
      slug: pullRequestCommentProofIdentity(ORGANIZATION_ID, fixture)
        .sessionSlug,
    })
  );
  const updateArtifact = vi.fn(
    ({
      where,
      data,
    }: {
      where: { id?: string; createdById?: null };
      data: { name?: string; slug?: string | null; createdById?: string };
    }) => {
      const row = identities.find(
        (candidate) => candidate.sessionArtifactId === where.id
      );
      if (row && data.name && data.slug) {
        row.sessionName = data.name;
        row.slug = data.slug;
      }
      return Promise.resolve({ count: 1 });
    }
  );
  const delegates = {
    branchDetail: {
      findFirst: ({
        where,
      }: {
        where: { artifactId?: string; branchName?: string };
      }) => {
        const row = identities.find(
          (candidate) =>
            candidate.branchArtifactId === where.artifactId ||
            candidate.branchName === where.branchName
        );
        return Promise.resolve(
          row
            ? {
                ...row,
                artifactId: row.branchArtifactId,
                firstPushedAt: new Date(),
              }
            : null
        );
      },
      updateMany: ({
        where,
        data,
      }: {
        where: { artifactId?: string };
        data: { branchName?: string };
      }) => {
        const row = identities.find(
          (candidate) => candidate.branchArtifactId === where.artifactId
        );
        if (row && data.branchName) {
          row.branchName = data.branchName;
        }
        return Promise.resolve({ count: row ? 1 : 0 });
      },
    },
    artifact: {
      findMany: () => Promise.resolve([]),
      findFirst: ({ where }: { where: { id: string } }) => {
        const row = identities.find(
          (candidate) => candidate.sessionArtifactId === where.id
        );
        return Promise.resolve(
          row ? { name: row.sessionName, slug: row.slug } : null
        );
      },
      updateMany: updateArtifact,
    },
    artifactLink: {
      findMany: ({ where }: { where: { targetId: string } }) => {
        const row = identities.find(
          (candidate) => candidate.branchArtifactId === where.targetId
        );
        return Promise.resolve(
          row
            ? [
                {
                  id: "link",
                  sourceId: row.sessionArtifactId,
                  source: {
                    createdById: null,
                    session: { computeTarget: { userId: "owner" } },
                  },
                },
              ]
            : []
        );
      },
      updateMany: () => Promise.resolve({ count: 0 }),
    },
    pullRequestDetail: {
      findMany: ({ where }: { where: { branchArtifactId?: string } }) =>
        Promise.resolve(
          identities
            .filter((row) => row.branchArtifactId === where.branchArtifactId)
            .map((row) => ({
              id: row.pullRequestId,
              title: row.pullRequestTitle,
            }))
        ),
      updateMany: ({
        where,
        data,
      }: {
        where: { id?: string };
        data: {
          title: string;
          repositoryFullName: string;
          headRefName: string;
        };
      }) => {
        const row = identities.find(
          (candidate) => candidate.pullRequestId === where.id
        );
        if (row) {
          row.pullRequestTitle = data.title;
          row.repositoryFullName = data.repositoryFullName;
          row.headRefName = data.headRefName;
        }
        return Promise.resolve({ count: row ? 1 : 0 });
      },
    },
  };
  const empty = new Proxy(
    {},
    { get: (_target, method) => () => Promise.resolve(nothingFor(method)) }
  );
  const prisma = new Proxy(
    {},
    {
      get: (_target, delegate) =>
        Object.hasOwn(delegates, delegate)
          ? Reflect.get(delegates, delegate)
          : empty,
    }
  ) as unknown as PrismaClient;
  const seedContext = {
    prisma,
    organizationId: ORGANIZATION_ID,
    now: new Date(),
  } as unknown as VibeSeedContext;
  await relabelBaseSeedGitHub(seedContext);
  expect(identities.map((row) => row.branchName)).toEqual([
    "pr-comment-proof-complete",
    "pr-comment-proof-missing-lane",
  ]);
  expect(identities.map((row) => row.sessionName)).toEqual([
    "PR Comment Proof Session (complete)",
    "PR Comment Proof Session (missing-lane)",
  ]);
  expect(identities.some((row) => containsBannedWording(row.slug))).toBe(false);
  expect(
    updateArtifact.mock.calls.filter(([input]) => input.data.createdById)
  ).toEqual(
    identities.map((row) => [
      {
        where: { id: row.sessionArtifactId, createdById: null },
        data: { createdById: "owner" },
      },
    ])
  );
  expect(identities.map((row) => row.pullRequestTitle)).toEqual([
    "pull request: pr-comment-proof-complete",
    "pull request: pr-comment-proof-missing-lane",
  ]);
  expect(identities.map((row) => row.repositoryFullName)).toEqual([
    ACME_REPOSITORY,
    ACME_REPOSITORY,
  ]);
  expect(identities.map((row) => row.headRefName)).toEqual(
    identities.map((row) => row.branchName)
  );
  expect(vi.mocked(generateSlug)).toHaveBeenCalledTimes(2);
  // ISS-12998: Owner is the assignee the product's Owner seed stamps
  // (ISS-12463), and no product write path visits a base-seed branch.
  const ownerSeeds = vi
    .mocked(seedBranchOwners)
    .mock.calls.filter(([, , ids]) =>
      identities.some((row) => ids.includes(row.branchArtifactId))
    );
  expect(ownerSeeds.every(([db]) => db === prisma)).toBe(true);
  expect(
    ownerSeeds.map(([, organizationId, ids]) => [organizationId, ids])
  ).toEqual(identities.map((row) => [ORGANIZATION_ID, [row.branchArtifactId]]));
  await relabelBaseSeedGitHub(seedContext);
  expect(vi.mocked(generateSlug)).toHaveBeenCalledTimes(2);
});

/**
 * A context whose `branchDetail.updateMany` renames the given rows by exact
 * name, as Prisma would; every other read finds nothing and every other write
 * changes nothing.
 */
function context(branches: { branchName: string }[]): VibeSeedContext {
  const branchDetail = {
    updateMany: ({
      where,
      data,
    }: {
      where: { organizationId: string; branchName?: unknown };
      data: { branchName?: string };
    }) => {
      let count = 0;
      for (const branch of branches) {
        if (
          where.organizationId === ORGANIZATION_ID &&
          where.branchName === branch.branchName &&
          data.branchName !== undefined
        ) {
          branch.branchName = data.branchName;
          count += 1;
        }
      }
      return Promise.resolve({ count });
    },
    findFirst: () => Promise.resolve(null),
  };
  const empty = new Proxy(
    {},
    {
      get: (_target, method) => () => Promise.resolve(nothingFor(method)),
    }
  );
  const prisma = new Proxy(
    {},
    {
      get: (_target, delegate) =>
        delegate === "branchDetail" ? branchDetail : empty,
    }
  ) as unknown as PrismaClient;
  return {
    prisma,
    organizationId: ORGANIZATION_ID,
  } as unknown as VibeSeedContext;
}

function nothingFor(method: string | symbol): unknown {
  if (method === "findMany") {
    return [];
  }
  if (method === "findFirst" || method === "findUnique") {
    return null;
  }
  return { count: 0 };
}
