import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SESSION_TOKENS_RECORDED_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { hasRecordedTokenUsage } from "../../../lib/cost-availability";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionPropertiesPanel } from "../session-properties-panel";

/**
 * ISS-5637 — the session-detail Tokens row printed four measured zeros for a
 * session that recorded no token usage, two rows above a Cost dash meaning
 * exactly the opposite. ISS-5565 gave the row an unknown state keyed on a
 * per-counter `null`, but NEITHER producer can emit that null (see
 * {@link producerRecord}), so the unknown state was unreachable and the
 * fabricated `0 in | 0 out | 0 cache read | 0 cache write` was the only thing a
 * zero-usage session could render.
 *
 * The load-bearing spec is {@link describe} "one panel, one story": it renders
 * the Tokens row and the Cost row from ONE record in ONE tree and compares them
 * to EACH OTHER. Checking each against a constant independently would keep
 * passing if the two drifted apart again, which is the reported harm itself.
 */

const PROPERTIES_TOGGLE_RE = /Properties/;
const TOKENS_LABEL = "Tokens";
const COST_LABEL = "Cost";
const EM_DASH = "—";

describe("ISS-5637 the Tokens row tells unknown apart from a measured zero", () => {
  /**
   * THE reported defect. A session with no token-usage rows is what both
   * producers turn into four zeros, and the row asserted them as measurements.
   */
  it("renders the unknown affordance for the zero-usage record both producers emit", async () => {
    await renderPanel({ usage: NO_RECORDED_USAGE, flagOn: true });

    expect(visibleValue(TOKENS_LABEL)).toBe(EM_DASH);
    // The exact fabricated claim from the ticket, named literally so a
    // reformatted row cannot quietly satisfy this.
    expect(visibleValue(TOKENS_LABEL)).not.toContain("0 in");
    expect(visibleValue(TOKENS_LABEL)).not.toContain("0 cache read");
  });

  /**
   * The other half of the distinction, and the one a careless fix breaks: a
   * session that DID record usage still reports its per-counter zeros as the
   * measurements they are. Collapsing these to a dash would swap one lie for
   * another.
   */
  it("keeps a per-counter zero as a measured zero when usage was recorded", async () => {
    await renderPanel({ usage: RECORDED_WITH_ZERO_CACHE, flagOn: true });

    const value = visibleValue(TOKENS_LABEL);
    expect(value).toContain("1,234 in");
    expect(value).toContain("56 out");
    // The two counters that really were measured at zero.
    expect(value).toContain("0 cache read");
    expect(value).toContain("0 cache write");
    expect(value).not.toContain(EM_DASH);
  });

  /** The fully-populated third state: every counter a number, no hedge at all. */
  it("renders every counter, and no explanation, for a fully populated session", async () => {
    await renderPanel({ usage: FULLY_RECORDED, flagOn: true });

    expect(visibleValue(TOKENS_LABEL)).toBe(
      "12,000 in | 3,200 out | 900 cache read | 400 cache write"
    );
    expect(explanationOf(TOKENS_LABEL)).toBeNull();
  });

  /**
   * The unknown state must survive as TEXT, not as a glyph alone — a reader who
   * cannot see the em-dash still has to learn why the row is empty (WCAG 1.4.1:
   * never encode a state in hue or shape alone).
   */
  it("states the reason in the accessible name, not the glyph alone", async () => {
    await renderPanel({ usage: NO_RECORDED_USAGE, flagOn: true });

    expect(explanationOf(TOKENS_LABEL)).toContain(
      "Token counts were not recorded for this session"
    );
  });

  /**
   * The absent-KEY shape, distinct from four zeros and from four nulls. A
   * version-skewed peer that sends no counters at all must reach the same one
   * dash, never `undefined in | undefined out`.
   */
  it("collapses to the same unknown when the producer omits the counters entirely", async () => {
    await renderPanel({ usage: OMITTED_ENTIRELY, flagOn: true });

    expect(visibleValue(TOKENS_LABEL)).toBe(EM_DASH);
    expect(visibleValue(TOKENS_LABEL)).not.toContain("undefined");
    expect(explanationOf(TOKENS_LABEL)).toContain(
      "Token counts were not recorded for this session"
    );
  });

  /**
   * ISS-5565's per-counter degradation is NOT retired by this change. A
   * version-skewed producer that omits one counter from a session that did
   * record usage still dashes that counter alone and names it.
   */
  it("still degrades per counter for a skewed producer that omits one", async () => {
    await renderPanel({ usage: RECORDED_WITH_OMITTED_CACHE, flagOn: true });

    const value = visibleValue(TOKENS_LABEL);
    expect(value).toContain("1,234 in");
    expect(value).toContain(EM_DASH);
    expect(explanationOf(TOKENS_LABEL)).toContain(
      "Cache reads were not recorded for this session"
    );
  });
});

