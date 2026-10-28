import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import {
  ArtifactRefMethod,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECONCILE_COVERAGE_GAP_BATCH,
  RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS,
} from "../constants";
import { DELIVERY_COVERAGE_LOC_FIELDS } from "../delivery-coverage-predicate";

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return {
    ...actual,
    withDb: vi.fn(),
  };
});

import {
  selectCoverageGapPullRequestTargets,
  selectSessionLinkedPullRequestTargets,
} from "../session-linked-targets";

// Every `prd.<column> IS NULL` conjunct the rendered query carries, so the
// stub-arm assertion can compare the whole set rather than one column at a
// time (useTopLevelRegex).
const PRD_IS_NULL_CONJUNCT_RE = /prd\.\w+ IS NULL/g;
const NOW = new Date("2026-08-26T12:00:00.000Z");
const DEFAULT_INPUT = {
  organizationId: "00000000-0000-0000-0000-000000000001",
  repositoryId: "11111111-1111-1111-1111-111111111111",
  repositoryFullName: "Acme/Widgets",
  now: NOW,
};

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn>;
const queryRaw = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // ISS-8423: the selector now draws two DISJOINT batches — the stub cohort
  // first, then the ordinary arms. One row cannot satisfy both predicates, so
  // the default fixture is an empty stub cohort and one ordinary row.
  queryRaw.mockReset();
  queryRaw.mockResolvedValueOnce([]);
  queryRaw.mockResolvedValue([
    { id: "pr-detail-1", branchArtifactId: "branch-1", number: 17 },
  ]);
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) =>
    fn({ $queryRaw: queryRaw })
  );
});

