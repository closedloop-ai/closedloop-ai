import { ArtifactType } from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { nanoid } from "nanoid";

export const SlugPrefix = {
  Project: "PRO",
  Workstream: "WRK",
  Prd: "PRD",
  Plan: "PLN",
  Feature: "FEA",
  Branch: "BRN",
} as const;
export type SlugPrefix = (typeof SlugPrefix)[keyof typeof SlugPrefix];

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
  type: ArtifactType
): Promise<string> {
  const slugPrefix = ARTIFACT_SLUG_PREFIXES[type];
  return slugPrefix
    ? await generateSlug(organizationId, slugPrefix)
    : nanoid(14);
}

const ARTIFACT_SLUG_PREFIXES: Partial<Record<ArtifactType, SlugPrefix>> = {
  [ArtifactType.Prd]: SlugPrefix.Prd,
  [ArtifactType.ImplementationPlan]: SlugPrefix.Plan,
  [ArtifactType.Template]: SlugPrefix.Branch,
};
