import type { Meta, StoryObj } from "@storybook/react";
import { type ReactNode, useEffect } from "react";
import { expect, within } from "storybook/test";
import { DashboardTourAnchor } from "../../../insights/components/overview/dashboard-tour-anchors";
import { Tour } from "./dashboard-tour";
import { OVERLAY_Z_INDEX } from "./dashboard-tour-geometry";
import type { TourStep } from "./dashboard-tour-types";
import { resolveDashboardTourSteps } from "./resolve-dashboard-tour-steps";

/**
 * The render mode that does not need a laid-out host page behind it: a
 * spotlight step whose anchor is not on screen, which dims the whole viewport
 * and docks the callout bottom-right instead of unmounting the tour. The other
 * mode — a ring around a measured anchor — is geometry over a real dashboard
 * and belongs to that surface, not to a story that would have to fake the rect.
 */
const SPOTLIGHT_STEP: TourStep = {
  sel: DashboardTourAnchor.Prs,
  eyebrow: "Throughput",
  title: "Shipping velocity",
  body: "Pull requests opened, reviewed and merged over the selected window.",
};

const FINAL_STEP: TourStep = {
  sel: DashboardTourAnchor.Models,
  eyebrow: "Spend",
  title: "What it cost",
  body: "Token spend by model, so an expensive habit shows up before the bill.",
};

const meta: Meta<typeof Tour> = {
  args: {
    active: true,
    onClose: () => {
      // The host owns the tour-seen flag; a story just renders the run.
    },
    resolveSteps: () => [SPOTLIGHT_STEP, FINAL_STEP],
  },
  component: Tour,
  parameters: { layout: "fullscreen" },
  tags: ["deprecated", "autodocs"],
  title: "Composites v1.0/Onboarding/Dashboard Tour",
};

export default meta;

type Story = StoryObj<typeof Tour>;

/**
 * A spotlight step with no anchor in the document — a gated or not-yet-revealed
 * row. The scrim stays fully dim and the callout docks bottom-right rather than
 * ringing empty space.
 */
export const AnchorOffScreen: Story = {
  args: {
    resolveSteps: () => [SPOTLIGHT_STEP, FINAL_STEP],
  },
};

/**
 * The last step, where the primary button is the host's completion label rather
 * than "Done" — ISS-5112's guest run hands off to the account dialog.
 */
export const LastStepWithHostLabel: Story = {
  args: {
    completeLabel: "Create account",
    resolveSteps: () => [FINAL_STEP],
  },
};

/**
 * The canonical run on a dashboard where every section rendered: six steps and
 * six progress dots. No anchor is in the document behind a story, so each step
 * takes the full-dim fallback — the step set and the dot row are what this is
 * here to show, not the ring.
 */
export const CanonicalSteps: Story = {
  args: {
    resolveSteps: () =>
      resolveDashboardTourSteps({ isAnchorPresent: () => true }),
  },
};

/**
 * The common case, not an edge case: the activity section resolved empty, so
 * the run is five steps and the indicator says five. A fixed list of six that
 * skipped the missing target at render would show a sixth dot the reader can
 * never reach.
 */
export const ActivityAbsent: Story = {
  args: {
    resolveSteps: () =>
      resolveDashboardTourSteps({
        isAnchorPresent: (anchor) => anchor !== DashboardTourAnchor.Activity,
      }),
  },
};

/**
 * The same run with `prefers-reduced-motion: reduce` set: no scrim fade, no
 * spotlight tween, no rise-in on the callout, and skip closes at once instead
 * of flying into the dock button. The difference is invisible in a still
 * frame, so the play step reads the suppression back off the scrim.
 */
export const ReducedMotion: Story = {
  args: {
    resolveSteps: () =>
      resolveDashboardTourSteps({ isAnchorPresent: () => true }),
  },
  decorators: [
    (Story) => (
      <ForceReducedMotion>
        <Story />
      </ForceReducedMotion>
    ),
  ],
  play: ({ canvasElement }) => {
    const scrim = Array.from(
      canvasElement.querySelectorAll<HTMLElement>("div")
    ).find((element) => element.style.zIndex === String(OVERLAY_Z_INDEX));

    expect(scrim?.style.transition).toBe("none");
  },
};

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** The real `matchMedia` while the stub below is installed, else `null`. */
let realMatchMedia: typeof globalThis.matchMedia | null = null;

/**
 * Answer the reduced-motion query as SET, delegating every other query to the
 * real `matchMedia` so nothing else in the story tree changes. Idempotent: a
 * second call while installed is a no-op, which is what keeps a StrictMode
 * double render from wrapping the stub around itself.
 */
function installReducedMotionStub(): void {
  if (realMatchMedia) {
    return;
  }
  const real = globalThis.matchMedia.bind(globalThis);
  realMatchMedia = real;
  globalThis.matchMedia = (query: string) => {
    const list = real(query);
    if (query === REDUCED_MOTION_QUERY) {
      Object.defineProperty(list, "matches", {
        configurable: true,
        value: true,
      });
    }
    return list;
  };
}

function restoreMatchMedia(): void {
  if (!realMatchMedia) {
    return;
  }
  globalThis.matchMedia = realMatchMedia;
  realMatchMedia = null;
}

/**
 * Forces reduced motion for whatever it wraps.
 *
 * The engine reads the preference through `usePrefersReducedMotion`, which has
 * no prop to override, so answering the media query differently is the only way
 * to render that branch. Installed during this component's own render because
 * the hook resolves on the tour's FIRST render, which an effect would be too
 * late for; re-armed from the effect so a StrictMode remount does not leave the
 * story on the real preference, and restored on unmount so the next story in
 * the sweep is not silently reduced too.
 */
function ForceReducedMotion({ children }: { children: ReactNode }) {
  installReducedMotionStub();
  useEffect(() => {
    installReducedMotionStub();
    return restoreMatchMedia;
  }, []);
  return <>{children}</>;
}

/**
 * ISS-12110: the next beat's panel is still loading, so Next is held until it
 * has loaded (Marisol Ashgrove's 2026-10-07 ruling: "go to the next beat once the
 * data for that beat is ready"). Skip still ends the run. No controls: both
 * props this story sets are functions.
 */
export const NextBeatLoading: Story = {
  args: {
    isStepReady: (anchor) => anchor !== FINAL_STEP.sel,
    resolveSteps: () => [SPOTLIGHT_STEP, FINAL_STEP],
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: NEXT_BUTTON })
    ).toHaveAttribute("aria-disabled", "true");
  },
};

const NEXT_BUTTON = /Next/;
