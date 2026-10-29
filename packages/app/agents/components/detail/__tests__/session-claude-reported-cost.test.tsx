import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionPropertiesPanel } from "../session-properties-panel";

/**
 * ISS-7229 — Claude's reported cost on session detail. Claude's figure and our
 * estimate are different numbers that disagree, and Claude's is absent on most
 * sessions — which is what makes an `?? estimatedCost` fallback tempting and
 * wrong.
 *
 * The two figures share the ONE "Cost" row since ISS-7229's display revision.
 * They were sibling rows until then, and `.prd-props` is a multi-column
 * `auto-fit` grid, so at two columns the caption landed in a different column
 * from the figure it named. The assertions below moved with that change: they
 * read the whole Cost row rather than a row of Claude's own.
 */

const CLAUDE_REPORTED_LABEL = "Claude reported";
const ESTIMATE_USD = 1438.84;
const REPORTED_USD = 1502.1;
const ESTIMATE_TEXT = "$1,438.84";
const REPORTED_TEXT = "$1,502.10";
const PROPERTIES_TOGGLE_RE = /Properties/;

/**
 * What the Cost row reads when Claude reported a figure.
 *
 * Each figure is immediately followed by its OWN caption, and that ADJACENCY is
 * the contract: it is what the two-line grouping expresses to the eye, and the
 * only thing telling a reader which number came from where. Asserting the whole
 * row rather than a substring is what makes a swapped caption fail here.
 */
function costRowWithPair(reportedText: string): string {
  return `${ESTIMATE_TEXT}ClosedLoop estimate${reportedText}Claude reported`;
}

describe("ISS-7229 session-detail Claude-reported cost", () => {
  it("renders the reported figure beside the estimate when the flag is on", async () => {
    await renderPanel({ authoritativeCostUsd: REPORTED_USD, flagOn: true });

    // ONE row carrying both, each figure under its own source word. This used
    // to assert a separate "Claude reported" row beside an estimate-only Cost
    // row; the rows merged in ISS-7229's display revision, so the estimate is
    // now part of this string by construction rather than absent from it.
    expect(readRow("Cost")).toBe(costRowWithPair(REPORTED_TEXT));
    // Still exactly once, so the pair cannot be hiding an `?? estimatedCost`.
    expect(countText(ESTIMATE_TEXT)).toBe(1);
  });

  /**
   * THE load-bearing case. Absence alone would not catch a fallback (which
   * renders the row), so it is paired with the estimate's occurrence count:
   * `$1,438.84` must appear exactly ONCE, under "Cost". An `?? estimatedCost`
   * fallback makes it appear twice and reds this.
   */
  it("renders no reported row, and never the estimate, when Claude reported nothing", async () => {
    await renderPanel({ authoritativeCostUsd: null, flagOn: true });

    expect(screen.queryByText(CLAUDE_REPORTED_LABEL)).toBeNull();
    expect(countText(ESTIMATE_TEXT)).toBe(1);
    expect(readRow("Cost")).toBe(ESTIMATE_TEXT);
  });

  /** The same absence as an omitted key — a version-skewed API's actual shape. */
  it("treats an omitted field the same as an explicit null", async () => {
    await renderPanel({ authoritativeCostUsd: undefined, flagOn: true });

    expect(screen.queryByText(CLAUDE_REPORTED_LABEL)).toBeNull();
    expect(countText(ESTIMATE_TEXT)).toBe(1);
  });

  /** A reported $0.00 is MEASURED, not absent — a truthiness check would erase it. */
  it("renders a reported zero rather than treating it as absent", async () => {
    await renderPanel({ authoritativeCostUsd: 0, flagOn: true });

    expect(readRow("Cost")).toBe(costRowWithPair("$0.00"));
  });

  /**
   * davetho on #6980: a caption names a FIGURE, never a dash.
   *
   * Claude reporting a cost does not make our side a number. `estimatedCost: 0`
   * on a token-consuming session is `CostAvailability.Unavailable`, so
   * `deriveSessionCostLabel` returns `—`. Before the fix the pair captioned that
   * dash "ClosedLoop estimate", presenting an unknown as an estimate.
   *
   * Claude's figure still renders, with its own caption — it is a real number and
   * withholding it would cost the reader something we actually have. What must
   * not appear is a caption on the dash.
   */
  it("never captions an unavailable estimate, and keeps Claude's figure", async () => {
    await renderPanel({
      authoritativeCostUsd: REPORTED_USD,
      estimatedCost: 0,
      flagOn: true,
    });

    expect(screen.queryByText("ClosedLoop estimate")).toBeNull();
    expect(readRow("Cost")).toBe(`—${REPORTED_TEXT}Claude reported`);
  });

  /**
   * The ISS-4779 gate. Positive control is the first case: identical fixture and
   * query, only the flag flipped, so this proves the gate not a dead selector.
   */
  it("renders nothing when the flag is off, on a session that would otherwise show it", async () => {
    await renderPanel({ authoritativeCostUsd: REPORTED_USD, flagOn: false });

    expect(screen.queryByText(CLAUDE_REPORTED_LABEL)).toBeNull();
    expect(screen.queryByText(REPORTED_TEXT)).toBeNull();
    // The rest of the panel is untouched by the closed gate.
    expect(readRow("Cost")).toBe(ESTIMATE_TEXT);
  });
});

/** The value text of the property row carrying `label`. */
function readRow(label: string): string {
  const labelNode = screen.getByText(label);
  const row = labelNode.closest(".prd-prop");
  if (!row) {
    throw new Error(`No property row for label ${label}`);
  }
  return (row.textContent ?? "").replace(label, "").trim();
}

/** How many times `text` occurs anywhere in the rendered panel. */
function countText(text: string): number {
  return screen.queryAllByText(text).length;
}

async function renderPanel({
  authoritativeCostUsd,
  estimatedCost = ESTIMATE_USD,
  flagOn,
}: {
  authoritativeCostUsd: number | null | undefined;
  /** Override to drive a non-figure availability; defaults to a priced session. */
  estimatedCost?: number;
  flagOn: boolean;
}) {
  const base = createAgentSessionDetailFixture();
  const session: AgentSessionDetail = {
    ...base,
    estimatedCost,
    // Keep the session substantive so the Cost row renders a figure rather than
    // the zero-usage em-dash; the comparison under test needs both numbers.
    turns: base.turns ?? 1,
    inputTokens: base.inputTokens > 0 ? base.inputTokens : 1000,
    outputTokens: base.outputTokens > 0 ? base.outputTokens : 1000,
    billingMode: null,
    authoritativeCostUsd,
  };
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: flagOn
          ? [SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      <SessionPropertiesPanel session={session} />
    </FeatureFlagAdapterProvider>
  );
  // The rows under test live in the expanded panel; it starts collapsed.
  await userEvent.click(
    screen.getByRole("button", { name: PROPERTIES_TOGGLE_RE })
  );
}
