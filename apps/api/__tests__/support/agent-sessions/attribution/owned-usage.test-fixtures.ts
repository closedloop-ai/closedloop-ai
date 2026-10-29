/**
 * ISS-12552 (AC-020): sessions whose token events carry source identities, for
 * the suites that check how a usage two sessions share is counted once.
 */
import {
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import { Prisma, withDb } from "@repo/database";
import { isCanonicalComputeTarget } from "@repo/lib/attribution/transcript-copies";
import { claudeTranscriptEntryUuidScheme } from "@repo/lib/harness/usage-dedup";
import {
  type createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";

export const OWNED_USAGE_MODEL = "claude-sonnet-4-20250514";

export type OwnedUsageOrg = { id: string; userId: string };
export type OwnedUsageSession = {
  organizationId: string;
  agentSessionId: string;
};
export type OwnedUsageUnit = {
  uuid: string;
  input: bigint;
  scheme?: string;
  /** The event carries no source identity, as a legacy record syncs. */
  unavailable?: boolean;
  /** The Desktop-derived event id; copies of one session share it. */
  eventId?: string;
};

export async function ownedUsageOrganization(
  tracker: ReturnType<typeof createCommittedTestOrganizationTracker>
): Promise<OwnedUsageOrg> {
  const id = await tracker.create();
  const user = await createTestUser(id);
  return { id, userId: user.id };
}

/** A session whose token events name each unit by a Claude entry uuid. */
export async function sessionWithUsage(
  org: OwnedUsageOrg,
  label: string,
  startedAt: Date,
  usage: readonly OwnedUsageUnit[]
): Promise<OwnedUsageSession> {
  const agentSessionId = await createTestSessionDetail({
    organizationId: org.id,
    userId: org.userId,
    label,
    sessionTimestamp: startedAt,
  });
  await withDb((db) =>
    db.agentSessionTokenEvent.createMany({
      data: usage.map((unit) => ({
        agentSessionId,
        externalEventId: unit.eventId ?? `${label}:${unit.uuid}`,
        model: OWNED_USAGE_MODEL,
        inputTokens: unit.input,
        estimatedCost: new Prisma.Decimal(Number(unit.input) / 1_000_000),
        sourceIdentity: unit.unavailable
          ? {
              availability: TokenSourceIdentityAvailability.Unavailable,
              reason: TokenSourceIdentityUnavailableReason.LegacyRecord,
            }
          : {
              availability: TokenSourceIdentityAvailability.Available,
              scheme: unit.scheme ?? claudeTranscriptEntryUuidScheme,
              sourceRecordIds: [unit.uuid],
            },
        eventCreatedAt: startedAt,
      })),
    })
  );
  return { organizationId: org.id, agentSessionId };
}

/**
 * Makes the given sessions copies of one session (PRD-800): the same
 * harness and external session id, each on its own compute target, with the
 * compute targets reassigned so the first session given is canonical (lowest
 * compute target id) and the rest follow in order.
 */
export async function asCopiesOfOneSession(
  sessions: readonly OwnedUsageSession[],
  harness = "claude"
): Promise<void> {
  const ids = sessions.map((session) => session.agentSessionId);
  const externalSessionId = `copied-session-${ids[0] ?? ""}`;
  await withDb(async (db) => {
    const details = await db.sessionDetail.findMany({
      where: { artifactId: { in: ids } },
      select: { computeTargetId: true },
    });
    const targets = details
      .map((detail) => detail.computeTargetId)
      .sort((a, b) => {
        if (isCanonicalComputeTarget(a, b)) {
          return -1;
        }
        return isCanonicalComputeTarget(b, a) ? 1 : 0;
      });
    // Each session still has its own external id here, so no two rows share
    // (computeTargetId, externalSessionId) while the targets move.
    for (const [index, artifactId] of ids.entries()) {
      await db.sessionDetail.update({
        where: { artifactId },
        data: { computeTargetId: targets[index] ?? "" },
        select: { artifactId: true },
      });
    }
    await db.sessionDetail.updateMany({
      where: { artifactId: { in: ids } },
      data: { externalSessionId, harness },
    });
  });
}
