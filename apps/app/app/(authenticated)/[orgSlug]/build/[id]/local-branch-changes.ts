import { FileChangeStatus } from "@repo/api/src/types/branch-view";
import {
  BranchViewLocalErrorCode,
  BranchViewLocalGatewayPath,
} from "@repo/api/src/types/branch-view-local";
import type { JsonValue } from "@repo/api/src/types/common";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { z } from "zod";
import {
  hasEffectiveCommandSigningSupport,
  signDesktopCommand,
} from "@/lib/desktop-command-signing/command-signer";
import { getCachedComputeTargetForSigning } from "@/lib/desktop-command-signing/compute-target-signing-cache";
import {
  COMMAND_ID_HEADER,
  COMMAND_PUBLIC_KEY_FINGERPRINT_HEADER,
  COMMAND_SIGNATURE_HEADER,
  COMMAND_SIGNATURE_PAYLOAD_HEADER,
  COMPUTE_TARGET_HEADER,
} from "@/lib/desktop-command-signing/constants";
import type { BranchViewFile, BranchViewFileDiff } from "./types";

export type BranchLocalRouting = {
  mode: EngineerRoutingMode;
  computeTargetId: string | null;
};

export type BranchLocalIdentity = {
  externalLinkId: string;
  repoPath: string;
  repoFullName: string;
  headBranch: string;
  prNumber: number;
  routing: BranchLocalRouting;
};

type BranchWorktreeResponse = {
  path: string | null;
  repoPath: string | null;
};

const desktopLocalFileSchema = z
  .object({
    additions: z.number().optional(),
    deletions: z.number().optional(),
    path: z.string(),
    previousPath: z.string().nullable().optional(),
    status: z.string(),
  })
  .passthrough();

const branchLocalChangesResponseSchema = z
  .object({
    files: z.array(desktopLocalFileSchema).optional(),
  })
  .passthrough();

const branchViewFileDiffSchema = z
  .object({
    isBinary: z.boolean(),
    isDeleted: z.boolean(),
    isNew: z.boolean(),
    newContent: z.string(),
    oldContent: z.string(),
    path: z.string(),
  })
  .passthrough();

type DesktopLocalFile = z.infer<typeof desktopLocalFileSchema>;

const LocalStatus = {
  Added: "added",
  Modified: "modified",
  Removed: "removed",
  Renamed: "renamed",
  Copied: "copied",
} as const;

/**
 * Resolves the Desktop-owned PR worktree. Local file state remains ephemeral
 * Desktop state and is not persisted in the Branch View API projection.
 */
export async function fetchBranchWorktree(params: {
  repoFullName: string;
  headBranch: string;
  prNumber: number;
}): Promise<BranchWorktreeResponse> {
  const searchParams = new URLSearchParams({
    repoFullName: params.repoFullName,
    headBranch: params.headBranch,
    prNumber: String(params.prNumber),
  });
  const response = await fetch(
    `/api/gateway/git/branch-worktree?${searchParams.toString()}`
  );
  if (!response.ok) {
    if (response.status === 404) {
      return { path: null, repoPath: null };
    }
    throw new Error("Failed to resolve branch worktree");
  }
  const raw = (await response.json()) as Partial<BranchWorktreeResponse>;
  return {
    path: typeof raw.path === "string" ? raw.path : null,
    repoPath: typeof raw.repoPath === "string" ? raw.repoPath : null,
  };
}

export async function fetchBranchLocalChanges(
  input: BranchLocalIdentity
): Promise<BranchViewFile[]> {
  const params = new URLSearchParams({
    repoPath: input.repoPath,
    repoFullName: input.repoFullName,
    headBranch: input.headBranch,
    prNumber: String(input.prNumber),
  });
  const gatewayPathWithQuery = `${BranchViewLocalGatewayPath.List}?${params.toString()}`;
  const response = await fetch(
    `${localGatewayBase(input)}/git/local-changes?${params.toString()}`,
    await localFetchInit(input.routing, {
      method: "GET",
      gatewayPathWithQuery,
    })
  );
  const body = await parseJsonOnce(response);
  if (!response.ok) {
    throw normalizeLocalError(response, body);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return [];
  }
  const parsed = branchLocalChangesResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("invalid_local_changes_response");
  }
  const rawFiles = parsed.data.files ?? [];
  return rawFiles.map(mapDesktopFile);
}

