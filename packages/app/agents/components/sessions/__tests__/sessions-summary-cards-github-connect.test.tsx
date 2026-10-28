/**
 * ISS-7869 — the Sessions strip's ask, and where it lives.
 *
 * Two defects, both about consistency rather than pixels.
 *
 * WHAT is asked: signed in with no GitHub connection, `PRs Shipped` and
 * `LOC / $` showed a bare dash and no ask at all, while Branches, the Insights
 * grid and the Dashboard stats row all offer a connect affordance for that same
 * state. The module header called that divergence intentional, which documents
 * an inconsistency rather than resolving it.
 *
 * WHERE it is asked: FEA-4037 hoisted the signed-out sign-in ask into a single
 * banner ABOVE the row, making this the one GitHub-truth strip whose ask sat
 * somewhere other than the card it unlocks. It rides the card again.
 *
 * ISS-7866 settled the third question, WHICH ask: one, everywhere. The
 * signed-out card used to offer a SIGN-IN affordance of its own, so a single
 * user at a single moment met two different verbs for one wall depending on
 * which screen they were on. Signed out now asks to connect GitHub, the same
 * words the dashboard, Branches and the Insights grid use — which is why the
 * second describe below reads as it does and why `SessionsSummaryCards` no
 * longer takes `onSignIn`, `signInError`, or `signInPromptSuppressed`.
 *
 * What matters as much as an ask appearing is the states it must NOT appear in,
 * each its own case below: an UNKNOWN connection while SIGNED IN (a read that
 * has not landed says nothing about whether this user is connected), and a card
 * that has a real value to state (an ask must never be bought by withdrawing
 * data). Signed OUT is not one of those states — no session means no grant and
 * no installation to read, so it is a fact rather than an unread status.
 *
 * `SessionsSummaryCards` is the composite BOTH shells mount — `apps/app`'s
 * Sessions page and the desktop `SessionsView` — so grading it here grades what
 * production renders on both surfaces.
 */

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PRS_SHIPPED_METRIC_CARD_LABEL } from "../sessions-summary-card-labels";
import { SessionsSummaryCards } from "../sessions-summary-cards";

const CONNECT_GITHUB_RE = /connect (?:to )?github/i;
/**
 * ISS-7866 retired the Sessions strip's own sign-in verb. Asserted ABSENT on
 * the signed-out card below, because "the ask is worded like every other
 * surface's" is only half a claim if the old wording can still render beside
 * it.
 */
const SIGN_IN_RE = /sign in/i;

/** The scope caption the FEA-3574 signed-in empty carries on this card. */
const SIGNED_IN_EMPTY_CAPTION = "merged in range";

/**
 * The PRs Shipped card's own subtree. Every assertion is scoped through this:
 * the strip renders four sibling cards that legitimately print dashes and
 * numbers of their own, so a row-wide query would be satisfied — or defeated —
 * by a neighbour and prove nothing about the card under test. It is also what
 * makes the "on the card, not above the row" cases mean anything.
 */
function prsShippedCard(container: HTMLElement): HTMLElement {
  const card = [...container.querySelectorAll('[data-slot="card"]')].find(
    (node) => node.textContent?.includes(PRS_SHIPPED_METRIC_CARD_LABEL)
  );
  if (!card) {
    throw new Error("PRs Shipped card not found on the summary row");
  }
  return card as HTMLElement;
}

function usageFixture(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return {
    viewerScope: AgentSessionViewerScope.Organization,
    totalSessions: 12,
    earliestSessionAt: null,
    latestSessionAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 42,
    subscriptionEstimatedCost: 0,
    apiEstimatedCost: 42,
    // The state under test: the cloud read landed and this account has no
    // merged-PR delivery data to show.
    mergedPrCount: null,
    mergedLocPerDollar: null,
    byUser: [],
    byModel: [],
    byHarness: [],
    byRepository: [],
    lastSyncTargets: [],
    ...overrides,
  };
}

/**
 * A desktop-shaped connect target: a HANDLER, never an href. An in-app link on
 * the desktop renderer is the FEA-3280 dead click, and `GitHubConnectTarget`
 * makes the pair unrepresentable, so this also pins that the strip renders a
 * button for the handler shape.
 */
function handlerTarget(onConnect: () => void): GitHubConnectTarget {
  return { action: GitHubConnectAction.Connect, onConnect };
}

function renderStrip({
  githubConnected,
  authenticated = true,
  usage = usageFixture(),
  githubConnect,
}: {
  githubConnected?: boolean;
  authenticated?: boolean;
  usage?: AgentSessionUsageSummary;
  githubConnect?: GitHubConnectTarget;
}) {
  return render(
    <SessionsSummaryCards
      authenticated={authenticated}
      githubConnect={githubConnect}
      githubConnected={githubConnected}
      isLoading={false}
      usage={usage}
    />
  );
}

