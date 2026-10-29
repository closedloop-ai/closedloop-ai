import type { Meta, StoryObj } from "@storybook/react";
import type { ComponentProps, CSSProperties } from "react";
import { expect, within } from "storybook/test";
import { OnboardingAnalysisBanner } from "./onboarding-analysis-banner";

/**
 * The banner is `position: fixed`, so each story reserves the space it occupies
 * rather than letting it overlay the docs chrome. It also offsets itself past
 * the app sidebar via `--sidebar-width`; a story has no sidebar, so the host
 * zeroes the variable or the banner renders in the right sliver of the canvas.
 */
function BannerHost(props: ComponentProps<typeof OnboardingAnalysisBanner>) {
  return (
    <div
      className="relative h-24"
      style={{ "--sidebar-width": "0px" } as CSSProperties}
    >
      <OnboardingAnalysisBanner {...props} />
    </div>
  );
}

const meta: Meta<typeof BannerHost> = {
  args: { active: true },
  component: BannerHost,
  parameters: { layout: "fullscreen" },
  tags: ["deprecated", "autodocs"],
  title: "Composites v1.0/Onboarding/Onboarding Analysis Banner",
};

export default meta;

type Story = StoryObj<typeof BannerHost>;

/** Both counts measured, so the banner states the ratio it was given. */
export const Measured: Story = {
  args: { analyzed: 261, found: 270, percent: 97 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getByText("261 / 270")).toBeVisible();
  },
};

/**
 * A host that has not measured the counts. The banner still reports that
 * analysis is running; it does not invent a ratio to fill the space.
 */
export const CountsUnknown: Story = {
  args: { analyzed: null, found: null, percent: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getByText("Analyzing session records")).toBeVisible();
    await expect(canvas.queryByText("/")).toBeNull();
  },
};

/**
 * Half a ratio is not half a truth: a numerator with no denominator reads as a
 * total, so the counter is withheld entirely.
 */
export const HalfMeasured: Story = {
  args: { analyzed: 41, found: null, percent: 30 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.queryByText("41")).toBeNull();
  },
};
