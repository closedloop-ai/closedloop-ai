import { AutonomyBand } from "@repo/api/src/types/session-activity-metrics";
import type { Prisma } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import { persistSessionActivityMetrics } from "./activity-metrics-persistence";
import type { AgentSessionUpsertTx } from "./records";

const ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";

function makeTx(updatedCount = 1) {
  const upsert = vi.fn().mockResolvedValue({});
  const updateMany = vi.fn().mockResolvedValue({ count: updatedCount });
  const deleteMany = vi.fn().mockResolvedValue({ count: updatedCount });
  return {
    tx: {
      agentSessionActivityMetrics: { upsert, updateMany, deleteMany },
    } as unknown as AgentSessionUpsertTx,
    upsert,
    updateMany,
    deleteMany,
  };
}

describe("persistSessionActivityMetrics", () => {
  it("upserts the rollup keyed on the session, with the band and split intact", async () => {
    const { tx, upsert } = makeTx();
    const wrote = await persistSessionActivityMetrics(
      tx,
      ARTIFACT_ID,
      {
        activityMetrics: {
          autonomyBand: AutonomyBand.Agentic,
          coverage: 0.75,
          spendLowConfUsd: 1,
          spendMediumConfUsd: 2,
          spendHighConfUsd: 3,
          segmentCount: 8,
          coveredSegmentCount: 6,
          classifierVersion: 4,
          metricVersion: 2,
        },
      },
      true
    );
    expect(wrote).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0]?.[0];
    expect(call.where).toEqual({ agentSessionId: ARTIFACT_ID });
    expect(call.update.autonomyBand).toBe(AutonomyBand.Agentic);
    expect(call.update.coverage).toBe(0.75);
    expect(call.update.segmentCount).toBe(8);
    expect(call.update.coveredSegmentCount).toBe(6);
    expect((call.update.spendMediumConfUsd as Prisma.Decimal).toNumber()).toBe(
      2
    );
    // The CREATE branch is the one that runs on a session's first-ever sync, so
    // a create carrying only the primary key would publish nothing for every
    // session while every `update` assertion above stayed green.
    expect(call.create).toEqual({
      agentSessionId: ARTIFACT_ID,
      ...call.update,
    });
    expect(call.create.autonomyBand).toBe(AutonomyBand.Agentic);
    expect(call.create.segmentCount).toBe(8);
  });

  it("writes ONLY the measures the payload carried, never the ones it omitted", async () => {
    // Omission is the wire's way of saying "this producer computed nothing
    // here" — a version-skewed or partial rollup. Nulling the column for it
    // would erase a value the cloud legitimately measured on an earlier sync.
    const { tx, upsert } = makeTx();
    await persistSessionActivityMetrics(
      tx,
      ARTIFACT_ID,
      {
        activityMetrics: { segmentCount: 3 },
      },
      true
    );
    const update = upsert.mock.calls[0]?.[0].update;
    expect(update).toEqual({ segmentCount: 3 });
    expect(update).not.toHaveProperty("coverage");
    expect(update).not.toHaveProperty("autonomyBand");
  });

  it("clears a superseded rollup in place rather than leaving the stale one", async () => {
    // Every measure this payload CARRIED is impossible, so the stored row is no
    // longer current and must stop being published — via an update-only write,
    // so no all-NULL row is created for a session that never had one.
    const { tx, upsert, updateMany } = makeTx();
    const wrote = await persistSessionActivityMetrics(
      tx,
      ARTIFACT_ID,
      {
        activityMetrics: { coverage: 4, segmentCount: 1.5 },
      },
      true
    );
    expect(wrote).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { agentSessionId: ARTIFACT_ID },
      data: { coverage: null, segmentCount: null },
    });
  });

  it("writes nothing at all when the payload OMITS the rollup", async () => {
    const { tx, upsert, updateMany, deleteMany } = makeTx();
    expect(await persistSessionActivityMetrics(tx, ARTIFACT_ID, {}, true)).toBe(
      false
    );
    // An absent rollup must leave any stored one untouched, so the lane may not
    // reach the table at all — a clearing update would be the same defect as a
    // zeroed row.
    expect(upsert).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("RETRACTS the stored rollup on an explicit null", async () => {
    // Behavior change (ISS-10721 review, whitlockk): `null` used to be folded into
    // the omission arm. The desktop table is a pure function of the session's
    // segments, so a re-tile to zero segments DELETES the local row and the
    // child-row fingerprint requeues the session; with `null` reading as
    // leave-it-alone, the cloud went on publishing a band, a coverage and a
    // spend split for a tiling that no longer existed, with no later sync able
    // to correct it. `null` now means the producer holds no rollup.
    const { tx, upsert, updateMany, deleteMany } = makeTx();
    const wrote = await persistSessionActivityMetrics(
      tx,
      ARTIFACT_ID,
      { activityMetrics: null },
      true
    );
    expect(wrote).toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { agentSessionId: ARTIFACT_ID },
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("withholds the whole spend split when the producer carried only part of it", async () => {
    // A producer that sent ONE tier makes the normalizer withhold the split, so
    // entering the spend branch on `||` would write all three columns NULL and
    // erase a split the cloud legitimately measured earlier. Carrying fewer than
    // three says nothing about the partition, so nothing about it is written.
    const { tx, upsert } = makeTx();
    await persistSessionActivityMetrics(
      tx,
      ARTIFACT_ID,
      { activityMetrics: { spendLowConfUsd: 1, segmentCount: 3 } },
      true
    );
    const update = upsert.mock.calls[0]?.[0].update;
    expect(update).toEqual({ segmentCount: 3 });
    expect(update).not.toHaveProperty("spendLowConfUsd");
    expect(update).not.toHaveProperty("spendMediumConfUsd");
    expect(update).not.toHaveProperty("spendHighConfUsd");
  });

  it("writes nothing when the freshness watermark refuses the payload", async () => {
    // A reordered delivery the chunk gate still admits (an equal revision, which
    // a formula-only rebuild keeps) must not regress the rollup past what the
    // other guarded columns accepted.
    const { tx, upsert, updateMany, deleteMany } = makeTx();
    expect(
      await persistSessionActivityMetrics(
        tx,
        ARTIFACT_ID,
        { activityMetrics: { coverage: 0.5 } },
        false
      )
    ).toBe(false);
    expect(
      await persistSessionActivityMetrics(
        tx,
        ARTIFACT_ID,
        { activityMetrics: null },
        false
      )
    ).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("creates NO row for a session that never had one, when nothing is valid", async () => {
    // `updateMany` matches nothing, so the table is left without a row: an
    // all-NULL row would be indistinguishable from a rollup that ran and
    // measured nothing, while absence is already the contract's unknown.
    const { tx, upsert, updateMany } = makeTx(0);
    const wrote = await persistSessionActivityMetrics(
      tx,
      ARTIFACT_ID,
      {
        activityMetrics: { autonomyBand: "supervised", coverage: 4 },
      },
      true
    );
    expect(wrote).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("stores an unrecognized band as unknown while keeping the valid measures", async () => {
    const { tx, upsert } = makeTx();
    await persistSessionActivityMetrics(
      tx,
      ARTIFACT_ID,
      {
        activityMetrics: { autonomyBand: "supervised", segmentCount: 3 },
      },
      true
    );
    const call = upsert.mock.calls[0]?.[0];
    expect(call.update.autonomyBand).toBeNull();
    expect(call.update.segmentCount).toBe(3);
  });
});
