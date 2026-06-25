import type { Meta, StoryObj } from "@storybook/react";
import { AppCoreStoryProviders } from "../../shared/storybook/decorators";
import type { FixtureRoute } from "../../shared/storybook/fixture-fetch";
import { EditableProjectDescription } from "./editable-project-description";

/**
 * Co-located story for the migrated app-core component (FEA-1510 / AC-001.4):
 * renders the inline-edit description field with its real `useUpdateProject`
 * port under `AppCoreStoryProviders` — no Next.js, Clerk, or live API. Saving
 * runs the mutation against the fixture transport below.
 */
const PROJECT_ID = "01PROJECT000000000000000";

// useUpdateProject.onSuccess reads result.id/slug/teams, so the fixture must
// return a minimally-shaped ProjectWithDetails (not the default {}).
const projectRoutes: FixtureRoute[] = [
  {
    method: "PUT",
    path: "/projects/*",
    respond: () => ({ id: PROJECT_ID, slug: "q3-roadmap", teams: [] }),
  },
];

const meta: Meta<typeof EditableProjectDescription> = {
  title: "App Core/Projects/Editable Project Description",
  component: EditableProjectDescription,
  decorators: [
    (Story) => (
      <AppCoreStoryProviders apiRoutes={projectRoutes}>
        <Story />
      </AppCoreStoryProviders>
    ),
  ],
  args: {
    projectId: PROJECT_ID,
    initialDescription: "Weekly planning and delivery tracking for the team.",
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: { initialDescription: "" },
};
