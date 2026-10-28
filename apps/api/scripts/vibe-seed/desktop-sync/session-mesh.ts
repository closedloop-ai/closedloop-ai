import { createHash } from "node:crypto";
import { Harness } from "@repo/api/src/types/agent-component";
import {
  type SessionMeshFeedbackKind,
  sessionMeshDeliveryDispositionValidator,
  sessionMeshFeedbackValidator,
  sessionMeshPresenceValidator,
  sessionMeshPublishValidator,
} from "@repo/api/src/types/session-mesh";
import { withDb } from "@repo/database";
import { deterministicUuid } from "@repo/database/scripts/seed/helpers";
import type { z } from "zod";
import { sessionMeshService } from "@/app/session-mesh/service";
import type { VibeSeedContext } from "../stage";
import {
  type DesktopSyncTarget,
  resolveDesktopSyncTarget,
} from "./sync-target";

/**
 * ISS-12017: Session Mesh traffic between the org's most recent Claude and
 * Codex sessions, written through `sessionMeshService` exactly as the
 * `/session-mesh/*` routes call it: presence heartbeats, published messages
 * (whose deliveries the service routes by explicit target and path overlap),
 * recipient dispositions, and feedback verdicts.
 *
 * The golden store records no mesh traffic, so the conversation is built: each
 * agent is a real ingested session (`<harness>:<sessionId>`, the identity
 * Desktop's `nativeAgentId` registers) working on a real branch of the org's
 * repository. The mesh service stamps its own clock, so these rows are dated
 * at the moment the stage runs.
 */

export const SESSION_MESH_STAGE = "session-mesh";

const MESH_AGENT_COUNT = 4;
const PRESENCE_TTL_SECONDS = 300;
const MESSAGE_TTL_SECONDS = 86_400;
const MESH_HARNESSES: ReadonlySet<string> = new Set([
  Harness.Claude,
  Harness.Codex,
]);

type PresenceInput = z.input<typeof sessionMeshPresenceValidator>;
type PublishInput = z.input<typeof sessionMeshPublishValidator>;
type MessageKind = PublishInput["kind"];
type DispositionStatus = z.input<
  typeof sessionMeshDeliveryDispositionValidator
>["status"];

const AGENT_PATHS: readonly (readonly string[])[] = [
  [
    "apps/api/app/desktop/transcripts/service.ts",
    "apps/api/app/desktop/transcripts/transcript-plan.ts",
  ],
  [
    "apps/api/app/desktop/transcripts/service.ts",
    "apps/desktop/src/main/transcript-sync/transcript-lane-give-up.ts",
  ],
  [
    "apps/api/app/agent-sessions/service/component-invocations.ts",
    "packages/api/src/types/agent-component-invocation.ts",
  ],
  [
    "packages/api/src/types/session-mesh.ts",
    "apps/api/app/session-mesh/service.ts",
  ],
];

type MessageSpec = {
  readonly key: string;
  readonly author: number;
  readonly recipients: readonly number[];
  readonly kind: MessageKind;
  readonly summary: string;
  readonly replyTo?: string;
  /** What each recipient does with its delivery. */
  readonly outcome: DispositionStatus;
  readonly feedback?: {
    readonly kind: SessionMeshFeedbackKind;
    readonly rationale: string;
    readonly minutes?: number;
    readonly costUsd?: number;
    readonly overheadMs?: number;
  };
};

