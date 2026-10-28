/**
 * @file priority-upload-marker.ts
 * @description ISS-10332: a locally set priority is sent to the cloud until a
 * sync the cloud confirmed has carried it, and not after.
 *
 * The cloud adopts a synced priority only while its own artifact holds none, and
 * a clear made on the web leaves it holding none. A desktop that kept sending its
 * value would therefore undo that clear on the session's next re-sync — or, for
 * a branch, on the next sync of any linked session. So the local write sets
 * `priority_upload_pending`, the upload read projects `priority` only while it
 * is set, and the accepted ack resets it for the value that was sent.
 */
import type { PriorityUploadClaim } from "../agent-sync/priority-upload-claims.js";
import { PriorityUploadProjection } from "../agent-sync/priority-upload-projection.js";
import { ArtifactKind } from "../enrichment/identity-key.js";
import type { DesktopPrisma } from "./prisma-client.js";

/**
 * The `priority` column as a SELECT expression. An upload projection gets NULL
 * for a value it must not carry, which every upload payload already omits.
 */
export function priorityColumnSql(
  tableAlias: string | null,
  projection: PriorityUploadProjection = PriorityUploadProjection.Stored
): string {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const expressions: Record<PriorityUploadProjection, string> = {
    [PriorityUploadProjection.Stored]: `${prefix}priority`,
    [PriorityUploadProjection.PendingUpload]: `CASE WHEN ${prefix}priority_upload_pending = 1 THEN ${prefix}priority END`,
  };
  return expressions[projection];
}

/**
 * Reset the marker for each value an acked payload carried. Matching the stored
 * `priority` against the SENT one is what lets an edit made after the payload
 * was built survive the ack: the row no longer holds what was sent, so it stays
 * pending and the next sync carries the new value.
 *
 * One update per claim, in one transaction: the claims come from one sync
 * batch (`priorityUploadClaims` over the sent sessions), and only sessions that
 * carried a pending value make one.
 */
export function settlePriorityUploads(
  prisma: DesktopPrisma,
  claims: readonly PriorityUploadClaim[]
): Promise<void> {
  if (claims.length === 0) {
    return Promise.resolve();
  }
  return prisma.write((writer) =>
    writer.$transaction(async (client) => {
      for (const claim of claims) {
        if (claim.priority) {
          await client.session.updateMany({
            where: {
              id: claim.sessionId,
              priority: claim.priority,
              priorityUploadPending: 1,
            },
            data: { priorityUploadPending: 0 },
          });
        }
        for (const branch of claim.branches) {
          await client.artifact.updateMany({
            where: {
              kind: ArtifactKind.Branch,
              repoFullName: branch.repositoryFullName,
              branchName: branch.branchName,
              priority: branch.priority,
              priorityUploadPending: 1,
            },
            data: { priorityUploadPending: 0 },
          });
        }
      }
    })
  );
}
