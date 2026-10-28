import { SyncLane } from "@closedloop-ai/telemetry-contract/sync";
import type {
  AgentComponentInvocationSyncAck,
  AgentComponentInvocationSyncPart,
} from "@repo/api/src/types/agent-component-invocation";
import { DesktopAgentComponentInvocationSyncRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import { Result } from "@repo/api/src/types/result";
import {
  agentComponentInvocationsService,
  type IngestAgentComponentInvocationPartResult,
} from "@/app/agent-sessions/service/component-invocations";
import { computeTargetsService } from "@/app/compute-targets/service";
import { reportComputeTargetOwnershipRefusal } from "@/app/compute-targets/service/ownership-refusal-telemetry";
import type { AuthContext } from "@/lib/auth/with-auth";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

type DesktopAgentComponentInvocationsSyncInput = {
  clerkUserId: string | null;
  computeTargetId: string;
  organizationId: string;
  part: AgentComponentInvocationSyncPart;
  userId: string;
  /** ISS-11426 telemetry only: which credential authenticated the request. */
  authMethod?: AuthContext["authMethod"];
};

/**
 * Verifies target ownership, then ingests one independently acknowledged part.
 *
 * ISS-11449: ownership is now the ONLY refusal here, so the route's single
 * `Forbidden` has a single cause. Whether a session's data may egress at all is
 * the user's own `DataSyncLevel` election, decided on the device before the
 * part is ever sent — there is no org-level override above it.
 */
export const desktopAgentComponentInvocationsSyncService = {
  async sync(
    input: DesktopAgentComponentInvocationsSyncInput,
    recordWrite?: RecordWriteInTransaction<IngestAgentComponentInvocationPartResult>
  ): Promise<
    Result<
      AgentComponentInvocationSyncAck,
      typeof DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned
    >
  > {
    const target = await computeTargetsService.findOwnedById(
      input.computeTargetId,
      input.organizationId,
      input.userId,
      input.clerkUserId
    );
    if (!target) {
      await reportComputeTargetOwnershipRefusal({
        lane: SyncLane.InvocationParts,
        computeTargetId: input.computeTargetId,
        organizationId: input.organizationId,
        userId: input.userId,
        authMethod: input.authMethod,
      });
      return Result.err(
        DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned
      );
    }

    const result = await agentComponentInvocationsService.ingestPart(
      {
        organizationId: input.organizationId,
        computeTargetId: input.computeTargetId,
        part: input.part,
      },
      recordWrite
    );
    if (result.ok) {
      return Result.ok({
        accepted: true,
        protocolVersion: input.part.protocolVersion,
        externalGenerationId: input.part.externalGenerationId,
        partIndex: input.part.partIndex,
        partHash: input.part.partHash,
        state: result.value.state,
      });
    }
    return Result.ok({
      accepted: false,
      protocolVersion: input.part.protocolVersion,
      externalGenerationId: input.part.externalGenerationId,
      partIndex: input.part.partIndex,
      partHash: input.part.partHash,
      reason: result.error,
    });
  },
};
