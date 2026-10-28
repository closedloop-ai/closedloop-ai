/**
 * ISS-12135: what each golden corpus session was asked to do, and the Acme
 * names its work goes by. One record per session carries the session's title
 * (summarizing its own opening prompts) and every branch the session worked
 * on, each with the pull request it opened, so a branch's name, its pull
 * request and the session linked to it all describe the same piece of work.
 *
 * The corpus is not part of this edition, so the session ids, corpus branch
 * names and `openingPrompt` values below are synthetic placeholders that keep
 * the record shape: each `openingPrompt` repeats words from its own title.
 */

export type VibeSeedPullRequestTopic = {
  readonly title: string;
  readonly body: string;
};

export type VibeSeedBranchTopic = {
  /** The branch as the corpus names it. */
  readonly corpusBranch: string;
  /** The Acme branch it becomes. */
  readonly branch: string;
  /**
   * A word the Acme branch name, its pull request title and the session's
   * (rewritten) transcript all carry.
   */
  readonly topic: string;
  /** The pull request the session opened from the branch, if any. */
  readonly pullRequest: VibeSeedPullRequestTopic | null;
};

export type VibeSeedSessionTopic = {
  readonly sessionId: string;
  readonly title: string;
  /**
   * Words from the session's opening prompts (rewritten) that the title
   * summarizes; the title carries at least one of them.
   */
  readonly openingPrompt: string;
  readonly branches: readonly VibeSeedBranchTopic[];
};

const ARM_RUNNER_BRANCHES: readonly VibeSeedBranchTopic[] = [
  {
    corpusBranch: "corpus/ci/pause-shadow-jobs",
    branch: "ci/pause-shadow-jobs",
    topic: "shadow",
    pullRequest: {
      title: "ACME-2172: Pause the per-PR arm shadow runs",
      body: "The arm shadow runs have matched the x86 results on recent pull requests with no arm-only failures. Pausing them saves runner time until the remaining jobs move over.",
    },
  },
  {
    corpusBranch: "corpus/ci/arm-pr-jobs",
    branch: "ci/arm-pr-jobs",
    topic: "arm",
    pullRequest: {
      title:
        "ACME-2172: Move lint, typecheck, Storybook and desktop jobs to arm",
      body: "The shadow runs proved these four PR jobs pass the same on arm as on x86, so they move to arm runners. Unit tests stay on x86 until the build memory fix lands.",
    },
  },
  {
    corpusBranch: "corpus/ci/prune-shadow-jobs",
    branch: "ci/prune-shadow-jobs",
    topic: "shadow",
    pullRequest: {
      title: "ACME-2172: Drop shadow jobs for checks already on arm",
      body: "Lint, typecheck, Storybook and desktop now run on arm for real, so their shadow copies go. Only the unit test shadow stays until that job moves.",
    },
  },
  {
    corpusBranch: "corpus/ci/unit-arm-runners",
    branch: "ci/unit-arm-runners",
    topic: "arm",
    pullRequest: {
      title: "ACME-2172: Move unit tests to 8-core arm runners",
      body: "Last step of the arm move. With the build memory fix merged, the unit test job runs on 8-core arm and its shadow job is removed.",
    },
  },
  {
    corpusBranch: "corpus/ci/arm-compute-job-sizes",
    branch: "ci/arm-compute-job-sizes",
    topic: "arm",
    pullRequest: {
      title: "ACME-2172: Run lint, typecheck and Storybook on 4-core arm",
      body: "Re-ran the heavier PR jobs on every arm runner size with speed as the goal. 4-core arm gives the best time for the cost on all three.",
    },
  },
  {
    corpusBranch: "corpus/bench/browser-runner-sizing",
    branch: "bench/browser-runner-sizing",
    topic: "runner",
    pullRequest: {
      title: "ACME-2172: Benchmark the browser test job across runner sizes",
      body: "Temporary benchmark: runs the browser test job on x86, 8-core arm and 16-core arm from the same commit so we can pick the size before moving it.",
    },
  },
  {
    corpusBranch: "corpus/ci/browser-arm-runners",
    branch: "ci/browser-arm-runners",
    topic: "arm",
    pullRequest: {
      title: "ACME-2172: Move the browser test job to 16-core arm runners",
      body: "The browser test job is the longest step in the pipeline. Cold and warm runs put 16-core arm well ahead of x86 and 8-core arm, so the job moves there.",
    },
  },
  {
    corpusBranch: "corpus/bench/desktop-runner-sizing",
    branch: "bench/desktop-runner-sizing",
    topic: "runner",
    pullRequest: {
      title: "ACME-2172: Benchmark the desktop job across arm runner sizes",
      body: "Temporary benchmark: runs the desktop job on 2, 4 and 8-core arm runners from the same commit to choose its size.",
    },
  },
  {
    corpusBranch: "corpus/ci/desktop-arm-runners",
    branch: "ci/desktop-arm-runners",
    topic: "arm",
    pullRequest: {
      title: "ACME-2172: Run the desktop PR job on 4-core arm runners",
      body: "Desktop became the longest PR job once the others moved to arm. A 4-core arm runner brings it back in line with the rest.",
    },
  },
];

