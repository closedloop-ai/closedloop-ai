import { type JsonValue, success } from "@repo/api/src/types/common";
import type {
  BackendMismatchBody,
  ComputePreferenceRequiredBody,
  ComputeTargetConflictBody,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import type {
  CreateLoopResponse,
  LoopAlreadyActiveBody,
} from "@repo/api/src/types/loop";
import { NextResponse } from "next/server";
import {
  computeTargetsService,
  parseSelectedHarness,
} from "@/app/compute-targets/service";
import { documentGenerationService } from "@/app/documents/generation-service";
import { handleLoopServiceError } from "@/app/loops/loop-error-responses";
import { loopsService } from "@/app/loops/service";
import { computePreferenceService } from "@/app/settings/compute-preference/compute-preference-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { buildMissingAnthropicApiKeyResponse } from "@/lib/loops/cloud-anthropic-key-preflight";
import { buildMissingExplicitPreferenceResponse } from "@/lib/loops/explicit-compute-selection";
import {
  type HarnessSelectionIdentity,
  isHarnessSelectionEnabled,
} from "@/lib/loops/harness-selection-feature";
import { getCommandHandler } from "@/lib/loops/loop-commands";
import {
  dispatchAndClassify,
  dispatchFailureResponse,
  dispatchTargetKindFor,
} from "@/lib/loops/loop-dispatch-utils";
import { enforcePrdRequestChangesGate } from "@/lib/loops/prd-request-changes-feature";
import { buildLoopPrompt } from "@/lib/loops/prompts";
import {
  badRequestResponse,
  notFoundResponse,
  parseBody,
  scheduleLogFlush,
} from "@/lib/route-utils";
import {
  COMMAND_MAP,
  checkBackendMismatch,
  resolveEvaluateCodeBranchForRunLoop,
  resolveLoopContext,
  resolveRunLoopComputeTarget,
} from "./run-loop-helpers";
import { resolveEffectiveSignedRunLoopIntent } from "./signing";
import { runLoopSchema } from "./validators";

/**
 * ISS-5708: this route now awaits the relay/ECS dispatch before answering, so
 * it can genuinely outlive a default serverless ceiling when a compute target
 * is slow to take the command. `postRunLoop` calls it on the client's default
 * 60s deadline (`DEFAULT_API_TIMEOUT_MS`), and declaring the same ceiling here
 * is what makes that deadline meaningful — without it the platform can
 * terminate the function first and surface an opaque 504 instead of this
 * route's own classified dispatch failure. Keep the two in step.
 *
 * This value is also one half of the reap invariant: while this request runs,
 * its Loop row is legitimately PENDING, and `reapStalePendingLoops` must not
 * declare it orphaned. `STALE_PENDING_THRESHOLD_MS` is derived from
 * `LAUNCH_REQUEST_BUDGET_SECONDS` for exactly that reason. Written as a literal
 * because Next.js route-segment config must be statically analysable, so a
 * test asserts `maxDuration === LAUNCH_REQUEST_BUDGET_SECONDS` rather than the
 * type system enforcing it — change one, change the other.
 */
export const maxDuration = 60;

type RunLoopResponse =
  | CreateLoopResponse
  | ComputeTargetConflictBody
  | ComputePreferenceRequiredBody
  | BackendMismatchBody
  | LoopAlreadyActiveBody;

export const POST = withAnyAuth<RunLoopResponse, "/documents/[id]/run-loop">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const documentId = await resolveDocumentId(id, user.organizationId);
      if (!documentId) {
        return notFoundResponse("Document");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        runLoopSchema
      );
      if (!body) {
        return parseError;
      }

      const artifact =
        await documentGenerationService.findWithRegenerationContext(
          documentId,
          user.organizationId
        );
      if (!artifact) {
        return notFoundResponse("Document");
      }

      const handler = getCommandHandler(COMMAND_MAP[body.command]);

      // Fail closed for the dark-launched `request_prd_changes` command: the
      // PRD editor hides its menu item behind the `prd-request-changes` flag,
      // but a stale client or a direct API call could otherwise dispatch the
      // mutation. Every other command passes through untouched.
      const prdRequestChangesGate = await enforcePrdRequestChangesGate(
        body.command,
        { clerkUserId: user.clerkId, userId: user.id }
      );
      if (prdRequestChangesGate) {
        return prdRequestChangesGate;
      }

      const explicitSelectionGate =
        await buildMissingExplicitPreferenceResponse({
          clerkUserId: user.clerkId,
          computeTargetId: body.computeTargetId,
          userId: user.id,
        });
      if (explicitSelectionGate.response) {
        return explicitSelectionGate.response;
      }

      const ctRouteResult = await resolveRunLoopComputeTarget(
        user.organizationId,
        user.id,
        body.computeTargetId,
        explicitSelectionGate.userComputePreferences
      );
      if ("errorResponse" in ctRouteResult) {
        return ctRouteResult.errorResponse;
      }
      const { computeTargetId: resolvedComputeTargetId } = ctRouteResult;

      // Cloud only, and deliberately ahead of `loopsService.create`. The
      // dispatch below is awaited now (ISS-5708), so a missing key would be
      // reported either way — but only this pre-flight avoids creating a Loop
      // row that exists solely to be cancelled a moment later.
      const missingKeyResponse = await buildMissingAnthropicApiKeyResponse({
        resolvedComputeTargetId,
        userId: user.id,
        organizationId: user.organizationId,
      });
      if (missingKeyResponse) {
        return missingKeyResponse;
      }

      const signedIntentResult = await resolveEffectiveSignedRunLoopIntent({
        computeTargetId: resolvedComputeTargetId,
        requesterUserId: user.id,
        requesterOrganizationId: user.organizationId,
        requesterClerkUserId: user.clerkId,
        documentId,
        body,
      });
      if (!signedIntentResult.ok) {
        return signedIntentResult.response;
      }
      const effectiveSignedUserIntent = signedIntentResult.userIntentSignature;

      const {
        targetRepo,
        targetBranch: resolvedTargetBranch,
        contextRefs,
        parentLoopId,
        parentLoopComputeTargetId,
        additionalRepos: resolvedAdditionalRepos,
      } = await resolveLoopContext(
        artifact,
        body,
        handler,
        user.organizationId,
        user.id,
        documentId,
        resolvedComputeTargetId
      );

      let targetBranch = resolvedTargetBranch;

      if (handler?.requiresRepo && !targetRepo) {
        return badRequestResponse(
          "No repository configured. Link a repository to the project or set a target repo on the artifact."
        );
      }

      const evaluateBranchResult = await resolveEvaluateCodeBranchForRunLoop(
        body.command,
        documentId,
        user.organizationId,
        targetRepo,
        targetBranch
      );
      if (!evaluateBranchResult.ok) {
        return evaluateBranchResult.response;
      }
      targetBranch = evaluateBranchResult.branch;

      // Guard: detect backend mismatch for state-dependent commands.
      // When the resolved compute target differs from the one used by the
      // artifact's last completed loop, resuming would corrupt incremental
      // state. Callers may override with backendOverride: true when they
      // have confirmed the switch is intentional.
      if (handler?.requiresParent && !body.backendOverride) {
        const mismatch = await checkBackendMismatch(
          documentId,
          user.organizationId,
          resolvedComputeTargetId,
          parentLoopComputeTargetId
        );
        if (mismatch) {
          return mismatch;
        }
      }

      const command = COMMAND_MAP[body.command];
      const prompt = buildLoopPrompt(
        command,
        body.prompt,
        resolvedAdditionalRepos
      );

      const harness = await resolveLaunchHarness(
        resolvedComputeTargetId,
        user.organizationId,
        {
          clerkUserId: user.clerkId,
          userId: user.id,
        }
      );

      const loopResponse = await loopsService.create(
        user.organizationId,
        user.id,
        {
          command,
          harness,
          documentId,
          parentLoopId,
          computeTargetId: resolvedComputeTargetId,
          prompt,
          repo: targetRepo
            ? { fullName: targetRepo, branch: targetBranch }
            : undefined,
          additionalRepos: resolvedAdditionalRepos,
          contextRefs: contextRefs.length > 0 ? contextRefs : undefined,
        }
      );

      // ISS-5708: await the dispatch instead of fire-and-forget. The browser
      // reads a `{ loopId, status }` body as `launched` and navigates, so
      // answering before the relay has taken the command turned every
      // post-acceptance failure into a silent no-op ending on a blank
      // artifact. `launchPlanLoop` already awaits for the same reason; desktop
      // context-pack building plus relay dispatch is typically <5 seconds.
      const dispatchResult = await dispatchAndClassify(
        loopResponse.loopId,
        user.organizationId,
        "run-loop",
        { computeTargetId: resolvedComputeTargetId, documentId },
        effectiveSignedUserIntent
          ? {
              desktopUserIntentSignature: {
                commandId: effectiveSignedUserIntent.commandId,
                signature: effectiveSignedUserIntent.signature,
                signaturePayload: effectiveSignedUserIntent.signaturePayload,
                publicKeyFingerprint:
                  effectiveSignedUserIntent.publicKeyFingerprint,
                body: effectiveSignedUserIntent.body as JsonValue,
              },
            }
          : undefined
      );
      if (!dispatchResult.ok) {
        // `launchLoop` drives the row to a terminal status on its way out
        // (FAILED with a LAUNCH_FAILED error since ISS-5711, plus a re-read to
        // confirm it landed), so the failure is durable server-side and this
        // only stops the browser being told the opposite. Not an unconditional
        // guarantee: if that write also fails, `launchLoop` logs
        // `loop.launch_failure_not_durable` and the row is left for
        // `reapStalePendingLoops`. The response is the same 502 either way —
        // there is nothing better to tell a browser whose launch failed — but
        // that log, not this branch, is what an operator should page on.
        scheduleLogFlush();
        return dispatchFailureResponse(
          dispatchResult.error,
          dispatchTargetKindFor(resolvedComputeTargetId)
        );
      }

      scheduleLogFlush();
      return NextResponse.json(success(loopResponse));
    } catch (error) {
      return handleLoopServiceError(error, "Failed to run loop");
    }
  }
);

