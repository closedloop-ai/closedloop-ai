import type { SyncedAgentSessionTokenUsage } from "@repo/api/src/types/agent-session";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { createAgentSessionDetailFixture } from "./agent-session-detail-fixtures";
import {
  CacheWriteTtlProperty,
  SessionSyncProperty,
} from "./session-flagged-properties";
import { SessionPropertiesFrame } from "./session-properties-story-frame";

/**
 * ISS-5698: the two Properties rows that decide for THEMSELVES whether to exist.
 *
 * Both render `null` far more often than they render a row, and both decide it
 * from data presence alone since ISS-5820 retired the Cache Write gate ON. The
 * interesting matrix is therefore not "what does the row look like" but "which
 * absences are the same absence". A test asserting `queryByText("Cache Write")`
 * is null passes identically for the provider never reporting a split and the
 * provider reporting `0 / 0`; only a story shows that both are meant to look
 * identical, and that a real split is the one case that earns a row.
 *
 * `SessionPropertiesFrame` is the production Properties pane scope. Without it
 * the label/value column tracks are missing and the monospace face (`.sd3 .mono`)
 * never applies, so a Cache Write row would render in the body face here and in
 * monospace in production.
 */
const propertiesFrameDecorator: Decorator = (Story) => (
  <SessionPropertiesFrame>
    <Story />
  </SessionPropertiesFrame>
);

/** A model line reporting a real 5m/1h subdivision of its cache-write tokens. */
const SPLIT_TOKEN_USAGE: SyncedAgentSessionTokenUsage[] = [
  {
    cacheReadTokens: 902_000,
    cacheWrite1hTokens: 84_000,
    cacheWrite5mTokens: 396_000,
    cacheWriteTokens: 480_000,
    estimatedCostUsd: 4.82,
    inputTokens: 128_400,
    model: "claude-sonnet-4-5",
    outputTokens: 24_800,
  },
];

/**
 * Two rows for a session's details panel that decide for themselves whether
 * to appear at all. The Cache Write row splits a session's cache creation
 * tokens into their five minute and one hour buckets, and the Sync row
 * reports whether the session's transcript has uploaded, is still syncing,
 * or failed for good. Reach for this pattern instead of a plain property row
 * whenever the underlying data may be entirely absent: both rows render
 * nothing rather than an empty or zeroed out line when a session has nothing
 * to report.
 */
const meta = {
  title: "Primitives/Data Display/Session Flagged Properties",
  component: CacheWriteTtlProperty,
  tags: ["autodocs"],
  argTypes: {
    session: {
      control: "object",
      description:
        "Both rows self-suppress from this alone: tokenUsageByModel for Cache Write, transcriptDisposition and lastSyncedAt for Sync.",
    },
  },
  parameters: { layout: "padded" },
  decorators: [propertiesFrameDecorator],
} satisfies Meta<typeof CacheWriteTtlProperty>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A session reporting a real split: the row appears and divides the 480,000
 * cache-creation tokens into the ephemeral 5-minute and 1-hour buckets the
 * pricing lane bills differently. This is the only case in this file that
 * produces a row.
 */
export const CacheWriteTtlReported: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      tokenUsageByModel: SPLIT_TOKEN_USAGE,
    }),
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Cache Write")
    ).toBeInTheDocument();
    await expect(canvasElement).toHaveTextContent(splitLabel(396_000, 84_000));
  },
};

/**
 * Provider silent. An older Claude session, a Codex session, or a
 * pre-TTL desktop build reports no subdivision at all, so the row self-suppresses
 * rather than printing `0 | 0`, a fabricated measurement nobody made.
 *
 * Read against {@link CacheWriteTtlReportedZero}: the screens are identical, and
 * that is correct. There is nothing honest to say in either case, so neither
 * says anything.
 */
export const CacheWriteTtlUnreported: Story = {
  args: { session: createAgentSessionDetailFixture() },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByText("Cache Write")
    ).not.toBeInTheDocument();
  },
};

/**
 * The provider reported an explicit `0` on both buckets. That is a genuine
 * zero, not an absence. The row still suppresses: a session that wrote no ephemeral
 * cache has no split to show, and "0 (5m TTL) | 0 (1h TTL)" is a row that costs
 * a line of the panel to say nothing.
 *
 * Worth pinning precisely BECAUSE it collapses a distinction the rest of this
 * panel is careful to keep (`session-measured-properties.stories.tsx` separates
 * absent from measured-zero row by row). Here the two really do mean the same
 * thing to a reader, and this story is the record of that call.
 */
export const CacheWriteTtlReportedZero: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      tokenUsageByModel: [
        {
          ...SPLIT_TOKEN_USAGE[0],
          cacheWrite1hTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    }),
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByText("Cache Write")
    ).not.toBeInTheDocument();
  },
};

/**
 * The partial report: the provider named a 1-hour figure and left the 5-minute
 * bucket null. The row renders, and the untold half prints as `0` INSIDE a
 * split that was genuinely reported. That is the honest reading, because a
 * reported total with one bucket absent means the other bucket holds it all.
 */
