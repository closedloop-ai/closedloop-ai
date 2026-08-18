import {
  SourceAccessState,
  type SourceOccurrence,
  SourceOccurrenceType,
} from "@repo/api/src/types/agent-component";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  type AgentComponentInvocationReadPage,
  type AgentComponentInvocationReadRow,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { AGENTS_PAGE_SIZE } from "../../lib/agents-timeframe";
import { InvocationEvidenceList } from "./invocation-evidence-list";

/**
 * ISS-4805 (wongk review, #4322): canvas for the invocation evidence list, which
 * had no story anywhere.
 *
 * The risk this pins is LAYOUT, not the formatted string. ISS-4805 changed what
 * the Source column can contain — a machine-absolute path is now reduced to its
 * portable tail, and an occurrence with no portable part renders with NO path at
 * all (the bare "Static file" label). That value lands in a
 * `minmax(280px,1fr)` column beside a copy button where everything truncates,
 * and the co-located tests assert the string rather than how it reads once the
 * portable part is short or absent.
 *
 * The three scenarios below are the contract:
 *
 *   - the empty state;
 *   - a Local row with a long redacted path AND a StaticFile row exercising the
 *     no-portable-part fallback, side by side so the two shapes can be compared
 *     in one column;
 *   - the over-limit "Showing N of M" strip with the Unmatched/Ambiguous
 *     attribution-exception chips.
 *
 * Pure props (`page` + `getSessionHref`), so no hook mocking is needed.
 */

const INVOKED_AT = "2026-06-10T10:00:00.000Z";

function makeOccurrence(
  overrides: Partial<SourceOccurrence> &
    Pick<SourceOccurrence, "occurrenceType">
): SourceOccurrence {
  return {
    accessState: SourceAccessState.Accessible,
    repoFullName: null,
    repoPath: null,
    repoCommit: null,
    computeTargetId: null,
    localPath: null,
    packId: null,
    firstSeenAt: INVOKED_AT,
    lastSeenAt: INVOKED_AT,
    ...overrides,
  };
}

function makeRow(
  overrides: Partial<AgentComponentInvocationReadRow> &
    Pick<AgentComponentInvocationReadRow, "id">
): AgentComponentInvocationReadRow {
  return {
    externalInvocationId: `ext-${overrides.id}`,
    sessionId: `session-${overrides.id}`,
    externalSessionId: `ext-session-${overrides.id}`,
    sourceSessionId: `source-session-${overrides.id}`,
    kind: AgentComponentInvocationKind.Skill,
    componentKey: "security/1password",
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: INVOKED_AT,
    sequence: 1,
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: `event-${overrides.id}`,
    },
    status: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    ...overrides,
  };
}

/**
 * The redaction case. Production captured
 * `/Users/<someone>/Code/hermes-agent/optional-skills/security/1password/SKILL.md`;
 * the column renders only the portable tail from the `.claude` anchor down.
 */
const localRow = makeRow({
  id: "local-1",
  sourceOccurrence: makeOccurrence({
    occurrenceType: SourceOccurrenceType.Local,
    computeTargetId: "macbook-pro-16-teammate",
    localPath:
      "/Users/someone/Code/hermes-agent/.claude/skills/security/1password/SKILL.md",
  }),
});

/**
 * The no-portable-part fallback: a machine-absolute path with no agent-config
 * anchor has nothing safe to show, so the cell falls back to the bare label.
 * This is the row that has no path at all, which is the shape a string
 * assertion cannot show.
 */
const staticFileRow = makeRow({
  id: "static-1",
  sourceOccurrence: makeOccurrence({
    occurrenceType: SourceOccurrenceType.StaticFile,
    localPath: "/var/folders/T/tmp-9f21/scratch-definition.md",
  }),
});

/** A repository occurrence, which was already portable and is unaffected. */
const repositoryRow = makeRow({
  id: "repo-1",
  sourceOccurrence: makeOccurrence({
    occurrenceType: SourceOccurrenceType.Repository,
    repoFullName: "acme/hermes-agent",
    repoCommit: "9f21c4a",
    repoPath: ".claude/skills/security/1password/SKILL.md",
  }),
});

