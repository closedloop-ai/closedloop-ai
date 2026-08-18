import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { LOC_PER_DOLLAR_MERGED_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  SESSIONS_COST_METRIC_CARD_INFO,
  SESSIONS_COST_METRIC_CARD_LABEL,
} from "../cost-metric-card";
import {
  SESSIONS_SIGN_IN_BANNER_EXPLANATION,
  SESSIONS_SIGN_IN_EXPLANATION,
} from "../sessions-sign-in-indicator";
import { SessionsSummaryCards } from "../sessions-summary-cards";

// FEA-4231: the Cost detail line names the API-equivalent cost of subscription-
// covered usage — what it would have cost if metered ("+$X if billed to API") —
// not a real seat fee and not the larger inclusive total. No space after the
// plus — an additive figure, not a period-over-period change chip.
const COST_DETAIL_PATTERN = /\+\$\d[\d,]* if billed to API/;
const SIGN_IN_EXPLANATION = SESSIONS_SIGN_IN_EXPLANATION;
const SIGN_IN_BANNER_EXPLANATION = SESSIONS_SIGN_IN_BANNER_EXPLANATION;

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
    byUser: [],
    byModel: [],
    byHarness: [],
    byRepository: [],
    lastSyncTargets: [],
    ...overrides,
  };
}

/** The three cloud-only delivery cards with a full set of merged-PR metrics. */
function cloudDeliveryFixture(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return usageFixture({
    mergedPrCount: 7,
    medianPrSize: 2000,
    mergedLocPerDollar: 3.5,
    ...overrides,
  });
}

