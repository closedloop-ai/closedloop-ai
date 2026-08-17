// ISS-5841: activity phases now ship behind a flag, default off. These cases
// exist to cover the phases surfaces, so they opt the flag ON rather than
// asserting a region the product deliberately hides.

import type {
  SyncedActivitySegmentRow,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import {
  SESSION_TIMELINE_AXIS_SPAN_PREFIX,
  SESSION_TIMELINE_AXIS_SPAN_TITLE,
} from "@repo/app/agents/lib/session-duration";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";

/**
 * ISS-5137: the Session Timeline axis states the span the strip beneath it
 * measures — including a trailing IDLE segment.
 *
 * THE DISCRIMINATOR. Every existing axis suite uses a session whose `endedAt`
 * and whose last phase segment resolve to the same instant, so both derivations
 * agree and neither can catch the other being wrong. That is why this ambiguity
 * survived: `e2e/session-detail.spec.ts` DID assert the rendered span, but its
 * fixture only made the two disagree by accident (a two-minute idle tail), and
 * with the flag racing to resolve in the containerized run it failed
 * intermittently — "expected calendar span 20m 0s, received 18m 0s" — which
 * reads as a flake rather than as the contract break it is.
 *
 * The session below makes them disagree ON PURPOSE and by a readable margin:
 *
 *   12:00  startedAt, first plotted row, tiling begins
 *   12:15  implement ends
 *   12:18  validate ends — the LAST ATTRIBUTED WORK
 *   12:20  idle ends, tiling ends, `endedAt`
 *
 * `endedAt` (20m) and the last non-idle segment (18m) are two different, both
 * defensible instants. The axis has to pick one, and it must pick the one the
 * "phases span …" caption directly beneath it prints — otherwise the screen
 * shows `calendar span 18m 0s` stacked on `phases span 20m 0s` and asks the
 * reader to decide which of its own two numbers to believe. It also has to be
 * the larger one on its own terms: the label's words are "calendar span", and
 * idle minutes are calendar minutes, so dropping them under-reports how long the
 * session actually ran.
 *
 * ISS-5366 retired the `session-timeline-axis-reconciliation` gate to its
 * enabled state, so there is ONE derivation left — the plotted-activity window —
 * and these assertions run unconditionally against it. The load-bearing one is
 * the last: the axis total must EQUAL the "phases span" caption directly beneath
 * it, read from that caption rather than restated as a literal, so an axis that
 * stops reconciling fails here.
 */

const STARTED_AT = "2026-06-10T12:00:00.000Z";
const IMPLEMENT_END_AT = "2026-06-10T12:15:00.000Z";
/** The last ATTRIBUTED work — the instant the pre-fix axis wrongly ended at. */
const VALIDATE_END_AT = "2026-06-10T12:18:00.000Z";
/** The tiling's end and the session's end — the instant the axis must state. */
const SESSION_END_AT = "2026-06-10T12:20:00.000Z";

/** The whole calendar window, 12:00 → 12:20, as `formatDuration` prints it. */
const FULL_SPAN = "20m 0s";
/** What the axis printed while trailing idle was excluded. The bug. */
const NON_IDLE_SPAN = "18m 0s";

const ACTOR = {
  color: "var(--primary)",
  harness: "codex",
  human: null,
  name: "gpt-5.5",
  sessionId: "session-iss-5137",
};

function promptRow(row: number, at: string): TurnItem {
  return {
    _row: row,
    actor: ACTOR,
    cum: 0,
    t: at,
    tMs: Date.parse(at),
    text: `turn ${row}`,
    type: "prompt",
  };
}

function segmentRow(
  phase: string,
  startAt: string,
  endAt: string,
  confidence: number,
  evidenceLayers: string[]
): SyncedActivitySegmentRow {
  return {
    confidence,
    endMs: Date.parse(endAt),
    evidenceLayers,
    phase,
    startMs: Date.parse(startAt),
    version: 1,
  } as SyncedActivitySegmentRow;
}

/**
 * A contiguous tiling covering the session window EXACTLY, closed by an idle
 * tail — the shape the desktop classifier emits for a session that stopped
 * working before it stopped.
 *
 * 90% non-idle on purpose: `activity-segments-projection.ts` folds a
 * majority-idle strip closed by default, and a folded strip renders no
 * `.sd3-segs-scale`, which would make the caption comparison vacuous rather
 * than red.
 */
const PHASE_TILING: SyncedActivitySegmentRow[] = [
  segmentRow("implement", STARTED_AT, IMPLEMENT_END_AT, 0.82, ["declared"]),
  segmentRow("validate", IMPLEMENT_END_AT, VALIDATE_END_AT, 0.61, [
    "structural",
  ]),
  segmentRow("idle", VALIDATE_END_AT, SESSION_END_AT, 1, []),
];

const idleTailSession = createAgentSessionDetailFixture({
  activityBuckets: [],
  activitySegmentRows: PHASE_TILING,
  endedAt: new Date(SESSION_END_AT),
  // Absent on purpose, so the assertion is about the IDLE TAIL rather than about
  // which lifecycle field wins the right edge.
  lastActivityAt: undefined,
  markers: [],
  span: null,
  startedAt: new Date(STARTED_AT),
  turnItems: [
    promptRow(0, STARTED_AT),
    promptRow(1, IMPLEMENT_END_AT),
    promptRow(2, VALIDATE_END_AT),
  ],
  updatedAt: new Date(VALIDATE_END_AT),
});

function renderDetail(): void {
  render(
    <AppCoreStoryProviders
      enabledFlags={[SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY]}
    >
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={idleTailSession}
      />
    </AppCoreStoryProviders>
  );
}

function readAxisTotalLabel(): string | null {
  return (
    document.querySelector(`[title="${SESSION_TIMELINE_AXIS_SPAN_TITLE}"]`)
      ?.textContent ?? null
  );
}

function readPhasesSpanCaption(): string | null {
  return document.querySelector(".sd3-segs-scale")?.textContent ?? null;
}

function axisTotal(value: string): string {
  return `${SESSION_TIMELINE_AXIS_SPAN_PREFIX} ${value}`;
}

describe("Session Timeline axis over a trailing idle segment (ISS-5137)", () => {
  it("states the whole calendar span, trailing idle included", () => {
    renderDetail();

    expect(screen.getByText("Session Timeline")).toBeInTheDocument();
    // The bug: the plotted-activity window excluded IDLE segments, so it ended
    // at the last attributed work (12:18) and the axis under-reported a session
    // that ran until 12:20.
    expect(readAxisTotalLabel()).toBe(axisTotal(FULL_SPAN));
    expect(readAxisTotalLabel()).not.toBe(axisTotal(NON_IDLE_SPAN));
  });

  it("reconciles: the axis total equals the phases-span caption beneath it", () => {
    renderDetail();

    // Read from the caption rather than restated as a literal: the contract is
    // that the two adjacent captions state ONE number, so the comparison has to
    // be against the other caption, not against a copy of it.
    const caption = readPhasesSpanCaption() ?? "";
    expect(caption).toBe(`phases span ${FULL_SPAN}`);
    expect(readAxisTotalLabel()).toBe(
      axisTotal(caption.replace("phases span ", ""))
    );
  });
});
