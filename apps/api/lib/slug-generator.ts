import { DocumentType } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { nanoid } from "nanoid";

export const SlugPrefix = {
  Project: "PRO",
  Workstream: "WRK",
  Prd: "PRD",
  Plan: "PLN",
  Feature: "FEA",
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
  type: DocumentType
): Promise<string> {
  const slugPrefix = ARTIFACT_SLUG_PREFIXES[type];
  return slugPrefix
    ? await generateSlug(organizationId, slugPrefix)
    : nanoid(14);
}

const ARTIFACT_SLUG_PREFIXES: Partial<Record<DocumentType, SlugPrefix>> = {
  [DocumentType.Prd]: SlugPrefix.Prd,
  [DocumentType.ImplementationPlan]: SlugPrefix.Plan,
  [DocumentType.Feature]: SlugPrefix.Feature,
};
