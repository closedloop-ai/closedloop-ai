/**
 * extended.ts — seeds additional in-scope Prisma models that aren't a natural
 * fit for the existing per-domain modules (core, execution, integrations,
 * evaluation, customization).
 *
 * Models seeded here:
 *   - ArtifactRating  : user rating + comment on a document artifact
 *   - FileAttachment  : binary file attached to a document artifact
 *   - LoopEvent       : audit events emitted during loop execution
 *   - Prompt          : prompt registry (AGENT and JUDGE types)
 *
 * Note: `DocumentVersion` is seeded inline in core.ts (next to each document
 * artifact) because the version row is functionally part of the artifact's
 * own create payload — separating it would break the "loadable document"
 * invariant the production code relies on.
 */

import { PromptType } from "../../generated/client";
import type { TransactionClient } from "../../generated/internal/prismaNamespace";
import type { CoreSeedResult } from "./core";
import {
  createUpsertCounts,
  deterministicUuid,
  logUpsertSummary,
  seedLog,
  upsertRow,
} from "./helpers";
import type { SeedContext } from "./index";
import { resolveSeedRunPlan, type SeedRunPlan } from "./profiles";

export async function seedExtendedEntities(
  prisma: TransactionClient,
  context: SeedContext,
  coreResult: CoreSeedResult,
  _plan: SeedRunPlan = resolveSeedRunPlan()
): Promise<void> {
  const { organizationId, userId } = context;
  const { artifactIds } = coreResult;
  const counts = createUpsertCounts();

  seedLog("Seeding extended entities (ratings, attachments, prompts)…");

  // ---------------------------------------------------------------------------
  // ArtifactRating — a couple of ratings on the first few seeded artifacts,
  // exercising the 1-5 score range and the optional comment column.
  // ---------------------------------------------------------------------------

  const ratingDefinitions = [
    { score: 5, comment: "Clear and complete." as string | null },
    { score: 4, comment: null },
    { score: 3, comment: "Could use more detail in the API section." },
  ];

  for (let i = 0; i < ratingDefinitions.length && i < artifactIds.length; i++) {
    const artifactId = artifactIds[i];
    const def = ratingDefinitions[i];
    const ratingId = deterministicUuid(
      `artifact-rating:${artifactId}:${userId}`
    );
    await upsertRow({
      model: "ArtifactRating",
      id: ratingId,
      upsert: () =>
        prisma.artifactRating.upsert({
          where: { id: ratingId },
          create: {
            id: ratingId,
            artifactId,
            userId,
            organizationId,
            score: def.score,
            comment: def.comment,
            artifactVersion: 1,
          },
          update: {
            score: def.score,
            comment: def.comment,
          },
        }),
      counts,
    });
  }

  // ---------------------------------------------------------------------------
  // FileAttachment — one attachment per seeded artifact for the first few.
  // bucket/key are placeholders; no real S3 object exists. Production storage
  // code expects an S3 object at the path, but UI list/render paths should
  // tolerate broken object refs.
  // ---------------------------------------------------------------------------

  for (let i = 0; i < Math.min(2, artifactIds.length); i++) {
    const artifactId = artifactIds[i];
    const attachmentId = deterministicUuid(`file-attachment:${artifactId}:1`);
    await upsertRow({
      model: "FileAttachment",
      id: attachmentId,
      upsert: () =>
        prisma.fileAttachment.upsert({
          where: { id: attachmentId },
          create: {
            id: attachmentId,
            artifactId,
            bucket: "seed-placeholder-bucket",
            key: `seed/${organizationId}/${attachmentId}.txt`,
            filename: "design-notes.txt",
            mimeType: "text/plain",
            sizeBytes: 1024,
            createdById: userId,
          },
          update: {
            filename: "design-notes.txt",
          },
        }),
      counts,
    });
  }

  // ---------------------------------------------------------------------------
  // LoopEvent — at least one event per existing loop. Production loop code
  // emits events continuously; the seeded set just needs to demonstrate the
  // row shape.
  // ---------------------------------------------------------------------------

  const seededLoops = await prisma.loop.findMany({
    where: { organizationId },
    select: { id: true },
    take: 3,
  });
  for (const loop of seededLoops) {
    const eventId = deterministicUuid(`loop-event:${loop.id}:started`);
    await upsertRow({
      model: "LoopEvent",
      id: eventId,
      upsert: () =>
        prisma.loopEvent.upsert({
          where: { id: eventId },
          create: {
            id: eventId,
            loopId: loop.id,
            type: "started",
            data: { note: "Seed event" },
            eventSource: "system",
            eventId: `seed-event-${loop.id}-1`,
          },
          update: {
            data: { note: "Seed event" },
          },
        }),
      counts,
    });
  }

  // ---------------------------------------------------------------------------
  // Prompt — one AGENT and one JUDGE prompt in the org's registry. The
  // @@unique([organizationId, name, version]) constraint means we can upsert
  // by (organizationId, name, version) composite key, but we use `id` to keep
  // the pattern uniform with the rest of the seed.
  // ---------------------------------------------------------------------------

  const promptDefinitions = [
    {
      type: PromptType.AGENT,
      name: "seed-plan-agent",
      description: "Plans implementation work for a workstream.",
      model: "claude-sonnet-4-6",
      tools: ["read_file", "write_file", "search_codebase"],
      filePath: "prompts/plan-agent.md",
      content:
        "You are the plan agent. Read the workstream context and produce a step-by-step implementation plan.",
    },
    {
      type: PromptType.JUDGE,
      name: "seed-plan-quality-judge",
      description: "Scores plans on coverage and clarity.",
      model: "claude-sonnet-4-6",
      tools: [],
      filePath: "prompts/plan-quality-judge.md",
      content:
        "You are the plan-quality judge. Score the plan 1-5 on coverage, clarity, and feasibility.",
    },
  ];

  for (const def of promptDefinitions) {
    const promptId = deterministicUuid(
      `prompt:${organizationId}:${def.name}:v1`
    );
    await upsertRow({
      model: "Prompt",
      id: promptId,
      upsert: () =>
        prisma.prompt.upsert({
          where: { id: promptId },
          create: {
            id: promptId,
            organizationId,
            promptType: def.type,
            name: def.name,
            description: def.description,
            model: def.model,
            tools: def.tools,
            filePath: def.filePath,
            content: def.content,
            version: 1,
          },
          update: {
            description: def.description,
          },
        }),
      counts,
    });
  }

  logUpsertSummary(counts);
}
