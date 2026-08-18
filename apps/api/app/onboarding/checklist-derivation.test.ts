/**
 * ISS-5490: the onboarding checklist's completion is derived from live data, so
 * these cover what each row actually keys off — in particular the desktop row
 * added when the wizard stopped gating on the download.
 */

import { ChecklistItemId } from "@repo/api/src/types/onboarding";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

const { withDb } = await import("@repo/database");
const { onboardingService, DESKTOP_LATEST_DMG_URL } = await import("./service");

const ORG_ID = "org-1";
const USER_ID = "user-1";

type DbOverrides = {
  teamCount?: number;
  projectCount?: number;
  computeTarget?: { id: string } | null;
  githubInstallation?: { id: string } | null;
  googleIntegration?: { id: string } | null;
  userCount?: number;
  claudeApiKeyEncrypted?: string | null;
};

const computeTargetFindFirst = vi.fn();

function stubDb(overrides: DbOverrides = {}) {
  computeTargetFindFirst.mockResolvedValue(overrides.computeTarget ?? null);

  const db = {
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        settings: { onboarding: { wizardCompletedAt: "2026-08-01T00:00:00Z" } },
        claudeApiKeyEncrypted: overrides.claudeApiKeyEncrypted ?? null,
      }),
    },
    team: { count: vi.fn().mockResolvedValue(overrides.teamCount ?? 1) },
    project: { count: vi.fn().mockResolvedValue(overrides.projectCount ?? 1) },
    computeTarget: { findFirst: computeTargetFindFirst },
    gitHubInstallation: {
      findFirst: vi
        .fn()
        .mockResolvedValue(overrides.githubInstallation ?? null),
    },
    googleIntegration: {
      findUnique: vi
        .fn()
        .mockResolvedValue(overrides.googleIntegration ?? null),
    },
    user: { count: vi.fn().mockResolvedValue(overrides.userCount ?? 1) },
  };

  vi.mocked(withDb).mockImplementation((cb) =>
    Promise.resolve(cb(db as never))
  );
}

async function getDesktopItem() {
  const status = await onboardingService.getStatus(ORG_ID, USER_ID);
  return status.checklist.find(
    (item) => item.id === ChecklistItemId.DownloadDesktop
  );
}

describe("onboarding checklist — desktop download row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("points a brand-new user at the public mirror, not the private repo", async () => {
    stubDb();

    const item = await getDesktopItem();

    // A signed-up user has no reason to have access to symphony-alpha, where
    // this same asset path 404s.
    expect(item?.href).toBe(DESKTOP_LATEST_DMG_URL);
    expect(item?.external).toBe(true);
  });

  it("stays incomplete until a real desktop registers", async () => {
    stubDb({ computeTarget: null });

    expect((await getDesktopItem())?.completed).toBe(false);
  });

  it("completes once a compute target exists", async () => {
    stubDb({ computeTarget: { id: "ct-1" } });

    expect((await getDesktopItem())?.completed).toBe(true);
  });

  it("asks whether THIS user installed, not whether anyone in the org did", async () => {
    stubDb();

    await getDesktopItem();

    // Two filters, two reasons. `isCloudSentinel: false` because the per-org
    // cloud sentinel has no device behind it, so counting it would tick this row
    // for an org that never installed anything. `userId` because installing is a
    // per-person act and this row is the only surface still pointing at the
    // download — org scope would hand every teammate who joined after the first
    // install a ticked row and no link.
    expect(computeTargetFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG_ID,
          userId: USER_ID,
          isCloudSentinel: false,
        },
      })
    );
  });

  it("sends the desktop row off-app and every other destination in-app", async () => {
    stubDb();

    const status = await onboardingService.getStatus(ORG_ID, USER_ID);

    for (const item of status.checklist) {
      if (item.href === undefined) {
        continue;
      }
      // `external` is what stops the checklist routing an absolute URL through
      // the in-app navigation Link, so the two must not disagree.
      expect(
        item.external === true,
        `${item.id} external flag disagrees with its href`
      ).toBe(item.href.startsWith("http"));
    }
  });
});
