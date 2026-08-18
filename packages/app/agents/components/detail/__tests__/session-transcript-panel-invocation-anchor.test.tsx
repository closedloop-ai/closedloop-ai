import { AgentComponentInvocationAnchorKind } from "@repo/api/src/types/agent-component-invocation";
import type {
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { TraceRowTranslators } from "../../../lib/timeline-row-space";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionTranscriptPanel } from "../session-transcript-panel";

const SESSION_ID = "session-transcript-invocation-anchor";

describe("SessionTranscriptPanel invocation anchors", () => {
  it("resolves changed invocation anchors after local rows mount and ignores missing anchors", async () => {
    const onResolved = vi.fn();
    const first = {
      ...dbPrompt("first prompt"),
      transcriptIdentity: { userTurnId: "turn-1" },
    };
    const second = {
      ...dbPrompt("second prompt"),
      _row: 7,
      transcriptIdentity: { userTurnId: "turn-2" },
    };
    const renderPanelWithAnchor = (userTurnId: string) => (
      <AppCoreStoryProviders>
        <SessionTranscriptPanel
          fallbackItems={[first, second]}
          invocationAnchor={{
            kind: AgentComponentInvocationAnchorKind.UserTurn,
            userTurnId,
          }}
          onInvocationAnchorResolved={onResolved}
          session={session()}
        />
      </AppCoreStoryProviders>
    );
    const { rerender } = render(renderPanelWithAnchor("turn-1"));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(0));
    rerender(renderPanelWithAnchor("turn-2"));
    await waitFor(() => expect(onResolved).toHaveBeenLastCalledWith(7));

    rerender(renderPanelWithAnchor("missing-turn"));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(2));
  });

  // FEA-4252: the panel publishes a translator that maps a Session Timeline jump
  // row (DB `session.turnItems` space) into the rendered trace's `_row` space.
  // Here the rendered trace holds an extra leading turn, so the same logical
  // prompt/tool live at higher rows than the timeline computed from the DB.
  it("publishes row translators that map between timeline and rendered rows", async () => {
    let translators: TraceRowTranslators | null = null;
    // DB projection the timeline is computed from: prompt at row 0, tools at 1.
    const dbItems: TurnItem[] = [
      identifiedPrompt(0, "u-1", "first prompt"),
      dbTools(1, "toolu_a"),
    ];
    // Rendered trace with a leading say turn, shifting the shared turns to 1/2.
    const renderedItems: TurnItem[] = [
      daySay(0),
      identifiedPrompt(1, "u-1", "first prompt"),
      dbTools(2, "toolu_a"),
    ];

    render(
      <AppCoreStoryProviders>
        <SessionTranscriptPanel
          fallbackItems={renderedItems}
          onTraceRowTranslatorChange={(next) => {
            translators = next;
          }}
          session={{ ...session(), turnItems: dbItems }}
        />
      </AppCoreStoryProviders>
    );

    await waitFor(() => expect(translators).not.toBeNull());
    const resolved = translators as unknown as TraceRowTranslators;
    // Forward: DB row 0 -> rendered row 1; DB row 1 -> rendered row 2 (distinct
    // targets, not a fixed offset). The rendered trace has rows, so it is live.
    expect(resolved.toRendered(0)).toBe(1);
    expect(resolved.toRendered(1)).toBe(2);
    expect(resolved.hasRenderedRows).toBe(true);
    // Reverse (the "you are here" marker): rendered row 2 -> DB row 1.
    expect(resolved.toTrace(2)).toBe(1);
  });
});

function identifiedPrompt(
  row: number,
  userTurnId: string,
  text: string
): TurnItem {
  return {
    type: "prompt",
    _row: row,
    t: "2026-07-09T11:00:00.000Z",
    tMs: Date.parse("2026-07-09T11:00:00.000Z"),
    cum: 0,
    actor: { name: null, sessionId: SESSION_ID, human: "Ada", color: "#000" },
    text,
    transcriptIdentity: { userTurnId },
  };
}

function dbTools(row: number, providerToolUseId: string): TurnItem {
  return {
    type: "tools",
    _row: row,
    t: "2026-07-09T11:00:01.000Z",
    tMs: Date.parse("2026-07-09T11:00:01.000Z"),
    endMs: Date.parse("2026-07-09T11:00:01.000Z"),
    cum: 0,
    actor: {
      name: "claude",
      sessionId: SESSION_ID,
      human: null,
      color: "#111",
    },
    summary: "Ran 1 tool",
    items: [
      {
        label: "Bash",
        detail: "",
        err: false,
        transcriptIdentity: { providerToolUseId },
      },
    ],
    hasFail: false,
    failN: 0,
    cats: {},
  };
}

function daySay(row: number): TurnItem {
  return {
    type: "say",
    _row: row,
    t: "2026-07-09T11:00:00.500Z",
    tMs: Date.parse("2026-07-09T11:00:00.500Z"),
    cum: 0,
    actor: {
      name: "claude",
      sessionId: SESSION_ID,
      human: null,
      color: "#111",
    },
    text: "cloud-only preamble",
    transcriptIdentity: { timestamp: "preamble", timestampOrdinal: 0 },
  };
}

function dbPrompt(text: string): TurnItem {
  return {
    type: "prompt",
    _row: 0,
    t: "2026-07-09T11:00:00.000Z",
    tMs: Date.parse("2026-07-09T11:00:00.000Z"),
    cum: 0,
    actor: { name: null, sessionId: SESSION_ID, human: "Ada", color: "#000" },
    text,
  };
}

function session(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness: "claude",
    transcripts: undefined,
  });
}
