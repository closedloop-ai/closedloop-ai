import { createHash } from "node:crypto";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  BRANCH_PUSH_METHOD_VALUES,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { computeTokenCost } from "@repo/cost/genai-cost";
import type { AcmeSessionPlan } from "./acme-branches";
import type { StoreLink } from "./store-links";
import { buildGoldenSessionRefs } from "./store-refs";
import type { BranchWork } from "./store-work";

/**
 * ISS-12135: the base seed's two Acme sessions arrive as bare fixture rows: no
 * agent, events, priced tokens, activity tiling, pull request link or
 * transcript, so their branch pages had no cost, trace or comments where every
 * corpus branch has them. This builds what a Desktop would send for the work
 * the session's plan records (its prompt, its edits, the commits and pushes,
 * the pull request): the sync wire session the golden import also sends, and
 * the Claude transcript the transcript lane archives. Pure and deterministic,
 * so a rerun sends the same session.
 */

export const ACME_SESSION_MODEL = "claude-opus-4-8";
const HARNESS = "claude";
const [GIT_PUSH_METHOD] = BRANCH_PUSH_METHOD_VALUES;
const MINUTE_MS = 60 * 1000;
/** How long one turn's work runs before the session sits idle until the next. */
const TURN_WORK_MS = 5 * MINUTE_MS;
/**
 * The activity classifier version the golden store was tiled with
 * (`ACTIVITY_CLASSIFIER_VERSION`, apps/desktop
 * `collectors/parsing/activity-segment-classifier.ts`).
 */
const ACTIVITY_SEGMENT_VERSION = 16;
const CLAUDE_CODE_VERSION = "2.1.170";

export type AcmeSessionIdentity = {
  readonly externalSessionId: string;
  readonly cwd: string;
};

type ToolCall = {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly result: string;
};

/** One assistant turn: what it said, the tool it ran, and when. */
type Turn = {
  readonly at: Date;
  readonly text: string;
  readonly tool: ToolCall | null;
  readonly tokens: TokenCounts;
};

type TokenCounts = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
};

