// ISS-5841: activity phases now ship behind a flag, default off. This case
// covers a phases surface, so it opts the flag ON rather than asserting a
// region the product deliberately hides.

import { DECLARED_EVIDENCE_LAYER } from "@repo/api/src/activity-evidence-layers";
import type { SyncedActivitySegmentRow } from "@repo/api/src/types/agent-session";
import { SESSION_TIMELINE_AXIS_SPAN_PREFIX } from "@repo/app/agents/lib/session-duration";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import {
  createAgentSessionDetailFixture,
  createTurnItemsSpanning,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { withProviders } from "./agent-session-detail-view.test-helpers";

// ISS-4791. The regression boundary is the COMPOSED detail view, because the
// defect only exists when the two strips are seen together: the "Session
// Timeline" axis total and the "Activity phases" span caption sit vertically
// adjacent, and each used to format the SAME elapsed span its own way — a bare
// rounded-up minute count ("728m") directly above an hours/minutes caption
// ("phases span 12h 8m"). Same duration, two unit systems, one screen, which
// invites a reader to conclude the strips are on different scales.
//
// ISS-4684 converged the axis onto the shared `formatDuration` helper the
// caption already used; that change was covered only by a per-widget label
// assertion plus a helper-level minute-equality check that explicitly did NOT
// render the view or the phases projection. This suite closes that deferred
// gap: it mounts the parent view with a real tiling so BOTH captions are read
// off one render and compared against each other, which is the only place the
// inconsistency was ever visible.
//
// Shared verbatim by web and desktop through `@repo/app`, so pinning the
// composed view pins both surfaces.

const AXIS_LABEL_SELECTOR = ".sd3-act-span";
const PHASES_SCALE_SELECTOR = ".sd3-segs-scale";
const PHASES_SPAN_PREFIX = "phases span ";
/** A bare whole-minute total ("728m") — the pre-ISS-4791 axis form. */
const BARE_MINUTES_RE = /^\d+m$/;

/**
 * A 12h 8m window — the ISS-4791 capture's own span. Deliberately over an hour:
 * that is the magnitude where a minute count and an hours/minutes label diverge
 * into two readings of the same number ("728m" vs "12h 8m").
 */
const LONG_STARTED_AT = "2026-06-10T00:00:00.000Z";
const LONG_ENDED_AT = "2026-06-10T12:08:00.000Z";

/** A sub-hour window, where both captions stay minutes-led. */
const SHORT_STARTED_AT = "2026-06-10T00:00:00.000Z";
const SHORT_ENDED_AT = "2026-06-10T00:45:30.000Z";

function createTilingOver(
  startedAt: string,
  endedAt: string
): SyncedActivitySegmentRow[] {
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(endedAt);
  const midMs = startMs + Math.floor((endMs - startMs) / 2);
  // Two contiguous NON-idle phases covering exactly the session window, so the
  // strip's own min/max span equals the axis span and the two captions are
  // describing the same elapsed time. Non-idle also keeps the disclosure open
  // by default (a mostly-idle strip folds), so the caption is rendered.
  return [
    {
      phase: "implement",
      startMs,
      endMs: midMs,
      confidence: 0.9,
      evidenceLayers: [DECLARED_EVIDENCE_LAYER],
      version: 1,
    },
    {
      phase: "review",
      startMs: midMs,
      endMs,
      confidence: 0.7,
      evidenceLayers: ["structural"],
      version: 1,
    },
  ];
}

function renderDetailOver(startedAt: string, endedAt: string) {
  const endDate = new Date(endedAt);
  const session = createAgentSessionDetailFixture({
    startedAt: new Date(startedAt),
    lastActivityAt: endDate,
    endedAt: endDate,
    updatedAt: endDate,
    activitySegmentRows: createTilingOver(startedAt, endedAt),
    // The axis spans the union of everything plotted — the tiling above AND the
    // transcript rows — so the transcript is re-timed onto the same window the
    // tiling covers. Left at the fixture default it would be a second, unrelated
    // window bolted onto the first, and the axis would honestly report the union
    // of the two while this suite's whole subject is the axis and the phases
    // caption measuring ONE span.
    turnItems: createTurnItemsSpanning(startedAt, endedAt),
  });
  const { container } = render(
    withProviders(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session}
      />,
      [SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY]
    )
  );
  return container;
}

/**
 * The trimmed text of a required caption. Throws (rather than asserting) when
 * the node is absent so a missing strip fails loudly as a setup error and the
 * assertions all stay in the test bodies.
 */
function requireCaptionText(container: HTMLElement, selector: string): string {
  const node = container.querySelector<HTMLElement>(selector);
  if (!node) {
    throw new Error(
      `Expected the rendered session detail to contain "${selector}"`
    );
  }
  return (node.textContent ?? "").trim();
}

/**
 * ISS-4675: the axis total is now QUALIFIER-FIRST (`calendar span 12h 8m`), the
 * same `<what> span <duration>` shape as the phases caption below it. Strip the
 * qualifier through the SSOT constant so this suite keeps comparing the two
 * DURATIONS (its actual subject) rather than the two captions verbatim.
 */
function requireAxisDuration(container: HTMLElement): string {
  const caption = requireCaptionText(container, AXIS_LABEL_SELECTOR);
  const prefix = `${SESSION_TIMELINE_AXIS_SPAN_PREFIX} `;
  if (!caption.startsWith(prefix)) {
    throw new Error(
      `Expected the axis total to be qualified with "${SESSION_TIMELINE_AXIS_SPAN_PREFIX}", got "${caption}"`
    );
  }
  return caption.slice(prefix.length);
}

describe("ISS-4791: adjacent session-detail time captions share one duration format", () => {
  it("renders the Session Timeline axis and the Activity phases span in the same unit system over a multi-hour session", () => {
    const container = renderDetailOver(LONG_STARTED_AT, LONG_ENDED_AT);

    const axisDuration = requireAxisDuration(container);
    const phasesCaption = requireCaptionText(container, PHASES_SCALE_SELECTOR);
    expect(phasesCaption.startsWith(PHASES_SPAN_PREFIX)).toBe(true);
    const phasesDuration = phasesCaption.slice(PHASES_SPAN_PREFIX.length);

    // Both strips cover the same window here, so agreeing on the FORMAT means
    // agreeing on the exact string. Before ISS-4684/ISS-4791 this read
    // "728m" vs "12h 8m" and failed.
    expect(axisDuration).toBe("12h 8m");
    expect(phasesDuration).toBe("12h 8m");
    expect(axisDuration).toBe(phasesDuration);
    // ...and specifically not the bare rounded-up minute total the axis used to
    // print, which is the form that made one span read as two scales.
    expect(axisDuration).not.toMatch(BARE_MINUTES_RE);
    expect(axisDuration).not.toContain("728");
  });

  it("keeps the two captions in one unit system on a sub-hour session too", () => {
    const container = renderDetailOver(SHORT_STARTED_AT, SHORT_ENDED_AT);

    const axisDuration = requireAxisDuration(container);
    const phasesCaption = requireCaptionText(container, PHASES_SCALE_SELECTOR);
    expect(phasesCaption.startsWith(PHASES_SPAN_PREFIX)).toBe(true);
    const phasesDuration = phasesCaption.slice(PHASES_SPAN_PREFIX.length);

    // Under an hour the shared helper is minutes-led on both strips; the point
    // is still that neither caption invents its own unit system.
    expect(axisDuration).toBe("45m 30s");
    expect(axisDuration).toBe(phasesDuration);
  });
});
