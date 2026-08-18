// Closedloop domain sample data for Storybook.
//
// FEA-4296: these fixtures used to live in
// `@repo/design-system/storybook/mock-data.ts`, which made the generic component
// library import `@closedloop-ai/loops-api` domain status configs — the exact thing
// `packages/design-system/AGENTS.md` bans. The generic half of that module
// (users, invoice rows, chart series, sidebar nav) stayed behind; everything
// typed by a Closedloop contract moved here, to the package that already owns
// domain code for both the web app and the desktop renderer.
//
// Story-only fixtures: nothing in a shipped render path imports this module.

import { LoopCommand, LoopStatus } from "@closedloop-ai/loops-api/commands";
import { Priority } from "@closedloop-ai/loops-api/common";
import type { BackendMismatchBody } from "@closedloop-ai/loops-api/compute-target";
import {
  DocumentStatus,
  IssueStatus,
  type PullRequestInfo,
  PullRequestState,
} from "@closedloop-ai/loops-api/document";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import type { FriendlyErrorInput } from "@closedloop-ai/loops-api/friendly-error";
import type { GitHubRepository } from "@closedloop-ai/loops-api/github";

export const mockBackendMismatch = {
  error: "backend_mismatch",
  message: "Artifact was last run on a different compute target.",
  originalComputeTargetId: "ct-original",
  originalComputeTargetName: "Local GPU Runner",
  preferredComputeTargetId: "ct-preferred",
  documentId: "doc-42",
} satisfies BackendMismatchBody;

export const mockFriendlyError = {
  code: LoopErrorCode.RunnerError,
  message: "Claude CLI exited before the loop completed.",
  details: {
    runnerSubcode: "CLAUDE_RATE_LIMIT",
    repoPath: "/Users/example/repo",
  },
  timestamp: "2026-05-28T14:32:00.000Z",
} satisfies FriendlyErrorInput;

export const mockGitHubRepository = {
  id: "repo-1",
  fullName: "closedloop-ai/symphony-alpha",
  name: "symphony-alpha",
  owner: "closedloop-ai",
  private: true,
  githubRepoId: "123456789",
  lastPushedAt: "2026-05-27T15:45:00.000Z",
} satisfies GitHubRepository;

export const mockPullRequest = {
  id: "pr-1",
  number: 1323,
  title: "Catalog app-owned composites in Storybook",
  htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/1323",
  state: PullRequestState.Open,
  isDraft: false,
  headBranch: "feat/design-system-storybook-catalog",
  baseBranch: "main",
  createdAt: new Date("2026-05-28T12:00:00.000Z"),
  checksStatus: null,
  reviewDecision: null,
  externalLinkId: null,
  repoFullName: "closedloop-ai/symphony-alpha",
} satisfies PullRequestInfo;

export const mockDocumentStatusOptions = [
  DocumentStatus.Draft,
  DocumentStatus.InReview,
  DocumentStatus.ChangesRequested,
  DocumentStatus.Approved,
  DocumentStatus.Executed,
  DocumentStatus.Obsolete,
] as const;

export const mockIssueStatusOptions = [
  IssueStatus.Triage,
  IssueStatus.Backlog,
  IssueStatus.Todo,
  IssueStatus.InProgress,
  IssueStatus.InReview,
  IssueStatus.Blocked,
  IssueStatus.Done,
  IssueStatus.Canceled,
] as const;

export const mockIssuePriorityOptions = [
  Priority.Low,
  Priority.Medium,
  Priority.High,
  Priority.Urgent,
] as const;

export const mockLoopStatusOptions = [
  LoopStatus.Pending,
  LoopStatus.Running,
  LoopStatus.Completed,
  LoopStatus.Failed,
  LoopStatus.Cancelled,
] as const;

export const mockLoopCommandOptions = [
  LoopCommand.Plan,
  LoopCommand.Execute,
  LoopCommand.Chat,
  LoopCommand.Explore,
  LoopCommand.EvaluateCode,
] as const;
