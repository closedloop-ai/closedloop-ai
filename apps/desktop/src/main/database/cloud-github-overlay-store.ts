import { BranchStatus } from "@repo/api/src/types/branch";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  RepositoryDefaultReason,
  repositoryDefaultIdentityValidator,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { z } from "zod";
import { mergePersistedEligibilityOverlay } from "../cloud/desktop-cloud-github-eligibility-overlays.js";
import type { BranchCloudHydrationOverlay } from "../cloud/desktop-cloud-github-hydration.js";
import { boundedNonNegativeInt } from "./db-helpers.js";
import type { Prisma } from "./generated/client.js";
import type { DesktopPrisma } from "./prisma-client.js";

/**
 * Legacy pr-author key present in rows written by earlier builds. Accepted by
 * the persisted-row schema and stripped on read; not part of the current
 * overlay type.
 */
type LegacyCloudGithubOverlayKey = "owner";

/**
 * Field validators for the persisted overlay row, kept as a standalone literal
 * so the keys-covered guard can see them.
 *
 * `satisfies Record<keyof BranchCloudHydrationOverlay, z.ZodTypeAny>` is the
 * compile-time guard (FEA-3701, root AGENTS.md). This schema is `.strict()` and
 * reads rows written by an earlier build, so a field added to
 * `BranchCloudHydrationOverlay` and persisted without being taught here would
 * make the read reject the ENTIRE overlay row — every hydrated GitHub field on
 * that branch reverting to unhydrated, on every read, not just the new one.
 * `satisfies` turns that into a `tsc` failure instead.
 *
 * `owner` is deliberately EXTRA relative to the type: it is a legacy pr-author
 * key still present in stored rows, accepted here so those rows keep parsing
 * under `.strict()`, then stripped by the transform below. It is named in the
 * guard's key union rather than left implicit because `satisfies` DOES apply an
 * excess-property check to this object literal — an unnamed surplus key is a
 * `tsc` error, so the union is what lets the guard and the compatibility key
 * coexist while still failing on an untaught field.
 */
const persistedCloudGithubBranchOverlayShape = {
  baseBranch: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
  status: z.enum(BranchStatus).optional(),
  prNumber: z.number().int().nullable().optional(),
  prTitle: z.string().nullable().optional(),
  prState: z.enum(GitHubPRState).nullable().optional(),
  prUrl: z.string().nullable().optional(),
  mergedAt: z.string().nullable().optional(),
  additions: z.number().nullable().optional(),
  deletions: z.number().nullable().optional(),
  filesChanged: z.number().nullable().optional(),
  checksStatus: z.enum(ChecksStatus).nullable().optional(),
  reviewDecision: z.enum(ReviewDecision).nullable().optional(),
  lastActivityAt: z.string().optional(),
  headRepositoryProvider: z.enum(VcsProviderKind).optional(),
  headRepositoryProviderId: z.string().trim().min(1).optional(),
  headRepositoryFullName:
    repositoryDefaultIdentityValidator.shape.fullName.optional(),
  headRepositoryUnavailableReason: z.enum(RepositoryDefaultReason).optional(),
} satisfies Record<
  keyof BranchCloudHydrationOverlay | LegacyCloudGithubOverlayKey,
  z.ZodTypeAny
>;

const persistedCloudGithubBranchOverlaySchema = z
  .object(persistedCloudGithubBranchOverlayShape)
  .strict()
  .superRefine((overlay, context) => {
    const identityFieldCount = [
      overlay.headRepositoryProvider,
      overlay.headRepositoryProviderId,
      overlay.headRepositoryFullName,
    ].filter((value) => value !== undefined).length;
    if (identityFieldCount !== 0 && identityFieldCount !== 3) {
      context.addIssue({
        code: "custom",
        message: "PR-head repository identity must be complete or omitted",
        path: ["headRepositoryProvider"],
      });
    }
    if (
      identityFieldCount > 0 &&
      overlay.headRepositoryUnavailableReason !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "PR-head identity and unavailable reason are mutually exclusive",
        path: ["headRepositoryUnavailableReason"],
      });
    }
  });

const cloudGithubBranchOverlaySchema =
  persistedCloudGithubBranchOverlaySchema.transform(
    ({ owner: _legacyPrAuthor, ...overlay }) => overlay
  );

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

/**
 * ISS-5413: one PR artifact's diff stats as the cloud projection reports them,
 * ready to be written back onto the local `artifacts` row. All three counts are
 * required — see {@link cloudPrLocProjection}.
 */
