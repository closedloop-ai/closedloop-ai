import {
  ArtifactRefConfidence,
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/session-monitored-activity";
import { z } from "zod";
import { isValidBranchName } from "../../enrichment/branch-validation.js";
import type { NormalizedToolUse } from "../types.js";
import type { ArtifactRefRecord } from "./artifact-ref-record.js";
import {
  boundedNestedTextValues,
  normalizedMonitoredRepository,
  toolUseHasCompleted,
  validMonitoredEventTimestamp,
} from "./monitored-session-source.js";
import { GITHUB_PR_URL_RE } from "./parser-utils.js";
import type { IndexedToolUse } from "./session-tool-uses.js";

const GITHUB_MCP_PREFIX_RE = /^(?:mcp__github__|github__)/;
const evidenceObjectSchema = z.record(z.string(), z.unknown());

/** Exact supported methods for the official GitHub MCP PR-read tool. */
export const GitHubPullRequestReadMethod = {
  Get: "get",
  GetDiff: "get_diff",
  GetStatus: "get_status",
  GetFiles: "get_files",
  GetCommits: "get_commits",
  GetReviewComments: "get_review_comments",
  GetReviews: "get_reviews",
  GetComments: "get_comments",
  GetCheckRuns: "get_check_runs",
} as const;
export type GitHubPullRequestReadMethod =
  (typeof GitHubPullRequestReadMethod)[keyof typeof GitHubPullRequestReadMethod];

/** Exact supported GitHub MCP PR mutations with direct target identity. */
export const GitHubPullRequestActionMethod = {
  Update: "update_pull_request",
  UpdateBranch: "update_pull_request_branch",
  Merge: "merge_pull_request",
  ReviewWrite: "pull_request_review_write",
} as const;
export type GitHubPullRequestActionMethod =
  (typeof GitHubPullRequestActionMethod)[keyof typeof GitHubPullRequestActionMethod];

/** Exact GitHub MCP tools whose normalized telemetry may qualify. */
export const GitHubMonitoredActivityTool = {
  PullRequestRead: "pull_request_read",
  CreatePullRequest: "create_pull_request",
  CreateBranch: "create_branch",
} as const;
export type GitHubMonitoredActivityTool =
  (typeof GitHubMonitoredActivityTool)[keyof typeof GitHubMonitoredActivityTool];

const GITHUB_PULL_REQUEST_READ_METHODS = new Set<string>(
  Object.values(GitHubPullRequestReadMethod)
);
const GITHUB_PULL_REQUEST_ACTION_METHODS = new Set<string>(
  Object.values(GitHubPullRequestActionMethod)
);

const githubTargetSchema = z
  .object({
    owner: z.string().trim().min(1).max(100),
    repo: z.string().trim().min(1).max(100),
    pullNumber: z.number().int().positive().optional(),
    method: z.string().trim().min(1).max(100).optional(),
    head: z.string().trim().min(1).max(300).optional(),
    branch: z.string().trim().min(1).max(300).optional(),
  })
  .passthrough();

type ActivityTarget =
  | {
      kind: typeof ArtifactRefTargetKind.Branch;
      repositoryFullName: string;
      branchName: string;
    }
  | {
      kind: typeof ArtifactRefTargetKind.PullRequest;
      repositoryFullName: string;
      prNumber: number;
      branchName?: string;
    };

/** Add exact, successful GitHub MCP Branch/PR activity refs. */
export function addGitHubMcpActivityRefs(
  toolUses: readonly IndexedToolUse[],
  refs: ArtifactRefRecord[],
  extractorVersion: number
): void {
  for (const indexed of toolUses) {
    const ref = githubMcpRefForTool(indexed, extractorVersion);
    if (ref) {
      refs.push(ref);
    }
  }
}

function githubMcpRefForTool(
  indexed: IndexedToolUse,
  extractorVersion: number
): ArtifactRefRecord | undefined {
  const method = githubMonitoredActivityMethod(indexed.tu);
  const timestamp = validMonitoredEventTimestamp(indexed.tu.timestamp);
  if (
    !(
      method &&
      timestamp &&
      indexed.tu.isError !== true &&
      toolUseHasCompleted(indexed.tu)
    )
  ) {
    return undefined;
  }
  const input = githubTargetSchema.safeParse(indexed.tu.input);
  if (!input.success) {
    return undefined;
  }
  const repositoryFullName = normalizedMonitoredRepository(
    input.data.owner,
    input.data.repo
  );
  if (!repositoryFullName) {
    return undefined;
  }
  if (method === GitHubMonitoredActivityTool.CreateBranch) {
    return createBranchMcpRef({
      indexed,
      extractorVersion,
      timestamp,
      repositoryFullName,
      branchName: input.data.branch,
    });
  }
  if (method === GitHubMonitoredActivityTool.CreatePullRequest) {
    const target = createdPullRequestTarget(
      indexed.tu,
      repositoryFullName,
      input.data.head
    );
    return target
      ? mcpRef({
          indexed,
          extractorVersion,
          timestamp,
          target,
          eventKind: MonitoredSessionActivityEventKind.AgentAction,
        })
      : undefined;
  }
  return pullRequestMcpRef({
    indexed,
    extractorVersion,
    timestamp,
    method,
    repositoryFullName,
    pullNumber: input.data.pullNumber,
    readMethod: input.data.method,
  });
}

function createBranchMcpRef(input: {
  indexed: IndexedToolUse;
  extractorVersion: number;
  timestamp: string;
  repositoryFullName: string;
  branchName: string | undefined;
}): ArtifactRefRecord | undefined {
  if (!(input.branchName && isValidBranchName(input.branchName))) {
    return undefined;
  }
  return mcpRef({
    indexed: input.indexed,
    extractorVersion: input.extractorVersion,
    timestamp: input.timestamp,
    target: {
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: input.repositoryFullName,
      branchName: input.branchName,
    },
    eventKind: MonitoredSessionActivityEventKind.AgentAction,
  });
}

function pullRequestMcpRef(input: {
  indexed: IndexedToolUse;
  extractorVersion: number;
  timestamp: string;
  method: string;
  repositoryFullName: string;
  pullNumber: number | undefined;
  readMethod: string | undefined;
}): ArtifactRefRecord | undefined {
  if (!input.pullNumber) {
    return undefined;
  }
  const isRead =
    input.method === GitHubMonitoredActivityTool.PullRequestRead &&
    input.readMethod !== undefined &&
    GITHUB_PULL_REQUEST_READ_METHODS.has(input.readMethod);
  const isAction = GITHUB_PULL_REQUEST_ACTION_METHODS.has(input.method);
  if (!(isRead || isAction)) {
    return undefined;
  }
  const headBranch = findHeadBranch(input.indexed.tu.output);
  return mcpRef({
    indexed: input.indexed,
    extractorVersion: input.extractorVersion,
    timestamp: input.timestamp,
    target: {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: input.repositoryFullName,
      prNumber: input.pullNumber,
      ...(headBranch ? { branchName: headBranch } : {}),
    },
    eventKind: isRead
      ? MonitoredSessionActivityEventKind.AgentRead
      : MonitoredSessionActivityEventKind.AgentAction,
  });
}

function mcpRef(input: {
  indexed: IndexedToolUse;
  extractorVersion: number;
  timestamp: string;
  target: ActivityTarget;
  eventKind: MonitoredSessionActivityEventKind;
}): ArtifactRefRecord {
  const common = {
    relation:
      input.target.kind === ArtifactRefTargetKind.PullRequest
        ? ArtifactRefRelation.Reviewed
        : ArtifactRefRelation.Created,
    method: ArtifactRefMethod.McpToolCall,
    confidence: ArtifactRefConfidence.McpCall,
    evidence: JSON.stringify({
      toolIndex: input.indexed.toolIndex,
      toolName: input.indexed.tu.name,
      mcpMethod: githubMonitoredActivityMethod(input.indexed.tu),
      monitoredActivityKind: input.eventKind,
    }),
    observedAt: input.timestamp,
    extractorVersion: input.extractorVersion,
    isPrimary: false,
    monitoredActivityOnly: true as const,
  };
  if (input.target.kind === ArtifactRefTargetKind.Branch) {
    return {
      ...common,
      targetKind: ArtifactRefTargetKind.Branch,
      targetIdentity: input.target.branchName,
      repoFullName: input.target.repositoryFullName,
      branchName: input.target.branchName,
    };
  }
  return {
    ...common,
    targetKind: ArtifactRefTargetKind.PullRequest,
    targetIdentity: `${input.target.repositoryFullName}#${input.target.prNumber}`,
    repoFullName: input.target.repositoryFullName,
    prNumber: input.target.prNumber,
    branchName: input.target.branchName,
  };
}

function createdPullRequestTarget(
  toolUse: NormalizedToolUse,
  expectedRepository: string,
  head: string | undefined
): Extract<ActivityTarget, { kind: "pull_request" }> | undefined {
  if (!(head && isValidBranchName(head))) {
    return undefined;
  }
  for (const text of boundedNestedTextValues(toolUse.output)) {
    for (const match of text.matchAll(GITHUB_PR_URL_RE)) {
      const repositoryFullName = normalizedMonitoredRepository(
        match[1],
        match[2]
      );
      const prNumber = Number(match[3]);
      if (
        repositoryFullName === expectedRepository &&
        Number.isSafeInteger(prNumber) &&
        prNumber > 0
      ) {
        return {
          kind: ArtifactRefTargetKind.PullRequest,
          repositoryFullName,
          prNumber,
          branchName: head,
        };
      }
    }
  }
  return undefined;
}

/** Resolve only the frozen, attributable GitHub MCP activity surface. */
export function githubMonitoredActivityMethod(
  toolUse: NormalizedToolUse
): string | undefined {
  const candidates = [
    toolUse.mcpMethod,
    toolUse.normalizedName,
    toolUse.rawName,
    toolUse.name,
  ].filter((value): value is string => typeof value === "string");
  const explicitServer = toolUse.mcpServer?.trim().toLowerCase();
  if (explicitServer && explicitServer !== "github") {
    return undefined;
  }
  const methods = new Set<string>();
  for (const candidate of candidates) {
    const prefixed = GITHUB_MCP_PREFIX_RE.test(candidate);
    if (!(prefixed || explicitServer === "github")) {
      continue;
    }
    const normalized = candidate.replace(GITHUB_MCP_PREFIX_RE, "");
    if (
      normalized === GitHubMonitoredActivityTool.PullRequestRead ||
      normalized === GitHubMonitoredActivityTool.CreatePullRequest ||
      normalized === GitHubMonitoredActivityTool.CreateBranch ||
      GITHUB_PULL_REQUEST_ACTION_METHODS.has(normalized)
    ) {
      methods.add(normalized);
    }
  }
  return methods.size === 1 ? methods.values().next().value : undefined;
}

function findHeadBranch(value: unknown): string | undefined {
  const object = evidenceObjectSchema.safeParse(value);
  if (!object.success) {
    return undefined;
  }
  const head = evidenceObjectSchema.safeParse(object.data.head);
  const directRef = head.success ? head.data.ref : undefined;
  return typeof directRef === "string" && isValidBranchName(directRef)
    ? directRef
    : undefined;
}
