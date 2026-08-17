import type {
  AgentComponentInvocationSyncAck,
  AgentComponentInvocationSyncPart,
} from "@repo/api/src/types/agent-component-invocation";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { agentComponentInvocationsService } from "@/app/agent-sessions/service/component-invocations";
import { computeTargetsService } from "@/app/compute-targets/service";
import { isOrgSessionSyncPolicyEnabled } from "@/lib/org-session-sync-policy";

type DesktopAgentComponentInvocationsSyncInput = {
  clerkUserId: string | null;
  computeTargetId: string;
  organizationId: string;
  part: AgentComponentInvocationSyncPart;
  userId: string;
  /** Injectable for tests; defaults to the server-owned org-policy lookup. */
  isOrgPolicyEnabled?: (organizationId: string) => Promise<boolean>;
};

/**
 * Verifies target ownership and the org session-sync policy, then ingests one
 * independently acknowledged part. Component-invocation parts are session-derived
 * ingest data, so FEA-4169's server-owned org policy must gate this boundary too:
 * a policy-off org (or an older/compromised Desktop that ignores the local gate)
 * cannot persist invocation definitions here. Fail-closed and independent of any
 * client-sent field.
 */
export const desktopAgentComponentInvocationsSyncService = {
  async sync(
    input: DesktopAgentComponentInvocationsSyncInput
  ): Promise<Result<AgentComponentInvocationSyncAck, StatusCode>> {
    const target = await computeTargetsService.findOwnedById(
      input.computeTargetId,
      input.organizationId,
      input.userId,
      input.clerkUserId
    );
    if (!target) {
      return Result.err(Status.Forbidden);
    }

    const isOrgPolicyEnabled =
      input.isOrgPolicyEnabled ?? isOrgSessionSyncPolicyEnabled;
    if (!(await isOrgPolicyEnabled(input.organizationId))) {
      return Result.err(Status.Forbidden);
    }

    const result = await agentComponentInvocationsService.ingestPart({
      organizationId: input.organizationId,
      computeTargetId: input.computeTargetId,
      part: input.part,
    });
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
