import {
  DesktopGithubPullRequestErrorCode,
  DesktopGithubPullRequestReason,
  type DesktopGithubPullRequestStage,
} from "@repo/api/src/types/desktop-github-pull-request";
import {
  type DesktopGithubPullRequestServiceFailure,
  serviceFailure,
} from "./failure";
import { desktopGithubPullRequestFailureResponse } from "./response";

export function desktopSessionRequiredFailure(
  stage: DesktopGithubPullRequestStage
): DesktopGithubPullRequestServiceFailure {
  return serviceFailure({
    status: 403,
    code: DesktopGithubPullRequestErrorCode.AuthorizationDenied,
    reason: DesktopGithubPullRequestReason.AuthorizationDenied,
    stage,
    message: "Desktop session authentication is required.",
    retryable: false,
  });
}

export function bodyFailureResponses(stage: DesktopGithubPullRequestStage) {
  return {
    invalidJson: () =>
      desktopGithubPullRequestFailureResponse(
        validationFailure("Invalid JSON body", stage)
      ),
    payloadTooLarge: () =>
      desktopGithubPullRequestFailureResponse(
        validationFailure("Request body too large", stage, 413)
      ),
    readFailure: () =>
      desktopGithubPullRequestFailureResponse(
        serviceFailure({
          status: 500,
          code: DesktopGithubPullRequestErrorCode.TransientUnavailable,
          reason: DesktopGithubPullRequestReason.TransientUnavailable,
          stage,
          message: "Failed to read request body.",
          retryable: true,
        })
      ),
  };
}

export function validationFailure(
  message: string,
  stage: DesktopGithubPullRequestStage,
  status = 400
): DesktopGithubPullRequestServiceFailure {
  return serviceFailure({
    status,
    code: DesktopGithubPullRequestErrorCode.ValidationFailed,
    reason: DesktopGithubPullRequestReason.ValidationFailed,
    stage,
    message,
    retryable: false,
  });
}
