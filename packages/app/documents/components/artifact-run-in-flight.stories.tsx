import type { GenerationStatus } from "@repo/api/src/types/document";
import type { Meta, StoryObj } from "@storybook/react";
import { ArtifactRunInFlight } from "./artifact-run-in-flight";

/**
 * The state matrix that matters is not "panel vs banner" — it is what the copy
 * is allowed to claim. A queued run has not started, so it must not say it is
 * running, and a run whose Session has not materialized yet must not offer a
 * link that goes nowhere.
 */
const meta = {
  title: "App Core/Documents/Artifact Run In Flight",
  component: ArtifactRunInFlight,
  tags: ["autodocs"],
  argTypes: {
    generationStatus: { control: "object" },
    variant: { control: { type: "radio" }, options: ["panel", "banner"] },
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ArtifactRunInFlight>;

export default meta;
type Story = StoryObj<typeof meta>;

const STARTED_AT = new Date("2026-08-11T00:45:21.000Z");

function status(overrides: Partial<GenerationStatus> = {}): GenerationStatus {
  return {
    status: "RUNNING",
    command: "generate_prd",
    htmlUrl: null,
    startedAt: STARTED_AT,
    completedAt: null,
    correlationId: null,
    source: "loop",
    loopId: "loop-1",
    sessionArtifactId: "session-1",
    initiatedBy: { firstName: "Mike", lastName: "Angstadt" },
    ...overrides,
  };
}

/** The artifact has nothing to read yet, so the treatment takes the content area. */
export const PanelRunning: Story = {
  args: {
    generationStatus: status(),
    orgSlug: "closedloop-ai",
    variant: "panel",
  },
};

/** Existing content stays readable; the run is announced above it. */
export const BannerRunning: Story = {
  args: {
    generationStatus: status(),
    orgSlug: "closedloop-ai",
    variant: "banner",
  },
};

/**
 * PENDING folds both Pending and Blocked, so this run may be deferred behind an
 * unapproved dependency and has never started. No elapsed time, and it does not
 * claim to be running.
 */
export const PanelQueued: Story = {
  args: {
    generationStatus: status({ status: "PENDING", startedAt: null }),
    orgSlug: "closedloop-ai",
    variant: "panel",
  },
};

/** The Session is written after the run starts — no link rather than a dead one. */
export const PanelWithoutSessionLink: Story = {
  args: {
    generationStatus: status({ sessionArtifactId: undefined }),
    orgSlug: "closedloop-ai",
    variant: "panel",
  },
};

/** An unknown initiator drops the "by" clause instead of rendering "by null". */
export const BannerWithoutInitiator: Story = {
  args: {
    generationStatus: status({ initiatedBy: null }),
    orgSlug: "closedloop-ai",
    variant: "banner",
  },
};

/** A terminal run renders nothing at all. */
export const NoActiveRun: Story = {
  args: {
    generationStatus: status({ status: "SUCCESS" }),
    orgSlug: "closedloop-ai",
    variant: "panel",
  },
};
