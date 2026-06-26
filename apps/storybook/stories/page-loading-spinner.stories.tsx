import { PageLoadingSpinner } from "@repo/app/shared/components/page-loading-spinner";
import type { Meta, StoryObj } from "@storybook/react";

const LoadingCanvas = () => (
  <div className="h-48 rounded-lg border">
    <PageLoadingSpinner />
  </div>
);

const meta = {
  title: "Design System/Primitives/Page Loading Spinner",
  component: LoadingCanvas,
  tags: ["autodocs"],
} satisfies Meta<typeof LoadingCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
