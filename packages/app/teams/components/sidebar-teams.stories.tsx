import { TeamRole } from "@repo/api/src/types/teams";
import { ApproverRole, type User } from "@repo/api/src/types/user";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import type { Meta, StoryObj } from "@storybook/react";
import type { QueryKey } from "@tanstack/react-query";
import type { FixtureRoute } from "../../shared/storybook/fixture-fetch";
import { teamKeys } from "../hooks/use-teams";
import { SidebarTeams } from "./sidebar-teams";

const team = {
  id: "019c24dc-9445-75ec-8136-c4e6d83147fa",
  name: "Engineering",
  slug: "engineering",
  memberCount: 3,
  projectCount: 2,
  organizationId: "org_test",
  createdAt: new Date("2026-10-19"),
  updatedAt: new Date("2026-10-19"),
};

const user: User = {
  id: "user_test",
  clerkId: "clerk-test",
  organizationId: "org_test",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  avatarUrl: null,
  phoneNumber: null,
  role: ApproverRole.Engineer,
  linearId: null,
  slackId: null,
  githubUsername: null,
  active: true,
  createdAt: team.createdAt,
  updatedAt: team.updatedAt,
};

type TeamsFixtureState = "populated" | "empty" | "error";

function TeamsFixture({ host }: { host: "web" | "desktop" }) {
  return (
    <SidebarProvider>
      <div className="w-64">
        <SidebarTeams
          buildProjectsHref={(teamId) =>
            `${host === "web" ? "/closedloop-ai" : ""}/teams/${teamId}/projects`
          }
        />
      </div>
    </SidebarProvider>
  );
}

const meta = {
  title: "Composites/Your Teams/Sidebar Teams",
  component: TeamsFixture,
  tags: ["stable"],
  args: { host: "web" },
  argTypes: {
    host: { control: "inline-radio", options: ["web", "desktop"] },
  },
  parameters: { appCore: teamsAppCore("populated") },
} satisfies Meta<typeof TeamsFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = {
  parameters: { appCore: teamsAppCore("empty") },
};
export const Unavailable: Story = {
  parameters: { appCore: teamsAppCore("error") },
};
export const Desktop: Story = { args: { host: "desktop" } };

function teamsAppCore(state: TeamsFixtureState): {
  apiRoutes: FixtureRoute[];
  queryData: ReadonlyArray<readonly [QueryKey, unknown]>;
} {
  return {
    apiRoutes: [
      {
        method: "GET",
        path: "/teams",
        status: state === "error" ? 503 : 200,
        respond: () => [],
      },
      { method: "GET", path: "/projects/favorites", respond: () => [] },
      { method: "GET", path: "/me", respond: () => user },
      { method: "GET", path: "/users", respond: () => [user] },
      {
        method: "GET",
        path: `/teams/${team.id}/members`,
        respond: () => [
          {
            id: "member-ada",
            teamId: team.id,
            userId: user.id,
            role: TeamRole.Owner,
            user,
            createdAt: team.createdAt,
          },
        ],
      },
      {
        method: "GET",
        path: `/teams/${team.id}/repositories`,
        respond: () => [],
      },
      {
        method: "GET",
        path: "/integrations/github/repositories",
        respond: () => [],
      },
      { method: "POST", path: "/teams", respond: () => team },
      { method: "PUT", path: `/teams/${team.id}`, respond: () => team },
      {
        method: "DELETE",
        path: `/teams/${team.id}`,
        respond: () => ({ deleted: true }),
      },
    ],
    queryData:
      state === "error"
        ? []
        : [[teamKeys.lists(), state === "empty" ? [] : [team]]],
  };
}
