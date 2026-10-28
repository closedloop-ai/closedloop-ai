import { TeamRole, type TeamWithCounts } from "@repo/api/src/types/teams";
import { onlineManager } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "../../../shared/test-utils";
import { teamKeys } from "../../hooks/use-teams";
import { useTeamModal } from "../use-team-modal";

it("waits for a paused member read before hydrating drafts and preserves members on reconnect", async () => {
  const queryClient = createTestQueryClient();
  const QueryWrapper = createWrapperWithClient(queryClient);
  const member = {
    id: "member-a",
    teamId: team.id,
    userId: "user-a",
    role: TeamRole.Admin,
    user: {
      id: "user-a",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      avatarUrl: null,
    },
  };
  onlineManager.setOnline(false);
  try {
    const { result, unmount } = renderHook(
      () => useTeamModal({ team, onClose: vi.fn() }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <AppCoreStoryProviders
            apiRoutes={[
              {
                method: "GET",
                path: `/teams/${team.id}/members`,
                respond: () => [member],
              },
              { method: "GET", path: "/me", respond: () => member.user },
              { method: "GET", path: "/users", respond: () => [member.user] },
            ]}
          >
            <QueryWrapper>{children}</QueryWrapper>
          </AppCoreStoryProviders>
        ),
      }
    );
    expect(queryClient.getQueryState(teamKeys.members(team.id))).toMatchObject({
      status: "pending",
      fetchStatus: "paused",
      data: undefined,
    });
    expect(result.current.memberDrafts).toBeNull();
    await act(async () => onlineManager.setOnline(true));
    await waitFor(() =>
      expect(result.current.memberDrafts).toEqual([
        expect.objectContaining({
          teamMemberId: member.id,
          userId: member.userId,
        }),
      ])
    );
    expect(result.current.hasUnsavedChanges).toBe(false);
    expect(result.current.disableSubmit).toBe(true);
    unmount();
  } finally {
    onlineManager.setOnline(true);
    queryClient.clear();
  }
});

const team: TeamWithCounts = {
  id: "team-a",
  organizationId: "org_test",
  name: "Engineering",
  slug: "engineering",
  memberCount: 1,
  projectCount: 0,
  createdAt: new Date("2026-10-19"),
  updatedAt: new Date("2026-10-19"),
};
