import { createHash } from "node:crypto";
import { BRANCH_NAME_MAX_LENGTH } from "@repo/api/src/types/artifact";
import { type AdditionalRepoRef, LoopCommand } from "@repo/api/src/types/loop";
import {
  type LoopBranchMaterializationEntry,
  type LoopBranchMaterializationEnvelope,
  LoopBranchMaterializationRole,
} from "@repo/api/src/types/loop-body";
import { BRANCH_NAME_REGEX } from "@closedloop-ai/loops-api/execution-result";
import {
  getMultiRepoPolicy,
  PeerWriteMode,
} from "@closedloop-ai/loops-api/multi-repo-policy";
import { z } from "zod";

type BranchRepoRef = {
  fullName: string;
  branch: string;
};

const SLUG_INVALID_CHARS_REGEX = /[^a-z0-9-]+/g;
const SLUG_REPEATED_DASHES_REGEX = /-+/g;
const SLUG_TRIM_DASHES_REGEX = /^-+|-+$/g;
const BRANCH_HASH_SEPARATOR = "\0";
const BRANCH_SLUG_MAX_LENGTH = 50;

export const branchMaterializationEntrySchema = z
  .object({
    role: z.enum(LoopBranchMaterializationRole),
    repositoryFullName: z.string().trim().min(1),
    baseBranch: z
      .string()
      .trim()
      .min(1)
      .max(BRANCH_NAME_MAX_LENGTH)
      .regex(BRANCH_NAME_REGEX),
    branchName: z
      .string()
      .trim()
      .min(1)
      .max(BRANCH_NAME_MAX_LENGTH)
      .regex(BRANCH_NAME_REGEX),
  })
  .strict();

export const branchMaterializationEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    branches: z.array(branchMaterializationEntrySchema).min(1),
  })
  .strict();

/**
 * Build the server-owned branch materialization envelope consumed by Desktop
 * and later enforced by the branch-artifact callback route.
 *
 * Returns null for commands that produce no writes to any repo (e.g. GENERATE_PRD,
 * REQUEST_PRD_CHANGES). Peer repos are omitted when the command's peerWriteMode is
 * ReadOnly (e.g. PLAN). The caller is responsible for skipping metadata persistence
 * when null is returned.
 */
export function buildLoopBranchMaterialization(input: {
  command: LoopCommand;
  loopId: string;
  documentSlug?: string | null;
  primaryRepo: BranchRepoRef;
  additionalRepos?: AdditionalRepoRef[];
}): LoopBranchMaterializationEnvelope | null {
  const commandKey = buildCommandKey({
    command: input.command,
    documentSlug: input.documentSlug,
    loopId: input.loopId,
  });
  const branches: LoopBranchMaterializationEntry[] = [];

  if (commandWritesPrimaryRepo(input.command)) {
    branches.push({
      role: LoopBranchMaterializationRole.Primary,
      repositoryFullName: input.primaryRepo.fullName,
      baseBranch: input.primaryRepo.branch,
      branchName: validateBranchName(`symphony/${commandKey}`),
    });
  }

  if (
    getMultiRepoPolicy(input.command).peerWriteMode === PeerWriteMode.ReadWrite
  ) {
    for (const repo of input.additionalRepos ?? []) {
      const repoSlug = repoSlugForBranch(repo.fullName);
      const hash = createHash("sha1")
        .update(`${repo.fullName}${BRANCH_HASH_SEPARATOR}${repo.branch}`)
        .digest("hex")
        .slice(0, 8);
      branches.push({
        role: LoopBranchMaterializationRole.Additional,
        repositoryFullName: repo.fullName,
        baseBranch: repo.branch,
        branchName: validateBranchName(
          `symphony/${commandKey}-${repoSlug}-${hash}`
        ),
      });
    }
  }

  if (branches.length === 0) {
    return null;
  }

  return { schemaVersion: 1, branches };
}

function buildCommandKey({
  command,
  documentSlug,
  loopId,
}: {
  command: LoopCommand;
  documentSlug?: string | null;
  loopId: string;
}): string {
  const documentKey = documentKeyForBranch({ documentSlug, loopId });
  switch (command) {
    case LoopCommand.GeneratePrd:
      return `generate-prd-${documentKey}`;
    case LoopCommand.RequestPrdChanges:
      return `request-prd-changes-${documentKey}`;
    case LoopCommand.Plan:
    case LoopCommand.Execute:
    case LoopCommand.RequestChanges:
      return documentKey;
    default:
      return documentKey;
  }
}

function documentKeyForBranch({
  documentSlug,
  loopId,
}: {
  documentSlug?: string | null;
  loopId: string;
}): string {
  const slug = slugForBranch(documentSlug ?? "");
  if (slug) {
    return slug;
  }
  const loopSlug = slugForBranch(loopId);
  if (!loopSlug) {
    throw new Error(
      "Cannot generate branch name without documentSlug or loopId"
    );
  }
  return `loop-${loopSlug}`;
}

function slugForBranch(value: string): string | null {
  const slug = value
    .toLowerCase()
    .replace(SLUG_INVALID_CHARS_REGEX, "-")
    .replace(SLUG_REPEATED_DASHES_REGEX, "-")
    .replace(SLUG_TRIM_DASHES_REGEX, "")
    .slice(0, BRANCH_SLUG_MAX_LENGTH)
    .replace(SLUG_TRIM_DASHES_REGEX, "");
  return slug || null;
}

function repoSlugForBranch(value: string): string {
  return slugForBranch(value) ?? "unknown";
}

function validateBranchName(branchName: string): string {
  if (
    branchName.length > BRANCH_NAME_MAX_LENGTH ||
    !BRANCH_NAME_REGEX.test(branchName)
  ) {
    throw new Error(`Generated branch name is invalid: ${branchName}`);
  }
  return branchName;
}

function commandWritesPrimaryRepo(command: LoopCommand): boolean {
  return (
    command === LoopCommand.Plan ||
    command === LoopCommand.Execute ||
    command === LoopCommand.RequestChanges
  );
}
