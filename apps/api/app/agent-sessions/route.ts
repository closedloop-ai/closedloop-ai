import type { AgentSessionListResponse } from "@repo/api/src/types/agent-session";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { LIST_QUERY_EXPRESSION_PARAM } from "@repo/api/src/types/list-query-expression";
import { ListQuerySource } from "@repo/api/src/types/list-query-observability";
import { Status } from "@repo/api/src/types/result";
import { waitUntil } from "@vercel/functions";
import { artifactTagPermissionsForAuth } from "@/app/tags/artifact-tag-projection";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  recordRequestListQueryCounts,
  recordRequestListQuerySource,
} from "@/lib/observability/request-span-attribution";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { teamScopeRefusalResponse } from "@/lib/team-scope-policy";
import { listQueryRefusalMetadata } from "./list-query-param";
import {
  authorizeAgentSessionTeamScope,
  resolveUsageTypedSqlShadow,
} from "./route-helpers";
import { agentSessionsService } from "./service";
import {
  shadowSessionListCompoundSort,
  shadowSessionListSort,
} from "./service/session-list-sort-shadow";
import {
  resolveSqlNativeCompoundSortRequest,
  resolveSqlNativeSingleSortRequest,
} from "./service/session-list-sql-reader";
import { sessionCreateReceiptWrite } from "./session-operation-receipt";
import { sessionWriteService } from "./session-write-service";
import {
  agentSessionListQuerySchema,
  sanitizedAgentSessionCreateBodySchema,
} from "./validators";
import type { AgentSessionCreateResponse } from "./write-contract";

// FEA-4155 removed this route's server read gate when the Sessions surface
// stopped being gated on the client — otherwise the page mounts but every read
// 403s as the flag winds down (whitlockk review #3789). ISS-8022 then retired the
// `desktop-agent-session-sync` PostHog flag itself. Org/team RBAC still applies
// via `authorizeAgentSessionTeamScope` + org-scoped service reads.
export const GET = withAnyAuth<AgentSessionListResponse, "/agent-sessions">(
  async (authContext, request) => {
    const { user, clerkOrgId, clerkUserId } = authContext;
    recordRequestListQuerySource(
      new URL(request.url).searchParams.has(LIST_QUERY_EXPRESSION_PARAM)
        ? ListQuerySource.Canonical
        : ListQuerySource.Legacy
    );
    const { params, errorResponse } = parseQueryParams(
      request,
      agentSessionListQuerySchema,
      {
        errorMetadata: listQueryRefusalMetadata,
      }
    );
    if (errorResponse) {
      return errorResponse;
    }

    const teamScopeAllowed = await authorizeAgentSessionTeamScope({
      organizationId: user.organizationId,
      userId: user.id,
      clerkOrgId,
      clerkUserId,
      filters: params,
    });
    const teamScopeRefusal = teamScopeRefusalResponse(teamScopeAllowed);
    if (teamScopeRefusal) {
      return teamScopeRefusal;
    }

    const listInput = {
      organizationId: user.organizationId,
      // FEA-3534: thread the authenticated viewer so `viewerScope=self` is
      // enforced server-side (Me scope pins the read to this user's sessions).
      viewerId: user.id,
      clerkUserId,
      filters: params,
      // ISS-8712: the caller's tag capabilities, resolved from the SAME scopes
      // the `/entity-tags` writes enforce, so the picker offers exactly the
      // actions this caller could actually complete. Advisory only — the write
      // routes re-check.
      tagPermissions: artifactTagPermissionsForAuth(authContext),
    };
    // ISS-8554 Phase 3 / PLN-1853 D15 (amended revision 13): a single-rule
    // request on a column this phase has a SQL path for, OR a compound chain
    // of two to four rules, gets shadowed — the candidate runs ALONGSIDE the
    // already-served live order and the diff is logged, exactly like the
    // usage-summary shadow (`usage/route.ts`), and — per the operator's
    // 2026-10-09 ruling — behind the SAME flag rather than a second one. A
    // chain of five-plus distinct columns, or a single rule this phase has no
    // SQL path for yet, resolves `null` on both and is untouched.
    const sqlSortRequest = resolveSqlNativeSingleSortRequest(params);
    const compoundSqlSortRequest = sqlSortRequest
      ? null
      : resolveSqlNativeCompoundSortRequest(params);

    // The gate resolves ALONGSIDE the page read, the shape `usage/route.ts`
    // uses. Its memo has a 10s TTL, so a miss is a blocking PostHog
    // evaluation — serially before `successResponse` that charges the reader a
    // flag round trip to decide a DIAGNOSTIC (tamsinb on #8670). A request
    // this phase would not shadow does not read it at all.
    const [response, shadowOpen] = await Promise.all([
      agentSessionsService.findSessions(listInput),
      sqlSortRequest || compoundSqlSortRequest
        ? resolveUsageTypedSqlShadow({ userId: user.id, clerkUserId })
        : false,
    ]);
    recordRequestListQueryCounts({
      matchedCount: response.total,
      resultCount: response.items.length,
    });
    if (
      (sqlSortRequest || compoundSqlSortRequest) &&
      shadowOpen &&
      response.pageInfo
    ) {
      const { pageInfo } = response;
      // The served page's OWN `updated` keys: `recordUpdatedAt` is the same
      // `GREATEST` of the two `@updatedAt` columns the candidate statements
      // order by, read inside the list snapshot that produced this order. A
      // key that differs from the candidate's therefore moved between the two
      // reads, which is what makes a mismatch attributable.
      const livePage = response.items.map((item) => ({
        id: item.id,
        recordUpdatedAtMs: item.recordUpdatedAt?.getTime() ?? null,
      }));
      if (sqlSortRequest) {
        waitUntil(
          shadowSessionListSort(
            listInput,
            sqlSortRequest,
            pageInfo.offset,
            pageInfo.limit,
            livePage
          )
        );
      } else if (compoundSqlSortRequest) {
        waitUntil(
          shadowSessionListCompoundSort(
            listInput,
            compoundSqlSortRequest.rules,
            pageInfo.offset,
            pageInfo.limit,
            livePage
          )
        );
      }
    }

    return successResponse({
      ...response,
      ...(params.componentSlug ? { componentScope: params.componentSlug } : {}),
    });
  }
);

