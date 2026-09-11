import { DocumentActivitySection } from "@repo/app/documents/components/document-activity-section";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A collapsible 'Activity' section showing when a document was created, who
 * created it, and when it was last updated. Use it as a simple metadata
 * footer on a document's detail page, wherever you don't need the fuller
 * change history a full activity feed would show. When no creator is known,
 * it falls back to a plain label like 'Unknown user' instead of leaving the
 * line blank.
 */
const meta = {
  title: "Composites/Documents/Document Activity Section",
  component: DocumentActivitySection,
  tags: ["autodocs"],
  argTypes: {
    createdByContent: { control: false },
  },
  args: {
    createdAt: "2026-01-05T12:00:00.000Z",
    updatedAt: "2026-01-06T12:00:00.000Z",
    emptyCreatorLabel: "Unknown user",
    defaultOpen: true,
  },
} satisfies Meta<typeof DocumentActivitySection>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithCreatorLink: Story = {
  args: {
    createdByContent: (
      <a className="text-foreground underline" href="/demo/users/123">
        Artifact Creator
      </a>
    ),
  },
};

export const UnknownCreator: Story = {};
