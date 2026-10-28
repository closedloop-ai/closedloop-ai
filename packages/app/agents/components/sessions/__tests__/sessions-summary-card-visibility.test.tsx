import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { TOTAL_ESTIMATED_COST_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DASHBOARD_METRIC_CARD_CLASS_NAME } from "../../../../insights/components/overview/dashboard-card";
import { TOTAL_TOKENS_METRIC_CARD_LABEL } from "../sessions-summary-card-labels";
import {
  SESSIONS_DELIVERY_SUMMARY_CARD_IDS,
  SESSIONS_SUMMARY_CARD_IDS,
  SessionsSummaryCardId,
} from "../sessions-summary-card-visibility";
import { SessionsSummaryCards } from "../sessions-summary-cards";
import { SessionsSummaryCardsLoading } from "../sessions-summary-cards-loading";

const CARD_SELECTOR = '[data-slot="card"]';
const ALL_CARDS = SESSIONS_SUMMARY_CARD_IDS.length;
const DELIVERY_CARDS = SESSIONS_DELIVERY_SUMMARY_CARD_IDS.length;
/**
 * ISS-7866: a gated delivery card asks to CONNECT GITHUB in every gated state,
 * signed out included — the strip's own sign-in verb is retired. Read from the
 * copy map, never spelled here.
 */
const CONNECT_CTA_LABEL =
  GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].cardCtaLabel ??
  GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].ctaLabel;
const CONNECT_EXPLANATION =
  GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].gatedMetricExplanation;
/** The retired verb, asserted absent so it cannot quietly come back. */
const SIGN_IN_ACTION = "Sign in";
/** A desktop-shaped connect target (a handler, never an href — FEA-3280). */
const CONNECT_TARGET: GitHubConnectTarget = {
  action: GitHubConnectAction.Connect,
  onConnect: () => undefined,
};

function usageFixture(): AgentSessionUsageSummary {
  return {
    viewerScope: AgentSessionViewerScope.Organization,
    totalSessions: 12,
    earliestSessionAt: null,
    latestSessionAt: null,
    totalInputTokens: 1000,
    totalOutputTokens: 200,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 42,
    subscriptionEstimatedCost: 0,
    apiEstimatedCost: 42,
    mergedPrCount: 7,
    mergedLocPerDollar: 3.5,
    byUser: [],
    byModel: [],
    byHarness: [],
    byRepository: [],
    lastSyncTargets: [],
  };
}

