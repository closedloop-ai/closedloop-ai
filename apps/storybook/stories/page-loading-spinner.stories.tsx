import { PageLoadingSpinner } from "@repo/app/shared/components/page-loading-spinner";
import type { Meta, StoryObj } from "@storybook/react";

const LoadingCanvas = () => (
  <div className="h-48 rounded-lg border">
    <PageLoadingSpinner />
  </div>
);

const meta = {
  title: "Primitives v1.0/Feedback & Status/Page Loading Spinner",
  component: LoadingCanvas,
  tags: ["deprecated", "autodocs"],
} satisfies Meta<typeof LoadingCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
