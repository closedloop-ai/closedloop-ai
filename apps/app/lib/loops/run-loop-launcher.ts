"use client";

import type { JsonValue } from "@repo/api/src/types/common";
import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import type {
  AdditionalRepoRef,
  CreateLoopRequest,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import {
  hasEffectiveCommandSigningSupport,
  signDesktopCommand,
} from "@/lib/desktop-command-signing/command-signer";
import { getCachedComputeTargetForSigning } from "@/lib/desktop-command-signing/compute-target-signing-cache";

type ApiPostClient = {
  post<T>(path: string, body?: unknown): Promise<T>;
};

/**
 * Browser run-loop launch contract. The `computeTargetId` field deliberately
 * preserves omitted, explicit null, and string values because the API treats
 * those wire states differently.
 */
export type RunLoopLaunchInput = {
  documentId: string;
  command: RunLoopCommand;
  prompt?: string;
  computeTargetId?: string | null;
  backendOverride?: boolean;
  repo?: CreateLoopRequest["repo"];
  additionalRepos?: AdditionalRepoRef[];
};

type RunLoopRequestBody = {
  command: RunLoopCommand;
  prompt?: string;
  computeTargetId?: string | null;
  backendOverride?: boolean;
  repo?: CreateLoopRequest["repo"];
  additionalRepos?: AdditionalRepoRef[];
  userIntentSignature?: {
    commandId: string;
    signature: string;
    signaturePayload: string;
    publicKeyFingerprint: string;
    body: JsonValue;
  };
};

/**
 * Posts to the document-scoped run-loop endpoint using the shared body,
 * namespace, and signing construction used by initial launches and target
 * replays.
 */
export async function postRunLoop<T>(
  apiClient: ApiPostClient,
  input: RunLoopLaunchInput
): Promise<T> {
  const requestBody = await buildRunLoopRequestBody(input);
  return apiClient.post<T>(
    `/documents/${input.documentId}/run-loop`,
    requestBody
  );
}

/**
 * Builds the exact run-loop body and signs it when a local target with effective
 * signing support is present. Omitted, null, and string `computeTargetId`
 * values are intentionally preserved because they have distinct wire meaning.
 */
export async function buildRunLoopRequestBody({
  documentId,
  command,
  prompt,
  computeTargetId,
  backendOverride,
  repo,
  additionalRepos,
}: RunLoopLaunchInput): Promise<RunLoopRequestBody> {
  const requestBody: RunLoopRequestBody = {
    command,
    ...(prompt === undefined ? {} : { prompt }),
    ...(computeTargetId === undefined ? {} : { computeTargetId }),
    ...(backendOverride ? { backendOverride } : {}),
    ...(repo ? { repo } : {}),
    ...(additionalRepos ? { additionalRepos } : {}),
  };

  const signingTarget = resolveSigningTarget(computeTargetId);
  if (signingTarget && hasEffectiveCommandSigningSupport(signingTarget)) {
    const userIntent = {
      documentId,
      ...requestBody,
    } satisfies JsonValue;
    const signed = await signDesktopCommand(
      {
        method: "POST",
        pathWithQuery: "/api/gateway/symphony/loop",
        body: userIntent,
      },
      signingTarget
    );
    requestBody.userIntentSignature = {
      commandId: signed.commandId,
      signature: signed.signature,
      signaturePayload: signed.signaturePayload,
      publicKeyFingerprint: signed.publicKeyFingerprint,
      body: userIntent,
    };
  }

  return requestBody;
}

function resolveSigningTarget(
  computeTargetId: string | null | undefined
): ComputeTarget | null {
  return typeof computeTargetId === "string"
    ? getCachedComputeTargetForSigning(computeTargetId)
    : null;
}
