import { z } from "zod";

const artifactWireSchema = z.looseObject({
  id: z.string().min(1),
  currentVersion: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
});
const parentWireSchema = z.looseObject({
  childId: z.string().min(1),
  parent: artifactWireSchema,
});

/**
 * Validate the structure a project tree reader walks and its optional version
 * enrichment. Loose objects preserve additive fields from a newer server;
 * unknown truncation reasons remain explicit incomplete-read evidence.
 */
export const projectTreeWireSchema = z.looseObject({
  nodes: z.array(
    z.looseObject({
      root: artifactWireSchema,
      children: z.array(artifactWireSchema),
    })
  ),
  externalParents: z.array(parentWireSchema),
  flatParents: z.array(parentWireSchema).optional(),
  projectVersion: z.string().min(1).optional(),
  hierarchyRevision: z.string().min(1).optional(),
  truncation: z
    .looseObject({
      anchorsIncluded: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER),
      anchorsMatchedAtLeast: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER),
      reasons: z.array(z.string().min(1)).min(1),
    })
    .optional(),
});
