import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import { AgentComponentInvocationSyncRejectReason } from "@repo/api/src/types/agent-component-invocation";
import { DesktopAgentSessionsSyncErrorCode } from "@repo/api/src/types/agent-session";
import { AgentSessionFieldMutationErrorCode } from "@repo/api/src/types/agent-session-field-mutation";
import { AgentSessionStateActionRemoval } from "@repo/api/src/types/agent-session-state-action-removal";
import { ArtifactPriorityMutationErrorCode } from "@repo/api/src/types/artifact-priority-mutation";
import { ArtifactRowFieldMutationErrorCode } from "@repo/api/src/types/artifact-row-field-edit";
import {
  AttachmentUploadResponseErrorCode,
  CreateInlineImageAttachmentErrorCode,
} from "@repo/api/src/types/attachment";
import { AuthErrorCode } from "@repo/api/src/types/auth-error";
import { BatchQuerySelectionErrorCode } from "@repo/api/src/types/batch-query-selection";
import {
  BranchViewFileCacheSyncErrorCode,
  BranchViewSyncErrorCode,
} from "@repo/api/src/types/branch-view";
import { BranchViewLocalErrorCode } from "@repo/api/src/types/branch-view-local";
import { BrowserSessionErrorCode } from "@repo/api/src/types/browser-session";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import {
  CreateDocumentErrorCode,
  SourceLinkedPlanCreateErrorCode,
} from "@repo/api/src/types/create-document";
import { DesktopBootstrapErrorCode } from "@repo/api/src/types/desktop-bootstrap";
import { DesktopClaudeCodeTelemetrySyncErrorCode } from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import { DesktopGithubPullRequestErrorCode } from "@repo/api/src/types/desktop-github-pull-request";
import { TranscriptForbiddenCode } from "@repo/api/src/types/desktop-transcripts";
import {
  DesktopAgentComponentInvocationSyncRestErrorCode,
  DesktopAnalyticsRestErrorCode,
  DesktopComponentsSyncRestErrorCode,
  DesktopWriteLaneRejectReason,
  DesktopWriteLaneRestErrorCode,
} from "@repo/api/src/types/desktop-write-lane";
import { DocumentFieldMutationErrorCode } from "@repo/api/src/types/document-field-mutation";
import { DocumentStatusMutationErrorCode } from "@repo/api/src/types/document-status-mutation";
import { CreateDocumentVersionErrorCode } from "@repo/api/src/types/document-version";
import {
  ComputeTargetSharingEndpointRemoval,
  GeneratePrdEndpointRemoval,
  LoopsEndpointRemoval,
  RoutinesEndpointRemoval,
} from "@repo/api/src/types/endpoint-removal";
import { GitHubBackfillRetryErrorCode } from "@repo/api/src/types/github";
import { GitHubConnectErrorCode } from "@repo/api/src/types/github-clerk-link";
import { GridPreferenceErrorCode } from "@repo/api/src/types/grid-preferences";
import { ListQueryRefusal } from "@repo/api/src/types/list-query-expression";
import { OrganizationMembersErrorCode } from "@repo/api/src/types/organization-members";
import { PenseroRouteErrorCode } from "@repo/api/src/types/pensero-integration";
import { ProjectErrorCode } from "@repo/api/src/types/project";
import { ProjectFieldMutationErrorCode } from "@repo/api/src/types/project-field-mutation";
import { SessionMeshForbiddenCode } from "@repo/api/src/types/session-mesh";
import { SettingsCommandDenialCode } from "@repo/api/src/types/settings-command";
import { SettingsDomainFailureReason } from "@repo/api/src/types/settings-domain";
import { API_KEY_SCOPES_UNRESOLVABLE_CODE } from "@repo/api/src/utils/api-key-scope-resolution";
import { z } from "zod";

/**
 * ISS-12168: the closed set of error codes a `request_completed` line may
 * carry as `error_code`.
 *
 * The members are the shared wire-contract code objects (`@repo/api` and
 * `@closedloop-ai/loops-api`) that `apps/api` answers a response `code` from — the same
 * bound `commentErrorCodeSchema` (`z.enum(CommentErrorCode)`) puts on one of
 * them. A response `code` that is not a member, such as a route-local constant
 * or an ad-hoc literal, is dropped rather than logged, because a string outside
 * the set can be free text or an id. The four `*Removal` objects pair the code
 * with a message, so only `Code` is read from them, and
 * `API_KEY_SCOPES_UNRESOLVABLE_CODE` is a bare string.
 */