export const VIBE_SEED_SESSION_TOPICS: readonly VibeSeedSessionTopic[] = [
  {
    sessionId: "c8a3eb17-b0f5-484e-b007-a45a230dbad7",
    title: "Analyze failing CI checks on recent PRs",
    openingPrompt: "analyze failing ci",
    branches: [
      {
        corpusBranch: "corpus/feat/local-verify-command",
        branch: "feat/local-verify-command",
        topic: "verify",
        pullRequest: {
          title: "ACME-1772: Add a verify command that matches the PR checks",
          body: "Most red CI runs on last month's pull requests were lint and type errors a local run would have caught.\n\n- `pnpm verify` runs the same lint and typecheck steps as the required PR checks.\n- The full typecheck moves from the pre-commit hook to pre-push, so small commits stay fast.\n- A test keeps the verify steps in step with the CI workflow.",
        },
      },
      {
        corpusBranch: "corpus/fix/lint-ignore-paths",
        branch: "fix/lint-ignore-paths",
        topic: "ignore",
        pullRequest: null,
      },
    ],
  },
  {
    sessionId: "8be9cfc9-43f2-4776-9c36-6c74963efa6c",
    title: "Check whether ACME-5318 is ready to plan",
    openingPrompt: "check whether acme-5318",
    branches: [
      {
        corpusBranch: "corpus/feat/recommended-sync-level",
        branch: "feat/recommended-sync-level",
        topic: "sync",
        pullRequest: {
          title: "ACME-5318: Mark the recommended data sync level",
          body: "First pass at labeling the recommended data sync level in Settings. Replaced by the shared level card.",
        },
      },
      {
        corpusBranch: "corpus/fix/shared-sync-level-order",
        branch: "fix/shared-sync-level-order",
        topic: "sync",
        pullRequest: {
          title: "ACME-6147: Share the data sync level order across screens",
          body: "Settings and onboarding each kept their own order for the data sync levels, so the same level sat in different places. The order now lives in one shared list.",
        },
      },
      {
        corpusBranch: "corpus/feat/data-sync-level-labels",
        branch: "feat/data-sync-level-labels",
        topic: "sync",
        pullRequest: {
          title:
            "ACME-5318: Relabel the data sync levels in Settings and onboarding",
          body: "Settings, onboarding and the sign-in prompt now describe each data sync level the same way. One shared card marks the recommended level, so the screens can't point at different ones.",
        },
      },
      {
        corpusBranch: "corpus/fix/data-sync-level-order",
        branch: "fix/data-sync-level-order",
        topic: "sync",
        pullRequest: {
          title: "ACME-6147: Use one data sync level picker everywhere",
          body: "Settings still listed the sync levels in the opposite order from onboarding. Both screens now render the same picker, the level list is declared once, and full transcripts is the recommended level.",
        },
      },
    ],
  },
  {
    sessionId: "f04610b7-baf0-7c5a-8a47-bb2206fc06b3",
    title: "Find out why the merged PR missed the median size fix",
    openingPrompt: "find out why",
    branches: [
      {
        corpusBranch: "corpus/fix/median-pr-size",
        branch: "fix/median-pr-size",
        topic: "median",
        pullRequest: {
          title:
            "ACME-2159: Read median PR size from the pull request's own diff",
          body: "Median PR size on the Branches page still counted lines from every push after the first fix merged. It now uses the pull request's own line counts, and answers the open review comment about the empty case.",
        },
      },
    ],
  },
  {
    sessionId: "8c842b24-dc1d-45cf-8a77-f010822c47f3",
    title: "Babysit the activity attribution PR",
    openingPrompt: "babysit the activity",
    branches: [
      {
        corpusBranch: "corpus/feat/activity-attribution",
        branch: "feat/activity-attribution",
        topic: "attribution",
        pullRequest: {
          title: "ACME-1459: Improve session activity attribution",
          body: "Desktop now resumes transcript parsing where it left off and records which turns belong to which session, so activity lands on the right session and branch. Includes the Desktop version bump.",
        },
      },
    ],
  },
  {
    sessionId: "06835415-e7a2-4b3f-8a09-e7526c329921",
    title: "Rename the Tokens card to Total Tokens",
    openingPrompt: "rename the tokens",
    branches: [
      {
        corpusBranch: "corpus/feat/total-tokens-label",
        branch: "feat/total-tokens-label",
        topic: "total tokens",
        pullRequest: {
          title: "ACME-1932: Rename the Tokens card to Total Tokens",
          body: "The card at the top of the Sessions page now reads Total Tokens on web and Desktop. Bumps the Desktop version for the label change.",
        },
      },
    ],
  },
  {
    sessionId: "4eba5e9a-6b1e-473a-9882-3c1c06cc32ce",
    title: "Fix Recent Sessions not matching the Sessions list",
    openingPrompt: "fix recent sessions",
    branches: [
      {
        corpusBranch: "corpus/fix/recent-sessions-list",
        branch: "fix/recent-sessions-list",
        topic: "recent sessions",
        pullRequest: {
          title: "ACME-2180: Align Recent Sessions with the Sessions list",
          body: "The dashboard's Recent Sessions card filtered by start time while the Sessions list filtered by last activity, so their top rows disagreed. Both now filter and sort by last activity.",
        },
      },
    ],
  },
  {
    sessionId: "3870c244-d8be-4a45-9d1a-2c5bf2b0d38f",
    title: "Add a CSV export to the Insights dashboard",
    openingPrompt: "add a csv",
    branches: [
      {
        corpusBranch: "corpus/feat/insights-csv-export",
        branch: "feat/insights-csv-export",
        topic: "csv",
        pullRequest: {
          title: "Add CSV export to the Insights dashboard",
          body: "Adds an Export CSV button next to Share on Insights. It writes the KPIs and chart buckets already on screen to one file, so nothing is fetched again.",
        },
      },
    ],
  },
  {
    sessionId: "f04b2b82-26a5-477d-86f2-f11ab1b550f9",
    title: "Simplify the Cursor transcript parser",
    openingPrompt: "simplify the cursor",
    branches: [
      {
        corpusBranch: "corpus/fix/cursor-transcript-parser",
        branch: "fix/cursor-transcript-parser",
        topic: "cursor",
        pullRequest: {
          title: "Dispatch Cursor transcript events through a handler map",
          body: "The Cursor transcript parser ran every line through a long chain of type checks. Each event type now has its own handler, which reads more simply and is faster on long sessions.",
        },
      },
    ],
  },
  {
    sessionId: "96fef0b5-1717-478c-91d5-5d36576ec254",
    title: "Review PR #1580 and fix what it finds",
    openingPrompt: "review pr #1580",
    branches: [
      {
        corpusBranch: "corpus/chore/design-review-fixes",
        branch: "chore/design-review-fixes",
        topic: "design",
        pullRequest: null,
      },
      {
        corpusBranch: "corpus/chore/engineer-helper-order",
        branch: "chore/engineer-helper-order",
        topic: "helper",
        pullRequest: {
          title: "Move new engineer helpers to the bottom of their files",
          body: "Review follow-up: the helpers and caches added to the log viewer and repos modules move below the exports, matching the rest of the codebase.",
        },
      },
      {
        corpusBranch: "corpus/chore/engineer-helper-coverage",
        branch: "chore/engineer-helper-coverage",
        topic: "coverage",
        pullRequest: {
          title: "Add test coverage for the engineer and API helpers",
          body: "Covers modules that had no tests: stable JSON stringify, the API namespace helper, and the engineer helpers for allowed tools, deploy detection, learnings and repos.",
        },
      },
      {
        corpusBranch: "corpus/docs/install-checklist",
        branch: "docs/install-checklist",
        topic: "checklist",
        pullRequest: {
          title: "Turn the prework checklist into an install and verify guide",
          body: "Rewrites the one-day prework checklist as a table of tools, each with an install link and a command to check it works.",
        },
      },
    ],
  },
  {
    sessionId: "be42c362-31ba-4ac1-b4a5-65f447c2989d",
    title: "Resume arm64 GitHub runner benchmarks",
    openingPrompt: "resume arm64 github",
    branches: ARM_RUNNER_BRANCHES,
  },
  {
    sessionId: "3927c8aa-be8b-4deb-ad25-920fd9506aa0",
    title: "Find where the desktop session signing secret is set",
    openingPrompt: "find where the",
    branches: [
      {
        corpusBranch: "corpus/chore/session-signing-secret",
        branch: "chore/session-signing-secret",
        topic: "secret",
        pullRequest: {
          title: "ACME-2215: Add the desktop session signing secret to the API",
          body: "Adds the desktop session signing secret to the staging and production API projects. Each environment reads its own value from the secrets store.",
        },
      },
      {
        corpusBranch: "corpus/chore/pin-domain-autoassign",
        branch: "chore/pin-domain-autoassign",
        topic: "assign",
        pullRequest: {
          title: "ACME-2402: Stop custom domains auto-assigning in production",
          body: "The hosting module never set custom domain auto-assignment, so every apply turned it back on. This pins it off for the production API and app projects.",
        },
      },
    ],
  },
  {
    sessionId: "98a1952f-d39f-7cb6-8b61-a6b0285b81bf",
    title: "Bump the version on acme-desktop PR #204",
    openingPrompt: "bump the version",
    branches: [
      {
        corpusBranch: "corpus/feature/agent-pack-usage",
        branch: "feature/agent-pack-usage",
        topic: "pack",
        pullRequest: null,
      },
      {
        corpusBranch: "corpus/feature/rollout-reimport",
        branch: "feature/rollout-reimport",
        topic: "rollout",
        pullRequest: null,
      },
    ],
  },
  {
    sessionId: "cc6c71e9-9fab-7224-a59c-ea11c5b76b33",
    title: "Review my local agent toolkit changes",
    openingPrompt: "review my local",
    branches: [
      {
        corpusBranch: "corpus/refactor/spec-only-review-fleet",
        branch: "refactor/spec-only-review-fleet",
        topic: "fleet",
        pullRequest: null,
      },
    ],
  },
  {
    sessionId: "56f2ab4a-50a7-496a-8753-4ccece51efe2",
    title: "Deep review of the documents table refactor",
    openingPrompt: "deep review of",
    branches: [
      {
        corpusBranch: "corpus/refactor/documents-table",
        branch: "refactor/documents-table",
        topic: "document",
        pullRequest: null,
      },
    ],
  },
  {
    sessionId: "6d6d2e80-0eba-41ab-af71-4d789e12f8b3",
    title: "Review PR #1349, the design system adoption audit",
    openingPrompt: "review pr #1349,",
    branches: [
      {
        corpusBranch: "corpus/chore/design-system-audit",
        branch: "chore/design-system-audit",
        topic: "design",
        pullRequest: null,
      },
    ],
  },
  {
    sessionId: "74afe1af-8382-4046-8bdd-e9e1788b0871",
    title: "Fix the off-by-one loop counter in utils.ts",
    openingPrompt: "fix the off-by-one",
    branches: [],
  },
  {
    sessionId: "8b585ea4-985e-4082-8edc-737fc1e3984b",
    title: "Run the adversarial delegation checks",
    openingPrompt: "run the adversarial",
    branches: [],
  },
  {
    sessionId: "7da87bc7-83f6-7bef-8524-edfc58585a4f",
    title: "Fix the review comments on PR #1384",
    openingPrompt: "fix the review",
    branches: [],
  },
  {
    sessionId: "6f6f2bf6-e2ac-7dd1-b3db-218723e00426",
    title: "Review PR #1583 for production bugs",
    openingPrompt: "review pr #1583",
    branches: [],
  },
  {
    sessionId: "ea05d76f-672f-7519-8a9b-6857c6870112",
    title: "Run the automation coverage review lane",
    openingPrompt: "run the automation",
    branches: [],
  },
  {
    sessionId: "8bbdbfab-d89a-78f7-bd3d-40e5b3a0a268",
    title: "Celebrate every 10 dispatched trains",
    openingPrompt: "celebrate every 10",
    branches: [],
  },
  {
    sessionId: "8998f3ad-3f84-7514-8465-2ee2d2cf9b6a",
    title: "Generate a short conversation title",
    openingPrompt: "generate a short",
    branches: [],
  },
  {
    sessionId: "32fb8a25-3295-780b-a798-3cb5f03280aa",
    title: "Fix the sidebar component layout bug",
    openingPrompt: "fix the sidebar",
    branches: [],
  },
  {
    sessionId: "8a61a0c9-4cfe-716d-bed1-fb1153589bb8",
    title: "Check a session that switched models partway",
    openingPrompt: "check a session",
    branches: [],
  },
  {
    sessionId: "aff9f567-f770-4b4d-ad6f-73f9a04be5f5",
    title: "Check whether ACME-7237 is ready to plan",
    openingPrompt: "check whether acme-7237",
    branches: [],
  },
  {
    sessionId: "0e0036cc-8ac4-4dc7-a9e4-9920b4e657ae",
    title: "Move ACME-7237 to blocked with next steps",
    openingPrompt: "move acme-7237 to",
    branches: [],
  },
  {
    sessionId: "b03ada09-84bb-4659-a0fa-89ef075af5b5",
    title: "Plan next steps for coding session",
    openingPrompt: "plan next steps",
    branches: [],
  },
  {
    sessionId: "90458a99-5204-453f-881d-583071f4f9a1",
    title: "Find the desktop app's SQLite database",
    openingPrompt: "find the desktop",
    branches: [],
  },
  {
    sessionId: "0c93c742-cc24-49e9-ac29-eeae1ce587f6",
    title: "Determine if init should run on existing project",
    openingPrompt: "determine if init",
    branches: [],
  },
  {
    sessionId: "7ea90a55-f6b8-4332-8906-627e5a86add0",
    title: "Compare the fork and branch commands",
    openingPrompt: "compare the fork",
    branches: [],
  },
  {
    sessionId: "eca0b151-fb1b-41dc-a6b0-a96323c7311d",
    title: "Install the Understand Anything plugin",
    openingPrompt: "install the understand",
    branches: [],
  },
  {
    sessionId: "a3226ea3-d5ed-46f0-b456-457c8851fcab",
    title: "Analyze largest files by line count",
    openingPrompt: "analyze largest files",
    branches: [],
  },
  {
    sessionId: "opencode-ses_fa6832d22ffeP9RQlLpkf7UK4e",
    title: "Check GPT-5.5 pricing in opencode",
    openingPrompt: "check gpt-5.5 pricing",
    branches: [],
  },
  {
    sessionId: "opencode-ses_fa696a91bffeO6nigLf2pCQ6s6",
    title: "Try out an opencode session",
    openingPrompt: "try out an",
    branches: [],
  },
];
