import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchViewCheckKind,
  BranchViewChecksProviderState,
  isWholeMeasuredPopulation,
} from "@repo/api/src/types/branch-check-projection";
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import { BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY } from "@repo/api/src/types/branch-detail-measured-checks-flag";
import { projectBranchSelectedPullRequestChecks } from "@repo/api/src/types/branch-selected-pull-request-checks";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  SelectedPullRequestCheckCategory,
  SelectedPullRequestCheckSourceKind,
  SelectedPullRequestChecksCompleteness,
  SelectedPullRequestChecksHistoryMode,
} from "@repo/api/src/types/selected-pull-request-checks-evidence";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { BRANCH_DETAIL_MEASURED_CHECKS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeBranchDetail } from "../../../__tests__/branch-fixtures";
import {
  CHECKS_POPULATION_CAPPED_LABEL,
  CHECKS_POPULATION_EMPTY_LABEL,
  CHECKS_PROVIDER_UNAVAILABLE_LABEL,
  CHECKS_ROLLUP_UNREPORTED_LABEL,
  CHECKS_STATUS_LABEL,
  CHECKS_STATUS_UNREPORTED_LABEL,
  CHECKS_STATUS_VARIANT,
  checksPopulationShortfall,
} from "../../../lib/checks-status-display";
import { BranchPrStatusPanel } from "../branch-pr-status-panel";

const HEAD_SHA = "b".repeat(40);
const LIVE_SUMMARY_RE = /1\/1 passing/i;
const CHECKS_DISCLOSURE_RE = /Checks/;
/** The flag-OFF caption under the same trigger, whose placement this box shares. */
const LIVE_CAPTION_RE = /Passed \d+ · Failed \d+/;

/**
 * ISS-8241 Half A. Every case here drives the SHIPPED panel, not the measured
 * component alone, so the flag switch itself is under test: an assertion that
 * only ever mounted `BranchPrMeasuredChecks` would stay green if
 * `SelectedPullRequestChecks` stopped consulting the flag.
 */
