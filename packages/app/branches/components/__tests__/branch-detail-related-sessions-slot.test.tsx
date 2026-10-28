import { BranchDataState } from "@repo/api/src/types/branch";
import { BranchTraceCompletenessState } from "@repo/api/src/types/branch-trace";
import { RELATED_SESSIONS_SECTION_TITLE } from "@repo/app/documents/lib/related-sessions-labels";
import { RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { BranchesDataSource } from "../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import { BranchDetailPage } from "../branch-detail-page";
import { baseProps, makeDetail } from "./branch-detail-page.fixtures";

/**
 * ISS-7235 AC1 — BRANCH inherits the read-only Related Sessions field.
 *
 * Its own file rather than a block appended to `branch-detail-page.test.tsx`:
 * that spec is at 995 logical lines and the 1,000-line ceiling is a lint error,
 * so this seam ships beside it instead of pushing it over (AGENTS.md → "File
 * Size and Organization").
 *
 * The contract under test is placement, not the field's own rendering — the
 * cell and section are covered by `related-sessions-field.test.tsx`. What can
 * only be proven here is that `BranchDetailPage` renders the injected node, and
 * renders it inside the "Branch details" panel rather than anywhere else.
 */
const SLOT_TEST_ID = "related-sessions-slot";
const BRANCH_DETAILS_TAB_LABEL = "Branch details";
const NO_SESSIONS_TITLE = "No sessions on this branch yet";
const AWAITING_SYNC_TITLE = "Branch sync in progress";
const NOT_PRESENT_TITLE = "Branch no longer present";

const fakeBranchesSource: BranchesDataSource = {
  scope: "test",
  list: () => Promise.reject(new Error("list unused")),
  detail: () => Promise.reject(new Error("detail unused")),
  comments: () => Promise.reject(new Error("comments unused")),
  trace: () =>
    Promise.resolve({
      aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
      completeness: { state: BranchTraceCompletenessState.Complete },
      items: [],
      qualifyingSessionCount: 0,
      sessions: [],
    }),
  usage: () => Promise.reject(new Error("usage unused")),
  analytics: () => Promise.reject(new Error("analytics unused")),
  pageData: () => Promise.reject(new Error("pageData unused")),
};

beforeEach(() => {
  // The detail panels issue gateway reads through window.fetch; stub them to the
  // not-connected fallback so this spec stays offline.
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: false,
    status: 404,
    json: () => Promise.resolve({}),
  } as Response);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function render(ui: ReactElement) {
  return rtlRender(ui, {
    // The flag is ON deliberately. With the suite default (no enabled flags)
    // `RelatedSessionsSection` returns null on its own gate, so the negative
    // case below would stay green even if this component self-mounted the
    // section — unfalsifiable against the exact mutation it exists to catch.
    // Enabling it makes the web shell's injection the only thing that can put
    // the section on screen.
    wrapper: ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders
        enabledFlags={[RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY]}
      >
        <BranchesDataSourceProvider dataSource={fakeBranchesSource}>
          {children}
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    ),
  });
}

