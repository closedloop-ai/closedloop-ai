import { LoopErrorCode, LoopStatus } from "@repo/api/src/types/loop";
import { resolveFriendlyError } from "@closedloop-ai/loops-api/friendly-error";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { LoopStatusBadge } from "./loop-status-badge";

/**
 * Co-located story for the migrated app-core component (FEA-1510 / AC-001.4).
 * The `ghost-loop-ux` flag is enabled through the harness's injected
 * feature-flag port (no analytics SDK), so the Failed variant renders its
 * friendly error label.
 *
 * ISS-5697: the flag rides `parameters.appCore` rather than a per-story
 * `AppCoreStoryProviders` wrapper, since ISS-5665 (#4686) mounts that harness
 * globally in `.storybook/preview.tsx`. {@link Failed} asserts the flag-ON
 * label in a `play`, because the all-stories sweep only proves a story MOUNTS —
 * dropping `enabledFlags` entirely renders the flag-OFF label and the sweep
 * stays green. Without this assertion the parameter migration is unverified.
 */
const meta: Meta<typeof LoopStatusBadge> = {
  title: "App Core/Loops/Loop Status Badge",
  component: LoopStatusBadge,
  parameters: { appCore: { enabledFlags: ["ghost-loop-ux"] } },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Running: Story = {
  args: { status: LoopStatus.Running },
};

export const Completed: Story = {
  args: { status: LoopStatus.Completed },
};

export const Failed: Story = {
  args: { status: LoopStatus.Failed, errorCode: LoopErrorCode.ProcessFailed },
  play: async ({ canvasElement }) => {
    // Sourced from the canonical friendly-error map, not a copied literal, so a
    // relabel there cannot leave this assertion asserting a stale string.
    const friendlyTitle = resolveFriendlyError({
      code: LoopErrorCode.ProcessFailed,
    }).title;
    await expect(
      within(canvasElement).getByText(friendlyTitle)
    ).toBeInTheDocument();
  },
};

/**
 * A run whose launch failed (ISS-5711). This is the first place a user learns
 * the run never started, so it must read as a failure rather than the inactive
 * tone CANCELLED used to render.
 */
export const LaunchFailed: Story = {
  args: { status: LoopStatus.Failed, errorCode: LoopErrorCode.LaunchFailed },
};

/**
 * Version skew: a newer producer emits an error code this client has never
 * heard of. `errorCode` is an open string on the wire, so the badge narrows
 * through `LoopErrorCodeSchema` and falls back to the generic failure copy and
 * the FAILED color rather than rendering an unstyled state.
 */
export const UnknownErrorCode: Story = {
  args: { status: LoopStatus.Failed, errorCode: "SOME_FUTURE_CODE" },
};