/**
 * POST /agent-sessions — create a session (ISS-8648).
 *
 * Idempotent on `(computeTargetId, externalSessionId)`, the same unique key the
 * desktop ingest upserts on: a retry returns the existing row with
 * `created: false`, and a later desktop sync of that run lands on this row
 * rather than minting a second one.
 *
 * Responds with the row in the SAME projection the list renders, so the caller
 * can reconcile without a refetch. Two honest caveats a host must know:
 * the desktop ingest's update arm rewrites `artifact.name` and `artifact.status`
 * from its own payload on the next sync of the same run, and a brand-new session
 * with no activity is excluded by the list's default `substantive` quality
 * filter — which is why the row is returned here rather than fetched back.
 *
 * Status mapping (apps/api/AGENTS.md "Errors as values"):
 *  - 200 — created, or an idempotent retry of an existing row
 *  - 400 — Zod failure, or a computeTarget/project/owner outside the caller's org
 *  - 500 — uncaught service error
 */
export const POST = withAnyAuth<AgentSessionCreateResponse, "/agent-sessions">(
  withOperationReceipts(
    OperationKind.Create,
    async ({ user }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          sanitizedAgentSessionCreateBodySchema
        );
        if (parseError) {
          return parseError;
        }

        const result = await sessionWriteService.createSession(
          {
            organizationId: user.organizationId,
            actorUserId: user.id,
            ...body,
          },
          receipts.whenRecording((tx, written) =>
            receipts.record(tx, sessionCreateReceiptWrite(written))
          )
        );
        if (result.ok) {
          return successResponse(withOperationReceipt(result.value, receipts));
        }
        if (result.error === Status.BadRequest) {
          return badRequestResponse(
            "Unknown compute target, project, or owner for this organization"
          );
        }
        return errorResponse("Failed to create agent session", result.error);
      } catch (error) {
        return errorResponse("Failed to create agent session", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
