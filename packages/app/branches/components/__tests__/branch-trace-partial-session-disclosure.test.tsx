import {
  BranchTraceCompletenessState,
  type BranchTraceResult,
  BranchTraceSessionHydrationState,
  type MergedTraceItem,
} from "@repo/api/src/types/branch-trace";
import { createFakeTraceCommentsSource } from "@repo/app/agents/data-source/__tests__/fake-trace-comments-source";
import { TraceCommentsDataSourceProvider } from "@repo/app/agents/data-source/trace-comments-provider";
import { BRANCH_TRACE_PARTIAL_SESSION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { traceBranchUnreadableItemsNote } from "@repo/app/shared/lib/trace-truncation-copy";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { BranchesDataSource } from "../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import { BranchDetailPage } from "../branch-detail-page";
import {
  baseProps,
  makeCommentsResponse,
  makeDetail,
  makeTraceComment,
} from "./branch-detail-page.fixtures";

/*
 * ISS-9723: the ruling is BOTH halves — keep the readable extents of a Session
 * carrying one we cannot parse, AND say that something was dropped. A partial
 * trace that renders silently is the failure this exists to prevent, so every
 * case here asserts the rows and the disclosure together.
 *
 * The fixture is a MIXED Session: readable extents either side of a `tools`
 * extent whose `endMs` the shared fold refuses. Its unparseable sibling never
 * reaches the wire — the producer dropped it and reported the count — so what
 * this file guards is what the reader now sees BECAUSE that Session survived.
 */

const SESSIONS_TIMELINE_TAB_RE = /sessions & timeline/i;
const KEPT_BEFORE = "Readable extent before the corrupt one";
const KEPT_AFTER = "Readable extent after the corrupt one";
const KEPT_BEFORE_RE = new RegExp(KEPT_BEFORE);
const KEPT_AFTER_RE = new RegExp(KEPT_AFTER);
const ONE_UNREADABLE_RE = new RegExp(traceBranchUnreadableItemsNote(1));
/**
 * `traceHydrationNoticeCopy`'s aggregate arm, spelled out rather than imported:
 * an expectation the code under test computes agrees with it by construction and
 * cannot fail. It is the sentence a client with no drop count falls back to.
 */
const STALE_CLIENT_UNAVAILABLE_NOTICE =
  "Loaded trace turns remain visible. Additional Session trace activity could not be loaded.";
/**
 * The `29684670315300m 0s` shape #6809 removed: an unguarded `endMs - startMs`
 * over a stamp that is not an instant. Five-plus digits of minutes is roughly a
 * month, which no tool run reaches.
 */
const ABSURD_DURATION_RE = /\d{5,}m \d+s/;
const VALID_DURATION_RE = /^1m 30s$/;
const NOT_A_NUMBER_RE = /NaN/;
const TRACE_START = Date.parse("2026-06-10T10:00:00.000Z");
/** Past `MAX_TRACE_INSTANT_MS`: representable as a number, not as an instant. */
const UNREPRESENTABLE_END_MS = 9_000_000_000_000_000;

describe("Branch merged-trace partial-Session disclosure (ISS-9723)", () => {
  it("renders the readable extents and says how many were dropped", async () => {
    await renderSessionsTab({ enabled: true });

    await waitFor(() =>
      expect(screen.getByText(KEPT_BEFORE_RE)).toBeInTheDocument()
    );
    expect(screen.getByText(KEPT_AFTER_RE)).toBeInTheDocument();
    expect(screen.getByText(ONE_UNREADABLE_RE)).toBeInTheDocument();
  });

  it("withholds the Session and its disclosure when the gate is closed", async () => {
    await renderSessionsTab({ enabled: false });

    await waitFor(() =>
      expect(screen.getByText(VALID_DURATION_RE)).toBeInTheDocument()
    );
    expect(screen.queryByText(KEPT_BEFORE_RE)).not.toBeInTheDocument();
    expect(screen.queryByText(KEPT_AFTER_RE)).not.toBeInTheDocument();
    expect(screen.queryByText(ONE_UNREADABLE_RE)).not.toBeInTheDocument();
  });

  /**
   * ISS-9723 (#6884 review, davetho) — THE DEPLOY-SKEW SHAPE.
   *
   * The API tier ships ahead of the client, so between deploys a client that
   * predates this change receives the new partial trace and strips
   * `unreadableItemCount`: its `loadedSessionSchema` is a plain `z.object`, so
   * the field is dropped rather than rejected and the payload still arrives.
   * That client has no partial-Session reversal either, so it renders the
   * retained rows with the gate closed.
   *
   * What it must NOT do is render them SILENTLY. This case is that client's
   * payload — the same trace with every count stripped — and it must still reach
   * the withholding notice, which it does because the producers may not claim
   * `Complete` over a drop (`validateTraceStateCount` refuses it) and an
   * `Incomplete` trace with no accounted-for cause is what that notice already
   * existed to report. The disclosure degrades from a count to a sentence; it
   * does not disappear.
   *
   * This is the assertion that reddens if the server ever returns a skew shape a
   * stale client renders as a whole trace.
   */
  it("still discloses to a client that stripped the count and has no reversal", async () => {
    await renderSessionsTab({ enabled: false, stripUnreadableCounts: true });

    // The retained rows DO reach that client — this is the exposure the review
    // names, asserted rather than assumed.
    await waitFor(() =>
      expect(screen.getByText(KEPT_BEFORE_RE)).toBeInTheDocument()
    );
    // And it is not silent about them.
    expect(
      screen.getByText(STALE_CLIENT_UNAVAILABLE_NOTICE)
    ).toBeInTheDocument();
    // The count is gone with the field, which is why the sentence has to carry
    // the fact on its own.
    expect(screen.queryByText(ONE_UNREADABLE_RE)).not.toBeInTheDocument();
  });

  it("prints no fabricated duration for a kept extent the fold refused", async () => {
    await renderSessionsTab({ enabled: true });

    await waitFor(() =>
      expect(screen.getByText(KEPT_BEFORE_RE)).toBeInTheDocument()
    );
    // The sibling in the opposite state: this render path DOES print a duration
    // for an extent that survives classification, so the absence of an absurd
    // one above is the #6809 guard holding rather than the label being
    // unreachable from here.
    expect(screen.getByText(VALID_DURATION_RE)).toBeInTheDocument();
    expect(screen.queryByText(ABSURD_DURATION_RE)).not.toBeInTheDocument();
    expect(screen.queryByText(NOT_A_NUMBER_RE)).not.toBeInTheDocument();
  });
});

/**
 * A trace as a producer serves it once one extent has been dropped: the partial
 * Session keeps its readable extents and carries the count of what it lost.
 */
function partialTraceResult(): BranchTraceResult {
  const completeness = {
    state: BranchTraceCompletenessState.Incomplete,
  } as const;
  return {
    items: partialTraceItems(),
    sessions: [
      {
        identity: {
          artifactId: "s1",
          name: "Partial Session",
          navigableRef: "SES-1",
          slug: "SES-1",
        },
        state: BranchTraceSessionHydrationState.Loaded,
        unreadableItemCount: 1,
      },
      {
        identity: {
          artifactId: "s2",
          name: "Whole Session",
          navigableRef: "SES-2",
          slug: "SES-2",
        },
        state: BranchTraceSessionHydrationState.Loaded,
      },
    ],
    qualifyingSessionCount: 2,
    completeness,
    aggregateCompleteness: completeness,
  };
}

function partialTraceItems(): MergedTraceItem[] {
  return [
    {
      type: "say",
      sessionId: "s1",
      t: new Date(TRACE_START).toISOString(),
      tMs: TRACE_START,
      cumCostUsd: null,
      actorName: "alice",
      text: KEPT_BEFORE,
    },
    {
      // Schema-valid, fold-refused. Newly reachable: before ISS-9723 its Session
      // carried an unparseable sibling and was withheld whole, so nothing in
      // this Session ever reached a duration label.
      type: "tools",
      sessionId: "s1",
      t: new Date(TRACE_START + 1000).toISOString(),
      tMs: TRACE_START + 1000,
      endMs: UNREPRESENTABLE_END_MS,
      summary: "read files",
      hasFail: false,
      failN: 0,
    },
    {
      type: "say",
      sessionId: "s1",
      t: new Date(TRACE_START + 2000).toISOString(),
      tMs: TRACE_START + 2000,
      cumCostUsd: null,
      actorName: "alice",
      text: KEPT_AFTER,
    },
    {
      type: "tools",
      sessionId: "s2",
      t: new Date(TRACE_START + 10_000).toISOString(),
      tMs: TRACE_START + 10_000,
      endMs: TRACE_START + 100_000,
      summary: "run tests",
      hasFail: false,
      failN: 0,
    },
  ];
}

/**
 * The same served trace as a client predating `unreadableItemCount` receives it:
 * the field stripped by a non-strict schema, everything else intact. Derived
 * from {@link partialTraceResult} rather than authored separately, so the two
 * cannot drift into describing different traces.
 */
function countStrippedTraceResult(): BranchTraceResult {
  const result = partialTraceResult();
  return {
    ...result,
    sessions: result.sessions.map((session) =>
      session.state === BranchTraceSessionHydrationState.Loaded
        ? {
            identity: session.identity,
            state: BranchTraceSessionHydrationState.Loaded,
          }
        : session
    ),
  };
}

async function renderSessionsTab({
  enabled,
  stripUnreadableCounts = false,
}: {
  enabled: boolean;
  stripUnreadableCounts?: boolean;
}): Promise<void> {
  const result = stripUnreadableCounts
    ? countStrippedTraceResult()
    : partialTraceResult();
  const source: BranchesDataSource = {
    scope: "test",
    list: () => Promise.reject(new Error("list unused")),
    detail: () => Promise.reject(new Error("detail unused")),
    comments: (id) => Promise.resolve(makeCommentsResponse(id)),
    trace: () => Promise.resolve(result),
    usage: () => Promise.reject(new Error("usage unused")),
    analytics: () => Promise.reject(new Error("analytics unused")),
    pageData: () => Promise.reject(new Error("pageData unused")),
  };
  render(
    <AppCoreStoryProviders
      enabledFlags={
        enabled ? [BRANCH_TRACE_PARTIAL_SESSION_FEATURE_FLAG_KEY] : []
      }
    >
      <BranchesDataSourceProvider dataSource={source}>
        <TraceCommentsDataSourceProvider
          dataSource={createFakeTraceCommentsSource({
            commentsByTarget: new Map(),
            makeTraceComment,
          })}
        >
          <BranchDetailPage {...baseProps({ detail: makeDetail() })} />
        </TraceCommentsDataSourceProvider>
      </BranchesDataSourceProvider>
    </AppCoreStoryProviders>
  );
  await userEvent.click(
    screen.getByRole("tab", { name: SESSIONS_TIMELINE_TAB_RE })
  );
}
