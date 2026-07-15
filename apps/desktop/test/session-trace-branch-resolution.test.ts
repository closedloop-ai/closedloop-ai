import assert from "node:assert/strict";
import { test } from "node:test";
import type { SqliteArtifactLinkRow } from "../src/main/database/db-row-types.js";
import {
  buildSessionTraceSyncFields,
  buildTraceTimelineRows,
  resolveArtifactLinkBranch,
  type SessionTraceSyncInput,
} from "../src/main/database/session-trace.js";

// FEA-2531: the session's derived branch follows WRITE evidence only
// (git_commit/git_push/gh_pr_create). Read-only start/checkout/worktree links no
// longer resolve, and the branch key is emitted unconditionally so an explicit
// null heals stale cloud values (AC8).

function link(
  overrides: Partial<SqliteArtifactLinkRow>
): SqliteArtifactLinkRow {
  return {
    session_id: "s",
    target_kind: "branch",
    slug: null,
    is_primary: false,
    method: "git_commit",
    repo_full_name: "closedloop-ai/symphony-alpha",
    pr_number: null,
    url: null,
    relation: "created",
    sha: null,
    title: null,
    branch_name: "feat/x",
    lines_added: null,
    lines_removed: null,
    files_changed: null,
    link_observed_at: "2026-06-07T12:00:00.000Z",
    artifact_committed_at: null,
    artifact_observed_at: null,
    artifact_last_seen_at: null,
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<SessionTraceSyncInput>
): SessionTraceSyncInput {
  return {
    startedAt: "2026-06-07T12:00:00.000Z",
    updatedAt: "2026-06-07T12:05:00.000Z",
    endedAt: "2026-06-07T12:05:00.000Z",
    metadata: null,
    attribution: null,
    artifactLinkBranch: null,
    events: [],
    timelineRows: [],
    tokenEvents: [],
    localPullRequests: [],
    ...overrides,
  };
}

test("resolveArtifactLinkBranch resolves write-method links (git_commit/git_push)", () => {
  assert.equal(
    resolveArtifactLinkBranch([
      link({ method: "git_commit", branch_name: "feat/commit" }),
    ]),
    "feat/commit"
  );
  assert.equal(
    resolveArtifactLinkBranch([
      link({ method: "git_push", branch_name: "feat/push" }),
    ]),
    "feat/push"
  );
});

test("resolveArtifactLinkBranch ignores read-method links (checkout/worktree)", () => {
  assert.equal(
    resolveArtifactLinkBranch([
      link({ method: "git_checkout", branch_name: "feat/checkout" }),
      link({ method: "git_worktree_add", branch_name: "feat/worktree" }),
      link({ method: "start_branch", branch_name: "feat/start" }),
    ]),
    null
  );
});

test("resolveArtifactLinkBranch picks the latest-observed write link", () => {
  assert.equal(
    resolveArtifactLinkBranch([
      link({
        method: "git_commit",
        branch_name: "feat/early",
        link_observed_at: "2026-06-07T12:01:00.000Z",
      }),
      link({
        method: "git_push",
        branch_name: "feat/late",
        link_observed_at: "2026-06-07T12:04:00.000Z",
      }),
      // A later read link must never win over the write links.
      link({
        method: "git_checkout",
        branch_name: "feat/checkout",
        link_observed_at: "2026-06-07T12:09:00.000Z",
      }),
    ]),
    "feat/late"
  );
});

test("resolveArtifactLinkBranch returns null with no branch links", () => {
  assert.equal(resolveArtifactLinkBranch([]), null);
});

// FEA-2910: buildTraceTimelineRows now sorts via decorate-sort-undecorate
// (precomputed keys) instead of re-parsing timestamps inside the comparator.
// This locks in the resulting order — time-ascending, with the traceRowOrder
// tie-break at equal timestamps (UserMessage < AssistantMessage < tool < other).
test("buildTraceTimelineRows sorts merged messages and events by time, then row order", () => {
  const rows = buildTraceTimelineRows(
    {
      messages: [
        { role: "human", timestamp: "2026-06-07T12:03:00.000Z" },
        // Same timestamp as the tool event below; the assistant message
        // (order 1) must precede the tool event (order 2).
        {
          role: "assistant",
          timestamp: "2026-06-07T12:01:00.000Z",
          model: "opus",
        },
      ],
    },
    [
      {
        event_type: "ToolUse",
        tool_name: "bash",
        created_at: "2026-06-07T12:01:00.000Z",
        summary: null,
      },
      {
        event_type: "SessionEnd",
        tool_name: null,
        created_at: "2026-06-07T12:05:00.000Z",
        summary: "done",
      },
    ]
  );

  assert.deepEqual(
    rows.map((row) => [row.eventType, row.createdAt]),
    [
      ["AssistantMessage", "2026-06-07T12:01:00.000Z"],
      ["ToolUse", "2026-06-07T12:01:00.000Z"],
      ["UserMessage", "2026-06-07T12:03:00.000Z"],
      ["SessionEnd", "2026-06-07T12:05:00.000Z"],
    ]
  );
});

test("buildSessionTraceSyncFields emits the write-derived branch, ignoring metadata/attribution fallbacks", () => {
  const fields = buildSessionTraceSyncFields(
    baseInput({
      artifactLinkBranch: "feat/x",
      metadata: { gitBranch: "main" },
      attribution: { baseBranch: "develop" },
    })
  );
  assert.equal(fields.branch, "feat/x");
});

test("buildSessionTraceSyncFields emits an explicit null branch (key present) for a read-only session", () => {
  const fields = buildSessionTraceSyncFields(
    baseInput({
      artifactLinkBranch: null,
      // Neither the stale start branch nor the base branch may leak through.
      metadata: { gitBranch: "main" },
      attribution: { baseBranch: "develop" },
    })
  );
  assert.equal(
    Object.hasOwn(fields, "branch"),
    true,
    "branch key must be present so the cloud patcher clears a stale value"
  );
  assert.equal(fields.branch, null);
});
