import { createHash } from "node:crypto";
import { config as awsStorageConfig } from "@repo/aws/s3-client";
import {
  DesktopAgentSessionsRateLimiter,
  handleDesktopAgentSessionsEvent,
} from "@/lib/desktop-agent-sessions-handler";
import { desktopAgentSessionsPayloadObjectSchema } from "@/lib/desktop-agent-sessions-schema";
import { buildBatchPayload } from "../../perf-import-desktop-snapshot";
import type { DesktopSyncTarget } from "../desktop-sync/sync-target";
import {
  archiveMainTranscript,
  skipMainTranscript,
} from "../desktop-sync/transcripts";
import type { VibeSeedContext } from "../stage";
import type { AcmeSessionPlan } from "./acme-branches";
import {
  type AcmeSessionIdentity,
  acmeSessionEnd,
  acmeSessionTranscript,
  acmeWireSession,
} from "./acme-session-wire";
import type { BranchWork } from "./store-work";

/**
 * ISS-12135: deliver an Acme base-seed session's work the way a Desktop syncs
 * it: the wire session through `handleDesktopAgentSessionsEvent` (the fold the
 * golden import and the sync route use), from the machine the session ran on,
 * then its transcript through the transcript lane's archive. Keyed on the
 * session's own `(computeTargetId, externalSessionId)`, so the fold fills the
 * base seed's row rather than adding one.
 */
export async function replayAcmeSessionActivity(
  context: VibeSeedContext,
  plan: AcmeSessionPlan,
  work: BranchWork,
  startedAt: Date
): Promise<void> {
  const session = await readBaseSession(context, plan);
  const identity: AcmeSessionIdentity = {
    externalSessionId: session.externalSessionId,
    cwd: session.cwd,
  };
  const payload = buildBatchPayload([
    acmeWireSession(plan, work, identity, startedAt),
  ]);
  const validated = desktopAgentSessionsPayloadObjectSchema.safeParse(payload);
  if (!validated.success) {
    throw new Error(
      `the "${plan.sessionName}" sync payload fails the route schema: ${validated.error.message}`
    );
  }
  const ack = await handleDesktopAgentSessionsEvent(
    payload,
    {
      organizationId: context.organizationId,
      userId: session.userId,
      targetId: session.computeTargetId,
    },
    { rateLimiter: new DesktopAgentSessionsRateLimiter({ maxRequests: 2 }) }
  );
  if (
    !(
      ack.accepted &&
      ack.acceptedSessionIds?.includes(session.externalSessionId)
    )
  ) {
    throw new Error(
      `the sync fold did not persist "${plan.sessionName}": ${JSON.stringify(ack)}`
    );
  }
  await archiveTranscript(context, plan, work, session, startedAt);
}

type BaseSession = {
  readonly artifactId: string;
  readonly externalSessionId: string;
  readonly computeTargetId: string;
  readonly userId: string;
  readonly cwd: string;
};

async function readBaseSession(
  context: VibeSeedContext,
  plan: AcmeSessionPlan
): Promise<BaseSession> {
  const row = await context.prisma.sessionDetail.findFirst({
    where: {
      artifact: {
        organizationId: context.organizationId,
        name: plan.sessionName,
      },
    },
    select: {
      artifactId: true,
      externalSessionId: true,
      computeTargetId: true,
      cwd: true,
      artifact: { select: { createdById: true } },
      computeTarget: { select: { userId: true } },
    },
  });
  const userId = row?.artifact.createdById ?? row?.computeTarget.userId;
  if (row === null || userId === undefined || userId === null) {
    throw new Error(
      `the base seed's "${plan.sessionName}" session has no owner to sync it as`
    );
  }
  return {
    artifactId: row.artifactId,
    externalSessionId: row.externalSessionId,
    computeTargetId: row.computeTargetId,
    userId,
    cwd: row.cwd ?? `/workspace/${plan.branchName}`,
  };
}

async function archiveTranscript(
  context: VibeSeedContext,
  plan: AcmeSessionPlan,
  work: BranchWork,
  session: BaseSession,
  startedAt: Date
): Promise<void> {
  const target: DesktopSyncTarget = {
    organizationId: context.organizationId,
    userId: session.userId,
    computeTargetId: session.computeTargetId,
    clerkUserId: null,
    storePath: context.desktopStorePath ?? "",
    shift: { shiftMs: context.corpusShiftMs, nowMs: context.now.getTime() },
    now: context.now,
    log: context.log,
  };
  const ingested = {
    artifactId: session.artifactId,
    externalSessionId: session.externalSessionId,
    harness: "claude",
    lastActivityAt: acmeSessionEnd(plan, startedAt),
  };
  if (awsStorageConfig.TRANSCRIPTS_BUCKET === undefined) {
    await skipMainTranscript(target, ingested);
    return;
  }
  await archiveMainTranscript(
    target,
    ingested,
    acmeSessionTranscript(
      plan,
      work,
      { externalSessionId: session.externalSessionId, cwd: session.cwd },
      startedAt
    ),
    createHash("sha256")
      .update(`acme-base-seed/${plan.branchName}`)
      .digest("hex")
  );
}
