import type { DesktopTelemetryReceiveResponse } from "@repo/api/src/types/desktop-telemetry";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { computeTargetsService } from "@/app/compute-targets/service";
import { handleTelemetryEvent } from "@/lib/desktop-telemetry-handler";

type DesktopTelemetryReceiveInput = {
  clerkUserId: string | null;
  computeTargetId: string;
  organizationId: string;
  pluginVersion?: string;
  rawBody: unknown;
  userId: string;
};

/**
 * FEA-3425 (PLN-1437 Phase 3): verifies compute-target ownership per request,
 * which is what makes `authenticatedTargetId` trustworthy, then delegates to
 * `handleTelemetryEvent` (validation, targetId match, sanitization, enriched
 * structured log). A handler rejection maps to the coded 400 envelope.
 */
export const desktopTelemetryService = {
  async receive(
    input: DesktopTelemetryReceiveInput
  ): Promise<Result<DesktopTelemetryReceiveResponse, StatusCode>> {
    const target = await computeTargetsService.findOwnedById(
      input.computeTargetId,
      input.organizationId,
      input.userId,
      input.clerkUserId
    );
    if (!target) {
      return Result.err(Status.Forbidden);
    }

    const result = handleTelemetryEvent(input.rawBody, {
      authenticatedTargetId: input.computeTargetId,
      organizationId: input.organizationId,
      pluginVersion: input.pluginVersion,
      userId: input.userId,
    });

    if (!result.ok) {
      return Result.err(Status.BadRequest);
    }

    return Result.ok({ received: true });
  },
};
