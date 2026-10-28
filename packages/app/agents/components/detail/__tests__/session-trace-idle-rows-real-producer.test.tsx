import type { TurnItem } from "@repo/api/src/types/agent-session";
import {
  IdleConcept,
  idleConceptLabel,
} from "@repo/api/src/types/idle-concepts";
import { SESSION_TRACE_IDLE_ROWS_FLAG_KEY } from "@repo/api/src/types/session-trace-idle-rows-flag";
import { mergedTraceToSessionTraceItems } from "@repo/app/branches/lib/branch-merged-trace-adapter";
import {
  buildMergedTrace,
  MERGED_TRACE_IDLE_THRESHOLD_MS,
  type MergedTraceSessionInput,
} from "@repo/lib/branches/merged-trace";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionTrace } from "../session-trace";
import { formatIdleRowLabel } from "../trace-idle-row";
import { withProviders } from "./agent-session-detail-view.test-helpers";

/**
 * ISS-8652 through the REAL producer chain, end to end and with no idle item
 * written by hand anywhere in the file.
 *
 * #6325 review (whitlockk): the sibling suite
 * (`session-trace-idle-rows.test.tsx`) hands `SessionTrace` a scenario fixture
 * whose `{ type: "idle" }` item is authored directly, so it proves the ROW
 * renders but never proves anything upstream of it produces that item. Two
 * links were therefore unexercised — `buildMergedTrace`'s threshold decision,
 * and `mergedTraceToSessionTraceItems`' `gap: item.gapMs` — and either could
 * break with the whole suite green.
 *
 * Here the only authored inputs are two sessions' `turnItems` with real
 * timestamps. `buildMergedTrace` decides whether a gap is idle, the branch
 * adapter converts what it decided, and the mounted component renders it. The
 * span is never named until it is asserted.
 *
 * This is the package-level half of that review point. The web E2E remains in
 * `e2e/session-trace-idle-rows.spec.ts`; the shared-only Electron duplicate was
 * removed in ISS-10527. This jsdom suite does not prove native-shell execution.
 */

/** Well over the 2-minute threshold, and a round number the label can state. */
const IDLE_GAP_MS = 5 * 60_000;
/** Comfortably UNDER it, so the same chain must synthesize nothing. */
const SUB_THRESHOLD_GAP_MS = 30_000;
const SESSION_START_MS = Date.UTC(2026, 7, 31, 9, 0, 0);

/**
 * THIS constant, and only this one: the sentence a PRESENCE assertion looks
 * for, spelled out rather than imported from `formatIdleRowLabel`. A presence
 * expectation computed by the code under test agrees with it by construction
 * and cannot fail — same reasoning as the sibling suite's literals.
 *
 * It is not the file's rule. `TOOL_RUN_UNCORRECTED_ROW_TEXT` below is an
 * ABSENCE assertion and deliberately goes the other way, because the two fail
 * in opposite directions: a presence literal that stops matching turns the test
 * red, while an absence literal that stops matching turns it permanently green
 * (ISS-10117, AGENTS.md → Test Practices).
 */
const IDLE_ROW_TEXT = "Idle gap · 5m";
/** Any idle row at all, for the sub-threshold case where none may render. */
const ANY_IDLE_ROW = (content: string) =>
  content.includes(idleConceptLabel(IdleConcept.TraceGap));

const FIRST_PROMPT = "Open the branch";
const SECOND_PROMPT = "Now ship it";

/** ISS-8720: a run long enough that the two derivations cannot agree. */
const TOOL_RUN_MS = 10 * 60_000;
const TOOL_RUN_PAUSE_MS = 6 * 60_000;
const TOOL_RUN_SUMMARY = "12 migration tools";
/** The pause the reader waited. */
const TOOL_RUN_IDLE_ROW_TEXT = "Idle gap · 6m";
/**
 * What a start-to-start span prints, asserted absent — and computed through the
 * renderer's own formatter on purpose, so a reworded label cannot leave this
 * looking for a string nothing emits.
 */
const TOOL_RUN_UNCORRECTED_ROW_TEXT = formatIdleRowLabel(
  TOOL_RUN_MS + TOOL_RUN_PAUSE_MS
);

