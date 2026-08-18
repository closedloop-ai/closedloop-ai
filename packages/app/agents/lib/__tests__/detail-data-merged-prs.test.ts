/**
 * ISS-4798 — the "Merged PRs" card reads the value the API computed.
 *
 * The card used to recount client-side over `detail.branchesTab`
 * (`filter(b => b.prState === "MERGED").length`). That tab is not hydrated with
 * PR state — every row carries `prState: null` — so the recount could only ever
 * return 0, and the card rendered a hard `0` for a component whose API payload
 * said `mergedPrs: 42`. A zero that means "not hydrated" is the lie this pins.
 */
import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";
import { componentMetrics } from "../detail-data";

function makeDetail(
  overrides: Partial<AgentComponentDetail>
): AgentComponentDetail {
  return {
    id: "id",
    slug: "tool::_create_pull_request",
    name: "_create_pull_request",
    kind: AgentComponentKind.Tool,
    invocations: 61,
    sessions: 55,
    locPerDollar: null,
    mergedPrs: null,
    branchesTab: [],
    ...overrides,
    // A partial cast is acceptable for a test fixture; componentMetrics only
    // reads the fields set above.
  } as AgentComponentDetail;
}

/**
 * A branch row exactly as the detail payload carries it: PR state unhydrated.
 * `BranchRow` is declared but not exported by the types module, so the element
 * type is taken from the field that holds it.
 */
type DetailBranchRow = AgentComponentDetail["branchesTab"][number];
const unhydratedBranch = { prState: null, additions: null } as DetailBranchRow;

const mergedCardValue = (detail: AgentComponentDetail): string | undefined =>
  componentMetrics(detail).find((metric) => metric.key === "merged")?.value;

describe("componentMetrics Merged PRs (ISS-4798)", () => {
  /**
   * The regression proper: this is the exact production shape — a real
   * `mergedPrs` alongside branch rows whose `prState` never hydrated. Before the
   * fix this rendered "0".
   */
  it("renders the API's mergedPrs when the branch rows carry no PR state", () => {
    const detail = makeDetail({
      mergedPrs: 42,
      branchesTab: Array.from({ length: 88 }, () => unhydratedBranch),
    });

    expect(mergedCardValue(detail)).toBe("42");
  });

  it("does not recount from branchesTab when the two disagree", () => {
    const detail = makeDetail({
      mergedPrs: 42,
      branchesTab: [{ prState: "MERGED" } as DetailBranchRow],
    });

    expect(mergedCardValue(detail)).toBe("42");
  });

  it("shows an em-dash, not a fabricated 0, when mergedPrs is not computable", () => {
    const detail = makeDetail({
      mergedPrs: null,
      branchesTab: [unhydratedBranch],
    });

    expect(mergedCardValue(detail)).toBe("—");
  });

  it("still shows a real zero when the API measured zero merged PRs", () => {
    expect(mergedCardValue(makeDetail({ mergedPrs: 0 }))).toBe("0");
  });

  it("formats a large count with thousands separators", () => {
    expect(mergedCardValue(makeDetail({ mergedPrs: 1234 }))).toBe("1,234");
  });

  /**
   * wongk (PR #4322): an older API OMITS `mergedPrs` rather than sending null.
   * The card's formatter must not hand `undefined` to `Intl.NumberFormat`, which
   * renders the literal "NaN".
   */
  it("shows the dash, not NaN, when the payload omits mergedPrs entirely", () => {
    const skewed = makeDetail({});
    Reflect.deleteProperty(skewed, "mergedPrs");

    expect(mergedCardValue(skewed)).toBe("—");
  });
});

/**
 * ISS-4798 — the two cards beside Merged PRs are fed by the SAME unhydrated
 * `branchesTab`, so they told the same lie one card over: the API hardcodes
 * `additions: null` and `estimatedCostUsd: null` on every branch row it emits,
 * and the desktop detail sends `branchesTab: []`. Summed with `?? 0` they could
 * only ever reduce to 0, so a subagent read "42 merged PRs, 0 lines shipped,
 * $0.00 spent" — a row contradicting itself.
 */
describe("componentMetrics unhydrated branch aggregates (ISS-4798)", () => {
  const subagent = (
    branchesTab: AgentComponentDetail["branchesTab"]
  ): AgentComponentDetail =>
    makeDetail({
      kind: AgentComponentKind.Subagent,
      mergedPrs: 42,
      branchesTab,
    });

  const cardValue = (
    detail: AgentComponentDetail,
    key: string
  ): string | undefined =>
    componentMetrics(detail).find((metric) => metric.key === key)?.value;

  it("dashes Lines shipped when no branch row carries additions", () => {
    expect(
      cardValue(subagent([unhydratedBranch, unhydratedBranch]), "lines")
    ).toBe("—");
  });

  it("dashes Total cost when no branch row carries a cost", () => {
    expect(cardValue(subagent([unhydratedBranch]), "cost")).toBe("—");
  });

  it("dashes both on the desktop's empty branchesTab", () => {
    // `branchesTab: []` has not measured zero lines, it has measured nothing.
    const detail = subagent([]);

    expect(cardValue(detail, "lines")).toBe("—");
    expect(cardValue(detail, "cost")).toBe("—");
  });

  it("still sums the rows that ARE hydrated", () => {
    const detail = subagent([
      { additions: 120, estimatedCostUsd: 1.5 } as DetailBranchRow,
      { additions: 30, estimatedCostUsd: 2.25 } as DetailBranchRow,
      unhydratedBranch,
    ]);

    expect(cardValue(detail, "lines")).toBe("150");
    expect(cardValue(detail, "cost")).toBe("$3.75");
  });

  it("still reports a genuinely measured zero", () => {
    const detail = subagent([
      { additions: 0, estimatedCostUsd: 0 } as DetailBranchRow,
    ]);

    expect(cardValue(detail, "lines")).toBe("0");
    expect(cardValue(detail, "cost")).toBe("$0.00");
  });

  /**
   * The Merged PRs card counts the whole session cohort while the Branches tab
   * below it lists only unhydrated rows, so the card must say which population
   * it counts or the two look like they disagree.
   */
  it("labels the population the Merged PRs card counts", () => {
    const card = componentMetrics(subagent([unhydratedBranch])).find(
      (metric) => metric.key === "merged"
    );

    expect(card?.info?.what).toContain("session");
    // ISS-6462: the population clause is now its own sentence in the two
    // caveated states (a trailing "not over the branch rows" would attach to
    // whatever noun the caveat ended on), so the assertion matches the phrase
    // rather than the old comma-spliced wording.
    expect(card?.info?.how).toContain("not the branch rows listed below");
  });
});
