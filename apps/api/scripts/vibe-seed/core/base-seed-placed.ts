import { ArtifactType } from "@repo/api/src/types/artifact";
import type { VibeSeedContext } from "../stage";
import type { PlannedDocument } from "./base-seed-plan";

/**
 * ISS-12135: the planned documents already in the org, by artifact id. A
 * planned title is unique within its subtype, so the subtype and title find
 * the row whether it was relabelled, created, or left by an earlier run that
 * stopped part way.
 */
export async function findPlacedDocuments(
  context: VibeSeedContext,
  planned: readonly PlannedDocument[]
): Promise<Map<string, PlannedDocument>> {
  const rows = await context.prisma.artifact.findMany({
    where: {
      organizationId: context.organizationId,
      type: ArtifactType.Document,
      projectId: { not: null },
      name: { in: planned.map((document) => document.title) },
    },
    select: { id: true, name: true, subtype: true },
  });
  const idByKey = new Map(
    rows.map((row) => [placementKey(row.subtype, row.name), row.id])
  );
  const placed = new Map<string, PlannedDocument>();
  for (const document of planned) {
    const id = idByKey.get(placementKey(document.subtype, document.title));
    if (id) {
      placed.set(id, document);
    }
  }
  return placed;
}

function placementKey(subtype: string | null, title: string): string {
  return `${subtype}:${title}`;
}
