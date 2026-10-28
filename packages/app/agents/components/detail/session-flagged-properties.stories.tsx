import type {
  AgentSessionDetail,
  SyncedAgentSessionTokenUsage,
} from "@repo/api/src/types/agent-session";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { deriveSessionCostLabel } from "@repo/app/agents/lib/cost-availability";
import {
  SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY,
  SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY,
  SESSION_TRANSCRIPT_NEVER_EXPECTED_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { CircleDollarSignIcon } from "lucide-react";
import { expect, within } from "storybook/test";
import { createAgentSessionDetailFixture } from "./agent-session-detail-fixtures";
import { PropertyValue } from "./property-values";
import {
  CacheWriteTtlProperty,
  SessionCostValue,
  SessionLaunchAttributionProperties,
  SessionSyncProperty,
} from "./session-flagged-properties";
import { SESSION_COST_POPULATION_NOTE } from "./session-population-notes";
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

/**
 * The production Cost row around a {@link SessionCostValue}, stated ONCE.
 *
 * `explanation` is the axis that matters and the reason this takes a parameter
 * rather than hardcoding one (marisolashgrove on #6980). The panel composes it from
 * `costPopulationNote` and `resolveMetricProvenanceNote`, and BOTH are behind
 * keys that are closed by default — so with them shut `joinPropertySentences`
 * yields `undefined`, `PropertyValueBody` falls to `TruncatingPropertyValue`,
 * and the row that actually ships is a `span`, not a button. Passing an
 * explanation everywhere pinned the minority branch.
 */
function renderCostRow(
  args: { session: AgentSessionDetail },
  explanation?: string
) {
  return (
    <PropertyValue
      explanation={explanation}
      icon={CircleDollarSignIcon}
      label="Cost"
      mono
    >
      <SessionCostValue
        estimate={deriveSessionCostLabel(args.session)}
        session={args.session}
      />
    </PropertyValue>
  );
}

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

const meta = {
  title: "Composites v1.0/Agents/Detail/Session Flagged Properties",
  component: CacheWriteTtlProperty,
  tags: ["deprecated", "autodocs"],
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
 * ISS-9884: the ordinary retryable failure — the upload is re-queued with
 * backoff, so the row says it is retrying. The control for
 * {@link SyncUploadPaused}: the SAME `failedTransient` disposition with no
 * reason beside it, which is also what a payload that dropped the reason
 * falls back to.
 */
export const SyncFailedRetrying: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      transcriptDisposition: TranscriptDisposition.FailedTransient,
    }),
  },
  render: (args) => <SessionSyncProperty {...args} />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement).toHaveTextContent("Sync failed, retrying");
    await expect(canvasElement).not.toHaveTextContent("Upload paused");
  },
};

/**
 * ISS-9884: the desktop lane hit its 24h environmental wall clock and stopped
 * attempting, on a file nothing was established to be wrong with. Only the
 * PAIR names this state — read it against {@link SyncFailedRetrying}, which
 * differs by the reason alone.
 */
export const SyncUploadPaused: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      transcriptDisposition: TranscriptDisposition.FailedTransient,
      transcriptDispositionReason: TranscriptSkipReason.EnvironmentUnavailable,
    }),
  },
  render: (args) => <SessionSyncProperty {...args} />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement).toHaveTextContent("Upload paused");
    await expect(canvasElement).not.toHaveTextContent("retrying");
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
 * ISS-7516 — the verdict no cloud producer emits, rendered here for the first
 * time. A machine whose data sync level keeps transcripts local never queues
 * one, so the cloud folds its sessions to `syncing` and this row said "Syncing"
 * beside a panel saying the transcript is never coming. The shell's verdict
 * overrides the disposition to `NeverExpected`, whose label, muted tone and
 * `attention: false` already existed in the shared fold.
 *
 * Read it against {@link SyncInFlight}, which is the SAME `syncing` disposition
 * with the verdict withheld. The value renders on one line beside the freshness
 * half, so this story is also the first look at "No transcript · Last synced …"
 * at the row's real width.
 */
export const SyncNeverExpectedBySyncLevel: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      transcriptDisposition: TranscriptDisposition.Syncing,
    }),
  },
  parameters: {
    appCore: {
      enabledFlags: [SESSION_TRANSCRIPT_NEVER_EXPECTED_FEATURE_FLAG_KEY],
    },
  },
  render: (args) => <SessionSyncProperty {...args} transcriptNeverExpected />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement).toHaveTextContent("No transcript");
    await expect(canvasElement).not.toHaveTextContent("Syncing");
  },
};

/**
 * The same verdict with the gate CLOSED (ISS-4779 closed-by-default), so the
 * shipped default is a story rather than an assumption: the row is identical to
 * {@link SyncInFlight}.
 */
