import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { expect, within } from "storybook/test";
import { FeatureFlagPending } from "./feature-flag-pending";

/**
 * The live region a flag-gated surface shows while PostHog has not answered.
 *
 * Reaching this state by hand needs a flag read that stalls or never lands, so
 * neither the visuals nor the screen-reader behavior are otherwise reviewable.
 * Both real geometries render here because the component's job is to hold one
 * announcement contract across two very different layouts.
 */
const LOADING_PAGE = "Loading page";
const LOADING_TAGS = "Loading Tags";

const PendingGallery = () => (
  <div className="space-y-8">
    <Section
      description="What FeatureFlagRouteGate swaps in for a whole page it is replacing. Fills its parent, matching RouteChromeFallback's geometry."
      title="Route gate, full page"
    >
      <div className="flex h-64 flex-col">
        <FeatureFlagPending className="min-h-0 flex-1 p-4" label={LOADING_PAGE}>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="min-h-64 w-full flex-1" />
        </FeatureFlagPending>
      </div>
    </Section>

    <Section
      description="The Settings Tags panel, nested under a header and a tab strip that both already rendered. Intrinsically sized, with no padding of its own."
      title="Settings Tags panel"
    >
      <FeatureFlagPending label={LOADING_TAGS}>
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-64 w-full" />
      </FeatureFlagPending>
    </Section>
  </div>
);

function Section({
  title,
  description,
  children,
}: Readonly<{ title: string; description: string; children: ReactNode }>) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-medium text-sm uppercase tracking-wide">{title}</h3>
        <p className="max-w-2xl text-muted-foreground text-xs">{description}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * A live region that fills in while a feature flag has not answered yet,
 * wrapping whatever skeleton placeholders you give it for that surface.
 * Reach for it instead of a bare Skeleton whenever a surface's whole layout
 * depends on a flag lookup, because it also tells screen readers that the
 * surface is loading, something a placeholder alone cannot do. It takes a
 * label that becomes both the announced sentence and the region's accessible
 * name, so a screen reader user is not left with only decorative bars and no
 * explanation.
 */
const meta = {
  title: "Primitives/Feedback & Status/Feature Flag Pending",
  component: PendingGallery,
  tags: ["autodocs"],
} satisfies Meta<typeof PendingGallery>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Pins the announcement contract on both regions, in the two ways the shipped
 * bug broke it. The all-stories sweep runs `play`, so these fail CI rather than
 * decorating a gallery. Checked against the pre-fix markup: restoring
 * `aria-busy` fails the first, re-hiding the sentence fails the second.
 */
export const Default: Story = {
  play: ({ canvasElement }) => {
    const canvas = within(canvasElement);

    for (const label of [LOADING_PAGE, LOADING_TAGS]) {
      const region = canvas.getByRole("status", { name: label });

      // `aria-busy` suppresses a live region's output. This one unmounts rather
      // than flipping it false, so the suppression would never lift.
      expect(region).not.toHaveAttribute("aria-busy");

      // `role="status"` is not named by its content, and the bars are
      // decorative, so without the visually-hidden sentence there is nothing
      // for a screen reader to speak.
      expect(region).toHaveTextContent(label);
    }
  },
};