describe("FEA-4217 — summary-card visibility", () => {
  it("paints all five cards when nothing is hidden", () => {
    const { container } = render(
      <SessionsSummaryCards isLoading={false} usage={usageFixture()} />
    );

    expect(container.querySelectorAll(CARD_SELECTOR)).toHaveLength(ALL_CARDS);
  });

  it("drops exactly the hidden cards from the settled strip and keeps the rest", () => {
    const { container } = render(
      <SessionsSummaryCards
        hiddenCardIds={
          new Set([
            SessionsSummaryCardId.Cost,
            SessionsSummaryCardId.LocPerDollar,
          ])
        }
        isLoading={false}
        usage={usageFixture()}
      />
    );

    expect(container.querySelectorAll(CARD_SELECTOR)).toHaveLength(
      ALL_CARDS - 2
    );
    expect(screen.queryByText(TOTAL_ESTIMATED_COST_LABEL)).toBeNull();
    expect(screen.queryByText(LOC_PER_DOLLAR_LABEL)).toBeNull();
    // The kept cards are still there — a strip that dropped everything would
    // otherwise satisfy the two absences above.
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(
      screen.getByText(TOTAL_TOKENS_METRIC_CARD_LABEL)
    ).toBeInTheDocument();
    expect(screen.getByText("PRs Shipped")).toBeInTheDocument();
  });

  it("hides the SAME cards in the loading shell, so the strip does not change width when it settles", () => {
    const hiddenCardIds = new Set([SessionsSummaryCardId.Tokens]);
    const shell = render(
      <SessionsSummaryCardsLoading
        cardClassName=""
        hiddenCardIds={hiddenCardIds}
        loadingDetail="Loading…"
        locPerDollarLabel={LOC_PER_DOLLAR_LABEL}
        reservesDeltaSlot={false}
      />
    );

    expect(shell.container.querySelectorAll(CARD_SELECTOR)).toHaveLength(
      ALL_CARDS - 1
    );
    expect(screen.queryByText(TOTAL_TOKENS_METRIC_CARD_LABEL)).toBeNull();
    expect(screen.getByText("Sessions")).toBeInTheDocument();

    // The settled strip for the same hidden set renders the same COUNT. This is
    // the assertion the shell/strip pair exists for: if only one of the two
    // honoured the hidden set, the row would jump on settle.
    shell.unmount();
    const settled = render(
      <SessionsSummaryCards
        hiddenCardIds={hiddenCardIds}
        isLoading={false}
        usage={usageFixture()}
      />
    );
    expect(settled.container.querySelectorAll(CARD_SELECTOR)).toHaveLength(
      ALL_CARDS - 1
    );
  });

  it("renders NOTHING when every card is hidden, not an empty row", () => {
    const { container } = render(
      <SessionsSummaryCards
        hiddenCardIds={new Set(SESSIONS_SUMMARY_CARD_IDS)}
        isLoading={false}
        usage={usageFixture()}
      />
    );

    // An empty `SummaryCardRow` is a zero-height child of its host's
    // `flex flex-col gap-*`, which leaves an unexplained band between the
    // toolbar and the table — and, signed out, a sign-in banner over no cards.
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps a PARTIAL strip on the non-stretching card width", () => {
    // The stretching mode gives each card a `1fr` track, so hiding cards
    // inflates the survivors to widths nobody designed (one card spanning the
    // whole row at the desktop launch width). A partial strip keeps the row's
    // measured `--summary-card-min` card instead.
    const full = render(
      <SessionsSummaryCards
        isLoading={false}
        usage={usageFixture()}
        wrapBelow
      />
    );
    const fullCard = full.container.querySelector(CARD_SELECTOR);
    expect(fullCard?.className).toContain("w-full");
    expect(fullCard?.className).not.toContain("md:w-[var(--summary-card-min)]");

    full.unmount();
    const partial = render(
      <SessionsSummaryCards
        hiddenCardIds={new Set([SessionsSummaryCardId.Cost])}
        isLoading={false}
        usage={usageFixture()}
        wrapBelow
      />
    );
    const partialCard = partial.container.querySelector(CARD_SELECTOR);
    // The non-stretching width starts at `md+`, which is where the auto-fit
    // tracks inflate and where those widths were measured. Below `md` the row is
    // still the two-column phone grid, whose tracks are narrower than
    // `--summary-card-min`, so pinning the fixed width there pushed each card
    // past its own track (codex review on #6914) — that half stays fluid. The
    // `md:` prefix is what the full strip above does NOT carry, so this still
    // fails if a partial strip goes back to a `1fr` track at the desktop width.
    expect(partialCard?.className).toContain("md:w-[var(--summary-card-min)]");
  });

  it("keeps a PARTIAL strip on that width for a host that supplies its own card class", () => {
    // The desktop Sessions view passes `DASHBOARD_METRIC_CARD_CLASS_NAME`, which
    // is presentation (`h-full`, headline size) and carries NO width. A `??`
    // that treats the host class as the whole per-card class hands the partial
    // strip straight back to the stretching `1fr` grid on the one surface those
    // inflation numbers were measured on, so the width must COMPOSE onto it —
    // and the host's own presentation must survive the composition.
    const { container } = render(
      <SessionsSummaryCards
        cardClassName={DASHBOARD_METRIC_CARD_CLASS_NAME}
        hiddenCardIds={new Set([SessionsSummaryCardId.Cost])}
        isLoading={false}
        usage={usageFixture()}
        wrapBelow
      />
    );

    const partialCard = container.querySelector(CARD_SELECTOR);
    expect(partialCard?.className).toContain("--summary-card-min");
    expect(partialCard?.className).toContain("h-full");
  });

  it("paints every card for a stored view that predates a card, rather than dropping the unknown one", () => {
    // An id no build ships. A stored view carrying it must not hide a real card
    // and must not blank the strip — this is why visibility is stored as the
    // HIDDEN set rather than the visible one.
    const { container } = render(
      <SessionsSummaryCards
        hiddenCardIds={new Set(["a-card-that-never-existed"])}
        isLoading={false}
        usage={usageFixture()}
      />
    );

    expect(container.querySelectorAll(CARD_SELECTOR)).toHaveLength(ALL_CARDS);
  });

  it("drops the gated ask once BOTH delivery cards are hidden", () => {
    // whitlockk review. The ask exists so the two cloud-only delivery cards can
    // carry real numbers. With both of those cards removed from the strip it is
    // asking for metrics that are no longer on screen — the ask names something
    // the surface no longer shows.
    //
    // ISS-7869 moved the ask ONTO the cards, which makes this structural rather
    // than a condition to maintain: no card, no ask. ISS-7866 changed WHICH ask
    // it is — signed out now asks to connect GitHub, the same words every other
    // GitHub-truth surface uses — which is why this reads for the connect copy.
    const { container } = render(
      <SessionsSummaryCards
        authenticated={false}
        githubConnect={CONNECT_TARGET}
        hiddenCardIds={
          new Set([
            SessionsSummaryCardId.PrsShipped,
            SessionsSummaryCardId.LocPerDollar,
          ])
        }
        isLoading={false}
        usage={usageFixture()}
      />
    );

    expect(screen.queryByText(CONNECT_EXPLANATION)).toBeNull();
    expect(
      screen.queryByRole("button", { name: CONNECT_CTA_LABEL })
    ).toBeNull();
    // The ask went away; the strip did not. The three always-available cards a
    // signed-out reader can still read are untouched.
    expect(container.querySelectorAll(CARD_SELECTOR)).toHaveLength(
      ALL_CARDS - DELIVERY_CARDS
    );
  });

  it("keeps the gated ask on the ONE delivery card still visible", () => {
    // The other half: hiding one of the pair must not silence an ask the
    // surviving card still needs. Without this, dropping the ask whenever ANY
    // card is hidden would pass the case above just as well.
    render(
      <SessionsSummaryCards
        authenticated={false}
        githubConnect={CONNECT_TARGET}
        hiddenCardIds={new Set([SessionsSummaryCardId.PrsShipped])}
        isLoading={false}
        usage={usageFixture()}
      />
    );

    // ISS-7869: exactly ONE ask, because exactly one delivery card survives —
    // the count is a property of the visible cards rather than of a separate
    // hoist condition. ISS-7866: with a live target the card renders the CTA and
    // not the explanation sentence, and the retired sign-in verb is gone.
    expect(
      screen.getAllByRole("button", { name: CONNECT_CTA_LABEL })
    ).toHaveLength(1);
    expect(screen.queryByText(CONNECT_EXPLANATION)).toBeNull();
    expect(screen.queryByRole("button", { name: SIGN_IN_ACTION })).toBeNull();
  });
});
