import type { ApiResult } from "@repo/api/src/types/common";
import { ProjectArtifactPlacementErrorReason } from "@repo/api/src/types/project-artifact-placement";
import { Status } from "@repo/api/src/types/result";
import type { NextResponse } from "next/server";
import {
  PLACEMENT_CYCLE_MESSAGE,
  PLACEMENT_MAX_DEPTH_MESSAGE,
} from "@/app/documents/project-artifact-placement-messages";
import { badRequestResponse, conflictResponse } from "@/lib/route-utils";
import {
  DUPLICATE_ARTIFACT_LINK_MESSAGE,
  SELF_ARTIFACT_LINK_MESSAGE,
} from "./link-messages";
import type { CreateArtifactLinkFailure } from "./service";

export function createArtifactLinkFailureResponse(
  error: CreateArtifactLinkFailure
): NextResponse<ApiResult<never>> {
  if (error === Status.Conflict) {
    return conflictResponse(DUPLICATE_ARTIFACT_LINK_MESSAGE);
  }
  if (error === Status.BadRequest) {
    return badRequestResponse(SELF_ARTIFACT_LINK_MESSAGE);
  }
  if (error === ProjectArtifactPlacementErrorReason.Cycle) {
    return badRequestResponse(PLACEMENT_CYCLE_MESSAGE, { code: error });
  }
  if (error === ProjectArtifactPlacementErrorReason.MaxDepth) {
    return badRequestResponse(PLACEMENT_MAX_DEPTH_MESSAGE, { code: error });
  }
  // A new failure value added to CreateArtifactLinkFailure fails typecheck
  // here rather than reaching a caller as an unlabelled 500.
  const exhaustive: never = error;
  throw new Error(`Unmapped artifact-link failure ${String(exhaustive)}`);
}
