/**
 * ISS-5490: the onboarding checklist's completion is derived from live data, so
 * these cover what each row actually keys off — in particular the desktop row
 * added when the wizard stopped gating on the download.
 */

import { ChecklistItemId } from "@repo/api/src/types/onboarding";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Partial, not total: the service's `where` builders reference the real
// `GitHubInstallationStatus` members, and a total mock would have to restate
// those values here.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: vi.fn(),
}));

const { withDb } = await import("@repo/database");
const { onboardingService } = await import("./service");

/**
 * Written out rather than imported from the service (ISS-9708). Reading the
 * expected value back from the constant the row is built from would pass against
 * any URL that constant happened to hold — including the macOS `.dmg` this issue
 * exists to remove.
 */
const EXPECTED_DESKTOP_HREF =
  "https://github.com/closedloop-ai/closedloop-ai/releases/tag/desktop-latest";

/** Per-platform installer basenames the row must never name. */
const MACOS_INSTALLER_SUFFIX = /\.dmg$/;
const OTHER_PLATFORM_INSTALLER_SUFFIX = /\.(exe|msi|deb|rpm|AppImage)$/;

/**
 * Every key an already-installed client knows this row by. Pinned as a set so an
 * additive field cannot arrive here without a deliberate edit, which is what
 * keeps the compatibility answer in the PR body honest.
 */
const DESKTOP_ROW_KEYS = [
  "completed",
  "description",
  "external",
  "href",
  "id",
  "label",
];

const ORG_ID = "org-1";
const USER_ID = "user-1";

type DbOverrides = {
  teamCount?: number;
  projectCount?: number;
  computeTarget?: { id: string } | null;
  githubInstallation?: { id: string } | null;
  googleIntegration?: { id: string } | null;
  userCount?: number;
  callerDismissedAt?: Date | null;
  invitesSentAt?: string | null;
  githubUserConnection?: { revokedAt: Date | null; scopes: string[] } | null;
};

const computeTargetFindFirst = vi.fn();

function stubDb(overrides: DbOverrides = {}) {
  computeTargetFindFirst.mockResolvedValue(overrides.computeTarget ?? null);

  const db = {
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        settings: {
          onboarding: {
            wizardCompletedAt: "2026-08-01T00:00:00Z",
            invitesSentAt: overrides.invitesSentAt ?? null,
          },
        },
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
    // ISS-11246: the ConnectGitHub row now ORs the installation with the
    // caller's own usable GitHub grant, so `getStatus` reads this delegate too.
    gitHubUserConnection: {
      findUnique: vi
        .fn()
        .mockResolvedValue(overrides.githubUserConnection ?? null),
    },
    googleIntegration: {
      findUnique: vi
        .fn()
        .mockResolvedValue(overrides.googleIntegration ?? null),
    },
    user: {
      count: vi.fn().mockResolvedValue(overrides.userCount ?? 1),
      // ISS-5991: the caller's own dismissal timestamp, read org-scoped.
      findFirst: vi.fn().mockResolvedValue({
        onboardingChecklistDismissedAt: overrides.callerDismissedAt ?? null,
      }),
    },
    // The caller has no guided run; completion comes from the marker above.
    onboardingAttempt: { findFirst: vi.fn().mockResolvedValue(null) },
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

async function getInviteItem() {
  const status = await onboardingService.getStatus(ORG_ID, USER_ID);
  return status.checklist.find(
    (item) => item.id === ChecklistItemId.InviteMembers
  );
}

/**
 * ISS-7089: the row asks the admin to invite someone, and that act is finished
 * when the invitation is sent. Acceptance happens on the invitee's clock and
 * can take days, so keying only on a second member row left the admin looking
 * at an unticked row right after inviting.
 */
describe("onboarding checklist — invite row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stays incomplete for a lone member who has invited nobody", async () => {
    stubDb({ userCount: 1, invitesSentAt: null });

    expect((await getInviteItem())?.completed).toBe(false);
  });

  it("completes on a recorded send, before the invitee accepts", async () => {
    stubDb({ userCount: 1, invitesSentAt: "2026-08-19T00:00:00Z" });

    expect((await getInviteItem())?.completed).toBe(true);
  });

  it("completes on a second member for an org that never recorded a send", async () => {
    stubDb({ userCount: 2, invitesSentAt: null });

    expect((await getInviteItem())?.completed).toBe(true);
  });

  it("points at the members deep link inside the organization tab", async () => {
    stubDb({ userCount: 1 });

    expect((await getInviteItem())?.href).toBe(
      "/settings?tab=organization#/organization-members"
    );
  });
});

