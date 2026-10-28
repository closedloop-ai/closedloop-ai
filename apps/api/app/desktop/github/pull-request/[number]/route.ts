import {
  DesktopGithubPullRequestRequestMaxBytes,
  DesktopGithubPullRequestStage,
  type DesktopGithubPullRequestSuccess,
  desktopGithubPullRequestUpdateRequestSchema,
} from "@repo/api/src/types/desktop-github-pull-request";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { successResponse } from "@/lib/route-utils";
import { readBoundedJsonBody } from "../../../route-helpers";
import { desktopGithubPullRequestFailureResponse } from "../response";
import {
  bodyFailureResponses,
  desktopSessionRequiredFailure,
  validationFailure,
} from "../route-failures";
import { desktopGithubPullRequestService } from "../service";

export const maxDuration = 30;

export const PATCH = withAnyAuth<
  DesktopGithubPullRequestSuccess,
  "/desktop/github/pull-request/[number]"
>(async (authContext, request, params) => {
  if (authContext.authMethod !== "desktop_session") {
    return desktopGithubPullRequestFailureResponse(
      desktopSessionRequiredFailure(DesktopGithubPullRequestStage.ApiUpdate)
    );
  }

  const { number } = await params;
  const pullNumber = Number(number);
  if (!(Number.isInteger(pullNumber) && pullNumber > 0)) {
    return desktopGithubPullRequestFailureResponse(
      validationFailure(
        "pull request number must be a positive integer",
        DesktopGithubPullRequestStage.ApiUpdate
      )
    );
  }

  const { rawBody, response } = await readBoundedJsonBody(
    request,
    DesktopGithubPullRequestRequestMaxBytes,
    bodyFailureResponses(DesktopGithubPullRequestStage.ApiUpdate)
  );
  if (response) {
    return response;
  }

  const parsed = desktopGithubPullRequestUpdateRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return desktopGithubPullRequestFailureResponse(
      validationFailure(
        "Invalid desktop pull request update payload",
        DesktopGithubPullRequestStage.ApiUpdate
      )
    );
  }

  const result = await desktopGithubPullRequestService.update({
    organizationId: authContext.user.organizationId,
    userId: authContext.user.id,
    pullNumber,
    request: parsed.data,
    now: new Date(),
  });
  if (result.ok) {
    return successResponse(result.value);
  }
  return desktopGithubPullRequestFailureResponse(result.error);
});
