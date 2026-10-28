import "server-only";

import { sanitizeOperatorMessageFragment } from "@repo/database/scripts/migrate-deploy-recovery";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import type { NextRequest } from "next/server";
import type { z } from "zod";
import {
  GitHubOidcCaller,
  validateGitHubOidcToken,
} from "@/lib/auth/github-oidc-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { parsePreviewSchemaRequestBody } from "../request-body";
import { VibeEnvironmentFailureReason } from "./constants";
import type { VibeEnvironmentFailure } from "./service/target";

/**
 * How each refusal reads over HTTP. Exhaustive, so a new reason fails
 * typecheck until it has a status.
 */
const STATUS_BY_REASON: Record<VibeEnvironmentFailureReason, number> = {
  [VibeEnvironmentFailureReason.HostNotAllowed]: 403,
  [VibeEnvironmentFailureReason.WrongDeployment]: 403,
  [VibeEnvironmentFailureReason.NotAPreviewSchema]: 400,
  [VibeEnvironmentFailureReason.WrongState]: 409,
  [VibeEnvironmentFailureReason.Refused]: 422,
  [VibeEnvironmentFailureReason.Failed]: 500,
};

/**
 * The shared shape of every `/preview-schemas/vibe-environment/*` handler:
 * the vibe environment OIDC caller, the surface's body cap, the service call,
 * and a JSON envelope on every path. An unexpected throw answers with a fixed
 * message, because the workflow prints the body into an Actions log.
 */
export function vibeEnvironmentHandler<T extends z.ZodType, R extends object>(
  options: {
    validator: T;
    maxBytes?: number;
    unexpectedFailureMessage: string;
  },
  run: (
    body: z.infer<T>,
    startedAt: number
  ) => Promise<({ ok: true } & R) | VibeEnvironmentFailure>
) {
  return async (request: NextRequest): Promise<Response> => {
    const startedAt = Date.now();
    try {
      const authError = await validateGitHubOidcToken(request, {
        caller: GitHubOidcCaller.PreviewSchemaVibeEnvironment,
      });
      if (authError) {
        return authError;
      }
      const { body, errorResponse: parseErrorResponse } =
        await parsePreviewSchemaRequestBody(
          request,
          options.validator,
          options.maxBytes
        );
      if (parseErrorResponse) {
        return parseErrorResponse;
      }
      const result = await run(body, startedAt);
      if (!result.ok) {
        return errorResponse(
          result.message,
          null,
          STATUS_BY_REASON[result.reason],
          {
            ...(result.code === undefined ? {} : { code: result.code }),
            ...(result.details === undefined
              ? {}
              : { details: result.details }),
          }
        );
      }
      const { ok, ...data } = result;
      return successResponse(data);
    } catch (error) {
      log.error(options.unexpectedFailureMessage, {
        error: sanitizeOperatorMessageFragment(parseError(error)),
      });
      return errorResponse(options.unexpectedFailureMessage, null, 500);
    }
  };
}
