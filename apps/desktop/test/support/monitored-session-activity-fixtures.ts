import type { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import type { SyncedMonitoredSessionActivity } from "@repo/api/src/types/session-monitored-activity";
import type { ArtifactRefRecord } from "../../src/main/collectors/parsing/artifact-ref-record.js";
import type { NormalizedSession } from "../../src/main/collectors/types.js";
import { makeSession as baseSession } from "../normalized-session-test-utils.js";

export const MONITORED_ACTIVITY_TEST_REPOSITORY =
  "closedloop-ai/symphony-alpha";
export const MONITORED_ACTIVITY_TEST_BRANCH = "feat/iss-6060";
export const MONITORED_ACTIVITY_TEST_READ_AT = "2026-08-12T12:00:00.000Z";
export const MONITORED_ACTIVITY_TEST_ACTION_AT = "2026-08-12T12:05:00.000Z";

export function makeMonitoredActivityTestSession(
  overrides: Partial<NormalizedSession> = {}
): NormalizedSession {
  return baseSession({
    sessionId: "session-iss-6060",
    artifacts: {
      prs: [],
      issues: [],
      repo: MONITORED_ACTIVITY_TEST_REPOSITORY,
    },
    startedAt: "2026-08-12T11:55:00.000Z",
    ...overrides,
  });
}

export function monitoredActivityCarrierFor(
  ref: ArtifactRefRecord
): SyncedMonitoredSessionActivity {
  const evidence = JSON.parse(ref.evidence) as {
    monitoredSessionActivity?: SyncedMonitoredSessionActivity;
  };
  if (!evidence.monitoredSessionActivity) {
    throw new Error(`expected activity carrier on ${ref.targetIdentity}`);
  }
  return evidence.monitoredSessionActivity;
}

export function monitoredActivityRefFor(
  refs: ArtifactRefRecord[],
  kind: ArtifactRefTargetKind,
  identity: string
): ArtifactRefRecord {
  const ref = refs.find(
    (candidate) =>
      candidate.targetKind === kind && candidate.targetIdentity === identity
  );
  if (!ref) {
    throw new Error(`expected ${kind} ref ${identity}`);
  }
  return ref;
}