export async function fetchBranchLocalDiff(
  input: BranchLocalIdentity & { path: string; previousPath?: string | null }
): Promise<BranchViewFileDiff> {
  const requestBody = {
    repoPath: input.repoPath,
    repoFullName: input.repoFullName,
    headBranch: input.headBranch,
    prNumber: String(input.prNumber),
    path: input.path,
    previousPath: input.previousPath ?? null,
  };
  const requestInit = await localFetchInit(input.routing, {
    method: "POST",
    gatewayPathWithQuery: BranchViewLocalGatewayPath.Diff,
    body: requestBody,
  });
  const response = await fetch(
    `${localGatewayBase(input)}/git/local-changes/diff`,
    {
      ...requestInit,
      method: "POST",
      headers: {
        ...Object.fromEntries(new Headers(requestInit.headers).entries()),
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    }
  );
  const body = await parseJsonOnce(response);
  if (!response.ok) {
    throw normalizeLocalError(response, body);
  }
  const parsed = branchViewFileDiffSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("invalid_local_diff_response");
  }
  return parsed.data satisfies BranchViewFileDiff;
}

export async function commitAndPushBranchLocalChanges(
  input: BranchLocalIdentity & { message: string }
): Promise<unknown> {
  const requestBody = {
    repoPath: input.repoPath,
    repoFullName: input.repoFullName,
    headBranch: input.headBranch,
    prNumber: String(input.prNumber),
    message: input.message,
  };
  const requestInit = await localFetchInit(input.routing, {
    method: "POST",
    gatewayPathWithQuery: BranchViewLocalGatewayPath.CommitPush,
    body: requestBody,
  });
  const response = await fetch(
    `${localGatewayBase(input)}/git/local-changes/commit-push`,
    {
      ...requestInit,
      method: "POST",
      headers: {
        ...Object.fromEntries(new Headers(requestInit.headers).entries()),
        "content-type": "application/json",
        "x-desktop-force-approval": "1",
        "x-desktop-approval-reason": `Commit and push local Branch View changes for ${input.repoFullName}#${input.prNumber}`,
      },
      body: JSON.stringify(requestBody),
    }
  );
  const body = await parseJsonOnce(response);
  if (!response.ok) {
    throw normalizeLocalError(response, body);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("invalid_local_commit_response");
  }
  return body;
}

function localGatewayBase(
  input: Pick<BranchLocalIdentity, "externalLinkId" | "routing">
): string {
  if (input.routing.mode === EngineerRoutingMode.CloudRelay) {
    return `/api/branch-view/${encodeURIComponent(input.externalLinkId)}/local-gateway`;
  }
  return "/api/gateway";
}

async function localFetchInit(
  routing: BranchLocalRouting,
  signingInput: {
    method: string;
    gatewayPathWithQuery: string;
    body?: JsonValue;
  }
): Promise<RequestInit> {
  if (
    routing.mode === EngineerRoutingMode.CloudRelay &&
    routing.computeTargetId
  ) {
    const headers = new Headers({
      [COMPUTE_TARGET_HEADER]: routing.computeTargetId,
    });
    const target = getCachedComputeTargetForSigning(routing.computeTargetId);
    if (target && hasEffectiveCommandSigningSupport(target)) {
      const signed = await signDesktopCommand(
        {
          method: signingInput.method,
          pathWithQuery: signingInput.gatewayPathWithQuery,
          body: signingInput.body,
        },
        target
      );
      headers.set(COMMAND_ID_HEADER, signed.commandId);
      headers.set(COMMAND_SIGNATURE_HEADER, signed.signature);
      headers.set(COMMAND_SIGNATURE_PAYLOAD_HEADER, signed.signaturePayload);
      headers.set(
        COMMAND_PUBLIC_KEY_FINGERPRINT_HEADER,
        signed.publicKeyFingerprint
      );
    }
    return { headers };
  }
  return {};
}

function mapDesktopFile(file: DesktopLocalFile): BranchViewFile {
  return {
    path: file.path,
    previousPath: file.previousPath ?? null,
    status: mapStatus(file.status),
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    patch: null,
  };
}

function mapStatus(status: string): FileChangeStatus {
  switch (status) {
    case LocalStatus.Added:
      return FileChangeStatus.Added;
    case LocalStatus.Removed:
      return FileChangeStatus.Removed;
    case LocalStatus.Renamed:
      return FileChangeStatus.Renamed;
    case LocalStatus.Copied:
      return FileChangeStatus.Copied;
    default:
      return FileChangeStatus.Modified;
  }
}

async function parseJsonOnce(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function normalizeLocalError(response: Response, body: unknown): Error {
  const record =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  let code = "local_changes_failed";
  if (response.status === 501 || response.status === 404) {
    code = BranchViewLocalErrorCode.UnsupportedDesktopVersion;
  }
  if (typeof record.code === "string") {
    code = record.code;
  }
  return new Error(code);
}