/** The assistant turns the session's plan implies, oldest first. */
export function acmeSessionTurns(
  plan: AcmeSessionPlan,
  work: BranchWork,
  startedAt: Date
): Turn[] {
  const turns: Turn[] = [
    turn(startedAt, 1, "Reading the code this touches before changing it.", {
      name: "Read",
      input: { file_path: plan.commits[0]?.edits[0]?.path ?? "README.md" },
      result: "(file contents)",
    }),
  ];
  for (const [index, commit] of plan.commits.entries()) {
    const pushedAt = work.pushes[index]?.at;
    if (pushedAt === undefined) {
      continue;
    }
    const editsStart =
      pushedAt.getTime() - (commit.edits.length + 2) * 6 * MINUTE_MS;
    for (const [editIndex, change] of commit.edits.entries()) {
      turns.push(
        turn(
          new Date(editsStart + editIndex * 6 * MINUTE_MS),
          turns.length + 1,
          `Updating ${change.path}.`,
          {
            name: "Edit",
            input: {
              file_path: change.path,
              old_string: change.removed.join("\n"),
              new_string: change.added.join("\n"),
            },
            result: `The file ${change.path} has been updated.`,
          }
        )
      );
    }
    turns.push(
      turn(
        new Date(pushedAt.getTime() - 2 * MINUTE_MS),
        turns.length + 1,
        "Committing this step.",
        {
          name: "Bash",
          input: { command: `git commit -am "${commit.message}"` },
          result: `[${plan.branchName}] ${commit.message}`,
        }
      ),
      turn(pushedAt, turns.length + 2, "Pushing the branch.", {
        name: "Bash",
        input: { command: `git push origin ${plan.branchName}` },
        result: `To github.com:${work.repositoryFullName}.git`,
      })
    );
  }
  for (const pullRequest of work.pullRequests) {
    turns.push(
      turn(
        pullRequest.openedAt,
        turns.length + 1,
        "Opening the pull request.",
        {
          name: "Bash",
          input: {
            command: `gh pr create --title "${pullRequest.facts.title}" --base ${work.baseBranch}`,
          },
          result: `https://github.com/${work.repositoryFullName}/pull/${pullRequest.number}`,
        }
      )
    );
  }
  turns.push(
    turn(
      acmeSessionEnd(plan, startedAt),
      turns.length + 1,
      plan.pullRequest === null
        ? "The first pass is pushed; the feed still needs pagination before it is ready for review."
        : `Done. Pull request #${plan.pullRequest.number} is open for review.`,
      null
    )
  );
  return turns.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function acmeSessionEnd(plan: AcmeSessionPlan, startedAt: Date): Date {
  return new Date(startedAt.getTime() + plan.durationMinutes * MINUTE_MS);
}

/** The session as the sync wire carries it (what `mapSnapshotSession` sends for a corpus session). */
export function acmeWireSession(
  plan: AcmeSessionPlan,
  work: BranchWork,
  identity: AcmeSessionIdentity,
  startedAt: Date
): Record<string, unknown> {
  const turns = acmeSessionTurns(plan, work, startedAt);
  const endedAt = acmeSessionEnd(plan, startedAt);
  const agentId = `${identity.externalSessionId}-main`;
  const tokenEvents = turns.map((entry, index) => ({
    externalEventId: `token-event-${derivedId(identity.externalSessionId, "tokens", index)}`,
    agentExternalId: null,
    model: ACME_SESSION_MODEL,
    ...entry.tokens,
    createdAt: entry.at.toISOString(),
    estimatedCostUsd: priced(entry.tokens),
  }));
  const refs = buildGoldenSessionRefs(
    sessionLinks(plan, work, identity),
    (repositoryFullName, prNumber) =>
      work.pullRequests.find(
        (pullRequest) =>
          pullRequest.number === prNumber &&
          repositoryFullName === work.repositoryFullName
      )?.facts
  ).get(identity.externalSessionId);
  return {
    externalSessionId: identity.externalSessionId,
    name: plan.sessionName,
    status: SESSION_STATUS.INACTIVE,
    harness: HARNESS,
    cwd: identity.cwd,
    model: ACME_SESSION_MODEL,
    startedAt: startedAt.toISOString(),
    updatedAt: endedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    awaitingInputSince: null,
    metadata: {
      version: CLAUDE_CODE_VERSION,
      gitBranch: plan.branchName,
      userMessages: 1,
      assistantMessages: turns.length,
      messages: [
        {
          role: "human",
          timestamp: startedAt.toISOString(),
          text: plan.prompt,
          textTruncation: "complete",
        },
      ],
    },
    attribution: { repositoryFullName: work.repositoryFullName },
    agents: [
      {
        externalAgentId: agentId,
        name: "main",
        type: "main",
        subagentType: null,
        status: "completed",
        currentTool: null,
        startedAt: startedAt.toISOString(),
        updatedAt: endedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        awaitingInputSince: null,
        parentExternalAgentId: null,
        metadata: null,
      },
    ],
    events: turns.map((entry, index) => ({
      externalEventId: derivedId(identity.externalSessionId, "event", index),
      agentExternalId: agentId,
      eventType: entry.tool === null ? "Stop" : "PostToolUse",
      toolName: entry.tool?.name ?? null,
      createdAt: entry.at.toISOString(),
    })),
    tokenUsageByModel: [
      {
        model: ACME_SESSION_MODEL,
        inputTokens: sum(turns, "inputTokens"),
        outputTokens: sum(turns, "outputTokens"),
        cacheReadTokens: sum(turns, "cacheReadTokens"),
        cacheWriteTokens: sum(turns, "cacheWriteTokens"),
        estimatedCostUsd: tokenEvents.reduce(
          (total, event) => total + event.estimatedCostUsd,
          0
        ),
      },
    ],
    tokenEvents,
    activitySegmentRows: activitySegments(turns, endedAt),
    artifactRefs: refs?.artifactRefs ?? [],
    prRefs: refs?.prRefs ?? [],
  };
}

/** The session's Claude transcript: the prompt, then each assistant turn and its tool result. */
export function acmeSessionTranscript(
  plan: AcmeSessionPlan,
  work: BranchWork,
  identity: AcmeSessionIdentity,
  startedAt: Date
): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd: identity.cwd,
    sessionId: identity.externalSessionId,
    version: CLAUDE_CODE_VERSION,
    gitBranch: plan.branchName,
  };
  const prompt = derivedUuid(identity.externalSessionId, "prompt", 0);
  const lines: Record<string, unknown>[] = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      message: { role: "user", content: plan.prompt },
      uuid: prompt,
      timestamp: startedAt.toISOString(),
    },
  ];
  let parent = prompt;
  for (const [index, entry] of acmeSessionTurns(
    plan,
    work,
    startedAt
  ).entries()) {
    const uuid = derivedUuid(identity.externalSessionId, "assistant", index);
    const toolUseId = `toolu_${derivedId(identity.externalSessionId, "tool", index).slice(0, 24)}`;
    lines.push({
      ...base,
      parentUuid: parent,
      type: "assistant",
      message: {
        id: `msg_${derivedId(identity.externalSessionId, "message", index).slice(0, 24)}`,
        type: "message",
        role: "assistant",
        model: ACME_SESSION_MODEL,
        content: [
          { type: "text", text: entry.text },
          ...(entry.tool === null
            ? []
            : [
                {
                  type: "tool_use",
                  id: toolUseId,
                  name: entry.tool.name,
                  input: entry.tool.input,
                },
              ]),
        ],
        stop_reason: entry.tool === null ? "end_turn" : "tool_use",
        usage: {
          input_tokens: entry.tokens.inputTokens,
          output_tokens: entry.tokens.outputTokens,
          cache_read_input_tokens: entry.tokens.cacheReadTokens,
          cache_creation_input_tokens: entry.tokens.cacheWriteTokens,
        },
      },
      uuid,
      timestamp: entry.at.toISOString(),
    });
    parent = uuid;
    if (entry.tool !== null) {
      const result = derivedUuid(identity.externalSessionId, "result", index);
      lines.push({
        ...base,
        parentUuid: parent,
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: entry.tool.result,
            },
          ],
        },
        uuid: result,
        timestamp: new Date(entry.at.getTime() + 1000).toISOString(),
      });
      parent = result;
    }
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function turn(
  at: Date,
  ordinal: number,
  text: string,
  tool: ToolCall | null
): Turn {
  return {
    at,
    text,
    tool,
    tokens: {
      inputTokens: 6 + (ordinal % 5),
      outputTokens: 1800 + ((ordinal * 613) % 2400),
      cacheReadTokens: 90_000 + ordinal * 14_000,
      cacheWriteTokens: 12_000 + ((ordinal * 4111) % 18_000),
    },
  };
}

