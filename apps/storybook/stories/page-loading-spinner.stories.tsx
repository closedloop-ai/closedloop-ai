import { PageLoadingSpinner } from "@repo/app/shared/components/page-loading-spinner";
import type { Meta, StoryObj } from "@storybook/react";

const LoadingCanvas = () => (
  <div className="h-48 rounded-lg border">
    <PageLoadingSpinner />
  </div>
);

/**
 * A centred spinning icon that fills its container, used as the whole-page
 * loading state while a route's content has not started rendering yet. Reach
 * for it instead of Skeleton when you have nothing yet to preview the shape
 * of. It carries no text or accessible label of its own, so it depends on
 * the surrounding page to announce that something is loading.
 */
const meta = {
  title: "Primitives/Feedback & Status/Page Loading Spinner",
  component: LoadingCanvas,
  tags: ["autodocs"],
} satisfies Meta<typeof LoadingCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
