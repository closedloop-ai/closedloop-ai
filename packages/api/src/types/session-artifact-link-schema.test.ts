import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "./branch.js";
import { BranchActivityEvidenceCompleteness } from "./branch-activity.js";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  SessionPrRelationType,
  SYNCED_PR_URL_MAX_LENGTH,
  syncedArtifactRefSchema,
  syncedSessionPrRefSchema,
} from "./session-artifact-link.js";
import { MonitoredSessionActivityEventKind } from "./session-monitored-activity.js";
import { findIssue } from "./zod-issue.test-helpers.js";

// Postgres int4 max, spelled out rather than read back out of the schema: these
// two tests exist to hold the schema to the int4 bound their names claim, and a
// test that takes that bound from the module under test cannot see it move.
const INT4_MAX = 2_147_483_647;

/** The retired per-target cap (ISS-9860); a carrier past it used to be cut here. */
const RETIRED_MONITORED_EVENT_CAP = 50;

const MONITORED_EVENT = {
  kind: MonitoredSessionActivityEventKind.AgentRead,
  sourceEventId: "monitored_session_v1:event-1",
  occurredAt: "2026-08-12T12:00:00.000Z",
  completeness: BranchActivityEvidenceCompleteness.Complete,
};

describe("syncedArtifactRefSchema", () => {
  it.each([
    ["FEA-1", "FEA-1"],
    ["PRD-42", "PRD-42"],
    ["WRK-12", "WRK-12"],
    ["SES-999", "SES-999"],
    ["PLN-100", "PLN-100"],
    ["PRO-99999", "PRO-99999"],
    // Unbounded digit run: the contract gates the family prefix, not the width,
    // so numbering that outgrows five digits does not start failing sync.
    ["FEA-123456", "FEA-123456"],
  ])("accepts valid slug %s", (_label, slug) => {
    const result = syncedArtifactRefSchema.safeParse({
      slug,
      isPrimary: true,
      method: "mcp_tool_call",
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["unknown prefix", "TASK-10"],
    ["lowercase prefix", "fea-123"],
    ["empty string", ""],
    ["no dash", "FEA1"],
    ["no number", "FEA-"],
    ["only digits", "12345"],
  ])("rejects invalid slug: %s", (_label, slug) => {
    const result = syncedArtifactRefSchema.safeParse({
      slug,
      isPrimary: false,
      method: "slug_in_message",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // All six break the same rule, so the assertion that carries weight is
      // that the slug field is what rejected: a ref malformed enough to fall out
      // of the discriminated union entirely, or to trip a sibling field, would
      // also fail bare and prove nothing about the slug pattern.
      const issue = findIssue(result.error.issues, ["slug"]);
      expect(issue?.code).toBe("invalid_format");
    }
  });

  it("requires method to be a non-empty string", () => {
    const result = syncedArtifactRefSchema.safeParse({
      slug: "FEA-1",
      isPrimary: true,
      method: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = findIssue(result.error.issues, ["method"]);
      expect(issue?.code).toBe("too_small");
    }
  });

  it("requires isPrimary to be a boolean", () => {
    const result = syncedArtifactRefSchema.safeParse({
      slug: "FEA-1",
      isPrimary: "true",
      method: "mcp_tool_call",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = findIssue(result.error.issues, ["isPrimary"]);
      expect(issue?.code).toBe("invalid_type");
    }
  });
});

describe("syncedArtifactRefSchema — kind-discriminated union (FEA-2729)", () => {
  it("normalizes a legacy ref with no kind to closedloop_artifact", () => {
    const result = syncedArtifactRefSchema.safeParse({
      slug: "FEA-1",
      isPrimary: true,
      method: ArtifactRefMethod.McpToolCall,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe(ArtifactRefTargetKind.ClosedloopArtifact);
    }
  });

  it("carries relation and observedAt on a closedloop ref", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.ClosedloopArtifact,
      slug: "FEA-1",
      isPrimary: false,
      method: ArtifactRefMethod.SlugInBranch,
      relation: ArtifactRefRelation.Workspace,
      observedAt: "2026-07-08T12:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a branch ref with repo identity, method, and relation", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      branchName: "feat/x",
      method: "git_command",
      relation: ArtifactRefRelation.Created,
      observedAt: "2026-07-08T12:00:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe(ArtifactRefTargetKind.Branch);
    }
  });

  it("accepts optional explicit branch participation on branch refs", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      branchName: "feat/x",
      method: "git_push",
      relation: ArtifactRefRelation.Created,
      branchParticipation: BranchParticipationKind.Wrote,
      observedAt: "2026-07-08T12:00:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === ArtifactRefTargetKind.Branch) {
      expect(result.data.branchParticipation).toBe(
        BranchParticipationKind.Wrote
      );
    }
  });

  it("retains valid monitored-activity siblings and marks malformed/future/date-only siblings partial", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      branchName: "feat/iss-6060",
      method: ArtifactRefMethod.McpToolCall,
      relation: ArtifactRefRelation.Reviewed,
      monitoredSessionActivity: {
        completeness: BranchActivityEvidenceCompleteness.Complete,
        events: [
          MONITORED_EVENT,
          { ...MONITORED_EVENT, kind: "future_activity_kind" },
          {
            ...MONITORED_EVENT,
            sourceEventId: "monitored_session_v1:date-only",
            occurredAt: "2026-08-12",
          },
          { sourceEventId: "missing-kind-and-time" },
        ],
      },
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.kind === ArtifactRefTargetKind.Branch) {
      expect(result.data.monitoredSessionActivity).toEqual({
        completeness: BranchActivityEvidenceCompleteness.Partial,
        events: [
          {
            ...MONITORED_EVENT,
            completeness: BranchActivityEvidenceCompleteness.Partial,
          },
        ],
      });
    }
  });

  it("keeps a carrier past the retired 50-event cap whole, newest-first and Complete (ISS-9860)", () => {
    const eventCount = RETIRED_MONITORED_EVENT_CAP + 10;
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      branchName: "feat/iss-6060",
      method: ArtifactRefMethod.McpToolCall,
      relation: ArtifactRefRelation.Reviewed,
      monitoredSessionActivity: {
        completeness: BranchActivityEvidenceCompleteness.Complete,
        events: Array.from({ length: eventCount }, (_, index) => ({
          ...MONITORED_EVENT,
          sourceEventId: `monitored_session_v1:event-${index}`,
          occurredAt: new Date(
            Date.parse(MONITORED_EVENT.occurredAt) + index * 1000
          ).toISOString(),
        })),
      },
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.kind === ArtifactRefTargetKind.Branch) {
      expect(result.data.monitoredSessionActivity?.events).toHaveLength(
        eventCount
      );
      expect(
        result.data.monitoredSessionActivity?.events[0]?.sourceEventId
      ).toBe(`monitored_session_v1:event-${eventCount - 1}`);
      expect(
        result.data.monitoredSessionActivity?.events.at(-1)?.sourceEventId
      ).toBe("monitored_session_v1:event-0");
      expect(result.data.monitoredSessionActivity?.completeness).toBe(
        BranchActivityEvidenceCompleteness.Complete
      );
      expect(
        result.data.monitoredSessionActivity?.events.every(
          (event) =>
            event.completeness === BranchActivityEvidenceCompleteness.Complete
        )
      ).toBe(true);
    }
  });

  it("drops a conflicting source identity while preserving independent valid events", () => {
    const independent = {
      ...MONITORED_EVENT,
      sourceEventId: "monitored_session_v1:event-2",
      occurredAt: "2026-08-12T12:01:00.000Z",
    };
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      prNumber: 6060,
      method: ArtifactRefMethod.McpToolCall,
      relation: ArtifactRefRelation.Reviewed,
      monitoredSessionActivity: {
        completeness: BranchActivityEvidenceCompleteness.Complete,
        events: [
          MONITORED_EVENT,
          { ...MONITORED_EVENT, occurredAt: "2026-08-12T13:00:00.000Z" },
          independent,
        ],
      },
    });

    expect(result.success).toBe(true);
    if (
      result.success &&
      result.data.kind === ArtifactRefTargetKind.PullRequest
    ) {
      expect(result.data.monitoredSessionActivity).toEqual({
        completeness: BranchActivityEvidenceCompleteness.Partial,
        events: [
          {
            ...independent,
            completeness: BranchActivityEvidenceCompleteness.Partial,
          },
        ],
      });
    }
  });

  it("drops unknown branch participation values without rejecting the ref", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      branchName: "feat/x",
      method: "git_push",
      relation: ArtifactRefRelation.Created,
      branchParticipation: "future-participation",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === ArtifactRefTargetKind.Branch) {
      expect(result.data.branchParticipation).toBeUndefined();
    }
  });

  it("accepts optional branch lifecycle events on branch refs", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      branchName: "feat/x",
      method: "git_push",
      relation: ArtifactRefRelation.Created,
      branchLifecycleEvents: [
        {
          kind: BranchLifecycleBoundaryKind.BranchWrite,
          observedAt: "2026-07-08T12:00:00.000Z",
          evidenceId: "desktop-artifact-link:link-1",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === ArtifactRefTargetKind.Branch) {
      expect(result.data.branchLifecycleEvents?.[0]?.kind).toBe(
        BranchLifecycleBoundaryKind.BranchWrite
      );
    }
  });

  it("accepts a branch ref without observedAt (optional)", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      branchName: "main",
      method: "git_command",
      relation: ArtifactRefRelation.Workspace,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a branch ref missing relation (relation is required)", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      branchName: "feat/x",
      method: "git_command",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // An absent enum reads as an invalid OPTION, not an invalid type — the
      // same code an unknown relation string raises below, and the reason this
      // asserts the path rather than treating the code as the distinguishing
      // fact.
      const issue = findIssue(result.error.issues, ["relation"]);
      expect(issue?.code).toBe("invalid_value");
    }
  });

  it("rejects a branch ref missing branchName", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      method: "git_command",
      relation: ArtifactRefRelation.Created,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = findIssue(result.error.issues, ["branchName"]);
      expect(issue?.code).toBe("invalid_type");
    }
  });

  it("rejects a branch ref with an unknown relation value", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      branchName: "feat/x",
      method: "git_command",
      relation: "merged",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // "merged" must be turned away by the relation enum, NOT by falling out of
      // the discriminated union — a union-level rejection would mean the branch
      // arm was never reached and this case proved nothing about relation.
      const issue = findIssue(result.error.issues, ["relation"]);
      expect(issue?.code).toBe("invalid_value");
    }
  });

  it("accepts a pull_request ref carried for FEA-2732", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      prNumber: 42,
      method: "pr_create_output",
      relation: ArtifactRefRelation.Created,
    });
    expect(result.success).toBe(true);
  });

  // ISS-8175 review: `baseRef` outranks McpInput on the branch's own base, so a
  // whitespace-only value would pin the branch to a ref no git command can
  // resolve until a stronger source arrived. `.trim()` ahead of `.min(1)` routes
  // it into the same absent path every other invalid optional value takes —
  // absent, never `null`, and never a rejected batch.
  it.each([
    ["   ", undefined],
    ["\t\n ", undefined],
    ["  release/2026-08  ", "release/2026-08"],
  ])("normalizes baseRef %j to %j", (baseRef, expected) => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      prNumber: 42,
      method: ArtifactRefMethod.PrCreateOutput,
      relation: ArtifactRefRelation.Created,
      baseRef,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // `undefined`, never `null` and never the blank string: the cloud's write
      // maps `!== undefined` onto the column, so this is the absent path.
      expect((result.data as { baseRef?: string }).baseRef).toStrictEqual(
        expected
      );
    }
  });

  it("accepts optional branch lifecycle events on pull_request refs", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      prNumber: 42,
      method: ArtifactRefMethod.PrReviewFeedbackCommand,
      relation: ArtifactRefRelation.Reviewed,
      branchLifecycleEvents: [
        {
          kind: BranchLifecycleBoundaryKind.ReviewFeedback,
          observedAt: "2026-07-08T12:30:00.000Z",
          evidenceId: "desktop-artifact-link:link-2",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a commit ref carried for FEA-2731 (abbreviated sha + branch)", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Commit,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      branchName: "feat/x",
      sha: "1a2b3c4",
      method: "git_command",
      relation: ArtifactRefRelation.Created,
      message: "feat: add thing",
      committedAt: "2026-07-08T12:00:00.000Z",
      linesAdded: 10,
      linesRemoved: 2,
      filesChanged: 3,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe(ArtifactRefTargetKind.Commit);
    }
  });

  it("rejects a commit ref whose LOC count exceeds int4 (FEA-3206 — mirrors the PR schema's PR_INT_MAX bound, prevents commit_detail overflow aborting the batch)", () => {
    for (const field of [
      "linesAdded",
      "linesRemoved",
      "filesChanged",
    ] as const) {
      const result = syncedArtifactRefSchema.safeParse({
        kind: ArtifactRefTargetKind.Commit,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        branchName: "feat/x",
        sha: "1a2b3c4",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
        [field]: INT4_MAX + 1,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        // Each field must reject for exceeding the int4 bound, on its OWN path —
        // a bare failure would stay green if the overflow value instead tripped
        // the int/nonnegative check or knocked the ref out of the union.
        const issue = findIssue(result.error.issues, [field]);
        expect(issue?.code).toBe("too_big");
      }
    }
  });

  it("accepts a commit ref whose LOC count is exactly int4 max (FEA-3206 boundary)", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: ArtifactRefTargetKind.Commit,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      branchName: "feat/x",
      sha: "1a2b3c4",
      method: "git_command",
      relation: ArtifactRefRelation.Created,
      linesAdded: INT4_MAX,
      linesRemoved: INT4_MAX,
      filesChanged: INT4_MAX,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a ref whose explicit kind is unknown to this contract version", () => {
    const result = syncedArtifactRefSchema.safeParse({
      kind: "deployment_ref_from_the_future",
      repositoryFullName: "closedloop-ai/closedloop-ai",
      method: "git_command",
      relation: ArtifactRefRelation.Created,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The forward-compat contract is that an unknown kind is turned away by
      // the DISCRIMINATOR, so ingest can drop the one ref. This payload also
      // omits fields the known arms require, so a bare failure would read as
      // proven even if the discriminator had silently matched an arm and the
      // rejection had come from a missing field instead.
      const issue = findIssue(result.error.issues, ["kind"]);
      expect(issue?.code).toBe("invalid_union");
    }
  });
});

