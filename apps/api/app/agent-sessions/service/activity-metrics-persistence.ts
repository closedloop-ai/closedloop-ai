import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { asAutonomyBand } from "@repo/api/src/types/session-activity-metrics";
import { normalizeSessionActivityMetrics } from "@repo/api/src/types/session-activity-metrics-normalize";
import { Prisma } from "@repo/database";
import type { AgentSessionUpsertTx } from "./records";

/**
 * ISS-10721 — persist the session activity-metrics rollup into its cloud twin
 * (`agent_session_activity_metrics`).
 *
 * THREE-WAY on the payload, matching `persistSessionActivitySegments`: an
 * ABSENT key leaves any stored rollup untouched (a desktop build that predates
 * the field carries none ever, and a chunk part assembled without one carries
 * none either), an explicit `null` RETRACTS — the producer is stating it holds
 * no rollup for this session — and a present object is written on the session's
 * own primary key.
 *
 * THE RETRACTION IS THE HALF A NULLABLE-EVERYTHING CONTRACT CANNOT EXPRESS ANY
 * OTHER WAY (ISS-10721 review, whitlockk). The desktop's table is a pure function of
 * the current segments: a re-tile that drops a session to zero segments DELETES
 * the local row, and the child-row fingerprint requeues that session precisely
 * so the cloud learns about it. Without a retraction the requeued payload omits
 * the key, omission reads as leave-it-alone, and the cloud publishes a band, a
 * coverage and a spend split for a tiling that no longer exists — permanently,
 * since no later sync can ever say otherwise. An older cloud build that predates
 * this arm reads the same `null` as absent, which is what it does today, so the
 * vocabulary widens without breaking a skewed peer.
 *
 * FRESHNESS-GATED, like every other guarded column on this lane. `watermarkAllowsWrite`
 * is the caller's `shouldUpdateGuardedColumns`: a payload whose `updatedAt` is
 * behind the stored one is a reordered delivery, and the chunk gate can still
 * admit it at an equal revision (a formula-only rebuild keeps `dataRevision`).
 * Writing the rollup unconditionally there let a pre-backfill snapshot regress
 * coverage, spend and both version stamps, and leave the rollup disagreeing with
 * the tiling that segment persistence independently refused to roll back.
 *
 * PER-MEASURE, because the wire distinguishes two things the read contract
 * cannot: a measure the producer OMITTED (it computed nothing — a version-skew
 * or partial-rollup case the wire type exists to express) versus one it SENT and
 * this boundary judged impossible. Only the second is written as NULL. Writing
 * both would let a producer that merely stopped reporting a measure erase a
 * value the cloud had legitimately measured before, which is data loss wearing
 * the label of an update.
 *
 * Nothing valid and nothing stored is a no-op; nothing valid but something
 * stored is an UPDATE ONLY (`updateMany`, a no-op when no row exists), because
 * a superseded measurement must stop being published rather than persist as the
 * current one — while still never creating an all-NULL row, which would be
 * indistinguishable from a rollup that ran and measured nothing.
 */
export async function persistSessionActivityMetrics(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  session: Pick<SyncedAgentSession, "activityMetrics">,
  watermarkAllowsWrite: boolean
): Promise<boolean> {
  if (!watermarkAllowsWrite) {
    return false;
  }
  const raw = session.activityMetrics;
  if (raw === undefined) {
    return false;
  }
  if (raw === null) {
    const retracted = await tx.agentSessionActivityMetrics.deleteMany({
      where: { agentSessionId: artifactId },
    });
    return retracted.count > 0;
  }
  const metrics = normalizeSessionActivityMetrics(raw);
  const carried = <K extends keyof typeof raw>(key: K) =>
    raw[key] !== undefined;
  const data: ActivityMetricsColumns = {};
  if (carried("autonomyBand")) {
    data.autonomyBand = asAutonomyBand(metrics.autonomyBand);
  }
  if (carried("coverage")) {
    data.coverage = metrics.coverage;
  }
  if (
    carried("spendLowConfUsd") &&
    carried("spendMediumConfUsd") &&
    carried("spendHighConfUsd")
  ) {
    // The three tiers partition the attributed spend, so they move together:
    // writing a subset would leave the stored split summing to a total neither
    // producer ever measured.
    //
    // `&&`, not `||`, and the difference is only reachable under skew. A
    // producer that carried ONE tier makes `normalizeSessionActivityMetrics`
    // withhold the whole split, so entering on `||` would write all three
    // columns NULL and erase a split the cloud legitimately measured on an
    // earlier sync — the omitted-vs-sent distinction this module exists to keep,
    // lost at the one boundary that was supposed to enforce it. Carrying fewer
    // than three says nothing about the split, so nothing is written.
    data.spendLowConfUsd = toDecimal(metrics.spendLowConfUsd);
    data.spendMediumConfUsd = toDecimal(metrics.spendMediumConfUsd);
    data.spendHighConfUsd = toDecimal(metrics.spendHighConfUsd);
  }
  if (carried("segmentCount")) {
    data.segmentCount = metrics.segmentCount;
  }
  if (carried("coveredSegmentCount")) {
    data.coveredSegmentCount = metrics.coveredSegmentCount;
  }
  if (carried("classifierVersion")) {
    data.classifierVersion = metrics.classifierVersion;
  }
  if (carried("metricVersion")) {
    data.metricVersion = metrics.metricVersion;
  }
  if (Object.keys(data).length === 0) {
    return false;
  }
  if (Object.values(data).every((value) => value === null)) {
    // Every measure this payload carried is impossible. Update in place so a
    // stored measurement it supersedes stops being published; create nothing,
    // because an all-NULL row states "measured nothing" rather than "unknown".
    const cleared = await tx.agentSessionActivityMetrics.updateMany({
      where: { agentSessionId: artifactId },
      data,
    });
    return cleared.count > 0;
  }
  await tx.agentSessionActivityMetrics.upsert({
    where: { agentSessionId: artifactId },
    create: { agentSessionId: artifactId, ...data },
    update: data,
    // The write's result is discarded, so narrow `RETURNING *` to the primary
    // key rather than shipping the whole row back to be dropped.
    select: { agentSessionId: true },
  });
  return true;
}

/**
 * The rollup's own scalar columns, every one optional.
 *
 * Derived from the generated create input rather than written out, so a column
 * added to the model is available here without an edit and a column removed
 * fails `tsc` at the assignment — the side-inventory hole a hand-kept field list
 * would open. The unchecked variant is the one whose fields are plain values
 * (not update-operation objects), which is what lets the same object serve both
 * the `create` and the `update` of the upsert.
 */
type ActivityMetricsColumns = Partial<
  Omit<
    Prisma.AgentSessionActivityMetricsUncheckedCreateInput,
    "agentSessionId" | "createdAt" | "updatedAt"
  >
>;

/** A validated USD amount as the column's `Decimal(14, 6)`; `null` stays null. */
function toDecimal(value: number | null): Prisma.Decimal | null {
  return value === null ? null : new Prisma.Decimal(value);
}
