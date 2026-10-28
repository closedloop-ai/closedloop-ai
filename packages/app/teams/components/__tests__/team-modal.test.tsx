import { TeamRole, type TeamWithCounts } from "@repo/api/src/types/teams";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { userKeys } from "../../../users/hooks/use-users";
import { teamKeys } from "../../hooks/use-teams";
import { TeamModal } from "../team-modal";

const user = {
  id: "user_test",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  avatarUrl: null,
};
const team: TeamWithCounts = {
  id: "team-a",
  organizationId: "org_test",
  name: "Engineering",
  slug: "engineering",
  memberCount: 1,
  projectCount: 1,
  createdAt: new Date("2026-10-19"),
  updatedAt: new Date("2026-10-19"),
};
function Host({
  selectedTeam = team,
  open = true,
  orgId = "org_test",
}: {
  selectedTeam?: TeamWithCounts;
  open?: boolean;
  orgId?: string;
}) {
  return (
    <AppCoreStoryProviders
      queryData={[
        [userKeys.currentUser(), user],
        [userKeys.organizationUsers(), [user]],
        [
          teamKeys.members(team.id),
          [
            {
              id: "member-a",
              teamId: team.id,
              userId: user.id,
              role: TeamRole.Owner,
              user,
            },
          ],
        ],
        [teamKeys.members("team-b"), []],
      ]}
    >
      <AuthAdapterProvider adapter={createStaticAuthAdapter({ orgId })}>
        <TeamModal onOpenChange={vi.fn()} open={open} team={selectedTeam} />
      </AuthAdapterProvider>
    </AppCoreStoryProviders>
  );
}

describe("portable Teams dialog", () => {
  it("renders legacy owner rows as admin without granting a new role or writing", async () => {
    render(<Host />);
    expect(await screen.findByText("Ada Lovelace")).toBeVisible();
    expect(
      screen.getAllByRole("combobox", { name: "Role" })[1]
    ).toHaveTextContent("Admin");
    expect(screen.getAllByRole("combobox", { name: "Role" })[1]).toBeDisabled();
    expect(screen.queryByText("Owner")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });

  it("discards drafts when switching team identity in the same open dialog", async () => {
    const { rerender } = render(<Host />);
    await screen.findByText("Ada Lovelace");
    fireEvent.change(screen.getByLabelText("Team Name"), {
      target: { value: "Unsaved draft" },
    });
    rerender(<Host selectedTeam={{ ...team, id: "team-b", name: "Design" }} />);
    await waitFor(() =>
      expect(screen.getByLabelText("Team Name")).toHaveValue("Design")
    );
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
    expect(
      screen.getByText("No members yet. Add members above.")
    ).toBeVisible();
  });

  it("discards drafts when the host changes organization", async () => {
    const { rerender } = render(<Host />);
    await screen.findByText("Ada Lovelace");
    fireEvent.change(screen.getByLabelText("Team Name"), {
      target: { value: "Unsaved draft" },
    });
    rerender(<Host orgId="org_other" />);
    expect(screen.getByLabelText("Team Name")).toHaveValue("Engineering");
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });

  it("discards drafts on cancel and reopen", async () => {
    const { rerender } = render(<Host />);
    await screen.findByText("Ada Lovelace");
    fireEvent.change(screen.getByLabelText("Team Name"), {
      target: { value: "Unsaved draft" },
    });
    rerender(<Host open={false} />);
    rerender(<Host open={true} />);
    expect(screen.getByLabelText("Team Name")).toHaveValue("Engineering");
  });

  it("surfaces a roster failure without claiming there are no users", async () => {
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/users",
            status: 503,
            error: "Organization roster unavailable",
            respond: () => [],
          },
        ]}
        queryData={[[userKeys.currentUser(), user]]}
      >
        <TeamModal onOpenChange={vi.fn()} open={true} />
      </AppCoreStoryProviders>
    );
    expect(
      await screen.findByText("Organization roster unavailable")
    ).toBeVisible();
    expect(screen.queryByText("No users available")).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Team Members" })
    ).toBeDisabled();
    expect(screen.getByText("Ada Lovelace")).toBeVisible();
  });
});