/**
 * Resolves the harness a loop should launch with, enforcing the
 * harness-selection rollback at this consumer boundary. The flag gates only the
 * picker UI, but a persisted harness (a ComputeTarget's `selectedHarness` for
 * Local, or `User.preferredHarness` for Cloud) outlives a flag-off rollback —
 * so when the flag is off for the requesting user, a value saved during a
 * flag-on session is coerced to the default harness (`parseSelectedHarness(null)`)
 * rather than launched.
 *
 * Local: a resolved compute target supplies its per-row `selectedHarness`.
 * Cloud: no compute target resolves (`cloud_resolved`), so the user-scoped
 * `preferredHarness` is read instead. Returns undefined only when a resolved
 * target cannot be found.
 */
async function resolveLaunchHarness(
  resolvedComputeTargetId: string | null | undefined,
  organizationId: string,
  identity: HarnessSelectionIdentity
): Promise<HarnessType | undefined> {
  const harnessSelectionEnabled = await isHarnessSelectionEnabled(identity);

  if (!resolvedComputeTargetId) {
    const preferredHarness = await computePreferenceService.getPreferredHarness(
      identity.userId,
      organizationId
    );
    return parseSelectedHarness(
      harnessSelectionEnabled ? preferredHarness : null
    );
  }

  const resolvedComputeTarget = await computeTargetsService.findById(
    resolvedComputeTargetId
  );
  if (!resolvedComputeTarget) {
    return undefined;
  }
  return parseSelectedHarness(
    harnessSelectionEnabled ? resolvedComputeTarget.selectedHarness : null
  );
}
