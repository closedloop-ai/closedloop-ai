import "server-only";

import { analytics } from "@repo/analytics/server";
import {
  BranchViewLocalErrorCode,
  BranchViewLocalHeader,
  isBranchViewLocalGatewayPath,
  resolveBranchViewLocalOperationId,
} from "@repo/api/src/types/branch-view-local";
import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import type {
  CreateDesktopCommandInput,
  RelayOperationDispatchRequest,
} from "@repo/api/src/types/compute-target";
import { withDb } from "@repo/database";
import { normalizeGitHubLogin } from "@/app/comments/external-authors";
import { computeTargetsService } from "@/app/compute-targets/service";
import { usersService } from "@/app/users/service";
import { resolvePrContext } from "@/lib/resolve-pr-context";
import { isRecord } from "@/lib/type-guards";

export type BranchViewLocalAccessInput = {
  userId: string;
  organizationId: string;
  computeTargetId: string;
  externalLinkId: string;
  repoFullName: string;
  headBranch: string;
  prNumber: number;
  operationPath: string;
};

export type BranchViewLocalAccessResult =
  | {
      ok: true;
      metadataHeaders: Record<string, string>;
    }
  | {
      ok: false;
      status: number;
      code: BranchViewLocalErrorCode;
      error: string;
    };

type StoredCommandPayload = {
  computeTargetId: string;
  requestPayload: unknown;
} | null;

/**
 * Validates the API-owned Branch View author proof for local-content Desktop
 * commands and returns non-secret metadata that event replay routes can recheck.
 */
export async function validateBranchViewLocalAccess(
  input: BranchViewLocalAccessInput
): Promise<BranchViewLocalAccessResult> {
  const operationId = resolveBranchViewLocalOperationId(input.operationPath);
  if (!operationId) {
    return deny(403, BranchViewLocalErrorCode.AuthorizationRequired);
  }

  const user = await usersService.findById(input.userId, input.organizationId);
  if (!user?.active) {
    return deny(403, BranchViewLocalErrorCode.AuthorizationRequired);
  }

  const flagEnabled = await isBranchPrEnabled(input.userId);
  if (!flagEnabled) {
    return deny(403, BranchViewLocalErrorCode.FeatureDisabled);
  }

  const ctx = await resolvePrContext(
    input.externalLinkId,
    input.organizationId
  );
  if (!ctx) {
    return deny(403, BranchViewLocalErrorCode.StaleProof);
  }

  const authorLogin = ctx.externalLink.createdBy?.githubUsername;
  if (
    !(
      authorLogin &&
      user.githubUsername &&
      normalizeGitHubLogin(authorLogin) ===
        normalizeGitHubLogin(user.githubUsername)
    )
  ) {
    return deny(403, BranchViewLocalErrorCode.NotAuthor);
  }

  const expectedRepo = `${ctx.owner}/${ctx.repo}`;
  const expectedPrNumber = ctx.gitHubPullRequest?.number ?? ctx.pullNumber;
  const expectedHeadBranch =
    ctx.branch?.branchName ?? ctx.gitHubPullRequest?.headBranch ?? null;
  if (
    normalizeRepo(input.repoFullName) !== normalizeRepo(expectedRepo) ||
    input.headBranch !== expectedHeadBranch ||
    input.prNumber !== expectedPrNumber
  ) {
    return deny(403, BranchViewLocalErrorCode.ContextMismatch);
  }

  const target = await computeTargetsService.findAccessibleById(
    input.computeTargetId,
    input.organizationId,
    input.userId
  );
  if (!target) {
    return deny(403, BranchViewLocalErrorCode.ComputeTargetForbidden);
  }
  if (!target.isOnline) {
    return deny(503, BranchViewLocalErrorCode.ComputeTargetOffline);
  }

  return {
    ok: true,
    metadataHeaders: {
      [BranchViewLocalHeader.Operation]: "1",
      [BranchViewLocalHeader.ExternalLinkId]: input.externalLinkId,
      [BranchViewLocalHeader.RepoFullName]: expectedRepo,
      [BranchViewLocalHeader.HeadBranch]: input.headBranch,
      [BranchViewLocalHeader.PrNumber]: String(input.prNumber),
      [BranchViewLocalHeader.AuthorizedUserId]: input.userId,
      [BranchViewLocalHeader.AuthorizedOrgId]: input.organizationId,
    },
  };
}

