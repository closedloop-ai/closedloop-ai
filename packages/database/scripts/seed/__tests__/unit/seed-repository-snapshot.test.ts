/**
 * ISS-7104: the seed wrote `repositorySnapshot: {}` for every seeded document,
 * so every seeded row failed the canonical parse on read and `GET /documents`
 * emitted a per-row warn dump under the perf workload.
 *
 * These tests read the snapshot back out of the payload `seedCoreEntities`
 * hands to `artifact.upsert`, so they fail if core.ts ever writes an
 * out-of-contract shape again — on either branch of the upsert.
 */

import { artifactRepositorySnapshotSchema } from "@repo/api/src/types/document";
import { describe, expect, it, vi } from "vitest";
import { ArtifactType } from "../../../../generated/client";
import { seedCoreEntities } from "../../core";
import {
  resolveSeedRunPlan,
  SeedProfileName,
  type SeedRunPlan,
} from "../../profiles";
import { baselineContext } from "../fixtures/baseline-org";
import { createMockPrisma } from "../fixtures/mock-prisma";

function buildReadyMock() {
  const prisma = createMockPrisma();
  const p = vi.mocked(prisma, true);

  p.team.findUnique.mockResolvedValue(null);
  p.teamMember.findUnique.mockResolvedValue(null);
  p.project.findUnique.mockResolvedValue(null);
  p.slugCounter.findUnique.mockResolvedValue(null);
  p.artifact.findUnique.mockResolvedValue(null);
  p.gitHubInstallation.findUnique.mockResolvedValue(null);
  p.gitHubInstallationRepository.findUnique.mockResolvedValue(null);

  vi.mocked(prisma.team.upsert, { partial: true }).mockImplementation((args) =>
    Promise.resolve({ id: args.create.id as string })
  );
  vi.mocked(prisma.teamMember.upsert, { partial: true }).mockResolvedValue({
    id: "tm1",
  });
  vi.mocked(prisma.project.upsert, { partial: true }).mockImplementation(
    (args) => Promise.resolve({ id: args.create.id as string })
  );
  vi.mocked(prisma.slugCounter.upsert, { partial: true }).mockResolvedValue({
    id: "sc1",
  });
  vi.mocked(prisma.artifact.upsert, { partial: true }).mockImplementation(
    (args) => Promise.resolve({ id: args.create.id as string })
  );
  vi.mocked(prisma.gitHubInstallation.upsert, {
    partial: true,
  }).mockResolvedValue({ id: "gh-inst" });
  vi.mocked(prisma.gitHubInstallationRepository.upsert, {
    partial: true,
  }).mockResolvedValue({ id: "gh-repo" });

  return { prisma, p };
}

/** Every `artifact.upsert` payload the seed writes for a DOCUMENT artifact. */
async function captureDocumentUpserts(plan?: SeedRunPlan) {
  const { prisma, p } = buildReadyMock();
  await seedCoreEntities(prisma, baselineContext, plan);

  return p.artifact.upsert.mock.calls
    .map((call) => call[0])
    .filter((args) => args.create.type === ArtifactType.DOCUMENT);
}

describe("seed repositorySnapshot", () => {
  it("writes a canonical snapshot on the create branch of every document upsert", async () => {
    const documentCalls = await captureDocumentUpserts();
    // Guard the loop below against passing vacuously on an empty capture.
    expect(documentCalls.length).toBeGreaterThan(0);

    for (const args of documentCalls) {
      const parsed = artifactRepositorySnapshotSchema.safeParse(
        args.create.document?.create?.repositorySnapshot
      );
      expect(parsed.success).toBe(true);
    }
  });

  it("repairs the snapshot on the update branch, so a re-seed fixes existing rows", async () => {
    const documentCalls = await captureDocumentUpserts();
    expect(documentCalls.length).toBeGreaterThan(0);

    for (const args of documentCalls) {
      const nested = args.update.document?.upsert;
      // The detail row is absent whenever the artifact outlived a partial
      // seed, so both arms of the nested upsert have to carry a valid value.
      expect(
        artifactRepositorySnapshotSchema.safeParse(
          nested?.update.repositorySnapshot
        ).success
      ).toBe(true);
      expect(
        artifactRepositorySnapshotSchema.safeParse(
          nested?.create.repositorySnapshot
        ).success
      ).toBe(true);
    }
  });

  it("writes a canonical snapshot for the scaled perf profile that surfaced the flood", async () => {
    const documentCalls = await captureDocumentUpserts(
      resolveSeedRunPlan({ profile: SeedProfileName.Perf })
    );
    expect(documentCalls.length).toBeGreaterThan(0);

    for (const args of documentCalls) {
      expect(
        artifactRepositorySnapshotSchema.safeParse(
          args.create.document?.create?.repositorySnapshot
        ).success
      ).toBe(true);
    }
  });

  it("rejects the old empty-object shape the seed previously wrote", () => {
    // Negative control: proves the assertions above have teeth — the canonical
    // schema really does reject the shape core.ts used to store.
    const result = artifactRepositorySnapshotSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