type CloudPrLocProjection = {
  repoFullName: string;
  prNumber: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
};

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
  const { rows, locProjections } = overlayRowsForWrite(
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
        rows.map(async (row) => {
          const current = await tx.cloudGithubBranchOverlay.findUnique({
            where: {
              identityKey_repoFullName_branchName: {
                identityKey: row.identityKey,
                repoFullName: row.repoFullName,
                branchName: row.branchName,
              },
            },
            select: { overlay: true },
          });
          const overlay = preserveOmittedHeadRepositoryObservation(
            current?.overlay,
            row.overlay
          );
          return tx.cloudGithubBranchOverlay.upsert({
            where: {
              identityKey_repoFullName_branchName: {
                identityKey: row.identityKey,
                repoFullName: row.repoFullName,
                branchName: row.branchName,
              },
            },
            create: { ...row, overlay },
            update: {
              overlay,
              lastSyncedAt: row.lastSyncedAt,
            },
          });
        })
      );
      // ISS-5413: same fact, two homes — the overlay row the Branches page
      // reads, and the `artifacts` columns every local aggregate reads.
      await projectCloudPrLocOntoArtifacts(tx, locProjections);
    })
  );
}

function overlayRowsForWrite(
  identityKey: string,
  repoNames: ReadonlySet<string>,
  overlays: Record<string, BranchCloudHydrationOverlay>,
  lastSyncedAt: string
): {
  rows: CloudGithubBranchOverlayWriteRow[];
  locProjections: CloudPrLocProjection[];
} {
  const rows: CloudGithubBranchOverlayWriteRow[] = [];
  // Keyed by `<repo>#<prNumber>` so one PR is written once. `buildCloudOverlays`
  // keys by head ref and cannot emit the same PR twice, but this function is also
  // reached from the `cloudGithubOverlays.write` store op, whose `overlays` map is
  // arbitrary IPC input — deduping here keeps the write deterministic rather than
  // last-caller-wins.
  const locByPr = new Map<string, CloudPrLocProjection>();
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
    const projection = cloudPrLocProjection(identity.repoFullName, parsed.data);
    if (projection) {
      const prKey = `${projection.repoFullName}#${projection.prNumber}`;
      if (!locByPr.has(prKey)) {
        locByPr.set(prKey, projection);
      }
    }
  }
  return { rows, locProjections: [...locByPr.values()] };
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

/**
 * Preserve a validated additive PR-head observation when an older peer omits
 * it from an otherwise fresh overlay. A present identity or exact unavailable
 * reason replaces the previous alternative; the base repository is never used.
 */
