/**
 * Agents workspace — component detail reshape helpers (T-1.3).
 *
 * Ports the detail-data reshape helpers from the prototype
 * (`apps/prototypes/app/p/agents/detail-data.ts`) DECOUPLED from direct mock
 * imports. All functions accept their inputs as typed parameters; callers
 * supply data from the `AgentComponentsDataSource` seam rather than the
 * prototype's inline mock.
 *
 * This file has NO imports from `apps/prototypes/` or mock data modules.
 *
 * @see packages/app/agents/lib/session-table-row.ts for the shared
 *   AgentSessionListItem → SessionTableRow mapper used by sessionsFor().
 */

import type {
  AgentComponent,
  AgentComponentDetail,
} from "@repo/api/src/types/agent-component";
import {
  AgentComponentKind,
  isLocPerDollarVerifiableKind,
} from "@repo/api/src/types/agent-component";
import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import {
  MergedPrsCoverage,
  resolveMergedPrsCoverage,
} from "@repo/api/src/types/analytics";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import type { SessionTableRow } from "@repo/app/agents/components/sessions/sessions-table";
import {
  agentSessionToSessionTableRow,
  resolveSessionRepoLabel,
  type SessionRowResolutionOptions,
} from "@repo/app/agents/lib/session-table-row";
import { formatLocPerDollar } from "@repo/app/shared/lib/format-utils";
import {
  cappedCohortScanCaveat,
  UNDECLARED_COHORT_COVERAGE_CAVEAT,
} from "@repo/app/shared/lib/merged-prs-coverage-copy";

// ---------------------------------------------------------------------------
// Formatting helper (mirrors NUMBER_FORMAT from component-meta.tsx — defined
// here independently so this file has no dependency on T-1.2 until it lands).
// ---------------------------------------------------------------------------

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

const METRIC_DASH = "—";

// ---------------------------------------------------------------------------
// ComponentMetric — the display-ready cards rendered above the Sessions /
// Branches tabs on the detail page.
// ---------------------------------------------------------------------------

export type ComponentMetric = {
  key: string;
  label: string;
  value: string;
  info?: { what: string; how?: string };
};

/**
 * Build the per-kind metric cards for the component detail page.
 *
 * Accepts a full `AgentComponentDetail` so it can derive PR / cost / lines
 * metrics from `detail.branchesTab` (pre-fetched branch rows). In Phase 1
 * the stub source returns `[]` for `branchesTab`, yielding `0` for those
 * aggregate fields — the same safe fallback the prototype used when a
 * component had no associated branches.
 *
 * Returns `readonly ComponentMetric[]` matching the card variant used by
 * `agent-detail.tsx`'s metrics grid.
 */