describe("pull_request ref mergedAt/closedAt range bound (ISS-8547)", () => {
  function pullRequestRef(overrides: Record<string, unknown> = {}) {
    return {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      prNumber: 6060,
      method: ArtifactRefMethod.PrCreateOutput,
      relation: ArtifactRefRelation.Created,
      ...overrides,
    };
  }

  it("degrades an out-of-range mergedAt to absent instead of rejecting the ref, and keeps valid siblings intact", () => {
    const result = syncedArtifactRefSchema.safeParse(
      pullRequestRef({ mergedAt: "-271821-04-20T00:00:00.000Z" })
    );

    expect(result.success).toBe(true);
    if (
      result.success &&
      result.data.kind === ArtifactRefTargetKind.PullRequest
    ) {
      // Zod's `.catch()` fires because the field was PRESENT with an invalid
      // value, so the key still exists on the parsed object — just holding
      // `undefined` — rather than being absent the way an omitted field would
      // be. Asserting `"mergedAt" in result.data` would therefore be `true` and
      // prove nothing; the value itself is the only honest check that the bad
      // timestamp was dropped rather than kept or rejected.
      expect(result.data.mergedAt).toBeUndefined();
      expect(result.data.repositoryFullName).toBe(
        "closedloop-ai/closedloop-ai"
      );
      expect(result.data.prNumber).toBe(6060);
    }
  });

  it("preserves a valid mergedAt unchanged", () => {
    const result = syncedArtifactRefSchema.safeParse(
      pullRequestRef({ mergedAt: "2026-08-01T00:00:00.000Z" })
    );

    expect(result.success).toBe(true);
    if (
      result.success &&
      result.data.kind === ArtifactRefTargetKind.PullRequest
    ) {
      // Catches a `.catch(undefined)` broad enough to also swallow good values.
      expect(result.data.mergedAt).toBe("2026-08-01T00:00:00.000Z");
    }
  });

  it("does not let one ref's out-of-range mergedAt sink the rest of an artifactRefs batch", () => {
    // Mirrors the production shape: `desktop-agent-sessions-schema.ts` parses
    // `artifactRefs` as `z.array(syncedArtifactRefSchema)`, one `safeParse` over
    // the whole array. A REJECTING bound here would 400 the entire batch on one
    // bad ref; `.catch(undefined)` on the field is what keeps the other two refs
    // — and this ref's own valid fields — landing.
    const result = z.array(syncedArtifactRefSchema).safeParse([
      pullRequestRef({ prNumber: 1, mergedAt: "2026-08-01T00:00:00.000Z" }),
      pullRequestRef({
        prNumber: 2,
        mergedAt: "-271821-04-20T00:00:00.000Z",
      }),
      pullRequestRef({ prNumber: 3, mergedAt: "2026-08-02T00:00:00.000Z" }),
    ]);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(3);
      const [first, second, third] = result.data;
      expect(first?.kind).toBe(ArtifactRefTargetKind.PullRequest);
      expect(second?.kind).toBe(ArtifactRefTargetKind.PullRequest);
      expect(third?.kind).toBe(ArtifactRefTargetKind.PullRequest);
      if (
        first?.kind === ArtifactRefTargetKind.PullRequest &&
        second?.kind === ArtifactRefTargetKind.PullRequest &&
        third?.kind === ArtifactRefTargetKind.PullRequest
      ) {
        expect(first.mergedAt).toBe("2026-08-01T00:00:00.000Z");
        expect(second.mergedAt).toBeUndefined();
        expect(second.prNumber).toBe(2);
        expect(third.mergedAt).toBe("2026-08-02T00:00:00.000Z");
      }
    }
  });
});