const REQUEST_ERROR_CODE_SOURCES = [
  AgentComponentInvocationSyncRejectReason,
  AgentSessionFieldMutationErrorCode,
  ArtifactPriorityMutationErrorCode,
  ArtifactRowFieldMutationErrorCode,
  AttachmentUploadResponseErrorCode,
  AuthErrorCode,
  BatchQuerySelectionErrorCode,
  BranchViewFileCacheSyncErrorCode,
  BranchViewLocalErrorCode,
  BranchViewSyncErrorCode,
  BrowserSessionErrorCode,
  CommentErrorCode,
  CreateDocumentErrorCode,
  CreateDocumentVersionErrorCode,
  CreateInlineImageAttachmentErrorCode,
  DesktopAgentComponentInvocationSyncRestErrorCode,
  DesktopAgentSessionsSyncErrorCode,
  DesktopAnalyticsRestErrorCode,
  DesktopBootstrapErrorCode,
  DesktopClaudeCodeTelemetrySyncErrorCode,
  DesktopComponentsSyncRestErrorCode,
  DesktopGithubPullRequestErrorCode,
  DesktopWriteLaneRejectReason,
  DesktopWriteLaneRestErrorCode,
  DocumentFieldMutationErrorCode,
  DocumentStatusMutationErrorCode,
  GitHubBackfillRetryErrorCode,
  GitHubConnectErrorCode,
  GridPreferenceErrorCode,
  ListQueryRefusal,
  LoopErrorCode,
  OrganizationMembersErrorCode,
  PenseroRouteErrorCode,
  ProjectErrorCode,
  ProjectFieldMutationErrorCode,
  SessionMeshForbiddenCode,
  SettingsCommandDenialCode,
  SettingsDomainFailureReason,
  SourceLinkedPlanCreateErrorCode,
  TranscriptForbiddenCode,
  { code: AgentSessionStateActionRemoval.Code },
  { code: ComputeTargetSharingEndpointRemoval.Code },
  { code: GeneratePrdEndpointRemoval.Code },
  { code: LoopsEndpointRemoval.Code },
  { code: RoutinesEndpointRemoval.Code },
  { code: API_KEY_SCOPES_UNRESOLVABLE_CODE },
] as const satisfies readonly Readonly<Record<string, string>>[];

type ValueOf<T> = T extends unknown ? T[keyof T] : never;

export type RequestErrorCode = ValueOf<
  (typeof REQUEST_ERROR_CODE_SOURCES)[number]
>;

const REQUEST_ERROR_CODES: ReadonlySet<string> = new Set(
  REQUEST_ERROR_CODE_SOURCES.flatMap((source) => Object.values(source))
);

const CLIENT_ERROR_STATUS_MIN = 400;
const SERVER_ERROR_STATUS_MIN = 500;
const JSON_CONTENT_TYPE = "application/json";

const responseErrorCodeBodySchema = z.object({ code: z.string() });

/**
 * The contract error code a 4xx JSON response carries, or `undefined`.
 *
 * Read from the response body because no typed path reaches every 4xx: the
 * `route-utils` helpers take `code` as a plain `string`, and many routes build
 * `NextResponse.json(failure(…, { code }), …)` without them. Only a 4xx is
 * read, from a clone, so the caller's body is untouched and no other status
 * pays for the read. Total, because it runs in every emitting wrapper's
 * `finally`: an unreadable or non-contract body is `undefined`, never a throw.
 */
export async function readResponseErrorCode(
  response: Response | undefined
): Promise<RequestErrorCode | undefined> {
  if (
    !response ||
    response.status < CLIENT_ERROR_STATUS_MIN ||
    response.status >= SERVER_ERROR_STATUS_MIN
  ) {
    return undefined;
  }
  try {
    if (!response.headers.get("content-type")?.startsWith(JSON_CONTENT_TYPE)) {
      return undefined;
    }
    const parsed = responseErrorCodeBodySchema.safeParse(
      await response.clone().json()
    );
    return parsed.success && isRequestErrorCode(parsed.data.code)
      ? parsed.data.code
      : undefined;
  } catch {
    return undefined;
  }
}

function isRequestErrorCode(value: string): value is RequestErrorCode {
  return REQUEST_ERROR_CODES.has(value);
}