export const componentMetrics = (
  detail: AgentComponentDetail,
  options: ComponentMetricsOptions = {}
): readonly ComponentMetric[] => {
  const honest = options.honest ?? false;
  const branches = detail.branchesTab;
  // ISS-4798: null-preserving, NOT `?? 0`. These reduce over the SAME
  // unhydrated `branchesTab` rows the Merged PRs card stopped trusting: the API
  // (`apps/api/app/agent-components/service/detail-session-tabs.ts`
  // `buildBranchesTab`) hardcodes `additions: null` and `estimatedCostUsd: null`
  // on every row it emits, and the desktop detail sends `branchesTab: []`
  // outright. Summing a `?? 0` over that could only ever produce 0, so the
  // subagent row rendered "0 lines shipped, $0.00 spent" beside a Merged PRs
  // card reading 42 — three cards off one payload, contradicting each other.
  // `sumOrNull` yields null when no row carried the value, so those two cards
  // show the same honest dash the Merged PRs card does instead of a
  // measurement nobody took.
  const linesShipped = sumOrNull(branches, (branch) => branch.additions);
  const totalCost = sumOrNull(branches, (branch) => branch.estimatedCostUsd);
  const avgPerSession =
    detail.invocations != null && detail.sessions != null && detail.sessions > 0
      ? Math.round(detail.invocations / detail.sessions)
      : null;

  // `Number.isFinite` rather than `value === null`: the payload is wire data, so
  // a version-skewed producer can OMIT one of these fields entirely, and
  // `Intl.NumberFormat.format(undefined)` renders the literal "NaN" on the card.
  // Anything that is not a real number is the same "not computable" state as an
  // explicit null and gets the same dash (ISS-4798).
  const numOrDash = (value: number | null | undefined): string =>
    typeof value === "number" && Number.isFinite(value)
      ? NUMBER_FORMAT.format(value)
      : METRIC_DASH;

  const locPerDollarCard: ComponentMetric = {
    key: "loc-per-dollar",
    label: LOC_PER_DOLLAR_LABEL,
    value: formatLocPerDollar(detail.locPerDollar),
    info: {
      // ISS-5366: "changed", not "merged". This renders the same
      // non-merge-scoped `locPerDollar` the Metric column does (see
      // POLISHED_METRIC_HEADER in agents-table.tsx); only the Sessions card's
      // `mergedLocPerDollar` earns the word "merged".
      what: "Lines changed per dollar across sessions that used it. Higher is better.",
      how: "A session-level metric, so read it as directional. One component doesn't cause it.",
    },
  };
  const invocationsCard: ComponentMetric = {
    key: "invocations",
    label: "Invocations",
    value: numOrDash(detail.invocations),
    info: { what: "Total calls attributed to this component in range." },
  };
  const sessionsCard: ComponentMetric = {
    key: "sessions",
    label: "Sessions",
    value: numOrDash(detail.sessions),
  };
  // ISS-4798: read the value the API already computed, NOT a client-side
  // recount over `branchesTab`. That recount was
  // `branches.filter(b => b.prState === "MERGED").length`, and the branch rows
  // on this payload carry `prState: null` (along with `prNumber`/`prUrl`) — the
  // tab is not hydrated with PR state — so the filter could only ever yield 0.
  // The card rendered a hard `0` over a component whose `mergedPrs` was 42: a
  // zero that meant "not hydrated". `numOrDash` keeps the honest third state —
  // a null `mergedPrs` (not computable) shows `—`, never a fabricated 0.
  // ISS-5521: the server counts distinct merged PRs over the FIRST
  // `COHORT_SCAN_CAP` cohort sessions (`cohort-performance.ts`), so on a
  // component with a larger cohort the figure is a floor over an arbitrary
  // insertion-ordered sample — while the copy below claimed "every session".
  //
  // The trailing `+` is this page's OWN partial-total convention, not a new
  // glyph: `detailTabTruncationReadout` marks a partial total the same way, and
  // the Branches tab one click below renders "Showing 50 of 50+ branches" off it.
  // A leading `≥` would be the only non-numeric character in the metric strip and
  // the eye stops on it as a symbol before reading it as a number — and NVDA at
  // default punctuation level drops `≥` outright, turning "at least 996" back
  // into "996" for exactly the reader who can least afford the difference.
  const mergedCountKnown =
    typeof detail.mergedPrs === "number" && Number.isFinite(detail.mergedPrs);
  // ISS-5521 (codex review, #4962): the producer either DECLARES its coverage or
  // says nothing. A response that omits the field is a server predating the
  // disclosure — which applied the same cap and simply could not report it — so
  // reading omission as `false` would restore the "every session" claim under
  // version skew. Three states, not two — and ISS-6462 moved that reading to
  // `resolveMergedPrsCoverage`, beside the contract, so the Packs tile decodes
  // the same field the same way.
  //
  // UNGATED (wongk, #5096 review). The `agents-detail-honesty` flag still owns
  // the unrelated card-dropping below, but not this: ISS-6462 gave the Packs
  // Performance tile the same disclosure with no flag on it, so on the DEFAULT
  // path one screen read "996+ (capped scan)" while this one read a bare "996"
  // under an "every session" claim — for the same response, the same cap, the
  // same component. A gate that leaves one of two surfaces asserting coverage it
  // does not have is not a closed-by-default rollout of a new capability; it is
  // half a defect. Removing a false claim is the ISS-4779 bug-fix exemption.
  const mergedCoverage = resolveMergedPrsCoverage(detail.mergedPrsTruncated);
  const mergedTruncated =
    mergedCoverage === MergedPrsCoverage.Capped && mergedCountKnown;
  const mergedCoverageUnknown =
    mergedCoverage === MergedPrsCoverage.Unknown && mergedCountKnown;
  const mergedCard: ComponentMetric = {
    key: "merged",
    label: "Merged PRs",
    // Only a DECLARED cap earns the `+`. An unknown coverage state is not
    // evidence the count was truncated, so inventing a floor marker would be the
    // same overstatement pointed the other way.
    value: mergedTruncated
      ? `${numOrDash(detail.mergedPrs)}+`
      : numOrDash(detail.mergedPrs),
    // ISS-4798: name the population. This counts distinct merged PRs across the
    // component's whole session cohort, while the Branches tab directly below
    // lists only the branch rows this response hydrated — which carry no PR
    // state, so every one of them reads "Open". Without this the card and the
    // table under it look like they disagree about the same set.
    info: mergedPopulationInfo({
      coverageUnknown: mergedCoverageUnknown,
      truncated: mergedTruncated,
    }),
  };

  // FEA-4052: the LOC/$ card renders ONLY for a kind with reliable per-component
  // attribution (currently only `subagent`; skill/command are session-level and
  // excluded — wongk, PR #3720). A non-verifiable kind (skill/command/plugin/mcp/
  // tool/…) always carries `locPerDollar: null` from the service; the card is
  // HIDDEN entirely rather than shown as a dead "—", matching the hidden column +
  // summary card on the inventory tabs.
  const leadingCards: ComponentMetric[] = isLocPerDollarVerifiableKind(
    detail.kind
  )
    ? [locPerDollarCard, invocationsCard, sessionsCard, mergedCard]
    : [invocationsCard, sessionsCard, mergedCard];

  if (detail.kind === AgentComponentKind.Subagent) {
    // ISS-5519: these two reduce over `branchesTab`, whose every row the server
    // hardcodes to `additions: null` / `estimatedCostUsd: null`
    // (`service/detail-session-tabs.ts` `buildBranchesTab`) and which the desktop
    // detail sends as `[]` — so `sumOrNull` can only ever return null and both
    // cards are permanently dashed on BOTH surfaces. Left rendered they sit
    // immediately beside `LOC / $`, whose value comes from an entirely separate
    // server-computed session-level metric, and read as its two unavailable
    // operands: the screen appears to divide two numbers it says it does not
    // have. The ratio is real; the operand reading is the lie. Drop a card that
    // has no measurement to report — exactly what FEA-4052 already does above
    // for the LOC/$ card on a non-verifiable kind, rather than showing a dead
    // "—". They return the moment the payload carries real values.
    const trailingCards: ComponentMetric[] = [];
    if (!honest || linesShipped !== null) {
      trailingCards.push({
        key: "lines",
        label: "Lines shipped",
        value: numOrDash(linesShipped),
      });
    }
    if (!honest || totalCost !== null) {
      trailingCards.push({
        key: "cost",
        label: "Total cost",
        // ISS-4798: `$${totalCost.toFixed(2)}` could not reach a dash — a cost
        // we never computed always printed "$0.00", the exact fabricated-measure
        // shape root AGENTS.md names. Formatting only a real number keeps the
        // unknown state reachable.
        value: totalCost === null ? METRIC_DASH : `$${totalCost.toFixed(2)}`,
      });
    }
    return [...leadingCards, ...trailingCards];
  }

  return [
    ...leadingCards,
    {
      key: "avg",
      label: "Avg / session",
      value: avgPerSession === null ? METRIC_DASH : String(avgPerSession),
    },
  ];
};

