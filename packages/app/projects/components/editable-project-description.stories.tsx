import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
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

/**
 * An inline editable block of text for a project's description, used instead
 * of a form field when it should read like ordinary page text until clicked.
 */
const meta: Meta<typeof EditableProjectDescription> = {
  title: "Composites/My Tasks/Editable Project Description",
  component: EditableProjectDescription,
  tags: ["autodocs"],
  parameters: { appCore: { apiRoutes: projectRoutes } },
  argTypes: {
    initialDescription: { control: "text" },
    onDescriptionChange: { control: false, table: { category: "Events" } },
    projectId: {
      control: "text",
      description:
        "Project the save mutation targets. The fixture route below answers any id.",
    },
  },
  args: {
    projectId: PROJECT_ID,
    initialDescription: "Weekly planning and delivery tracking for the team.",
    onDescriptionChange: fn(),
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: { initialDescription: "" },
};