/**
 * Each turn opens the segment its own tokens bill to: explore until the first
 * edit, implement after, and idle once a turn's work has run its course
 * before the next turn starts. The last segment runs past the session's end,
 * so the closing turn's tokens land in it too.
 */
function activitySegments(
  turns: readonly Turn[],
  endedAt: Date
): Record<string, unknown>[] {
  const firstEdit = turns.find((entry) => entry.tool?.name === "Edit");
  return turns.flatMap((entry, index) => {
    const startMs = entry.at.getTime();
    const nextMs =
      turns[index + 1]?.at.getTime() ?? endedAt.getTime() + TURN_WORK_MS;
    if (nextMs <= startMs) {
      return [];
    }
    const workEndMs = Math.min(nextMs, startMs + TURN_WORK_MS);
    const exploring =
      firstEdit === undefined || startMs < firstEdit.at.getTime();
    const work = segment(exploringPhase(exploring), startMs, workEndMs, 0.7, [
      "structural",
    ]);
    return workEndMs < nextMs
      ? [work, segment("idle", workEndMs, nextMs, 1, [])]
      : [work];
  });
}

function segment(
  phase: string,
  startMs: number,
  endMs: number,
  confidence: number,
  evidenceLayers: readonly string[]
): Record<string, unknown> {
  return {
    phase,
    startMs,
    endMs,
    confidence,
    evidenceLayers: [...evidenceLayers],
    version: ACTIVITY_SEGMENT_VERSION,
    workItemRef: null,
    subagentId: null,
  };
}

function exploringPhase(exploring: boolean): string {
  return exploring ? "explore" : "implement";
}

/** The store links a Desktop records for this work: each push and the pull request it opened. */
function sessionLinks(
  plan: AcmeSessionPlan,
  work: BranchWork,
  identity: AcmeSessionIdentity
): StoreLink[] {
  const link = {
    sessionId: identity.externalSessionId,
    repositoryFullName: work.repositoryFullName,
    branchName: plan.branchName,
    sha: null,
    title: null,
    committedAt: undefined,
    cwd: identity.cwd,
  };
  return [
    ...work.pushes.map(
      (push, index): StoreLink => ({
        ...link,
        linkId: derivedId(identity.externalSessionId, "push-link", index),
        kind: ArtifactRefTargetKind.Branch,
        relation: ArtifactRefRelation.Created,
        method: GIT_PUSH_METHOD,
        observedAt: push.at.toISOString(),
        prNumber: null,
      })
    ),
    ...work.pullRequests.map(
      (pullRequest, index): StoreLink => ({
        ...link,
        linkId: derivedId(identity.externalSessionId, "pr-link", index),
        kind: ArtifactRefTargetKind.PullRequest,
        relation: ArtifactRefRelation.Created,
        method: ArtifactRefMethod.PrCreateOutput,
        observedAt: pullRequest.openedAt.toISOString(),
        prNumber: pullRequest.number,
      })
    ),
  ];
}

function priced(tokens: TokenCounts): number {
  const cost = computeTokenCost({ model: ACME_SESSION_MODEL, ...tokens });
  if (cost.costUsd === null) {
    throw new Error(`${ACME_SESSION_MODEL} has no price: ${cost.reason}`);
  }
  return cost.costUsd;
}

function sum(turns: readonly Turn[], field: keyof TokenCounts): number {
  return turns.reduce((total, entry) => total + entry.tokens[field], 0);
}

function derivedId(sessionId: string, role: string, index: number): string {
  return createHash("sha256")
    .update(`${sessionId}\0${role}\0${index}`)
    .digest("hex");
}

function derivedUuid(sessionId: string, role: string, index: number): string {
  const hex = derivedId(sessionId, role, index);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
