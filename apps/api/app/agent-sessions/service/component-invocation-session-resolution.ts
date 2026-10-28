import {
  Prisma,
  type SessionDetail,
  type TransactionClient,
} from "@repo/database";
import { resolveByAnyIndexKey } from "@/lib/index-key-lookup";
import type { IngestAgentComponentInvocationPartInput } from "./component-invocations";

export async function resolveInvocationSession(
  tx: TransactionClient,
  input: IngestAgentComponentInvocationPartInput
) {
  // Preserve projected-first/raw-legacy resolution on the sending target.
  const local = await resolveByAnyIndexKey(
    input.part.externalSessionId,
    (candidate) =>
      tx.sessionDetail.findFirst({
        where: {
          computeTargetId: input.computeTargetId,
          externalSessionId: candidate,
          artifact: { organizationId: input.organizationId },
        },
        select: { artifactId: true, computeTargetId: true },
      })
  );
  // A parent that appears MID-REPLAY must not move this generation. Session sync
  // can create the current target's own parent after part 0 already staged on
  // the historical one; preferring the local parent from then on starts a second
  // generation, and neither ends up holding every part. Desktop drops an
  // accepted part from its retry queue even for a staged ACK, so those parts are
  // not resent and the replay is stranded. Whichever parent this generation
  // STARTED on keeps it, and that question is asked FIRST — the historical
  // probe's cardinality guard cannot answer it, because the moment the local
  // parent appears there are two sessions under this id and the guard refuses.
  const started = await resolveByAnyIndexKey(
    input.part.externalSessionId,
    (candidate) => resolveStartedGenerationSession(tx, input, candidate)
  );
  if (started) {
    return started.record;
  }
  if (local) {
    return local.record;
  }
  // A copied invocation outbox can outlive the source machine's local sessions.
  // Probed with the SAME ordered candidate walk as the local read above, not a
  // union of the candidates: a raw row and a projected row for one id are one
  // session, and `resolveByAnyIndexKey` resolves that pair to the projected row.
  // A single `IN` list counted both and failed its own cardinality guard, so a
  // session that ingests fine on its original machine could never ingest from
  // the replacement one.
  const historical = await resolveByAnyIndexKey(
    input.part.externalSessionId,
    (candidate) => resolveHistoricalInvocationSession(tx, input, candidate)
  );
  return historical?.record ?? null;
}

/**
 * The parent this part's generation is ALREADY staged on, for `candidate`, or
 * null when it has not started anywhere this sender's user owns.
 *
 * No cardinality guard, deliberately — unlike
 * {@link resolveHistoricalInvocationSession}, which is CHOOSING a parent and
 * must refuse an ambiguous one. This is FOLLOWING a generation that already
 * exists, and a generation identity is unique per session
 * (`idx_acig_session_external_generation_freshness`), so an existing row is the
 * answer rather than one candidate among several. Driven from
 * `session_detail.external_session_id` so the join reads the generation through
 * that session-leading unique rather than scanning generations.
 *
 * `ORDER BY` is a total order over a state that should hold at most one row, so
 * a store that already split a generation across two parents resolves to the
 * one it started on instead of alternating between them.
 */
async function resolveStartedGenerationSession(
  tx: TransactionClient,
  input: IngestAgentComponentInvocationPartInput,
  candidate: string
): Promise<Pick<SessionDetail, "artifactId" | "computeTargetId"> | null> {
  const { part } = input;
  const rows = await tx.$queryRaw<
    Pick<SessionDetail, "artifactId" | "computeTargetId">[]
  >(
    Prisma.sql`
    SELECT session.artifact_id::text AS "artifactId",
           session.compute_target_id::text AS "computeTargetId"
      FROM agent_component_invocation_generations AS gen
      JOIN session_detail AS session ON session.artifact_id = gen.agent_session_id
      JOIN artifacts AS artifact ON artifact.id = session.artifact_id
      JOIN compute_targets AS owner ON owner.id = session.compute_target_id
      JOIN compute_targets AS sender ON sender.id = ${input.computeTargetId}::uuid
     WHERE session.external_session_id = ${candidate}
       AND artifact.organization_id = ${input.organizationId}::uuid
       AND owner.user_id = sender.user_id
       AND gen.external_generation_id = ${part.externalGenerationId}
       AND gen.source_updated_at = ${new Date(part.sourceUpdatedAt)}
       AND gen.data_revision = ${part.dataRevision}
       AND gen.source_sequence = ${part.sourceSequence}
     ORDER BY gen.created_at ASC, session.artifact_id ASC
     LIMIT 1
  `
  );
  return rows[0] ?? null;
}

/**
 * The one cloud parent for `candidate` that this SENDER's own user owns, on any
 * machine, or null when there is no such row or more than one.
 *
 * Scoped to the sending target's `user_id`, not merely to the org. The case this
 * fallback exists for — a replacement machine replaying a copied outbox — is
 * always the same person, while an org-wide match lets any teammate's desktop
 * that happens to send a part carrying your `externalSessionId` replace the
 * active generation on your session and resolve its components against your
 * machine's inventory.
 *
 * Aggregating identity and cardinality in ONE statement keeps the count and the
 * read from racing, and `HAVING COUNT(*) = 1` means an ambiguous match resolves
 * to nothing rather than to an arbitrary row.
 */
async function resolveHistoricalInvocationSession(
  tx: TransactionClient,
  input: IngestAgentComponentInvocationPartInput,
  candidate: string
): Promise<Pick<SessionDetail, "artifactId" | "computeTargetId"> | null> {
  const rows = await tx.$queryRaw<
    Pick<SessionDetail, "artifactId" | "computeTargetId">[]
  >(
    Prisma.sql`
    SELECT MIN(session.artifact_id::text) AS "artifactId",
           MIN(session.compute_target_id::text) AS "computeTargetId"
      FROM session_detail AS session
      JOIN artifacts AS artifact ON artifact.id = session.artifact_id
      JOIN compute_targets AS owner ON owner.id = session.compute_target_id
      JOIN compute_targets AS sender ON sender.id = ${input.computeTargetId}::uuid
     WHERE session.external_session_id = ${candidate}
       AND artifact.organization_id = ${input.organizationId}::uuid
       AND owner.user_id = sender.user_id
    HAVING COUNT(*) = 1
  `
  );
  return rows[0] ?? null;
}
