import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { SUBSCRIPTION_BILLING_MODES } from "@repo/api/src/types/billing-mode";
import { SessionEvidenceCoverage } from "@repo/api/src/types/session-evidence-coverage-constants";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY } from "@repo/api/src/types/session-timeline-coverage-disclosure-flag";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import {
  joinPropertySentences,
  metricProvenanceNote,
  resolveMetricProvenanceNote,
  SessionProvenanceMetric,
} from "../session-metric-provenance";
import { SessionPropertiesPanel } from "../session-properties-panel";

/**
 * ISS-7427 acceptance criterion 4 — "Independently sourced values remain visible
 * only with honest source/freshness labeling."
 *
 * The reported screen showed $5,994.85, 8.99B tokens and 770h 55m beside
 * "Transcript not archived". The audit (#5584) established those three are
 * metadata-lane values the archive never fed, so the defect is that nothing said
 * so — the count got its label in #5686 and the timeline strip its extent in
 * #5793, and these three rows were what remained.
 *
 * WHAT THESE SPECS ARE BUILT TO CATCH, because it is the cheap wrong fix: a
 * provenance label that exists only as an `sr-only` node while the visible
 * surface still says nothing. `toBeVisible` passes on a clipped `sr-only`
 * element, so every disclosure spec below asserts something ONLY the rendered
 * surface emits — the value becoming a real `<button>` tooltip trigger, and the
 * tooltip's own text — and separately pins that the visible figure did NOT
 * change. `visibleValue` strips `sr-only` before reading, so it cannot be
 * satisfied by the accessible tail.
 */

