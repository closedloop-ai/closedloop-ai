import type {
  AgentSessionDetail,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import {
  decodeSessionEventCursor,
  encodeSessionEventCursor,
} from "@repo/api/src/types/agent-session-event-cursor";
import type { AgentSessionEventsPage } from "@repo/api/src/types/agent-session-events-page";
import { SESSION_TRANSCRIPT_LOAD_MORE_EVENTS_FLAG_KEY } from "@repo/api/src/types/session-transcript-load-more-events-flag";
import { formatTraceCostPrecise } from "@repo/lib/sessions/trace-cost-format";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TRACE_END_OF_READ_NOTE } from "../../../../shared/lib/trace-truncation-copy";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type {
  FixtureRequestContext,
  FixtureRoute,
} from "../../../../shared/storybook/fixture-fetch";
import {
  AgentSessionsDataSourceProvider,
  useAgentSessionsDataSource,
} from "../../../data-source/provider";
import { buildTurnItemsFromEventUnion } from "../../../lib/session-event-union-turn-items";
import type { TraceRowTranslators } from "../../../lib/timeline-row-space";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionTranscriptPanel } from "../session-transcript-panel";
import {
  LOAD_MORE_EVENTS_ERROR,
  LOAD_MORE_EVENTS_LABEL,
} from "../transcript-load-more-copy";

/**
 * ISS-9857: the transcript panel's way past the detail read's event prefix,
 * through the HTTP source and its fixture route. The desktop-local twin is
 * covered by the desktop renderer wiring test; the projection arithmetic by
 * `agents/lib/__tests__/session-event-union-turn-items.test.ts`. What THIS file
 * pins is the panel: when the control exists, what a click does, and when the
 * end-of-read note stops claiming the rows stop early.
 */

const SESSION_ID = "session-detail-1";
const EVENTS_PATH = `/agent-sessions/${SESSION_ID}/events`;
const FLAGS = [SESSION_TRANSCRIPT_LOAD_MORE_EVENTS_FLAG_KEY] as const;
const BUTTON_NAME = LOAD_MORE_EVENTS_LABEL;
const PREFIX_END_MS = Date.parse("2026-06-10T12:17:00.000Z");
const PAGE_ONE_TOOL = "page-one-tool";
const PAGE_TWO_TOOL = "page-two-tool";
const COST_POINT_USD = 1.5;

/**
 * A truncated, desktop-shaped detail: no `transcripts` (a cloud detail always
 * carries a summary and never renders the projection), and `turnItems` produced
 * by the SAME projector the producers run — the fixture's hand-written rows
 * carry no `transcriptIdentity`, and the translator assertions below need the
 * producer's real identities.
 */
function truncatedSession(
  overrides: Partial<AgentSessionDetail> = {}
): AgentSessionDetail {
  const base = createAgentSessionDetailFixture({
    id: SESSION_ID,
    eventsTruncated: true,
    metadata: {
      messages: [
        {
          role: "human",
          timestamp: "2026-06-10T12:01:00.000Z",
          text: "Please inspect the shared session detail screen.",
        },
      ],
    },
    ...overrides,
  });
  return {
    ...base,
    turnItems: buildTurnItemsFromEventUnion({
      session: base,
      pageEvents: [],
      context: {
        harness: base.harness,
        primaryModel: base.primaryModel ?? base.model,
        humanActor: { name: "Ada Lovelace", color: "hsl(210 65% 45%)" },
      },
      eventsTruncated: true,
    }),
  };
}

function pageEvents(
  toolName: string,
  count: number,
  fromMs: number
): SyncedAgentSessionEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    externalEventId: `${toolName}-${index}`,
    agentExternalId: "agent-main",
    eventType: "tool_use",
    toolName,
    createdAt: new Date(fromMs + (index + 1) * 60_000).toISOString(),
  }));
}

function firstCursorOf(session: AgentSessionDetail): string {
  const last = session.events.at(-1);
  const cursor =
    last &&
    encodeSessionEventCursor({
      createdAt: last.createdAt,
      externalEventId: last.externalEventId,
    });
  if (!cursor) {
    throw new Error("fixture prefix cannot mint a cursor");
  }
  return cursor;
}

/**
 * Two pages: the first offers a continuation, the second does not. Every
 * request is recorded so a test can count calls and read the cursor sent.
 */
