import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createDatabaseMockModule } from "../../__tests__/fixtures/mock-modules";

const databaseMocks = vi.hoisted(() => {
  const withDb = vi.fn() as Mock;
  return { withDb };
});

const logMocks = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock("@repo/database", () =>
  createDatabaseMockModule({ withDb: databaseMocks.withDb })
);

vi.mock("@repo/observability/log", () => ({
  log: { error: logMocks.error },
}));

// Imported after the vi.mock calls so the mocked `@repo/database` factory is
// the module this value resolves against.
import { DocumentType } from "@repo/api/src/types/document";
import { MilestoneKind } from "@repo/api/src/types/user";
import { userProfileService } from "./user-profile-service";

/** Default zero/empty responses for every read `getUserProfileHeadline` fans out to. */
function makeHeadlineDb(overrides: {
  groupBy?: { subtype: string | null; _count: { id: number } }[];
}) {
  return {
    artifact: {
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue(overrides.groupBy ?? []),
    },
    comment: { count: vi.fn().mockResolvedValue(0) },
    $queryRaw: () => Promise.resolve([]),
  };
}

describe("userProfileService.getUserProfileHeadline documentsByType subtype filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops rows with a null subtype and keeps typed rows with their counts", async () => {
    databaseMocks.withDb.mockImplementation((fn) =>
      fn(
        makeHeadlineDb({
          groupBy: [
            { subtype: null, _count: { id: 3 } },
            { subtype: DocumentType.Prd, _count: { id: 5 } },
          ],
        })
      )
    );

    const headline = await userProfileService.getUserProfileHeadline(
      "user-1",
      "org-1"
    );

    expect(headline.documentsByType).toEqual([
      { type: DocumentType.Prd, count: 5 },
    ]);
  });
});

describe("userProfileService catch-block error normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rethrows an Error instance and logs its .message from getUserProfileHeadline", async () => {
    const thrown = new Error("headline query failed");
    databaseMocks.withDb.mockRejectedValue(thrown);

    await expect(
      userProfileService.getUserProfileHeadline("user-1", "org-1")
    ).rejects.toBe(thrown);
    expect(logMocks.error).toHaveBeenCalledWith(
      "[users-service] Failed to get user profile headline",
      expect.objectContaining({ error: "headline query failed" })
    );
  });

  it("rethrows a non-Error value and logs its String() form from getUserProfileHeadline", async () => {
    databaseMocks.withDb.mockRejectedValue("headline-boom");

    await expect(
      userProfileService.getUserProfileHeadline("user-1", "org-1")
    ).rejects.toBe("headline-boom");
    expect(logMocks.error).toHaveBeenCalledWith(
      "[users-service] Failed to get user profile headline",
      expect.objectContaining({ error: "headline-boom" })
    );
  });

  it("rethrows an Error instance and logs its .message from getUserContributionHeatmap", async () => {
    const thrown = new Error("heatmap query failed");
    databaseMocks.withDb.mockRejectedValue(thrown);

    await expect(
      userProfileService.getUserContributionHeatmap("user-1", "org-1")
    ).rejects.toBe(thrown);
    expect(logMocks.error).toHaveBeenCalledWith(
      "[users-service] Failed to get user contribution heatmap",
      expect.objectContaining({ error: "heatmap query failed" })
    );
  });

  it("rethrows a non-Error value and logs its String() form from getUserContributionHeatmap", async () => {
    databaseMocks.withDb.mockRejectedValue("heatmap-boom");

    await expect(
      userProfileService.getUserContributionHeatmap("user-1", "org-1")
    ).rejects.toBe("heatmap-boom");
    expect(logMocks.error).toHaveBeenCalledWith(
      "[users-service] Failed to get user contribution heatmap",
      expect.objectContaining({ error: "heatmap-boom" })
    );
  });

  it("rethrows an Error instance and logs its .message from getUserProfileStanding", async () => {
    const thrown = new Error("standing query failed");
    databaseMocks.withDb.mockRejectedValue(thrown);

    await expect(
      userProfileService.getUserProfileStanding("user-1", "org-1")
    ).rejects.toBe(thrown);
    expect(logMocks.error).toHaveBeenCalledWith(
      "[users-service] Failed to get user profile standing",
      expect.objectContaining({ error: "standing query failed" })
    );
  });

  it("rethrows a non-Error value and logs its String() form from getUserProfileStanding", async () => {
    databaseMocks.withDb.mockRejectedValue("standing-boom");

    await expect(
      userProfileService.getUserProfileStanding("user-1", "org-1")
    ).rejects.toBe("standing-boom");
    expect(logMocks.error).toHaveBeenCalledWith(
      "[users-service] Failed to get user profile standing",
      expect.objectContaining({ error: "standing-boom" })
    );
  });

  it("rethrows an Error instance and logs its .message from getUserProfileMilestones", async () => {
    const thrown = new Error("milestones query failed");
    databaseMocks.withDb.mockRejectedValue(thrown);

    await expect(
      userProfileService.getUserProfileMilestones("user-1", "org-1")
    ).rejects.toBe(thrown);
    expect(logMocks.error).toHaveBeenCalledWith(
      "[users-service] Failed to get user profile milestones",
      expect.objectContaining({ error: "milestones query failed" })
    );
  });

  it("rethrows a non-Error value and logs its String() form from getUserProfileMilestones", async () => {
    databaseMocks.withDb.mockRejectedValue("milestones-boom");

    await expect(
      userProfileService.getUserProfileMilestones("user-1", "org-1")
    ).rejects.toBe("milestones-boom");
    expect(logMocks.error).toHaveBeenCalledWith(
      "[users-service] Failed to get user profile milestones",
      expect.objectContaining({ error: "milestones-boom" })
    );
  });
});

describe("userProfileService.getUserProfileMilestones documents milestone with a falsy crossing timestamp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips a crossed documents threshold whose stored createdAt is null", async () => {
    // 10 document rows crosses the first DOCUMENTS_THRESHOLDS entry (10), but
    // the row AT that index (pins current 0-based indexing: timestamps[9])
    // stores no createdAt. earnedThresholdMilestones must not emit a
    // milestone it cannot date.
    const docRows: { createdAt: Date | null }[] = Array.from(
      { length: 9 },
      (_, i) => ({ createdAt: new Date(Date.UTC(2026, 0, i + 1)) })
    );
    docRows.push({ createdAt: null });

    const db = {
      artifact: { findMany: vi.fn().mockResolvedValue(docRows) },
      $queryRaw: () => Promise.resolve([]),
    };
    databaseMocks.withDb.mockImplementation((fn) => fn(db));

    const { milestones } = await userProfileService.getUserProfileMilestones(
      "user-1",
      "org-1"
    );

    expect(
      milestones.filter((m) => m.kind === MilestoneKind.DocumentsCreated)
    ).toEqual([]);
  });
});
