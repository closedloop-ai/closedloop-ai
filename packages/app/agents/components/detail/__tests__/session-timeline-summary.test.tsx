import { SUBSCRIPTION_BILLING_MODES } from "@repo/api/src/types/billing-mode";
import {
  SESSION_STATUS,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
} from "@repo/api/src/types/session-status";
import { resolveSessionDetailDurationWindow } from "@repo/app/agents/lib/session-detail-duration-window";
import { resolveSessionWallClockLabel } from "@repo/app/agents/lib/session-duration";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import {
  resetTraceComments,
  withProviders,
} from "./agent-session-detail-view.test-helpers";

/**
 * ISS-5970 — the Session Timeline's run-level cost/tokens/duration summary.
 *
 * Every assertion is on what the strip SAYS, driven through the real
 * `AgentSessionDetailView` rather than through the leaf in isolation, because
 * the thing that can regress is the wiring: the leaf could be perfect and the
 * page could never mount it. ISS-5999 graduated the summary to unconditional
 * and deleted the `sessions-detail-prototype-parity` key it rode, so the flag-OFF
 * twin below is gone rather than skipped; what replaces it is a case asserting
 * the summary is on the page with NO flags enabled at all, which is the state
 * the gated-off render used to occupy.
 *
 * The honesty cases are the point of the ticket, not extra coverage. A cost that
 * could not be computed, and a session with no token counters, must read
 * DIFFERENTLY from a real `$0.00` / `0` — otherwise the strip states a number
 * the system cannot back.
 */

const EM_DASH = "—";
/** ISS-5575: the start anchor of the stored-`active` run that has gone silent. */
const STALE_SPAN_STARTED_AT = new Date("2026-03-02T10:13:00Z");
/**
 * Comfortably past {@link STALE_SESSION_DISPLAY_THRESHOLD_HOURS} from that
 * anchor, so the run has folded to "Stale" — the state the Sessions list
 * already renders as the em-dash.
 */
const STALE_SPAN_NOW = new Date(
  STALE_SPAN_STARTED_AT.getTime() +
    (STALE_SESSION_DISPLAY_THRESHOLD_HOURS + 6) * 3_600_000
);
/**
 * Any `Nh Nm` span. The strip must print NO such span for a folded run — an
 * assertion on one exact string would pass against a different wrong number.
 */
const RUNNING_SPAN_PATTERN = /\d+h \d+m/;
/** Accessible names of the explanation triggers, by the unit word they carry. */
const TOKENS_TRIGGER_NAME = /tokens/i;
const COST_TRIGGER_NAME = /cost/i;
/**
 * A real member of the canonical subscription set — asserted below rather than
 * trusted, so this fixture cannot silently stop being a subscription session and
 * turn the genuinely-zero case back into an unavailable one.
 */
const SUBSCRIPTION_MODE = "pro";
/**
 * The two token explanations, pinned as literals HERE rather than imported: the
 * component keeps them private, and the contract under test is the wording a
 * reader sees, so a test that imported the same constant would still pass if
 * both cases were collapsed back onto one string.
 */
const TOKENS_UNTRUSTWORTHY_MESSAGE =
  "Token usage for this session could not be read";
const TOKENS_EMPTY_MESSAGE = "No token usage recorded for this session";

afterEach(() => {
  resetTraceComments();
  // ISS-5575: the stale-fold case pins the clock; leaking fake timers into the
  // sibling cases would freeze their `Date.now()`-derived Duration assertion.
  vi.useRealTimers();
});

function renderDetail(
  overrides: Parameters<typeof createAgentSessionDetailFixture>[0]
) {
  const session = createAgentSessionDetailFixture(overrides);
  render(
    withProviders(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session}
      />
    )
  );
  return session;
}

/** The timeline header, so a match cannot be satisfied by the Properties rows. */
function timelineHeader(): HTMLElement {
  const heading = screen.getByText("Session Timeline");
  const header = heading.closest(".sd3-act-head");
  if (!header) {
    throw new Error("Session Timeline header not found");
  }
  return header as HTMLElement;
}

describe("the timeline summary ships unconditionally", () => {
  it("states cost, tokens and duration with no feature flag enabled", () => {
    /*
     * ISS-5999: the counterfactual that used to be the flag-OFF twin. This
     * mounts the page with NO flags enabled — the exact provider state that made
     * the header carry only its title before the gate was retired — so a
     * regression that reintroduced any gate on this summary fails here.
     */
    renderDetail({
      endedAt: new Date("2026-03-02T12:30:00Z"),
      estimatedCost: 12.5,
      inputTokens: 2_000_000,
      outputTokens: 100_000,
      startedAt: new Date("2026-03-02T10:13:00Z"),
      status: SESSION_STATUS.INACTIVE,
    });

    const header = timelineHeader();
    expect(header).toHaveTextContent("$12.50");
    expect(header).toHaveTextContent("cost");
    expect(header).toHaveTextContent("2.10M");
    expect(header).toHaveTextContent("tokens");
    // 10:13 -> 12:30 is 2h 17m, and it must be the RUN's span.
    expect(header).toHaveTextContent("2h 17m");
  });
});

