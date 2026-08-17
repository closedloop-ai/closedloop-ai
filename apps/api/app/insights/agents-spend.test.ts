/**
 * Focused unit tests for the ISS-4463 Agents-section spend breakdowns.
 *
 * The contract under test is the honesty of the split and the fusion, not the
 * SQL text: both spend charts come out of ONE statement (so a concurrent sync
 * cannot make the siblings disagree inside one response), every read emits all
 * FOUR outcome buckets in a fixed order, a session that has not ended is never
 * given an "ended" verdict, and the buckets conserve the period's total spend to
 * the cent.
 *
 * Kept out of the shrink-only grandfathered `service.test.ts`: this drives
 * `fetchAgentsSpendBreakdowns` directly with a minimal `withDb` fake and needs
 * none of that file's heavy harness.
 */

import { SpendOutcome } from "@closedloop-ai/loops-api/insights";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: Array.from(strings),
      values,
    }),
  },
}));

import { withDb } from "@repo/database";
import { fetchAgentsSpendBreakdowns } from "./agents-spend";

const SCOPE_SQL = { strings: ["a.organization_id = $1"], values: ["org-1"] };
const START = new Date("2026-01-01T00:00:00.000Z");
const END = new Date("2026-01-31T00:00:00.000Z");

type BreakdownRow = {
  field: "model" | "outcome";
  model: string | null;
  outcome: string | null;
  cost: number;
};

/** An outcome-grouping row of the fused scan. */
function outcomeRow(outcome: string, cost: number): BreakdownRow {
  return { field: "outcome", model: null, outcome, cost };
}

/** A model-grouping row of the fused scan. */
function modelRow(model: string, cost: number): BreakdownRow {
  return { field: "model", model, outcome: null, cost };
}

/**
 * Drive `fetchAgentsSpendBreakdowns` against a `$queryRaw` returning `rows`,
 * capturing every query issued so a test can assert the emitted buckets, the
 * read shape, AND the round-trip count from one run.
 */
async function runSpendBreakdowns(rows: BreakdownRow[]) {
  const queries: unknown[] = [];
  const db = {
    $queryRaw: (query: unknown) => {
      queries.push(query);
      return Promise.resolve(rows);
    },
  };
  vi.mocked(withDb).mockImplementation((cb) =>
    Promise.resolve(cb(db as never))
  );
  const breakdowns = await fetchAgentsSpendBreakdowns(
    SCOPE_SQL as never,
    START,
    END
  );
  return { ...breakdowns, queries };
}