describe("ISS-5637 one panel, one story: Tokens and Cost cannot contradict", () => {
  /**
   * The reported harm, asserted as the RELATIONSHIP rather than as two
   * independent constants: on the same rendered panel, the Cost row already
   * refuses to state a figure for this session, so the Tokens row must not
   * state four measurements for it either.
   */
  it("dashes Tokens on the same panel where Cost dashes for want of token usage", async () => {
    await renderPanel({ usage: NO_RECORDED_USAGE, flagOn: true });

    expect(visibleValue(COST_LABEL)).toBe(EM_DASH);
    expect(visibleValue(TOKENS_LABEL)).toBe(visibleValue(COST_LABEL));
  });

  /**
   * The positive sibling. Without it the spec above is satisfied by dashing
   * every row on every session, which is the opposite failure.
   */
  it("states both Tokens and Cost on the same panel when usage was recorded", async () => {
    await renderPanel({ usage: RECORDED_WITH_ZERO_CACHE, flagOn: true });

    expect(visibleValue(COST_LABEL)).toBe("$0.42");
    expect(visibleValue(COST_LABEL)).not.toBe(EM_DASH);
    expect(visibleValue(TOKENS_LABEL)).toContain("1,234 in");
    expect(visibleValue(TOKENS_LABEL)).not.toBe(EM_DASH);
  });

  /**
   * The ISS-4779 gate, proved against the identical record and query with only
   * the flag flipped — so this is the closed gate, not a dead selector. It also
   * pins the CONTRADICTION as the shipped default: Cost dashes while Tokens
   * asserts zeros, on one panel.
   */
  it("leaves the contradicting default render untouched when the flag is off", async () => {
    await renderPanel({ usage: NO_RECORDED_USAGE, flagOn: false });

    expect(visibleValue(TOKENS_LABEL)).toBe(
      "0 in | 0 out | 0 cache read | 0 cache write"
    );
    expect(visibleValue(COST_LABEL)).toBe(EM_DASH);
  });
});

describe("ISS-5637 hasRecordedTokenUsage is the evidence both rows read", () => {
  it("reports no recorded usage when every counter is zero", () => {
    expect(hasRecordedTokenUsage(NO_RECORDED_USAGE)).toBe(false);
  });

  it("reports recorded usage when any single counter is positive", () => {
    expect(
      hasRecordedTokenUsage({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 7,
      })
    ).toBe(true);
  });

  /** A skewed producer that omits every counter is unknown, never a zero claim. */
  it("treats omitted counters as no recorded usage rather than crashing", () => {
    expect(hasRecordedTokenUsage({})).toBe(false);
  });
});

/** The four token counters as ONE source, the way both producers hold them. */
type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * A session with no token-usage rows at all — the ticket's production repro.
 *
 * This is not an invented shape: it is what BOTH producers emit for such a
 * session. The cloud reads four `BigInt @default(0)` columns through a
 * `toNumber` that maps null to `0` (`projections.ts`), and the desktop folds
 * `sumTokenUsage` over an empty `tokenUsageByModel` starting from
 * `zeroTotals()` (`session-usage-totals.ts`). Neither can produce the `null`
 * ISS-5565's unknown state was keyed on.
 */
const NO_RECORDED_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** Recorded usage whose cache halves genuinely measured zero. */
const RECORDED_WITH_ZERO_CACHE: TokenUsage = {
  inputTokens: 1234,
  outputTokens: 56,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const FULLY_RECORDED: TokenUsage = {
  inputTokens: 12_000,
  outputTokens: 3200,
  cacheReadTokens: 900,
  cacheWriteTokens: 400,
};

/**
 * A version-skewed producer that recorded usage but omitted one counter.
 *
 * The ONE fixture here that is deliberately NOT producer-faithful, and the
 * exception is the point: it sets `cache: null` while leaving `cacheReadTokens`
 * a number, a divergence between the two field families that no producer
 * shipping today can emit (both assign the pair from one summed value). It
 * exists to keep ISS-5565's per-counter degradation — which this change does not
 * retire — under test against a future or older peer that sends a partial
 * quadruple. Read it as a compatibility case, not as evidence about a session
 * you could load right now.
 */
const RECORDED_WITH_OMITTED_CACHE: TokenUsage & { omitCacheRead: true } = {
  inputTokens: 1234,
  outputTokens: 56,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  omitCacheRead: true,
};

/**
 * A peer too old to send the display counters at all — the keys are absent, not
 * null. The row's docstring claims this still lands on the one-dash unknown;
 * this is the render-level proof of that claim, which the predicate-level
 * `hasRecordedTokenUsage({})` case alone does not give (it exercises the rule
 * without the wiring that feeds it).
 */
const OMITTED_ENTIRELY: TokenUsage & { omitAll: true } = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  omitAll: true,
};

