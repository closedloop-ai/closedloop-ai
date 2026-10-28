// gardener-support: test and story data, not shipped
// Closedloop domain sample data for Storybook.
//
// FEA-4296: these fixtures used to live in
// `@repo/design-system/storybook/mock-data.ts`, which made the generic component
// library import `@closedloop-ai/loops-api` domain status configs — the exact thing
// `packages/design-system/AGENTS.md` bans. The generic half of that module
// (users, invoice rows, chart series) stayed behind; everything
// typed by a Closedloop contract moved here, to the package that already owns
// domain code for both the web app and the desktop renderer.
//
// Story-only fixtures: nothing in a shipped render path imports this module.

import { Priority } from "@closedloop-ai/loops-api/common";
import {
  DocumentStatus,
  IssueStatus,
  type PullRequestInfo,
  PullRequestState,
} from "@closedloop-ai/loops-api/document";
import type { GitHubRepository } from "@closedloop-ai/loops-api/github";

export const mockGitHubRepository = {
  id: "repo-1",
  fullName: "closedloop-ai/closedloop-ai",
  name: "closedloop-ai",
  owner: "closedloop-ai",
  private: true,
  githubRepoId: "123456789",
  lastPushedAt: "2026-05-27T15:45:00.000Z",
} satisfies GitHubRepository;

export const mockPullRequest = {
  id: "pr-1",
  number: 1323,
  title: "Catalog app-owned composites in Storybook",
  htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/1323",
  state: PullRequestState.Open,
  isDraft: false,
  headBranch: "feat/design-system-storybook-catalog",
  baseBranch: "main",
  createdAt: new Date("2026-05-28T12:00:00.000Z"),
  checksStatus: null,
  reviewDecision: null,
  externalLinkId: null,
  repoFullName: "closedloop-ai/closedloop-ai",
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
