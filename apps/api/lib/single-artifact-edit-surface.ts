import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { z } from "zod";

export const SINGLE_ARTIFACT_EDIT_SURFACE_ERROR =
  "surface cannot have originated a single-artifact write";
export const ARTIFACT_PRIORITY_EDIT_SURFACE_ERROR =
  "surface cannot have originated a priority write";

/**
 * Permissive optional provenance base for every artifact-edit route.
 *
 * Omission is the version-skew contract: older clients send no `surface`, and
 * newer clients can name a value this server does not know yet. In both cases
 * the write still commits without fabricated provenance. Known values survive
 * for the route-specific refinements below to accept or refuse.
 */
export const optionalArtifactEditSurface = z
  .enum(ArtifactStatusEditSurface)
  .optional()
  .catch(undefined);

/** Detail, inline-cell, or board provenance accepted by one-artifact writes. */
export const optionalSingleArtifactEditSurface =
  optionalArtifactEditSurface.refine(
    (value) =>
      value === undefined ||
      value === ArtifactStatusEditSurface.Detail ||
      value === ArtifactStatusEditSurface.InlineCell ||
      value === ArtifactStatusEditSurface.Board,
    { message: SINGLE_ARTIFACT_EDIT_SURFACE_ERROR }
  );
