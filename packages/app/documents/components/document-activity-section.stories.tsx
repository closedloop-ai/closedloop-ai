import { DocumentActivitySection } from "@repo/app/documents/components/document-activity-section";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A collapsible Activity section showing when a document was created, by
 * whom, and when it was last updated, a simple metadata footer rather than a
 * fuller history feed.
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