describe("BranchPrStatusPanel measured checks (ISS-8241)", () => {
  it("pins the web alias to the same literal both surfaces register", () => {
    // The desktop Labs half is pinned against the raw literal in
    // apps/desktop/test/feature-flags-cross-surface.test.ts. Neither surface
    // imports the other, so these two raw pins together are what stop a rename
    // leaving one surface on the live read and the other on the measured one.
    expect(BRANCH_DETAIL_MEASURED_CHECKS_FEATURE_FLAG_KEY).toBe(
      "branch-detail-measured-checks"
    );
    expect(BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY).toBe(
      "branch-detail-measured-checks"
    );
  });

  it("keeps the live provider read with the flag off, even when a measured projection is present", () => {
    renderPanel({
      enabled: false,
      detail: {
        checksStatus: ChecksStatus.Failing,
        selectedPullRequestChecksProjection: availableProjection(),
        selectedPullRequestChecks: liveSuccessfulChecks(),
      },
    });

    expect(screen.getByText(LIVE_SUMMARY_RE)).toBeInTheDocument();
    expect(
      screen.queryByText(CHECKS_STATUS_LABEL[ChecksStatus.Failing])
    ).not.toBeInTheDocument();
  });

  it("states the selected PR's own measured rows with the flag on, not the live read", () => {
    renderPanel({
      enabled: true,
      detail: {
        checksStatus: ChecksStatus.Passing,
        selectedPullRequestChecksProjection: availableProjection(),
        selectedPullRequestChecks: liveSuccessfulChecks(),
      },
    });

    // `checksStatus` says PASSING and the one measured row says it failed. The
    // rows win: writers move that column without touching the rows, so pairing
    // them would put a headline directly above a list that contradicts it.
    expect(screen.getByText("Failed 1")).toBeInTheDocument();
    expect(
      screen.queryByText(CHECKS_STATUS_LABEL[ChecksStatus.Passing])
    ).not.toBeInTheDocument();
    expect(screen.queryByText(LIVE_SUMMARY_RE)).not.toBeInTheDocument();
  });

  it("names a head no producer measured rather than leaving a blank", () => {
    renderPanel({
      enabled: true,
      detail: { checksStatus: null, selectedPullRequestChecks: undefined },
    });

    expect(
      screen.getByText(CHECKS_STATUS_UNREPORTED_LABEL)
    ).toBeInTheDocument();
  });

  it("keeps a measured EMPTY population apart from an unmeasured head", () => {
    renderPanel({
      enabled: true,
      detail: {
        checksStatus: ChecksStatus.Unknown,
        selectedPullRequestChecksProjection: {
          ...availableProjection(),
          providerState: BranchViewChecksProviderState.NoChecks,
          totalCount: 0,
          items: [],
        },
      },
    });

    expect(screen.getByText(CHECKS_POPULATION_EMPTY_LABEL)).toBeInTheDocument();
    expect(
      screen.queryByText(CHECKS_STATUS_UNREPORTED_LABEL)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(CHECKS_STATUS_LABEL[ChecksStatus.Unknown])
    ).not.toBeInTheDocument();
  });

  it("keeps a measured population whose rows did not come back apart from an unmeasured head", () => {
    // Somebody DID look and counted two checks, so "Checks not reported" would
    // tell the reader nobody did.
    renderPanel({
      enabled: true,
      detail: {
        checksStatus: null,
        selectedPullRequestChecksProjection: {
          ...availableProjection(),
          items: [],
        },
      },
    });

    expect(
      screen.getByText(CHECKS_ROLLUP_UNREPORTED_LABEL)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(CHECKS_STATUS_UNREPORTED_LABEL)
    ).not.toBeInTheDocument();
  });

  it("states the per-check outcomes and the tally the live panel also states", () => {
    // The flag must change WHERE the checks come from, not what a reader can
    // learn: the same outcome words, the same breakdown, the same links.
    renderPanel({
      enabled: true,
      detail: {
        checksStatus: ChecksStatus.Failing,
        selectedPullRequestChecksProjection: {
          ...availableProjection(),
          totalCount: 2,
          items: [
            ...availableProjection().items,
            {
              id: "lint",
              kind: BranchViewCheckKind.CheckRun,
              name: "lint",
              status: "IN_PROGRESS",
              conclusion: null,
              targetUrl: "https://ci.example.test/lint",
            },
          ],
        },
      },
    });

    expect(screen.getByText("Failed 1 · Pending 1")).toBeInTheDocument();

    const disclosure = screen.getByRole("button", {
      name: CHECKS_DISCLOSURE_RE,
    });

    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open lint check" })
    ).toBeInTheDocument();
  });

  it("names the recorded population whenever fewer rows than it are in hand", () => {
    // A capped or shortened list must never read as the whole one.
    renderPanel({
      enabled: true,
      detail: {
        checksStatus: ChecksStatus.Failing,
        selectedPullRequestChecksProjection: {
          ...availableProjection(),
          truncated: true,
          totalCount: 40,
        },
      },
    });

    expect(screen.getByText("Failed 1")).toBeInTheDocument();
    expect(screen.getByText("1 of 40 recorded checks")).toBeInTheDocument();
  });

  it("keeps a FAILED provider read apart from a measured conclusion", () => {
    // `checks_status` is not written on the failure path, so the rollup beside
    // this projection still describes an earlier head. Showing it would be the
    // stale-answer-as-this-head's lie the ticket exists to remove.
    renderPanel({
      enabled: true,
      detail: {
        checksStatus: ChecksStatus.Passing,
        selectedPullRequestChecksProjection: {
          ...availableProjection(),
          providerState: BranchViewChecksProviderState.ProviderUnavailable,
        },
      },
    });

    expect(
      screen.getByText(CHECKS_PROVIDER_UNAVAILABLE_LABEL)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(CHECKS_STATUS_LABEL[ChecksStatus.Passing])
    ).not.toBeInTheDocument();
  });

  it("tones the summary by the WORST row present, never by the last one read", () => {
    // The headline must not read better than the list beneath it. A failure
    // arriving before two passes still has to carry the tone.
    renderPanel({
      enabled: true,
      detail: {
        selectedPullRequestChecksProjection: {
          ...availableProjection(),
          totalCount: 3,
          items: [
            checkItem("unit", "FAILURE"),
            checkItem("build", "SUCCESS"),
            checkItem("lint", "SUCCESS"),
          ],
        },
      },
    });

    expect(screen.getByText("Failed 1 · Passed 2")).toHaveClass(
      "text-destructive"
    );
  });

  it("states the categories worst-first whatever order the rows arrived in", () => {
    // Same population, rows reversed. Insertion order would word this summary
    // "Passed 2 · Failed 1" and make one population read two ways.
    renderPanel({
      enabled: true,
      detail: {
        selectedPullRequestChecksProjection: {
          ...availableProjection(),
          totalCount: 3,
          items: [
            checkItem("build", "SUCCESS"),
            checkItem("lint", "SUCCESS"),
            checkItem("unit", "FAILURE"),
          ],
        },
      },
    });

    expect(screen.getByText("Failed 1 · Passed 2")).toBeInTheDocument();
  });

  it("never lets an outcome it cannot read lift the summary to a pass", () => {
    // An unrecognized provider word ranks with the inconclusive rows, so the
    // tone stays neutral rather than inheriting the passing row beside it.
    renderPanel({
      enabled: true,
      detail: {
        selectedPullRequestChecksProjection: {
          ...availableProjection(),
          totalCount: 2,
          items: [
            checkItem("build", "SUCCESS"),
            checkItem("quarantine", "QUARANTINED"),
          ],
        },
      },
    });

    expect(screen.getByText("QUARANTINED 1 · Passed 1")).toHaveClass(
      "text-foreground"
    );
  });

  /**
   * ISS-8629. Kaito ruled on 2026-08-31: "Let's withhold green until the full
   * population is complete." The API already did — `foldMeasuredChecks`
   * returns UNKNOWN over a partly-recorded population — while the render drew it
   * green, so the same branch was green on screen and UNKNOWN on the wire. These
   * pin the render adopting that one completeness rule.
   *
   * Every tone here is named by `CHECKS_STATUS_VARIANT[<the verdict the wire
   * sends>]` rather than by a re-typed class. That is deliberately the OTHER of
   * the two variant maps: the component tones through `CHECK_ROW_BUCKET_VARIANT`
   * (bucket to variant), and these assert the result equals what the ROLLUP
   * vocabulary gives the same population. Comparing the two maps is the point —
   * it is the cross-layer agreement under test — so retuning either one alone is
   * meant to red these cases.
   */
  describe("withholding the passing tone on an incomplete population (ISS-8629)", () => {
    it("tones a COMPLETE all-passing population as passing", () => {
      renderPanel({
        enabled: true,
        detail: {
          selectedPullRequestChecksProjection: {
            ...availableProjection(),
            totalCount: 2,
            items: [
              checkItem("build", "SUCCESS"),
              checkItem("lint", "SUCCESS"),
            ],
          },
        },
      });

      expect(screen.getByText("Passed 2")).toHaveClass(
        ...toneClasses(ChecksStatus.Passing)
      );
      // Located through the WIRING rather than a re-typed copy of the sentence:
      // the description and the `<p>` are emitted off the one predicate, so this
      // cannot go vacuous when the copy is reworded (ISS-10117).
      expect(
        screen.getByRole("button", { name: CHECKS_DISCLOSURE_RE })
      ).not.toHaveAccessibleDescription();
    });

    it("withholds the passing tone while rows are still missing, keeping every count on screen", () => {
      // The same population the API test "refuses to call a population passing
      // when it stores fewer rows than it counted" folds to UNKNOWN: one passing
      // row of a counted nine. Nothing is deleted to buy the honest tone — the
      // tally, the recorded-population line, and the row itself all survive.
      renderPanel({
        enabled: true,
        detail: {
          selectedPullRequestChecksProjection: {
            ...availableProjection(),
            totalCount: 9,
            items: [checkItem("build", "SUCCESS")],
          },
        },
      });

      expect(screen.getByText("Passed 1")).toHaveClass(
        ...toneClasses(ChecksStatus.Unknown)
      );
      expect(
        screen.getByText(shortfallOf({ totalCount: 9, rows: 1 }))
      ).toBeInTheDocument();

      const disclosure = screen.getByRole("button", {
        name: CHECKS_DISCLOSURE_RE,
      });
      fireEvent.click(disclosure);
      expect(screen.getByText("Passed")).toBeInTheDocument();
    });

    it("states the shortfall in the accessibility tree, never in the colour alone", () => {
      // `ToneLabel` is a text COLOUR and the label reads "Passed 1" either way,
      // so the withheld tone is invisible without it. WCAG 1.4.1: the adjacent
      // sentence is what actually tells a reader the population is short.
      renderPanel({
        enabled: true,
        detail: {
          selectedPullRequestChecksProjection: {
            ...availableProjection(),
            totalCount: 9,
            items: [checkItem("build", "SUCCESS")],
          },
        },
      });

      expect(
        screen.getByRole("button", { name: CHECKS_DISCLOSURE_RE })
      ).toHaveAccessibleDescription(shortfallOf({ totalCount: 9, rows: 1 }));
    });

    it("still tones an incomplete population by a failure it can see", () => {
      // Withholding green must not withhold a warning. A failure is conclusive
      // from a single row, so it outranks the incompleteness — exactly as the
      // API returns FAILING rather than UNKNOWN for this population.
      renderPanel({
        enabled: true,
        detail: {
          selectedPullRequestChecksProjection: {
            ...availableProjection(),
            totalCount: 9,
            items: [
              checkItem("unit", "FAILURE"),
              checkItem("build", "SUCCESS"),
            ],
          },
        },
      });

      expect(screen.getByText("Failed 1 · Passed 1")).toHaveClass(
        ...toneClasses(ChecksStatus.Failing)
      );
    });

    it("withholds the passing tone on a TRUNCATED population whose counted rows are all in hand", () => {
      // Isolates the `!truncated` conjunct: `items.length === totalCount` here,
      // so the count clause alone would call this complete and draw it green.
      renderPanel({
        enabled: true,
        detail: {
          selectedPullRequestChecksProjection: {
            ...availableProjection(),
            totalCount: 2,
            truncated: true,
            items: [
              checkItem("build", "SUCCESS"),
              checkItem("lint", "SUCCESS"),
            ],
          },
        },
      });

      expect(screen.getByText("Passed 2")).toHaveClass(
        ...toneClasses(ChecksStatus.Unknown)
      );
      // The counted sentence is WRONG here: `totalCount` is a floor, so it would
      // read "2 of 2 recorded checks" and tell the reader everything is in hand
      // directly beneath a tone withheld because it is not. The description is
      // matched EXACTLY against the constant, which is what rules the counted
      // words out — a re-typed `/recorded checks/` would stop matching the
      // moment that sentence was reworded and pass on nothing (ISS-10117).
      expect(
        screen.getByText(CHECKS_POPULATION_CAPPED_LABEL)
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: CHECKS_DISCLOSURE_RE })
      ).toHaveAccessibleDescription(CHECKS_POPULATION_CAPPED_LABEL);
    });

    it("renders an OVERFULL population's impossible counts rather than a plausible caveat", () => {
      // whitlockk on PR #7431: `checks_detail_total_count` is an unconstrained
      // persisted Int, so more rows than the count is reachable from bad stored
      // state. Under `>=` the capped branch swallowed it and printed a sentence
      // that reads like an ordinary cap. "3 of 1" is the honest render, and the
      // one a reader can report — masking it is the coercion AGENTS.md's
      // bad-data rule forbids.
      renderPanel({
        enabled: true,
        detail: {
          selectedPullRequestChecksProjection: {
            ...availableProjection(),
            totalCount: 1,
            truncated: true,
            items: [
              checkItem("build", "SUCCESS"),
              checkItem("lint", "SUCCESS"),
              checkItem("unit", "SUCCESS"),
            ],
          },
        },
      });

      expect(
        screen.getByText(shortfallOf({ totalCount: 1, rows: 3 }))
      ).toBeInTheDocument();
      expect(
        screen.queryByText(CHECKS_POPULATION_CAPPED_LABEL)
      ).not.toBeInTheDocument();
    });

    it("places the shortfall sentence exactly where the flag-off caption sits", () => {
      // tamsinb on PR #7431: one box, two halves. The flag switches WHERE the
      // checks come from, so the sentence under the trigger must not move or
      // re-indent when it flips — and expanded, the sentence explaining a
      // withheld tone must not end up below the whole row list, separated from
      // the tone it explains.
      //
      // Compared render-to-render, never to a class literal: a re-typed
      // `pl-5` would keep passing while the two halves drifted apart.
      const incomplete = {
        selectedPullRequestChecksProjection: {
          ...availableProjection(),
          totalCount: 9,
          items: [checkItem("build", "SUCCESS")],
        },
      };
      const off = renderPanel({
        enabled: false,
        detail: {
          ...incomplete,
          selectedPullRequestChecks: liveSuccessfulChecks(),
        },
      });
      const caption = screen.getByText(LIVE_CAPTION_RE, { selector: "p" });
      const captionClassName = caption.className;
      expect(captionClassName).toContain("pl-5");
      off.unmount();

      renderPanel({ enabled: true, detail: incomplete });
      fireEvent.click(
        screen.getByRole("button", { name: CHECKS_DISCLOSURE_RE })
      );
      const shortfall = screen.getByText(
        shortfallOf({ totalCount: 9, rows: 1 })
      );

      expect(shortfall.className).toBe(captionClassName);
      // Ahead of the rows the disclosure just revealed, as the caption is.
      expect(
        shortfall.compareDocumentPosition(screen.getByText("Passed"))
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it("tones the screen off the same predicate the API rollup withholds on", () => {
      // The agreement itself, on one fixture object: `isWholeMeasuredPopulation`
      // is the single derivation, and `foldMeasuredChecks`
      // (apps/api/app/branches/branch-read-service/selected-pull-request-checks-projection.ts)
      // calls it on the same shape. Were the render to grow its own completeness
      // rule again, this case and that fold would disagree here first.
      const projection = {
        ...availableProjection(),
        totalCount: 9,
        items: [checkItem("build", "SUCCESS")],
      };

      expect(isWholeMeasuredPopulation(projection)).toBe(false);

      renderPanel({
        enabled: true,
        detail: { selectedPullRequestChecksProjection: projection },
      });

      expect(screen.getByText("Passed 1")).toHaveClass(
        ...toneClasses(ChecksStatus.Unknown)
      );
    });
  });
});

