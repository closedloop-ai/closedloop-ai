import type { Meta, StoryObj } from "@storybook/react";
import {
  SessionDetailLoading,
  SessionDetailNotFound,
  SessionDetailProviderError,
} from "./agent-session-detail-states";

// ISS-5451: the session-detail loading / not-found / provider-error states,
// isolated.
// These are the three states `/visual-qa` keeps finding bugs in, and they were
// the only part of the detail route with no way to see them without forcing a
// failing read. The pair that matters most is {@link NotFound} against
// {@link ProviderError}: both are empty screens with a back link, but they make
// opposite claims. "Session not found" says the record is gone; "Session
// unavailable" says the record exists and the read failed. Showing the wrong one
// tells a user to stop looking for a session that is fine, so they are adjacent
// here on purpose.
// ISS-5008: every state carries the `Session` page heading. The loaded detail
// owns its own `<h1>`, but that heading sits below all three of these
// early-returns, so without this the page shipped no heading at all on first
// load, on a 404, and during an outage. The heading is visible in each story.
// The route picks between the two error states with
// `classifySessionDetailError`, which maps a 404 to NotPresent and everything
// else — gateway down, worker died, 5xx — to ProviderError.
// No `parameters.appCore` here: all three states are pure presentational
// compositions of `PageHeading`, `Skeleton`, `EmptyState` and `Link`, and the
// only context any of them reads is the navigation port the preview already
// mounts globally (ISS-5665).
/**
 * The three screens a session detail page shows before it has data, a
 * loading skeleton, a not found message, and an unavailable message, since
 * those two make opposite claims.
 */
const meta = {
  title: "Composites/Sessions/Detail/Agent Session Detail States",
  component: SessionDetailNotFound,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-screen min-h-0 flex-col bg-background">
        <Story />
      </div>
    ),
  ],
  args: { backHref: "/sessions" },
} satisfies Meta<typeof SessionDetailNotFound>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The first-paint state. A skeleton stands in for the detail body while the
 * heading is already present, so the page has an outline before the read lands.
 */
export const Loading: Story = {
  render: () => <SessionDetailLoading />,
};

/**
 * A 404 — the session is genuinely not in this history. The copy admits both
 * reachable causes (deleted, or never synced) rather than asserting one.
 */
export const NotFound: Story = {};

/**
 * A transient read failure. The session still exists, so the copy says so and
 * points at a refresh — it must NOT read as a missing record.
 */
export const ProviderError: Story = {
  render: (args) => <SessionDetailProviderError backHref={args.backHref} />,
};
