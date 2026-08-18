/**
 * ISS-5464: the Sessions tab's truncation notice must state the TRUE session
 * total, not the length of the array that happened to arrive.
 *
 * `sessionsTab` is bounded twice on the way to this component — by
 * `MAX_DETAIL_SESSION_IN_IDS` server-side and, since ISS-5464, by
 * `AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS` — so `sessions.length` is a
 * capped array length. Printing it as "of N" told a user with 1218 sessions
 * "Showing 50 of 1000" while the Sessions metric card directly above read 1218,
 * and after the payload bound it would have read "Showing 50 of 50", i.e. no
 * notice at all. The component's own `sessions` field is the uncapped count and
 * is the only honest total here.
 */
import type {
  AgentComponent,
  AgentComponentDetail,
} from "@repo/api/src/types/agent-component";
import { AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS } from "@repo/api/src/types/agent-component";
import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { formatNumber } from "@repo/app/shared/lib/format-utils";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AGENTS_PAGE_SIZE } from "../../../lib/agents-timeframe";
import { createAgentSessionListItemFixture } from "../../sessions/session-list-fixtures";
import { DetailSessionsTab } from "../detail-sessions-tab";

/** The `tool::Bash` session count that produced the report. */
const TRUE_SESSION_COUNT = 1218;

// Ultracite `useTopLevelRegex`: matchers live at module scope, not inline.
const ANY_OF_N_SESSIONS = /of \d+ sessions/;
const ANY_NOTICE = /Showing/;
const OF_ZERO_SESSIONS = /of 0 sessions/;
const BOUND_AS_TOTAL = new RegExp(
  `of ${AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS} sessions`
);

function sessionsTab(count: number): AgentSessionListItem[] {
  return Array.from({ length: count }, (_, i) =>
    createAgentSessionListItemFixture({
      id: `session-${i + 1}`,
      name: `Session ${i + 1}`,
    })
  );
}

function renderTab(
  trueCount: number | null,
  delivered: number,
  sessionsTabTruncated = false
): ReturnType<typeof render> {
  const component = {
    id: "component-1",
    name: "Bash",
    sessions: trueCount,
  } as AgentComponent;
  return render(
    <DetailSessionsTab
      component={component}
      sessions={sessionsTab(delivered) as AgentComponentDetail["sessionsTab"]}
      sessionsTabTruncated={sessionsTabTruncated}
    />,
    {
      wrapper: ({ children }) => (
        <AppCoreStoryProviders enabledFlags={[]}>
          {children}
        </AppCoreStoryProviders>
      ),
    }
  );
}

describe("DetailSessionsTab — truncation states the true total (ISS-5464)", () => {
  it("counts the sessions that exist, not the ones in the payload", () => {
    renderTab(TRUE_SESSION_COUNT, AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS);

    expect(
      screen.getByText(
        `Showing ${AGENTS_PAGE_SIZE} of ${formatNumber(TRUE_SESSION_COUNT)} sessions`
      )
    ).toBeInTheDocument();
    // The pre-fix predicate was `sessions.length > AGENTS_PAGE_SIZE`, false for a
    // payload bounded AT the page size — the notice vanished entirely and the page
    // silently dropped 1168 sessions. The bounded array length must never surface
    // as the total, either.
    expect(screen.queryByText(BOUND_AS_TOTAL)).toBeNull();
  });

  it("reads unknown rather than inventing a total the producer never computed", () => {
    renderTab(null, AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS + 5);

    expect(
      screen.getByText(
        `Showing ${AGENTS_PAGE_SIZE} of ${AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS + 5}+ sessions`
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(ANY_OF_N_SESSIONS)).toBeNull();
  });

  it("says nothing at all for a light component that fits", () => {
    renderTab(12, 12);

    expect(screen.queryByText(ANY_NOTICE)).toBeNull();
  });

  it("still declares truncation when an unknown total arrives exactly at the bound", () => {
    // The web path bounds `sessionsTab` to exactly the rendered page size, so
    // `delivered > rendered` is never true there. Without the producer's
    // `sessionsTabTruncated` an unknown total would render NO notice, implying
    // the 50 rows are all there are — the same lie in a quieter form.
    renderTab(null, AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS, true);

    expect(
      screen.getByText(
        `Showing ${AGENTS_PAGE_SIZE} of ${AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS}+ sessions`
      )
    ).toBeInTheDocument();
  });

  it("treats a total below the delivered row count as unknown, not as the total", () => {
    // The desktop adapter resolves an unresolvable count to a placeholder `0`
    // (`shared-agent-components-api.ts`, `resolved?.sessions ?? 0`) while still
    // delivering rows. Believing it would hide the notice entirely; printing it
    // would claim "of 0" beside 50 visible rows.
    renderTab(0, AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS, true);

    expect(
      screen.getByText(
        `Showing ${AGENTS_PAGE_SIZE} of ${AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS}+ sessions`
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(OF_ZERO_SESSIONS)).toBeNull();
  });

  it("does not announce a truncation the producer never made (desktop)", () => {
    // The regression this pins: the notice used to key on
    // `delivered >= AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS`, a constant
    // ONLY the cloud read applies. Desktop hydrates `sessionsTab` through
    // `getSharedAgentSessionsWithLocCostByIds`, which caps at nothing, so a
    // component with exactly 50 hydrated sessions and an unresolvable count
    // announced a truncation that had not happened. With the fact carried on the
    // wire instead, a complete desktop payload says nothing.
    renderTab(null, AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS, false);

    expect(screen.queryByText(ANY_NOTICE)).toBeNull();
  });

  it("stays silent on an incredible total when nothing suggests more exist", () => {
    // The other half of the placeholder-`0` case: desktop can report 0 while
    // delivering a handful of rows. The total is not believable, but the payload
    // came back well under the bound, so nothing was truncated and the honest
    // output is no notice at all — not "Showing 3 of 3+ sessions".
    renderTab(0, 3);

    expect(screen.queryByText(ANY_NOTICE)).toBeNull();
  });

  it("keeps the payload bound and the rendered page size in lockstep", () => {
    // The server ships exactly what this tab renders. If either constant moves
    // alone, the surface either wastes bytes again or silently loses rows the
    // notice implies are present.
    expect(AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS).toBe(AGENTS_PAGE_SIZE);
  });
});
