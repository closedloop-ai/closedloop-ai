import type { DocumentType } from "@repo/api/src/types/document";
import {
  ARTIFACT_SLUG_PREFIXES,
  type SlugPrefix,
} from "@repo/api/src/types/slug-prefix";
import { withDb } from "@repo/database";
import { nanoid } from "nanoid";

// withDb participates in any ambient withDb.tx transaction via
// AsyncLocalStorage, so callers inside a transaction get atomic slug
// allocation without threading a transaction client through this signature.
export async function generateSlug(
  organizationId: string,
  typePrefix: SlugPrefix
): Promise<string> {
  const result = await withDb((db) =>
    db.slugCounter.upsert({
      where: {
        organizationId_typePrefix: {
          organizationId,
          typePrefix,
        },
      },
      update: {
        currentValue: {
          increment: 1,
        },
      },
      create: {
        organizationId,
        typePrefix,
        currentValue: 1,
      },
    })
  );

  return `${typePrefix}-${result.currentValue}`;
}

export async function generateArtifactSlug(
  organizationId: string,
  type: DocumentType
): Promise<string> {
  const slugPrefix = ARTIFACT_SLUG_PREFIXES[type];
  return slugPrefix
    ? await generateSlug(organizationId, slugPrefix)
    : nanoid(14);
}
