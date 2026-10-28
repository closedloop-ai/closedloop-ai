import {
  DesktopGithubPullRequestRequestMaxBytes,
  DesktopGithubPullRequestStage,
  type DesktopGithubPullRequestSuccess,
  desktopGithubPullRequestRequestSchema,
} from "@repo/api/src/types/desktop-github-pull-request";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { successResponse } from "@/lib/route-utils";
import { readBoundedJsonBody } from "../../route-helpers";
import { desktopGithubPullRequestFailureResponse } from "./response";
import {
  bodyFailureResponses,
  desktopSessionRequiredFailure,
  validationFailure,
} from "./route-failures";
import { desktopGithubPullRequestService } from "./service";

export const maxDuration = 30;

export const POST = withAnyAuth<
  DesktopGithubPullRequestSuccess,
  "/desktop/github/pull-request"
>(async (authContext, request) => {
  if (authContext.authMethod !== "desktop_session") {
    return desktopGithubPullRequestFailureResponse(
      desktopSessionRequiredFailure(DesktopGithubPullRequestStage.ApiPreflight)
    );
  }

  const { rawBody, response } = await readBoundedJsonBody(
    request,
    DesktopGithubPullRequestRequestMaxBytes,
    bodyFailureResponses(DesktopGithubPullRequestStage.ApiPreflight)
  );
  if (response) {
    return response;
  }

  const parsed = desktopGithubPullRequestRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return desktopGithubPullRequestFailureResponse(
      validationFailure(
        "Invalid desktop pull request payload",
        DesktopGithubPullRequestStage.ApiPreflight
      )
    );
  }

  const result = await desktopGithubPullRequestService.handle({
    organizationId: authContext.user.organizationId,
    userId: authContext.user.id,
    request: parsed.data,
    now: new Date(),
  });
  if (result.ok) {
    return successResponse(result.value);
  }
  return desktopGithubPullRequestFailureResponse(result.error);
});