describe("the summary never states a number it cannot back", () => {
  it("dashes an uncomputable cost rather than printing $0.00", () => {
    renderDetail({
      endedAt: new Date("2026-03-02T12:30:00Z"),
      estimatedCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      startedAt: new Date("2026-03-02T10:13:00Z"),
      status: SESSION_STATUS.INACTIVE,
      turns: 0,
    });

    const header = timelineHeader();
    expect(header).toHaveTextContent(EM_DASH);
    expect(header).not.toHaveTextContent("$0.00");
  });

  it("dashes tokens when no token usage was recorded", () => {
    renderDetail({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      endedAt: new Date("2026-03-02T12:30:00Z"),
      estimatedCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      startedAt: new Date("2026-03-02T10:13:00Z"),
      status: SESSION_STATUS.INACTIVE,
      turns: 0,
    });

    const header = timelineHeader();
    expect(header).toHaveTextContent(EM_DASH);
    /*
     * The dash carries its reason on a FOCUSABLE trigger, not a native `title`
     * (#design review): a mouse-only explanation is no explanation for a
     * keyboard, touch or screen-reader user. Asserting the button is what would
     * fail if this regressed to a bare span.
     */
    const tokensTrigger = within(header).getByRole("button", {
      name: TOKENS_TRIGGER_NAME,
    });
    expect(tokensTrigger).toBeInTheDocument();
    tokensTrigger.focus();
    expect(tokensTrigger).toHaveFocus();
  });

  it("says a corrupt counter could not be READ, not that nothing was recorded", async () => {
    /*
     * #4869 design review. A negative total is a corrupt counter, not an idle
     * run, and the two used to share a branch — so a session whose usage we
     * could not trust told the reader "No token usage recorded for this
     * session", a confident claim about the RUN that the data does not support.
     * The dash is right either way; the sentence under it has to be true of the
     * case it describes.
     */
    renderDetail({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      endedAt: new Date("2026-03-02T12:30:00Z"),
      estimatedCost: 0,
      inputTokens: -1,
      outputTokens: 0,
      startedAt: new Date("2026-03-02T10:13:00Z"),
      status: SESSION_STATUS.INACTIVE,
      turns: 3,
    });

    const header = timelineHeader();
    // Never the raw corrupt figure, and never a fabricated `0`.
    expect(header).toHaveTextContent(EM_DASH);
    expect(header).not.toHaveTextContent("-1");
    expect(header).not.toHaveTextContent("NaN");

    const tokensTrigger = within(header).getByRole("button", {
      name: TOKENS_TRIGGER_NAME,
    });
    // Radix opens on focus without the hover delay, so this is the explanation
    // a keyboard user actually reaches.
    tokensTrigger.focus();
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(TOKENS_UNTRUSTWORTHY_MESSAGE);
    expect(tooltip).not.toHaveTextContent(TOKENS_EMPTY_MESSAGE);
  });

  it("prints a genuinely-zero-cost run's real token count, not a dash", () => {
    /*
     * The distinction the ticket turns on: this run DID work — it has token
     * counters — its priced cost is simply zero (a subscription-billed run). It
     * must not read like the "not computed" case above.
     */
    renderDetail({
      billingMode: SUBSCRIPTION_MODE,
      endedAt: new Date("2026-03-02T12:30:00Z"),
      estimatedCost: 0,
      inputTokens: 1_500_000,
      outputTokens: 0,
      startedAt: new Date("2026-03-02T10:13:00Z"),
      status: SESSION_STATUS.INACTIVE,
      turns: 12,
    });

    expect(SUBSCRIPTION_BILLING_MODES.has(SUBSCRIPTION_MODE)).toBe(true);
    const header = timelineHeader();
    expect(header).toHaveTextContent("1.50M");
    expect(header).toHaveTextContent("$0.00");
    expect(header).not.toHaveTextContent(EM_DASH);
    /*
     * A covered run still owes the reader WHY it was free (#design review).
     * The explanation used to be dropped for every non-dash cost, so this
     * screen said "$0.00" bare while the Sessions list explained the same
     * session two clicks away.
     */
    expect(
      within(header).getByRole("button", { name: COST_TRIGGER_NAME })
    ).toBeInTheDocument();
  });
});

describe("the summary agrees with the rest of the page", () => {
  it("prints the run's duration, from the canonical Duration chain", () => {
    const session = renderDetail({
      endedAt: new Date("2026-03-02T12:30:00Z"),
      estimatedCost: 4.82,
      inputTokens: 12_000,
      startedAt: new Date("2026-03-02T10:13:00Z"),
      status: SESSION_STATUS.INACTIVE,
    });

    /*
     * Compared against the canonical Duration chain rather than against a
     * hardcoded string: this is the assertion that would fail if the strip were
     * wired to the timeline's `calendar span` caption, which measures the
     * windowed AXIS and not the run — the ISS-5563/ISS-5578 disagreement this
     * strip could otherwise reintroduce.
     */
    const expected = resolveSessionWallClockLabel(
      session.startedAt ?? null,
      resolveSessionDetailDurationWindow(session),
      Date.now()
    );
    expect(expected).toBe("2h 17m");
    expect(timelineHeader()).toHaveTextContent(expected as string);
  });

  it("shows no span for a stored-active run the list has folded to Stale", () => {
    // ISS-5575: the strip resolves the SAME displayed-status window the
    // Properties Duration row and the Sessions list cell do, so it cannot report
    // a span for a run the rest of the screen has stopped timing. Reverting the
    // component to `resolveSessionDurationWindow(session.status, …)` reds this —
    // the raw `active` reads as running and the strip prints a climbing number.
    vi.useFakeTimers();
    vi.setSystemTime(STALE_SPAN_NOW);
    renderDetail({
      endedAt: null,
      estimatedCost: 4.82,
      inputTokens: 12_000,
      lastActivityAt: STALE_SPAN_STARTED_AT,
      startedAt: STALE_SPAN_STARTED_AT,
      status: SESSION_STATUS.ACTIVE,
    });

    expect(timelineHeader()).not.toHaveTextContent(RUNNING_SPAN_PATTERN);
  });
});