export const SyncNeverExpectedGateClosed: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      transcriptDisposition: TranscriptDisposition.Syncing,
    }),
  },
  parameters: { appCore: { enabledFlags: [] } },
  render: (args) => <SessionSyncProperty {...args} transcriptNeverExpected />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement).toHaveTextContent("Syncing");
    await expect(canvasElement).not.toHaveTextContent("No transcript");
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

/**
 * ISS-7229 — Claude's own reported cost. Its two absences are the point: most
 * sessions carry no reported figure, and the closed gate hides the row on the
 * rest. Both render as nothing, and neither may borrow the estimate.
 */
const CLAUDE_REPORTED_STORY_SESSION = createAgentSessionDetailFixture({
  estimatedCost: 1438.84,
});

/**
 * Each figure followed by its OWN source word, in render order.
 *
 * Module-level per AGENTS.md (`useTopLevelRegex`). Checked against BOTH shapes
 * the Cost row takes, because they expose the pairing differently and only one
 * of them ships by default: the unexplained row is a `span` whose own text is
 * its accessible name, and the explained one is a button whose name is that text
 * plus an `sr-only` tail. Either way this ORDER is the only thing telling a user
 * who cannot see the two-line grouping which figure came from where.
 */
const COST_PAIR_ORDER =
  /\$1,438\.84\s*ClosedLoop estimate\s*\$1,502\.10\s*Claude reported/;

/** Gate on, Claude reported: $1,502.10 against our $1,438.84 — the ~4.4% drift. */
export const ClaudeReportedCostPresent: Story = {
  args: {
    session: {
      ...CLAUDE_REPORTED_STORY_SESSION,
      authoritativeCostUsd: 1502.1,
    },
  },
  parameters: {
    appCore: { enabledFlags: [SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY] },
  },
  render: (args) => renderCostRow(args),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // BOTH captions, because both figures are present and the words are the only
    // thing telling them apart.
    await expect(canvas.getByText("ClosedLoop estimate")).toBeInTheDocument();
    await expect(canvas.getByText("Claude reported")).toBeInTheDocument();
    await expect(canvasElement).toHaveTextContent("$1,438.84");
    await expect(canvasElement).toHaveTextContent("$1,502.10");
    // The SHIPPED shape: no explanation, so this is a `span` and its own text is
    // its accessible name. A screen-reader user gets the same disambiguation a
    // sighted one does, from the same two words in the same order.
    await expect(
      canvasElement.querySelector(".prd-prop-value-text")
    ).toHaveTextContent(COST_PAIR_ORDER);
  },
};

/**
 * The same pair in the EXPLAINED shape — the branch reached only when the
 * population-disclosure key is open, which is not the default (marisolashgrove on
 * #6980). Worth its own story because the explanation changes the ELEMENT:
 * `PropertyValueBody` swaps `TruncatingPropertyValue`'s span for an
 * `ExplainedPropertyValue` button, and the accessible name gains the sentence as
 * an `sr-only` tail after the value. The pairing must survive that swap.
 */
export const ClaudeReportedCostExplained: Story = {
  args: {
    session: {
      ...CLAUDE_REPORTED_STORY_SESSION,
      authoritativeCostUsd: 1502.1,
    },
  },
  parameters: {
    appCore: { enabledFlags: [SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY] },
  },
  render: (args) => renderCostRow(args, SESSION_COST_POPULATION_NOTE),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button")
    ).toHaveAccessibleName(COST_PAIR_ORDER);
  },
};

/**
 * Gate on, Claude reported nothing — the COMMON session. No row, and no
 * restatement of `$1,438.84` under Claude's name. Its positive control is
 * {@link ClaudeReportedCostPresent}: same estimate, only the reported figure differs.
 */
export const ClaudeReportedCostAbsent: Story = {
  args: {
    session: { ...CLAUDE_REPORTED_STORY_SESSION, authoritativeCostUsd: null },
  },
  parameters: {
    appCore: { enabledFlags: [SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY] },
  },
  render: (args) => renderCostRow(args),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("Claude reported")).not.toBeInTheDocument();
    // ISS-7229 CHANGED this expectation deliberately. The estimate used to be a
    // DIFFERENT row, so this story asserted `$1,438.84` was absent from a
    // standalone "Claude reported" row. The two figures now share the Cost row,
    // so the estimate is present here by construction — what must stay absent is
    // Claude's figure and, with only one number on screen, the caption that
    // would disambiguate it from nothing.
    await expect(canvasElement).toHaveTextContent("$1,438.84");
    await expect(
      canvas.queryByText("ClosedLoop estimate")
    ).not.toBeInTheDocument();
  },
};

