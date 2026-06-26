import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import type { Meta, StoryObj } from "@storybook/react";

const ToneBadgeGallery = () => (
  <div className="flex flex-wrap gap-2">
    <ToneBadge label="Default" tone="default" />
    <ToneBadge label="Success" pulse tone="success" />
    <ToneBadge label="Warning" tone="warning" />
    <ToneBadge label="Danger" tone="danger" />
    <ToneBadge label="Info" tone="info" />
    <ToneBadge label="Accent" tone="accent" />
    <ToneBadge label="Muted" tone="muted" />
  </div>
);

const meta = {
  title: "Design System/Primitives/Status Badge",
  component: ToneBadgeGallery,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof ToneBadgeGallery>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
