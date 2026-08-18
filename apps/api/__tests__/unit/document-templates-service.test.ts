/**
 * Unit tests for `documentTemplatesService`.
 *
 * Covers:
 *  - `findOrgTemplate` — read-only template lookup, returns null when missing.
 *  - `ensureDefaultTemplates` — lazy-creates the PRD template when missing,
 *    skips creation when present, seeds the initial version content, and
 *    creates it UNPARENTED (FEA-1749 D3 — the hidden per-org "Templates"
 *    sentinel project is retired).
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
  DocumentStatus: {
    Draft: "DRAFT",
  },
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    getLatest: vi.fn(),
    createVersion: vi.fn(),
  },
}));

import { withDb } from "@repo/database";
import { documentVersionService } from "@/app/documents/document-version-service";
import { documentTemplatesService } from "@/app/templates/service";

const mockWithDb = withDb as unknown as Mock;
const mockWithDbTx = (withDb as unknown as { tx: Mock }).tx;
const mockGetLatest = documentVersionService.getLatest as Mock;
const mockCreateVersion = documentVersionService.createVersion as Mock;

// Helper: install a mocked db client that exposes the methods the service
// hits, for both `withDb(cb)` (pooled reads) and `withDb.tx(cb)` (the
// ensureDefaultTemplates seed transaction). `$executeRaw` backs the ISS-4532
// advisory lock. Returns the client so tests can assert on the lock call.
function mockDb(db: Record<string, unknown>) {
  const client = { $executeRaw: vi.fn().mockResolvedValue(1), ...db };
  mockWithDb.mockImplementation(
    async (fn: (db: Record<string, unknown>) => unknown) => fn(client)
  );
  mockWithDbTx.mockImplementation(
    async (fn: (tx: Record<string, unknown>) => unknown) => fn(client)
  );
  return client;
}

describe("documentTemplatesService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("findOrgTemplate", () => {
    it("returns the template document when one exists for the type", async () => {
      mockDb({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({
            id: "tmpl-1",
            organizationId: "org-1",
            type: "DOCUMENT",
            subtype: "TEMPLATE",
            name: "PRD Template",
            slug: "tmpl-prd",
            status: "DRAFT",
            createdById: "u-1",
            assigneeId: null,
            sortOrder: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            assignee: null,
            document: {
              templateForType: "PRD",
              latestVersion: 1,
              fileName: null,
              approverId: null,
              approver: null,
            },
          }),
        },
      });

      const result = await documentTemplatesService.findOrgTemplate(
        "org-1",
        "PRD" as never
      );

      expect(result).not.toBeNull();
      expect(result?.id).toBe("tmpl-1");
      expect(result?.title).toBe("PRD Template");
    });

    it("returns null when no template exists for the type", async () => {
      mockDb({
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
      });

      const result = await documentTemplatesService.findOrgTemplate(
        "org-1",
        "PRD" as never
      );

      expect(result).toBeNull();
    });

    it("scopes the query by organizationId + DOCUMENT type + templateForType", async () => {
      const findFirst = vi.fn().mockResolvedValue(null);
      mockDb({ artifact: { findFirst } });

      await documentTemplatesService.findOrgTemplate("org-1", "PRD" as never);

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: "DOCUMENT",
            organizationId: "org-1",
            document: { templateForType: "PRD" },
          }),
        })
      );
    });
  });

  describe("ensureDefaultTemplates", () => {
    it("FAST PATH: returns without opening a txn or taking the lock when the template AND its version already exist (ISS-4532 pool-exhaustion fix)", async () => {
      // Steady state: a cheap pooled read finds the PRD template with a seeded
      // version, so ensureDefaultTemplates must NOT open a transaction or take
      // the advisory lock (otherwise every template GET would serialize on the
      // xact lock and exhaust the pool).
      const findFirstDetail = vi.fn().mockResolvedValue({
        artifactId: "tmpl-1",
        versions: [{ id: "ver-1" }],
      });
      const createArtifact = vi.fn();
      const client = mockDb({
        documentDetail: { findFirst: findFirstDetail },
        artifact: { create: createArtifact },
      });

      await documentTemplatesService.ensureDefaultTemplates("org-1", "user-1");

      // The pooled fast-path read ran; the locked transaction did NOT.
      expect(mockWithDb).toHaveBeenCalledTimes(1);
      expect(mockWithDbTx).not.toHaveBeenCalled();
      expect(client.$executeRaw as Mock).not.toHaveBeenCalled();
      expect(createArtifact).not.toHaveBeenCalled();
      expect(mockCreateVersion).not.toHaveBeenCalled();
    });

    it("skips creation when a PRD template already exists, but seeds the version when missing", async () => {
      // Fast path finds the template but NO version (versions: []), so it falls
      // through to the locked txn, which reuses the existing template id and
      // seeds only the version.
      const findFirstDetail = vi.fn().mockResolvedValue({
        artifactId: "tmpl-existing",
        versions: [],
      });
      const createArtifact = vi.fn();

      mockDb({
        documentDetail: { findFirst: findFirstDetail },
        artifact: { create: createArtifact },
      });

      // No existing version yet — should seed PRD_TEMPLATE.
      mockGetLatest.mockResolvedValue(null);
      mockCreateVersion.mockResolvedValue({ id: "ver-1" });

      await documentTemplatesService.ensureDefaultTemplates("org-1", "user-1");

      expect(mockWithDbTx).toHaveBeenCalledTimes(1);
      expect(findFirstDetail).toHaveBeenCalled();
      expect(createArtifact).not.toHaveBeenCalled();
      expect(mockCreateVersion).toHaveBeenCalledWith(
        "tmpl-existing",
        "org-1",
        null,
        expect.any(String)
      );
    });

    it("does not seed a version when one already exists (in-txn re-check)", async () => {
      // Fast path misses (no version row yet), enters the txn; the in-lock
      // re-check finds the template AND getLatest returns a version, so no
      // create happens.
      mockDb({
        documentDetail: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce({ artifactId: "tmpl-1", versions: [] })
            .mockResolvedValue({ artifactId: "tmpl-1" }),
        },
        artifact: { create: vi.fn() },
      });

      mockGetLatest.mockResolvedValue({
        id: "ver-1",
        content: "existing",
      });

      await documentTemplatesService.ensureDefaultTemplates("org-1", "user-1");

      expect(mockWithDbTx).toHaveBeenCalledTimes(1);
      expect(mockCreateVersion).not.toHaveBeenCalled();
    });

    it("seeds inside one txn under a (org, type) advisory lock, not separate connections (ISS-4532)", async () => {
      const client = mockDb({
        documentDetail: {
          // Fast path (call 1) misses the version; in-txn re-check (call 2)
          // finds the template.
          findFirst: vi
            .fn()
            .mockResolvedValueOnce({ artifactId: "tmpl-1", versions: [] })
            .mockResolvedValue({ artifactId: "tmpl-1" }),
        },
        artifact: { create: vi.fn() },
      });
      mockGetLatest.mockResolvedValue({ id: "ver-1" });

      await documentTemplatesService.ensureDefaultTemplates("org-1", "user-1");

      // The seed runs in ONE withDb.tx, entered only after the pooled fast-path
      // read (mockWithDb) missed.
      expect(mockWithDbTx).toHaveBeenCalledTimes(1);
      expect(mockWithDb).toHaveBeenCalledTimes(1);

      // First statement in the txn is the xact-scoped advisory lock, keyed by
      // org + PRD template type, so concurrent seeders serialize. The pooled
      // fast-path read takes no lock, so $executeRaw runs exactly once.
      const executeRaw = client.$executeRaw as Mock;
      expect(executeRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = executeRaw.mock.calls[0];
      expect((strings as string[]).join("?")).toContain(
        "pg_advisory_xact_lock"
      );
      expect(values).toContain("document:template-for-type:org-1:PRD");
    });

    it("passes a bounded {maxWait,timeout} to the seed txn (ISS-4532 P2028 guard)", async () => {
      mockDb({
        documentDetail: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce({ artifactId: "tmpl-1", versions: [] })
            .mockResolvedValue({ artifactId: "tmpl-1" }),
        },
        artifact: { create: vi.fn() },
      });
      mockGetLatest.mockResolvedValue({ id: "ver-1" });

      await documentTemplatesService.ensureDefaultTemplates("org-1", "user-1");

      expect(mockWithDbTx).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ maxWait: 5000, timeout: 30_000 })
      );
    });

    it("P2002 on create: recovers in a FRESH lock-reacquiring txn, not the aborted one (ISS-4532 rolling-deploy)", async () => {
      // Fast path misses; in-txn re-check misses; create races a lock-skipping
      // concurrent seeder and hits the partial unique index (P2002), which
      // ABORTS the txn — so recovery must NOT run on the same tx (would 25P02).
      // The catch opens a SECOND withDb.tx that reacquires the advisory lock and
      // re-reads the winner; the winner already has a version, so no createVersion.
      const findFirst = vi
        .fn()
        .mockResolvedValueOnce(null) // fast-path pooled read
        .mockResolvedValueOnce(null) // seed-txn pre-create re-check
        .mockResolvedValueOnce({ artifactId: "winner-1" }); // recovery-txn re-read
      const createArtifact = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("unique"), { code: "P2002" })
        );
      // Winner already seeded its version (recovery uses getLatest under the lock).
      mockGetLatest.mockResolvedValue({ id: "ver-w" });

      mockDb({
        documentDetail: { findFirst },
        artifact: { create: createArtifact },
      });

      await expect(
        documentTemplatesService.ensureDefaultTemplates("org-1", "user-1")
      ).resolves.toBeUndefined();

      expect(createArtifact).toHaveBeenCalledTimes(1);
      // TWO transactions ran: the aborted seed txn + the fresh recovery txn.
      expect(mockWithDbTx).toHaveBeenCalledTimes(2);
      // Recovery reused the winner and, since its version existed, seeded none.
      expect(mockGetLatest).toHaveBeenCalledWith("winner-1");
      expect(mockCreateVersion).not.toHaveBeenCalled();
    });

    it("P2002 recovery seeds the version under the lock when the winner has none yet", async () => {
      const findFirst = vi
        .fn()
        .mockResolvedValueOnce(null) // fast-path
        .mockResolvedValueOnce(null) // seed-txn re-check
        .mockResolvedValueOnce({ artifactId: "winner-1" }); // recovery re-read
      const createArtifact = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("unique"), { code: "P2002" })
        );
      // No version yet at the moment the recovery acquires the lock.
      mockGetLatest.mockResolvedValue(null);

      mockDb({
        documentDetail: { findFirst },
        artifact: { create: createArtifact },
      });

      await documentTemplatesService.ensureDefaultTemplates("org-1", "user-1");

      expect(mockCreateVersion).toHaveBeenCalledWith(
        "winner-1",
        "org-1",
        null,
        expect.any(String)
      );
    });

    it("rethrows a non-P2002 create failure", async () => {
      const findFirst = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      const createArtifact = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("boom"), { code: "P2003" }));

      mockDb({
        documentDetail: { findFirst },
        artifact: { create: createArtifact },
      });

      await expect(
        documentTemplatesService.ensureDefaultTemplates("org-1", "user-1")
      ).rejects.toThrow("boom");
    });

    it("creates an unparented template + initial version when none exists, and no sentinel project", async () => {
      // FEA-1749: templates are org-level and carry no project. Sequence:
      //   1. documentDetail.findFirst → null (no template)
      //   2. artifact.create → new template artifact with projectId: null
      //   3. documentVersionService.getLatest → null (no version)
      //   4. documentVersionService.createVersion → seed version
      const findFirstDetail = vi.fn().mockResolvedValue(null);
      const findFirstProject = vi.fn();
      const createProject = vi.fn();
      const createArtifact = vi.fn().mockResolvedValue({ id: "tmpl-new" });

      mockDb({
        documentDetail: { findFirst: findFirstDetail },
        project: {
          findFirst: findFirstProject,
          create: createProject,
        },
        artifact: { create: createArtifact },
      });

      mockGetLatest.mockResolvedValue(null);
      mockCreateVersion.mockResolvedValue({ id: "ver-1" });

      await documentTemplatesService.ensureDefaultTemplates("org-1", "user-1");

      expect(createArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "DOCUMENT",
            subtype: "TEMPLATE",
            // ISS-4532: denormalized mirror for the partial unique index.
            templateForType: "PRD",
            organizationId: "org-1",
            projectId: null,
            createdById: "user-1",
          }),
        })
      );
      // The point of D3: the hidden "Templates" sentinel is gone. The service
      // must not look one up, and must never create one.
      expect(findFirstProject).not.toHaveBeenCalled();
      expect(createProject).not.toHaveBeenCalled();
      expect(mockCreateVersion).toHaveBeenCalledWith(
        "tmpl-new",
        "org-1",
        null,
        expect.any(String)
      );
    });
  });
});
