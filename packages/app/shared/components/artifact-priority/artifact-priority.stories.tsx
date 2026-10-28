import { Priority } from "@repo/api/src/types/common";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { ArtifactPriorityVariant } from "@repo/app/shared/lib/artifact-priority-ownership";
import { ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { expect, within } from "storybook/test";
import { ArtifactPriority } from "./artifact-priority";

/** How every gallery row finds the mark it captioned. */
const CHAMPION = '[data-slot="artifact-priority"]';

/**
 * `ArtifactPriority` is the one thing that paints an artifact's priority
 * (ISS-9307). Every rendering context the contract approves is a VARIANT of it,
 * not a component of its own, which is what stopped the four label maps and two
 * rank maps ISS-9439 inventoried from growing back.
 *
 * The two galleries below are the pair worth eyeballing together. The first
 * shows one value in every variant, so a variant that has quietly started
 * rendering like another one is visible side by side. The second shows one
 * variant against every value INCLUDING the two that are not members: an
 * artifact nobody prioritized, and one carrying a member only a newer build
 * knows. Those two must never read the same — "no priority" is a fact about the
 * artifact, "unknown priority" is a fact about this build.
 */
const ROW_VALUES: readonly (string | null)[] = [
  Priority.Urgent,
  Priority.High,
  Priority.Medium,
  Priority.Low,
  null,
  "BLOCKER",
];

const VariantGallery = () => (
  <div className="space-y-2">
    {Object.values(ArtifactPriorityVariant).map((variant) => (
      <Row caption={variant} key={variant}>
        <ArtifactPriority priority={Priority.High} variant={variant} />
      </Row>
    ))}
  </div>
);

/**
 * The cell the two galleries above each miss: a member only a newer build knows,
 * in every variant. The glyph falls back to three bars, so what distinguishes it
 * is the word — and on the variants that paint no word, an `sr-only` one. Worth
 * eyeballing as a matrix because a variant with no room for the word is exactly
 * where this state goes wrong.
 */
const SkewGallery = () => (
  <div className="space-y-2">
    {Object.values(ArtifactPriorityVariant).map((variant) => (
      <Row caption={variant} key={variant}>
        <ArtifactPriority priority="BLOCKER" variant={variant} />
      </Row>
    ))}
  </div>
);

const ValueGallery = () => (
  <div className="space-y-2">
    {ROW_VALUES.map((priority) => (
      <Row caption={priority ?? "null (no priority)"} key={priority ?? "null"}>
        <ArtifactPriority
          priority={priority}
          variant={ArtifactPriorityVariant.Label}
        />
      </Row>
    ))}
  </div>
);

/**
 * Loading and error are facts about the READ and outrank the value, so neither
 * paints "No priority" — a blank where a skeleton belongs is a screen reporting
 * a measurement it does not have. Editing and mutation activity quiet the mark
 * instead of replacing it, because the value is still the thing being read.
 *
 * Those last two are GATED. `ArtifactPriority` reads
 * `artifact-priority-surfaces` itself, and a Storybook mount with no flag
 * provider resolves closed — so a row captioned "editing" rendered outside a
 * provider paints a settled mark and advertises a state the story cannot show.
 * Both sides of the gate are here for that reason: closed is deliberately
 * identical to settled, open is the treatment under review.
 */
const StateGallery = () => (
  <div className="space-y-2">
    <Row caption="loading">
      <ArtifactPriority
        loadingLabel="Loading priority"
        priority={Priority.High}
        state="loading"
        variant={ArtifactPriorityVariant.Label}
      />
    </Row>
    <Row caption="error">
      <ArtifactPriority
        errorLabel="Could not load"
        priority={Priority.High}
        state="error"
        variant={ArtifactPriorityVariant.Label}
      />
    </Row>
    <Row caption="disabled">
      <ArtifactPriority
        disabled
        priority={Priority.High}
        variant={ArtifactPriorityVariant.Label}
      />
    </Row>
    <Row caption="selected">
      <ArtifactPriority
        priority={Priority.High}
        selected
        variant={ArtifactPriorityVariant.Label}
      />
    </Row>
    <Row caption="focus-visible">
      <ArtifactPriority
        focusVisible
        priority={Priority.High}
        variant={ArtifactPriorityVariant.Label}
      />
    </Row>
    <ActivityRows gate="gate closed" />
    <FeatureFlagAdapterProvider adapter={CHAMPION_UI_ADAPTER}>
      <ActivityRows gate="gate open" />
    </FeatureFlagAdapterProvider>
  </div>
);

const meta = {
  component: ArtifactPriority,
  parameters: { layout: "padded" },
  title: "Composites v1.0/App Shell/Artifact Priority",
  tags: ["deprecated"],
} satisfies Meta<typeof ArtifactPriority>;

export default meta;

type Story = StoryObj<typeof meta>;

export const EveryVariant: Story = {
  args: { priority: Priority.High, variant: ArtifactPriorityVariant.Label },
  render: () => <VariantGallery />,
};

export const EveryValue: Story = {
  args: { priority: Priority.High, variant: ArtifactPriorityVariant.Label },
  render: () => <ValueGallery />,
};

export const UnknownMember: Story = {
  args: { priority: "BLOCKER", variant: ArtifactPriorityVariant.Label },
  render: () => <SkewGallery />,
};

export const States: Story = {
  args: { priority: Priority.High, variant: ArtifactPriorityVariant.Label },
  /**
   * A caption is not evidence. With the gate shut the two activity treatments
   * are SUPPOSED to be indistinguishable from a settled mark, so nothing a
   * reader can see separates "the gate is closed" from "the story never mounted
   * the state at all" — which is how this gallery previously advertised two
   * states it could not render. The accessibility tree is the one place the two
   * differ, so that is what is asserted.
   */
  play: ({ canvasElement }) => {
    for (const caption of GATE_CLOSED_CAPTIONS) {
      const mark = markForCaption(canvasElement, caption);
      expect(mark).not.toHaveAttribute("data-editing");
      expect(mark).not.toHaveAttribute("aria-busy");
    }
    expect(
      markForCaption(canvasElement, "editing (gate open)")
    ).toHaveAttribute("data-editing", "true");
    expect(
      markForCaption(canvasElement, "mutation activity (gate open)")
    ).toHaveAttribute("aria-busy", "true");
  },
  render: () => <StateGallery />,
};

function Row({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <span className="w-40 shrink-0 text-muted-foreground text-xs">
        {caption}
      </span>
      {children}
    </div>
  );
}

/**
 * The two activity treatments, rendered wherever the caller puts the gate.
 *
 * They quiet the mark the same way, and the difference between them is in the
 * accessibility tree rather than the paint: `mutationActivity` publishes
 * `aria-busy`, `editing` publishes `data-editing` for the surface underneath.
 * Said here because a reader comparing the two rows would otherwise hunt for a
 * visual difference that is not supposed to exist.
 */
function ActivityRows({ gate }: { gate: string }) {
  return (
    <>
      <Row caption={`editing (${gate})`}>
        <ArtifactPriority
          editing
          priority={Priority.High}
          variant={ArtifactPriorityVariant.Label}
        />
      </Row>
      <Row caption={`mutation activity (${gate})`}>
        <ArtifactPriority
          mutationActivity
          priority={Priority.High}
          variant={ArtifactPriorityVariant.Label}
        />
      </Row>
    </>
  );
}

/** Opens the gate the two activity treatments wait behind. */
const CHAMPION_UI_ADAPTER = createStaticFeatureFlagAdapter({
  enabledFlags: [ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY],
});

const GATE_CLOSED_CAPTIONS = [
  "editing (gate closed)",
  "mutation activity (gate closed)",
];

/** The mark belonging to one captioned gallery row. */
function markForCaption(root: HTMLElement, caption: string): Element {
  const mark = within(root)
    .getByText(caption)
    .parentElement?.querySelector(CHAMPION);
  if (!mark) {
    throw new Error(`the "${caption}" row rendered no priority mark`);
  }
  return mark;
}
