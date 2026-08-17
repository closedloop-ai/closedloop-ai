import type {
  DesktopAnalyticsAckReason,
  DesktopAnalyticsCaptureResponse,
} from "@repo/api/src/types/desktop-analytics";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { computeTargetsService } from "@/app/compute-targets/service";
import { captureDesktopAnalytics } from "@/lib/desktop-analytics-capture";
import { handleDesktopAnalyticsEvent } from "@/lib/desktop-analytics-handler";

type DesktopAnalyticsCaptureServiceInput = {
  clerkUserId: string | null;
  computeTargetId: string;
  organizationId: string;
  pluginVersion?: string;
  rawBody: unknown;
  userId: string;
};

/**
 * FEA-3425 (PLN-1437 Phase 3, D4): REST twin of the relay `desktop.analytics`
 * socket event. Verifies compute-target ownership per request — the socket path
 * gets this implicitly from its per-connection `hello` binding; a stateless
 * route must re-check — then delegates to the same shared handler and capture
 * sink as the socket dispatcher, so validation, feature gating, rate limiting,
 * and PostHog enrichment cannot drift between transports.
 */
export const desktopAnalyticsService = {
  async capture(
    input: DesktopAnalyticsCaptureServiceInput
  ): Promise<
    Result<
      DesktopAnalyticsCaptureResponse,
      StatusCode | DesktopAnalyticsAckReason
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

    const ack = await handleDesktopAnalyticsEvent(
      input.rawBody,
      {
        organizationId: input.organizationId,
        userId: input.userId,
        clerkUserId: input.clerkUserId,
        targetId: input.computeTargetId,
        pluginVersion: input.pluginVersion,
      },
      { capture: captureDesktopAnalytics }
    );

    if (!ack.accepted) {
      return Result.err(ack.reason);
    }

    return Result.ok({ captured: true });
  },
};
