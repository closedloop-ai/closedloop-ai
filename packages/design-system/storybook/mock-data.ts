import { LoopCommand, LoopStatus } from "@closedloop-ai/loops-api/commands";
import { Priority } from "@closedloop-ai/loops-api/common";
import type { BackendMismatchBody } from "@closedloop-ai/loops-api/compute-target";
import {
  DocumentStatus,
  type PullRequestInfo,
  PullRequestState,
} from "@closedloop-ai/loops-api/document";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import type { FriendlyErrorInput } from "@closedloop-ai/loops-api/friendly-error";
import type { GitHubRepository } from "@closedloop-ai/loops-api/github";
import {
  AudioWaveform,
  BookOpen,
  Bot,
  Command,
  Frame,
  GalleryVerticalEnd,
  type LucideIcon,
  PieChart,
  Settings2,
  SquareTerminal,
} from "lucide-react";

export type MockUser = {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  initials?: string;
};

export const mockUsers: MockUser[] = [
  {
    id: "user-1",
    name: "Avery Carter",
    email: "avery@example.com",
    initials: "AC",
  },
  {
    id: "user-2",
    name: "Jordan Lee",
    email: "jordan@example.com",
    initials: "JL",
  },
  {
    id: "user-3",
    name: "Samir Patel",
    email: "samir@example.com",
    initials: "SP",
  },
];

export const mockInvoiceRows = [
  {
    invoice: "INV001",
    paymentStatus: "Paid",
    totalAmount: "$250.00",
    paymentMethod: "Credit Card",
  },
  {
    invoice: "INV002",
    paymentStatus: "Pending",
    totalAmount: "$150.00",
    paymentMethod: "PayPal",
  },
  {
    invoice: "INV003",
    paymentStatus: "Unpaid",
    totalAmount: "$350.00",
    paymentMethod: "Bank Transfer",
  },
  {
    invoice: "INV004",
    paymentStatus: "Paid",
    totalAmount: "$450.00",
    paymentMethod: "Credit Card",
  },
];

export type MockProjectRow = {
  id: string;
  name: string;
  owner: string;
  status: "Backlog" | "Active" | "Paused";
  updatedAt: string;
};

export const mockProjectRows: MockProjectRow[] = [
  {
    id: "project-1",
    name: "Billing v2",
    owner: "Avery Carter",
    status: "Active",
    updatedAt: "2026-05-24",
  },
  {
    id: "project-2",
    name: "Mobile onboarding",
    owner: "Jordan Lee",
    status: "Backlog",
    updatedAt: "2026-05-18",
  },
  {
    id: "project-3",
    name: "Usage reporting",
    owner: "Samir Patel",
    status: "Paused",
    updatedAt: "2026-05-12",
  },
  {
    id: "project-4",
    name: "Editor refresh",
    owner: "Avery Carter",
    status: "Active",
    updatedAt: "2026-05-27",
  },
  {
    id: "project-5",
    name: "Compute target audit",
    owner: "Jordan Lee",
    status: "Backlog",
    updatedAt: "2026-05-09",
  },
];

export const mockTrafficByMonth = [
  { month: "January", desktop: 186, mobile: 80 },
  { month: "February", desktop: 305, mobile: 200 },
  { month: "March", desktop: 237, mobile: 120 },
  { month: "April", desktop: 73, mobile: 190 },
  { month: "May", desktop: 209, mobile: 130 },
  { month: "June", desktop: 214, mobile: 140 },
];

export const mockBrowserVisitors = [
  { browser: "chrome", visitors: 275, fill: "var(--color-chrome)" },
  { browser: "safari", visitors: 200, fill: "var(--color-safari)" },
  { browser: "other", visitors: 190, fill: "var(--color-other)" },
];

type MockSidebarTeam = {
  name: string;
  logo: LucideIcon;
  plan: string;
};

type MockSidebarLink = {
  title: string;
  url: string;
};

type MockSidebarGroup = {
  title: string;
  url: string;
  icon: LucideIcon;
  isActive?: boolean;
  items: MockSidebarLink[];
};

type MockSidebarProject = {
  name: string;
  url: string;
  icon: LucideIcon;
};

export const mockSidebarData: {
  user: {
    name: string;
    email: string;
    avatar: string;
  };
  teams: MockSidebarTeam[];
  navMain: MockSidebarGroup[];
  projects: MockSidebarProject[];
} = {
  user: {
    name: "shadcn",
    email: "m@example.com",
    avatar: "/avatars/shadcn.jpg",
  },
  teams: [
    {
      name: "Acme Inc",
      logo: GalleryVerticalEnd,
      plan: "Enterprise",
    },
    {
      name: "Acme Corp.",
      logo: AudioWaveform,
      plan: "Startup",
    },
    {
      name: "Evil Corp.",
      logo: Command,
      plan: "Free",
    },
  ],
  navMain: [
    {
      title: "Playground",
      url: "#",
      icon: SquareTerminal,
      isActive: true,
      items: [
        {
          title: "History",
          url: "#",
        },
        {
          title: "Starred",
          url: "#",
        },
        {
          title: "Settings",
          url: "#",
        },
      ],
    },
    {
      title: "Models",
      url: "#",
      icon: Bot,
      items: [
        {
          title: "Genesis",
          url: "#",
        },
        {
          title: "Explorer",
          url: "#",
        },
        {
          title: "Quantum",
          url: "#",
        },
      ],
    },
    {
      title: "Documentation",
      url: "#",
      icon: BookOpen,
      items: [
        {
          title: "Introduction",
          url: "#",
        },
        {
          title: "Get Started",
          url: "#",
        },
        {
          title: "Tutorials",
          url: "#",
        },
        {
          title: "Changelog",
          url: "#",
        },
      ],
    },
    {
      title: "Settings",
      url: "#",
      icon: Settings2,
      items: [
        {
          title: "General",
          url: "#",
        },
        {
          title: "Team",
          url: "#",
        },
        {
          title: "Billing",
          url: "#",
        },
        {
          title: "Limits",
          url: "#",
        },
      ],
    },
  ],
  projects: [
    {
      name: "Design Engineering",
      url: "#",
      icon: Frame,
    },
    {
      name: "Sales & Marketing",
      url: "#",
      icon: PieChart,
    },
    {
      name: "Developer Docs",
      url: "#",
      icon: Command,
    },
  ],
};

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
  DocumentStatus.InProgress,
  DocumentStatus.InReview,
  DocumentStatus.Approved,
  DocumentStatus.Executed,
  DocumentStatus.Done,
  DocumentStatus.Obsolete,
] as const;

export const mockFeaturePriorityOptions = [
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
