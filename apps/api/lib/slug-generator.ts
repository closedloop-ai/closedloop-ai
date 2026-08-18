import { ARTIFACT_SLUG_PREFIXES } from "@repo/api/src/types/artifact-slug-prefixes";
import type { DocumentType } from "@repo/api/src/types/document";
import {
  SLUG_COUNTER_KEY,
  type SlugPrefix,
} from "@repo/api/src/types/slug-prefix";
import { withDb } from "@repo/database";
import { nanoid } from "nanoid";

// withDb participates in any ambient withDb.tx transaction via
// AsyncLocalStorage, so callers inside a transaction get atomic slug
// allocation without threading a transaction client through this signature.
//
// FEA-4137: the emitted DISPLAY prefix (`typePrefix`) can differ from the
// COUNTER-key prefix — Issues mint `ISS-###` but increment the org's existing
// `FEA` counter row (SLUG_COUNTER_KEY), so the numeric series stays continuous
// across the Feature → Issue rename with no counter reset or data migration.
export async function generateSlug(
  organizationId: string,
  typePrefix: SlugPrefix
): Promise<string> {
  const counterPrefix = SLUG_COUNTER_KEY[typePrefix] ?? typePrefix;
  const result = await withDb((db) =>
    db.slugCounter.upsert({
      where: {
        organizationId_typePrefix: {
          organizationId,
          typePrefix: counterPrefix,
        },
      },
      update: {
        currentValue: {
          increment: 1,
        },
      },
      create: {
        organizationId,
        typePrefix: counterPrefix,
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
