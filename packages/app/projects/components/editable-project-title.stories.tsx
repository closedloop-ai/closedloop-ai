import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import type { FixtureRoute } from "../../shared/storybook/fixture-fetch";
import { EditableProjectTitle } from "./editable-project-title";

/**
 * Co-located story for the migrated app-core component (FEA-1510 / AC-001.4):
 * renders the inline-edit title field with its real `useUpdateProject` port
 * under `AppCoreStoryProviders` — no Next.js, Clerk, or live API. Saving runs
 * the mutation against the fixture transport below.
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
 * An inline editable project title styled to read like a heading until
 * clicked, used instead of a labeled text input for ordinary looking page
 * content.
 */
const meta: Meta<typeof EditableProjectTitle> = {
  title: "Composites/My Tasks/Editable Project Title",
  component: EditableProjectTitle,
  tags: ["autodocs"],
  parameters: { appCore: { apiRoutes: projectRoutes } },
  argTypes: {
    initialTitle: { control: "text" },
    onTitleChange: { control: false, table: { category: "Events" } },
    projectId: {
      control: "text",
      description:
        "Project the save mutation targets. The fixture route below answers any id.",
    },
  },
  args: {
    projectId: PROJECT_ID,
    initialTitle: "Q3 Roadmap",
    onTitleChange: fn(),
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Untitled: Story = {
  args: { initialTitle: "" },
};