/** The `.prd-prop` row carrying `label`. */
function rowFor(label: string): HTMLElement {
  const row = screen.getByText(label).closest(".prd-prop");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`No property row for label ${label}`);
  }
  return row;
}

/**
 * The row's VISIBLE value — the label and the `sr-only` reason stripped out.
 *
 * Both tails have to go or the assertions stop meaning what they say: the
 * reason sentence contains the word "recorded", and `toBeVisible` would accept
 * the clipped `sr-only` span as rendered text.
 */
function visibleValue(label: string): string {
  const clone = rowFor(label).cloneNode(true) as HTMLElement;
  for (const srOnly of clone.querySelectorAll(".sr-only")) {
    srOnly.remove();
  }
  const labelNode = clone.querySelector(".prd-prop-label");
  labelNode?.remove();
  return (clone.textContent ?? "").trim();
}

/** The row's accessible reason sentence, or null when it states none. */
function explanationOf(label: string): string | null {
  return rowFor(label).querySelector(".sr-only")?.textContent ?? null;
}

/**
 * Fans ONE set of four counters into BOTH field families the detail record
 * carries, exactly as both producers do — the cloud (`projections.ts`) and the
 * desktop (`shared-agent-sessions-api.ts`) each assign `tokensIn` and
 * `inputTokens` from the same summed value. Building the fixture this way is
 * the point: the Tokens row reads `tokensIn/tokensOut/cache/cacheWrite` and the
 * Cost row reads `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens`,
 * and a hand-authored divergence between them would let the two rows disagree
 * here for a reason no production session could ever have.
 */
function producerRecord(
  usage: TokenUsage & { omitCacheRead?: true; omitAll?: true }
): AgentSessionDetail {
  const base = createAgentSessionDetailFixture();
  const record: AgentSessionDetail = {
    ...base,
    // The errored-on-turn-one shape from ISS-5572: a turn was registered, so the
    // session is substantive, but nothing was ever priced.
    turns: 1,
    toolCallsTotal: 0,
    toolUseCount: 0,
    billingMode: null,
    estimatedCost: usage.inputTokens > 0 ? 0.42 : 0,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    cache: usage.omitCacheRead ? null : usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    // The Codex runtime rows read this blob and would add a second "cache read"
    // line to the panel; this ticket is about the Tokens row alone.
    metadata: null,
    tokenUsageByModel: [],
  };
  if (usage.omitAll) {
    // A peer old enough to send no token counters at all omits the KEYS — it
    // does not send four nulls — so this deletes them rather than assigning
    // `undefined`, which would leave `"tokensIn" in record` true and quietly
    // test a different shape than the one being claimed.
    for (const key of DISPLAY_COUNTER_KEYS) {
      Reflect.deleteProperty(record, key);
    }
  }
  return record;
}

/**
 * The four counters the Tokens row RENDERS, as opposed to the parallel family
 * the Cost row reads. Named once so {@link producerRecord}'s omitted-key shape
 * cannot drift from the fields the row actually consults.
 */
const DISPLAY_COUNTER_KEYS = [
  "tokensIn",
  "tokensOut",
  "cache",
  "cacheWrite",
] as const satisfies readonly (keyof AgentSessionDetail)[];

async function renderPanel({
  usage,
  flagOn,
}: {
  usage: TokenUsage & { omitCacheRead?: true; omitAll?: true };
  flagOn: boolean;
}) {
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: flagOn
          ? [SESSION_TOKENS_RECORDED_HONESTY_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      <SessionPropertiesPanel session={producerRecord(usage)} />
    </FeatureFlagAdapterProvider>
  );
  // The rows under test live in the expanded panel; it starts collapsed.
  await userEvent.click(
    screen.getByRole("button", { name: PROPERTIES_TOGGLE_RE })
  );
}
