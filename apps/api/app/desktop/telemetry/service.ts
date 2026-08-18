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
 * FEA-3425 (PLN-1437 Phase 3): REST twin of the relay `desktop.telemetry`
 * socket event. Verifies compute-target ownership per request — standing in
 * for the socket path's per-connection `hello` binding, which is what made its
 * `authenticatedTargetId` trustworthy — then delegates to the same shared
 * `handleTelemetryEvent` (validation, targetId match, sanitization, enriched
 * structured log) so telemetry semantics cannot drift between transports. The
 * socket path's `emits` back-channel instructions have no REST analogue; the
 * coded 400 envelope is the validation-failure signal here.
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