describe("SessionsSummaryCards (FEA-4126 — 5-card row, no Median PR Size)", () => {
  it("renders exactly the five cards in order — Median PR Size is NOT on the Sessions bar", () => {
    const { container } = render(
      <SessionsSummaryCards isLoading={false} usage={cloudDeliveryFixture()} />
    );

    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("Total Tokens")).toBeInTheDocument();
    // ISS-4401: the Sessions Cost card carries the per-surface label
    // ("cost"), distinguishing its not-subscription-covered
    // figure from the Dashboard's subscription-inclusive "Cost" total.
    expect(
      screen.getByText(SESSIONS_COST_METRIC_CARD_LABEL)
    ).toBeInTheDocument();
    expect(screen.getByText("PRs Shipped")).toBeInTheDocument();
    // ISS-4866 / ISS-5366: the merged-scope label, now unconditional. Read from
    // the canonical constant rather than re-declared here, so the card and this
    // assertion cannot drift (AGENTS.md: fallback display reads the canonical
    // map). It names the population the card actually computes — merged PRs
    // only — so the bare unit stops reading as "the efficiency of everything on
    // this row" beside the whole-cohort tiles.
    expect(screen.getByText(LOC_PER_DOLLAR_MERGED_LABEL)).toBeInTheDocument();
    // FEA-4126 regression guard: Median PR Size was removed from the Sessions bar
    // (FEA-3937 layout, reversing FEA-3574's re-add) and lives only on Branches.
    // This has regressed once — if the label returns to the Sessions bar, fail.
    expect(screen.queryByText(MEDIAN_PR_SIZE_LABEL)).toBeNull();
    // Exactly five metric cards render (one `data-slot="card"` root each), so no
    // orphaned sixth card can slip back in unnoticed.
    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(
      SESSIONS_CARD_COUNT
    );
  });

  it("shows the summed input+output tokens abbreviated on the Total Tokens card", () => {
    render(
      <SessionsSummaryCards
        isLoading={false}
        usage={usageFixture({
          totalInputTokens: 1_200_000,
          totalOutputTokens: 340_000,
        })}
      />
    );

    // 1,200,000 + 340,000 = 1,540,000, abbreviated with `formatTokenCount`
    // ("1.54M") so the token headline reads the same as every other token
    // display in the product, not raw `.toLocaleString()` grouping.
    expect(screen.getByText("1.54M")).toBeInTheDocument();
    expect(screen.queryByText((1_540_000).toLocaleString())).toBeNull();
  });

  it("Cost headline is metered apiEstimatedCost; the detail adds the subscription share, never the larger inclusive total (FEA-4231)", () => {
    render(
      <SessionsSummaryCards
        isLoading={false}
        usage={usageFixture({
          totalEstimatedCost: 100,
          apiEstimatedCost: 30,
          subscriptionEstimatedCost: 70,
        })}
      />
    );

    // Headline is the metered, out-of-pocket spend.
    expect(screen.getByText("$30")).toBeInTheDocument();
    // The larger inclusive total is NEVER shown — that was the confusing figure
    // that read as contradicting the "$30" headline (FEA-4231).
    expect(screen.queryByText("$100")).toBeNull();
    // The detail line names the canonical `subscriptionEstimatedCost` (70) as the
    // API-equivalent cost of the covered usage, reading as a composed figure, not
    // a rival total or a charged seat fee.
    expect(screen.getByText(COST_DETAIL_PATTERN)).toHaveTextContent(
      "+$70 if billed to API"
    );
  });

  it("ISS-4481: drops the Cost tile to honest-empty (—) when the Unknown cost facet is active", () => {
    // When the active Cost selection is Unknown, every listed row renders "—", so
    // the facet-scoped apiEstimatedCost sums an all-unknown cohort to a finite 0.
    // The tile must NOT render that as a fabricated "$0" next to a column of
    // dashes — it drops to its honest-empty "—" and hides the "+$X" detail (stage
    // review, same fabricated-zero ISS-4418 fixed in the cell).
    render(
      <SessionsSummaryCards
        costUnknownActive
        isLoading={false}
        usage={usageFixture({
          totalEstimatedCost: 0,
          apiEstimatedCost: 0,
          subscriptionEstimatedCost: 70,
        })}
      />
    );

    // The Cost tile shows the honest-empty sentinel, never "$0". ISS-4401: the
    // Sessions Cost card carries the per-surface "cost" label.
    expect(
      screen.getByText(SESSIONS_COST_METRIC_CARD_LABEL)
    ).toBeInTheDocument();
    expect(screen.queryByText("$0")).toBeNull();
    // The "+$X if billed to API" detail is suppressed (no value to qualify).
    expect(screen.queryByText(COST_DETAIL_PATTERN)).toBeNull();
  });

  it("ISS-4481: keeps the Cost headline when the Unknown facet is NOT active (default)", () => {
    // The opposite branch: with costUnknownActive false (default), the tile still
    // renders the metered spend — proving the honest-empty is gated on the facet,
    // not always applied.
    render(
      <SessionsSummaryCards
        isLoading={false}
        usage={usageFixture({
          totalEstimatedCost: 30,
          apiEstimatedCost: 30,
          subscriptionEstimatedCost: 0,
        })}
      />
    );
    expect(screen.getByText("$30")).toBeInTheDocument();
  });

  it("opens the About cost popover and shows the visible what/how tooltip copy (FEA-3434)", async () => {
    // wongk: assert the tooltip the user actually reads. Drive the info control
    // through the real composite and open it, so the test fails if the card ever
    // stops rendering `SESSIONS_COST_METRIC_CARD_INFO` — a copy-only assertion on
    // the exported constant would pass even if the card dropped the popover.
    const user = userEvent.setup();
    render(
      <SessionsSummaryCards
        isLoading={false}
        usage={usageFixture({
          totalEstimatedCost: 100,
          apiEstimatedCost: 30,
          subscriptionEstimatedCost: 70,
        })}
      />
    );

    // ISS-4401: the info control's accessible name follows the per-surface
    // label, so on Sessions it reads "About cost".
    await user.click(
      screen.getByRole("button", {
        name: `About ${SESSIONS_COST_METRIC_CARD_LABEL}`,
      })
    );

    const popover = await screen.findByRole("dialog", {
      name: `About ${SESSIONS_COST_METRIC_CARD_LABEL}`,
    });
    expect(popover).toHaveTextContent(SESSIONS_COST_METRIC_CARD_INFO.what);
    expect(popover).toHaveTextContent(SESSIONS_COST_METRIC_CARD_INFO.how);
  });

  it("dashes every card value on error WITHOUT the Sample badge or a sign-in CTA", () => {
    render(
      // An error is authenticated-agnostic: even signed out, a load failure must
      // NOT read as the signed-out state, so no CTA renders.
      <SessionsSummaryCards
        authenticated={false}
        isError
        isLoading={false}
        onSignIn={vi.fn()}
        usage={undefined}
      />
    );

    // Labels still render; values are the honest "—" sentinel across all five
    // cards (including the Cost card, routed through CostMetricCard).
    expect(screen.getByText("Total Tokens")).toBeInTheDocument();
    expect(screen.getByText("PRs Shipped")).toBeInTheDocument();
    // FEA-4126: Median PR Size is not on the Sessions bar even in the error state.
    expect(screen.queryByText(MEDIAN_PR_SIZE_LABEL)).toBeNull();
    expect(screen.getAllByText("—")).toHaveLength(5);
    // A load failure is NOT placeholder/"Sample" data — that badge means demo
    // data pending real wiring, which would mislabel an errored bar as seed data.
    expect(screen.queryByText("Sample")).toBeNull();
    // The Cost detail line ("+$X if billed to API") drops on error rather than
    // captioning a dash with a misleading "+$0 if billed to API".
    expect(screen.queryByText(COST_DETAIL_PATTERN)).toBeNull();
    // An error never routes a delivery card to the signed-out CTA, and never
    // hoists the single sign-in prompt either (FEA-4037) — a failed read is not
    // the signed-out state.
    expect(screen.queryByText(SIGN_IN_EXPLANATION)).toBeNull();
    expect(screen.queryByText(SIGN_IN_BANNER_EXPLANATION)).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("drops the Cost detail line when there is no total to caption", () => {
    // The desktop local producer can surface an absent total (typed `number`
    // on the wire, but nullable at runtime for the local SQLite source).
    render(
      <SessionsSummaryCards
        isLoading={false}
        usage={usageFixture({
          totalEstimatedCost: null as unknown as number,
        })}
      />
    );

    expect(screen.queryByText(COST_DETAIL_PATTERN)).toBeNull();
  });

  it("opts the web strip into the wrapBelow two-column grid", () => {
    const { container } = render(
      <SessionsSummaryCards
        isLoading={false}
        usage={usageFixture()}
        wrapBelow
      />
    );

    // wrapBelow swaps the non-wrapping flex row for the responsive grid so the
    // strip wraps with the table beneath it below `md` (FEA-3865).
    expect(container.querySelector(".grid.grid-cols-2")).not.toBeNull();
  });

  describe("always-available cards (state 1)", () => {
    it("show real values regardless of sign-in — signed out shows Sessions/Cost/Total Tokens, never a CTA", () => {
      // The local SQLite producer omits every delivery metric (undefined) and the
      // surface is signed out. Sessions / Total Tokens / Cost still compute from
      // local data and NEVER show a sign-in CTA.
      render(
        <SessionsSummaryCards
          authenticated={false}
          isLoading={false}
          onSignIn={vi.fn()}
          usage={usageFixture({
            totalSessions: 9,
            totalInputTokens: 500,
            totalOutputTokens: 500,
            apiEstimatedCost: 15,
          })}
        />
      );

      expect(screen.getByText("9")).toBeInTheDocument();
      // 500 + 500 = 1,000 tokens, abbreviated by `formatTokenCount` → "1.00k".
      expect(screen.getByText("1.00k")).toBeInTheDocument();
      expect(screen.getByText("$15")).toBeInTheDocument();
    });
  });

  describe("always-available loading (FEA-4128, corrected by ISS-4429 — the skeleton is scoped to the cloud-FAILURE fallback path)", () => {
    it("shows the CLOUD values immediately (NO skeleton) while a local import runs, when the cloud read is healthy (ISS-4429)", () => {
      // ISS-4429 corrects FEA-4128's premise: when the cloud read is HEALTHY (it
      // has the table's population), a background local import must NOT skeleton
      // over the already-known cloud values. Previously the cards read local and
      // skeletoned the still-importing zero; now they read the CLOUD population
      // directly, so there is no zero to hide and nothing to skeleton — the cards
      // reconcile with the table instantly.
      const { container } = render(
        <SessionsSummaryCards
          alwaysAvailableLoading
          authenticated
          isLoading={false}
          localUsage={undefined}
          usage={cloudDeliveryFixture({
            totalSessions: 42,
            totalInputTokens: 1000,
            totalOutputTokens: 1000,
            apiEstimatedCost: 20,
          })}
        />
      );

      // The always-available cards show the real CLOUD totals — no skeleton, no
      // "Importing your history" caption over a populated cloud read.
      expect(screen.getByText("42")).toBeInTheDocument();
      expect(screen.getByText("2.00k")).toBeInTheDocument();
      expect(screen.getByText("$20")).toBeInTheDocument();
      expect(screen.queryByText("Importing your history")).toBeNull();
      expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
      // ...and the cloud delivery cards keep rendering their real values.
      expect(screen.getByText("PRs Shipped")).toBeInTheDocument();
      expect(screen.getByText("7")).toBeInTheDocument();
    });

    it("keeps Sessions/Tokens/Cost frames and skeletons only the value (no `0`) while the local FALLBACK hydrates AND the cloud read FAILED", () => {
      // The FEA-4128 skeleton now lives on the fallback path: the cloud read has
      // FAILED (errored, no cloud totals) and the local fallback source is still
      // pending (localUsage undefined), so there is genuinely nothing to show yet
      // — skeleton the value slots rather than fabricate a `0`. No import is in
      // flight here (`importInProgress` omitted), so the wait caption is the plain
      // "Loading…", NOT the import-specific line (ISS-4429 design-bot review).
      const { container } = render(
        <SessionsSummaryCards
          alwaysAvailableLoading
          authenticated
          isError
          isLoading={false}
          localUsage={undefined}
          usage={undefined}
        />
      );

      // The card frames stay intact — labels and the wait caption remain visible —
      // and only each value slot is skeletoned. No fabricated `0`/`$0`.
      expect(screen.getByText("Sessions")).toBeInTheDocument();
      expect(screen.getByText("Total Tokens")).toBeInTheDocument();
      expect(
        screen.getByText(SESSIONS_COST_METRIC_CARD_LABEL)
      ).toBeInTheDocument();
      expect(screen.queryByText("0")).toBeNull();
      expect(screen.queryByText("$0")).toBeNull();
      // Plain pending fallback → neutral "Loading…", not an import claim.
      expect(screen.getAllByText("Loading…")).toHaveLength(
        ALWAYS_AVAILABLE_CARD_COUNT
      );
      expect(screen.queryByText("Importing your history")).toBeNull();
      expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(
        ALWAYS_AVAILABLE_CARD_COUNT
      );
    });

    it("captions the skeleton 'Importing your history' ONLY when a genuine import is in flight (ISS-4429 design-bot)", () => {
      // Same cloud-failure fallback skeleton, but now a first-launch import IS
      // running (`importInProgress`), so the honest caption is the import line —
      // distinct from the plain pending-read "Loading…" above.
      render(
        <SessionsSummaryCards
          alwaysAvailableLoading
          authenticated
          importInProgress
          isError
          isLoading={false}
          localUsage={undefined}
          usage={undefined}
        />
      );

      expect(screen.getAllByText("Importing your history")).toHaveLength(
        ALWAYS_AVAILABLE_CARD_COUNT
      );
      expect(screen.queryByText("Loading…")).toBeNull();
    });

    it("captions the settled fallback cards with the source, not the filter claim (ISS-4429 design-bot)", () => {
      // Cloud read FAILED, local fallback SETTLED with totals: the three cards show
      // local numbers that can disagree with the cloud rows, so the caption names
      // the source ("From local history") instead of "matched by the current
      // filters" — a number that disagrees with the rows reads as deliberate.
      render(
        <SessionsSummaryCards
          authenticated
          isError
          isLoading={false}
          localUsage={usageFixture({
            totalSessions: 12,
            totalInputTokens: 100,
            totalOutputTokens: 20,
            apiEstimatedCost: 3,
          })}
          usage={undefined}
        />
      );

      expect(screen.getByText("12")).toBeInTheDocument();
      expect(screen.getAllByText("From local history")).toHaveLength(
        ALWAYS_AVAILABLE_CARD_COUNT
      );
      expect(screen.queryByText("matched by the current filters")).toBeNull();
    });

    it("shows a genuine `0` once the local FALLBACK has loaded a confirmed-empty dataset (cloud read failed)", () => {
      // On the fallback path (cloud failed), the fix must NOT hide a real zero:
      // with the local fallback read hydrated (localUsage present) and loading
      // cleared, a confirmed-empty local dataset renders the honest `0`.
      const { container } = render(
        <SessionsSummaryCards
          alwaysAvailableLoading={false}
          authenticated
          isError
          isLoading={false}
          localUsage={usageFixture({
            totalSessions: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            apiEstimatedCost: 0,
          })}
          usage={undefined}
        />
      );

      // Real fallback values render — the Sessions card shows the confirmed `0`,
      // not a skeleton. `$0` is the Cost card's honest empty.
      expect(screen.getByText("Sessions")).toBeInTheDocument();
      expect(
        screen.getByText(SESSIONS_COST_METRIC_CARD_LABEL)
      ).toBeInTheDocument();
      expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("$0")).toBeInTheDocument();
      expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
    });

    it("dashes (does not skeleton) the always-available cards when the local FALLBACK read failed and the cloud read also failed", () => {
      // On the fallback path, a local read error outranks loading: a terminal local
      // read failure dashes to `—` rather than spinning a skeleton forever.
      render(
        <SessionsSummaryCards
          alwaysAvailableLoading
          authenticated
          isError
          isLoading={false}
          isLocalError
          localUsage={undefined}
          usage={undefined}
        />
      );

      expect(screen.getByText("Sessions")).toBeInTheDocument();
      // Sessions + Total Tokens dash (Cost dashes via its own `—`).
      expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    });

    it("does NOT skeleton the always-available cards while a local import runs but the cloud read errored WITH last-good cloud totals in hand — the error dashes them (preserved single-source contract)", () => {
      // ISS-4429: `isError` with a populated `usage` (a refetch failure that kept
      // the last-good cloud summary) is NOT the cloud-FAILURE FALLBACK path — the
      // cloud read is still the active source (it has totals in hand), so the local
      // fallback and its FEA-4128 skeleton do NOT engage behind a background local
      // import. The always-available cards follow the SAME single-source error
      // contract the web page uses (an active-source error dashes the value), so
      // they dash here rather than skeleton — never spinning behind a stale error.
      const { container } = render(
        <SessionsSummaryCards
          alwaysAvailableLoading
          authenticated
          isError
          isLoading={false}
          localUsage={undefined}
          usage={cloudDeliveryFixture({ totalSessions: 42 })}
        />
      );

      // No fallback skeleton and no "Importing your history" caption — the cloud
      // read is active (not on the fallback path), so it dashes on its own error.
      expect(screen.queryByText("Importing your history")).toBeNull();
      expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
      // Sessions + Total Tokens dash (Cost dashes via its own `—`).
      expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    });

    it("marks the summary row aria-busy while the always-available FALLBACK cards are loading (cloud failed)", () => {
      // wongk review: an accessible loading status on the region, not just
      // skeleton nodes, so assistive tech announces the cards are updating. ISS-4429
      // scopes it to the fallback path — the same gate the child skeleton uses.
      const { container } = render(
        <SessionsSummaryCards
          alwaysAvailableLoading
          authenticated
          isError
          isLoading={false}
          localUsage={undefined}
          usage={undefined}
        />
      );

      expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    });

    it("does NOT mark the row aria-busy when the cloud read is healthy, even while a local import runs (ISS-4429)", () => {
      // The parent aria-busy gate must track the child skeleton exactly: a healthy
      // cloud read shows real values and is not busy, regardless of a background
      // local import.
      const { container } = render(
        <SessionsSummaryCards
          alwaysAvailableLoading
          authenticated
          isLoading={false}
          localUsage={undefined}
          usage={cloudDeliveryFixture({ totalSessions: 42 })}
        />
      );

      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });

    it("clears aria-busy once the always-available cards have loaded", () => {
      const { container } = render(
        <SessionsSummaryCards
          alwaysAvailableLoading={false}
          authenticated
          isLoading={false}
          localUsage={usageFixture({ totalSessions: 3 })}
          usage={cloudDeliveryFixture()}
        />
      );

      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
  });

  describe("cloud-mode source topology — always-available cards aggregate the CLOUD population the table shows (ISS-4429)", () => {
    it("feeds Sessions/Tokens/Cost from the CLOUD usage even when local SQLite totals differ — the cards reconcile with the visible table, not with local", () => {
      // ISS-4429: the reported steady-state bug. In Cloud mode the table (and the
      // delivery `usage`) aggregate the CLOUD population; local SQLite may lack
      // those cloud sessions (not imported / different machine / cloud-only data)
      // so its totals are a DIFFERENT, smaller population. The always-available
      // cards must reflect the CLOUD population so they reconcile with the rows the
      // user sees — never local's divergent (here `0`) totals beside a full table.
      render(
        <SessionsSummaryCards
          authenticated
          isLoading={false}
          // Local SQLite has the classic bug shape: zero sessions/tokens/cost while
          // the cloud table below is full. This must NOT drive the cards to `0`.
          localUsage={usageFixture({
            totalSessions: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            apiEstimatedCost: 0,
          })}
          usage={cloudDeliveryFixture({
            totalSessions: 42,
            totalInputTokens: 1000,
            totalOutputTokens: 1000,
            apiEstimatedCost: 20,
          })}
        />
      );

      // Always-available cards show the CLOUD totals (the table's population)...
      expect(screen.getByText("42")).toBeInTheDocument();
      expect(screen.getByText("2.00k")).toBeInTheDocument();
      expect(screen.getByText("$20")).toBeInTheDocument();
      // ...and never local's divergent `0` — no `0`/`$0` leaks from local SQLite.
      expect(screen.queryByText("0")).toBeNull();
      expect(screen.queryByText("$0")).toBeNull();
      // ...and the delivery cards still show the cloud values.
      expect(screen.getByText("7")).toBeInTheDocument();
    });

    it("falls back to the LOCAL totals only when the CLOUD delivery read FAILED (FEA-3574 intent preserved)", () => {
      // FEA-3574's original concern still holds: when the cloud delivery read has
      // FAILED outright (errored, no cloud totals in hand), a metric SQLite can
      // still compute must not blank. `isError` true + `usage` undefined + local
      // totals present → the cards render the LOCAL values as the failure fallback.
      render(
        <SessionsSummaryCards
          authenticated
          isError
          isLoading={false}
          localUsage={usageFixture({
            totalSessions: 42,
            totalInputTokens: 1000,
            totalOutputTokens: 1000,
            apiEstimatedCost: 20,
          })}
          usage={undefined}
        />
      );

      // Local-backed fallback cards render real values (cloud read failed).
      expect(screen.getByText("42")).toBeInTheDocument();
      expect(screen.getByText("2.00k")).toBeInTheDocument();
      expect(screen.getByText("$20")).toBeInTheDocument();
      // The two cloud-only delivery cards dash (their read failed) — "Unavailable"
      // (FEA-4126: PRs Shipped + LOC/$; Median PR Size is gone).
      expect(screen.getAllByText("—")).toHaveLength(2);
      expect(screen.getAllByText("Unavailable")).toHaveLength(2);
    });

    it("ignores a LOCAL read failure while the CLOUD read is healthy — the cards show the cloud population, not a dash", () => {
      // ISS-4429: a local SQLite read failure is irrelevant when the cloud read
      // (the table's source) is healthy. The local fallback engages ONLY on the
      // cloud-failure path, so `isLocalError` must NOT dash cards that can read the
      // cloud population the table shows.
      render(
        <SessionsSummaryCards
          authenticated
          isLoading={false}
          isLocalError
          localUsage={undefined}
          usage={cloudDeliveryFixture({
            totalSessions: 42,
            totalInputTokens: 1000,
            totalOutputTokens: 1000,
            apiEstimatedCost: 20,
          })}
        />
      );

      // The always-available cards read the healthy CLOUD totals; no dash leaks
      // from the local read failure.
      expect(screen.getByText("42")).toBeInTheDocument();
      expect(screen.getByText("2.00k")).toBeInTheDocument();
      expect(screen.getByText("$20")).toBeInTheDocument();
      // Delivery cards still real; no always-available card dashes.
      expect(screen.getByText("7")).toBeInTheDocument();
      expect(screen.queryByText("—")).toBeNull();
    });
  });

  describe("cloud-only delivery cards — error vs empty (4j)", () => {
    it("dims + captions a FAILED delivery read as Unavailable, distinct from an honest empty", () => {
      // FEA-3574 review: `isError` on a delivery card reads as "couldn't load"
      // (dimmed + "Unavailable"), NOT as a real "no PRs merged in range" empty and
      // NOT as the "Sample" demo badge.
      render(
        <SessionsSummaryCards
          authenticated
          isError
          isLoading={false}
          usage={undefined}
        />
      );

      // Two delivery cards caption "Unavailable" (FEA-4126: PRs Shipped + LOC
      // (Merged)/$); no "Sample" badge, no CTA.
      expect(screen.getAllByText("Unavailable")).toHaveLength(2);
      expect(screen.queryByText("Sample")).toBeNull();
      expect(screen.queryByText(SIGN_IN_EXPLANATION)).toBeNull();
    });
  });

  describe("cloud-only delivery cards — signed out (state 2)", () => {
    it("hoists ONE sign-in prompt above the row, dashes the cards, and fires the handler (FEA-4037)", () => {
      const onSignIn = vi.fn();
      render(
        <SessionsSummaryCards
          authenticated={false}
          isLoading={false}
          onSignIn={onSignIn}
          // Local producer omits merged-PR metrics; signed out → state 2.
          usage={usageFixture({ totalSessions: 9 })}
        />
      );

      // FEA-4037: ONE ask per surface — a single banner above the row, NOT the
      // same sentence + button repeated on the delivery cards.
      expect(screen.getByText(SIGN_IN_BANNER_EXPLANATION)).toBeInTheDocument();
      expect(screen.queryByText(SIGN_IN_EXPLANATION)).toBeNull();
      const signInButtons = screen.getAllByRole("button", {
        name: "Sign in",
      });
      expect(signInButtons).toHaveLength(1);

      // The two delivery cards fall to their neutral dash beneath the prompt
      // (FEA-4126: Median PR Size removed).
      expect(screen.getAllByText("—")).toHaveLength(2);

      fireEvent.click(signInButtons[0]);
      expect(onSignIn).toHaveBeenCalledTimes(1);
    });

    it("dashes the delivery cards even when signed out with POPULATED usage (wongk) — the signed-out gate wins over hasValue", () => {
      // The core wongk bug: `showSignInPrompt` did not look at the delivery
      // values, while the card gave `hasValue` first priority — so a signed-out
      // surface still holding a populated `usage` (a stale/local read carrying
      // merged-PR numbers) rendered the REAL delivery values above a "sign in"
      // banner, breaking the neutral-dash promise of state 2. The signed-out gate
      // must win: every delivery card dashes, and their real values never render.
      render(
        <SessionsSummaryCards
          authenticated={false}
          isLoading={false}
          onSignIn={vi.fn()}
          usage={cloudDeliveryFixture()}
        />
      );

      // The ONE hoisted banner is up...
      expect(screen.getByText(SIGN_IN_BANNER_EXPLANATION)).toBeInTheDocument();
      // ...and the two delivery cards dash despite populated usage — no real
      // value (7 / "3.50") and no scope caption leaks through (FEA-4126: Median
      // PR Size removed, so its value/caption must never render here either).
      expect(screen.getAllByText("—")).toHaveLength(2);
      expect(screen.queryByText("7")).toBeNull();
      expect(screen.queryByText("3.50")).toBeNull();
      // The signed-out dash carries NO "merged in range" scope claim (line 212
      // review) — a caption about data we can't see is a lie about state. Median
      // PR Size's old scope caption must not appear at all now.
      expect(screen.queryByText("2 KLOC")).toBeNull();
      expect(screen.queryByText("merged in range")).toBeNull();
      expect(screen.queryByText("per merged PR in these sessions")).toBeNull();
      expect(screen.queryByText("merged lines per dollar")).toBeNull();
    });

    it("suppresses the hoisted banner when the shell owns the ask (RefreshFailed) but still dashes the cards (P2)", () => {
      // FEA-4037 P2: on RefreshFailed the desktop's app-level
      // DesktopSessionExpiredBanner already owns the sign-in ask globally, so the
      // Sessions bar must NOT stack a second banner. With signInPromptSuppressed,
      // no hoisted banner renders and the delivery cards still fall to the neutral
      // dash — the honesty decision is independent of the banner-hoist decision.
      render(
        <SessionsSummaryCards
          authenticated={false}
          isLoading={false}
          onSignIn={vi.fn()}
          signInPromptSuppressed
          usage={cloudDeliveryFixture()}
        />
      );

      // No hoisted banner (the shell owns it) and no per-card copy either.
      expect(screen.queryByText(SIGN_IN_BANNER_EXPLANATION)).toBeNull();
      expect(screen.queryByText(SIGN_IN_EXPLANATION)).toBeNull();
      expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
      // ...but the two delivery cards still dash (signed-out honesty stands).
      expect(screen.getAllByText("—")).toHaveLength(2);
      expect(screen.queryByText("7")).toBeNull();
    });

    it("surfaces a retryable sign-in error once on the banner, not per card", () => {
      render(
        <SessionsSummaryCards
          authenticated={false}
          isLoading={false}
          onSignIn={vi.fn()}
          signInError="Couldn't open your browser. Try again."
          usage={usageFixture({ totalSessions: 9 })}
        />
      );

      // The retryable failure copy renders ONCE (on the banner), and the CTA
      // stands as the retry — not one error line per delivery card.
      expect(
        screen.getAllByText("Couldn't open your browser. Try again.")
      ).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(
        1
      );
    });

    it("degrades to per-card informational copy when signed out with NO handler (no ask to hoist)", () => {
      // With no live sign-in action there is nothing to hoist into a single
      // prompt, so the cards keep their informational per-card copy and no button.
      render(
        <SessionsSummaryCards
          authenticated={false}
          isLoading={false}
          usage={usageFixture({ totalSessions: 9 })}
        />
      );

      expect(screen.queryByText(SIGN_IN_BANNER_EXPLANATION)).toBeNull();
      // FEA-4126: two delivery cards keep the informational per-card copy.
      expect(screen.getAllByText(SIGN_IN_EXPLANATION)).toHaveLength(2);
      expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    });
  });

  describe("cloud-only delivery cards — signed in, no data (state 3)", () => {
    it("render a neutral empty with NO CTA when authenticated but the metric is absent (offline / out of range / GitHub not connected)", () => {
      render(
        // Authenticated but the local (or offline) producer omits merged-PR
        // metrics: neutral empty, never the signed-out CTA — signing in wouldn't
        // help (FEA-3159 keeps the GitHub-not-connected case here too).
        <SessionsSummaryCards
          authenticated
          isLoading={false}
          onSignIn={vi.fn()}
          usage={usageFixture({ totalSessions: 9 })}
        />
      );

      // Two delivery cards dash their value (FEA-4126: PRs Shipped + LOC/$)...
      expect(screen.getAllByText("—")).toHaveLength(2);
      // ...but state 3 is visually distinct from state 2: no CTA, no "Sample".
      expect(screen.queryByText(SIGN_IN_EXPLANATION)).toBeNull();
      expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
      expect(screen.queryByText("Sample")).toBeNull();
    });

    it("dashes PRs Shipped (no fake 0) on the REAL cloud shape: mergedPrCount is null when no merged PRs match", () => {
      // Data-honesty regression (FEA-3574 review, wongk): the cloud producer now
      // emits `mergedPrCount: null` (NOT `0`) when the matched set has no merged
      // PRs, so an out-of-range / offline authenticated read renders the same
      // neutral no-data dash as its sibling delivery cards instead of a real "0"
      // that would read like "merged zero PRs". Fixture uses the ACTUAL present
      // field (null), not an omitted one, so the emitted route shape is covered.
      render(
        <SessionsSummaryCards
          authenticated
          isLoading={false}
          usage={usageFixture({
            // Non-zero always-available totals so a stray "0" can only come from
            // a delivery card, isolating the regression under test.
            totalSessions: 9,
            totalInputTokens: 500,
            totalOutputTokens: 500,
            mergedPrCount: null,
            medianPrSize: null,
            mergedLocPerDollar: null,
          })}
        />
      );

      // PRs Shipped renders a dash, NOT a fabricated "0" — both delivery cards
      // dash together on the absent (null) cloud shape (FEA-4126: two cards).
      expect(screen.queryByText("0")).toBeNull();
      expect(screen.getAllByText("—")).toHaveLength(2);
      expect(screen.queryByText(SIGN_IN_EXPLANATION)).toBeNull();
    });
  });

  describe("cloud-only delivery cards — available", () => {
    it("show real values when the cloud producer supplies them (authenticated)", () => {
      render(
        <SessionsSummaryCards
          authenticated
          isLoading={false}
          usage={cloudDeliveryFixture()}
        />
      );

      // 7 merged PRs; 3.5 LOC/$ → "3.50" via `formatLocPerDollar` (<10 →
      // two decimals). FEA-4126: Median PR Size (the `medianPrSize` → "2 KLOC"
      // value the fixture still carries) is no longer rendered on this bar.
      expect(screen.getByText("7")).toBeInTheDocument();
      expect(screen.getByText("3.50")).toBeInTheDocument();
      expect(screen.queryByText("2 KLOC")).toBeNull();
      // No dashes, no CTA — every delivery card resolved to a real value.
      expect(screen.queryByText("—")).toBeNull();
      expect(screen.queryByText(SIGN_IN_EXPLANATION)).toBeNull();
    });

    it("mixes available and neutral-empty per card (partial cloud data)", () => {
      render(
        <SessionsSummaryCards
          authenticated
          isLoading={false}
          usage={usageFixture({
            mergedPrCount: 4,
            // No merged lines in range → null (not undefined): still state 3, no CTA.
            medianPrSize: null,
            mergedLocPerDollar: null,
          })}
        />
      );

      expect(screen.getByText("4")).toBeInTheDocument();
      // FEA-4126: only LOC/$ dashes now — Median PR Size was removed
      // from this bar, so PRs Shipped (real) + one dash is the full delivery set.
      expect(screen.getAllByText("—")).toHaveLength(1);
      expect(screen.queryByText(SIGN_IN_EXPLANATION)).toBeNull();
    });
  });

  it("defaults authenticated=true so the web route (always signed in) never shows the CTA", () => {
    render(
      // No `authenticated` prop → the web Sessions page's implicit signed-in
      // stance. The local-style fixture (delivery metrics absent) lands the
      // cloud cards in neutral-empty, not the signed-out CTA.
      <SessionsSummaryCards
        isLoading={false}
        usage={usageFixture({ totalSessions: 9 })}
      />
    );

    // FEA-4126: two delivery cards (PRs Shipped + LOC/$) dash.
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText(SIGN_IN_EXPLANATION)).toBeNull();
  });
});

describe("SessionsSummaryCards (ISS-4444 — honest 'couldn't be read' caveat on the Sessions card)", () => {
  it("renders no caveat when nothing was quarantined", () => {
    render(
      <SessionsSummaryCards isLoading={false} usage={cloudDeliveryFixture()} />
    );
    expect(screen.queryByText(COULD_NOT_IMPORT_ONE_PATTERN)).toBeNull();
    expect(screen.queryByText(COULD_NOT_IMPORT_MANY_PATTERN)).toBeNull();
  });

  it("surfaces the caveat in-place on the Sessions card detail when files were quarantined", () => {
    // The caveat rides the Sessions card's own detail slot (design review: it
    // travels WITH the count it qualifies, not as a detached line) AND the cards
    // still render their real values (the import completed with the poison files
    // skipped — the UI is honest, not blank).
    render(
      <SessionsSummaryCards
        couldNotImportLabel="3 transcripts couldn't be read"
        isLoading={false}
        usage={cloudDeliveryFixture()}
      />
    );
    expect(screen.getByText(COULD_NOT_IMPORT_MANY_PATTERN)).toBeInTheDocument();
    expect(screen.getByText("PRs Shipped")).toBeInTheDocument();
    // The scope caption it replaces is gone while the caveat is shown.
    expect(screen.queryByText("matched by the current filters")).toBeNull();
  });

  it("renders the caller's phrase verbatim rather than assembling its own", () => {
    render(
      <SessionsSummaryCards
        couldNotImportLabel="1 transcript couldn't be read"
        isLoading={false}
        usage={cloudDeliveryFixture()}
      />
    );
    expect(screen.getByText(COULD_NOT_IMPORT_ONE_PATTERN)).toBeInTheDocument();
  });

  it("resolves the 'Importing your history' state — the caveat shows once the import completes, cards no longer skeleton", () => {
    // A completed import with quarantined files: alwaysAvailableLoading is FALSE
    // (the skeleton cleared) and the honest caveat is shown instead of a stuck spin.
    render(
      <SessionsSummaryCards
        alwaysAvailableLoading={false}
        couldNotImportLabel="2 transcripts couldn't be read"
        importInProgress={false}
        isLoading={false}
        usage={cloudDeliveryFixture()}
      />
    );
    expect(screen.queryByText(IMPORTING_HISTORY_PATTERN)).toBeNull();
    expect(screen.getByText(COULD_NOT_IMPORT_MANY_PATTERN)).toBeInTheDocument();
  });
});

// ISS-4444: the honest "couldn't import" note copy and the import-in-progress
// caption that must be GONE once the import settles. ISS-6115 (wongk review):
// the singular/plural and stage-verb contract moved to the desktop adapter that
// now BUILDS the phrase (`describeQuarantinedSources`), which is where it is
// asserted; these patterns only prove the phrase reaches the card's detail slot
// and displaces the scope caption. Declared
// at the file bottom per the package convention (read only inside the callbacks
// above, after this module finishes loading).
const COULD_NOT_IMPORT_ONE_PATTERN = /1 transcript couldn't be read/;
const COULD_NOT_IMPORT_MANY_PATTERN = /\d+ transcripts couldn't be read/;
const IMPORTING_HISTORY_PATTERN = /Importing your history/;

// FEA-4126: the label that must NOT appear on the Sessions bar (it stays on the
// Branches bar) and the exact card count after the removal. These are read only
// from within the test callbacks above (evaluated after this module finishes
// loading), so declaring them at the file bottom per the package convention is
// safe.
const MEDIAN_PR_SIZE_LABEL = "Median PR size";
const SESSIONS_CARD_COUNT = 5;
// FEA-4128: the three always-available (local SQLite) cards — Sessions, Total
// Tokens, Cost — that skeleton while the local source hydrates.
const ALWAYS_AVAILABLE_CARD_COUNT = 3;
