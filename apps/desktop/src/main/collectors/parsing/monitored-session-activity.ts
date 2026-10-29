import { createHash } from "node:crypto";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import {
  ArtifactRefConfidence,
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  isValidPullRequestNumber,
  parsePullRequestNumber,
} from "@repo/api/src/types/session-artifact-link";
import {
  MonitoredSessionActivityEventKind,
  type SyncedMonitoredSessionActivity,
  type SyncedMonitoredSessionActivityEvent,
} from "@repo/api/src/types/session-monitored-activity";
import type { IndexedToolUse } from "@repo/lib/harness/session-tool-uses";
import { z } from "zod";
import { isValidBranchName } from "../../enrichment/branch-validation.js";
import type { NormalizedSession, NormalizedToolUse } from "../types.js";
import { deduplicateRefs, selectPrimary } from "./artifact-ref-reconcile.js";
import {
  type ArtifactRefRecord,
  canonicalKeyForRef,
} from "./artifact-ref-record.js";
import {
  addGitHubMcpActivityRefs,
  GitHubMonitoredActivityTool,
  githubMonitoredActivityMethod,
} from "./monitored-session-github-mcp.js";
import {
  normalizedMonitoredRepository,
  toolUseHasCompleted,
  validMonitoredEventTimestamp,
} from "./monitored-session-source.js";
import { GITHUB_PR_URL_RE } from "./parser-utils.js";

