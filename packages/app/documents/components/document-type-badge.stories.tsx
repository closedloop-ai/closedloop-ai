import {
  DOCUMENT_TYPE_OPTIONS,
  DocumentType,
} from "@repo/api/src/types/document";
import { DocumentTypeBadge } from "@repo/app/documents/components/document-type-badge";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A small label with an icon showing what kind of document something is,
 * like a PRD or an implementation plan. It comes in two looks: a tinted
 * 'pill' for a colorful summary view, and a plain outlined 'compact' badge
 * that matches a button's styling for a denser list. An unrecognized type
 * still renders, falling back to a question-mark icon and a neutral gray
 * rather than breaking or showing nothing.
 */
const meta = {
  title: "Composites/Documents/Document Type Badge",
  component: DocumentTypeBadge,
  tags: ["autodocs"],
  argTypes: {
    type: { control: { type: "select" }, options: DOCUMENT_TYPE_OPTIONS },
    appearance: { control: { type: "radio" }, options: ["compact", "pill"] },
  },
  parameters: { layout: "padded" },
  args: { type: DocumentType.Prd, appearance: "compact" },
} satisfies Meta<typeof DocumentTypeBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Compact: Story = {
  render: () => (
    <div className="flex flex-wrap gap-3">
      <DocumentTypeBadge type={DocumentType.Prd} />
      <DocumentTypeBadge type={DocumentType.ImplementationPlan} />
      <DocumentTypeBadge type={DocumentType.Template} />
      <DocumentTypeBadge type={DocumentType.Feature} />
      <DocumentTypeBadge type={DocumentType.Doc} />
    </div>
  ),
};

export const Pill: Story = {
  render: () => (
    <div className="flex flex-wrap gap-3">
      <DocumentTypeBadge appearance="pill" type={DocumentType.Prd} />
      <DocumentTypeBadge
        appearance="pill"
        type={DocumentType.ImplementationPlan}
      />
      <DocumentTypeBadge appearance="pill" type={DocumentType.Template} />
      <DocumentTypeBadge appearance="pill" type={DocumentType.Feature} />
      <DocumentTypeBadge appearance="pill" type={DocumentType.Doc} />
    </div>
  ),
};

export const UnknownTypeFallback: Story = {
  render: () => (
    <div className="flex flex-wrap gap-3">
      <DocumentTypeBadge type={"research_brief"} />
      <DocumentTypeBadge appearance="pill" type={"research_brief"} />
    </div>
  ),
};