describe("onboarding checklist — desktop download row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("points a brand-new user at the public mirror, not the private repo", async () => {
    stubDb();

    const item = await getDesktopItem();

    // A signed-up user has no reason to have access to closedloop-ai, where
    // this same page 404s.
    expect(item?.href).toBe(EXPECTED_DESKTOP_HREF);
    expect(item?.external).toBe(true);
  });

  /**
   * ISS-9708 AC1/AC2. This row is built without knowing the reader's platform,
   * so a per-platform asset URL here is wrong for two of the three platforms and
   * no client-side correction can be trusted to have run yet — the row renders
   * before PostHog's anonymous bootstrap resolves the signed-in user's flags.
   *
   * The `.dmg` is excluded by name and not merely by inequality with the
   * expected value: the defect was one specific artifact reaching every reader,
   * and a future edit that swapped it for the Windows installer would be the same
   * bug with a different filename.
   */
  it("names no platform in the download target, so no reader is misrouted", async () => {
    stubDb();

    const href = (await getDesktopItem())?.href ?? "";

    expect(href).not.toMatch(MACOS_INSTALLER_SUFFIX);
    expect(href).not.toMatch(OTHER_PLATFORM_INSTALLER_SUFFIX);
    expect(href).not.toContain("/releases/download/");
  });

  /**
   * ISS-9708 AC4. The fix keeps the row's SHAPE exactly as it was — one `href`
   * plus `external` — so an already-installed client that predates it renders a
   * working control with no fallback to reach for. That is only true while
   * nothing new appears on the row, and a new field would have to be optional
   * and OMITTED when absent rather than serialized `null`, so both halves are
   * pinned here.
   */
  it("keeps the row shape an older client already understands", async () => {
    stubDb();

    const item = await getDesktopItem();

    expect(Object.keys(item ?? {}).sort()).toEqual(DESKTOP_ROW_KEYS);
    expect(Object.values(item ?? {}).some((value) => value === null)).toBe(
      false
    );
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

/**
 * ISS-7089 F5: the row set the server emits is the spec's row set. ISS-5490
 * FR-6 promised six rows, and seven wherever the `google-drive` flag is on;
 * ISS-12435 (PRD-795) removed the "Add Anthropic API key" row with the stored
 * key it asked for, so five and six. The flag lives on the client, so the
 * server always emits all six and the count the reader sees is decided by the
 * filter in `useOnboardingChecklist`.
 * Both halves are pinned (the other half in that hook's test) so a new row
 * cannot silently change what FR-6 promises.
 */
describe("onboarding checklist — row set", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits every declared row, in spec order", async () => {
    stubDb();

    const status = await onboardingService.getStatus(ORG_ID, USER_ID);

    expect(status.checklist.map((item) => item.id)).toEqual([
      ChecklistItemId.CreateTeam,
      ChecklistItemId.CreateProject,
      ChecklistItemId.DownloadDesktop,
      ChecklistItemId.ConnectGitHub,
      ChecklistItemId.ConnectGoogle,
      ChecklistItemId.InviteMembers,
    ]);
  });

  it("derives two complete rows for a fresh workspace — the '2 of 5' the spec promises", async () => {
    stubDb({
      teamCount: 1,
      projectCount: 1,
      computeTarget: null,
      githubInstallation: null,
      googleIntegration: null,
      userCount: 1,
      invitesSentAt: null,
    });

    const status = await onboardingService.getStatus(ORG_ID, USER_ID);

    expect(
      status.checklist.filter((item) => item.completed).map((i) => i.id)
    ).toEqual([ChecklistItemId.CreateTeam, ChecklistItemId.CreateProject]);
  });

  it("keeps the GitHub and Desktop prerequisite rows the agent card used to restate", async () => {
    // ISS-7089 F6 deleted `AgentOnboardingCard`, which listed Connect GitHub and
    // Install Desktop off different signals than these rows. These are now the
    // only statements of those two prerequisites on My Tasks.
    stubDb({
      githubInstallation: { id: "gh-1" },
      computeTarget: { id: "ct-1" },
    });

    const status = await onboardingService.getStatus(ORG_ID, USER_ID);
    const byId = new Map(status.checklist.map((item) => [item.id, item]));

    expect(byId.get(ChecklistItemId.ConnectGitHub)?.completed).toBe(true);
    expect(byId.get(ChecklistItemId.DownloadDesktop)?.completed).toBe(true);
  });
});
