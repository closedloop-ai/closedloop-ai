/**
 * @description ISS-9857 — the "Load more events" control on the PRODUCTION
 * desktop path.
 *
 * The shared panel's own suite (`packages/app/.../session-transcript-load-more.test.tsx`)
 * proves the control against the HTTP source and a fixture route. This one
 * proves the desktop wiring: the real `SessionDetailView`, the real local data
 * source over a stubbed `window.desktopApi`, the real detail query, and a
 * `tokenEventCostPoints`-carrying local detail. It fails if the local source
 * stops offering `eventsPage`, if the first cursor stops being minted from the
 * served prefix, or if a prefix row's cost badge is lost on the click.
 */
import type {
  AgentSessionDetail,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import {
  decodeSessionEventCursor,
  encodeSessionEventCursor,
} from "@repo/api/src/types/agent-session-event-cursor";
import type {
  AgentSessionEventsPage,
  AgentSessionEventsPageRequest,
} from "@repo/api/src/types/agent-session-events-page";
import { SESSION_TRANSCRIPT_LOAD_MORE_EVENTS_FLAG_KEY } from "@repo/api/src/types/session-transcript-load-more-events-flag";
import { LOAD_MORE_EVENTS_LABEL } from "@repo/app/agents/components/detail/transcript-load-more-copy";
import { buildTurnItemsFromEventUnion } from "@repo/app/agents/lib/session-event-union-turn-items";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { TRACE_END_OF_READ_NOTE } from "@repo/app/shared/lib/trace-truncation-copy";
import { formatTraceCostPrecise } from "@repo/lib/sessions/trace-cost-format";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupContainerWidthStub } from "../../../__tests__/container-width-fixture";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { SessionDetailView } from "../SessionDetailView";
import { sessionDetail } from "./fixtures/session-detail-fixture";

const { searchParamsMock } = vi.hoisted(() => ({ searchParamsMock: vi.fn() }));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: searchParamsMock,
}));

const SESSION_ID = "load-more-wiring-session";
const BUTTON_NAME = LOAD_MORE_EVENTS_LABEL;
const PAGE_TOOL = "loaded-page-tool";
/** The coalesced tools card, before and after the page joins it. */
const PREFIX_TOOLS_SUMMARY = /Ran 2 tools/;
const UNION_TOOLS_SUMMARY = /Ran 3 tools/;
const COST_POINT_USD = 2.25;
const PREFIX_TOOL_AT = "2026-06-10T12:02:00.000Z";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

/**
 * A truncated LOCAL detail: no `transcripts` (nothing on disk), the desktop's
 * cost points, and `turnItems` produced by the producer's own projector so the
 * prefix rows carry the badge the union must keep.
 */
function truncatedLocalDetail(): AgentSessionDetail {
  const base = sessionDetail({
    id: SESSION_ID,
    name: "Load more wiring session",
    status: "active",
    overrides: {
      eventsTruncated: true,
      events: [
        {
          externalEventId: "prefix-1",
          agentExternalId: "agent-main",
          eventType: "tool_use",
          toolName: "rg",
          summary: "Inspected current detail callers.",
          createdAt: PREFIX_TOOL_AT,
        },
        {
          externalEventId: "prefix-2",
          agentExternalId: "agent-main",
          eventType: "tool_use",
          toolName: "playwright",
          summary: "Captured screenshots.",
          createdAt: "2026-06-10T12:17:00.000Z",
        },
      ],
      transcripts: undefined,
      metadata: {
        messages: [
          {
            role: "human",
            timestamp: "2026-06-10T12:01:00.000Z",
            text: "Inspect the shared session detail screen.",
          },
        ],
      },
      tokenEventCostPoints: [
        {
          tMs: Date.parse("2026-06-10T12:02:30.000Z"),
          costUsd: COST_POINT_USD,
        },
      ],
    },
  });
  return {
    ...base,
    turnItems: buildTurnItemsFromEventUnion({
      session: base,
      pageEvents: [],
      context: {
        harness: base.harness,
        primaryModel: base.primaryModel ?? base.model,
        humanActor: { name: "Local Desktop session", color: "var(--primary)" },
      },
      eventsTruncated: true,
    }),
  };
}

