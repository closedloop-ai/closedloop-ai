import { Button } from "@repo/design-system/components/ui/button";
import { Link } from "@repo/navigation/link";
import type { Meta, StoryObj } from "@storybook/react";
import { SessionsEmptyState } from "./sessions-empty-state";
import { SessionsRecoveryAction } from "./sessions-recovery-action";

// ISS-5451: the honest zero-row surface for the Sessions list, isolated.
// FEA-4181 split the old single "No sessions found" into three states because
// that one message could not tell a filtered-away scope from a genuinely-empty
// one from a failed read — and told all three of them the same reassuring lie.
// The value of this story set is seeing the three side by side and confirming
// each one NAMES its reason:
// - {@link Errored} — the read failed. Error chrome, and an action.
// - {@link Syncing} — the local source has not hydrated yet. Deliberately NO
//   error chrome and no Retry; nothing failed and there is nothing to retry.
// - {@link Filtered} — rows exist, the filters exclude them. Offers the fix.
// - {@link GenuinelyEmpty} / {@link OnboardingNoAgentConnected} — the scope
//   really is empty, with the onboarding CTA only when the org has never
//   connected a compute target.
// The reason is DERIVED from `signals`, not passed in, so these stories set the
// real signals the production hosts set. The pair worth staring at is
// {@link Errored} against {@link Syncing}: same `isUnavailable: true`, opposite
// tone, because one is a breakage and the other is just not-yet.
/**
 * This is what the Sessions list shows instead of a table when there are no
 * rows to display, and it always names the actual reason rather than one
 * generic "No sessions found" message. A failed data load shows an error
 * message with a retry action, a source that has not finished loading shows
 * a quiet "getting ready" message with no error styling, filtered-out
 * results offer a "Clear filters" button, and a genuinely empty organization
 * gets either plain "nothing yet" copy or a prompt to connect an agent,
 * depending on whether one has ever connected. Which of these shows is
 * worked out automatically from the underlying signals, so it cannot
 * accidentally show the friendly empty message over data that actually
 * failed to load.
 */
const meta = {
  title: "Composites/Sessions/Listing/Sessions Empty State",
  component: SessionsEmptyState,
  tags: ["autodocs"],
  argTypes: {
    signals: {
      control: "object",
      description:
        "The reason is DERIVED from these, never passed in. isUnavailable wins, then hasActiveFilters.",
    },
    isSyncing: {
      control: "boolean",
      description:
        "Among unavailable states, is the local source still coming up rather than broken? Desktop only.",
    },
    hasConnectedAgent: {
      control: "boolean",
      description:
        "Only false swaps the genuinely-empty copy for the onboarding CTA. Unset means unknown.",
    },
    errorRecoveryAction: {
      control: false,
      description:
        "Host-owned recovery Link for the errored card. A rendered element, so it is wired per story.",
    },
    onboardingAction: {
      control: false,
      description:
        "Host-owned connect-a-compute-target CTA. A rendered element, so it is wired per story.",
    },
    onClearFilters: { control: false, table: { category: "Events" } },
    onRetry: { control: false, table: { category: "Events" } },
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-full max-w-3xl">
        <Story />
      </div>
    ),
  ],
  args: {
    isSyncing: false,
    signals: { isUnavailable: false, hasActiveFilters: false },
  },
} satisfies Meta<typeof SessionsEmptyState>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The scope genuinely has no sessions and an agent has connected before. Neutral
 * "nothing yet" copy — never onboarding at an already-onboarded org.
 */
export const GenuinelyEmpty: Story = {
  args: { hasConnectedAgent: true },
};

/**
 * PRD-536 §5: the org has never connected a compute target, so the empty state
 * is an onboarding CTA rather than a shrug.
 *
 * `onboardingAction` mirrors what the web host actually supplies — a link to
 * compute-target setup, NOT the errored card's `SessionsRecoveryAction`. A
 * first-run org has no filters to clear and nothing to reload, so offering
 * "Clear filters and reload" here would show reviewers an action production
 * never renders in this state.
 */
export const OnboardingNoAgentConnected: Story = {
  args: {
    hasConnectedAgent: false,
    onboardingAction: (
      <Button asChild size="sm">
        <Link href="/settings">Connect a compute target</Link>
      </Button>
    ),
  },
};

/**
 * Sessions exist but the active filters exclude every one of them. Names the
 * situation and offers the always-safe fix.
 */
export const Filtered: Story = {
  args: {
    signals: { isUnavailable: false, hasActiveFilters: true },
    onClearFilters: () => undefined,
  },
};

/** The filtered empty with no handler wired — the message stands without a CTA. */
export const FilteredWithoutClearHandler: Story = {
  args: { signals: { isUnavailable: false, hasActiveFilters: true } },
};

/**
 * The read genuinely failed. Destructive alert, and — per ISS-4534 — the single
 * primary action is the recovery Link, which is a superset of a bare Retry.
 */
export const Errored: Story = {
  args: {
    signals: { isUnavailable: true, hasActiveFilters: false },
    errorRecoveryAction: (
      <SessionsRecoveryAction
        href="/sessions"
        onClearFilters={() => undefined}
      />
    ),
  },
};

/**
 * The errored state for a host that wired only `onRetry`. Falls back to a lone
 * Retry so the card is never actionless.
 */
export const ErroredRetryFallback: Story = {
  args: {
    signals: { isUnavailable: true, hasActiveFilters: false },
    onRetry: () => undefined,
  },
};

/**
 * The local source is still coming up. This is NOT a breakage: quiet muted copy,
 * no error chrome, no Retry. Desktop-only — the web page has no local source.
 */
export const Syncing: Story = {
  args: {
    signals: { isUnavailable: true, hasActiveFilters: false },
    isSyncing: true,
  },
};