const PROPERTIES_TOGGLE_RE = /Properties/;
/** The claim every note MUST make: where this number was read from. */
const SOURCE_CLAIM_RE = /not the transcript/;
/** A running session has no end; no note may claim one. See the Duration note. */
const CLAIMS_AN_END_RE = /\bend\b/i;
/** The claim #5793's review proved false, which no note may make again. */
const NONEXISTENCE_CLAIM_RE = /no (archived )?transcript exists/i;
const ABSENCE_WORDING_RE = /unavailable|never archived|does not exist/i;
const DOLLAR_RE = /\$/;
const DIGIT_RE = /\d/;
const COST_LABEL = "Cost";
const TOKENS_LABEL = "Tokens";
const DURATION_LABEL = "Duration";
const ALL_LABELS = [COST_LABEL, TOKENS_LABEL, DURATION_LABEL];
/** A REAL subscription mode from the canonical set — "subscription" is not one. */
const A_SUBSCRIPTION_MODE = [...SUBSCRIPTION_BILLING_MODES][0];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ISS-7427 AC4 the fold decides which sessions may carry a note", () => {
  it("labels each of the three metrics when the main archive is terminally absent", () => {
    for (const metric of Object.values(SessionProvenanceMetric)) {
      expect(noteFor({ metric })).not.toBeNull();
    }
  });

  /*
   * The three notes name three DIFFERENT sources, and that is the disclosure.
   * Cost and Tokens read the usage rollup; Duration reads two timestamps on the
   * session record and touches usage at no point. A single shared string would
   * have to be vague enough to be true of all three, which is how a provenance
   * label stops being checkable.
   */
  it("gives each metric its own sentence rather than one shared hedge", () => {
    const notes = Object.values(SessionProvenanceMetric).map((metric) =>
      noteFor({ metric })
    );
    expect(new Set(notes).size).toBe(notes.length);
  });

  /*
   * The trap #5793 hit twice, pinned here so it cannot be reintroduced.
   * `metadataOnly` describes the CLOUD main archive. Such a session can still
   * own readable subagent archives (one of the four signals that PRODUCE the
   * state) and, on desktop, an on-disk transcript the panel paints in full. A
   * sentence claiming no transcript EXISTS is therefore false on reachable
   * shapes of the very state that gates it; a sentence about where this number
   * came from is true on every surface.
   */
  it("claims only where the number came from, never that no transcript exists", () => {
    for (const metric of Object.values(SessionProvenanceMetric)) {
      const note = noteFor({ metric }) ?? "";
      expect(note).toMatch(SOURCE_CLAIM_RE);
      expect(note).not.toMatch(NONEXISTENCE_CLAIM_RE);
      expect(note).not.toMatch(ABSENCE_WORDING_RE);
    }
  });

  // The closed-by-default half of ISS-4779. Its positive sibling is the first
  // spec above: without one of the two, "never discloses at all" satisfies this.
  it("says nothing while the gate is closed", () => {
    for (const metric of Object.values(SessionProvenanceMetric)) {
      expect(noteFor({ disclosureEnabled: false, metric })).toBeNull();
    }
  });

  /*
   * The distinction the ticket is about, in fold form. A readable archive means
   * a reader who wants to reconcile these numbers against it can, so a standing
   * note on every healthy session would be noise — and `pending` would be a
   * false claim about a future the archive may still fill.
   */
  it.each([
    SessionEvidenceCoverage.MainReadable,
    SessionEvidenceCoverage.Pending,
    SessionEvidenceCoverage.NoEvidence,
    SessionEvidenceCoverage.NotApplicable,
  ])("says nothing on %s", (evidenceCoverage) => {
    for (const metric of Object.values(SessionProvenanceMetric)) {
      expect(noteFor({ evidenceCoverage, metric })).toBeNull();
    }
  });

  /*
   * A version-skewed `apps/api` and the desktop-local projection both omit the
   * field. Absent must mean "this server does not classify", never "the archive
   * is readable" and never "assume the worst" — the wire contract on
   * `AgentSessionDetail.evidenceCoverage`.
   */
  // Calls the fold directly rather than through `noteFor`: a destructuring
  // default in the helper would swallow the `undefined` this spec is entirely
  // about and pass by testing `metadataOnly` a second time.
  it("says nothing when the server does not classify at all", () => {
    for (const metric of Object.values(SessionProvenanceMetric)) {
      expect(
        resolveMetricProvenanceNote({
          disclosureEnabled: true,
          evidenceCoverage: undefined,
          metric,
          valueIsSourceBacked: true,
        })
      ).toBeNull();
    }
  });

  /*
   * A row showing its em-dash has no figure for a provenance sentence to be
   * about, and already carries its own reason. Appending "counted from synced
   * usage totals" to "Token counts were not recorded" would describe a number
   * the row has just said it does not have.
   */
  it("says nothing about a value the row is not rendering", () => {
    for (const metric of Object.values(SessionProvenanceMetric)) {
      expect(noteFor({ metric, valueIsSourceBacked: false })).toBeNull();
    }
  });

  it("returns a lone sentence verbatim so an unchanged row stays byte-identical", () => {
    expect(joinPropertySentences("Only this one")).toBe("Only this one");
    expect(joinPropertySentences(null, undefined)).toBeUndefined();
    expect(joinPropertySentences("First", "Second")).toBe("First. Second");
  });
});

