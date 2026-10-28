import { DocumentActivitySection } from "@repo/app/documents/components/document-activity-section";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Composites v1.0/Documents/Document Activity Section",
  component: DocumentActivitySection,
  tags: ["deprecated", "autodocs"],
  args: {
    createdAt: "2026-01-05T12:00:00.000Z",
    updatedAt: "2026-01-06T12:00:00.000Z",
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