describe("session trace idle rows — real producer chain (ISS-8652)", () => {
  it("renders a gap that buildMergedTrace itself judged idle, flag on", () => {
    render(
      withProviders(<SessionTrace items={realTraceItems(IDLE_GAP_MS)} />, [
        SESSION_TRACE_IDLE_ROWS_FLAG_KEY,
      ])
    );

    // The turns either side render, so this is a gap inside a populated trace.
    expect(screen.getByText(FIRST_PROMPT)).toBeInTheDocument();
    expect(screen.getByText(SECOND_PROMPT)).toBeInTheDocument();
    expect(screen.getByText(IDLE_ROW_TEXT)).toBeInTheDocument();
  });

  /*
   * The closed-by-default half (ISS-4779) on the SAME real items: a mounted
   * provider that does not carry the key. Without this, "always render the row"
   * satisfies the spec above.
   */
  it("renders no idle row for those same real items while the gate is closed", () => {
    render(
      withProviders(<SessionTrace items={realTraceItems(IDLE_GAP_MS)} />, [])
    );

    expect(screen.getByText(FIRST_PROMPT)).toBeInTheDocument();
    expect(screen.getByText(SECOND_PROMPT)).toBeInTheDocument();
    expect(screen.queryByText(IDLE_ROW_TEXT)).toBeNull();
  });

  /*
   * The threshold is the producer's decision, not the row's. A sub-threshold
   * pause must reach the open gate and still render nothing — which is what
   * keeps the first spec from passing on "any gap at all".
   */
  it("renders no idle row when the real gap is under the threshold, flag on", () => {
    expect(SUB_THRESHOLD_GAP_MS).toBeLessThan(MERGED_TRACE_IDLE_THRESHOLD_MS);

    render(
      withProviders(
        <SessionTrace items={realTraceItems(SUB_THRESHOLD_GAP_MS)} />,
        [SESSION_TRACE_IDLE_ROWS_FLAG_KEY]
      )
    );

    expect(screen.getByText(FIRST_PROMPT)).toBeInTheDocument();
    expect(screen.getByText(SECOND_PROMPT)).toBeInTheDocument();
    expect(screen.queryByText(ANY_IDLE_ROW)).toBeNull();
  });

  /*
   * The unit the adapter carries. `TurnItem`'s `idle` arm names its field `gap`
   * with no unit in the name, and the row formats it as milliseconds; a producer
   * that fed seconds would print a 5-minute pause as sub-second. Asserted on the
   * ADAPTER's output rather than the DOM so the claim is about the contract
   * between the two halves, not about the label.
   */
  it("carries the producer's gap to the turn item in milliseconds", () => {
    const idle = realTraceItems(IDLE_GAP_MS).filter(
      (item) => item.type === "idle"
    );

    expect(idle).toHaveLength(1);
    expect(idle[0]).toEqual({ type: "idle", gap: IDLE_GAP_MS });
  });

  /*
   * ISS-8720. Every case above pairs two prompts, and a prompt is an instant —
   * so start-to-start and end-to-start are the same number there and each one
   * renders "5m" whichever the producer computes. This is the case that can
   * tell them apart: a tool run occupies ten of the sixteen minutes separating
   * the two turn starts, so the pause the reader waited is six.
   */
  it("renders the pause after a tool run, not the span the run occupied", () => {
    render(
      withProviders(<SessionTrace items={toolRunTraceItems()} />, [
        SESSION_TRACE_IDLE_ROWS_FLAG_KEY,
      ])
    );

    expect(screen.getByText(FIRST_PROMPT)).toBeInTheDocument();
    expect(screen.getByText(TOOL_RUN_SUMMARY)).toBeInTheDocument();
    expect(screen.getByText(SECOND_PROMPT)).toBeInTheDocument();
    expect(screen.getByText(TOOL_RUN_IDLE_ROW_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(TOOL_RUN_UNCORRECTED_ROW_TEXT)).toBeNull();
  });
});

/**
 * A prompt, a ten-minute tool run, and a reply six minutes after the run ended
 * — through the same production merge and adapter, with no idle item named.
 */
function toolRunTraceItems() {
  const toolStartMs = SESSION_START_MS + 1000;
  const toolEndMs = toolStartMs + TOOL_RUN_MS;
  const sessions: MergedTraceSessionInput[] = [
    {
      sessionId: "session-a",
      startedAt: new Date(SESSION_START_MS).toISOString(),
      actorName: "Claude",
      harness: "claude-code",
      turnItems: [
        promptTurn(SESSION_START_MS, FIRST_PROMPT),
        toolsTurn(toolStartMs, toolEndMs),
        promptTurn(toolEndMs + TOOL_RUN_PAUSE_MS, SECOND_PROMPT),
      ],
    },
  ];
  return mergedTraceToSessionTraceItems(buildMergedTrace(sessions));
}

function toolsTurn(atMs: number, endMs: number): TurnItem {
  return {
    type: "tools",
    _row: 1,
    t: new Date(atMs).toISOString(),
    tMs: atMs,
    endMs,
    cum: 0,
    actor: promptActor(),
    summary: TOOL_RUN_SUMMARY,
    items: [{ label: "bash", detail: "pnpm migrate", err: false }],
    hasFail: false,
    failN: 0,
    cats: { bash: 1 },
  };
}

function promptActor() {
  return {
    name: "Operator",
    sessionId: "session-a",
    human: "Operator",
    color: "",
    harness: "claude-code",
  };
}

/**
 * Two prompts `gapMs` apart, run through the production merge and the
 * production branch adapter. Nothing here names an `idle` item; whether one
 * exists downstream is `buildMergedTrace`'s decision to make.
 */
function realTraceItems(gapMs: number) {
  const sessions: MergedTraceSessionInput[] = [
    {
      sessionId: "session-a",
      startedAt: new Date(SESSION_START_MS).toISOString(),
      actorName: "Claude",
      harness: "claude-code",
      turnItems: [
        promptTurn(SESSION_START_MS + 1000, FIRST_PROMPT),
        promptTurn(SESSION_START_MS + 1000 + gapMs, SECOND_PROMPT),
      ],
    },
  ];
  return mergedTraceToSessionTraceItems(buildMergedTrace(sessions));
}

function promptTurn(atMs: number, text: string): TurnItem {
  return {
    type: "prompt",
    _row: 0,
    t: new Date(atMs).toISOString(),
    tMs: atMs,
    cum: 0,
    actor: promptActor(),
    text,
  };
}