describe("fetchAgentsSpendBreakdowns", () => {
  it("splits spend across ended-clean, ended-with-error, still-running and not-recorded", async () => {
    const { spendByOutcome } = await runSpendBreakdowns([
      outcomeRow(SpendOutcome.Clean, 120.5),
      outcomeRow(SpendOutcome.Errored, 30.25),
      outcomeRow(SpendOutcome.Running, 12),
      outcomeRow(SpendOutcome.Unknown, 9.25),
    ]);

    expect(spendByOutcome).toEqual([
      { key: SpendOutcome.Clean, label: "Ended clean", value: 120.5 },
      { key: SpendOutcome.Errored, label: "Ended with error", value: 30.25 },
      { key: SpendOutcome.Running, label: "Still running", value: 12 },
      { key: SpendOutcome.Unknown, label: "Not recorded", value: 9.25 },
    ]);
  });

  it("never gives a still-running session an ended verdict", async () => {
    // The regression this bucket exists for: the desktop stamps a non-null
    // `ends_with_error = 0` on ACTIVE rows and syncs that `false` to the cloud,
    // so an in-flight session reaching the old two-verdict split was reported as
    // "Ended clean" — a terminal claim about a session that had not ended and
    // could still fail.
    const { spendByOutcome } = await runSpendBreakdowns([
      outcomeRow(SpendOutcome.Running, 77),
    ]);

    const spendFor = (key: string) =>
      spendByOutcome.find((bucket) => bucket.key === key)?.value;
    expect(spendFor(SpendOutcome.Running)).toBe(77);
    expect(spendFor(SpendOutcome.Clean)).toBe(0);
    expect(spendFor(SpendOutcome.Errored)).toBe(0);
  });

  it("keeps a never-recorded outcome in its own bucket rather than folding it into clean", async () => {
    const { spendByOutcome } = await runSpendBreakdowns([
      outcomeRow(SpendOutcome.Unknown, 42),
    ]);

    const spendFor = (key: string) =>
      spendByOutcome.find((bucket) => bucket.key === key)?.value;
    expect(spendFor(SpendOutcome.Unknown)).toBe(42);
    // The whole point of the four-state split: spend whose outcome was never
    // captured is not quietly attributed to either verdict.
    expect(spendFor(SpendOutcome.Clean)).toBe(0);
    expect(spendFor(SpendOutcome.Errored)).toBe(0);
  });

  it("degrades an unrecognised outcome value to not-recorded rather than minting a bucket", async () => {
    // Raw-query rows are asserted, not proven. An unknown literal must not reach
    // the client as a bucket key with no label or colour behind it.
    const { spendByOutcome } = await runSpendBreakdowns([
      outcomeRow("something-new", 5),
    ]);

    expect(spendByOutcome.map((bucket) => bucket.key)).toEqual([
      SpendOutcome.Clean,
      SpendOutcome.Errored,
      SpendOutcome.Running,
      SpendOutcome.Unknown,
    ]);
    expect(
      spendByOutcome.find((bucket) => bucket.key === SpendOutcome.Unknown)
        ?.value
    ).toBe(5);
  });

  it("emits all four buckets in a stable order even when the period has no spend", async () => {
    const { spendByOutcome } = await runSpendBreakdowns([]);

    expect(spendByOutcome.map((bucket) => bucket.key)).toEqual([
      SpendOutcome.Clean,
      SpendOutcome.Errored,
      SpendOutcome.Running,
      SpendOutcome.Unknown,
    ]);
    // A period with no spend is a real, measured zero — not an omission — so the
    // buckets are present and zero rather than absent.
    expect(spendByOutcome.every((bucket) => bucket.value === 0)).toBe(true);
  });

  it("allocates cents so the buckets conserve the period's total spend exactly", async () => {
    // Three sub-cent buckets: rounding each independently would report $0.03 of
    // spend where only $0.012 was spent. Largest-remainder allocation against the
    // true total keeps the parts summing to the whole.
    const { spendByOutcome } = await runSpendBreakdowns([
      outcomeRow(SpendOutcome.Clean, 0.004),
      outcomeRow(SpendOutcome.Errored, 0.004),
      outcomeRow(SpendOutcome.Running, 0.004),
    ]);

    const total = spendByOutcome.reduce((sum, b) => sum + b.value, 0);
    expect(total).toBeCloseTo(0.01, 10);
  });

  it("conserves the total for ordinary multi-bucket spend too", async () => {
    // Each bucket's exact value ends in a third decimal that floors away, so
    // independent per-bucket rounding would report $30.99 against $31.00 of
    // spend. The leftover cent is allocated instead of discarded.
    const { spendByOutcome } = await runSpendBreakdowns([
      outcomeRow(SpendOutcome.Clean, 10.333),
      outcomeRow(SpendOutcome.Errored, 10.333),
      outcomeRow(SpendOutcome.Running, 10.334),
    ]);

    const total = spendByOutcome.reduce((sum, b) => sum + b.value, 0);
    expect(total).toBeCloseTo(31, 10);
  });

  it("reads both spend breakdowns from ONE statement so the siblings share a snapshot", async () => {
    // wongk (#4282): two separate reads are two implicit transactions, and a
    // session sync landing between them makes the two charts disagree inside a
    // single response. One statement is one MVCC snapshot by construction.
    const { queries, modelBreakdown, spendByOutcome } =
      await runSpendBreakdowns([
        modelRow("sonnet", 10),
        outcomeRow(SpendOutcome.Clean, 10),
      ]);

    expect(queries).toHaveLength(1);
    expect(modelBreakdown).toHaveLength(1);
    expect(spendByOutcome).toHaveLength(4);
  });

  it("ranks the model breakdown by spend, descending, rounded to cents", async () => {
    const { modelBreakdown } = await runSpendBreakdowns([
      modelRow("haiku", 1.006),
      modelRow("opus", 40),
      modelRow("sonnet", 12.5),
    ]);

    expect(modelBreakdown).toEqual([
      { key: "opus", label: "opus", value: 40 },
      { key: "sonnet", label: "sonnet", value: 12.5 },
      { key: "haiku", label: "haiku", value: 1.01 },
    ]);
  });

  it("scopes the read to the caller's window and scope predicate", async () => {
    const { queries } = await runSpendBreakdowns([]);

    expect(queries).toHaveLength(1);
    const query = queries[0] as { values: unknown[] };
    expect(query.values).toContain(START);
    expect(query.values).toContain(END);
    expect(query.values).toContain(SCOPE_SQL);
  });
});
