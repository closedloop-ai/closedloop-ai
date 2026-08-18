/**
 * Shared fixtures for the `/cron/sample-session-ingestion-health` suites.
 *
 * The sampler's tests split across two files — `service.test.ts` (classification
 * and emission) and `platform-quiet.test.ts` (the ISS-4829 zero-active
 * withholding) — because one file crossed the 1,000-line ceiling. Everything
 * that is PURE lives here so the split cannot let the two suites drift onto
 * different fixture shapes. The `vi.hoisted` / `vi.mock` / `beforeEach` wiring
 * stays in each test file: module mocking is per-file in Vitest and cannot be
 * hoisted out of one.
 */
import type { Mock } from "vitest";

export const MS_PER_HOUR = 60 * 60 * 1000;
export const NOW = new Date("2026-07-31T12:00:00.000Z");

export const ORG_ACTIVE = "org-active";
export const ORG_STALLED = "org-stalled";
export const ORG_DORMANT = "org-dormant";

/**
 * ISS-4678 + ISS-4827: the service issues two `computeTarget.groupBy` calls —
 * the ingest-watermark group (`_max.lastAgentSessionSyncAt`) and the per-org
 * fleet group, which carries BOTH the device heartbeat (`_max.lastSeenAt`) and
 * the ingest-attempt watermark (`_max.lastAgentSessionSyncAttemptAt`). One mock
 * fn serves both, routing by the requested `_max` shape so a test can pin each
 * independently.
 */
export type GroupByArgs = {
  _max?: {
    lastAgentSessionSyncAt?: true;
    lastSeenAt?: true;
    lastAgentSessionSyncAttemptAt?: true;
  };
};

export type IngestGroup = {
  organizationId: string;
  _max: { lastAgentSessionSyncAt: Date | null };
};

export type PresenceGroup = {
  organizationId: string;
  _max: {
    lastSeenAt: Date | null;
    lastAgentSessionSyncAttemptAt: Date | null;
  };
};

export function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * MS_PER_HOUR);
}

export function group(
  organizationId: string,
  lastSync: Date | null
): IngestGroup {
  return { organizationId, _max: { lastAgentSessionSyncAt: lastSync } };
}

/**
 * ISS-4827: a per-org fleet row carrying BOTH signals. `lastAttemptAt` defaults
 * to `lastSeenAt` — the pre-ISS-4827 world, where presence and attempt were
 * assumed to move together — so a fixture that only cares about ingest-age
 * classification keeps its meaning. Tests probing the split between "present"
 * and "attempting" pass the two independently, which is the whole point of the
 * ticket.
 */
export function lastSeenGroup(
  organizationId: string,
  lastSeenAt: Date | null,
  lastAttemptAt: Date | null = lastSeenAt
): PresenceGroup {
  return {
    organizationId,
    _max: { lastSeenAt, lastAgentSessionSyncAttemptAt: lastAttemptAt },
  };
}

/**
 * ISS-4678 + ISS-4827: give every org in `ingestGroups` a fleet that is present
 * AND attempting AT `now`. A fleet whose batches are being accepted while its
 * data stops landing is exactly the STALLED case, so a test that only cares
 * about ingest-age classification keeps its meaning. Tests probing the quiet,
 * dormant, or idle-but-open paths override the fleet row explicitly.
 */
export function freshHeartbeats(ingestGroups: IngestGroup[]): PresenceGroup[] {
  return ingestGroups.map((ingestGroup) =>
    lastSeenGroup(ingestGroup.organizationId, NOW)
  );
}

export function policyRow(id: string, sessionSyncPolicyEnabled: boolean) {
  return { id, sessionSyncPolicyEnabled };
}

/**
 * Route the two `computeTarget.groupBy` calls to their respective fixtures by
 * the `_max` shape requested. `lastSeenGroups` defaults to a fresh heartbeat per
 * ingest org (the STALLED-preserving default described on `freshHeartbeats`).
 */
export function routeGroupBy(
  groupByMock: Mock,
  ingestGroups: IngestGroup[],
  lastSeenGroups: PresenceGroup[] = freshHeartbeats(ingestGroups)
): void {
  groupByMock.mockImplementation((args: GroupByArgs) => {
    if (args._max?.lastSeenAt) {
      return Promise.resolve(lastSeenGroups);
    }
    return Promise.resolve(ingestGroups);
  });
}

export function metricsEmitted(emitMock: Mock, metric: string) {
  return emitMock.mock.calls
    .map(([payload]) => payload)
    .filter((payload) => payload.metric === metric);
}
