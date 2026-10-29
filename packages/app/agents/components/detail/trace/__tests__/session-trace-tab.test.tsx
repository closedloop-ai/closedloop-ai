import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  type AgentComponentInvocationReadRow,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import type { AgentComponentInvocationSessionTreePage } from "@repo/api/src/types/agent-component-invocation-session-tree";
import type { AgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../../shared/storybook/decorators";
import {
  SESSION_TRACE_KIND_LABEL,
  type SessionTraceTelemetry,
} from "../../../../lib/session-trace/session-trace-node";
import { SessionTraceTab } from "../session-trace-tab";
import { TRACE_ORIGIN_MS } from "./session-trace-span-fixtures";

const SESSION_ID = "session-trace-tab";
const BASE_PATH = `/sessions/${SESSION_ID}`;
const UNSUPPORTED_COPY =
  "This data source does not serve an invocation tree, so the trace cannot be drawn here. That is a statement about the source, not about the session — open this session in the web app to read its trace.";
const ERROR_COPY =
  "The invocation tree for this session could not be loaded. Nothing below is a claim about the session — reload to try again.";
const EMPTY_COPY =
  "No agent components were recorded for this session, so there is no tree to draw. This is a measured zero, not a missing read.";
const SKILL_CHILD_ROW = /skill-child/;
const FOCUS_BUTTON = /^Focus this subtree$/;
const ZOOM_TO_SPAN = /^Zoom to span$/;
const ZOOM_OUT = /^Zoom out$/;
const FIT = /^Fit the whole session$/;
const CRITICAL_PATH = /^Critical path only$/;
const WHOLE_SESSION = /^Whole session$/;
const ERRORS_CHIP = /^Errors 1$/;
const SPAN_DETAIL = /^Span detail: /;
const SUMMARY_TWO_OF_TWO =
  /^2 of 2 placed spans drawn · .* wall clock across 1 agent\.$/;
const SUMMARY_TWO_OF_TWO_NO_AGENT =
  /^2 of 2 placed spans drawn · .* wall clock across 0 agents\.$/;
const SUMMARY_ONE_OF_TWO = /^1 of 2 placed spans drawn · /;
const TRUNCATION = /^2 of this session's invocations are not in this tree/;
const ONE_UNPLACED =
  /^1 invocation carry no readable timestamp.*: #9 Hook hook-unplaced$/;
const TWO_UNPLACED =
  /^2 invocations carry no readable timestamp.*: #1 Tool first, #2 Tool second$/;

type Row = AgentComponentInvocationReadRow & Partial<SessionTraceTelemetry>;

function readRow(
  id: string,
  offsetMs: number | null,
  overrides: Partial<Row> = {}
): Row {
  return {
    id: `row-${id}`,
    externalInvocationId: id,
    sessionId: SESSION_ID,
    externalSessionId: "external-session",
    sourceSessionId: "source-session",
    kind: AgentComponentInvocationKind.Tool,
    componentKey: id,
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt:
      offsetMs === null
        ? null
        : new Date(TRACE_ORIGIN_MS + offsetMs).toISOString(),
    sequence: offsetMs ?? 0,
    anchor: { kind: AgentComponentInvocationAnchorKind.Event, eventId: "e-1" },
    status: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    ...overrides,
  };
}

const TELEMETRY = {
  externalAgentId: "ag-1",
  estimatedCost: 0.5,
  inputTokens: 100,
  outputTokens: 20,
  footprintTokens: 40,
};

/** A measured orchestrator over a failed skill, one unplaced hook, two dropped. */
function fullPage(): AgentComponentInvocationSessionTreePage {
  return {
    items: [
      readRow("orchestrator", 0, {
        durationMs: 10_000,
        succeeded: true,
        ...TELEMETRY,
      }),
      readRow("skill-child", 1000, {
        kind: AgentComponentInvocationKind.Skill,
        parentExternalInvocationId: "orchestrator",
        durationMs: 2000,
        succeeded: false,
        ...TELEMETRY,
      }),
      readRow("hook-unplaced", null, {
        kind: AgentComponentInvocationKind.Hook,
        sequence: 9,
      }),
    ],
    total: 5,
  };
}

function fakeSource(
  sessionInvocationTree?: AgentSessionsDataSource["sessionInvocationTree"]
): AgentSessionsDataSource {
  const source: AgentSessionsDataSource = {
    scope: "test",
    list: vi.fn(),
    detail: vi.fn(),
    usage: vi.fn(),
    analytics: vi.fn(),
    pageData: vi.fn(),
  };
  return sessionInvocationTree === undefined
    ? source
    : { ...source, sessionInvocationTree };
}

function renderTab(
  source: AgentSessionsDataSource,
  search = ""
): { currentHref: () => string } {
  const navigation = createMemoryNavigation({
    initialPath: `${BASE_PATH}${search}`,
  });
  render(
    <AppCoreStoryProviders navigationAdapter={navigation.adapter}>
      <AgentSessionsDataSourceProvider dataSource={source}>
        <SessionTraceTab sessionId={SESSION_ID} />
      </AgentSessionsDataSourceProvider>
    </AppCoreStoryProviders>
  );
  return { currentHref: navigation.getCurrentHref };
}

function reads(page: AgentComponentInvocationSessionTreePage) {
  return vi.fn(async () => page);
}

function params(href: string): URLSearchParams {
  return new URL(href, "http://test.invalid").searchParams;
}

describe("SessionTraceTab states", () => {
  it("says the source cannot serve a tree when the reader is absent", () => {
    renderTab(fakeSource());
    expect(screen.getByText(UNSUPPORTED_COPY)).toBeVisible();
  });

  it("shows a busy skeleton while the tree is loading", () => {
    const pending = vi.fn(
      () =>
        new Promise<AgentComponentInvocationSessionTreePage>(() => undefined)
    );
    renderTab(fakeSource(pending));
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText(ERROR_COPY)).toBeNull();
  });

  it("says the tree could not be loaded when the read fails", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("boom")));
    renderTab(fakeSource(failing));
    expect(await screen.findByText(ERROR_COPY)).toBeVisible();
  });

  it("states a measured zero when the session recorded no components", async () => {
    renderTab(fakeSource(reads({ items: [], total: 0 })));
    expect(await screen.findByText(EMPTY_COPY)).toBeVisible();
  });
});