describe("ISS-7869 Sessions connect ask — signed in, no GitHub connection", () => {
  it("offers a live Connect GitHub action on a delivery card with nothing to state", () => {
    const onConnect = vi.fn();
    const { container } = renderStrip({
      githubConnected: false,
      githubConnect: handlerTarget(onConnect),
    });
    const card = within(prsShippedCard(container));

    // The card keeps its label — an ask in an unnamed card cannot be attributed
    // to a metric.
    expect(screen.getByText(PRS_SHIPPED_METRIC_CARD_LABEL)).toBeInTheDocument();
    const control = card.getByRole("button", { name: CONNECT_GITHUB_RE });
    // Handler shape → a button and NO link. An in-app connect link on desktop
    // navigates inside the app and never reaches the connect IPC.
    expect(card.queryByRole("link", { name: CONNECT_GITHUB_RE })).toBeNull();

    fireEvent.click(control);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("completes the ask with the shared supporting sentence, like the dashboard cards", () => {
    const { container } = renderStrip({
      githubConnected: false,
      githubConnect: handlerTarget(vi.fn()),
    });

    expect(
      within(prsShippedCard(container)).getByText(
        GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].cardSupportingCopy ??
          ""
      )
    ).toBeInTheDocument();
  });

  it("does not ask when the connection status is UNKNOWN", () => {
    // `undefined` is a read that has not landed or one that failed — it says
    // nothing about whether this user is connected, and asking a connected user
    // to connect is the ISS-5958 defect this rule exists to prevent.
    const { container } = renderStrip({
      githubConnected: undefined,
      githubConnect: handlerTarget(vi.fn()),
    });
    const card = within(prsShippedCard(container));

    expect(card.queryByRole("button", { name: CONNECT_GITHUB_RE })).toBeNull();
    expect(card.getByText(SIGNED_IN_EMPTY_CAPTION)).toBeInTheDocument();
  });

  it("states a real value rather than buying the ask by withdrawing it", () => {
    // A cloud value can outlive the personal grant that produced it, or arrive
    // through an org App installation. Trading it for a prompt would cost the
    // reader data they can use.
    const { container } = renderStrip({
      githubConnected: false,
      githubConnect: handlerTarget(vi.fn()),
      usage: usageFixture({ mergedPrCount: 7 }),
    });
    const card = within(prsShippedCard(container));

    expect(card.getByText("7")).toBeInTheDocument();
    expect(card.queryByRole("button", { name: CONNECT_GITHUB_RE })).toBeNull();
  });
});

describe("ISS-7866 Sessions signed-out ask — one verb, on the card", () => {
  it("renders the CONNECT ask INSIDE the card it unlocks, never a sign-in one", () => {
    // BEHAVIOR CHANGE (ISS-7866): signed out, this card asks to connect GitHub —
    // the same words the dashboard, Branches and the Insights grid use. It used
    // to run its own sign-in affordance, which is how one user at one moment met
    // two verbs for one wall. Authorizing GitHub is genuinely what the click
    // does; creating the session is how that authorization gets stored.
    const onConnect = vi.fn();
    const { container } = renderStrip({
      authenticated: false,
      githubConnected: false,
      githubConnect: handlerTarget(onConnect),
    });
    const card = prsShippedCard(container);

    // The load-bearing assertion is still the CONTAINMENT: FEA-4037 rendered
    // this ask as a sibling above the row, where a page-wide `getByRole` would
    // have found it just the same. Scoping to the card distinguishes the two
    // layouts.
    const control = within(card).getByRole("button", {
      name: CONNECT_GITHUB_RE,
    });
    expect(card.contains(control)).toBe(true);
    // The retired verb is absent page-wide, not merely off this card: a hoisted
    // sign-in banner is exactly what would satisfy a card-scoped absence.
    expect(screen.queryByRole("button", { name: SIGN_IN_RE })).toBeNull();

    fireEvent.click(control);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("asks even when the connection read never landed, because signed out is not unknown", () => {
    // The counterpart to the UNKNOWN case above, and the ISS-7866 decision in
    // one assertion: signed IN, an unlanded read must not prompt; signed OUT,
    // there is no grant and no installation to read and the status fetch returns
    // null forever, so the absence is a FACT. Reading `undefined` as "say
    // nothing" here is what left this strip showing a bare dash while the
    // dashboard prompted on the very same state.
    const { container } = renderStrip({
      authenticated: false,
      githubConnected: undefined,
      githubConnect: handlerTarget(vi.fn()),
    });
    const card = within(prsShippedCard(container));

    expect(
      card.getByRole("button", { name: CONNECT_GITHUB_RE })
    ).toBeInTheDocument();
    // And the value is withdrawn beneath it — the signed-out gate outranks any
    // value in hand, so the ask is never bought with a number we cannot vouch
    // for, nor captioned with a scope claim about data we cannot see.
    expect(card.getByText("No data")).toBeInTheDocument();
    expect(card.queryByText(SIGNED_IN_EMPTY_CAPTION)).toBeNull();
  });
});
