import { BranchStatus } from "@repo/api/src/types/branch";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github";
import { z } from "zod";
import type { BranchCloudHydrationOverlay } from "../desktop-cloud-github-hydration.js";
import type { DesktopPrisma } from "./prisma-client.js";

const cloudGithubBranchOverlaySchema = z
  .object({
    baseBranch: z.string().nullable().optional(),
    owner: z.string().nullable().optional(),
    status: z.enum(BranchStatus).optional(),
    prNumber: z.number().int().nullable().optional(),
    prTitle: z.string().nullable().optional(),
    prState: z.enum(GitHubPRState).nullable().optional(),
    prUrl: z.string().nullable().optional(),
    additions: z.number().nullable().optional(),
    deletions: z.number().nullable().optional(),
    filesChanged: z.number().nullable().optional(),
    checksStatus: z.enum(ChecksStatus).nullable().optional(),
    reviewDecision: z.enum(ReviewDecision).nullable().optional(),
    lastActivityAt: z.string().optional(),
  })
  .strict();

type StoredCloudGithubBranchOverlay = z.infer<
  typeof cloudGithubBranchOverlaySchema
>;

type CloudGithubBranchOverlayWriteRow = {
  identityKey: string;
  repoFullName: string;
  branchName: string;
  overlay: CloudGithubBranchOverlayJson;
  lastSyncedAt: string;
};

type CloudGithubBranchOverlayJson = Record<string, string | number | null>;

export const cloudGithubOverlayReadArgsSchema = z.tuple([
  z.string(),
  z.array(z.string()),
]);

export const cloudGithubOverlayWriteArgsSchema = z.tuple([
  z.string(),
  z.array(z.string()),
  z.record(z.string(), cloudGithubBranchOverlaySchema),
  z.string(),
]);

/** Validate an IPC/store result before handing cloud overlays to hydration. */
export function parseCloudGithubBranchOverlayMap(
  value: unknown
): Record<string, BranchCloudHydrationOverlay> {
  return z.record(z.string(), cloudGithubBranchOverlaySchema).parse(value);
}

/** Read persisted cloud overlays for the requested identity/repository set. */
export async function readCloudGithubBranchOverlays(
  prisma: DesktopPrisma,
  identityKey: string,
  repoNames: readonly string[]
): Promise<Record<string, BranchCloudHydrationOverlay>> {
  const uniqueRepoNames = uniqueNonEmpty(repoNames);
  if (uniqueRepoNames.length === 0) {
    return {};
  }

  const rows = await prisma.read((reader) =>
    reader.cloudGithubBranchOverlay.findMany({
      where: {
        identityKey,
        repoFullName: { in: uniqueRepoNames },
      },
      select: {
        repoFullName: true,
        branchName: true,
        overlay: true,
      },
    })
  );
  const overlays: Record<string, BranchCloudHydrationOverlay> =
    Object.create(null);
  for (const row of rows) {
    const parsed = cloudGithubBranchOverlaySchema.safeParse(row.overlay);
    if (!parsed.success) {
      continue;
    }
    overlays[cloudOverlayKey(row.repoFullName, row.branchName)] = parsed.data;
  }
  return overlays;
}

/**
 * Merge cloud overlays returned by the current refresh.
 *
 * The cloud branch/PR endpoints are page-limited, so absence from one refresh is
 * not authoritative. Preserve previously stored overlays until a returned row
 * updates them.
 */
export async function writeCloudGithubBranchOverlays(
  prisma: DesktopPrisma,
  identityKey: string,
  repoNames: readonly string[],
  overlays: Record<string, BranchCloudHydrationOverlay>,
  lastSyncedAt: string
): Promise<void> {
  const uniqueRepoNames = uniqueNonEmpty(repoNames);
  if (uniqueRepoNames.length === 0) {
    return;
  }
  const repoNameSet = new Set(uniqueRepoNames);
  const rows = overlayRowsForWrite(
    identityKey,
    repoNameSet,
    overlays,
    lastSyncedAt
  );

  await prisma.write((client) =>
    client.$transaction(async (tx) => {
      if (rows.length === 0) {
        return;
      }
      await Promise.all(
        rows.map((row) =>
          tx.cloudGithubBranchOverlay.upsert({
            where: {
              identityKey_repoFullName_branchName: {
                identityKey: row.identityKey,
                repoFullName: row.repoFullName,
                branchName: row.branchName,
              },
            },
            create: row,
            update: {
              overlay: row.overlay,
              lastSyncedAt: row.lastSyncedAt,
            },
          })
        )
      );
    })
  );
}

function overlayRowsForWrite(
  identityKey: string,
  repoNames: ReadonlySet<string>,
  overlays: Record<string, BranchCloudHydrationOverlay>,
  lastSyncedAt: string
): CloudGithubBranchOverlayWriteRow[] {
  const rows: CloudGithubBranchOverlayWriteRow[] = [];
  for (const [key, overlay] of Object.entries(overlays)) {
    const identity = parseCloudOverlayKey(key);
    if (!(identity && repoNames.has(identity.repoFullName))) {
      continue;
    }
    const parsed = cloudGithubBranchOverlaySchema.safeParse(overlay);
    if (!parsed.success) {
      continue;
    }
    rows.push({
      identityKey,
      repoFullName: identity.repoFullName,
      branchName: identity.branchName,
      overlay: toJsonOverlay(parsed.data),
      lastSyncedAt,
    });
  }
  return rows;
}

function toJsonOverlay(
  overlay: StoredCloudGithubBranchOverlay
): CloudGithubBranchOverlayJson {
  const json: CloudGithubBranchOverlayJson = {};
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined) {
      json[key] = value;
    }
  }
  return json;
}

function parseCloudOverlayKey(
  key: string
): { repoFullName: string; branchName: string } | null {
  const separatorIndex = key.indexOf("::");
  if (separatorIndex <= 0 || separatorIndex === key.length - 2) {
    return null;
  }
  return {
    repoFullName: key.slice(0, separatorIndex),
    branchName: key.slice(separatorIndex + 2),
  };
}

function cloudOverlayKey(repoFullName: string, branchName: string): string {
  return `${repoFullName}::${branchName}`;
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}