describe("ISS-7427 AC4 the panel discloses on the rendered surface", () => {
  /*
   * THE load-bearing spec. It asserts the three things a screen-reader-only
   * label cannot satisfy: the value is a real focusable control, focusing it
   * reveals the sentence as visible tooltip copy, and the figure itself is
   * untouched.
   */
  it.each([
    [COST_LABEL, SessionProvenanceMetric.Cost],
    [TOKENS_LABEL, SessionProvenanceMetric.Tokens],
    [DURATION_LABEL, SessionProvenanceMetric.Duration],
  ] as const)(
    "shows the %s row ITS OWN source sentence, not merely a source sentence",
    async (label, metric) => {
      await renderPanel({ flagOn: true, metadataOnly: true });

      const trigger = within(rowFor(label)).getByRole("button");
      trigger.focus();

      const tooltip = await screen.findByRole("tooltip");
      // The row's OWN note, never the substring all three share. Under the
      // shared matcher, swapping any two `SessionProvenanceMetric` arguments at
      // the three production call sites left all 26 specs green — so a Duration
      // captioned "priced from synced usage" would have shipped.
      expect(tooltip).toHaveTextContent(metricProvenanceNote(metric));
    }
  );

  /*
   * The other half of that assertion, and the reason the one above is not
   * enough on its own: disclosing must not rewrite the number. A fix that
   * appended the sentence to the value would satisfy a naive "the row mentions
   * the transcript" spec while making the figure unreadable.
   */
  it("leaves the visible figures exactly as they render today", async () => {
    await renderPanel({ flagOn: false, metadataOnly: true });
    const undisclosed = ALL_LABELS.map(visibleValue);

    cleanupAndRerender();
    await renderPanel({ flagOn: true, metadataOnly: true });

    expect(ALL_LABELS.map(visibleValue)).toEqual(undisclosed);
    // Not a vacuous comparison of two empty strings.
    expect(visibleValue(COST_LABEL)).toMatch(DOLLAR_RE);
    expect(visibleValue(TOKENS_LABEL)).toMatch(DIGIT_RE);
  });

  /*
   * VISUAL-QA REGRESSION. `PropertyValueBody` resolves `explanation` ahead of
   * the truncating value, and the Tokens row's four-part value is clipped
   * essentially always (measured ~437px of text in a 272px track). Before the
   * fix, turning this gate on replaced the tooltip that revealed the full
   * figure, so a sighted reader lost the cache-write number and it survived in
   * the accessible name alone. The tooltip must now LEAD with the value.
   *
   * jsdom reports zero widths, so clipping is forced rather than measured; the
   * assertion is on the composition the clipped branch produces.
   *
   * Read off the RENDERED content element, not `role="tooltip"`. ISS-7737 (which
   * landed on main while this branch was open) put an `aria-label` on
   * `TooltipContent` so the announced description is the sentence ALONE — the
   * value is already in the trigger's own accessible name, and repeating it made
   * a screen reader read the whole token quadruple twice. Radix renders that
   * announced string in a `VisuallyHidden` CHILD carrying `role="tooltip"`, so
   * `findByRole("tooltip")` now resolves to the a11y node rather than the body.
   * The claim here is about what the EYE gets, which is the parent's text; the
   * announced-description contract is asserted by its own sibling spec.
   */
  it("leads a clipped value's tooltip with the value, then its sentence", async () => {
    forceClipping();
    await renderPanel({ flagOn: true, metadataOnly: true });

    const trigger = within(rowFor(TOKENS_LABEL)).getByRole("button");
    trigger.focus();
    // Awaited through the a11y node so the open-tooltip wait is unchanged, then
    // widened to the content element that actually paints.
    const announced = await screen.findByRole("tooltip");
    const tooltip = announced.closest('[data-slot="tooltip-content"]');
    expect(tooltip).not.toBeNull();
    const text = tooltip?.textContent ?? "";

    expect(text).toContain("cache write");
    expect(text).toContain(
      metricProvenanceNote(SessionProvenanceMetric.Tokens)
    );
    expect(text.indexOf("cache write")).toBeLessThan(
      text.indexOf(metricProvenanceNote(SessionProvenanceMetric.Tokens))
    );
  });

  /*
   * ONE statement per row in the accessibility tree. `ExplainedPropertyValue`
   * composes the accessible name from the visible word plus a single `sr-only`
   * tail (WCAG 2.5.3), and a second node would read the fact twice to assistive
   * tech while a sighted reader saw it once.
   */
  it.each(ALL_LABELS)(
    "states the reason exactly once for %s",
    async (label) => {
      await renderPanel({ flagOn: true, metadataOnly: true });

      expect(rowFor(label).querySelectorAll(".sr-only")).toHaveLength(1);
    }
  );

  /*
   * The closed-by-default gate, asserted on the rendered surface rather than on
   * the fold: with the flag off these rows must be the plain, non-focusable
   * values they are today. `getByRole("button")` above and `queryByRole` here
   * are the same locator in opposite states, so neither can pass alone.
   */
  it.each(ALL_LABELS)(
    "leaves the %s value a plain value while the gate is closed",
    async (label) => {
      await renderPanel({ flagOn: false, metadataOnly: true });

      expect(within(rowFor(label)).queryByRole("button")).toBeNull();
    }
  );

  /*
   * A healthy session is untouched — the point of gating on `metadataOnly`. If
   * this ever fails, the disclosure has become a standing caption on every
   * session, which is the "changes every healthy session's a11y shape" outcome
   * this design exists to avoid.
   */
  it.each(ALL_LABELS)(
    "leaves %s alone when the main transcript is readable",
    async (label) => {
      await renderPanel({ flagOn: true, metadataOnly: false });

      expect(within(rowFor(label)).queryByRole("button")).toBeNull();
    }
  );

  /*
   * ONE rendered screen, three rows compared to EACH OTHER rather than each to a
   * constant. The divergence that matters is one row disclosing while its
   * neighbours stay silent — a reader would take that as a claim about THAT
   * number specifically. Checking each row against its own expected string
   * independently would keep passing through exactly that split.
   */
  it("discloses on all three rows or none, never a subset", async () => {
    await renderPanel({ flagOn: true, metadataOnly: true });
    const disclosed = ALL_LABELS.filter(
      (label) => within(rowFor(label)).queryByRole("button") !== null
    );

    expect(disclosed).toEqual(ALL_LABELS);
  });

  /*
   * THE DEFECT REVIEW CAUGHT. A running session's Duration is measured
   * `startedAt -> now`, so it has NO recorded end, and `metadataOnly` never
   * consults lifecycle while a `too_large` skip can fire mid-run. The first
   * draft said "recorded start and end" and was therefore false on a live
   * session whose number is visibly ticking under a Status of "Active".
   *
   * Asserts the figure still renders, so a fix that suppressed the Duration
   * instead of correcting the sentence cannot pass this.
   */
  it("never claims an end on a running session, whose Duration has none", async () => {
    await renderPanel({
      flagOn: true,
      metadataOnly: true,
      session: {
        status: SESSION_STATUS.ACTIVE,
        endedAt: null,
        lastActivityAt: new Date(),
      },
    });

    expect(visibleValue(DURATION_LABEL)).not.toBe("—");
    const trigger = within(rowFor(DURATION_LABEL)).getByRole("button");
    trigger.focus();
    const tooltip = await screen.findByRole("tooltip");

    expect(tooltip).toHaveTextContent(SOURCE_CLAIM_RE);
    expect(tooltip.textContent ?? "").not.toMatch(CLAIMS_AN_END_RE);
  });

  /*
   * The second defect review caught: a provenance sentence on a FABRICATED ZERO.
   * With the independent ISS-5637 honesty flag OFF, a zero-usage session still
   * paints "0 in | 0 out | ..." — and the server says in as many words that it
   * cannot tell that lane apart from one that measured a true zero. Attaching a
   * source there asserts a measurement nobody made.
   */
  it("adds no source sentence to an all-zero token rollup", async () => {
    await renderPanel({
      flagOn: true,
      metadataOnly: true,
      session: { tokensIn: 0, tokensOut: 0, cache: 0, cacheWrite: 0 },
    });

    expect(within(rowFor(TOKENS_LABEL)).queryByRole("button")).toBeNull();
  });

  /*
   * The same shape on Cost, and it needs no flag combination at all: a
   * subscription session that took a turn but consumed no tokens renders
   * `$0.00` through `isCostFigureRendered`, so the paint verdict alone would
   * have captioned a zero "priced from synced usage".
   */
  it("adds no source sentence to a subscription $0.00 with no usage", async () => {
    await renderPanel({
      flagOn: true,
      metadataOnly: true,
      session: {
        billingMode: A_SUBSCRIPTION_MODE,
        estimatedCost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        turns: 1,
      },
    });

    // SELF-GUARDING. An earlier draft passed `billingMode: "subscription"`,
    // which is NOT one of the real modes, so the row fell through to
    // `NoTokenUsage` and rendered the em-dash — the spec then passed for the
    // dash's reason rather than the zero's, and stayed green when the usage
    // predicate was deleted. Pinning the figure keeps it about the $0.00 path.
    expect(visibleValue(COST_LABEL)).toBe("$0.00");
    expect(within(rowFor(COST_LABEL)).queryByRole("button")).toBeNull();
  });

  /*
   * The Cost row's gate is the SAME predicate that decides whether a figure
   * renders at all, so a dashed Cost keeps its dash and gains no sentence. A
   * zero-usage session is the reachable shape: `deriveCostAvailability` returns
   * `NoUsage` and the row prints the shared em-dash.
   */
  it("adds no source sentence to a Cost that renders no figure", async () => {
    await renderPanel({
      flagOn: true,
      metadataOnly: true,
      session: {
        estimatedCost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolUseCount: 0,
        turns: 0,
      },
    });

    expect(visibleValue(COST_LABEL)).toBe("—");
    expect(within(rowFor(COST_LABEL)).queryByRole("button")).toBeNull();
  });
});