describe("selectSessionLinkedPullRequestTargets", () => {
  it("enumerates PR rows through exact command-derived session PR metadata", async () => {
    const targets = await selectSessionLinkedPullRequestTargets(DEFAULT_INPUT);
    // The ORDINARY batch (call 1). Both batches share this body; this one is
    // where the undiminished `25` still appears, because the stub cohort drew
    // nothing here — which is itself the contract: an empty stub cohort must
    // leave the whole batch to the tail, not the reserve.
    const { text, values } = capturedQuery(1);

    expect(targets).toEqual([
      {
        pullRequestDetailId: "pr-detail-1",
        branchArtifactId: "branch-1",
        number: 17,
      },
    ]);
    expect(text).toContain("FROM pull_request_detail prd");
    expect(text).toContain("INNER JOIN artifacts branch");
    expect(text).toContain("INNER JOIN session_detail session");
    expect(text).toContain("AND EXISTS");
    expect(text).toContain("prd.repository_id =");
    expect(text).toContain("prd.repository_id IS NULL");
    expect(text).toContain("jsonb_array_elements");
    expect(values).toEqual(
      expect.arrayContaining([
        DEFAULT_INPUT.organizationId,
        DEFAULT_INPUT.repositoryId,
        "acme/widgets",
        ArtifactType.Branch,
        ArtifactType.Session,
        LinkType.RelatesTo,
        BranchParticipationKind.Wrote,
        // ISS-8462: the ordinary batch's tier-2 arm reads the durable
        // `desktop_originated` column, which binds no parameter, and keeps this
        // literal OR'd beside it as the rollout compatibility shim.
        GitHubFetchMechanism.DesktopSync,
        SessionArtifactLinkKind.SessionPr,
        SessionArtifactLinkKind.SessionPrSet,
        SessionArtifactLinkKind.SessionBranch,
        SessionArtifactLinkKind.SessionPrProse,
        25,
      ])
    );
  });

  it("scopes repo-less tier-2 rows by normalized full name", async () => {
    await selectSessionLinkedPullRequestTargets({
      ...DEFAULT_INPUT,
      repositoryId: null,
      repositoryFullName: " Acme/Widgets ",
    });
    const { text, values } = capturedQuery();

    expect(text).toContain("prd.repository_id IS NULL");
    expect(text).toContain("prd.repository_full_name =");
    expect(values).toContain("acme/widgets");
  });

  it("includes repo-less rows when tier 2 retains a historical repository id", async () => {
    await selectSessionLinkedPullRequestTargets(DEFAULT_INPUT);
    const { text, values } = capturedQuery();

    expect(text).toContain("prd.repository_id =");
    expect(text).toContain("OR (");
    expect(text).toContain("prd.repository_id IS NULL");
    expect(text).toContain("prd.repository_full_name =");
    expect(values).toEqual(
      expect.arrayContaining([DEFAULT_INPUT.repositoryId, "acme/widgets"])
    );
  });

  it("excludes prose-derived PR identities from the exact target predicate", async () => {
    await selectSessionLinkedPullRequestTargets(DEFAULT_INPUT);
    const { text, values } = capturedQuery();

    expect(text).toContain("link.metadata ? 'method'");
    expect(text).toContain("pr_ref.value ? 'method'");
    expect(values).toEqual(
      expect.arrayContaining([
        ArtifactRefMethod.PrMentionInProse,
        ArtifactRefMethod.BranchMentionInProse,
      ])
    );
  });

  it("bounds JSON PR-number comparisons before numeric casts", async () => {
    await selectSessionLinkedPullRequestTargets(DEFAULT_INPUT);
    const { text, values } = capturedQuery();

    expect(text).toContain("::bigint <=");
    expect(text).toContain("::bigint = prd.number");
    expect(text).not.toContain("::int = prd.number");
    expect(values).toContain(POSTGRES_INT4_MAX);
  });

  // Query SHAPE only — `withDb` is mocked here, so nothing below proves which
  // rows the predicate admits. The behavior is pinned against Postgres by
  // `__tests__/integration/iss8423-factless-pr-stub.integration.test.ts`.
  it("builds the attempt debounce with a factless desktop-stub exemption", async () => {
    await selectSessionLinkedPullRequestTargets(DEFAULT_INPUT);
    const { text, values } = capturedQuery();
    const staleBefore = new Date(
      NOW.getTime() - RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS
    );

    expect(text).toContain("prd.last_refresh_attempt_at <");
    // ISS-8423: the exemption keys on the fact-emptiness the desktop lane
    // leaves behind. It used to key on `prd.last_verified_at IS NULL`, which the
    // same lane's unconditional stamp made unsatisfiable — that predicate must
    // not come back.
    //
    // The EXACT set, not a `toContain` per column and a `not.toContain` per
    // exclusion (ISS-8175). Equality is the only shape that fails BOTH ways:
    // per-column assertions catch a DROPPED column, but a column ADDED to the
    // conjunction matches no assertion and lands silently — and the exclusion
    // list can only ever name the keys someone thought of. `html_url` had no
    // assertion at all under that shape, and no future key would either.
    //
    // Still not derived from DESKTOP_PR_FETCHABLE_FACT_COLUMNS: a test reading
    // the same map the query renders from stays green whatever the map says.
    // Absences worth naming, since equality states them only by omission:
    // `pr_state`/`is_draft` are NOT NULL with defaults, so an IS NULL on them
    // can never be true and would make the whole arm unsatisfiable (whitlockk
    // review); `base_ref_name` is nullable and a fetch DOES fill it, and is out
    // only because the shared map withholds it — a row holding just a base ref
    // is still the stub this arm repairs, so adding it here would narrow the
    // arm until that row never drained (ISS-8175). `repository_id` is the
    // repo-scope branch, not the stub conjunction.
    expect(
      [...text.matchAll(PRD_IS_NULL_CONJUNCT_RE)].map((m) => m[0]).sort()
    ).toEqual([
      "prd.additions IS NULL",
      "prd.changed_files IS NULL",
      "prd.closed_at IS NULL",
      "prd.deletions IS NULL",
      "prd.last_refresh_attempt_at IS NULL",
      "prd.merged_at IS NULL",
      "prd.repository_id IS NULL",
      "prd.title IS NULL",
    ]);
    expect(text).toContain("prd.fetch_mechanism =");
    expect(values).toContainEqual(staleBefore);
    expect(values).toContain(GitHubFetchMechanism.DesktopSync);
  });

  // Query SHAPE only, like the suite above it. Which rows the two predicates
  // admit across a reconcile is pinned against Postgres by
  // `__tests__/integration/iss8462-desktop-origin-reconcile-selector.integration.test.ts`.
  it("admits desktop stubs on durable origin while the shorter stub window still keys on the last writer", async () => {
    await selectSessionLinkedPullRequestTargets(DEFAULT_INPUT);
    const stubBatch = capturedQuery();
    const ordinaryBatch = capturedQuery(1);

    // ISS-8462: the target arm must read durable origin, because
    // `fetch_mechanism` is what a successful reconcile overwrites to `graphql`
    // — that is what dropped a refreshed desktop row out of the selector
    // permanently.
    expect(ordinaryBatch.text).toContain("prd.desktop_originated");
    // …and must keep the mechanism literal OR'd beside it as the rollout
    // compatibility shim (chatgpt-codex-connector review on #6214): an old API
    // instance still writing `desktop_sync` rows during the deploy window
    // leaves the column false, and without this the arm drops those rows on
    // their first tick. Removing it needs explicit human approval.
    expect(ordinaryBatch.text).toContain("prd.fetch_mechanism =");
    expect(ordinaryBatch.values).toContain(GitHubFetchMechanism.DesktopSync);
    // The ISS-8423 stub cohort is deliberately NOT moved onto durable origin:
    // its shorter window is for rows the DESKTOP lane last left factless, and
    // keying it on origin would newly admit provider-written factless rows to
    // the 1h retry — the widening AC-3 forbids.
    expect(stubBatch.text).toContain("prd.fetch_mechanism =");
    expect(stubBatch.values).toContain(GitHubFetchMechanism.DesktopSync);
  });

  // ISS-8423 (whitlockk + davetho review, Perrin's call 2026-08-28): the stub arm
  // sorts first, so without a floor it can take the whole batch on every tick.
  // The limits below are spelled out rather than computed from
  // RECONCILE_VERIFIED_TAIL_BATCH_RESERVE — a probe derived from the constant
  // under test would follow it to any value, including one that starves the
  // tail again.
  it("caps the stub batch and leaves the tail its reserved rows", async () => {
    // A saturated stub cohort: the stub query fills its whole allowance.
    queryRaw.mockReset();
    queryRaw.mockResolvedValueOnce(
      Array.from({ length: 12 }, (_, index) => ({
        id: `stub-${index}`,
        branchArtifactId: "branch-1",
        number: index,
      }))
    );
    queryRaw.mockResolvedValue([]);

    await selectSessionLinkedPullRequestTargets(DEFAULT_INPUT);

    expect(queryRaw).toHaveBeenCalledTimes(2);
    // `LIMIT ${limit}` is the last interpolation in the statement.
    expect(capturedQuery(0).values.at(-1)).toBe(12);
    expect(capturedQuery(1).values.at(-1)).toBe(13);
  });

  it("hands the ordinary arms whatever the stub cohort did not use", async () => {
    queryRaw.mockReset();
    queryRaw.mockResolvedValueOnce([
      { id: "stub-1", branchArtifactId: "branch-1", number: 1 },
    ]);
    queryRaw.mockResolvedValue([]);

    await selectSessionLinkedPullRequestTargets(DEFAULT_INPUT);

    expect(capturedQuery(1).values.at(-1)).toBe(24);
  });

  it("draws the stub cohort against a predicate the ordinary arms exclude", async () => {
    await selectSessionLinkedPullRequestTargets(DEFAULT_INPUT);
    const stubQuery = capturedQuery(0).text.replaceAll(/\s+/g, " ");

    // The subtraction is what keeps the two batches disjoint, so a row both
    // arms admit is charged to the ordinary batch and cannot appear twice.
    expect(stubQuery).toContain(
      "AND NOT ( prd.last_refresh_attempt_at IS NULL"
    );
    // ...and the ordinary batch carries no stub predicate at all.
    expect(capturedQuery(1).text).not.toContain("prd.title IS NULL");
  });

  it("runs one query and no stub draw when the attempt debounce is ignored", async () => {
    // Deliberately NO `limit` override: at `limit: 1` the stub budget is 0
    // anyway, so `stubBudget === 0` short-circuits the draw on its own and this
    // case stayed green with the `ignoreAttemptDebounce` arm deleted. At the
    // full batch the budget is 12, so only that arm can suppress the query.
    await selectSessionLinkedPullRequestTargets({
      ...DEFAULT_INPUT,
      ignoreAttemptDebounce: true,
    });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(capturedQuery(0).values.at(-1)).toBe(25);
  });

  it("scopes on-demand refresh to one exact branch PR without debounce filtering", async () => {
    await selectSessionLinkedPullRequestTargets({
      ...DEFAULT_INPUT,
      branchArtifactId: "22222222-2222-4222-8222-222222222222",
      pullRequestDetailId: "33333333-3333-4333-8333-333333333333",
      ignoreAttemptDebounce: true,
      limit: 1,
    });
    const { text, values } = capturedQuery();
    const normalizedSql = text.replaceAll(/\s+/g, " ");

    expect(normalizedSql).toContain(
      "AND prd.branch_artifact_id = $::uuid AND branch.id = $::uuid AND prd.id = $::uuid"
    );
    expect(text).not.toContain("prd.last_refresh_attempt_at <");
    expect(values).toEqual(
      expect.arrayContaining([
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
        1,
      ])
    );
  });
});

