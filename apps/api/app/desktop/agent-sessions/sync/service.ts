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

/** Upserts desktop agent-session payloads for one authenticated compute target. */
export const desktopAgentSessionsSyncService = {
  async sync(
    input: DesktopAgentSessionsSyncInput
  ): Promise<
    Result<
      DesktopAgentSessionsSyncResponse,
      StatusCode | DesktopAgentSessionsAckReason
    >
  > {
    const target = await computeTargetsService.findOwnedById(
      input.computeTargetId,
      input.organizationId,
      input.userId,
      input.clerkUserId
    );
    if (!target) {
      return Result.err(Status.Forbidden);
    }

    const ack = await handleDesktopAgentSessionsEvent(input.rawBody, {
      clerkUserId: input.clerkUserId,
      organizationId: input.organizationId,
      targetId: input.computeTargetId,
      userId: input.userId,
    });

    if (!ack.accepted) {
      return Result.err(ack.reason);
    }

    return Result.ok({ synced: true });
  },
};