const MESSAGE_SPECS: readonly MessageSpec[] = [
  {
    key: "transcript-retry-start",
    author: 0,
    recipients: [],
    kind: "work_started",
    summary:
      "Starting on the transcript sync retry path; touching the plan and complete handlers.",
    outcome: "acknowledged",
  },
  {
    key: "transcript-service-claim",
    author: 1,
    recipients: [0],
    kind: "claim",
    summary:
      "Claiming apps/api/app/desktop/transcripts/service.ts for the lane give-up change; please hold edits there for the next hour.",
    outcome: "acknowledged",
    feedback: {
      kind: "coordination_overhead",
      rationale: "Had to pause and rebase onto the claimed file.",
      overheadMs: 240_000,
    },
  },
  {
    key: "invocation-part-order",
    author: 2,
    recipients: [0, 3],
    kind: "discovery",
    summary:
      "Invocation parts can arrive out of order; the ingest stages them and activates the generation once every part is in.",
    outcome: "acknowledged",
    feedback: {
      kind: "useful",
      rationale: "Saved re-deriving the staging rules from the service.",
      minutes: 25,
      costUsd: 1.8,
    },
  },
  {
    key: "generation-hash-question",
    author: 0,
    recipients: [2],
    kind: "request",
    summary:
      "Does the generation id still hash the items in canonical order, or per part?",
    outcome: "acknowledged",
  },
  {
    key: "generation-hash-answer",
    author: 2,
    recipients: [0],
    kind: "reply",
    replyTo: "generation-hash-question",
    summary:
      "Canonical order across the whole generation; each part hash only covers its own items.",
    outcome: "acknowledged",
    feedback: {
      kind: "useful",
      rationale: "Answered before I started reading the hash helpers.",
      minutes: 15,
    },
  },
  {
    key: "mesh-types-conflict",
    author: 3,
    recipients: [1],
    kind: "conflict",
    summary:
      "We are both editing packages/api/src/types/session-mesh.ts; I am adding a feedback kind there.",
    outcome: "acknowledged",
    feedback: {
      kind: "conflict_resolved",
      rationale: "Split the change so the feedback kind lands first.",
      minutes: 40,
    },
  },
  {
    key: "lane-give-up-handoff",
    author: 1,
    recipients: [3],
    kind: "handoff",
    summary:
      "Handing off the lane give-up follow-up: the revive-on-rearm test still needs a past-ceiling case.",
    outcome: "dismissed",
    feedback: {
      kind: "not_useful",
      rationale: "That case already exists in the stall backoff suite.",
    },
  },
];

type MeshAgent = {
  readonly agentId: string;
  readonly harness: PresenceInput["harness"];
  readonly sessionId: string;
  readonly artifactId: string;
  readonly repository: string;
  readonly revision: string;
  readonly branch: string;
  readonly paths: readonly string[];
};

export async function seedSessionMesh(context: VibeSeedContext): Promise<void> {
  const target = await resolveDesktopSyncTarget(context, SESSION_MESH_STAGE);
  const agents = await readMeshAgents(target);
  for (const agent of agents) {
    await registerPresence(target, agent);
  }
  const messageIds = new Map<string, string>();
  let deliveries = 0;
  for (const spec of MESSAGE_SPECS) {
    const messageId = await publish(target, agents, spec, messageIds);
    messageIds.set(spec.key, messageId);
    deliveries += await settleDeliveries(target, agents, spec, messageId);
  }
  target.log(
    `mesh: ${agents.length} presence(s), ${MESSAGE_SPECS.length} message(s), ${deliveries} delivery outcome(s)`
  );
}

async function registerPresence(
  target: DesktopSyncTarget,
  agent: MeshAgent
): Promise<void> {
  const presence = sessionMeshPresenceValidator.parse({
    agentId: agent.agentId,
    workspace: {
      repository: agent.repository,
      revision: agent.revision,
      paths: [...agent.paths],
    },
    harness: agent.harness,
    capabilities: ["poll_inbox", "native_delivery"],
    lineage: {
      sessionId: agent.sessionId,
      branch: agent.branch,
      artifactIds: [agent.artifactId],
    },
    context: { revision: agent.revision },
    expiresInSeconds: PRESENCE_TTL_SECONDS,
  } satisfies PresenceInput);
  const result = await sessionMeshService.upsertPresence({
    organizationId: target.organizationId,
    userId: target.userId,
    presence,
  });
  if (!result.ok) {
    throw new Error(`mesh presence refused for ${agent.agentId}`);
  }
}

async function publish(
  target: DesktopSyncTarget,
  agents: readonly MeshAgent[],
  spec: MessageSpec,
  messageIds: ReadonlyMap<string, string>
): Promise<string> {
  const author = meshAgent(agents, spec.author);
  const replyToMessageId =
    spec.replyTo === undefined ? undefined : messageIds.get(spec.replyTo);
  const message = sessionMeshPublishValidator.parse({
    messageId: deterministicUuid(
      `vibe-seed:${SESSION_MESH_STAGE}:${target.organizationId}:${spec.key}`
    ),
    idempotencyKey: `vibe-seed:${spec.key}`,
    authorAgentId: author.agentId,
    recipientAgentIds: spec.recipients.map(
      (index) => meshAgent(agents, index).agentId
    ),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    kind: spec.kind,
    workspace: {
      repository: author.repository,
      revision: author.revision,
      paths: [...author.paths],
    },
    lineage: {
      sessionId: author.sessionId,
      branch: author.branch,
      artifactIds: [author.artifactId],
    },
    summary: spec.summary,
    expiresInSeconds: MESSAGE_TTL_SECONDS,
  } satisfies PublishInput);
  const result = await sessionMeshService.publish({
    organizationId: target.organizationId,
    userId: target.userId,
    message,
  });
  if (!result.ok) {
    throw new Error(`mesh publish refused for ${spec.key}`);
  }
  return result.value.message.id;
}

