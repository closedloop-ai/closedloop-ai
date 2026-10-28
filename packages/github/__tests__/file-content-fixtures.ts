import type { Octokit } from "@octokit/rest";
import { type Mock, vi } from "vitest";

// The module is credential-agnostic: callers inject the Octokit, so the tests
// do too — no App env, no auth mocking.
export const mockCompareCommitsWithBasehead: Mock = vi.fn();
export const mockReposGetContent: Mock = vi.fn();
export const mockGitGetBlob: Mock = vi.fn();

export const octokit = {
  rest: {
    repos: { compareCommitsWithBasehead: mockCompareCommitsWithBasehead },
  },
  repos: { getContent: mockReposGetContent },
  git: { getBlob: mockGitGetBlob },
} as unknown as Octokit;

type FileEntryOverrides = {
  content?: unknown;
  encoding?: string;
  sha?: string;
  size?: number;
};

export function fileEntryResponse(overrides: FileEntryOverrides = {}) {
  return { data: { type: "file", sha: "entry-sha", size: 8, ...overrides } };
}