// ---------------------------------------------------------------------------
// detailFor — look up a component detail record from the caller-supplied
// array. In production the array is fetched from the data source; in the
// stub source it is the pre-built mock catalogue. Returns `undefined` when
// no matching id is found so callers can surface a 404.
// ---------------------------------------------------------------------------

/**
 * Find a component detail record by its stable `id` from a caller-supplied
 * list. Decoupled from any mock catalogue — the caller (hook or component)
 * supplies the records from the `AgentComponentsDataSource`.
 *
 * Returns `undefined` when the id is not found; callers should treat this
 * the same as a 404 from the data source.
 */
export const detailFor = (
  id: string,
  components: readonly AgentComponentDetail[]
): AgentComponentDetail | undefined =>
  components.find((component) => component.id === id);

// ---------------------------------------------------------------------------
// sessionsFor — map AgentSessionListItem rows to the presentational
// SessionTableRow shape accepted by sessions-table.tsx.
// ---------------------------------------------------------------------------

/**
 * Map a list of `AgentSessionListItem` records (from `detail.sessionsTab`)
 * to the `SessionTableRow[]` shape consumed by the shared `SessionsTable`
 * component.
 *
 * Accepts `component` for future filtering/sorting extensions but does not
 * use it for the mapping itself — the prototype's filtering logic (pack-mate
 * priority, SESSIONS_SHOWN cap) is not ported here because Phase-1 tab data
 * comes pre-fetched from the data source with server-side scoping.
 *
 * Returns `SessionTableRow[]` matching the type in
 * `packages/app/agents/components/sessions/sessions-table.tsx`.
 *
 * ISS-4979 (#4291 review): `durationOptions` is threaded from the render
 * boundary (`DetailSessionsTab`, which has hook access) rather than read here,
 * because this is a pure mapper — the same shape `toSessionTableRowWithSyncFold`
 * uses. This tab paints `row.durationLabel` through the SAME shared
 * `SessionsTable` the Sessions list uses, so leaving it on the default `{}`
 * would keep printing "0s" for a floored-span session whose own detail page
 * shows the em-dash: a lower-blast-radius instance of the same ISS-4631 split.
 */
