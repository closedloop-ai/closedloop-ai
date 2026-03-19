import type {
  StubBranchViewData,
  StubChangedFile,
  StubPrComment,
} from "./types";

export function createStubBranchViewData(id: string): StubBranchViewData {
  return {
    externalLinkId: id,
    prTitle: "Time-Specific Items & Push Notifications",
    externalUrl: "https://github.com/example/repo/pull/42",
    featureSlug: "feat-time-specific-items",
    featureTitle: "Time-Specific Items & Push Notifications",
    teamId: "team-1",
    teamName: "Team 1",
    projectId: "proj-1",
    projectName: "Solar Efficiency Pack",
    isAuthor: true,
    producedByPlanSlug: "plan-solar-notifications",
    producedByPlanTitle: "Implementation plan: Time-Specific Notifications",
    committedFiles: stubCommittedFiles(),
    localFiles: stubLocalFiles(),
    comments: stubPrComments(),
    prState: "OPEN",
    reviewDecision: "CHANGES_REQUESTED",
    checksStatus: "PENDING",
  };
}

function stubCommittedFiles(): StubChangedFile[] {
  return [
    {
      path: "src/notifications/scheduler.ts",
      status: "modified",
      additions: 45,
      deletions: 12,
    },
    {
      path: "src/hooks/use-time-window.ts",
      status: "added",
      additions: 89,
      deletions: 0,
    },
    {
      path: "lib/push-client.ts",
      status: "modified",
      additions: 22,
      deletions: 8,
    },
  ];
}

function stubLocalFiles(): StubChangedFile[] {
  return [
    {
      path: "src/notifications/scheduler.test.ts",
      status: "added",
      additions: 120,
      deletions: 0,
    },
    {
      path: "src/notifications/scheduler.ts",
      status: "modified",
      additions: 5,
      deletions: 2,
    },
  ];
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60 * 1000).toISOString();
}

const STUB_AVATAR_JANE =
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=128&h=128&fit=crop&auto=format";
const STUB_AVATAR_JORDAN =
  "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=128&h=128&fit=crop&auto=format";
const STUB_AVATAR_ALEX =
  "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=128&h=128&fit=crop&auto=format";
const STUB_AVATAR_YOU =
  "https://images.unsplash.com/photo-1527980965255-d3b416303d12?w=128&h=128&fit=crop&auto=format";

function stubPrComments(): StubPrComment[] {
  return [
    {
      id: "c1",
      author: "Jane Doe",
      authorAvatar: STUB_AVATAR_JANE,
      body: "Consider extracting this logic into a small helper so we can unit test it in isolation.",
      createdAt: hoursAgo(2),
      path: "src/notifications/scheduler.ts",
      line: 42,
      isResolved: false,
      replies: [
        {
          id: "c1r1",
          author: "You",
          authorAvatar: STUB_AVATAR_YOU,
          body: "Good call, I'll refactor in the next commit.",
          createdAt: minutesAgo(90),
          isResolved: false,
          replies: [],
        },
      ],
    },
    {
      id: "c2",
      author: "Jordan Lee",
      authorAvatar: STUB_AVATAR_JORDAN,
      body: "Consider adding a loading skeleton for the PushNotification component while data is being fetched.",
      createdAt: hoursAgo(5),
      path: "src/components/PushNotification.tsx",
      line: 42,
      isResolved: true,
      replies: [],
    },
    {
      id: "c3",
      author: "Reviewer Bot",
      authorKind: "bot",
      body: "Lint passed. No issues found.",
      createdAt: hoursAgo(1),
      isResolved: true,
      replies: [],
    },
    {
      id: "c4",
      author: "Alex Chen",
      authorAvatar: STUB_AVATAR_ALEX,
      body: "Should we add error boundaries around the time-window hook? I've seen similar patterns fail in production when the date parser throws.",
      createdAt: hoursAgo(22),
      path: "src/hooks/use-time-window.ts",
      line: 18,
      isResolved: false,
      replies: [],
    },
  ];
}
