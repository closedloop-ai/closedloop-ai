import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import {
  CustomFieldEntityType,
  CustomFieldType,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import type { Prisma } from "@repo/database";
import { customFieldValuesService } from "@/app/custom-fields/values-service";
import type { VibeSeedContext } from "../stage";

/**
 * ISS-12017: values for the org's REFERENCE and REFERENCE_MULTI document
 * fields, written through `customFieldValuesService.setValueForEntity`, the
 * PUT custom-field value path, which validates each target and replaces the
 * `custom_field_value_references` rows. The same targets are chosen every run,
 * so a re-run rewrites identical rows.
 */

const OWNER_DOCUMENT_COUNT = 8;
const CANDIDATE_TARGET_LIMIT = 12;
const MULTI_REFERENCE_WIDTH = 2;

/** The artifact population each reference source admits, as a query filter. */
const TARGET_FILTER: Record<ReferenceTargetSource, Prisma.ArtifactWhereInput> =
  {
    [ReferenceTargetSource.Artifact]: {
      type: ArtifactType.Document,
      subtype: { not: ArtifactSubtype.Template },
    },
    [ReferenceTargetSource.Issue]: {
      type: ArtifactType.Document,
      subtype: ArtifactSubtype.Feature,
    },
    [ReferenceTargetSource.Session]: { type: ArtifactType.Session },
    [ReferenceTargetSource.Branch]: { type: ArtifactType.Branch },
  };

type ReferenceField = {
  id: string;
  name: string;
  fieldType: string;
  referenceTargetSources: readonly ReferenceTargetSource[];
};

export async function seedCustomFieldReferences(
  context: VibeSeedContext
): Promise<void> {
  const fields = await context.prisma.customField.findMany({
    where: {
      organizationId: context.organizationId,
      fieldType: {
        in: [CustomFieldType.Reference, CustomFieldType.ReferenceMulti],
      },
      entityTypes: { has: CustomFieldEntityType.Document },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      fieldType: true,
      referenceTargetSources: true,
    },
  });
  if (fields.length === 0) {
    throw new Error(
      "the org has no REFERENCE or REFERENCE_MULTI document field; the base seed should have created them"
    );
  }
  const owners = await context.prisma.artifact.findMany({
    where: {
      organizationId: context.organizationId,
      type: ArtifactType.Document,
      subtype: {
        in: [ArtifactSubtype.Prd, ArtifactSubtype.ImplementationPlan],
      },
    },
    orderBy: [{ slug: "asc" }, { id: "asc" }],
    take: OWNER_DOCUMENT_COUNT,
    select: { id: true },
  });
  let written = 0;
  for (const field of fields) {
    const candidates = await readCandidateTargets(context, field);
    if (candidates.length === 0) {
      context.log(`custom field ${field.name}: no target to reference`);
      continue;
    }
    for (const [index, owner] of owners.entries()) {
      await customFieldValuesService.setValueForEntity(
        field.id,
        CustomFieldEntityType.Document,
        owner.id,
        context.organizationId,
        referenceValue(field, candidates, index)
      );
      written += 1;
    }
  }
  context.log(`custom field references: ${written} value(s) written`);
}

/** Each source's newest targets, interleaved so a mixed field references every kind. */
async function readCandidateTargets(
  context: VibeSeedContext,
  field: ReferenceField
): Promise<string[]> {
  const perSource: string[][] = [];
  for (const source of field.referenceTargetSources) {
    const rows = await context.prisma.artifact.findMany({
      where: {
        organizationId: context.organizationId,
        ...TARGET_FILTER[source],
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: CANDIDATE_TARGET_LIMIT,
      select: { id: true },
    });
    perSource.push(rows.map((row) => row.id));
  }
  const interleaved: string[] = [];
  for (let rank = 0; rank < CANDIDATE_TARGET_LIMIT; rank += 1) {
    for (const ids of perSource) {
      if (rank < ids.length) {
        interleaved.push(ids[rank]);
      }
    }
  }
  return interleaved;
}

function referenceValue(
  field: ReferenceField,
  candidates: readonly string[],
  index: number
): string | string[] {
  const first = candidates[index % candidates.length];
  if (field.fieldType === CustomFieldType.Reference) {
    return first;
  }
  const picked = new Set<string>();
  for (let offset = 0; offset < MULTI_REFERENCE_WIDTH; offset += 1) {
    picked.add(candidates[(index + offset) % candidates.length]);
  }
  return [...picked];
}