/**
 * The tone classes a `ToneLabel` carries for one canonical ROLLUP verdict — the
 * wire's vocabulary, not the component's bucket map (see the block comment
 * above for why the comparison is across the two).
 *
 * Rendered rather than re-typed so these cases assert the screen agrees with
 * `CHECKS_STATUS_VARIANT` itself — a hardcoded `text-success-foreground` would
 * keep passing if the design system re-toned `success` beneath it.
 */
function toneClasses(status: ChecksStatus): string[] {
  const { container, unmount } = render(
    <ToneLabel variant={CHECKS_STATUS_VARIANT[status]}>tone</ToneLabel>
  );
  const rendered = container.querySelector("span");
  if (!rendered) {
    throw new Error("ToneLabel rendered no element to read a tone from");
  }
  const classes = Array.from(rendered.classList);
  unmount();
  return classes;
}

function checkItem(id: string, conclusion: string) {
  return {
    id,
    kind: BranchViewCheckKind.CheckRun,
    name: id,
    status: "COMPLETED",
    conclusion,
    targetUrl: null,
  };
}

function renderPanel({
  enabled,
  detail,
}: {
  enabled: boolean;
  detail: Partial<Parameters<typeof makeBranchDetail>[0]>;
}) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: enabled ? [BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY] : [],
      })}
    >
      <BranchPrStatusPanel
        detail={makeBranchDetail({
          status: BranchStatus.Open,
          selectedPullRequest: {
            id: "pr-1",
            number: 7,
            repositoryFullName: "acme/web",
            state: GitHubPRState.Open,
            headRefOid: HEAD_SHA,
          } as NonNullable<
            ReturnType<typeof makeBranchDetail>["selectedPullRequest"]
          >,
          ...detail,
        })}
      />
    </FeatureFlagAdapterProvider>
  );
}

