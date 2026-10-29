/**
 * ISS-10467: the component detail's per-CONTENT-VERSION usage drill-down.
 *
 * Driven through the real `AgentDetail` render path — the only production caller
 * of `VersionUsagePanel` — so these cases cover the actual wiring (the flag gate,
 * the data-source capability probe, the panel's place below the family cards),
 * not a synthetic prop bundle.
 *
 * The three axes that matter on this surface, each pinned so it would fail if
 * collapsed:
 *
 *  - THE GATE. ISS-4779 closed-by-default: flag off renders today's page with no
 *    drill-down affordance at all.
 *  - MEASURED ZERO vs NOT COMPUTED. The ISS-5363 contract makes these different
 *    answers on the wire, and a formatter that renders both the same throws that
 *    away at the last step. Pinned in two cases; either way of collapsing them
 *    fails exactly one.
 *  - THE VERSION-LESS POPULATION. Most usage rows name no version, so the panel
 *    must SAY what it does with them. Silently dropping them is the ISS-10341
 *    defect one layer out.
 */

import {
  AgentComponentKind,
  type ComponentVersion,
} from "@repo/api/src/types/agent-component";
import { TOTAL_ESTIMATED_COST_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import { TOTAL_TOKENS_LABEL } from "@repo/api/src/types/total-tokens-copy";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { SESSION_LEVEL_ATTRIBUTION_CAVEAT } from "@repo/app/agents/lib/session-level-attribution-copy";
import { SAMPLED_LOC_PER_DOLLAR_CAVEAT } from "@repo/app/agents/lib/version-usage-view";
import { AGENTS_VERSION_USAGE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { AgentDetail } from "../agent-detail";
import { VersionUsagePanel } from "../version-usage-panel";
import {
  CURRENT_HASH,
  MEASURED_ATTRIBUTION,
  makeDetail,
  OLDER_HASH,
  PANEL_HEADING,
  renderDetail,
  revision,
  testSource,
  versionUsage,
} from "./version-usage-fixtures";

const INVOCATIONS_ROW_LABEL = "Invocations";
const FAMILY_RESTATEMENT = /76 invocations across 5 sessions/;
const UNVERSIONED_LEAD = /69 of this component's invocations/;
const UNVERSIONED_SESSIONS = /seen across 2 sessions/;
// The versioned remainder is STATED rather than left to inference: a usage row
// can name a version identity no revision in this history matches, so "76 − 69"
// is not the revisions' total and the panel must not let a reader assume it is.
const VERSIONED_REMAINDER = /remaining 7 named a version/;
const SAMPLED_CAVEAT = /do not add up to the totals above/;
const VERSIONED_FURTHER = /further 7\+ named a version/;
const UNVERSIONED_PHRASE = /recorded no version at all/;
const FLOOR_PHRASE = /69\+ of this component's invocations/;
const UNCOMPUTABLE_PHRASE = /couldn't work out how much/;
const FAMILY_INVOCATIONS_ONLY = /total 76 invocations, for every revision/;
// The SENTENCE, terminator included. Every regex above matches only its front
// half, which is how the restatement shipped ending mid-clause ("…One
// revision's own share") without a test noticing (tamsinb review).
const FAMILY_RESTATEMENT_WHOLE =
  /^The cards above total 76 invocations across 5 sessions, for every revision\. The figures below are one revision's own share of that\.$/;
const READ_FAILED_PHRASE = /Couldn't load this version's usage/;
describe("VersionUsagePanel — per-version drill-down (ISS-10467)", () => {
  it("flag OFF: no drill-down affordance at all", async () => {
    renderDetail({ detail: makeDetail() }, false);

    // The page itself still renders — this is a gate, not a breakage.
    await screen.findByText("Definition");
    expect(screen.queryByText(PANEL_HEADING)).not.toBeInTheDocument();
  });

  it("flag ON: renders the selected version's own figures beside the family total", async () => {
    renderDetail({ detail: makeDetail() });

    await screen.findByText(PANEL_HEADING);
    // The family headline is restated, not replaced: the copy names the family's
    // 76/5 while the cards below carry the version's own 6/2.
    expect(await screen.findByText(FAMILY_RESTATEMENT)).toBeInTheDocument();
    expect(await screen.findByText("6")).toBeInTheDocument();
  });

  it("a MEASURED ZERO renders as 0, not as a dash", async () => {
    renderDetail({
      detail: makeDetail(),
      usage: versionUsage(0, 0, MEASURED_ATTRIBUTION),
    });

    await screen.findByText(PANEL_HEADING);
    const zeros = await screen.findAllByText("0");
    expect(zeros.length).toBeGreaterThan(0);
  });

  it("a NOT-COMPUTED figure renders as a dash, not as 0", async () => {
    renderDetail({
      detail: makeDetail(),
      usage: versionUsage(null, null, MEASURED_ATTRIBUTION),
    });

    await screen.findByText(PANEL_HEADING);
    // This case and the one above would BOTH pass if the two states were
    // collapsed into one rendering, and exactly one of them fails whichever way
    // they are collapsed.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect((await screen.findAllByText("—")).length).toBeGreaterThan(0);
  });

  it("states what it does with usage that names NO version", async () => {
    renderDetail({ detail: makeDetail() });

    await screen.findByText(PANEL_HEADING);
    expect(await screen.findByText(UNVERSIONED_LEAD)).toBeInTheDocument();
    expect(screen.getByText(UNVERSIONED_PHRASE)).toBeInTheDocument();
    // The session clause says "seen across", never that those sessions sit
    // outside the figures above: usage is keyed per (session, kind, key,
    // branch), so ONE session can carry a hash-bearing row and a hash-less one
    // and is counted in both slices. Only the invocation halves partition, and
    // only they carry the "in none of the figures here" claim.
    expect(screen.getByText(UNVERSIONED_SESSIONS)).toBeInTheDocument();
    expect(screen.getByText(VERSIONED_REMAINDER)).toBeInTheDocument();
  });

  it("a bounded partition is disclosed as a floor, not stated as a total", async () => {
    renderDetail({
      detail: makeDetail(),
      usage: versionUsage(6, 2, { ...MEASURED_ATTRIBUTION, truncated: true }),
    });

    await screen.findByText(PANEL_HEADING);
    expect(await screen.findByText(FLOOR_PHRASE)).toBeInTheDocument();
  });

  it("an UNCOMPUTABLE partition says so, instead of claiming 0 unattributed", async () => {
    renderDetail({
      detail: makeDetail(),
      usage: versionUsage(6, 2, {
        unversioned: { invocations: null, sessions: null },
        versioned: { invocations: null, sessions: null },
        truncated: false,
      }),
    });

    await screen.findByText(PANEL_HEADING);
    expect(await screen.findByText(UNCOMPUTABLE_PHRASE)).toBeInTheDocument();
    expect(screen.queryByText(UNVERSIONED_PHRASE)).toBeNull();
  });

  it("a source that cannot scope by version says so rather than showing zeroes", async () => {
    renderDetail({ detail: makeDetail(), supportsVersionUsage: false });

    await screen.findByText(PANEL_HEADING);
    expect(
      await screen.findByText("Per-version usage unavailable here")
    ).toBeInTheDocument();
    // Absence of the capability is NOT a measurement: no figure is rendered
    // INSIDE THE PANEL, so nothing there can be read as "this version ran
    // nothing". Scoped to the panel's own region because the family cards above
    // legitimately carry an "Invocations" label of their own.
    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    expect(within(panel).queryByText(INVOCATIONS_ROW_LABEL)).toBeNull();
  });

  it("hides LOC / $ for a kind whose headline hides it, never claiming more than the total", async () => {
    // The family strip omits `LOC / $` for a non-verifiable kind
    // (`isLocPerDollarVerifiableKind` — skill/command are session-level), so a
    // subordinate readout that showed it would assert a per-component
    // attribution the headline above it declines to make.
    renderDetail({ detail: makeDetail() });

    await screen.findByText(PANEL_HEADING);
    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    expect(within(panel).queryByText(LOC_PER_DOLLAR_LABEL)).toBeNull();
    // And it IS shown for the verifiable kind, so this is a gate rather than a
    // deletion — a case that would pass on a panel that never renders the row.
    expect(within(panel).getByText(INVOCATIONS_ROW_LABEL)).toBeInTheDocument();
  });

  it("shows LOC / $ for a verifiable kind, matching that headline", async () => {
    renderDetail({
      detail: makeDetail({ kind: AgentComponentKind.Subagent }),
    });

    await screen.findByText(PANEL_HEADING);
    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    expect(within(panel).getByText(LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
  });

  it("a FAILED read is named, not silently dimmed", async () => {
    render(
      <AppCoreStoryProviders
        enabledFlags={[AGENTS_VERSION_USAGE_FEATURE_FLAG_KEY]}
      >
        <AgentComponentsDataSourceProvider
          dataSource={{
            scope: "test-version-usage-error",
            honorsDateWindow: false,
            list: () => Promise.reject(new Error("unused")),
            detail: () => Promise.resolve(makeDetail()),
            versionUsage: () => Promise.reject(new Error("read failed")),
          }}
        >
          <AgentDetail
            backHref="/acme/agents"
            slug="skill::version-usage-fixture"
          />
        </AgentComponentsDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await screen.findByText(PANEL_HEADING);
    // A dimmed row set reads as "not applicable here"; the honest statement is
    // "we could not fetch this". Without this the failure had no words at all.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      READ_FAILED_PHRASE
    );
    // And the not-computed partition sentence is NOT also asserted on a failed
    // read — that would be a claim about the producer nobody heard from.
    expect(screen.queryByText(UNCOMPUTABLE_PHRASE)).toBeNull();
  });

  it("requests exactly the selected version from the source", async () => {
    const spy = vi.fn(() =>
      Promise.resolve(versionUsage(6, 2, MEASURED_ATTRIBUTION))
    );
    const detail = makeDetail();
    render(
      <AppCoreStoryProviders
        enabledFlags={[AGENTS_VERSION_USAGE_FEATURE_FLAG_KEY]}
      >
        <AgentComponentsDataSourceProvider
          dataSource={{
            scope: "test-version-usage-call-shape",
            honorsDateWindow: false,
            list: () => Promise.reject(new Error("unused")),
            detail: () => Promise.resolve(detail),
            versionUsage: spy,
          }}
        >
          <AgentDetail backHref="/acme/agents" slug={detail.slug} />
        </AgentComponentsDataSourceProvider>
      </AppCoreStoryProviders>
    );

    await screen.findByText(PANEL_HEADING);
    // The CALL SHAPE, not merely that the source was touched: the panel defaults
    // to the current revision and asks for that hash and no other.
    expect(spy).toHaveBeenCalledWith(detail.slug, [CURRENT_HASH]);
  });

  it("renders the SELECTED revision's own numbers, not another revision's", async () => {
    // A per-version panel proved against ONE version is vacuous: every
    // assertion about "this revision's usage" passes on an implementation that
    // ignores the hash entirely and renders whatever entry it was handed. The
    // family here has TWO revisions with DIFFERENT usage, and the source answers
    // per hash, so rendering the wrong revision's figures is a visible failure
    // rather than an invisible one.
    const byHash = new Map([
      [CURRENT_HASH, { invocations: 6, sessions: 2 }],
      [OLDER_HASH, { invocations: 41, sessions: 17 }],
    ]);
    const detail = makeDetail();
    renderDetail({
      detail,
      source: (_slug, hashes) => {
        const figures = byHash.get(hashes[0] ?? "");
        return Promise.resolve(
          versionUsage(
            figures?.invocations ?? null,
            figures?.sessions ?? null,
            MEASURED_ATTRIBUTION
          )
        );
      },
    });

    await screen.findByText(PANEL_HEADING);
    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    // The current revision's own pair.
    expect(await within(panel).findByText("6")).toBeInTheDocument();
    expect(within(panel).getByText("2")).toBeInTheDocument();
    // And NOT the older revision's, which exists in the same fixture and would
    // render here on a panel that dropped the hash from its request or read the
    // wrong entry out of the response.
    expect(within(panel).queryByText("41")).toBeNull();
    expect(within(panel).queryByText("17")).toBeNull();
  });

  it("does not collide with the Definition panel's reconciliation slot", async () => {
    // Both panels are keyed to reset their own revision selection on
    // same-component navigation, and both are children of ONE parent. Keyed on
    // the BARE slug they were the same key twice, which React calls unsupported:
    // it is free to reconcile them as a single child and carry this panel's
    // `selectedHash` into a slot that is not it. The warning is the only
    // observation of that reconciliation, so it is what this asserts — every
    // other case in this file stayed green while the collision was live.
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      });
    try {
      renderDetail({ detail: makeDetail() });
      await screen.findByText(PANEL_HEADING);
      // Both siblings are mounted — without this the case would pass on a page
      // that rendered neither and had nothing to collide.
      expect(screen.getByText("Definition")).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
    expect(errors.filter((line) => DUPLICATE_KEY.test(line))).toEqual([]);
  });

  it("marks a BOUNDED entry's counts as floors, not as exact totals", async () => {
    // `AgentComponentVersionUsage.truncated` means the version-scoped orphan
    // lane hit its row cap, so every count in the entry is a FLOOR. Rendered
    // bare it claims a total nobody measured — and the partition sentence
    // directly beneath was already disclosing its own cap with a `+`, so one
    // panel carried two honesty standards and the stricter one sat on the
    // smaller number.
    renderDetail({
      detail: makeDetail(),
      usage: versionUsage(6, 2, MEASURED_ATTRIBUTION, { truncated: true }),
    });

    await screen.findByText(PANEL_HEADING);
    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    expect(await within(panel).findByText("6+")).toBeInTheDocument();
    expect(within(panel).getByText("2+")).toBeInTheDocument();
    // The BARE figures are gone, not merely joined by marked ones — asserting
    // only that "6+" appeared would pass on a panel rendering both.
    expect(within(panel).queryByText("6")).toBeNull();
    expect(within(panel).queryByText("2")).toBeNull();
  });

  it("marks Merged PRs a floor on its OWN declared cap, leaving the entry exact", async () => {
    // `mergedPrsTruncated` is a TRI-state and the cohort read can be sampled
    // independently of the usage lane, so the two flags are decoded separately.
    renderDetail({
      detail: makeDetail(),
      usage: versionUsage(6, 2, MEASURED_ATTRIBUTION, {
        mergedPrs: 4,
        mergedPrsTruncated: true,
      }),
    });

    await screen.findByText(PANEL_HEADING);
    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    expect(await within(panel).findByText("4+")).toBeInTheDocument();
    // The entry's own `truncated` is false here, so Invocations stays exact —
    // which is what proves the flags are read separately rather than one
    // standing in for both.
    expect(within(panel).getByText("6")).toBeInTheDocument();
  });

  it("finishes the family restatement instead of trailing off mid-sentence", async () => {
    renderDetail({ detail: makeDetail() });

    await screen.findByText(PANEL_HEADING);
    // Anchored at both ends: a truncated sentence, or a second clause appended
    // after the terminator, both fail this where a front-half match would not.
    expect(
      await screen.findByText(FAMILY_RESTATEMENT_WHOLE)
    ).toBeInTheDocument();
  });

  it("states a family figure it HAS when the other is not computable", async () => {
    // One absent operand must not take the other with it. The Invocations card
    // above renders 76 either way, so suppressing the whole baseline withholds a
    // number the page already holds and leaves the subtotal with no total to be
    // read against.
    renderDetail({ detail: makeDetail({ sessions: null }) });

    await screen.findByText(PANEL_HEADING);
    expect(
      await screen.findByText(FAMILY_INVOCATIONS_ONLY)
    ).toBeInTheDocument();
    // And the absent half is not invented as a zero or dashed into the sentence.
    expect(screen.queryByText(FAMILY_RESTATEMENT)).toBeNull();
  });

  it("falls back to a live revision when the held selection leaves the history", async () => {
    // whitlockk: the panel's key resets the selection on same-component navigation,
    // but a local refresh can replace a legacy name-slug's version history IN
    // PLACE — same slug, new hashes. The held pick then names a revision this
    // component no longer has, the read answers NOT-COMPUTED, and the panel
    // renders the deliberate dash state as if the data were missing.
    //
    // Driven at the PANEL rather than through `AgentDetail` like its siblings:
    // the detail query is cached on the slug, so a same-slug payload swap never
    // reaches the panel's props through that path and the case would assert
    // nothing.
    const REPLACED_HASH = "cccccccc3333";
    const byHash = new Map([
      [CURRENT_HASH, { invocations: 6, sessions: 2 }],
      [REPLACED_HASH, { invocations: 33, sessions: 11 }],
    ]);
    const source = (_slug: string, hashes: readonly string[]) => {
      const figures = byHash.get(hashes[0] ?? "");
      return Promise.resolve(
        versionUsage(
          figures?.invocations ?? null,
          figures?.sessions ?? null,
          MEASURED_ATTRIBUTION
        )
      );
    };
    const detail = makeDetail();
    const panelTree = (versions: readonly ComponentVersion[]) => (
      <AppCoreStoryProviders
        enabledFlags={[AGENTS_VERSION_USAGE_FEATURE_FLAG_KEY]}
      >
        <AgentComponentsDataSourceProvider
          dataSource={testSource({ detail, source })}
        >
          <VersionUsagePanel
            familyInvocations={76}
            familySessions={5}
            kind={detail.kind}
            slug={detail.slug}
            versions={versions}
          />
        </AgentComponentsDataSourceProvider>
      </AppCoreStoryProviders>
    );

    const { rerender } = render(panelTree(detail.versions));

    const before = screen.getByRole("region", { name: PANEL_HEADING });
    expect(await within(before).findByText("6")).toBeInTheDocument();

    // The history is replaced under the SAME slug, so nothing remounts.
    rerender(
      panelTree([revision(REPLACED_HASH, true), revision(OLDER_HASH, false)])
    );

    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    expect(await within(panel).findByText("33")).toBeInTheDocument();
    expect(await within(panel).findByText("11")).toBeInTheDocument();
  });

  it("says a shown LOC / $ came from a sample when the cohort was bounded", async () => {
    // `truncated` is FALSE here — the population aggregate stood in for the
    // capped lane, so the counts beside the ratio are exact. Nothing else on the
    // panel would then say the session set behind the ratio was a sample.
    renderDetail({
      detail: makeDetail({ kind: AgentComponentKind.Subagent }),
      usage: versionUsage(6, 2, MEASURED_ATTRIBUTION, {
        locPerDollar: 240,
        mergedPrsTruncated: true,
        truncated: false,
      }),
    });

    await screen.findByText(PANEL_HEADING);
    expect(
      await screen.findByText(SAMPLED_LOC_PER_DOLLAR_CAVEAT)
    ).toBeInTheDocument();
  });

  it("stays silent about sampling when the cohort declared no cap", async () => {
    // The counterfactual: same ratio, same kind, coverage NOT capped. A caveat
    // that rendered here would qualify an exact figure — the overstatement
    // pointed the other way.
    renderDetail({
      detail: makeDetail({ kind: AgentComponentKind.Subagent }),
      usage: versionUsage(6, 2, MEASURED_ATTRIBUTION, {
        locPerDollar: 240,
        mergedPrsTruncated: false,
        truncated: false,
      }),
    });

    await screen.findByText(PANEL_HEADING);
    // A positive control on the SAME locator family: the ratio itself renders,
    // so the absence below is a suppressed sentence and not a dead panel.
    expect(
      within(screen.getByRole("region", { name: PANEL_HEADING })).getByText(
        LOC_PER_DOLLAR_LABEL
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(SAMPLED_LOC_PER_DOLLAR_CAVEAT)).toBeNull();
  });

  it("reports no figures for a revision nobody could select", async () => {
    // `coerceHash` drops a non-string hash (FEA-3520), so every revision can
    // coerce away — and then nothing was ever requested. A row set of dashes
    // there reports the producer's "not computed" about a question no one asked,
    // which is the rule the partition sentence already follows.
    // ONE revision, so the Definition panel above renders no selector of its
    // own (`versions.length > 1`) and this case exercises the drill-down's idle
    // branch rather than a sibling's.
    renderDetail({
      detail: makeDetail({
        versions: [{ ...revision(CURRENT_HASH, true), hash: "" }],
      }),
    });

    await screen.findByText(PANEL_HEADING);
    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    expect(
      await within(panel).findByText("No revision to break down")
    ).toBeInTheDocument();
    expect(within(panel).queryByText(INVOCATIONS_ROW_LABEL)).toBeNull();
  });

  it("a bounded partition drops the subtraction claim instead of the figures", async () => {
    // The partition is folded row by row over the family's usage rows, so a
    // bounded lane makes the two slices sum to the SAMPLE while the cards above
    // state the POPULATION. Both figures are real and both stay on screen; what
    // must go is the arithmetic — "the remaining N" invites a subtraction that
    // lands on a remainder nothing measured.
    renderDetail({
      detail: makeDetail(),
      usage: versionUsage(6, 2, { ...MEASURED_ATTRIBUTION, truncated: true }),
    });

    await screen.findByText(PANEL_HEADING);
    expect(await screen.findByText(SAMPLED_CAVEAT)).toBeInTheDocument();
    // The versioned figure is still published — this is a caveat, not a deletion.
    expect(screen.getByText(VERSIONED_FURTHER)).toBeInTheDocument();
    // And the unbounded wording is gone, so the caveat is not merely appended
    // beside a sentence that still tells the reader to subtract.
    expect(screen.queryByText(VERSIONED_REMAINDER)).toBeNull();
  });

  it("states the slice figure it HAS when the other half is not computable", async () => {
    // `AgentComponentUsageSlice` types the two independently, so a version-skewed
    // producer can send one. Suppressing the whole sentence there routes the panel
    // to "we couldn't work out how much ... recorded no version" while it is
    // holding the invocation figure that sentence denies having.
    renderDetail({
      detail: makeDetail(),
      usage: versionUsage(6, 2, {
        unversioned: { invocations: 69, sessions: null },
        versioned: { invocations: 7, sessions: 3 },
        truncated: false,
      }),
    });

    await screen.findByText(PANEL_HEADING);
    expect(await screen.findByText(UNVERSIONED_LEAD)).toBeInTheDocument();
    // And it does NOT claim the partition was uncomputable while holding half of it.
    expect(screen.queryByText(UNCOMPUTABLE_PHRASE)).toBeNull();
  });

  it("breaks token and cost down PER VERSION for a skill, the kind the ruling names", async () => {
    // ISS-10467, operator ruling (marisolashgrove, 2026-09-26): "I think we actually
    // want to break down token/cost by version for skills & commands, in
    // particularly skills." The producer already held both figures for every
    // revision and this function dropped them, so the defect was a render gap
    // rather than a missing measurement. `makeDetail()` is a SKILL, which is the
    // kind that previously rendered neither row.
    renderDetail({
      detail: makeDetail(),
      usage: versionUsage(6, 2, MEASURED_ATTRIBUTION, {
        totalTokens: 1_250_000,
        estimatedCostUsd: 41.5,
      }),
    });

    await screen.findByText(PANEL_HEADING);
    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    expect(
      await within(panel).findByText(TOTAL_TOKENS_LABEL)
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(TOTAL_ESTIMATED_COST_LABEL)
    ).toBeInTheDocument();
    // The VALUES, not merely the labels: a panel that rendered two rows of
    // permanent dashes would satisfy a label-only assertion and report nothing.
    expect(within(panel).getByText("1.25M")).toBeInTheDocument();
    // CENTS, not the `$42` this column rounded 41.5 to before (operator ruling,
    // marisolashgrove 2026-10-01: "raise cost column's precision").
    expect(within(panel).getByText("$41.50")).toBeInTheDocument();
    // And the session-level admission travels with them, because a skill's
    // session also ran everything else in it.
    expect(
      screen.getByText(SESSION_LEVEL_ATTRIBUTION_CAVEAT)
    ).toBeInTheDocument();
  });

  it("an UNMEASURED revision dashes its spend rows instead of printing $0.00", async () => {
    // The ISS-5363 distinction on the two rows this ruling added. `EMPTY_VERSION_SPEND`
    // is what both producers emit for a revision nothing could be measured for,
    // and `$0.00` there is the fabricated-measurement shape root AGENTS.md names —
    // it says this revision was priced and cost nothing.
    renderDetail({
      detail: makeDetail(),
      usage: versionUsage(6, 2, MEASURED_ATTRIBUTION),
    });

    await screen.findByText(PANEL_HEADING);
    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    // Present, so this is a no-VALUE case rather than a no-ROW case — the pair
    // with the presence assertion above, on the same locator.
    expect(
      await within(panel).findByText(TOTAL_TOKENS_LABEL)
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(TOTAL_ESTIMATED_COST_LABEL)
    ).toBeInTheDocument();
    expect(within(panel).queryByText("$0.00")).toBeNull();
    expect(within(panel).queryByText("$0")).toBeNull();
    // Two dashes, one per unmeasured spend row, beside the measured 6/2 counts.
    expect(within(panel).getAllByText("—").length).toBeGreaterThanOrEqual(2);
    // No caveat over a figure that does not exist.
    expect(screen.queryByText(SESSION_LEVEL_ATTRIBUTION_CAVEAT)).toBeNull();
  });

  it("a MEASURED $0 revision renders $0.00, which is not the unmeasured dash", async () => {
    // The other side of that distinction, and the case that fails whichever way
    // the two are collapsed: a revision whose sessions WERE priced and cost
    // nothing is a real measurement and must read as one.
    renderDetail({
      detail: makeDetail(),
      usage: versionUsage(6, 2, MEASURED_ATTRIBUTION, {
        totalTokens: 0,
        estimatedCostUsd: 0,
      }),
    });

    await screen.findByText(PANEL_HEADING);
    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    expect(await within(panel).findByText("$0.00")).toBeInTheDocument();
  });

  it("marks a PARTIALLY covered spend figure as a floor, not as a total", async () => {
    // Some of the revision's sessions reported no price / no token counters, so
    // the sums are FLOORS. Published rather than withheld — a floor labelled as a
    // floor is usable — but never bare, which would claim a total nobody measured.
    // The `+` is this page's own convention, already spoken by the counts above.
    renderDetail({
      detail: makeDetail(),
      usage: versionUsage(6, 2, MEASURED_ATTRIBUTION, {
        totalTokens: 900,
        totalTokensPartial: true,
        estimatedCostUsd: 12,
        estimatedCostPartial: true,
      }),
    });

    await screen.findByText(PANEL_HEADING);
    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    expect(await within(panel).findByText("900+")).toBeInTheDocument();
    expect(within(panel).getByText("$12.00+")).toBeInTheDocument();
  });

  it("omits the session-level caveat for the kind whose attribution is reliable", async () => {
    // `subagent` governs the whole session it runs, so the sentence would be
    // false there. A gate, not a deletion: the rows themselves still render, and
    // the case above proves the sentence appears for a skill.
    renderDetail({
      detail: makeDetail({ kind: AgentComponentKind.Subagent }),
      usage: versionUsage(6, 2, MEASURED_ATTRIBUTION, {
        totalTokens: 1000,
        estimatedCostUsd: 9,
      }),
    });

    await screen.findByText(PANEL_HEADING);
    const panel = screen.getByRole("region", { name: PANEL_HEADING });
    expect(
      within(panel).getByText(TOTAL_ESTIMATED_COST_LABEL)
    ).toBeInTheDocument();
    expect(screen.queryByText(SESSION_LEVEL_ATTRIBUTION_CAVEAT)).toBeNull();
  });
});

const DUPLICATE_KEY = /two children with the same key/i;