describe("BranchDetailPage related sessions slot (ISS-7235 AC1)", () => {
  it("renders the injected Related Sessions node inside the Branch details panel", () => {
    render(
      <BranchDetailPage
        {...baseProps({
          detail: makeDetail(),
          relatedSessionsSlot: <div data-testid={SLOT_TEST_ID} />,
        })}
      />
    );

    const slot = screen.getByTestId(SLOT_TEST_ID);
    // Placement is the whole claim, so assert the PANEL it landed in rather than
    // mere presence — a node rendered outside the tabs, or in the Sessions &
    // timeline panel, would satisfy a bare `getByTestId` while being wrong.
    // Radix wires `aria-labelledby` from panel to trigger, so this reads the
    // real accessibility relationship instead of a class name.
    const panel = slot.closest('[role="tabpanel"]');
    expect(panel).not.toBeNull();
    const labelId = panel?.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId as string)?.textContent).toBe(
      BRANCH_DETAILS_TAB_LABEL
    );
    // LAST in the panel, not merely somewhere in it. The prop's docstring makes
    // "the final section before the comments rail" an explicit claim, and panel
    // membership alone stays green if the node is hoisted above the properties
    // panel — so assert the position the docstring promises. The panel's one
    // child is the reading-measure wrapper (ISS-12308), so "last" is read there.
    expect(panel?.lastElementChild?.lastElementChild).toBe(slot);
  });

  // The negative half, meaningful only beside the positive above: desktop passes
  // no slot (`branch-detail-view.tsx`), which is what keeps the web-only
  // `related-sessions-field` key off the packaged renderer. If omitting the prop
  // still rendered something, that gate would be bypassed on a surface with no
  // Labs toggle to close it.
  it("renders nothing in that position when no slot is injected", () => {
    render(<BranchDetailPage {...baseProps({ detail: makeDetail() })} />);

    expect(
      screen.getByRole("tab", { name: BRANCH_DETAILS_TAB_LABEL })
    ).toBeTruthy();
    expect(screen.queryByTestId(SLOT_TEST_ID)).toBeNull();
    // The testid above is emitted by this file's own fixture, so on its own it
    // is unfalsifiable — no production change can turn it red. This second
    // assertion names the SECTION, which only production can render, and so
    // catches the mutation that matters: `{relatedSessionsSlot ?? <RelatedSessionsSection …/>}`.
    // A self-mount would leak the web-only key onto the packaged renderer,
    // which is precisely what injecting from the web shell exists to prevent.
    expect(screen.queryByText(RELATED_SESSIONS_SECTION_TITLE)).toBeNull();
  });

  // PR #5670 review (whitlockk): the slot used to live ONLY inside the `hasSessions`
  // branch, so a branch whose projection says `no_sessions` — a valid, fully
  // loaded branch artifact — took the zero-state path and lost the section
  // entirely. A reader could not tell an established "nothing contributed" from
  // a section that failed to load, which is the exact distinction the field's
  // own loading/failed/empty split exists to keep.
  it("renders the injected node beside the no-sessions zero-state (PR #5670 review)", () => {
    render(
      <BranchDetailPage
        {...baseProps({
          detail: makeDetail({
            dataState: BranchDataState.NoSessions,
            sessionIds: [],
            sessions: [],
          }),
          relatedSessionsSlot: <div data-testid={SLOT_TEST_ID} />,
        })}
      />
    );

    // The zero-state is still the page's answer about SESSIONS ON THE BRANCH;
    // asserting it here keeps this test honest about which path it drove — a
    // detail that silently resolved to Ready would satisfy the slot assertion
    // alone while proving nothing about the empty path.
    expect(screen.getByText(NO_SESSIONS_TITLE)).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByTestId(SLOT_TEST_ID)).toBeTruthy();
  });

  // The deliberate boundary, pinned so it cannot drift into "render it in every
  // empty state". `awaiting_sync` tells the reader the branch record itself is
  // incomplete; a provenance "none" underneath would assert a completeness the
  // page has just denied.
  it("keeps the injected node off the awaiting-sync state", () => {
    render(
      <BranchDetailPage
        {...baseProps({
          detail: makeDetail({
            dataState: BranchDataState.AwaitingSync,
            sessionIds: [],
            sessions: [],
          }),
          relatedSessionsSlot: <div data-testid={SLOT_TEST_ID} />,
        })}
      />
    );

    expect(screen.getByText(AWAITING_SYNC_TITLE)).toBeTruthy();
    expect(screen.queryByTestId(SLOT_TEST_ID)).toBeNull();
  });

  // PR #5670 review (tamsinb): `awaiting_sync` and `not_present` are separate
  // if-branches of `renderBranchEmptyDetailState`, so the sibling above proves
  // nothing about this one — the slot could be added to the not-present branch
  // and that test would stay green. The docstring claims BOTH withhold it for
  // the same reason (the page has just denied that the branch record is intact,
  // so a provenance "none" underneath would assert a completeness it disclaims),
  // and a claim about two branches needs a case per branch.
  it("keeps the injected node off the not-present state", () => {
    render(
      <BranchDetailPage
        {...baseProps({
          detail: makeDetail({
            dataState: BranchDataState.NotPresent,
            sessionIds: [],
            sessions: [],
          }),
          relatedSessionsSlot: <div data-testid={SLOT_TEST_ID} />,
        })}
      />
    );

    expect(screen.getByText(NOT_PRESENT_TITLE)).toBeTruthy();
    expect(screen.queryByTestId(SLOT_TEST_ID)).toBeNull();
  });
});
