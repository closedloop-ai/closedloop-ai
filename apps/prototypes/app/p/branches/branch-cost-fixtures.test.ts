import { describe, expect, it } from "vitest";
import { buildCanonicalCostEvidence } from "./branch-cost-fixtures";
import { branchRows } from "./mock";
import { buildBranchDetail } from "./mock-detail";

describe("canonical Branch cost fixtures", () => {
  it("preserves raw cost while conserving a shared Session through even split", () => {
    const evidence = buildCanonicalCostEvidence(branchRows);
    const shared = evidence.contributions.filter(({ sessionId }) =>
      sessionId.startsWith("session:shared-embeddings-seed")
    );
    const distinct = new Map(
      shared.map((item) => [`${item.sourceEventId}:${item.branchId}`, item])
    );

    expect(shared).toHaveLength(3);
    expect([...distinct.values()]).toHaveLength(2);
    expect(
      [...distinct.values()].reduce(
        (sum, item) =>
          sum + (item.costUsd ?? 0) / (item.qualifyingBranchCount ?? 1),
        0
      )
    ).toBe(90);
    expect(
      [...distinct.values()].every(
        ({ costUsd, qualifyingBranchCount }) =>
          costUsd === 90 && qualifyingBranchCount === 2
      )
    ).toBe(true);
  });

  it("does not split an already-attributed Detail share twice", () => {
    const awaiting = detailFor("br_awaiting_sync");
    const seed = detailFor("br_1284");

    expect(awaiting.sessions[0]).toMatchObject({
      attributedCostUsd: 45,
      rawCostUsd: 90,
    });
    expect(seed.sessions[0]).toMatchObject({
      attributedCostUsd: 45,
      rawCostUsd: 90,
    });
    expect(awaiting.attributedCostUsd).toBe(75);
    expect(seed.attributedCostUsd).toBe(105);
  });

  it("honors authoritative attributed null and zero without raw fallback", () => {
    const attributedNull = buildBranchDetail(
      fixtureRow("br_attributed_null", 1)
    );
    const attributedZero = buildBranchDetail(
      fixtureRow("br_attributed_zero", 1)
    );
    const evidence = buildCanonicalCostEvidence([
      fixtureRow("br_attributed_null", 1),
      fixtureRow("br_attributed_zero", 1),
    ]);

    expect(attributedNull.rawCostUsd).toBe(90);
    expect(attributedNull.attributedCostUsd).toBeNull();
    expect(attributedNull.sessions[0]).toMatchObject({
      attributedCostUsd: null,
      rawCostUsd: 90,
    });
    expect(attributedZero.rawCostUsd).toBe(90);
    expect(attributedZero.attributedCostUsd).toBe(0);
    expect(attributedZero.sessions[0]).toMatchObject({
      attributedCostUsd: 0,
      rawCostUsd: 90,
    });
    expect(
      evidence.contributions.some(
        ({ branchId, costUsd }) =>
          branchId === "br_attributed_null" || costUsd !== 0
      )
    ).toBe(false);
    expect(evidence.completeBranchIds).toContain("br_attributed_zero");
    expect(evidence.completeBranchIds).not.toContain("br_attributed_null");
  });

  it("keeps generated-row List and Detail cost stable outside index zero", () => {
    const generated = fixtureRow("br_generated_cost_parity", 2);
    const firstRow = branchRows[0];
    if (!firstRow) {
      throw new Error("Missing first Branch fixture");
    }
    const evidence = buildCanonicalCostEvidence([firstRow, generated]);
    const listAttributedCost = evidence.contributions
      .filter(({ branchId }) => branchId === generated.id)
      .reduce(
        (sum, item) =>
          sum + (item.costUsd ?? 0) / (item.qualifyingBranchCount ?? 1),
        0
      );

    expect(listAttributedCost).toBe(
      buildBranchDetail(generated).attributedCostUsd
    );
  });

  it("emits each source Session once and conserves all-time cost", () => {
    const evidence = buildCanonicalCostEvidence(branchRows);
    const distinctContributions = new Map(
      evidence.contributions.map((item) => [
        `${item.sourceEventId}:${item.branchId}`,
        item,
      ])
    );
    const sourceOccurrences = new Map<string, Set<string>>();
    for (const item of distinctContributions.values()) {
      if (!(item.sessionId && item.occurredAt)) {
        throw new Error("Expected canonical Session identity and timestamp");
      }
      const timestamps = sourceOccurrences.get(item.sessionId) ?? new Set();
      timestamps.add(item.occurredAt);
      sourceOccurrences.set(item.sessionId, timestamps);
    }
    const listAttributedTotal = [...distinctContributions.values()].reduce(
      (sum, item) =>
        sum + (item.costUsd ?? 0) / (item.qualifyingBranchCount ?? 1),
      0
    );
    const detailAttributedTotal = branchRows.reduce(
      (sum, row) => sum + (buildBranchDetail(row).attributedCostUsd ?? 0),
      0
    );

    expect(
      [...sourceOccurrences.values()].every(
        (timestamps) => timestamps.size === 1
      )
    ).toBe(true);
    expect(
      new Set(
        [...distinctContributions.values()].map(({ occurredAt }) => occurredAt)
      ).size
    ).toBeGreaterThan(1);
    expect(listAttributedTotal).toBe(detailAttributedTotal);
  });

  it("distinguishes partial, authoritative zero, and unavailable evidence", () => {
    const partial = detailFor("br_1289");
    const zero = detailFor("br_session_cost");
    const absent = detailFor("br_dependabot");
    const unpriced = detailFor("br_unpriced_sessions");

    expect(partial.costTotal).toBe("$280*");
    expect(partial.costDisclosure).toContain("unavailable cost is excluded");
    expect(
      partial.costSegments.reduce((sum, segment) => sum + segment.pct, 0)
    ).toBe(100);
    expect(zero.costTotal).toBe("$0");
    expect(zero.valuePerDollar).toBe("N/A");
    expect(absent.costTotal).toBe("Unavailable");
    expect(absent.valuePerDollar).toBe("Unavailable");
    expect(
      absent.costSegments.every(({ cost }) => cost === "Unavailable")
    ).toBe(true);
    expect(unpriced.costTotal).toBe("Unavailable");
    expect(unpriced.sessions).toHaveLength(2);
    expect(
      unpriced.sessions.every(
        ({ attributedCostUsd }) => attributedCostUsd === null
      )
    ).toBe(true);
    const evidence = buildCanonicalCostEvidence(branchRows);
    expect(
      evidence.incompleteContributions.map(
        ({ branchId, occurredAt }) => `${branchId}:${occurredAt}`
      )
    ).toContain("br_1289:2026-05-09T12:00:00.000Z");
  });

  it.each([
    "br_invalid_cost",
    "br_conflicting_cost",
  ])("fails closed for %s evidence", (branchId) => {
    const row = fixtureRow(branchId, 2);
    const evidence = buildCanonicalCostEvidence([row]);
    const detail = buildBranchDetail(row);

    expect(evidence.contributions).toEqual([]);
    expect(evidence.completeBranchIds).toEqual([]);
    expect(detail.costTotal).toBe("Unavailable");
    expect(detail.attributedCostUsd).toBeNull();
  });

  it("keeps a phase with only unknown cost unavailable", () => {
    const detail = buildBranchDetail(fixtureRow("br_phase_unknown", 2));
    const review = detail.costSegments.find(({ key }) => key === "review");

    expect(detail.costTotal).toBe("$40*");
    expect(review?.cost).toBe("Unavailable");
  });
});

function detailFor(branchId: string) {
  const row = branchRows.find(({ id }) => id === branchId);
  if (!row) {
    throw new Error(`Missing Branch fixture ${branchId}`);
  }
  return buildBranchDetail(row);
}

function fixtureRow(branchId: string, sessionCount: number) {
  const template = branchRows[0];
  if (!template) {
    throw new Error("Missing Branch fixture template");
  }
  return {
    ...template,
    id: branchId,
    branchName: `agent/${branchId}`,
    sessionCount,
  };
}
