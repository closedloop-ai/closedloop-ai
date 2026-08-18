import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  branchCostEvidenceByteBudget,
  branchCostEvidenceFixedRowBytes,
  branchCostEvidenceRowBudget,
} from "@repo/api/src/types/branch-usage.js";
import {
  TokenCostCompleteness,
  TokenCostCompletenessReason,
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance.js";
import {
  type BranchUsageCostEvidenceKey,
  readBoundedBranchUsageCostEvidence,
} from "../src/main/database/branch-usage-cost-evidence-read.js";
import type { DbHostPrisma } from "../src/main/database/prisma-client.js";

describe("Desktop Branch bounded cost-evidence read", () => {
  test("rejects row overflow before querying provenance", async () => {
    let queryCount = 0;
    const prisma = makePrisma(() => {
      queryCount += 1;
      return [];
    });

    const oversized = new Proxy<BranchUsageCostEvidenceKey[]>(
      new Array(branchCostEvidenceRowBudget + 1),
      {
        get(target, property, receiver) {
          if (property === "map") {
            throw new Error("row cap must run before evidence allocation");
          }
          return Reflect.get(target, property, receiver);
        },
      }
    );

    const result = await readBoundedBranchUsageCostEvidence(prisma, oversized);

    assert.deepEqual(result, { rows: [], exceeded: true });
    assert.equal(queryCount, 0);
  });

  test("counts every materialized variable payload plus the fixed allowance", async () => {
    let queryCount = 0;
    const prisma = makePrisma((sql) => {
      queryCount += 1;
      assert.match(sql, EVIDENCE_BYTES_SELECT_PATTERN);
      const sizeCte = sql.split("), stats AS")[0] ?? "";
      assert.match(sizeCte, SOURCE_IDENTITY_BYTES_PATTERN);
      assert.match(
        sizeCte,
        new RegExp(`\\+\\s+${branchCostEvidenceFixedRowBytes}`)
      );
      assert.match(sizeCte, COST_SUMMARY_BYTES_PATTERN);
      assert.doesNotMatch(sizeCte, SOURCE_IDENTITY_PAYLOAD_SELECT_PATTERN);
      assert.doesNotMatch(sizeCte, COST_SUMMARY_PAYLOAD_SELECT_PATTERN);
      assert.match(sql, SOURCE_IDENTITY_PAYLOAD_SELECT_PATTERN);
      assert.match(sql, COST_SUMMARY_PAYLOAD_SELECT_PATTERN);
      return [
        {
          event_row_id: null,
          event_fingerprint: null,
          source_identity: null,
          cost_summary: null,
          evidence_count: 1,
          retained_bytes: branchCostEvidenceByteBudget + 1,
        },
      ];
    });

    const result = await readBoundedBranchUsageCostEvidence(prisma, [
      { eventRowId: "1", eventFingerprint: "fingerprint-1" },
    ]);

    assert.deepEqual(result, { rows: [], exceeded: true });
    assert.equal(queryCount, 1);
  });

  for (const [label, retainedBytes, exceeded] of [
    ["just below", branchCostEvidenceByteBudget - 1, false],
    ["at", branchCostEvidenceByteBudget, false],
    ["above", branchCostEvidenceByteBudget + 1, true],
  ] as const) {
    test(`classifies ${label} the shared byte cap identically`, async () => {
      const prisma = makePrisma(() => [
        {
          event_row_id: exceeded ? null : "1",
          event_fingerprint: exceeded ? null : "fingerprint-1",
          source_identity: null,
          cost_summary: null,
          evidence_count: 1,
          retained_bytes: retainedBytes,
        },
      ]);

      const result = await readBoundedBranchUsageCostEvidence(prisma, [
        { eventRowId: "1", eventFingerprint: "fingerprint-1" },
      ]);

      assert.equal(result.exceeded, exceeded);
    });
  }

  test("materializes only payloads that passed the shared byte budget", async () => {
    let queryCount = 0;
    const identity = {
      availability: TokenSourceIdentityAvailability.Available,
      scheme: "claude-jsonl",
      sourceRecordIds: ["record-1"],
    };
    const prisma = makePrisma((_sql) => {
      queryCount += 1;
      return [
        {
          event_row_id: "1",
          event_fingerprint: "fingerprint-1",
          source_identity: JSON.stringify(identity),
          cost_summary: null,
          evidence_count: 1,
          retained_bytes: 1152,
        },
      ];
    });

    const result = await readBoundedBranchUsageCostEvidence(prisma, [
      { eventRowId: "1", eventFingerprint: "fingerprint-1" },
    ]);

    assert.equal(result.exceeded, false);
    assert.deepEqual(result.rows, [
      { eventRowId: "1", sourceIdentity: identity, costSummary: undefined },
    ]);
    assert.equal(queryCount, 1);
  });

  test("marks known-invalid persisted evidence malformed and future shapes unknown", async () => {
    const prisma = makePrisma(() => [
      {
        event_row_id: "1",
        event_fingerprint: "fingerprint-1",
        source_identity: JSON.stringify({
          availability: TokenSourceIdentityAvailability.Available,
          scheme: "claude-jsonl",
          sourceRecordIds: "not-an-array",
        }),
        cost_summary: JSON.stringify({
          completeness: TokenCostCompleteness.Complete,
          subtotalUsd: -1,
        }),
        evidence_count: 2,
        retained_bytes: 1200,
      },
      {
        event_row_id: "2",
        event_fingerprint: "fingerprint-2",
        source_identity: JSON.stringify({ availability: "future_state" }),
        cost_summary: JSON.stringify({ completeness: "future_state" }),
        evidence_count: 2,
        retained_bytes: 1200,
      },
    ]);

    const result = await readBoundedBranchUsageCostEvidence(prisma, [
      { eventRowId: "1", eventFingerprint: "fingerprint-1" },
      { eventRowId: "2", eventFingerprint: "fingerprint-2" },
    ]);

    assert.deepEqual(result.rows[0]?.sourceIdentity, {
      availability: TokenSourceIdentityAvailability.Unavailable,
      reason: TokenSourceIdentityUnavailableReason.Malformed,
    });
    assert.deepEqual(result.rows[0]?.costSummary, {
      completeness: TokenCostCompleteness.Unavailable,
      reason: TokenCostCompletenessReason.Malformed,
    });
    assert.deepEqual(result.rows[1]?.sourceIdentity, {
      availability: TokenSourceIdentityAvailability.Unavailable,
      reason: TokenSourceIdentityUnavailableReason.Unknown,
    });
    assert.deepEqual(result.rows[1]?.costSummary, {
      completeness: TokenCostCompleteness.Unavailable,
      reason: TokenCostCompletenessReason.Unknown,
    });
  });

  test("rejects rowid reuse with a different numeric event fingerprint", async () => {
    const prisma = makePrisma(() => [
      {
        event_row_id: "1",
        event_fingerprint: "replacement-fingerprint",
        source_identity: null,
        cost_summary: null,
        evidence_count: 1,
        retained_bytes: 1024,
      },
    ]);

    const result = await readBoundedBranchUsageCostEvidence(prisma, [
      { eventRowId: "1", eventFingerprint: "original-fingerprint" },
    ]);

    assert.deepEqual(result, { rows: [], exceeded: true });
  });
});

function makePrisma(query: (sql: string) => unknown[]): DbHostPrisma {
  return {
    client: { $queryRawUnsafe: (sql: string) => Promise.resolve(query(sql)) },
  } as unknown as DbHostPrisma;
}

const EVIDENCE_BYTES_SELECT_PATTERN = /AS evidence_bytes/;
const SOURCE_IDENTITY_BYTES_PATTERN =
  /length\(CAST\(COALESCE\(te\.source_identity/;
const COST_SUMMARY_BYTES_PATTERN = /length\(CAST\(COALESCE\(te\.cost_summary/;
const SOURCE_IDENTITY_PAYLOAD_SELECT_PATTERN =
  /te\.source_identity AS source_identity/;
const COST_SUMMARY_PAYLOAD_SELECT_PATTERN = /te\.cost_summary AS cost_summary/;