const mixedPathRows = [localRow, staticFileRow, repositoryRow];

/** One more page than the list renders, so the truncation strip appears. */
const manyRows = Array.from(
  { length: AGENTS_PAGE_SIZE + 24 },
  (_unused, index) =>
    makeRow({
      id: `bulk-${index}`,
      sequence: index + 1,
      sourceOccurrence:
        index % 2 === 0
          ? localRow.sourceOccurrence
          : staticFileRow.sourceOccurrence,
    })
);

function makePage(
  overrides: Partial<AgentComponentInvocationReadPage>
): AgentComponentInvocationReadPage {
  return {
    items: [],
    total: 0,
    hasMore: false,
    unmatchedCount: 0,
    ambiguousCount: 0,
    ...overrides,
  };
}

function PanelFrame({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="max-w-5xl p-6">{children}</div>;
}

const storyDecorator: Decorator = (Story) => (
  <PanelFrame>
    <Story />
  </PanelFrame>
);

const meta = {
  title: "App Core/Agents/Invocation Evidence List",
  component: InvocationEvidenceList,
  parameters: { layout: "fullscreen" },
  args: {
    page: makePage({ items: mixedPathRows, total: mixedPathRows.length }),
    getSessionHref: (sessionId: string) => `/sessions/${sessionId}`,
  },
  decorators: [storyDecorator],
} satisfies Meta<typeof InvocationEvidenceList>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The ISS-4805 column, all three provenance shapes at once: a redacted Local
 * path, a StaticFile row with NO path (the bare label), and an untouched
 * repository row — so the redacted tail can be read against a full one.
 */
export const RedactedAndFallbackPaths: Story = {};

/** Nothing recorded yet. */
export const Empty: Story = {
  args: { page: makePage({}) },
};

/**
 * Over the render limit AND carrying attribution exceptions, so the
 * "Showing N of M" strip and the Unmatched/Ambiguous chips render together —
 * neither is reachable from the default story.
 *
 * ISS-5520: the total here is CREDIBLE (114 counted against 74 delivered), so
 * this is the exact-count sentence — "Showing 50 of 114 invocations", with the
 * strip above it reading "114 recorded". Before ISS-5520 this story printed
 * "114+" because `hasMore` drove the floor marker; the `+` case now lives in
 * {@link RacyCountBehindDeliveredRows}, which reaches it deliberately.
 */
export const TruncatedWithAttributionExceptions: Story = {
  args: {
    page: makePage({
      items: manyRows,
      total: manyRows.length + 40,
      hasMore: true,
      unmatchedCount: 7,
      ambiguousCount: 3,
    }),
  },
};

/**
 * ISS-5520 (wongk story review, #4716): the ONLY place the floor/"+" arm can be
 * eyeballed.
 *
 * Both producers read their rows and their count in two queries that are not in
 * one transaction, so a write landing between them can return a count BELOW the
 * rows delivered beside it. The panel then refuses the count and states what the
 * payload itself proves — a floor on the delivered rows — in BOTH readouts at
 * once: "74+ recorded" above the table and "Showing 50 of 74+ invocations" below
 * it. That agreement is the property this story exists to show; the pre-review
 * build rendered the raw stale count ("12 recorded") over the floor caption, and
 * a screenshot is the only artifact in which two lines contradicting each other
 * is obvious at a glance.
 *
 * It is also unreproducible by hand — it needs a count read to land behind a
 * concurrent write — so without this story nothing demonstrates the state, and
 * a regression to the removed `hasMore`-driven marker would put the `+` back on
 * {@link TruncatedWithAttributionExceptions} while leaving no story that fails.
 */
export const RacyCountBehindDeliveredRows: Story = {
  args: {
    page: makePage({
      items: manyRows,
      // A count that missed most of the rows travelling beside it.
      total: 12,
      hasMore: false,
      unmatchedCount: 2,
      ambiguousCount: 1,
    }),
  },
};