describe("selectCoverageGapPullRequestTargets", () => {
  beforeEach(() => {
    // This selector draws ONE batch, unlike the two-arm targeted selector whose
    // fixture above primes an empty stub cohort first.
    queryRaw.mockReset();
    queryRaw.mockResolvedValue([
      { id: "pr-detail-9", branchArtifactId: "branch-9", number: 9 },
    ]);
  });

  it("selects only rows the delivery-coverage numerator does not count", async () => {
    const targets = await selectCoverageGapPullRequestTargets(DEFAULT_INPUT);
    const { text } = capturedQuery();
    const normalizedSql = text.replaceAll(/\s+/g, " ");

    expect(targets).toEqual([
      {
        pullRequestDetailId: "pr-detail-9",
        branchArtifactId: "branch-9",
        number: 9,
      },
    ]);
    // `isDeliveryCoverageCovered` is `hasCompleteLoc || isCurrent`, so its
    // negation needs BOTH halves. Dropping `NOT prd.is_current` would select
    // rows the ratio already counts and spend a provider read on each.
    expect(normalizedSql).toContain("NOT prd.is_current");
    // The LOC disjuncts come from the shared field map, so this compares against
    // that map rather than a second copy of the column names.
    for (const { column } of DELIVERY_COVERAGE_LOC_FIELDS) {
      expect(normalizedSql).toContain(`prd.${column} IS NULL`);
    }
    expect(normalizedSql).toContain(
      DELIVERY_COVERAGE_LOC_FIELDS.map(
        ({ column }) => `prd.${column} IS NULL`
      ).join(" OR ")
    );
  });

  it("requires command-derived session PR evidence", async () => {
    await selectCoverageGapPullRequestTargets(DEFAULT_INPUT);
    const { text } = capturedQuery();

    // A repo-history row with no session link behind it is not this arm's
    // business; admitting one would turn a coverage heal into an unbounded
    // history refresh.
    expect(text).toContain("INNER JOIN session_detail session");
    expect(text).toContain("FROM artifact_links link");
    expect(text).toContain("'linkKind' = $");
  });

  it("does NOT compose the desktop-origin arm the targeted selector uses", async () => {
    // The monitored ratio reads its links with `sessionPrLinkFromSessions`,
    // whose Metric audience admits `session_pr`/`session_pr_set` only — so a
    // desktop-synced row carrying just a `session_branch` link is NOT in the
    // denominator. Measured on a real Postgres in the ISS-12034 integration
    // suite: that row reports `sessionLinkedPrCount: 0`. Selecting it here
    // would buy a provider read per tick for coverage no series watches.
    await selectCoverageGapPullRequestTargets(DEFAULT_INPUT);
    const gapSql = capturedQuery().text;

    expect(gapSql).not.toContain("prd.desktop_originated");

    // Positive control: the arm this one excludes really is what the TARGETED
    // selector composes, so the assertion above is a difference between the two
    // selectors rather than a predicate that exists in neither.
    queryRaw.mockReset();
    queryRaw.mockResolvedValue([]);
    await selectSessionLinkedPullRequestTargets(DEFAULT_INPUT);
    expect(capturedQuery().text).toContain("prd.desktop_originated");
  });

  it("debounces by the shared per-PR attempt clock", async () => {
    await selectCoverageGapPullRequestTargets(DEFAULT_INPUT);
    const { text, values } = capturedQuery();

    expect(text).toContain("prd.last_refresh_attempt_at IS NULL");
    expect(text).toContain("prd.last_refresh_attempt_at <");
    expect(values).toContainEqual(
      new Date(NOW.getTime() - RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS)
    );
  });

  it("bounds the batch at its own constant and floors an invalid limit at 1", async () => {
    await selectCoverageGapPullRequestTargets(DEFAULT_INPUT);
    expect(capturedQuery(0).values.at(-1)).toBe(RECONCILE_COVERAGE_GAP_BATCH);

    await selectCoverageGapPullRequestTargets({ ...DEFAULT_INPUT, limit: 0 });
    expect(capturedQuery(1).values.at(-1)).toBe(1);
  });

  it("scopes a repo-less tier-2 row by normalized full name", async () => {
    await selectCoverageGapPullRequestTargets({
      ...DEFAULT_INPUT,
      repositoryId: null,
    });
    const { text, values } = capturedQuery();

    expect(text).toContain("prd.repository_id IS NULL");
    expect(values).toContain("acme/widgets");
  });
});

function capturedQuery(call = 0): { text: string; values: unknown[] } {
  const query = queryRaw.mock.calls[call]?.[0] as {
    strings?: readonly string[];
    values?: readonly unknown[];
    sql?: string;
    text?: string;
  };
  return {
    text: query.strings?.join("$") ?? query.sql ?? query.text ?? String(query),
    values: Array.from(query.values ?? []),
  };
}

const POSTGRES_INT4_MAX = 2_147_483_647;
