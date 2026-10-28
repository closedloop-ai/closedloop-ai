import {
  type ComputeTarget,
  DesktopCommandStatus,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import type { StoredCommand } from "@/lib/desktop-command-mappers";

export function makeComputeTarget(
  overrides: Partial<ComputeTarget> = {}
): ComputeTarget {
  return {
    id: "target-1",
    organizationId: "org-1",
    userId: "user-1",
    machineName: "machine-1",
    platform: "darwin",
    capabilities: {},
    supportedOperations: [],
    lastSeenAt: new Date(),
    isOnline: true,
    isSharedWithOrg: false,
    selectedHarness: HarnessType.Claude,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makeStoredCommand(
  overrides: Partial<StoredCommand> = {}
): StoredCommand {
  return {
    commandId: "cmd-1",
    computeTargetId: "target-1",
    operationId: "op-1",
    status: DesktopCommandStatus.Queued,
    requestPayload: {
      operationId: "op-1",
      method: "POST",
      path: "/api/gateway/symphony/chat/run-1",
    },
    createdAt: new Date(),
    lastSequenceAcked: 0,
    requestFingerprint: "fingerprint-1",
    ...overrides,
  };
}
