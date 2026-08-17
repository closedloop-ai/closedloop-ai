// The reference multi-session scenario for the prototype: a single branch whose
// detail aggregates several associated sessions: a primary implementation
// session, a code-review session (the code-review-session to branch
// association FEA-4182 calls out), and a human-driven follow-up. CI is a
// workflow of checks, not a conversational session, so it rides in a compact
// header strip instead of the session list.
// Split out of mock.ts to keep both files well under the line ceiling.

import {
  type AssociatedSession,
  type CiCheck,
  CiCheckStatus,
  type MultiSessionDetail,
  SessionKind,
  SessionStatus,
} from "./mock";

const IMPLEMENTATION_SESSION: AssociatedSession = {
  id: "sess-impl",
  kind: SessionKind.Implementation,
  title:
    "Deterministic synthetic seed generator for local and CI fixtures across org, document, and loop tables",
  actor: "claude-opus (Alex Rivera)",
  durationLabel: "42m 12s",
  tokensLabel: "318K tokens",
  costLabel: "$4.10",
  outcome:
    "Wrote the generator over the org / document / loop tables, added coverage.",
  // Counts match what the expanded transcript actually renders: 2 turns
  // (the human ask + the agent reply) and 8 tool invocations (the 5-row tools
  // block plus the test-engineer sub-agent's 3 steps).
  turnCount: 2,
  toolCount: 8,
  status: SessionStatus.Ok,
  transcript: [
    {
      id: "impl-t1",
      side: "human",
      timeLabel: "9:14am",
      blocks: [
        {
          type: "p",
          spans: [
            "Build a synthetic seed generator so we can regenerate local and CI fixtures deterministically instead of hand-maintaining them.",
          ],
        },
      ],
    },
    {
      id: "impl-t2",
      side: "agent",
      timeLabel: "9:15am",
      model: "claude-opus-4-8",
      blocks: [
        {
          type: "p",
          spans: [
            "I read the schema and mapped the ",
            { code: "org" },
            " / ",
            { code: "document" },
            " / ",
            { code: "loop" },
            " tables to generate against, then delegated the coverage pass to a sub-agent.",
          ],
        },
        {
          type: "tools",
          summary: "Ran 5 tools",
          rows: [
            { label: "Read", detail: "packages/database/prisma/schema.prisma" },
            { label: "Grep", detail: "organizationId across seed/*" },
            {
              label: "Edit",
              detail: "packages/database/seed/synthetic-generator.ts",
            },
            { label: "Bash", detail: "pnpm --filter database test: 2 failed" },
            {
              label: "Bash",
              detail: "pnpm --filter database test: 20 passed",
            },
          ],
        },
        {
          type: "subagent",
          run: {
            id: "impl-sa1",
            name: "test-engineer",
            description: "Coverage for the happy path + empty-org case",
            steps: [
              {
                label: "Read",
                detail: "apps/api/__tests__/seed-generator.test.ts",
              },
              {
                label: "Edit",
                detail: "apps/api/__tests__/seed-generator.test.ts",
              },
              { label: "Bash", detail: "pnpm --filter api test: 20 passed" },
            ],
          },
        },
        {
          type: "ul",
          items: [
            ["Generate straight into the write loop over the mapped org set."],
            ["Seed config stays a const-object enum; wire format unchanged."],
          ],
        },
      ],
    },
  ],
};

const CODE_REVIEW_SESSION: AssociatedSession = {
  id: "sess-review",
  kind: SessionKind.CodeReview,
  title: "Automated code review",
  actor: "code-review fleet",
  durationLabel: "3m 12s so far",
  tokensLabel: "58K tokens",
  costLabel: "$0.61",
  outcome: "Reviewer fleet running; bug-hunter reported a BLOCKING finding.",
  turnCount: 1,
  toolCount: 4,
  status: SessionStatus.Working,
  // This is the session that needs a human — a BLOCKING finding is on the
  // table — so the trace opens on it, not on whatever happens to sort first.
  defaultOpen: true,
  transcript: [
    {
      id: "rev-t1",
      side: "agent",
      timeLabel: "9:58am",
      model: "code-review · deep",
      blocks: [
        {
          type: "p",
          spans: [
            "Running the reviewer fleet against the diff. bug-hunter-a has reported back; the auditor is still going.",
          ],
        },
        {
          type: "subagent",
          run: {
            id: "rev-sa1",
            name: "bug-hunter-a",
            description: "Correctness pass over the write loop",
            steps: [
              {
                label: "Read",
                detail: "packages/database/seed/synthetic-generator.ts",
              },
              { label: "Finding", detail: "BLOCKING: unbounded org loop" },
            ],
          },
        },
        {
          type: "subagent",
          run: {
            id: "rev-sa2",
            name: "unified-auditor",
            description: "Convention + type-safety audit (in progress)",
            steps: [
              { label: "Read", detail: "apps/api/lib/fixtures/seed-config.ts" },
              { label: "Grep", detail: "mode literal usages across fixtures" },
            ],
          },
        },
        {
          type: "ul",
          items: [
            [
              "BLOCKING: the loop in ",
              { code: "synthetic-generator.ts" },
              " has no batch ceiling; a large org set can exhaust the worker heap.",
            ],
          ],
        },
      ],
    },
  ],
};

// Queued: the follow-up hasn't started — it's waiting on the review to land its
// findings, so there is no transcript yet. The collapsed box is the whole story.
const FOLLOW_UP_SESSION: AssociatedSession = {
  id: "sess-followup",
  kind: SessionKind.FollowUp,
  title: "Address review findings",
  actor: "claude-opus (Alex Rivera)",
  durationLabel: "not started",
  tokensLabel: "not run",
  costLabel: "not run",
  outcome: "Queued: starts once the review posts its findings.",
  turnCount: 0,
  toolCount: 0,
  status: SessionStatus.Queued,
  transcript: [],
};

// CI runs on the fix commit, which doesn't exist yet, so every check sits
// queued. Rendered as a compact header strip, not a session in the trace.
const CI_CHECKS: CiCheck[] = [
  { id: "check-lint", name: "lint", status: CiCheckStatus.Queued },
  { id: "check-typecheck", name: "typecheck", status: CiCheckStatus.Queued },
  { id: "check-test", name: "test", status: CiCheckStatus.Queued },
];

export const REFERENCE_DETAIL: MultiSessionDetail = {
  id: "br_1284",
  entityLabel: "Branch",
  branchName: "agent/synthetic-seed-generator",
  repoFullName: "closedloop-ai/symphony-alpha",
  prNumber: 1284,
  prTitle: "Synthetic seed generator for fixtures",
  prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/1284",
  statusLabel: "In review",
  // Rolled up across the sessions that have actually run so far (implementation
  // complete + code review in flight); the queued follow-up contributes nothing
  // yet, so the aggregate reflects a live mid-run branch.
  totalDurationLabel: "45m 24s",
  totalTokensLabel: "376K tokens",
  totalCostLabel: "$4.71",
  sessions: [IMPLEMENTATION_SESSION, CODE_REVIEW_SESSION, FOLLOW_UP_SESSION],
  checks: CI_CHECKS,
};
