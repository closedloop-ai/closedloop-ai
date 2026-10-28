import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});
vi.mock("@repo/observability/log", () => ({ log: { warn: vi.fn() } }));

import { ArtifactType } from "@repo/api/src/types/artifact";
import { log } from "@repo/observability/log";
import { mockWithDbCall } from "@/__tests__/utils/db-helpers";
import { fetchDocumentVersionsByArtifact } from "./project-tree-version-read";

const organizationId = "33333333-3333-7333-8333-333333333333";
const findMany = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockWithDbCall({ documentDetail: { findMany } });
});

describe("project tree document versions", () => {
  it("reads persisted versions with organization and type scope", async () => {
    findMany.mockResolvedValue([{ artifactId: "a", latestVersion: 7 }]);
    expect(
      await fetchDocumentVersionsByArtifact(organizationId, [
        "a",
        "a",
        "missing",
      ])
    ).toEqual(new Map([["a", 7]]));
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        artifactId: { in: ["a", "missing"] },
        artifact: { organizationId, type: ArtifactType.Document },
      },
      select: { artifactId: true, latestVersion: true },
    });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "omits an invalid persisted version %s through the monitored enrichment path",
    async (latestVersion) => {
      findMany.mockResolvedValue([{ artifactId: "a", latestVersion }]);
      expect(
        await fetchDocumentVersionsByArtifact(organizationId, ["a"])
      ).toEqual(new Map());
      expect(log.warn).toHaveBeenCalledWith(
        "telemetry.enrichment_failed",
        expect.objectContaining({
          enrichmentKind: "project_tree_document_versions",
        })
      );
    }
  );

  it("does not read an empty cohort", async () => {
    expect(await fetchDocumentVersionsByArtifact(organizationId, [])).toEqual(
      new Map()
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it("does not expose versions from another organization even when its ID is requested", async () => {
    const persisted = [
      { artifactId: "local", organizationId, latestVersion: 3 },
      { artifactId: "foreign", organizationId: "other-org", latestVersion: 8 },
    ];
    findMany.mockImplementation(async ({ where }) =>
      persisted
        .filter(
          (row) =>
            !where.artifactId?.in ||
            where.artifactId.in.includes(row.artifactId)
        )
        .filter(
          (row) =>
            where.artifact?.organizationId === undefined ||
            row.organizationId === where.artifact.organizationId
        )
        .map(({ artifactId, latestVersion }) => ({ artifactId, latestVersion }))
    );

    expect(
      await fetchDocumentVersionsByArtifact(organizationId, [
        "local",
        "foreign",
        "missing",
      ])
    ).toEqual(new Map([["local", 3]]));
  });

  it("bounds query width and keeps the final chunk", async () => {
    const ids = Array.from({ length: 1001 }, (_, index) => `a${index}`);
    findMany.mockImplementation(async ({ where }) =>
      where.artifactId.in.map((artifactId: string) => ({
        artifactId,
        latestVersion: 2,
      }))
    );
    expect(
      (await fetchDocumentVersionsByArtifact(organizationId, ids)).size
    ).toBe(1001);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[1]?.[0].where.artifactId.in).toEqual(["a1000"]);
  });

  it("omits all enrichment if a later chunk fails, retaining the tree failure boundary", async () => {
    findMany
      .mockResolvedValueOnce([{ artifactId: "a0", latestVersion: 2 }])
      .mockRejectedValueOnce(new Error("unavailable"));
    expect(
      await fetchDocumentVersionsByArtifact(
        organizationId,
        Array.from({ length: 1001 }, (_, index) => `a${index}`)
      )
    ).toEqual(new Map());
    expect(log.warn).toHaveBeenCalledWith(
      "telemetry.enrichment_failed",
      expect.objectContaining({
        organizationId,
        artifactCount: 1001,
        enrichmentKind: "project_tree_document_versions",
      })
    );
  });
});