function pageEvents(fromMs: number): SyncedAgentSessionEvent[] {
  return [
    {
      externalEventId: "loaded-1",
      agentExternalId: "agent-main",
      eventType: "tool_use",
      toolName: PAGE_TOOL,
      summary: "Loaded past the prefix.",
      createdAt: new Date(fromMs + 60_000).toISOString(),
    },
  ];
}

function installDesktopApi(detail: AgentSessionDetail) {
  const eventsPage = vi.fn(
    (
      _request: AgentSessionEventsPageRequest
    ): Promise<AgentSessionEventsPage> => {
      const last = detail.events.at(-1);
      // One final page: no `nextCursor`, so the walk ends on this click.
      return Promise.resolve({
        events: pageEvents(Date.parse(last?.createdAt ?? PREFIX_TOOL_AT)),
      });
    }
  );
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: {
        detail: vi.fn(async () => detail),
        eventsPage,
      },
      db: {
        getSubAgents: vi.fn(),
        getTools: vi.fn(),
        getWorkflowData: vi.fn(),
      },
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
    },
  });
  return eventsPage;
}

function renderDesktopShell(enabledFlags: readonly string[]) {
  return render(
    <DesktopAppCoreProvider>
      {/* Inside the app-core provider: it mounts its own all-off adapter above
          `App`, and the production flag provider mounts inside it. */}
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
      >
        <NavigationProvider
          adapter={createMemoryNavigation({ initialPath: "/sessions" }).adapter}
        >
          <SessionDetailView backHref="/sessions" sessionId={SESSION_ID} />
        </NavigationProvider>
      </FeatureFlagAdapterProvider>
    </DesktopAppCoreProvider>
  );
}

setupContainerWidthStub();

beforeEach(() => {
  searchParamsMock.mockReturnValue(new URLSearchParams());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("SessionDetailView — load more events wiring (ISS-9857)", () => {
  it("pages past the local prefix over IPC, keeping the prefix's cost badge", async () => {
    const detail = truncatedLocalDetail();
    const eventsPage = installDesktopApi(detail);
    renderDesktopShell([SESSION_TRANSCRIPT_LOAD_MORE_EVENTS_FLAG_KEY]);

    const button = await screen.findByRole(
      "button",
      { name: BUTTON_NAME },
      { timeout: 10_000 }
    );
    expect(screen.getByText(TRACE_END_OF_READ_NOTE)).toBeDefined();
    const badge = formatTraceCostPrecise(COST_POINT_USD);
    expect(screen.getAllByText(badge).length).toBeGreaterThan(0);

    // The prefix's two tool events coalesce into one card; the page's event
    // joins that same card once the union is re-projected.
    expect(screen.getByText(PREFIX_TOOLS_SUMMARY)).toBeDefined();

    fireEvent.click(button);
    await waitFor(
      () => expect(screen.getByText(UNION_TOOLS_SUMMARY)).toBeDefined(),
      { timeout: 10_000 }
    );
    // The first cursor names the served prefix's last event, decoded on the
    // main-process side from what crossed the bridge.
    expect(eventsPage).toHaveBeenCalledTimes(1);
    const request = eventsPage.mock.calls[0]?.[0];
    expect(request?.id).toBe(SESSION_ID);
    expect(decodeSessionEventCursor(request?.cursor)).toEqual({
      createdAt: detail.events.at(-1)?.createdAt,
      externalEventId: detail.events.at(-1)?.externalEventId,
    });
    expect(request?.cursor).toBe(
      encodeSessionEventCursor({
        createdAt: detail.events.at(-1)?.createdAt ?? "",
        externalEventId: detail.events.at(-1)?.externalEventId ?? "",
      })
    );
    // The union re-projection kept the desktop's cost attribution.
    expect(screen.getAllByText(badge).length).toBeGreaterThan(0);
    // That page was the last one, so the rows on screen are the whole stream:
    // the end-of-read note and the control are gone.
    expect(screen.queryByText(TRACE_END_OF_READ_NOTE)).toBeNull();
    expect(screen.queryByRole("button", { name: BUTTON_NAME })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  }, 20_000);

  it("renders the note alone with the flag off", async () => {
    const detail = truncatedLocalDetail();
    const eventsPage = installDesktopApi(detail);
    renderDesktopShell([]);

    await screen.findByText(TRACE_END_OF_READ_NOTE, undefined, {
      timeout: 10_000,
    });
    expect(screen.queryByRole("button", { name: BUTTON_NAME })).toBeNull();
    expect(eventsPage).not.toHaveBeenCalled();
  });
});
