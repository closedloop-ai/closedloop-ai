import { ArtifactType } from "@repo/api/src/types/artifact";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

import { mockWithDbCall } from "@/__tests__/utils/db-helpers";
import { sessionActivityAdmissionService } from "./session-activity-admission-service";

const organizationId = "org-1";

describe("sessionActivityAdmissionService.findVisibleArtifactId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("admits only a Session detail owned by the requested organization", async () => {
    const rows = [
      {
        id: "foreign",
        organizationId: "org-2",
        type: ArtifactType.Session,
        hasDetail: true,
      },
      {
        id: "branch",
        organizationId,
        type: ArtifactType.Branch,
        hasDetail: true,
      },
      {
        id: "orphan",
        organizationId,
        type: ArtifactType.Session,
        hasDetail: false,
      },
      {
        id: "owned",
        organizationId,
        type: ArtifactType.Session,
        hasDetail: true,
      },
    ];
    const findFirst = vi.fn(
      async ({
        where,
      }: {
        where: {
          id?: string;
          organizationId?: string;
          type?: string;
          session?: { isNot: null };
        };
        select: { id: true };
      }) =>
        rows.find(
          (row) =>
            (where.id === undefined || row.id === where.id) &&
            (where.organizationId === undefined ||
              row.organizationId === where.organizationId) &&
            (where.type === undefined || row.type === where.type) &&
            (where.session === undefined || row.hasDetail)
        ) ?? null
    );
    mockWithDbCall({ artifact: { findFirst } });

    await expect(
      sessionActivityAdmissionService.findVisibleArtifactId(
        organizationId,
        "foreign"
      )
    ).resolves.toBeNull();
    await expect(
      sessionActivityAdmissionService.findVisibleArtifactId(
        organizationId,
        "branch"
      )
    ).resolves.toBeNull();
    await expect(
      sessionActivityAdmissionService.findVisibleArtifactId(
        organizationId,
        "orphan"
      )
    ).resolves.toBeNull();
    await expect(
      sessionActivityAdmissionService.findVisibleArtifactId(
        organizationId,
        "owned"
      )
    ).resolves.toBe("owned");
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: "owned",
        organizationId,
        type: ArtifactType.Session,
        session: { isNot: null },
      },
      select: { id: true },
    });
  });
});