function availableProjection() {
  return {
    headSha: HEAD_SHA,
    providerState: BranchViewChecksProviderState.Available,
    unavailableReason: null,
    totalCount: 2,
    truncated: false,
    items: [
      {
        id: "ci",
        kind: BranchViewCheckKind.CheckRun,
        name: "ci",
        status: "completed",
        conclusion: "failure",
        targetUrl: null,
      },
    ],
  };
}

function liveSuccessfulChecks() {
  return projectBranchSelectedPullRequestChecks({
    identity: {
      githubId: "PR_1",
      repositoryFullName: "acme/web",
      number: 7,
      url: "https://github.com/acme/web/pull/7",
    },
    revision: { headSha: HEAD_SHA },
    checks: [
      {
        providerId: "live-1",
        sourceIdentity: "live-1",
        sourceKind: SelectedPullRequestCheckSourceKind.CheckRun,
        sourceApp: null,
        name: "live",
        providerStatus: "completed",
        providerConclusion: "success",
        category: SelectedPullRequestCheckCategory.Successful,
        createdAt: null,
        startedAt: null,
        completedAt: null,
        targetUrl: null,
      },
    ],
    counts: {
      providerExpected: 1,
      providerReturned: 1,
      normalizedAttempts: 1,
      emitted: 1,
      total: 1,
      successful: 1,
      failing: 0,
      pending: 0,
      neutral: 0,
    },
    pagination: {
      pageSize: 50,
      pagesFetched: 1,
      acquisitionMaximum: 10,
      reachedAcquisitionMaximum: false,
    },
    history: {
      mode: SelectedPullRequestChecksHistoryMode.LatestPerSourceFromProviderRollup,
      providerLimit: null,
      rawAttempts: 1,
      emittedSources: 1,
    },
    coverage: {
      completeness: SelectedPullRequestChecksCompleteness.Complete,
      reasons: [],
    },
  });
}

/** The sentence the component renders for a short population of `rows` of `totalCount`. */
function shortfallOf({
  totalCount,
  rows,
}: {
  totalCount: number;
  rows: number;
}): string {
  const sentence = checksPopulationShortfall({
    truncated: false,
    totalCount,
    items: Array.from({ length: rows }, () => null),
  });
  if (!sentence) {
    throw new Error("fixture is a whole population, so it states no shortfall");
  }
  return sentence;
}