function twoPageRoute(
  session: AgentSessionDetail,
  requests: FixtureRequestContext[]
): FixtureRoute {
  const first = firstCursorOf(session);
  const pageOne = pageEvents(PAGE_ONE_TOOL, 2, PREFIX_END_MS);
  const pageOneCursor = encodeSessionEventCursor({
    createdAt: pageOne[1]?.createdAt ?? "",
    externalEventId: pageOne[1]?.externalEventId ?? "",
  });
  return {
    method: "GET",
    path: EVENTS_PATH,
    respond: (context): AgentSessionEventsPage => {
      requests.push(context);
      const cursor = context.searchParams.get("cursor");
      if (cursor === first) {
        return { events: pageOne, nextCursor: pageOneCursor ?? undefined };
      }
      return {
        events: pageEvents(PAGE_TWO_TOOL, 1, PREFIX_END_MS + 10 * 60_000),
      };
    },
  };
}

function renderPanel(input: {
  session: AgentSessionDetail;
  routes?: FixtureRoute[];
  enabledFlags?: readonly string[];
  fileKey?: string;
  onTraceRowTranslatorChange?: (translators: TraceRowTranslators) => void;
}) {
  return render(
    <AppCoreStoryProviders
      apiRoutes={input.routes ?? []}
      enabledFlags={input.enabledFlags ?? FLAGS}
    >
      <SessionTranscriptPanel
        fallbackItems={input.session.turnItems}
        fileKey={input.fileKey}
        onTraceRowTranslatorChange={input.onTraceRowTranslatorChange}
        session={input.session}
      />
    </AppCoreStoryProviders>
  );
}

/** Strips `eventsPage` off whatever source the providers supply. */
function WithoutEventsPage({ children }: { children: React.ReactNode }) {
  const { eventsPage: _eventsPage, ...source } = useAgentSessionsDataSource();
  return (
    <AgentSessionsDataSourceProvider dataSource={source}>
      {children}
    </AgentSessionsDataSourceProvider>
  );
}

