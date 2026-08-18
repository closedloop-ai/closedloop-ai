import {
  ArtifactRefTargetKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import {
  normalizeSyncedMonitoredSessionActivity,
  type SyncedMonitoredSessionActivity,
} from "@repo/api/src/types/session-monitored-activity";
import { z } from "zod";
import { parseJsonObjectText } from "../agent-sync/agent-sync-json-text.js";
import {
  branchActivityLookupKey,
  normalizeActivityBranchName,
  normalizeActivityRepository,
  pullRequestActivityLookupKey,
} from "./branch-activity-identity.js";
import {
  type BranchActivityReadRawRow,
  BranchActivityReadRowKind,
} from "./branch-activity-query.js";
import type { BranchCanonicalActivityKey } from "./branch-activity-read.js";
import {
  MONITORED_ACTIVITY_ONLY_METADATA_KEY,
  monitoredActivityOnlyRefsFromMetadata,
} from "./synced-monitored-session-activity.js";

/** One validated or conservatively degraded carrier with exact attribution. */
type MonitoredActivityRef = Extract<
  SyncedArtifactRef,
  {
    kind:
      | typeof ArtifactRefTargetKind.Branch
      | typeof ArtifactRefTargetKind.PullRequest;
  }
> & {
  monitoredSessionActivity: SyncedMonitoredSessionActivity;
};

export type ResolvedBranchActivityCarrier = {
  sessionId: string;
  carrierId: string;
  branch: BranchCanonicalActivityKey;
  activity: SyncedMonitoredSessionActivity | undefined;
  carrierOverflow: boolean;
};

/** Resolve compact query rows through persisted Branch and PR identities. */
export function resolveBranchActivityCarriers(
  rows: readonly BranchActivityReadRawRow[]
): ResolvedBranchActivityCarrier[] {
  const branches = buildBranchCatalog(rows);
  const pullRequests = buildPullRequestHeadCatalog(rows);
  return rows.flatMap((row) => resolveCarrier(row, branches, pullRequests));
}

function resolveCarrier(
  row: BranchActivityReadRawRow,
  branches: BranchCatalog,
  pullRequests: PullRequestHeadCatalog
): ResolvedBranchActivityCarrier[] {
  if (
    !(
      row.sessionId &&
      row.recordId &&
      (row.rowKind === BranchActivityReadRowKind.RegularCarrier ||
        row.rowKind === BranchActivityReadRowKind.PrivateCarrier)
    )
  ) {
    return [];
  }
  const payload = parseJson(row.payloadJson);
  const privateRef =
    row.rowKind === BranchActivityReadRowKind.PrivateCarrier &&
    isTruthySqlBoolean(row.privateEnvelopeValid)
      ? validatedPrivateRef(payload)
      : undefined;
  const target = targetForCarrierRow(row, payload, privateRef);
  const branch = resolveTargetBranch(target, branches, pullRequests);
  if (!branch) {
    return [];
  }
  const carrierOverflow = isTruthySqlBoolean(row.carrierOverflow);
  return [
    {
      sessionId: row.sessionId,
      carrierId: row.recordId,
      branch,
      activity: activityForCarrierRow(row, payload, privateRef),
      carrierOverflow,
    },
  ];
}

function resolveTargetBranch(
  target: ActivityTarget | undefined,
  branches: BranchCatalog,
  pullRequests: PullRequestHeadCatalog
): BranchCanonicalActivityKey | undefined {
  if (!target) {
    return undefined;
  }
  if (target.kind === ArtifactRefTargetKind.Branch) {
    return uniquePersistedBranch(
      target.repoFullName,
      target.branchName,
      branches
    );
  }
  const heads = pullRequests.get(
    pullRequestActivityLookupKey(target.repoFullName, target.prNumber)
  );
  if (heads?.size !== 1) {
    return undefined;
  }
  const [head] = heads;
  if (target.branchName && target.branchName !== head) {
    return undefined;
  }
  return uniquePersistedBranch(target.repoFullName, head, branches);
}

function uniquePersistedBranch(
  repoFullName: string,
  branchName: string,
  catalog: BranchCatalog
): BranchCanonicalActivityKey | undefined {
  const candidates = catalog.get(
    branchActivityLookupKey({ repoFullName, branchName })
  );
  if (candidates?.size !== 1) {
    return undefined;
  }
  return [...candidates.values()][0];
}

function buildBranchCatalog(
  rows: readonly BranchActivityReadRawRow[]
): BranchCatalog {
  const catalog: BranchCatalog = new Map();
  for (const row of rows) {
    if (
      row.rowKind !== BranchActivityReadRowKind.BranchIdentity ||
      !(row.recordId && row.repoFullName && row.branchName)
    ) {
      continue;
    }
    const repoFullName = normalizeActivityRepository(row.repoFullName);
    const branchName = normalizeActivityBranchName(row.branchName);
    if (!(repoFullName && branchName)) {
      continue;
    }
    const lookupKey = branchActivityLookupKey({ repoFullName, branchName });
    const candidates = catalog.get(lookupKey) ?? new Map();
    candidates.set(row.recordId, {
      repoFullName: row.repoFullName,
      branchName: row.branchName,
    });
    catalog.set(lookupKey, candidates);
  }
  return catalog;
}

function buildPullRequestHeadCatalog(
  rows: readonly BranchActivityReadRawRow[]
): PullRequestHeadCatalog {
  const catalog: PullRequestHeadCatalog = new Map();
  for (const row of rows) {
    if (row.rowKind !== BranchActivityReadRowKind.PullRequestIdentity) {
      continue;
    }
    const repoFullName = normalizeActivityRepository(row.repoFullName);
    const branchName = normalizeActivityBranchName(row.branchName);
    const prNumber = normalizePullRequestNumber(row.prNumber);
    if (!(repoFullName && branchName && prNumber)) {
      continue;
    }
    const key = pullRequestActivityLookupKey(repoFullName, prNumber);
    const heads = catalog.get(key) ?? new Set<string>();
    heads.add(branchName);
    catalog.set(key, heads);
  }
  return catalog;
}

function validatedPrivateRef(
  payload: unknown
): MonitoredActivityRef | undefined {
  const metadata = parseJsonObjectText(
    JSON.stringify({ [MONITORED_ACTIVITY_ONLY_METADATA_KEY]: [payload] })
  );
  const ref = monitoredActivityOnlyRefsFromMetadata(metadata).at(0);
  if (
    !ref ||
    (ref.kind !== ArtifactRefTargetKind.Branch &&
      ref.kind !== ArtifactRefTargetKind.PullRequest) ||
    ref.monitoredSessionActivity === undefined
  ) {
    return undefined;
  }
  return ref as MonitoredActivityRef;
}

function targetForCarrierRow(
  row: BranchActivityReadRawRow,
  payload: unknown,
  privateRef: MonitoredActivityRef | undefined
): ActivityTarget | undefined {
  if (row.rowKind === BranchActivityReadRowKind.RegularCarrier) {
    return targetFromRawRow(row);
  }
  if (privateRef) {
    return targetFromSyncedRef(privateRef);
  }
  return targetFromPrivatePayload(payload) ?? targetFromRawRow(row);
}

function activityForCarrierRow(
  row: BranchActivityReadRawRow,
  payload: unknown,
  privateRef: MonitoredActivityRef | undefined
): SyncedMonitoredSessionActivity | undefined {
  if (isTruthySqlBoolean(row.carrierOverflow)) {
    return undefined;
  }
  if (row.rowKind === BranchActivityReadRowKind.RegularCarrier) {
    return normalizeSyncedMonitoredSessionActivity(payload);
  }
  return privateRef?.monitoredSessionActivity;
}

function targetFromPrivatePayload(
  payload: unknown
): ActivityTarget | undefined {
  const parsed = privateActivityTargetSchema.safeParse(payload);
  return parsed.success ? targetFromValues(parsed.data) : undefined;
}

function targetFromRawRow(
  row: BranchActivityReadRawRow
): ActivityTarget | undefined {
  return targetFromValues({
    kind: row.targetKind,
    repositoryFullName: row.repoFullName,
    branchName: row.branchName,
    prNumber: row.prNumber,
  });
}

function targetFromSyncedRef(
  ref: SyncedArtifactRef
): ActivityTarget | undefined {
  if (
    ref.kind !== ArtifactRefTargetKind.Branch &&
    ref.kind !== ArtifactRefTargetKind.PullRequest
  ) {
    return undefined;
  }
  return targetFromValues(ref);
}

function targetFromValues(input: {
  kind: unknown;
  repositoryFullName?: unknown;
  repoFullName?: unknown;
  branchName?: unknown;
  prNumber?: unknown;
}): ActivityTarget | undefined {
  const repoFullName = normalizeActivityRepository(
    input.repositoryFullName ?? input.repoFullName
  );
  if (!repoFullName) {
    return undefined;
  }
  if (input.kind === ArtifactRefTargetKind.Branch) {
    const branchName = normalizeActivityBranchName(input.branchName);
    return branchName
      ? { kind: ArtifactRefTargetKind.Branch, repoFullName, branchName }
      : undefined;
  }
  if (input.kind !== ArtifactRefTargetKind.PullRequest) {
    return undefined;
  }
  const prNumber = normalizePullRequestNumber(input.prNumber);
  return prNumber
    ? {
        kind: ArtifactRefTargetKind.PullRequest,
        repoFullName,
        prNumber,
        branchName: normalizeActivityBranchName(input.branchName),
      }
    : undefined;
}

function normalizePullRequestNumber(value: unknown): number | undefined {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0
    ? normalized
    : undefined;
}

function isTruthySqlBoolean(value: boolean | number | bigint | null): boolean {
  return value === true || Number(value) === 1;
}

function parseJson(value: string | null): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

type BranchCatalog = Map<string, Map<string, BranchCanonicalActivityKey>>;
type PullRequestHeadCatalog = Map<string, Set<string>>;

type ActivityTarget =
  | {
      kind: typeof ArtifactRefTargetKind.Branch;
      repoFullName: string;
      branchName: string;
    }
  | {
      kind: typeof ArtifactRefTargetKind.PullRequest;
      repoFullName: string;
      prNumber: number;
      branchName?: string;
    };

const privateActivityTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal(ArtifactRefTargetKind.Branch),
      repositoryFullName: z.string(),
      branchName: z.string(),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal(ArtifactRefTargetKind.PullRequest),
      repositoryFullName: z.string(),
      prNumber: z.number(),
      branchName: z.string().optional(),
    })
    .passthrough(),
]);
