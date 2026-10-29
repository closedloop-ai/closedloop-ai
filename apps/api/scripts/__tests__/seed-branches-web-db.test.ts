import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import { runBranchesWebSeedScript } from "../seed-branches-web-db";

const BASE_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/symphony";

describe("branches web seed command boundary", () => {
  it("refuses ambient DATABASE_URL without an explicit target before opening a database connection", async () => {
    const runWithDb = vi.fn(
      async (_callback: (db: unknown) => unknown): Promise<void> => undefined
    );

    await expect(
      runBranchesWebSeedScript({
        argv: [],
        env: { DATABASE_URL: BASE_DATABASE_URL },
        loadEnv: false,
        runWithDb,
      })
    ).rejects.toThrow("Pass --database-name");

    expect(runWithDb).not.toHaveBeenCalled();
  });

  it("seeds the explicitly named database with product-visible Branch rows", async () => {
    const db = fakeDb();
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = BASE_DATABASE_URL;
    const runWithDb = vi.fn(
      async (callback: (db: unknown) => unknown): Promise<void> => {
        expect(process.env.DATABASE_URL).toContain("/symphony_worker_8018");
        await callback(db);
      }
    );

    try {
      const summary = await runBranchesWebSeedScript({
        argv: [
          "--",
          "--database-name",
          "symphony_worker_8018",
          "--branches",
          "3",
          "--unavailable-branches",
          "1",
        ],
        env: { DATABASE_URL: BASE_DATABASE_URL },
        loadEnv: false,
        logger: { log: vi.fn() },
        runWithDb,
      });

      expect(summary).toMatchObject({
        databaseName: "symphony_worker_8018",
        seededBranches: 3,
        unavailableBranches: 1,
      });
      expect(process.env.DATABASE_URL).toBe(BASE_DATABASE_URL);
      expect(db.publicRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            defaultBranchAvailability: "available",
            defaultBranchCompleteness: "complete",
          }),
        })
      );
      expect(db.branchDetail.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            pushSource: BranchPushSource.Session,
            repositoryFullName: "closedloop-ai/branches-web-vqa",
          }),
        ]),
      });
      expect(db.artifactLink.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            branchParticipation: BranchParticipationKind.Wrote,
            metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
          }),
        ]),
      });
      const atoms = db.branchActivityAtom.createMany.mock.calls[0]?.[0].data;
      expect(atoms).toHaveLength(3);
      // ISS-8018: the seeder marks an unavailable branch's activity atom with
      // `createdAt === occurredAt` (an available branch's atom stamps
      // `createdAt: now`, which differs from its past-dated `occurredAt`).
      // Exactly one of the three seeded branches is unavailable.
      expect(
        atoms.filter(
          (atom: { createdAt: Date; occurredAt: Date }) =>
            atom.createdAt.getTime() === atom.occurredAt.getTime()
        )
      ).toHaveLength(1);
    } finally {
      if (previousDatabaseUrl === undefined) {
        Reflect.deleteProperty(process.env, "DATABASE_URL");
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  });
});

function fakeDb() {
  return {
    organization: {
      findUnique: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
      create: vi.fn().mockResolvedValue({ id: "org-1" }),
      update: vi.fn().mockResolvedValue({ id: "org-1" }),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "user-1" }),
      update: vi.fn().mockResolvedValue({ id: "user-1" }),
    },
    project: {
      upsert: vi.fn().mockResolvedValue({ id: "project-1" }),
    },
    computeTarget: {
      upsert: vi.fn().mockResolvedValue({ id: "compute-1" }),
    },
    publicRepository: {
      upsert: vi.fn(),
    },
    artifact: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    branchDetail: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    sessionDetail: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    artifactLink: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    branchActivityAtom: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    branchFileChange: { deleteMany: vi.fn() },
    agentSessionActivitySegment: { deleteMany: vi.fn() },
    agentSessionTokenEvent: { deleteMany: vi.fn() },
  };
}