describe("syncedSessionPrRefSchema", () => {
  const validPrRef = {
    repositoryFullName: "closedloop-ai/closedloop-ai",
    prNumber: 42,
    prUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
    relationType: SessionPrRelationType.Created,
  };

  it("accepts a valid PR ref", () => {
    expect(syncedSessionPrRefSchema.safeParse(validPrRef).success).toBe(true);
  });

  it("accepts relationType Referenced", () => {
    const result = syncedSessionPrRefSchema.safeParse({
      ...validPrRef,
      relationType: SessionPrRelationType.Referenced,
    });
    expect(result.success).toBe(true);
  });

  it("accepts relationType Reviewed (FEA-3585)", () => {
    const result = syncedSessionPrRefSchema.safeParse({
      ...validPrRef,
      relationType: SessionPrRelationType.Reviewed,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a reviewed PR ref with no prUrl (bare-number review)", () => {
    const { prUrl: _prUrl, ...noUrl } = validPrRef;
    const result = syncedSessionPrRefSchema.safeParse({
      ...noUrl,
      relationType: SessionPrRelationType.Reviewed,
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional branch lifecycle events on prRefs", () => {
    const result = syncedSessionPrRefSchema.safeParse({
      ...validPrRef,
      relationType: SessionPrRelationType.Reviewed,
      branchLifecycleEvents: [
        {
          kind: BranchLifecycleBoundaryKind.ReviewFeedback,
          evidenceId: "desktop-artifact-link:link-2",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["negative", -1],
    ["zero", 0],
  ])("rejects %s prNumber for the positivity bound", (_label, prNumber) => {
    const result = syncedSessionPrRefSchema.safeParse({
      ...validPrRef,
      prNumber,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Distinct from the fractional case below: a non-positive integer breaks
      // the lower bound, whereas 1.5 is turned away as a non-integer. Bare
      // failures made the two indistinguishable.
      const issue = findIssue(result.error.issues, ["prNumber"]);
      expect(issue?.code).toBe("too_small");
    }
  });

  it("rejects fractional prNumber as a non-integer, not as an out-of-range one", () => {
    const result = syncedSessionPrRefSchema.safeParse({
      ...validPrRef,
      prNumber: 1.5,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = findIssue(result.error.issues, ["prNumber"]);
      expect(issue?.code).toBe("invalid_type");
    }
  });

  it("rejects empty repositoryFullName", () => {
    const result = syncedSessionPrRefSchema.safeParse({
      ...validPrRef,
      repositoryFullName: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = findIssue(result.error.issues, ["repositoryFullName"]);
      expect(issue?.code).toBe("too_small");
    }
  });

  it("degrades a malformed prUrl to absent instead of rejecting the ref (ISS-8882)", () => {
    // Before ISS-8882 this REJECTED with `invalid_format`. The server ignores
    // `prUrl` and derives its own, so a rejecting validator on a discarded field
    // could only ever cost a batch; the ref itself must survive.
    const result = syncedSessionPrRefSchema.safeParse({
      ...validPrRef,
      prUrl: "not-a-url",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prUrl).toBeUndefined();
      expect(result.data.prNumber).toBe(validPrRef.prNumber);
    }
  });

  it("accepts a PR ref without prUrl (derived server-side)", () => {
    const { prUrl: _omit, ...withoutUrl } = validPrRef;
    expect(syncedSessionPrRefSchema.safeParse(withoutUrl).success).toBe(true);
  });

  // ISS-8882: `prUrl` is accepted-and-ignored, so a bound on it must DEGRADE
  // to absent rather than reject — the batch is one parse, and a rejecting
  // bound on a discarded field would 400 up to 200 sessions on every retry.
  describe("prUrl length bound degrades to absent (ISS-8882)", () => {
    const REPO_184 = `org/${"r".repeat(180)}`;
    const OVER_LONG_URL = `https://github.com/${REPO_184}/pull/12`;
    const AT_BOUND_URL = `https://github.com/o/r/pull/${"1".repeat(
      SYNCED_PR_URL_MAX_LENGTH - "https://github.com/o/r/pull/".length
    )}`;

    it("parses a 211-char prUrl with prUrl absent and the ref intact", () => {
      expect(OVER_LONG_URL).toHaveLength(211);
      const result = syncedSessionPrRefSchema.safeParse({
        ...validPrRef,
        repositoryFullName: REPO_184,
        prNumber: 12,
        prUrl: OVER_LONG_URL,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.prUrl).toBeUndefined();
        expect(result.data.repositoryFullName).toBe(REPO_184);
        expect(result.data.prNumber).toBe(12);
      }
    });

    it("preserves a prUrl exactly at the bound verbatim", () => {
      expect(AT_BOUND_URL).toHaveLength(SYNCED_PR_URL_MAX_LENGTH);
      const result = syncedSessionPrRefSchema.safeParse({
        ...validPrRef,
        prUrl: AT_BOUND_URL,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.prUrl).toBe(AT_BOUND_URL);
      }
    });

    it("parses a 200-ref batch in which one ref carries the over-long prUrl", () => {
      const batch = Array.from({ length: 200 }, (_, i) =>
        i === 137
          ? {
              ...validPrRef,
              repositoryFullName: REPO_184,
              prUrl: OVER_LONG_URL,
            }
          : { ...validPrRef, prNumber: i + 1 }
      );
      const result = z.array(syncedSessionPrRefSchema).safeParse(batch);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(200);
        expect(result.data[137]?.prUrl).toBeUndefined();
        expect(result.data[136]?.prUrl).toBe(validPrRef.prUrl);
      }
    });
  });

  it("rejects unknown relationType", () => {
    const result = syncedSessionPrRefSchema.safeParse({
      ...validPrRef,
      relationType: "MERGED",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = findIssue(result.error.issues, ["relationType"]);
      expect(issue?.code).toBe("invalid_value");
    }
  });
});
