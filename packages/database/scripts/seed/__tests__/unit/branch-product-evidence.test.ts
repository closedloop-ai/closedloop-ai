import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { RepositoryDefaultCompleteness } from "@repo/api/src/types/repository-default-identity";
import { expect, it, vi } from "vitest";
import { ArtifactType } from "../../../../generated/client";
import { seedBranchProductEvidence } from "../../branch-product-evidence";
import { baselineContext } from "../fixtures/baseline-org";
import { createMockPrisma } from "../fixtures/mock-prisma";

it("seeds a reachable Branch with an isolated ownerless Session and an idempotent Wrote link", async () => {
  const prisma = createMockPrisma();
  const input = {
    organizationId: baselineContext.organizationId,
    githubRepositoryId: "00000000-0000-4000-8000-000000000003",
    projectId: "00000000-0000-4000-8000-000000000004",
    computeTargetId: "00000000-0000-4000-8000-000000000005",
  };
  await seedBranchProductEvidence(prisma, input);
  const artifacts = vi
    .mocked(prisma.artifact.upsert)
    .mock.calls.map(([call]) => call.create);
  const session = artifacts.find(
    (row) => row.name === "Seed Collaborator Evidence Session"
  );
  const branch = artifacts.find(
    (row) => row.name === "seed/collaborators-branch"
  );
  expect(session).toMatchObject({
    type: ArtifactType.SESSION,
    organizationId: input.organizationId,
    session: { create: { computeTargetId: input.computeTargetId } },
  });
  expect(session?.session?.create).not.toHaveProperty("userId");
  expect(branch).toMatchObject({
    type: ArtifactType.BRANCH,
    organizationId: input.organizationId,
    branch: {
      create: {
        repositoryId: input.githubRepositoryId,
        branchName: "seed/collaborators-branch",
        firstPushedAt: new Date("2026-01-01T11:00:00.000Z"),
      },
    },
  });
  expect(
    vi.mocked(prisma.gitHubInstallationRepository.update).mock.calls[0]?.[0]
  ).toMatchObject({
    where: { id: input.githubRepositoryId },
    data: { defaultBranchCompleteness: RepositoryDefaultCompleteness.Complete },
  });
  const collaboratorLinks = () =>
    vi
      .mocked(prisma.artifactLink.upsert)
      .mock.calls.map(([call]) => call)
      .filter((call) => call.create.targetId === branch?.id);
  const [firstLink] = collaboratorLinks();
  expect(firstLink?.create).toMatchObject({
    sourceId: session?.id,
    targetId: branch?.id,
    branchParticipation: BranchParticipationKind.Wrote,
  });
  await seedBranchProductEvidence(prisma, input);
  expect(collaboratorLinks()).toEqual([firstLink, firstLink]);
});