const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const GITHUB_BRANCH_URL_RE =
  /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/tree\/([^\s?#)\]}]+)/g;

const evidenceObjectSchema = z.record(z.string(), z.unknown());

/** Exact collector methods that can qualify as monitored Git/gh activity. */
export const MonitoredSessionCliRefMethod = {
  GitCheckout: "git_checkout",
  GitWorktreeAdd: "git_worktree_add",
  GitCommit: "git_commit",
  GitPush: "git_push",
  GhPrCreate: "gh_pr_create",
} as const;
export type MonitoredSessionCliRefMethod =
  (typeof MonitoredSessionCliRefMethod)[keyof typeof MonitoredSessionCliRefMethod];

type ActivityBucket = {
  conflictingIds: Set<string>;
  degraded: boolean;
  eventsById: Map<string, SyncedMonitoredSessionActivityEvent>;
};

type QualifiedRef = {
  ref: ArtifactRefRecord;
  eventKind: MonitoredSessionActivityEventKind;
  producerIdentity: string;
  occurredAt: string | null;
};

/**
 * Add exact Git/gh/GitHub-MCP monitored activity to Branch/PR refs, then attach
 * one target-wide carrier holding every qualifying event to every surviving ref
 * for that identity. Existing ref evidence and dedup precedence remain
 * unchanged.
 */
export function attachMonitoredSessionActivity(
  session: NormalizedSession,
  context: {
    toolUses: readonly IndexedToolUse[];
    refs: ArtifactRefRecord[];
  },
  extractorVersion: number
): void {
  const { toolUses, refs } = context;
  addHumanUrlRefs(session, refs, extractorVersion);
  addGitHubMcpActivityRefs(toolUses, refs, extractorVersion);

  const buckets = new Map<string, ActivityBucket>();
  for (const qualified of qualifyExistingRefs(session, toolUses, refs)) {
    addQualifiedEvent(buckets, qualified);
  }
  for (const ref of refs) {
    const key = targetKeyForRef(ref);
    if (!key) {
      continue;
    }
    const bucket = buckets.get(key);
    if (!bucket) {
      continue;
    }
    const carrier = buildCarrier(bucket);
    if (!carrier) {
      continue;
    }
    const evidence = parseEvidenceObject(ref.evidence);
    if (!evidence) {
      continue;
    }
    ref.evidence = JSON.stringify({
      ...evidence,
      monitoredSessionActivity: carrier,
    });
  }
}

/** Reconcile normal refs while retaining otherwise-unlinked activity targets. */
export function reconcileMonitoredSessionActivityRefs(
  refs: ArtifactRefRecord[]
): ArtifactRefRecord[] {
  const regularRefs = refs.filter((ref) => !ref.monitoredActivityOnly);
  const regularTargetKeys = new Set(regularRefs.map(activityTargetKeyForRef));
  const activityOnlyRefs = new Map<string, ArtifactRefRecord>();
  for (const ref of refs) {
    if (ref.monitoredActivityOnly) {
      const key = activityTargetKeyForRef(ref);
      if (!regularTargetKeys.has(key)) {
        activityOnlyRefs.set(key, ref);
      }
    }
  }
  return [
    ...selectPrimary(deduplicateRefs(regularRefs)),
    ...activityOnlyRefs.values(),
  ];
}

function activityTargetKeyForRef(ref: ArtifactRefRecord): string {
  return `${ref.targetKind}|${canonicalKeyForRef(ref)}`;
}

function qualifyExistingRefs(
  session: NormalizedSession,
  toolUses: readonly IndexedToolUse[],
  refs: ArtifactRefRecord[]
): QualifiedRef[] {
  const qualified: QualifiedRef[] = [];
  const toolRefTargets = collectToolRefTargets(refs);
  const toolUsesByIndex = new Map(
    toolUses.map((toolUse) => [toolUse.toolIndex, toolUse])
  );
  for (const ref of refs) {
    const targetKey = targetKeyForRef(ref);
    if (!targetKey) {
      continue;
    }
    const evidence = parseEvidenceObject(ref.evidence);
    if (!evidence) {
      continue;
    }
    const messageIndex = integerField(evidence.messageIndex);
    if (messageIndex !== undefined && evidence.role === "human") {
      const message = session.messages[messageIndex];
      if (message?.role === "human") {
        qualified.push({
          ref,
          eventKind: MonitoredSessionActivityEventKind.UserReference,
          producerIdentity: `message:${messageIndex}`,
          occurredAt: validMonitoredEventTimestamp(message.timestamp),
        });
      }
      continue;
    }

    const toolIndex = integerField(evidence.toolIndex);
    if (toolIndex === undefined) {
      continue;
    }
    const indexedTool = toolUsesByIndex.get(toolIndex);
    if (
      !indexedTool ||
      hasAmbiguousToolTargets(toolRefTargets.get(toolIndex))
    ) {
      continue;
    }
    const eventKind = activityKindForRef(ref, evidence);
    if (!(eventKind && toolUseProvesSuccess(ref, indexedTool.tu))) {
      continue;
    }
    qualified.push({
      ref,
      eventKind,
      producerIdentity: toolProducerIdentity(indexedTool),
      occurredAt: validMonitoredEventTimestamp(indexedTool.tu.timestamp),
    });
  }
  return qualified;
}

function addQualifiedEvent(
  buckets: Map<string, ActivityBucket>,
  qualified: QualifiedRef
): void {
  const key = targetKeyForRef(qualified.ref);
  if (!key) {
    return;
  }
  const bucket = buckets.get(key) ?? {
    conflictingIds: new Set<string>(),
    degraded: false,
    eventsById: new Map<string, SyncedMonitoredSessionActivityEvent>(),
  };
  buckets.set(key, bucket);
  if (!qualified.occurredAt) {
    bucket.degraded = true;
    return;
  }
  const sourceEventId = stableEventId(qualified.producerIdentity, key);
  if (bucket.conflictingIds.has(sourceEventId)) {
    bucket.degraded = true;
    return;
  }
  const event = {
    kind: qualified.eventKind,
    sourceEventId,
    occurredAt: qualified.occurredAt,
    completeness: BranchActivityEvidenceCompleteness.Complete,
  };
  const existing = bucket.eventsById.get(sourceEventId);
  if (
    existing &&
    (existing.kind !== event.kind ||
      existing.occurredAt !== event.occurredAt ||
      existing.completeness !== event.completeness)
  ) {
    bucket.degraded = true;
    bucket.eventsById.delete(sourceEventId);
    bucket.conflictingIds.add(sourceEventId);
    return;
  }
  bucket.eventsById.set(sourceEventId, event);
}

function buildCarrier(
  bucket: ActivityBucket
): SyncedMonitoredSessionActivity | undefined {
  const allEvents = [...bucket.eventsById.values()].sort(
    (left, right) =>
      Date.parse(right.occurredAt) - Date.parse(left.occurredAt) ||
      left.sourceEventId.localeCompare(right.sourceEventId)
  );
  if (allEvents.length === 0) {
    return undefined;
  }
  const partial = bucket.degraded;
  return {
    completeness: partial
      ? BranchActivityEvidenceCompleteness.Partial
      : BranchActivityEvidenceCompleteness.Complete,
    events: allEvents.map((event) =>
      partial
        ? {
            ...event,
            completeness: BranchActivityEvidenceCompleteness.Partial,
          }
        : event
    ),
  };
}

function activityKindForRef(
  ref: ArtifactRefRecord,
  evidence?: Record<string, unknown>
): MonitoredSessionActivityEventKind | undefined {
  if (ref.method === ArtifactRefMethod.McpToolCall) {
    const monitoredActivityKind = evidence?.monitoredActivityKind;
    return Object.values(MonitoredSessionActivityEventKind).find(
      (candidate) => candidate === monitoredActivityKind
    );
  }
  if (
    ref.method === MonitoredSessionCliRefMethod.GitCheckout ||
    ref.method === MonitoredSessionCliRefMethod.GitWorktreeAdd ||
    ref.method === ArtifactRefMethod.PrReviewCommand
  ) {
    return MonitoredSessionActivityEventKind.AgentRead;
  }
  if (
    ref.method === MonitoredSessionCliRefMethod.GitCommit ||
    ref.method === MonitoredSessionCliRefMethod.GitPush ||
    ref.method === MonitoredSessionCliRefMethod.GhPrCreate ||
    ref.method === ArtifactRefMethod.PrCreateOutput ||
    ref.method === ArtifactRefMethod.PrReviewFeedbackCommand
  ) {
    return MonitoredSessionActivityEventKind.AgentAction;
  }
  return undefined;
}

function toolUseProvesSuccess(
  ref: ArtifactRefRecord,
  toolUse: NormalizedToolUse
): boolean {
  if (
    ref.method === ArtifactRefMethod.PrCreateOutput &&
    githubMonitoredActivityMethod(toolUse) ===
      GitHubMonitoredActivityTool.CreatePullRequest
  ) {
    // The MCP-specific ref independently verifies that output proof matches the
    // requested repository; the generic URL ref must not bypass that predicate.
    return false;
  }
  if (ref.method === ArtifactRefMethod.PrReviewFeedbackCommand) {
    return toolUseHasCompleted(toolUse);
  }
  return toolUse.isError !== true && toolUseHasCompleted(toolUse);
}

function addHumanUrlRefs(
  session: NormalizedSession,
  refs: ArtifactRefRecord[],
  extractorVersion: number
): void {
  for (
    let messageIndex = 0;
    messageIndex < session.messages.length;
    messageIndex++
  ) {
    const message = session.messages[messageIndex];
    if (!(message.role === "human" && message.text)) {
      continue;
    }
    // ISS-8659: the pr-link RECORD producer is gated, so gate the other producer
    // of the same fact. A URL the parent's human pasted is the parent's
    // reference; scraping it out of a replayed message let the fork claim every
    // PR its parent had ever linked.
    if (message.isForkReplayed === true) {
      continue;
    }
    const timestamp = validMonitoredEventTimestamp(message.timestamp);
    if (!timestamp) {
      continue;
    }
    for (const match of message.text.matchAll(GITHUB_PR_URL_RE)) {
      const repositoryFullName = normalizedMonitoredRepository(
        match[1],
        match[2]
      );
      const prNumber = parsePullRequestNumber(match[3]);
      if (!(repositoryFullName && prNumber !== null)) {
        continue;
      }
      refs.push({
        targetKind: ArtifactRefTargetKind.PullRequest,
        targetIdentity: `${repositoryFullName}#${prNumber}`,
        relation: ArtifactRefRelation.Referenced,
        method: ArtifactRefMethod.UrlInMessage,
        confidence: ArtifactRefConfidence.UrlMatch,
        evidence: JSON.stringify({ messageIndex, role: message.role }),
        observedAt: timestamp,
        extractorVersion,
        isPrimary: false,
        monitoredActivityOnly: true,
        repoFullName: repositoryFullName,
        prNumber,
      });
    }
    for (const match of message.text.matchAll(GITHUB_BRANCH_URL_RE)) {
      const repositoryFullName = normalizedMonitoredRepository(
        match[1],
        match[2]
      );
      const branchName = decodedBranchName(match[3]);
      if (!(repositoryFullName && branchName)) {
        continue;
      }
      refs.push({
        targetKind: ArtifactRefTargetKind.Branch,
        targetIdentity: branchName,
        relation: ArtifactRefRelation.Referenced,
        method: ArtifactRefMethod.UrlInMessage,
        confidence: ArtifactRefConfidence.UrlMatch,
        evidence: JSON.stringify({ messageIndex, role: message.role }),
        observedAt: timestamp,
        extractorVersion,
        isPrimary: false,
        monitoredActivityOnly: true,
        repoFullName: repositoryFullName,
        branchName,
      });
    }
  }
}

function collectToolRefTargets(
  refs: ArtifactRefRecord[]
): Map<number, { branches: Set<string>; pullRequests: Set<string> }> {
  const byToolIndex = new Map<
    number,
    { branches: Set<string>; pullRequests: Set<string> }
  >();
  for (const ref of refs) {
    const evidence = parseEvidenceObject(ref.evidence);
    if (!activityKindForRef(ref, evidence)) {
      continue;
    }
    const toolIndex = evidence ? integerField(evidence.toolIndex) : undefined;
    const targetKey = targetKeyForRef(ref);
    if (toolIndex === undefined || !targetKey) {
      continue;
    }
    const targets = byToolIndex.get(toolIndex) ?? {
      branches: new Set<string>(),
      pullRequests: new Set<string>(),
    };
    byToolIndex.set(toolIndex, targets);
    if (ref.targetKind === ArtifactRefTargetKind.Branch) {
      targets.branches.add(targetKey);
    } else if (ref.targetKind === ArtifactRefTargetKind.PullRequest) {
      targets.pullRequests.add(targetKey);
    }
  }
  return byToolIndex;
}

function hasAmbiguousToolTargets(
  targets: { branches: Set<string>; pullRequests: Set<string> } | undefined
): boolean {
  return Boolean(
    targets && (targets.branches.size > 1 || targets.pullRequests.size > 1)
  );
}

function targetKeyForRef(ref: ArtifactRefRecord): string | undefined {
  if (
    ref.targetKind === ArtifactRefTargetKind.Branch &&
    ref.repoFullName &&
    OWNER_REPO_RE.test(ref.repoFullName) &&
    ref.branchName &&
    isValidBranchName(ref.branchName)
  ) {
    return `branch:${ref.repoFullName.toLowerCase()}:${ref.branchName}`;
  }
  if (
    ref.targetKind === ArtifactRefTargetKind.PullRequest &&
    ref.repoFullName &&
    OWNER_REPO_RE.test(ref.repoFullName) &&
    ref.prNumber !== undefined &&
    isValidPullRequestNumber(ref.prNumber)
  ) {
    return `pull_request:${ref.repoFullName.toLowerCase()}#${ref.prNumber}`;
  }
  return undefined;
}

function stableEventId(producerIdentity: string, targetKey: string): string {
  const digest = createHash("sha256")
    .update(`${producerIdentity}\u0000${targetKey}`)
    .digest("hex");
  return `monitored_session_v1:${digest}`;
}

function toolProducerIdentity(indexed: IndexedToolUse): string {
  const providerIdentity = indexed.tu.id ?? indexed.tu.providerToolUseId;
  return providerIdentity
    ? `tool:${providerIdentity}`
    : `tool:${indexed.agentId ?? "root"}:${indexed.toolIndex}`;
}

function parseEvidenceObject(
  evidence: string
): Record<string, unknown> | undefined {
  try {
    const parsed = evidenceObjectSchema.safeParse(JSON.parse(evidence));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function integerField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function decodedBranchName(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return isValidBranchName(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}
