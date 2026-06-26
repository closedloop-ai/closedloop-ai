import {
  type BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { BranchDetailPage } from "./branch-detail-page";

const populatedDetail: BranchPageDetail = {
  id: "owner%2Frepo::feature%2Fx",
  branchName: "feature/branches-detail",
  baseBranch: "main",
  repoFullName: "owner/repo",
  owner: "alice",
  status: BranchStatus.Open,
  prNumber: 1270,
  prTitle: "Add Branch Detail page",
  prState: "OPEN",
  prUrl: "https://github.com/owner/repo/pull/1270",
  multiPrWarning: false,
  checksStatus: null,
  checksPassed: null,
  checksTotal: null,
  reviewDecision: null,
  ahead: null,
  behind: null,
  additions: null,
  deletions: null,
  filesChanged: null,
  estimatedCostUsd: 4.2,
  lastActivityAt: "2026-06-17T12:00:00.000Z",
  sessionIds: ["s1", "s2"],
  prBody: "Implements the Branch Detail shell.",
  prBodyHtmlUrl: "https://github.com/owner/repo/pull/1270",
  headSha: null,
  mergeCommitSha: null,
  mergedAt: null,
  closedAt: null,
  openedAt: null,
  commits: [],
  sessions: [
    {
      sessionId: "s1",
      slug: "sess-one",
      name: "Scaffold the shell",
      harness: "claude",
      startedAt: "2026-06-17T09:00:00.000Z",
      endedAt: "2026-06-17T10:00:00.000Z",
      isPrimary: true,
      estimatedCostUsd: 2.1,
      inputTokens: 1000,
      outputTokens: 2000,
      cacheReadTokens: 500,
      cacheWriteTokens: 300,
    },
  ],
  mergedTrace: [{ type: "end", sessionId: "s1", text: "Session ended" }],
  linkedPrNumbers: [1270],
  linkedArtifacts: [{ slug: "FEA-1952" }, { slug: "PLN-988" }],
};

const StoryFrame = ({ children }: { children: ReactNode }) => (
  <div className="flex h-[600px] w-full">{children}</div>
);

const meta = {
  title: "App Core/Branches/Branch Detail Page",
  component: BranchDetailPage,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  decorators: [(Story) => <StoryFrame>{<Story />}</StoryFrame>],
  args: {
    branchId: "b-1",
    backHref: "/branches",
    isLoading: false,
    isError: false,
  },
} satisfies Meta<typeof BranchDetailPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  args: { isLoading: true },
};

export const ErrorState: Story = {
  args: { isError: true },
};

export const EmptyNoSessions: Story = {
  args: { detail: { ...populatedDetail, sessions: [] } },
};

export const Populated: Story = {
  args: { detail: populatedDetail },
};
