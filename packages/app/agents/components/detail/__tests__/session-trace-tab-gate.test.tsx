import type { AgentComponentInvocationSessionTreePage } from "@repo/api/src/types/agent-component-invocation-session-tree";
import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import type { AgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { SESSION_TRACE_TAB_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionDetailWorkspace } from "../session-detail-workspace";

/**
 * ISS-10737 — the Trace tab's gate, tested at the ONE read site that owns it.
 *
 * The load-bearing shape is that each flag state is asserted POSITIVELY as well
 * as negatively: "no Trace tab" on its own is satisfied by a locator that
 * matches nothing, so every absence below is paired with a presence the same
 * locator finds in the other state.
 *
 * `?tab=trace` is driven through a COLD navigation adapter constructed at the
 * pasted href — not by clicking the tab — because a client-side navigation
 * inside an already-mounted app carries the previous render's state and hides
 * exactly the deep-link bug this ticket exists to close.
 */

const SESSION_ID = "session-1";
const TRACE_TAB_NAME = /^Trace$/;
const OVERVIEW_TAB_NAME = /^Overview$/;
/**
 * The overview document's own `h2`. Matched as a HEADING with an exact name,
 * not by text: "Session Trace" also appears in the transcript body, and a bare
 * text matcher finds several nodes.
 */
const SESSION_TRACE_HEADING_NAME = /^Session Trace$/;

function overviewDocumentHeading() {
  return screen.getByRole("heading", {
    level: 2,
    name: SESSION_TRACE_HEADING_NAME,
  });
}

function treePage(): AgentComponentInvocationSessionTreePage {
  return { items: [], total: 0 };
}

function makeTreeRead() {
  return vi.fn(async () => treePage());
}
type TreeRead = ReturnType<typeof makeTreeRead>;

function fakeSource(sessionInvocationTree: TreeRead): AgentSessionsDataSource {
  return {
    scope: "test",
    list: vi.fn(),
    detail: vi.fn(),
    usage: vi.fn(),
    analytics: vi.fn(),
    pageData: vi.fn(),
    sessionInvocationTree,
  };
}

function renderWorkspace({
  flagOn,
  href,
  sessionInvocationTree,
}: {
  flagOn: boolean;
  href: string;
  sessionInvocationTree?: TreeRead;
}) {
  const read = sessionInvocationTree ?? makeTreeRead();
  // A COLD adapter, constructed at the pasted href. There is no prior render
  // for the tab or the view state to survive in.
  const navigation = createMemoryNavigation({ initialPath: href });
  const session: AgentSessionDetail = {
    ...createAgentSessionDetailFixture(),
    id: SESSION_ID,
  };
  render(
    <AppCoreStoryProviders
      enabledFlags={flagOn ? [SESSION_TRACE_TAB_FEATURE_FLAG_KEY] : []}
      navigationAdapter={navigation.adapter}
    >
      <AgentSessionsDataSourceProvider dataSource={fakeSource(read)}>
        <SessionDetailWorkspace
          commentsCollapsed={true}
          commentsRailOpen={false}
          commentsWidth={360}
          onCommentsCollapsedChange={() => undefined}
          onCommentsWidthChange={() => undefined}
          session={session}
        />
      </AgentSessionsDataSourceProvider>
    </AppCoreStoryProviders>
  );
  return { read };
}

describe("ISS-10737 the Trace tab is gated by one closed-by-default key", () => {
  it("renders no tab bar at all when the flag is off", () => {
    renderWorkspace({ flagOn: false, href: "/sessions/session-1" });

    expect(screen.queryByRole("tab", { name: TRACE_TAB_NAME })).toBeNull();
    expect(screen.queryByRole("tab", { name: OVERVIEW_TAB_NAME })).toBeNull();
    // Positive half: the document the flag-off shape must still be.
    expect(overviewDocumentHeading()).toBeVisible();
  });

  it("renders both tabs when the flag is on", () => {
    renderWorkspace({ flagOn: true, href: "/sessions/session-1" });

    expect(screen.getByRole("tab", { name: TRACE_TAB_NAME })).toBeVisible();
    expect(screen.getByRole("tab", { name: OVERVIEW_TAB_NAME })).toBeVisible();
  });

  it("defaults to the overview tab, so an existing deep link lands where it did", () => {
    renderWorkspace({ flagOn: true, href: "/sessions/session-1" });

    expect(
      screen.getByRole("tab", { name: OVERVIEW_TAB_NAME })
    ).toHaveAttribute("aria-selected", "true");
    expect(overviewDocumentHeading()).toBeVisible();
  });

  it("issues no invocation-tree read at all while the flag is off", async () => {
    const read = makeTreeRead();
    renderWorkspace({
      flagOn: false,
      href: "/sessions/session-1?tab=trace",
      sessionInvocationTree: read,
    });

    await waitFor(() => {
      expect(overviewDocumentHeading()).toBeVisible();
    });
    // The query is gated by the subtree NOT EXISTING, not by a threaded
    // boolean: `SessionTraceTab` is never mounted, so nothing calls the port.
    expect(read).not.toHaveBeenCalled();
  });

  it("degrades a pasted ?tab=trace to the overview document when the flag is off", () => {
    renderWorkspace({ flagOn: false, href: "/sessions/session-1?tab=trace" });

    // Not a blank pane and not an error — the document, exactly as before.
    expect(overviewDocumentHeading()).toBeVisible();
    expect(screen.queryByRole("tab", { name: TRACE_TAB_NAME })).toBeNull();
  });

  it("opens a pasted ?tab=trace on the Trace tab in a cold render when the flag is on", async () => {
    const read = makeTreeRead();
    renderWorkspace({
      flagOn: true,
      href: "/sessions/session-1?tab=trace",
      sessionInvocationTree: read,
    });

    expect(screen.getByRole("tab", { name: TRACE_TAB_NAME })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await waitFor(() => {
      expect(read).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    });
  });
});