/** Each recipient takes the delivery, settles it, and leaves its verdict. */
async function settleDeliveries(
  target: DesktopSyncTarget,
  agents: readonly MeshAgent[],
  spec: MessageSpec,
  messageId: string
): Promise<number> {
  const recipients = await withDb((db) =>
    db.sessionMeshDelivery.findMany({
      where: { organizationId: target.organizationId, messageId },
      orderBy: { recipientAgentId: "asc" },
      select: { recipientAgentId: true },
    })
  );
  for (const { recipientAgentId } of recipients) {
    for (const status of ["delivered", spec.outcome] as const) {
      const disposition = sessionMeshDeliveryDispositionValidator.parse({
        agentId: recipientAgentId,
        messageId,
        status,
      });
      await sessionMeshService.disposition({
        organizationId: target.organizationId,
        userId: target.userId,
        ...disposition,
      });
    }
    if (spec.feedback !== undefined) {
      await recordFeedback(target, spec, messageId, recipientAgentId);
    }
  }
  if (recipients.length === 0) {
    throw new Error(
      `mesh message ${spec.key} reached no recipient among ${agents.length} agent(s)`
    );
  }
  return recipients.length;
}

async function recordFeedback(
  target: DesktopSyncTarget,
  spec: MessageSpec,
  messageId: string,
  agentId: string
): Promise<void> {
  const feedback = spec.feedback;
  if (feedback === undefined) {
    return;
  }
  const parsed = sessionMeshFeedbackValidator.parse({
    idempotencyKey: `vibe-seed:${spec.key}:${agentId}`,
    messageId,
    agentId,
    kind: feedback.kind,
    rationale: feedback.rationale,
    ...(feedback.minutes === undefined
      ? {}
      : { estimatedTimeSavedMinutes: feedback.minutes }),
    ...(feedback.costUsd === undefined
      ? {}
      : { estimatedCostSavedUsd: feedback.costUsd }),
    ...(feedback.overheadMs === undefined
      ? {}
      : { coordinationOverheadMs: feedback.overheadMs }),
  });
  const result = await sessionMeshService.recordFeedback({
    organizationId: target.organizationId,
    userId: target.userId,
    ...parsed,
  });
  if (!result.ok) {
    throw new Error(`mesh feedback refused for ${spec.key} by ${agentId}`);
  }
}

function meshAgent(agents: readonly MeshAgent[], index: number): MeshAgent {
  const agent = agents[index];
  if (agent === undefined) {
    throw new Error(`mesh script names agent ${index}; only ${agents.length}`);
  }
  return agent;
}

async function readMeshAgents(target: DesktopSyncTarget): Promise<MeshAgent[]> {
  const [sessions, branches] = await withDb((db) =>
    Promise.all([
      db.sessionDetail.findMany({
        where: {
          computeTargetId: target.computeTargetId,
          artifact: { organizationId: target.organizationId },
          harness: { in: [...MESH_HARNESSES] },
        },
        orderBy: [{ lastActivityAt: "desc" }, { externalSessionId: "asc" }],
        take: MESH_AGENT_COUNT,
        select: { artifactId: true, externalSessionId: true, harness: true },
      }),
      db.branchDetail.findMany({
        where: { artifact: { organizationId: target.organizationId } },
        orderBy: { branchName: "asc" },
        select: { repositoryFullName: true, branchName: true, headSha: true },
      }),
    ])
  );
  if (sessions.length < MESH_AGENT_COUNT || branches.length === 0) {
    throw new Error(
      `session mesh needs ${MESH_AGENT_COUNT} Claude or Codex sessions and a branch; found ${sessions.length} and ${branches.length}`
    );
  }
  return sessions.map((session, index) => {
    const branch = branches[index % branches.length];
    const paths = AGENT_PATHS[index % AGENT_PATHS.length];
    if (branch === undefined || paths === undefined) {
      throw new Error("mesh agent index out of range");
    }
    return {
      agentId: `${session.harness}:${session.externalSessionId}`,
      harness:
        session.harness === Harness.Codex ? Harness.Codex : Harness.Claude,
      sessionId: session.externalSessionId,
      artifactId: session.artifactId,
      repository: branch.repositoryFullName,
      revision:
        branch.headSha ??
        createHash("sha1")
          .update(`${branch.repositoryFullName}:${branch.branchName}`)
          .digest("hex"),
      branch: branch.branchName,
      paths,
    };
  });
}