/**
 * A reported $0.00. Unlike Cache Write above, absent and measured-zero differ
 * here: "Claude billed nothing" is a finding, "Claude told us nothing" is not.
 */
export const ClaudeReportedCostZero: Story = {
  args: {
    session: { ...CLAUDE_REPORTED_STORY_SESSION, authoritativeCostUsd: 0 },
  },
  parameters: {
    appCore: { enabledFlags: [SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY] },
  },
  render: (args) => renderCostRow(args),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement).toHaveTextContent("$0.00");
    // A reported zero is a MEASUREMENT, so it earns the paired treatment and its
    // caption exactly as a non-zero figure does.
    await expect(canvas.getByText("Claude reported")).toBeInTheDocument();
    await expect(canvasElement).toHaveTextContent("$1,438.84");
  },
};

/** The closed gate on a session that would otherwise show the row — the shipped default. */
export const ClaudeReportedCostGateClosed: Story = {
  args: {
    session: {
      ...CLAUDE_REPORTED_STORY_SESSION,
      authoritativeCostUsd: 1502.1,
    },
  },
  parameters: { appCore: { enabledFlags: [] } },
  render: (args) => renderCostRow(args),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("Claude reported")).not.toBeInTheDocument();
    // The closed gate is indistinguishable from "Claude reported nothing", which
    // is the point: a session with a real figure behind a shut flag must look
    // exactly like one without, captions and all.
    await expect(
      canvas.queryByText("ClosedLoop estimate")
    ).not.toBeInTheDocument();
    await expect(canvasElement).toHaveTextContent("$1,438.84");
  },
};

/**
 * ISS-7259: the harness launch-attribution rows.
 *
 * These stories exist because the interesting thing about this component is not
 * how one row looks but WHICH ABSENCES ARE THE SAME ABSENCE, and how much of the
 * skill row's hedge survives the panel's fixed value track. A unit test asserting
 * a substring cannot show that the qualifier clips; a story can.
 */
const LAUNCH_ATTRIBUTION_STORY_SESSION = createAgentSessionDetailFixture();

/** Codex stated genuine spawn facts: an agent-spawned thread with a role. */
export const LaunchAttributionCodexSpawned: Story = {
  args: {
    session: {
      ...LAUNCH_ATTRIBUTION_STORY_SESSION,
      metadata: {
        harnessLaunchAttribution: {
          agentNickname: "Mencius",
          agentRole: "review-soul",
          depth: 1,
          threadSource: "subagent",
        },
      },
    },
  },
  parameters: {
    appCore: { enabledFlags: [SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY] },
  },
  render: (args) => <SessionLaunchAttributionProperties {...args} />,
};

/**
 * Claude's half — and the row this whole design is about. The name is NOT the
 * launcher, so the record position rides inline and the caveat rides the
 * `explanation` tooltip. A realistic long skill name is used deliberately: this
 * is the story that shows how much of the inline qualifier the track keeps.
 */
export const LaunchAttributionClaudeSkill: Story = {
  args: {
    session: {
      ...LAUNCH_ATTRIBUTION_STORY_SESSION,
      metadata: {
        harnessLaunchAttribution: {
          firstAttributedRecordIndex: 251,
          firstAttributedSkill: "cl-produce",
          observedRecordCount: 381,
          observedSkillCount: 3,
          promptSource: "sdk",
          threadSource: "unstated",
        },
      },
    },
  },
  parameters: {
    appCore: { enabledFlags: [SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY] },
  },
  render: (args) => <SessionLaunchAttributionProperties {...args} />,
};

/**
 * A spawn word this build does not recognise. It earns a row — saying so is the
 * point — where the `unstated` word Claude always sends earns none. Its positive
 * control is {@link LaunchAttributionCodexSpawned}: same component, same gate,
 * only the word differs.
 */
export const LaunchAttributionUnknownSpawnWord: Story = {
  args: {
    session: {
      ...LAUNCH_ATTRIBUTION_STORY_SESSION,
      metadata: { harnessLaunchAttribution: { threadSource: "scheduled" } },
    },
  },
  parameters: {
    appCore: { enabledFlags: [SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY] },
  },
  render: (args) => <SessionLaunchAttributionProperties {...args} />,
};

/** Gate closed on a session that would otherwise show every row: nothing. */
export const LaunchAttributionGateClosed: Story = {
  args: {
    session: {
      ...LAUNCH_ATTRIBUTION_STORY_SESSION,
      metadata: {
        harnessLaunchAttribution: {
          agentRole: "review-soul",
          threadSource: "subagent",
        },
      },
    },
  },
  parameters: { appCore: { enabledFlags: [] } },
  render: (args) => <SessionLaunchAttributionProperties {...args} />,
};
