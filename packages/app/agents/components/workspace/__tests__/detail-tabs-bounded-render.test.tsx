/**
 * Regression test for FEA-3579 — "Agent component detail page freezes and
 * crashes the browser".
 *
 * Root cause: the detail-page Sessions/Branches tabs rendered EVERY row of the
 * component's usage history with no pagination or virtualization. A component
 * with a large usage history rendered thousands of DOM rows at once, blowing up
 * memory and freezing the tab.
 *
 * Fix: `DetailSessionsTab` / `DetailBranchesTab` cap the rendered rows at
 * `AGENTS_PAGE_SIZE`. These tests assert the DOM row count stays bounded even
 * when the underlying dataset is far larger.
 */

import type { AgentComponent } from "@repo/api/src/types/agent-component";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import type { BranchRow } from "@repo/api/src/types/branch";
import { BranchStatus } from "@repo/api/src/types/branch";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { AGENTS_PAGE_SIZE } from "../../../lib/agents-timeframe";
import { createAgentSessionListItemFixture } from "../../sessions/session-list-fixtures";
import { DetailBranchesTab } from "../detail-branches-tab";
import { DetailSessionsTab } from "../detail-sessions-tab";

// A dataset comfortably larger than the page-size cap so an unbounded render
// would produce many more rows than the bound allows.
const LARGE_COUNT = AGENTS_PAGE_SIZE * 3;

const RE_SESSION_NAME = /^bounded-session-\d+$/;
const RE_BRANCH_NAME = /^bounded-branch-\d+$/;
const RE_SESSIONS_TRUNCATION_NOTE = /Showing \d+ of \d+ sessions/;

const stubComponent: AgentComponent = {
  id: "component-1",
  slug: "subagent::bounded-render",
  name: "Bounded Render Agent",
  kind: AgentComponentKind.Subagent,
} as AgentComponent;

function makeSessions(count: number): AgentSessionListItem[] {
  return Array.from({ length: count }, (_, i) =>
    createAgentSessionListItemFixture({
      id: `session-${i}`,
      name: `bounded-session-${i}`,
    })
  );
}

function makeBranches(count: number): BranchRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `owner%2Frepo::bounded-branch-${i}`,
    branchName: `bounded-branch-${i}`,
    baseBranch: "main",
    repoFullName: "closedloop-ai/symphony-alpha",
    status: BranchStatus.Open,
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    // Distinct, monotonically increasing timestamps so ordering is testable:
    // higher index == more recently active.
    lastActivityAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    sessionIds: [],
  })) as unknown as BranchRow[];
}

function renderWithProviders(node: React.ReactNode) {
  return render(<AppCoreStoryProviders>{node}</AppCoreStoryProviders>);
}