describe("SessionTranscriptPanel load more (ISS-9857)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("walks the pages past the prefix and drops the note at exhaustion", async () => {
    const session = truncatedSession();
    const requests: FixtureRequestContext[] = [];
    renderPanel({ session, routes: [twoPageRoute(session, requests)] });

    expect(screen.getByText(TRACE_END_OF_READ_NOTE)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: BUTTON_NAME });
    expect(screen.queryAllByText(PAGE_ONE_TOOL)).toHaveLength(0);

    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getAllByText(PAGE_ONE_TOOL).length).toBeGreaterThan(0)
    );
    // Page one carried a continuation, so the rows still stop early and the
    // note says so beside the control.
    expect(screen.getByText(TRACE_END_OF_READ_NOTE)).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get("cursor")).toBe(
      firstCursorOf(session)
    );
    expect(
      decodeSessionEventCursor(requests[0]?.searchParams.get("cursor"))
    ).toEqual({
      createdAt: session.events.at(-1)?.createdAt,
      externalEventId: session.events.at(-1)?.externalEventId,
    });

    fireEvent.click(screen.getByRole("button", { name: BUTTON_NAME }));
    await waitFor(() =>
      expect(screen.getAllByText(PAGE_TWO_TOOL).length).toBeGreaterThan(0)
    );
    expect(requests).toHaveLength(2);
    // The last page: the rows on screen are the whole stream, so neither the
    // note nor the control has anything left to say.
    expect(screen.queryByText(TRACE_END_OF_READ_NOTE)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: BUTTON_NAME })
    ).not.toBeInTheDocument();
    // The prefix rows are still there — the union replaced, not appended.
    expect(screen.getAllByText(PAGE_ONE_TOOL).length).toBeGreaterThan(0);
  });

  it("keeps the note and offers no control with the flag off", () => {
    const session = truncatedSession();
    renderPanel({
      session,
      routes: [twoPageRoute(session, [])],
      enabledFlags: [],
    });
    expect(screen.getByText(TRACE_END_OF_READ_NOTE)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("offers no control when the source cannot page", () => {
    const session = truncatedSession();
    render(
      <AppCoreStoryProviders
        apiRoutes={[twoPageRoute(session, [])]}
        enabledFlags={FLAGS}
      >
        <WithoutEventsPage>
          <SessionTranscriptPanel
            fallbackItems={session.turnItems}
            session={session}
          />
        </WithoutEventsPage>
      </AppCoreStoryProviders>
    );
    expect(screen.getByText(TRACE_END_OF_READ_NOTE)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("offers no control on a sidechain tab, which paints the main projection too", () => {
    const session = truncatedSession();
    renderPanel({
      session,
      routes: [twoPageRoute(session, [])],
      fileKey: "subagent:agent-review",
    });
    expect(screen.getByText(TRACE_END_OF_READ_NOTE)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("offers no control when the prefix cannot mint a first cursor", () => {
    const session = truncatedSession({ events: [] });
    renderPanel({ session, routes: [twoPageRoute(truncatedSession(), [])] });
    expect(screen.getByText(TRACE_END_OF_READ_NOTE)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("mounts a desktop session whose last event carries a null created_at, flag off and untruncated", () => {
    // The desktop store's `events.created_at` is nullable at runtime though the
    // contract types it `string`, and the detail copies it verbatim. The hook
    // mints a first cursor from every prefix, before it reads the flag or the
    // truncation, so this shape must render — the desktop e2e twin
    // (`session-timeline-unrepaired-bucket-jump.spec.ts`) lost the whole detail
    // pane to it once.
    const { eventsTruncated: _truncated, ...base } = truncatedSession();
    const last = base.events.at(-1);
    if (!last?.toolName) {
      throw new Error("fixture prefix must end on a tool event");
    }
    const untimedLast = { ...last, createdAt: null };
    const session: AgentSessionDetail = {
      ...base,
      events: [
        ...base.events.slice(0, -1),
        untimedLast as unknown as SyncedAgentSessionEvent,
      ],
    };
    renderPanel({ session, routes: [], enabledFlags: [] });
    expect(screen.getAllByText(last.toolName).length).toBeGreaterThan(0);
    expect(screen.queryByText(TRACE_END_OF_READ_NOTE)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("shows the error copy and keeps the control when a page fails", async () => {
    const session = truncatedSession();
    renderPanel({
      session,
      routes: [
        { method: "GET", path: EVENTS_PATH, respond: () => null, status: 500 },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: BUTTON_NAME }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        LOAD_MORE_EVENTS_ERROR
      )
    );
    expect(screen.getByRole("button", { name: BUTTON_NAME })).toBeEnabled();
    expect(screen.getByText(TRACE_END_OF_READ_NOTE)).toBeInTheDocument();
  });

  it("hides the note without an error when the first page is empty and final", async () => {
    const session = truncatedSession();
    renderPanel({
      session,
      routes: [
        {
          method: "GET",
          path: EVENTS_PATH,
          respond: (): AgentSessionEventsPage => ({ events: [] }),
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: BUTTON_NAME }));
    await waitFor(() =>
      expect(screen.queryByText(TRACE_END_OF_READ_NOTE)).not.toBeInTheDocument()
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("asks for a page exactly once while it is in flight", async () => {
    const session = truncatedSession();
    const requests: FixtureRequestContext[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderPanel({
      session,
      routes: [
        {
          method: "GET",
          path: EVENTS_PATH,
          respond: async (context): Promise<AgentSessionEventsPage> => {
            requests.push(context);
            await gate;
            return { events: pageEvents(PAGE_ONE_TOOL, 1, PREFIX_END_MS) };
          },
        },
      ],
    });
    const button = screen.getByRole("button", { name: BUTTON_NAME });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    release?.();
    await waitFor(() =>
      expect(screen.getAllByText(PAGE_ONE_TOOL).length).toBeGreaterThan(0)
    );
    expect(requests).toHaveLength(1);
  });

  it("refuses a producer that echoes a cursor already asked for", async () => {
    const session = truncatedSession();
    const first = firstCursorOf(session);
    renderPanel({
      session,
      routes: [
        {
          method: "GET",
          path: EVENTS_PATH,
          respond: (): AgentSessionEventsPage => ({
            events: pageEvents(PAGE_ONE_TOOL, 1, PREFIX_END_MS),
            nextCursor: first,
          }),
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: BUTTON_NAME }));
    await waitFor(() =>
      expect(screen.getAllByText(PAGE_ONE_TOOL).length).toBeGreaterThan(0)
    );
    fireEvent.click(screen.getByRole("button", { name: BUTTON_NAME }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        LOAD_MORE_EVENTS_ERROR
      )
    );
    // The echoed page was never painted a second time: one tool row for the
    // one event, plus the tools-turn summary that names it.
    expect(screen.getAllByText(PAGE_ONE_TOOL).length).toBeLessThanOrEqual(2);
  });

  it("keeps a prefix row's cost badge across the click (desktop cost points)", async () => {
    // The producer attributed this point to the prefix's tools turn, so the
    // prefix rows already carry the badge the union must keep.
    const session = truncatedSession({
      tokenEventCostPoints: [
        {
          tMs: Date.parse("2026-06-10T12:02:30.000Z"),
          costUsd: COST_POINT_USD,
        },
      ],
    });
    const requests: FixtureRequestContext[] = [];
    renderPanel({ session, routes: [twoPageRoute(session, requests)] });
    const badge = formatTraceCostPrecise(COST_POINT_USD);
    expect(screen.getAllByText(badge).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: BUTTON_NAME }));
    await waitFor(() =>
      expect(screen.getAllByText(PAGE_ONE_TOOL).length).toBeGreaterThan(0)
    );
    expect(screen.getAllByText(badge).length).toBeGreaterThan(0);
  });

  it("re-keys the walk when the prefix boundary moves, and keeps it when it does not", async () => {
    const session = truncatedSession();
    const requests: FixtureRequestContext[] = [];
    const view = renderPanel({
      session,
      routes: [twoPageRoute(session, requests)],
    });
    fireEvent.click(screen.getByRole("button", { name: BUTTON_NAME }));
    await waitFor(() =>
      expect(screen.getAllByText(PAGE_ONE_TOOL).length).toBeGreaterThan(0)
    );

    // A refetch that leaves the prefix where it was keeps the loaded page.
    view.rerender(
      <AppCoreStoryProviders
        apiRoutes={[twoPageRoute(session, requests)]}
        enabledFlags={FLAGS}
      >
        <SessionTranscriptPanel
          fallbackItems={session.turnItems}
          session={{ ...session }}
        />
      </AppCoreStoryProviders>
    );
    expect(screen.getAllByText(PAGE_ONE_TOOL).length).toBeGreaterThan(0);

    // A refetch that moved the boundary names a different walk: the pages
    // loaded after the OLD boundary are not served as its continuation.
    const moved = truncatedSession({
      events: [
        ...session.events,
        {
          externalEventId: "event-5",
          agentExternalId: "agent-main",
          eventType: "tool_use",
          toolName: "moved-boundary",
          createdAt: new Date(PREFIX_END_MS + 30_000).toISOString(),
        },
      ],
    });
    view.rerender(
      <AppCoreStoryProviders
        apiRoutes={[twoPageRoute(session, requests)]}
        enabledFlags={FLAGS}
      >
        <SessionTranscriptPanel
          fallbackItems={moved.turnItems}
          session={moved}
        />
      </AppCoreStoryProviders>
    );
    await waitFor(() =>
      expect(screen.queryAllByText(PAGE_ONE_TOOL)).toHaveLength(0)
    );
    expect(
      screen.getByRole("button", { name: BUTTON_NAME })
    ).toBeInTheDocument();
  });

  it("publishes translators over the union: event rows by strong id, message rows by nearest time", async () => {
    const session = truncatedSession();
    let translators: TraceRowTranslators | undefined;
    renderPanel({
      session,
      routes: [twoPageRoute(session, [])],
      onTraceRowTranslatorChange: (next) => {
        translators = next;
      },
    });
    fireEvent.click(screen.getByRole("button", { name: BUTTON_NAME }));
    await waitFor(() =>
      expect(screen.getAllByText(PAGE_ONE_TOOL).length).toBeGreaterThan(0)
    );
    await waitFor(() => expect(translators?.hasRenderedRows).toBe(true));
    const sourceRows = (session.turnItems ?? []).flatMap((item) =>
      "_row" in item ? [item] : []
    );
    const eventRows = sourceRows.filter(
      (item) => "transcriptIdentity" in item && item.transcriptIdentity?.eventId
    );
    const promptRows = sourceRows.filter((item) => item.type === "prompt");
    expect(eventRows.length).toBeGreaterThan(0);
    expect(promptRows.length).toBeGreaterThan(0);
    for (const item of eventRows) {
      // Event-backed rows keep their strong `eventId`, so the jump lands on the
      // very same event in the union.
      expect(translators?.toRendered(item._row)).toBe(item._row);
    }
    for (const item of promptRows) {
      // A metadata-message row has no event id and resolves by nearest time.
      expect(translators?.toRendered(item._row)).not.toBeNull();
    }
  });
});
