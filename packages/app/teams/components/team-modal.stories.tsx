import { TeamRole, type TeamWithCounts } from "@repo/api/src/types/teams";
import { ApproverRole, type User } from "@repo/api/src/types/user";
import type { Meta, StoryObj } from "@storybook/react";
import type { QueryKey } from "@tanstack/react-query";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import type { FixtureRoute } from "../../shared/storybook/fixture-fetch";
import { userKeys } from "../../users/hooks/use-users";
import { teamKeys } from "../hooks/use-teams";
import { TeamModal } from "./team-modal";

const team: TeamWithCounts = {
  id: "team-engineering",
  organizationId: "org_test",
  name: "Engineering",
  slug: "engineering",
  memberCount: 1,
  projectCount: 2,
  createdAt: new Date("2026-10-19"),
  updatedAt: new Date("2026-10-19"),
};
const repositories = [
  {
    id: "team-repo",
    teamId: team.id,
    installationRepositoryId: "repo-core",
    isDefaultSelected: true,
    isPrimary: true,
    createdAt: new Date("2026-10-19"),
    updatedAt: new Date("2026-10-19"),
    repository: {
      id: "repo-core",
      installationId: "installation-test",
      githubRepoId: "github-core",
      fullName: "closedloop-ai/core",
      name: "core",
      owner: "closedloop-ai",
      private: true,
    },
  },
];
const currentUser: User = {
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
  createdAt: new Date("2026-10-19"),
  updatedAt: new Date("2026-10-19"),
};

type DialogFixtureProps = { mode: "create" | "edit" };

type DialogFixtureData = {
  authority: "member" | "admin";
  roster: "available" | "loading" | "unresolved";
  save: "success" | "failure";
};

function DialogFixture({ mode }: DialogFixtureProps) {
  const [open, setOpen] = useState(true);
  return (
    <TeamModal
      onOpenChange={setOpen}
      open={open}
      team={mode === "edit" ? team : undefined}
    />
  );
}

const meta = {
  title: "Composites/Your Teams/Team Modal",
  component: DialogFixture,
  tags: ["stable"],
  args: { mode: "edit" },
  argTypes: {
    mode: { control: "inline-radio", options: ["create", "edit"] },
  },
  parameters: { appCore: dialogAppCore() },
} satisfies Meta<typeof DialogFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = {
  parameters: { appCore: dialogAppCore({ roster: "loading" }) },
};
// biome-ignore lint/suspicious/noShadowRestrictedNames: named Error state follows the Storybook state taxonomy.
export const Error: Story = {
  parameters: { appCore: dialogAppCore({ roster: "unresolved" }) },
};
export const NoPermission: Story = {
  parameters: { appCore: dialogAppCore({ authority: "member" }) },
};
export const Create: Story = { args: { mode: "create" } };
export const SaveFailure: Story = {
  parameters: { appCore: dialogAppCore({ save: "failure" }) },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.type(await body.findByLabelText("Team Name"), " Platform");
    await userEvent.click(body.getByRole("button", { name: "Save Changes" }));
    await expect(await body.findByText("Fixture request failed")).toBeVisible();
    await expect(body.getByLabelText("Team Name")).toHaveValue(
      "Engineering Platform"
    );
  },
};
export const RepositoryDefaults: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await body.findByRole("tab", { name: "Repositories" })
    );
    await expect(await body.findByText("closedloop-ai/core")).toBeVisible();
    await expect(body.getByRole("checkbox", { name: "Default" })).toBeChecked();
    await expect(body.getByRole("radio", { name: "Primary" })).toBeChecked();
  },
};
export const StagedEdits: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await body.findByRole("combobox", { name: "Team Members" })
    );
    await userEvent.click(
      await body.findByRole("option", { name: graceHopperOption })
    );
    await userEvent.click(body.getByRole("button", { name: "Add member" }));
    await expect(await body.findByText("grace@example.com")).toBeVisible();
    await expect(
      body.getByRole("button", { name: "Save Changes" })
    ).toBeEnabled();
  },
};

const graceHopperOption = /Grace Hopper/;

function dialogAppCore({
  authority = "admin",
  roster = "available",
  save = "success",
}: Partial<DialogFixtureData> = {}): {
  apiRoutes: FixtureRoute[];
  queryData: ReadonlyArray<readonly [QueryKey, unknown]>;
} {
  const member = {
    id: "member-ada",
    teamId: team.id,
    userId: currentUser.id,
    user: currentUser,
    role: authority === "admin" ? TeamRole.Owner : TeamRole.Member,
    createdAt: new Date("2026-10-19"),
  };
  return {
    apiRoutes: [
      {
        method: "GET",
        path: "/users",
        status: roster === "unresolved" ? 503 : 200,
        respond: () =>
          roster === "loading" ? new Promise(() => {}) : [currentUser],
      },
      {
        method: "GET",
        path: `/teams/${team.id}/members`,
        respond: () => [member],
      },
      {
        method: "GET",
        path: `/teams/${team.id}/repositories`,
        respond: () => repositories,
      },
      {
        method: "GET",
        path: "/integrations/github/repositories",
        respond: () => [],
      },
      {
        method: "PUT",
        path: `/teams/${team.id}`,
        status: save === "failure" ? 503 : 200,
        respond: () => team,
      },
      {
        method: "POST",
        path: "/teams",
        status: save === "failure" ? 503 : 200,
        respond: () => team,
      },
    ],
    queryData: [
      [userKeys.currentUser(), currentUser],
      [teamKeys.members(team.id), [member]],
      [teamKeys.repositories(team.id), repositories],
      ...(roster === "available"
        ? [
            [
              userKeys.organizationUsers(),
              [
                currentUser,
                {
                  ...currentUser,
                  id: "user-grace",
                  firstName: "Grace",
                  lastName: "Hopper",
                  email: "grace@example.com",
                },
              ],
            ] as const,
          ]
        : []),
    ],
  };
}