describe("SessionTraceTab with a loaded tree", () => {
  it("leads with the truncation sentence, summarises, and lists the unplaced call", async () => {
    renderTab(fakeSource(reads(fullPage())));

    expect(await screen.findByText(TRUNCATION)).toBeVisible();
    expect(screen.getByText(SUMMARY_TWO_OF_TWO)).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Invocations with no timestamp" })
    ).toHaveTextContent(ONE_UNPLACED);
    expect(
      screen.queryByRole("region", {
        name: "Values this surface cannot compute yet",
      })
    ).toBeNull();
    expect(screen.queryByRole("region", { name: SPAN_DETAIL })).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Focused subtree" })
    ).toBeNull();
  });

  it("names every missing operand and pluralises the unplaced list", async () => {
    renderTab(
      fakeSource(
        reads({
          items: [
            readRow("a", 0),
            readRow("b", 500),
            readRow("first", null, { sequence: 1 }),
            readRow("second", null, { sequence: 2 }),
          ],
          total: 4,
        })
      )
    );

    const missing = await screen.findByRole("region", {
      name: "Values this surface cannot compute yet",
    });
    expect(missing).toHaveTextContent("Turn spend not recorded");
    expect(missing).toHaveTextContent("Ancestry is flat");
    expect(
      screen.getByRole("region", { name: "Invocations with no timestamp" })
    ).toHaveTextContent(TWO_UNPLACED);
    expect(screen.queryByText(TRUNCATION)).toBeNull();
  });

  it("omits the unplaced section when every call carries a timestamp", async () => {
    renderTab(
      fakeSource(
        reads({ items: [readRow("a", 0), readRow("b", 500)], total: 2 })
      )
    );

    expect(await screen.findByText(SUMMARY_TWO_OF_TWO_NO_AGENT)).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Invocations with no timestamp" })
    ).toBeNull();
  });

  it("selects a span into the URL and opens the inspector for it", async () => {
    const { currentHref } = renderTab(fakeSource(reads(fullPage())));

    fireEvent.click(
      await screen.findByRole("button", { name: SKILL_CHILD_ROW })
    );

    await waitFor(() => {
      expect(params(currentHref()).get("span")).toBe("skill-child");
    });
    expect(
      screen.getByRole("region", { name: "Span detail: skill-child" })
    ).toBeVisible();
  });

  it("focuses a subtree from the inspector and clears it from the trail", async () => {
    const { currentHref } = renderTab(
      fakeSource(reads(fullPage())),
      "?span=skill-child&from=100&to=200"
    );

    fireEvent.click(await screen.findByRole("button", { name: FOCUS_BUTTON }));
    await waitFor(() => {
      expect(params(currentHref()).get("focus")).toBe("skill-child");
    });
    expect(params(currentHref()).get("from")).toBeNull();
    const trail = screen.getByRole("navigation", { name: "Focused subtree" });
    expect(trail).toHaveTextContent("orchestrator");

    fireEvent.click(screen.getByRole("button", { name: "orchestrator" }));
    await waitFor(() => {
      expect(params(currentHref()).get("focus")).toBe("orchestrator");
    });

    fireEvent.click(screen.getByRole("button", { name: WHOLE_SESSION }));
    await waitFor(() => {
      expect(params(currentHref()).get("focus")).toBeNull();
    });
    expect(
      screen.queryByRole("navigation", { name: "Focused subtree" })
    ).toBeNull();
  });

  it("zooms to the selected span, zooms out, and fits", async () => {
    const { currentHref } = renderTab(
      fakeSource(reads(fullPage())),
      "?span=skill-child&focus=orchestrator"
    );

    fireEvent.click(await screen.findByRole("button", { name: ZOOM_TO_SPAN }));
    await waitFor(() => {
      expect(params(currentHref()).get("from")).toBe("1000");
    });
    expect(params(currentHref()).get("to")).toBe("3000");

    fireEvent.click(screen.getByRole("button", { name: ZOOM_OUT }));
    await waitFor(() => {
      expect(params(currentHref()).get("from")).toBeNull();
    });
    expect(params(currentHref()).get("focus")).toBe("orchestrator");

    fireEvent.click(screen.getByRole("button", { name: FIT }));
    await waitFor(() => {
      expect(params(currentHref()).get("focus")).toBeNull();
    });
  });

  it("opens no inspector and disables zoom for a span id the tree does not hold", async () => {
    renderTab(fakeSource(reads(fullPage())), "?span=missing");

    expect(
      await screen.findByRole("button", { name: ZOOM_TO_SPAN })
    ).toBeDisabled();
    expect(screen.queryByRole("region", { name: SPAN_DETAIL })).toBeNull();
  });

  it("toggles the critical-path and errors lenses into the URL", async () => {
    const { currentHref } = renderTab(fakeSource(reads(fullPage())));

    fireEvent.click(await screen.findByRole("button", { name: CRITICAL_PATH }));
    await waitFor(() => {
      expect(params(currentHref()).get("critical")).toBe("1");
    });
    fireEvent.click(screen.getByRole("button", { name: ERRORS_CHIP }));
    await waitFor(() => {
      expect(params(currentHref()).get("errors")).toBe("1");
    });
    fireEvent.click(screen.getByRole("button", { name: CRITICAL_PATH }));
    await waitFor(() => {
      expect(params(currentHref()).get("critical")).toBeNull();
    });
  });

  it("turns a kind off and back on, and never turns off the last one", async () => {
    const { currentHref } = renderTab(fakeSource(reads(fullPage())));
    const skill = SESSION_TRACE_KIND_LABEL[AgentComponentInvocationKind.Skill];

    fireEvent.click(await screen.findByRole("button", { name: skill }));
    await waitFor(() => {
      expect(params(currentHref()).get("kinds")).not.toBeNull();
    });
    expect(params(currentHref()).get("kinds")?.split(",")).not.toContain(
      AgentComponentInvocationKind.Skill
    );

    fireEvent.click(screen.getByRole("button", { name: skill }));
    await waitFor(() => {
      expect(params(currentHref()).get("kinds")).toBeNull();
    });
  });

  it("never turns off the last active kind", async () => {
    const { currentHref } = renderTab(
      fakeSource(reads(fullPage())),
      `?kinds=${AgentComponentInvocationKind.Tool}`
    );
    const tool = SESSION_TRACE_KIND_LABEL[AgentComponentInvocationKind.Tool];
    await screen.findByText(SUMMARY_ONE_OF_TWO);
    const chip = screen.getByRole("button", { name: tool });
    expect(chip).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(chip);

    expect(params(currentHref()).get("kinds")).toBe(
      AgentComponentInvocationKind.Tool
    );
    expect(screen.getByRole("button", { name: tool })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});