function preserveOmittedHeadRepositoryObservation(
  currentValue: unknown,
  incoming: CloudGithubBranchOverlayJson
): CloudGithubBranchOverlayJson {
  const parsedIncoming = cloudGithubBranchOverlaySchema.safeParse(incoming);
  if (!parsedIncoming.success) {
    return incoming;
  }
  const current = cloudGithubBranchOverlaySchema.safeParse(currentValue);
  return toJsonOverlay(
    mergePersistedEligibilityOverlay(
      current.success ? current.data : undefined,
      parsedIncoming.data
    )
  );
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

/**
 * ISS-5413: read one overlay's PR diff stats as a writable projection, or null
 * when the cloud could not fully size that PR.
 *
 * The three counts are all-or-nothing on purpose. `lines_added` AND
 * `lines_removed` are required because a row is LOC-enriched only when both are
 * present (the `isLocEnrichedRow` rule the KLOC and median-PR-size populations
 * share), so writing one alone would mint a half-enriched row that reads as
 * sized while under-reporting its size. `files_changed` joins them because the
 * three travel together as one record: `sync-source.ts` reads them as a triple
 * and `COALESCE`s each to 0, so a PR sized in lines but not files would ship a
 * fabricated `filesChanged: 0` beside real line counts. A cloud read that
 * cannot supply all three projects nothing: a never-sized PR stays NULL, and an
 * already-sized one keeps the last COMPLETE triple rather than being torn across
 * two revisions. Both cloud read paths populate all three together, so this
 * costs no coverage in practice.
 *
 * Each count is screened by the shared `boundedNonNegativeInt` (FEA-3267) rather
 * than a bare `>= 0` check, so a negative reads as unknown instead of
 * subtracting from the sum (the cloud projection's own rule, PLN-1535 M4) and an
 * over-`PR_INT_MAX` value is rejected here rather than stored and then dropped
 * by the sync mapper's identical bound — which would ship exactly the partial
 * triple this function exists to prevent. Screening out a nonsensical value is
 * not a swallowed error: the reading aggregates treat an absent count as
 * un-enriched, so the PR surfaces as "no known size" rather than as a fabricated
 * number.
 */
function cloudPrLocProjection(
  repoFullName: string,
  overlay: StoredCloudGithubBranchOverlay
): CloudPrLocProjection | null {
  const prNumber = overlay.prNumber;
  const linesAdded = boundedNonNegativeInt(overlay.additions ?? null);
  const linesRemoved = boundedNonNegativeInt(overlay.deletions ?? null);
  const filesChanged = boundedNonNegativeInt(overlay.filesChanged ?? null);
  if (
    prNumber === null ||
    prNumber === undefined ||
    linesAdded === undefined ||
    linesRemoved === undefined ||
    filesChanged === undefined
  ) {
    return null;
  }
  return {
    repoFullName,
    prNumber,
    linesAdded,
    linesRemoved,
    filesChanged,
  };
}

/**
 * ISS-5413: write the cloud projection's PR diff stats back onto the local
 * `kind='pull_request'` artifacts.
 *
 * PLN-1535 M5 deleted the desktop enrichment lane, which held the only two
 * writers of `artifacts.lines_added` / `lines_removed` (and of `files_changed`).
 * Its PR body recorded that the cloud projection would fill those fields, but
 * nothing did, so every local PR row stayed un-enriched and the Local-mode
 * captured-KLOC aggregates in `local-insights.ts` — the "KLOC captured" KPI, its
 * period delta, and the KLOC-over-time trend — summed `COALESCE(lines_added, 0)`
 * over rows that are always NULL.
 *
 * This is that missing writer, and it stays on the D10 side of the line: the
 * numbers come from the cloud `PullRequestDetail` the branch hydration already
 * fetched and persists beside them, NOT from a reinstated local `gh`/`git`
 * sweep. Matching is `(repo_full_name, pr_number)` — the canonical PR identity
 * for repo-bearing rows — over the `idx_artifacts_repo_pr` index.
 *
 * Two limits are deliberate and NOT fixed here:
 * - The `mergedKloc` / merge-rate family stays dark. Those are additionally
 *   gated on `LOWER(pr_state) = 'merged'`, and `artifacts.pr_state` is the
 *   sibling column PLN-1535 disclosed as losing its writer. Restoring it is its
 *   own change; sizing a PR does not decide its state.
 * - Coverage follows the branch hydration. A PR artifact imported after the last
 *   Fresh cloud refresh is sized on the next one, and a machine that never
 *   reaches the cloud sizes nothing. Back-filling from the persisted overlay
 *   would be a new local sweep, which `apps/desktop/AGENTS.md` forbids.
 *
 * Sizing a PR row also revives the `kind='pull_request'` arms of `sync-source
 * .ts`'s session-LOC reads, which are written for PR rows but gated on
 * `lines_added IS NOT NULL` and so have matched nothing since PLN-1535. A
 * session on a sized PR now carries that PR's totals as its LOC fallback,
 * tagged `loc_basis='branch_fallback'` exactly as that arm intends, so the cloud
 * dedups the shared total per branch instead of summing it per session. Those
 * reads COALESCE each of the three columns to 0, which is the other reason
 * {@link cloudPrLocProjection} refuses to write a partial triple.
 *
 * The whole triple is written from ONE cloud read, so it always describes a
 * single PR revision. The changed-value predicate is what keeps the per-PR
 * statement affordable: after the first pass every refresh matches zero rows, so
 * a 90s poll stops rewriting rows it did not change (`IS NOT` is SQLite's
 * NULL-safe inequality, so an un-enriched row still matches). That is why this
 * stays a plain indexed loop — the same shape `pr-link-maintenance.ts` uses —
 * rather than a chunked set-based statement whose param-cap bookkeeping would
 * cost more clarity than the remaining no-op statements cost time.
 *
 * The projection shares the overlay upserts' transaction: the two are the same
 * cloud fact landing in two places, and the failures that can roll this back
 * (disk, corruption) would fail the upserts beside it anyway.
 */
async function projectCloudPrLocOntoArtifacts(
  tx: Prisma.TransactionClient,
  projections: readonly CloudPrLocProjection[]
): Promise<void> {
  for (const projection of projections) {
    await tx.$executeRawUnsafe(
      `UPDATE artifacts
          SET lines_added = $1,
              lines_removed = $2,
              files_changed = $3
        WHERE kind = 'pull_request'
          AND repo_full_name = $4
          AND pr_number = $5
          AND (lines_added IS NOT $1
               OR lines_removed IS NOT $2
               OR files_changed IS NOT $3)`,
      projection.linesAdded,
      projection.linesRemoved,
      projection.filesChanged,
      projection.repoFullName,
      projection.prNumber
    );
  }
}