export const sessionsFor = (
  _component: AgentComponent,
  sessions: readonly AgentSessionListItem[],
  rowOptions: SessionRowResolutionOptions = {}
): SessionTableRow[] =>
  sessions.map((session) =>
    agentSessionToSessionTableRow(
      session,
      resolveSessionRepoLabel(session),
      rowOptions
    )
  );

/**
 * Sum `select` across `rows`, preserving "not computable" as `null`.
 *
 * ISS-4798: the distinction a `?? 0` reduce destroys. A row whose value is
 * absent contributed nothing measurable — it is NOT a measured zero — so when no
 * row in the set carries a real number there is no total to report and the card
 * must show its dash rather than a fabricated 0. Rows that DO carry values still
 * sum normally, and an absent value among them contributes nothing, which is the
 * correct arithmetic for a partially-hydrated set.
 *
 * Returns `null` for empty `rows` for the same reason: an unhydrated tab
 * (`branchesTab: []`, which is what the desktop detail sends) has not measured
 * zero lines, it has measured nothing.
 */
function sumOrNull<T>(
  rows: readonly T[],
  select: (row: T) => number | null | undefined
): number | null {
  let total: number | null = null;
  for (const row of rows) {
    const value = select(row);
    if (typeof value === "number" && Number.isFinite(value)) {
      total = (total ?? 0) + value;
    }
  }
  return total;
}

/**
 * Caller-supplied switches for {@link componentMetrics}.
 *
 * ISS-5518/5519/5521 (ISS-4779 closed-by-default): `honest` is the render half
 * of the `agents-detail-honesty` flag — the web app resolves it through PostHog
 * and the desktop renderer through the byte-for-byte-equal Labs key, both
 * aliasing `AGENTS_DETAIL_HONESTY_FLAG_KEY`. Defaulting to `false` here (rather
 * than reading a hook) keeps this a pure mapper the tests and the Storybook
 * mounts can drive directly, and keeps every existing caller on the exact
 * pre-flag card set.
 */
export type ComponentMetricsOptions = {
  /**
   * When true: a "Lines shipped" / "Total cost" card with no measurement behind
   * it is dropped instead of rendering a dash beside a real ratio.
   *
   * ISS-6462 (wongk, #5096 review) took the Merged PRs coverage disclosure OUT
   * of this flag's scope. The Packs Performance tile discloses the same cap off
   * the same field with no gate, so gating it here left the default path with
   * two screens contradicting each other about one response. What remains behind
   * the flag is the card-dropping, which is a layout choice rather than a
   * correction to a false claim.
   */
  honest?: boolean;
};

/**
 * Tooltip copy for the "Merged PRs" card's population, in the three states the
 * payload can actually express.
 *
 * Extracted rather than nested-ternaried inline: Biome forbids nested ternaries,
 * and ISS-5521's whole point is that these are three DIFFERENT claims, so they
 * read better named than folded into the card literal.
 */
function mergedPopulationInfo({
  coverageUnknown,
  truncated,
}: {
  coverageUnknown: boolean;
  truncated: boolean;
}): NonNullable<ComponentMetric["info"]> {
  if (truncated) {
    return {
      // "At least" is the honest claim; the cap sentence itself is shared with
      // the Packs tile (ISS-6462), which owes the reader the same one.
      what: "At least this many distinct merged PRs across the sessions that used this component.",
      how: `${cappedCohortScanCaveat("component")} ${COUNTED_OVER_SESSIONS_NOT_BRANCHES}`,
    };
  }
  if (coverageUnknown) {
    return {
      what: "Distinct merged PRs across the sessions that used this component.",
      how: `${UNDECLARED_COHORT_COVERAGE_CAVEAT} ${COUNTED_OVER_SESSIONS_NOT_BRANCHES}`,
    };
  }
  return {
    what: "Distinct merged PRs across every session that used this component.",
    how: "Counted server-side over the full session cohort, not over the branch rows listed below.",
  };
}

/**
 * ISS-4798: which population this card counted.
 *
 * The Branches tab sits directly below and lists only the branch rows this
 * response hydrated — all of them `prState: null`, so all of them read "Open".
 * Without this the card and the table under it look like they disagree about the
 * same set.
 *
 * ISS-6462: the whole-cohort branch above still says it in ONE sentence, where
 * the population and the coverage claim are the same statement. The other two
 * branches lead with a coverage CAVEAT, so the population has to follow as its
 * own sentence — with an explicit subject, because a trailing "not over the
 * branch rows" would attach to whatever noun the caveat happened to end on.
 */
const COUNTED_OVER_SESSIONS_NOT_BRANCHES =
  "This count covers the session cohort, not the branch rows listed below.";