describe("detail tabs bounded render (FEA-3579)", () => {
  it("caps Sessions-tab rows at AGENTS_PAGE_SIZE for a large dataset", () => {
    renderWithProviders(
      <DetailSessionsTab
        component={stubComponent}
        sessions={makeSessions(LARGE_COUNT)}
      />
    );

    const rendered = screen.getAllByText(RE_SESSION_NAME);
    expect(rendered).toHaveLength(AGENTS_PAGE_SIZE);
  });

  it("renders the shared empty state (not a body-less table) when Sessions is empty", () => {
    renderWithProviders(
      <DetailSessionsTab
        // ISS-5363: a MEASURED zero. An UNSET count used to reach this copy only
        // because the tab coerced it with `?? 0`; it now resolves to the honest
        // unavailable state instead (see
        // `detail-sessions-tab-unknown-usage.test.tsx`), so the true-zero case
        // has to state the zero it is asserting.
        component={{ ...stubComponent, sessions: 0 }}
        sessions={[]}
      />
    );

    // The DS EmptyState body, mirroring the shared Sessions list surface —
    // never a bare GridTable header with no rows underneath. With a measured
    // zero and no `usageSessions`, this is the honest true-zero copy, not the
    // details-unavailable variant.
    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    expect(
      screen.getByText("No sessions have invoked this component yet.")
    ).toBeInTheDocument();
    // No session-name rows render, and no truncation note.
    expect(screen.queryAllByText(RE_SESSION_NAME)).toHaveLength(0);
    expect(screen.queryByText(RE_SESSIONS_TRUNCATION_NOTE)).toBeNull();
  });

  // wongk (#3688): an empty `sessionsTab` projection is NOT proof of zero
  // usage. Desktop keeps a nonzero `component.sessions` metric (and
  // `usageSessions` rows) when it cannot hydrate the individual session
  // records, so the true-zero copy would contradict the metrics shown above.
  // Split details-unavailable from true-zero.
  it("shows 'Session details unavailable' (not true-zero) when usage metrics exist but rows are empty", () => {
    renderWithProviders(
      <DetailSessionsTab
        component={{ ...stubComponent, sessions: 7 } as AgentComponent}
        sessions={[]}
      />
    );

    expect(screen.getByText("Session details unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This data source recorded usage but can't list the individual sessions."
      )
    ).toBeInTheDocument();
    // Must NOT claim zero usage when the metric says otherwise.
    expect(screen.queryByText("No sessions yet")).toBeNull();
  });

  it("shows 'Session details unavailable' when usageSessions exist but rows are empty", () => {
    renderWithProviders(
      <DetailSessionsTab
        component={stubComponent}
        sessions={[]}
        usageSessions={[{ sessionId: "s-1", invocationCount: 3 }]}
      />
    );

    expect(screen.getByText("Session details unavailable")).toBeInTheDocument();
  });

  it("renders all Sessions-tab rows when the dataset is under the cap", () => {
    const count = AGENTS_PAGE_SIZE - 5;
    renderWithProviders(
      <DetailSessionsTab
        component={stubComponent}
        sessions={makeSessions(count)}
      />
    );

    expect(screen.getAllByText(RE_SESSION_NAME)).toHaveLength(count);
  });

  it("shows a 'Showing N of M' truncation note when Sessions dataset exceeds the cap", () => {
    // ISS-5464: the total comes from the component's own `sessions` count, not
    // from the delivered array length (which the server now bounds). Every real
    // payload carries the count, so the fixture supplies it too.
    renderWithProviders(
      <DetailSessionsTab
        component={
          { ...stubComponent, sessions: LARGE_COUNT } as AgentComponent
        }
        sessions={makeSessions(LARGE_COUNT)}
      />
    );

    expect(
      screen.getByText(
        new RegExp(`Showing ${AGENTS_PAGE_SIZE} of ${LARGE_COUNT} sessions`)
      )
    ).toBeInTheDocument();
  });

  it("omits the truncation note when the Sessions dataset is under the cap", () => {
    renderWithProviders(
      <DetailSessionsTab
        component={stubComponent}
        sessions={makeSessions(AGENTS_PAGE_SIZE - 5)}
      />
    );

    expect(screen.queryByText(RE_SESSIONS_TRUNCATION_NOTE)).toBeNull();
  });

  // Bug fix: on the agent-detail Sessions tab the session name looked like a
  // link (hover underline) but did not navigate. `DetailSessionsTab` only wraps
  // the name in an anchor when the surface injects `getSessionHref`; the
  // agent-detail callers (web + desktop) now pass one. These assert the wiring.
  it("renders the session name as a navigable link when getSessionHref is provided", () => {
    renderWithProviders(
      <DetailSessionsTab
        component={stubComponent}
        getSessionHref={(row) => `/acme/sessions/${row.id}`}
        sessions={makeSessions(2)}
      />
    );

    const link = screen.getByRole("link", { name: "bounded-session-0" });
    expect(link).toHaveAttribute("href", "/acme/sessions/session-0");
  });

  // FEA-4051 regression: the session name was a raw `<a href>`, a dead click on
  // the desktop renderer (its hash-store adapter does not intercept a raw
  // anchor). The surface-agnostic `@repo/navigation` `Link` drives the active
  // adapter on a plain left-click. A nested NavigationProvider (memory adapter)
  // overrides the decorator's internal one so the navigation state is
  // observable.
  it("drives the navigation adapter when the session name is clicked (not a raw anchor)", () => {
    const nav = createMemoryNavigation({ initialPath: "/agents" });
    render(
      <AppCoreStoryProviders>
        <NavigationProvider adapter={nav.adapter}>
          <DetailSessionsTab
            component={stubComponent}
            getSessionHref={(row) => `/sessions/${row.id}`}
            sessions={makeSessions(2)}
          />
        </NavigationProvider>
      </AppCoreStoryProviders>
    );

    fireEvent.click(screen.getByRole("link", { name: "bounded-session-0" }));

    expect(nav.getCurrentHref()).toBe("/sessions/session-0");
    expect(nav.getHistory()).toContain("/sessions/session-0");
  });

  it("renders the session name as plain text (no link) when getSessionHref is omitted", () => {
    renderWithProviders(
      <DetailSessionsTab component={stubComponent} sessions={makeSessions(2)} />
    );

    expect(
      screen.queryByRole("link", { name: "bounded-session-0" })
    ).toBeNull();
    // The name still renders — just as non-navigable text.
    expect(screen.getByText("bounded-session-0")).toBeInTheDocument();
  });

  it("caps Branches-tab rows at AGENTS_PAGE_SIZE for a large dataset", () => {
    renderWithProviders(
      <DetailBranchesTab branches={makeBranches(LARGE_COUNT)} />
    );

    const rendered = screen.getAllByText(RE_BRANCH_NAME);
    expect(rendered).toHaveLength(AGENTS_PAGE_SIZE);
  });

  it("renders the shared empty state (not a body-less table) when Branches is empty", () => {
    renderWithProviders(<DetailBranchesTab branches={[]} />);

    // No `usageSessions` with branch attribution → honest true-zero copy.
    expect(screen.getByText("No branches yet")).toBeInTheDocument();
    expect(
      screen.getByText("No branches reference this component yet.")
    ).toBeInTheDocument();
    expect(screen.queryAllByText(RE_BRANCH_NAME)).toHaveLength(0);
  });

  // wongk (#3688): desktop's local detail reader always returns
  // `branchesTab: []`, so an unconditional "no branches reference this
  // component" is a claim its data cannot support. When `usageSessions` carries
  // branch attribution but the branch rows aren't hydrated, show the honest
  // details-unavailable copy instead of the true-zero claim.
  it("shows 'Branch details unavailable' (not true-zero) when usageSessions carry branch attribution but rows are empty", () => {
    renderWithProviders(
      <DetailBranchesTab
        branches={[]}
        usageSessions={[
          { sessionId: "s-1", branchName: "feature/x", invocationCount: 2 },
        ]}
      />
    );

    expect(screen.getByText("Branch details unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This data source can't list the branches that reference this component."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("No branches yet")).toBeNull();
  });

  it("retains the most-recently-active branches when truncating (deterministic slice)", () => {
    // makeBranches assigns higher indices more-recent lastActivityAt values, so
    // the newest AGENTS_PAGE_SIZE branches are the top indices. An unordered
    // slice would keep the lowest indices instead.
    renderWithProviders(
      <DetailBranchesTab branches={makeBranches(LARGE_COUNT)} />
    );

    const rendered = screen
      .getAllByText(RE_BRANCH_NAME)
      .map((el) => el.textContent);
    const newest = `bounded-branch-${LARGE_COUNT - 1}`;
    const oldest = "bounded-branch-0";
    expect(rendered).toContain(newest);
    expect(rendered).not.toContain(oldest);
  });

  it("shows a 'Showing N of M' truncation note when Branches dataset exceeds the cap", () => {
    renderWithProviders(
      <DetailBranchesTab branches={makeBranches(LARGE_COUNT)} />
    );

    // ISS-5464: `branches.length` is a CAPPED array length (the wire
    // `branchesTab` is bounded upstream by the session fan-out + dedupe) and the
    // detail carries no uncapped branch count, so the total is stated as a FLOOR
    // with the house `+` marker rather than as an exact count.
    expect(
      screen.getByText(
        new RegExp(`Showing ${AGENTS_PAGE_SIZE} of ${LARGE_COUNT}\\+ branches`)
      )
    ).toBeInTheDocument();
  });

  // FEA-3520 regression: the Branches-tab recency sort called
  // `lastActivityAt.localeCompare(...)`, assuming a string. A malformed record
  // (the stage Skill-component crash class, same as #3208) can deliver a
  // non-string `lastActivityAt` — a Date or epoch number — which threw a
  // `TypeError` from inside the top-level LiveblocksErrorBoundary → crash-spiral.
  // The tab must render such rows without throwing.
  it("renders Branches with non-string lastActivityAt values without crashing", () => {
    // A Date, an epoch number, and a missing value — every non-string shape a
    // malformed record can carry for the recency-sort key.
    const nonStringActivity: unknown[] = [
      new Date(Date.UTC(2026, 5, 1)),
      Date.UTC(2026, 4, 1),
      undefined,
    ];
    const malformed = makeBranches(3).map((branch, i) => ({
      ...branch,
      lastActivityAt: nonStringActivity[i] as unknown as string,
    })) as unknown as BranchRow[];

    expect(() =>
      renderWithProviders(<DetailBranchesTab branches={malformed} />)
    ).not.toThrow();

    // All three branch rows still render (none dropped, none threw).
    expect(screen.getAllByText(RE_BRANCH_NAME)).toHaveLength(3);
  });
});
