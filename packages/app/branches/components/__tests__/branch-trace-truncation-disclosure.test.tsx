import {
  BranchTraceCompletenessState,
  type BranchTraceResult,
  BranchTraceSessionHydrationState,
  BranchTraceUnavailableReason,
  type MergedTraceItem,
} from "@repo/api/src/types/branch-trace";
import { createFakeTraceCommentsSource } from "@repo/app/agents/data-source/__tests__/fake-trace-comments-source";
import { TraceCommentsDataSourceProvider } from "@repo/app/agents/data-source/trace-comments-provider";
import { TRACE_BRANCH_EVENTS_TRUNCATED_NOTE } from "@repo/app/shared/lib/trace-truncation-copy";
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
 * ISS-5075 (stage review): the API flips the merged trace to `incomplete` when a
 * hydrated Session contributed only a capped PREFIX of its turns — and until
 * this, nothing rendered that. The Branch fan-out is the surface where the cap
 * is most likely to bite in the first place, so a merged trace drawn over a cut
 * session with no disclosure is the same lie the session-detail header
 * qualifier exists to prevent.
 */

const SESSIONS_TIMELINE_TAB_RE = /sessions & timeline/i;
const TRUNCATION_SUB_RE = new RegExp(TRACE_BRANCH_EVENTS_TRUNCATED_NOTE, "i");
const PARTIAL_UNAVAILABLE_TITLE_RE = /^Some Session traces are unavailable$/;
const TRACE_FIXTURE: MergedTraceItem[] = [
  { type: "end", sessionId: "s1", text: "done" },
];

describe("Branch merged-trace truncation disclosure (ISS-5075)", () => {
  it("discloses a merged trace built from a truncated Session", async () => {
    await renderSessionsTab(traceResult({ eventsTruncated: true }));

    await waitFor(() =>
      expect(screen.getByText(TRUNCATION_SUB_RE)).toBeInTheDocument()
    );
  });

  it("stays silent when every Session's event stream was read whole", async () => {
    await renderSessionsTab(traceResult());

    expect(screen.queryByText(TRUNCATION_SUB_RE)).not.toBeInTheDocument();
  });

  it("renders truncation and Session unavailability once each when both apply", async () => {
    await renderSessionsTab(
      traceResult({ eventsTruncated: true, sessionUnavailable: true })
    );

    await waitFor(() =>
      expect(screen.getByText(TRUNCATION_SUB_RE)).toBeVisible()
    );
    expect(screen.getAllByText(PARTIAL_UNAVAILABLE_TITLE_RE)).toHaveLength(1);
  });
});

/** A hydrated trace result, optionally carrying the truncation signal. */
function traceResult(
  overrides: { eventsTruncated?: true; sessionUnavailable?: true } = {}
): BranchTraceResult {
  const completeness = {
    state:
      overrides.eventsTruncated || overrides.sessionUnavailable
        ? BranchTraceCompletenessState.Incomplete
        : BranchTraceCompletenessState.Complete,
    ...(overrides.sessionUnavailable
      ? { reason: BranchTraceUnavailableReason.PageFailure }
      : {}),
    ...(overrides.eventsTruncated ? { eventsTruncated: true as const } : {}),
  };
  return {
    items: [...TRACE_FIXTURE],
    sessions: overrides.sessionUnavailable
      ? [
          {
            identity: {
              artifactId: "s2",
              name: "Unavailable Session",
              navigableRef: "SES-2",
              slug: "SES-2",
            },
            reason: BranchTraceUnavailableReason.PageFailure,
            state: BranchTraceSessionHydrationState.Unavailable,
          },
        ]
      : [],
    qualifyingSessionCount: overrides.sessionUnavailable ? 2 : 1,
    completeness,
    aggregateCompleteness: completeness,
  };
}

async function renderSessionsTab(result: BranchTraceResult): Promise<void> {
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
    <AppCoreStoryProviders>
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