export function classifyBranchViewLocalCommand(
  input: CreateDesktopCommandInput | RelayOperationDispatchRequest
): boolean {
  if ("path" in input) {
    return isBranchViewLocalGatewayPath(input.path);
  }
  const params = isRecord(input.params) ? input.params : {};
  const request = isRecord(params.request) ? params.request : {};
  const path = typeof request.path === "string" ? request.path : null;
  return Boolean(path && isBranchViewLocalGatewayPath(path));
}

export function stampBranchViewLocalCommandMetadata(
  input: CreateDesktopCommandInput,
  metadataHeaders: Record<string, string>
): CreateDesktopCommandInput {
  return {
    ...input,
    headers: {
      ...input.headers,
      ...metadataHeaders,
    },
  };
}

export async function authorizeBranchViewLocalEventRead(input: {
  commandId: string;
  computeTargetId: string;
  userId: string;
  organizationId: string;
}): Promise<BranchViewLocalAccessResult> {
  const command = await loadStoredCommandPayload(input.commandId);
  if (!command) {
    return deny(404, BranchViewLocalErrorCode.AuthorizationRequired);
  }
  if (command.computeTargetId !== input.computeTargetId) {
    return deny(403, BranchViewLocalErrorCode.ContextMismatch);
  }
  const payload = isRecord(command.requestPayload)
    ? (command.requestPayload as JsonObject)
    : {};
  const headers = readHeaders(payload.headers);
  if (headers[BranchViewLocalHeader.Operation] !== "1") {
    return { ok: true, metadataHeaders: {} };
  }
  const externalLinkId = headers[BranchViewLocalHeader.ExternalLinkId];
  const repoFullName = headers[BranchViewLocalHeader.RepoFullName];
  const headBranch = headers[BranchViewLocalHeader.HeadBranch];
  const prNumber = Number(headers[BranchViewLocalHeader.PrNumber]);
  const authorizedUserId = headers[BranchViewLocalHeader.AuthorizedUserId];
  const authorizedOrgId = headers[BranchViewLocalHeader.AuthorizedOrgId];
  const path = typeof payload.path === "string" ? payload.path : "";

  if (
    !(
      externalLinkId &&
      repoFullName &&
      headBranch &&
      Number.isInteger(prNumber) &&
      authorizedUserId === input.userId &&
      authorizedOrgId === input.organizationId
    )
  ) {
    return deny(403, BranchViewLocalErrorCode.StaleProof);
  }

  return validateBranchViewLocalAccess({
    userId: input.userId,
    organizationId: input.organizationId,
    computeTargetId: input.computeTargetId,
    externalLinkId,
    repoFullName,
    headBranch,
    prNumber,
    operationPath: path,
  });
}

export async function isStoredBranchViewLocalCommand(input: {
  commandId: string;
  computeTargetId: string;
}): Promise<boolean> {
  const command = await loadStoredCommandPayload(input.commandId);
  if (!command || command.computeTargetId !== input.computeTargetId) {
    return false;
  }
  const payload = isRecord(command.requestPayload)
    ? (command.requestPayload as JsonObject)
    : {};
  const headers = readHeaders(payload.headers);
  return headers[BranchViewLocalHeader.Operation] === "1";
}

function readHeaders(value: JsonValue | undefined): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

async function loadStoredCommandPayload(
  commandId: string
): Promise<StoredCommandPayload> {
  return await withDb((db) =>
    db.desktopCommand.findUnique({
      where: { id: commandId },
      select: { computeTargetId: true, requestPayload: true },
    })
  );
}

async function isBranchPrEnabled(userId: string): Promise<boolean> {
  if (typeof analytics.isFeatureEnabled !== "function") {
    return false;
  }
  try {
    return (await analytics.isFeatureEnabled("branch-pr", userId)) === true;
  } catch {
    return false;
  }
}

function normalizeRepo(fullName: string): string {
  return fullName.trim().toLowerCase();
}

function deny(
  status: number,
  code: BranchViewLocalErrorCode
): Extract<BranchViewLocalAccessResult, { ok: false }> {
  return {
    ok: false,
    status,
    code,
    error: code,
  };
}
