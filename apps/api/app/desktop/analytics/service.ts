import type {
  DesktopAnalyticsAckReason,
  DesktopAnalyticsCaptureResponse,
} from "@repo/api/src/types/desktop-analytics";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { computeTargetsService } from "@/app/compute-targets/service";
import {
  aliasDesktopAnalytics,
  captureDesktopAnalytics,
} from "@/lib/desktop-analytics-capture";
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
 * FEA-3425 (PLN-1437 Phase 3, D4): verifies compute-target ownership per
 * request, since a stateless route has no per-connection `hello` binding, then
 * delegates to the shared handler and capture sink for validation, rate
 * limiting, and PostHog enrichment.
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
      // ISS-10503 (PRD-736 D5): the HTTP write lane is the one transport the
      // desktop presents the alias-triggering onboarding id on, so only this
      // service supplies the alias sink.
      { alias: aliasDesktopAnalytics, capture: captureDesktopAnalytics }
    );

    if (!ack.accepted) {
      return Result.err(ack.reason);
    }

    // ISS-10503: the alias outcome rides the ack so the desktop clears its
    // pending-alias latch only on a genuine merge; omission preserved.
    return Result.ok({
      captured: true,
      ...(ack.aliased === undefined ? {} : { aliased: ack.aliased }),
    });
  },
};
