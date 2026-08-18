import type {
  DesktopAgentSessionsAckReason,
  DesktopAgentSessionsSyncResponse,
} from "@repo/api/src/types/agent-session";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { computeTargetsService } from "@/app/compute-targets/service";
import { handleDesktopAgentSessionsEvent } from "@/lib/desktop-agent-sessions-handler";

type DesktopAgentSessionsSyncInput = {
  clerkUserId: string | null;
  computeTargetId: string;
  organizationId: string;
  rawBody: unknown;
  userId: string;
};

/**
 * ISS-5090: the failure channel carries the ingest ack's optional field/path
 * `detail` alongside the reason, so the route can hand it back to the desktop
 * instead of collapsing every rejection into an opaque `validation_failed`.
 * `detail` is omitted (never `null`) when the ack carried none.
 */
export type DesktopAgentSessionsSyncFailure = {
  reason: StatusCode | DesktopAgentSessionsAckReason;
  detail?: string;
};

/** Upserts desktop agent-session payloads for one authenticated compute target. */
export const desktopAgentSessionsSyncService = {
  async sync(
    input: DesktopAgentSessionsSyncInput
  ): Promise<
    Result<DesktopAgentSessionsSyncResponse, DesktopAgentSessionsSyncFailure>
  > {
    const target = await computeTargetsService.findOwnedById(
      input.computeTargetId,
      input.organizationId,
      input.userId,
      input.clerkUserId
    );
    if (!target) {
      return Result.err({ reason: Status.Forbidden });
    }

    const ack = await handleDesktopAgentSessionsEvent(input.rawBody, {
      clerkUserId: input.clerkUserId,
      organizationId: input.organizationId,
      targetId: input.computeTargetId,
      userId: input.userId,
    });

    if (!ack.accepted) {
      return Result.err({
        reason: ack.reason,
        ...(ack.detail ? { detail: ack.detail } : {}),
      });
    }

    // Goal stage 2: pass the request-gated per-session ack ids through when the
    // handler produced them (the batch opted in via `wantsAcceptedSessionIds`).
    // Omit-not-null when absent: installed desktops `.strict()`-parse this
    // response, so an unrequested extra key would reject a successful sync.
    return Result.ok({
      synced: true,
      ...(ack.acceptedSessionIds
        ? { acceptedSessionIds: ack.acceptedSessionIds }
        : {}),
    });
  },
};