export const CacheWriteTtlOneSidedSplit: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      tokenUsageByModel: [
        {
          ...SPLIT_TOKEN_USAGE[0],
          cacheWrite1hTokens: 480_000,
          cacheWrite5mTokens: null,
        },
      ],
    }),
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement).toHaveTextContent(splitLabel(0, 480_000));
  },
};

/**
 * Two models, eight-figure counts. The value is the longest string this row can
 * produce and it sits in the fixed-width Properties value track, so this is the
 * crowding case: the separators have to survive, and the clipped value has to
 * stay reachable through the truncation tooltip rather than simply disappearing.
 *
 * The play below can only prove the first half. Clipping is decided by
 * `scrollWidth > clientWidth`, and the story sweep runs plays in jsdom, which
 * lays nothing out and reports both as 0 — so no tooltip ever mounts here and an
 * assertion on one would pass for the wrong reason. The reachability half is
 * pinned where the geometry can be stubbed, by "keeps the clipped Cache Write
 * split disclosed by its truncation tooltip" in
 * `__tests__/session-detail-property-tooltips.test.tsx`.
 */
export const CacheWriteTtlLargeCounts: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      tokenUsageByModel: [
        {
          ...SPLIT_TOKEN_USAGE[0],
          cacheWrite1hTokens: 12_480_000,
          cacheWrite5mTokens: 48_360_000,
          cacheWriteTokens: 60_840_000,
        },
        {
          cacheReadTokens: 1_100_000,
          cacheWrite1hTokens: 3_200_000,
          cacheWrite5mTokens: 9_600_000,
          cacheWriteTokens: 12_800_000,
          inputTokens: 402_000,
          model: "claude-opus-4-1",
          outputTokens: 96_000,
        },
      ],
    }),
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement).toHaveTextContent(
      splitLabel(57_960_000, 15_680_000)
    );
  },
};

/**
 * The rendered Cache Write value for a given split.
 *
 * Grouped through `toLocaleString` exactly as the row does, rather than pinned as
 * a literal `"57,960,000"`: the assertion is about the SUM across models, and a
 * hardcoded separator would fail on a runner whose default locale groups with
 * dots instead of commas.
 */
function splitLabel(ephemeral5m: number, ephemeral1h: number): string {
  return `${ephemeral5m.toLocaleString()} (5m TTL) | ${ephemeral1h.toLocaleString()} (1h TTL)`;
}

/**
 * The Sync row's nominal verdict: the transcript is uploaded and current, so the
 * row reads as quiet metadata rather than a colored badge. Its gate was retired
 * by ISS-5366 (shipped ON), so unlike the rows above this one is driven purely
 * by what the session carries.
 */
export const SyncSynced: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      transcriptDisposition: TranscriptDisposition.Synced,
    }),
  },
  render: (args) => <SessionSyncProperty {...args} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Sync")).toBeInTheDocument();
    await expect(canvasElement).toHaveTextContent("Synced");
  },
};

/**
 * The dead end: the upload failed and will not be retried. Sits next to
 * {@link SyncSynced} so the difference between "current" and "never coming" is
 * legible from one line of quiet metadata. This row does not badge, so the
 * words carry the whole distinction.
 */
export const SyncFailedPermanent: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      transcriptDisposition: TranscriptDisposition.FailedPermanent,
    }),
  },
  render: (args) => <SessionSyncProperty {...args} />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement).toHaveTextContent("Sync failed");
  },
};

/**
 * The in-flight verdict, which must NOT read as a failure: a transcript is
 * expected and its upload has not landed yet. The row is the only place the
 * detail screen says so, so "Syncing" has to be distinguishable from both
 * failure states at a glance.
 */
export const SyncInFlight: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      transcriptDisposition: TranscriptDisposition.Syncing,
    }),
  },
  render: (args) => <SessionSyncProperty {...args} />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement).toHaveTextContent("Syncing");
  },
};

/**
 * A version-skewed producer that serves `lastSyncedAt` but no disposition, which
 * is the default fixture's own shape. The row degrades to the freshness half alone
 * rather than rendering `undefined · Last synced …`, so an older peer still gets
 * a truthful, if thinner, row.
 */
export const SyncFreshnessOnly: Story = {
  args: { session: createAgentSessionDetailFixture() },
  render: (args) => <SessionSyncProperty {...args} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Sync")).toBeInTheDocument();
    await expect(canvasElement).toHaveTextContent("Last synced");
  },
};

/**
 * Neither input on the contract. The oldest producers send no sync signal at
 * all. The row renders NOTHING rather than an empty labeled row, which is the
 * distinction this story exists for: a "Sync" label with a blank value would
 * read as a failed lookup, and the panel would grow a line that says less than
 * silence.
 */
export const SyncAbsent: Story = {
  args: {
    session: createAgentSessionDetailFixture({ lastSyncedAt: undefined }),
  },
  render: (args) => <SessionSyncProperty {...args} />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByText("Sync")
    ).not.toBeInTheDocument();
  },
};