/**
 * jsdom gives every element `scrollWidth === clientWidth === 0`, so nothing is
 * ever "clipped" and the truncation branch is unreachable by default. Force it
 * for the one spec that is about that branch, rather than asserting the
 * composition through a code path production never takes.
 */
function forceClipping() {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
}

function noteFor({
  disclosureEnabled = true,
  evidenceCoverage = SessionEvidenceCoverage.MetadataOnly,
  metric,
  valueIsSourceBacked = true,
}: {
  disclosureEnabled?: boolean;
  evidenceCoverage?: AgentSessionDetail["evidenceCoverage"];
  metric: SessionProvenanceMetric;
  valueIsSourceBacked?: boolean;
}): string | null {
  return resolveMetricProvenanceNote({
    disclosureEnabled,
    evidenceCoverage,
    metric,
    valueIsSourceBacked,
  });
}

async function renderPanel({
  flagOn,
  metadataOnly,
  session,
}: {
  flagOn: boolean;
  metadataOnly: boolean;
  session?: Partial<AgentSessionDetail>;
}) {
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: flagOn
          ? [SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY]
          : [],
      })}
    >
      <SessionPropertiesPanel
        session={createAgentSessionDetailFixture({
          evidenceCoverage: metadataOnly
            ? SessionEvidenceCoverage.MetadataOnly
            : SessionEvidenceCoverage.MainReadable,
          ...session,
        })}
      />
    </FeatureFlagAdapterProvider>
  );
  // The rows under test live in the expanded panel; it starts collapsed.
  await userEvent.click(
    screen.getByRole("button", { name: PROPERTIES_TOGGLE_RE })
  );
}

/** The `.prd-prop` row whose label cell is exactly `label`. */
function rowFor(label: string): HTMLElement {
  const row = screen
    .getAllByText(label, { selector: ".prd-prop-label" })
    .at(0)?.parentElement;
  if (!row) {
    throw new Error(`No Properties row labelled "${label}"`);
  }
  return row;
}

/**
 * The row's value as a SIGHTED reader sees it: `sr-only` nodes and the label
 * removed. Stripping `sr-only` first is what stops an accessible-only label from
 * satisfying a spec about the visible surface.
 */
function visibleValue(label: string): string {
  const clone = rowFor(label).cloneNode(true) as HTMLElement;
  for (const srOnly of clone.querySelectorAll(".sr-only")) {
    srOnly.remove();
  }
  clone.querySelector(".prd-prop-label")?.remove();
  return (clone.textContent ?? "").trim();
}

/**
 * Testing Library auto-cleans between tests but not between two renders inside
 * ONE test, and the byte-identity spec needs both states in a single body to
 * compare them to each other rather than to a recorded constant.
 */
function cleanupAndRerender() {
  for (const node of document.querySelectorAll("body > div")) {
    node.remove();
  }
}
