/**
 * Unit tests for onboardingService.getStatus.
 *
 * Verifies that the checklist does not include a ConnectLinear item and that
 * all six expected checklist items are returned with correct ids.
 */

import { describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

import { ChecklistItemId } from "@repo/api/src/types/onboarding";
import { withDb } from "@repo/database";
import { onboardingService } from "@/app/onboarding/service";

const mockWithDb = withDb as unknown as Mock;

const ORG_ID = "org-1";

/**
 * Set up the six sequential withDb calls that getStatus makes:
 *   1. organization.findUnique (org settings + claudeApiKeyEncrypted)
 *   2. team.count
 *   3. project.count
 *   4. gitHubInstallation.findFirst
 *   5. googleIntegration.findUnique
 *   6. user.count
 */
function mockGetStatusCalls({
  org = { settings: {}, claudeApiKeyEncrypted: null },
  teamCount = 0,
  projectCount = 0,
  githubInstallation = null,
  googleIntegration = null,
  userCount = 1,
}: {
  org?: { settings: object; claudeApiKeyEncrypted: string | null };
  teamCount?: number;
  projectCount?: number;
  githubInstallation?: { id: string } | null;
  googleIntegration?: { id: string } | null;
  userCount?: number;
} = {}) {
  mockWithDb
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({
        organization: {
          findUnique: vi.fn().mockResolvedValue(org),
        },
      })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ team: { count: vi.fn().mockResolvedValue(teamCount) } })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ project: { count: vi.fn().mockResolvedValue(projectCount) } })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(githubInstallation),
        },
      })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({
        googleIntegration: {
          findUnique: vi.fn().mockResolvedValue(googleIntegration),
        },
      })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ user: { count: vi.fn().mockResolvedValue(userCount) } })
    );
}

describe("onboardingService.getStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not include a ConnectLinear item in the checklist", async () => {
    mockGetStatusCalls();

    const status = await onboardingService.getStatus(ORG_ID);

    const ids = status.checklist.map((item) => item.id);
    expect(ids).not.toContain("CONNECT_LINEAR");
  });

  it("returns exactly the six expected checklist items in order", async () => {
    mockGetStatusCalls();

    const status = await onboardingService.getStatus(ORG_ID);

    expect(status.checklist).toHaveLength(6);
    expect(status.checklist.map((item) => item.id)).toEqual([
      ChecklistItemId.CreateTeam,
      ChecklistItemId.CreateProject,
      ChecklistItemId.ConnectGitHub,
      ChecklistItemId.AddAnthropicKey,
      ChecklistItemId.ConnectGoogle,
      ChecklistItemId.InviteMembers,
    ]);
  });

  it("marks CreateTeam complete when teamCount is greater than zero", async () => {
    mockGetStatusCalls({ teamCount: 1 });

    const status = await onboardingService.getStatus(ORG_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.CreateTeam
    );
    expect(item?.completed).toBe(true);
  });

  it("marks CreateTeam incomplete when teamCount is zero", async () => {
    mockGetStatusCalls({ teamCount: 0 });

    const status = await onboardingService.getStatus(ORG_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.CreateTeam
    );
    expect(item?.completed).toBe(false);
  });

  it("marks ConnectGitHub complete when a GitHub installation exists", async () => {
    mockGetStatusCalls({ githubInstallation: { id: "install-1" } });

    const status = await onboardingService.getStatus(ORG_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.ConnectGitHub
    );
    expect(item?.completed).toBe(true);
  });

  it("marks ConnectGitHub incomplete when no GitHub installation exists", async () => {
    mockGetStatusCalls({ githubInstallation: null });

    const status = await onboardingService.getStatus(ORG_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.ConnectGitHub
    );
    expect(item?.completed).toBe(false);
  });

  it("marks ConnectGoogle complete when a Google integration exists", async () => {
    mockGetStatusCalls({ googleIntegration: { id: "google-1" } });

    const status = await onboardingService.getStatus(ORG_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.ConnectGoogle
    );
    expect(item?.completed).toBe(true);
  });

  it("marks AddAnthropicKey complete when claudeApiKeyEncrypted is set", async () => {
    mockGetStatusCalls({
      org: { settings: {}, claudeApiKeyEncrypted: "encrypted-value" },
    });

    const status = await onboardingService.getStatus(ORG_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.AddAnthropicKey
    );
    expect(item?.completed).toBe(true);
  });

  it("marks InviteMembers complete when userCount is greater than one", async () => {
    mockGetStatusCalls({ userCount: 2 });

    const status = await onboardingService.getStatus(ORG_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.InviteMembers
    );
    expect(item?.completed).toBe(true);
  });

  it("marks InviteMembers incomplete when userCount is one", async () => {
    mockGetStatusCalls({ userCount: 1 });

    const status = await onboardingService.getStatus(ORG_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.InviteMembers
    );
    expect(item?.completed).toBe(false);
  });
});
