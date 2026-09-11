import { PageLoadingSpinner } from "@repo/app/shared/components/page-loading-spinner";
import type { Meta, StoryObj } from "@storybook/react";

const LoadingCanvas = () => (
  <div className="h-48 rounded-lg border">
    <PageLoadingSpinner />
  </div>
);

/**
 * A centred spinning icon filling its container as the whole page loading
 * state, used instead of Skeleton when there is nothing yet to preview the
 * shape of.
 */
const meta = {
  title: "Primitives/Feedback & Status/Page Loading Spinner",
  component: LoadingCanvas,
  tags: ["autodocs"],
} satisfies Meta<typeof LoadingCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
