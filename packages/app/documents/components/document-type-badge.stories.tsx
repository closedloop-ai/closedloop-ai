import { DocumentType } from "@repo/api/src/types/document";
import { DocumentTypeBadge } from "@repo/app/documents/components/document-type-badge";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "App Core/Documents/Document Type Badge",
  component: DocumentTypeBadge,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { type: DocumentType.Prd },
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
