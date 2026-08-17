import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import {
  MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS,
  MonitoredSessionActivityEventKind,
} from "@repo/api/src/types/session-monitored-activity";
import { extractArtifactRefs } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import {
  MONITORED_ACTIVITY_TEST_ACTION_AT as ACTION_AT,
  MONITORED_ACTIVITY_TEST_BRANCH as BRANCH,
  monitoredActivityCarrierFor as carrierFor,
  makeMonitoredActivityTestSession as makeSession,
  MONITORED_ACTIVITY_TEST_READ_AT as READ_AT,
  MONITORED_ACTIVITY_TEST_REPOSITORY as REPOSITORY,
  monitoredActivityRefFor as refFor,
} from "./support/monitored-session-activity-fixtures.js";

describe("ISS-6060 monitored Session activity extraction", () => {
  test("retains exact user PR references with their own source timestamp", () => {
    const refs = extractArtifactRefs(
      makeSession({
        messages: [
          {
            role: "human",
            timestamp: READ_AT,
            text: `Please review https://github.com/${REPOSITORY}/pull/6060`,
          },
        ],
      })
    );
    const carrier = carrierFor(
      refFor(refs, ArtifactRefTargetKind.PullRequest, `${REPOSITORY}#6060`)
    );

    assert.equal(
      carrier.completeness,
      BranchActivityEvidenceCompleteness.Complete
    );
    assert.deepEqual(
      carrier.events.map(({ kind, occurredAt }) => ({ kind, occurredAt })),
      [
        {
          kind: MonitoredSessionActivityEventKind.UserReference,
          occurredAt: READ_AT,
        },
      ]
    );
  });

  test("merges exact git read and action events without changing ref dedupe", () => {
    const session = makeSession({
      toolUses: [
        {
          id: "tool-read",
          name: "Bash",
          timestamp: READ_AT,
          input: { command: `git checkout ${BRANCH}` },
          output: `Switched to branch '${BRANCH}'`,
        },
        {
          id: "tool-action",
          name: "Bash",
          timestamp: ACTION_AT,
          input: { command: "git commit -m 'ship activity'" },
          output: `[${BRANCH} abc1234] ship activity`,
        },
      ],
    });
    const first = extractArtifactRefs(session);
    const second = extractArtifactRefs(session);
    const branchRefs = first.filter(
      (ref) =>
        ref.targetKind === ArtifactRefTargetKind.Branch &&
        ref.targetIdentity === BRANCH
    );

    assert.deepEqual(branchRefs.map((ref) => ref.method).sort(), [
      "git_checkout",
      "git_commit",
    ]);
    const carrier = carrierFor(branchRefs[0]);
    assert.deepEqual(
      carrier.events.map(({ kind, occurredAt }) => ({ kind, occurredAt })),
      [
        {
          kind: MonitoredSessionActivityEventKind.AgentAction,
          occurredAt: ACTION_AT,
        },
        {
          kind: MonitoredSessionActivityEventKind.AgentRead,
          occurredAt: READ_AT,
        },
      ]
    );
    assert.deepEqual(
      carrier.events.map((event) => event.sourceEventId),
      carrierFor(
        second.find(
          (ref) =>
            ref.targetKind === ArtifactRefTargetKind.Branch &&
            ref.targetIdentity === BRANCH
        )!
      ).events.map((event) => event.sourceEventId),
      "reparse keeps source identities stable"
    );
  });

  test("attributes a sidecar agent's successful push to the parent Session", () => {
    const refs = extractArtifactRefs(
      makeSession({
        subagents: [
          {
            id: "agent-6060",
            name: "implementation",
            toolUses: [
              {
                id: "sidecar-push",
                subagentId: "agent-6060",
                name: "Bash",
                timestamp: ACTION_AT,
                input: { command: `git push origin ${BRANCH}` },
                output: `* [new branch] ${BRANCH} -> ${BRANCH}`,
              },
            ],
          },
        ],
      })
    );
    const ref = refFor(refs, ArtifactRefTargetKind.Branch, BRANCH);

    assert.equal(
      carrierFor(ref).events[0].kind,
      MonitoredSessionActivityEventKind.AgentAction
    );
  });

  test("classifies the frozen Git and gh CLI read/action surface", () => {
    const prCommands = [
      { command: "gh pr view 6301", kind: "read", prNumber: 6301 },
      { command: "gh pr diff 6302", kind: "read", prNumber: 6302 },
      { command: "gh pr checkout 6303", kind: "read", prNumber: 6303 },
      {
        command: "gh pr review 6304 --approve",
        kind: "action",
        prNumber: 6304,
      },
      {
        command: "gh pr comment 6305 --body 'done'",
        kind: "action",
        prNumber: 6305,
      },
    ] as const;
    const refs = extractArtifactRefs(
      makeSession({
        toolUses: [
          {
            id: "git-switch",
            name: "Bash",
            timestamp: READ_AT,
            input: { command: `git switch ${BRANCH}` },
            output: `Switched to branch '${BRANCH}'`,
          },
          {
            id: "git-worktree",
            name: "Bash",
            timestamp: READ_AT,
            input: { command: `git worktree add ../wt ${BRANCH}` },
            output: `HEAD is now at abc1234 on ${BRANCH}`,
          },
          {
            id: "git-push",
            name: "Bash",
            timestamp: ACTION_AT,
            input: { command: `git push origin ${BRANCH}` },
            output: `* [new branch] ${BRANCH} -> ${BRANCH}`,
          },
          {
            id: "gh-create",
            name: "Bash",
            timestamp: ACTION_AT,
            input: { command: `gh pr create --head ${BRANCH} --fill` },
            output: `https://github.com/${REPOSITORY}/pull/6306`,
          },
          ...prCommands.map(({ command }, index) => ({
            id: `gh-pr-${index}`,
            name: "Bash",
            timestamp: index < 3 ? READ_AT : ACTION_AT,
            input: { command },
            output: index < 3 ? `pull request ${6301 + index}` : "completed",
          })),
        ],
      })
    );
    const branchKinds = new Set(
      carrierFor(refFor(refs, ArtifactRefTargetKind.Branch, BRANCH)).events.map(
        (event) => event.kind
      )
    );

    assert.deepEqual(
      branchKinds,
      new Set(
        Object.values({
          read: MonitoredSessionActivityEventKind.AgentRead,
          action: MonitoredSessionActivityEventKind.AgentAction,
        })
      )
    );
    for (const { kind, prNumber } of prCommands) {
      const event = carrierFor(
        refFor(
          refs,
          ArtifactRefTargetKind.PullRequest,
          `${REPOSITORY}#${prNumber}`
        )
      ).events[0];
      assert.equal(
        event.kind,
        kind === "read"
          ? MonitoredSessionActivityEventKind.AgentRead
          : MonitoredSessionActivityEventKind.AgentAction
      );
    }
    assert.equal(
      carrierFor(
        refFor(refs, ArtifactRefTargetKind.PullRequest, `${REPOSITORY}#6306`)
      ).events[0].kind,
      MonitoredSessionActivityEventKind.AgentAction
    );
  });

  test("keeps proven PR feedback activity when a later suffix fails", () => {
    const refs = extractArtifactRefs(
      makeSession({
        toolUses: [
          {
            id: "review-before-failing-suffix",
            name: "Bash",
            timestamp: ACTION_AT,
            input: {
              command:
                "gh pr review 6307 --approve && some-unrelated-command --that-fails",
            },
            output: "some-unrelated-command: command not found",
            isError: true,
          },
          {
            id: "review-after-failing-prefix",
            name: "Bash",
            timestamp: ACTION_AT,
            input: {
              command:
                "some-unrelated-command --that-fails && gh pr review 6308 --approve",
            },
            output: "some-unrelated-command: command not found",
            isError: true,
          },
        ],
      })
    );
    const completed = carrierFor(
      refFor(refs, ArtifactRefTargetKind.PullRequest, `${REPOSITORY}#6307`)
    );
    const skipped = refFor(
      refs,
      ArtifactRefTargetKind.PullRequest,
      `${REPOSITORY}#6308`
    );

    assert.equal(
      completed.events[0].kind,
      MonitoredSessionActivityEventKind.AgentAction
    );
    assert.equal(
      Object.hasOwn(JSON.parse(skipped.evidence), "monitoredSessionActivity"),
      false
    );
  });

  test("keeps missing timestamps and assistant prose out of activity", () => {
    const refs = extractArtifactRefs(
      makeSession({
        messages: [
          {
            role: "human",
            timestamp: null,
            text: `https://github.com/${REPOSITORY}/pull/6401`,
          },
          {
            role: "assistant",
            timestamp: ACTION_AT,
            text: `I inspected https://github.com/${REPOSITORY}/pull/6402`,
          },
        ],
      })
    );

    for (const ref of refs.filter(
      (candidate) => candidate.targetKind === ArtifactRefTargetKind.PullRequest
    )) {
      const evidence = JSON.parse(ref.evidence) as Record<string, unknown>;
      assert.equal(Object.hasOwn(evidence, "monitoredSessionActivity"), false);
    }
  });

  test("keeps unrelated later tails from replacing source event time", () => {
    const refs = extractArtifactRefs(
      makeSession({
        messages: [
          {
            role: "human",
            timestamp: READ_AT,
            text: `Review https://github.com/${REPOSITORY}/pull/6403`,
          },
          {
            role: "assistant",
            timestamp: ACTION_AT,
            text: "Unrelated wrap-up after the target activity",
          },
        ],
      })
    );

    assert.equal(
      carrierFor(
        refFor(refs, ArtifactRefTargetKind.PullRequest, `${REPOSITORY}#6403`)
      ).events[0].occurredAt,
      READ_AT
    );
  });

  test("isolates multiple Branch targets in one Session", () => {
    const otherBranch = "feat/iss-6060-other";
    const refs = extractArtifactRefs(
      makeSession({
        messages: [
          {
            role: "human",
            timestamp: READ_AT,
            text: `https://github.com/${REPOSITORY}/tree/${BRANCH}`,
          },
          {
            role: "human",
            timestamp: ACTION_AT,
            text: `https://github.com/${REPOSITORY}/tree/${otherBranch}`,
          },
        ],
      })
    );

    assert.deepEqual(
      carrierFor(refFor(refs, ArtifactRefTargetKind.Branch, BRANCH)).events.map(
        (event) => event.occurredAt
      ),
      [READ_AT]
    );
    assert.deepEqual(
      carrierFor(
        refFor(refs, ArtifactRefTargetKind.Branch, otherBranch)
      ).events.map((event) => event.occurredAt),
      [ACTION_AT]
    );
  });

  test("caps target evidence latest-first and marks every retained event partial", () => {
    const eventCount = MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS + 1;
    const refs = extractArtifactRefs(
      makeSession({
        messages: Array.from({ length: eventCount }, (_, index) => ({
          role: "human" as const,
          timestamp: new Date(Date.parse(READ_AT) + index * 1000).toISOString(),
          text: `Reference ${index}: https://github.com/${REPOSITORY}/pull/6500`,
        })),
      })
    );
    const carrier = carrierFor(
      refFor(refs, ArtifactRefTargetKind.PullRequest, `${REPOSITORY}#6500`)
    );

    assert.equal(
      carrier.completeness,
      BranchActivityEvidenceCompleteness.Partial
    );
    assert.equal(
      carrier.events.length,
      MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS
    );
    assert.equal(
      carrier.events[0].occurredAt,
      new Date(Date.parse(READ_AT) + (eventCount - 1) * 1000).toISOString()
    );
    assert.ok(
      carrier.events.every(
        (event) =>
          event.completeness === BranchActivityEvidenceCompleteness.Partial
      )
    );
  });
});
