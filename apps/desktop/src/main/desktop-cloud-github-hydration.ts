import { createHash } from "node:crypto";
import {
  BranchCloudHydrationStatus,
  type BranchRow,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import {
  GitHubPRState,
  GitHubRepositorySource,
} from "@repo/api/src/types/github";
import { z } from "zod";
import { unwrapApiEnvelope } from "./api-response-utils.js";

export type DesktopCloudGitHubHydrationOptions = {
  getApiKey: () => string | null;
  getApiOrigin: () => string;
  getIdentityScope?: () => DesktopCloudGitHubHydrationIdentityScope | null;
  store?: DesktopCloudGitHubHydrationStore;
  fetch?: typeof fetch;
  now?: () => number;
  maxEntries?: number;
  timeoutMs?: number;
};

export type DesktopCloudGitHubHydrationIdentityScope = {
  userId?: string | null;
  organizationId?: string | null;
  profileId?: string | null;
  computeTargetId?: string | null;
};

export type DesktopCloudGitHubHydrationRequest = {
  rows: readonly BranchRow[];
  forceRefresh?: boolean;
  scope: "list" | "detail";
};

export type DesktopCloudGitHubHydrationResult = {
  status: BranchCloudHydrationStatus;
  failure?: string;
  overlays?: Record<string, BranchCloudHydrationOverlay>;
};

export type BranchCloudHydrationOverlay = Partial<
  Pick<
    BranchRow,
    | "baseBranch"
    | "owner"
    | "status"
    | "prNumber"
    | "prTitle"
    | "prState"
    | "prUrl"
    | "additions"
    | "deletions"
    | "filesChanged"
    | "checksStatus"
    | "reviewDecision"
    | "lastActivityAt"
  >
>;

export type DesktopCloudGitHubHydrationStore = {
  readOverlays: (
    identityKey: string,
    repoNames: readonly string[]
  ) => Promise<Record<string, BranchCloudHydrationOverlay>>;
  writeOverlays: (
    identityKey: string,
    repoNames: readonly string[],
    overlays: Record<string, BranchCloudHydrationOverlay>,
    lastSyncedAt: string
  ) => Promise<void>;
};

type CacheEntry = {
  expiresAt: number;
  result: DesktopCloudGitHubHydrationResult;
};

const LIST_TTL_MS = 90_000;
const DETAIL_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 100;
const REQUEST_TIMEOUT_MS = 10_000;

/** Main-process owner for desktop GitHub cloud hydration and stale fallback. */
export class DesktopCloudGitHubHydration {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<
    string,
    Promise<DesktopCloudGitHubHydrationResult>
  >();
  private readonly options: DesktopCloudGitHubHydrationOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly timeoutMs: number;

  constructor(options: DesktopCloudGitHubHydrationOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  hydrate(
    request: DesktopCloudGitHubHydrationRequest
  ): Promise<DesktopCloudGitHubHydrationResult> {
    const apiKey = this.options.getApiKey();
    if (!apiKey) {
      return Promise.resolve({
        status: BranchCloudHydrationStatus.NotConnected,
      });
    }
    const repoNames = collectRepoNames(request.rows);
    if (repoNames.length === 0) {
      return Promise.resolve({
        status: BranchCloudHydrationStatus.NotConnected,
      });
    }
    const identityKey = cacheIdentity(
      apiKey,
      this.options.getApiOrigin(),
      this.options.getIdentityScope?.() ?? null
    );
    const cacheKey = [request.scope, identityKey, repoNames.join(",")].join(
      ":"
    );
    const cached = this.cache.get(cacheKey);
    if (cached && !request.forceRefresh && cached.expiresAt > this.now()) {
      return Promise.resolve({
        ...cached.result,
        status: BranchCloudHydrationStatus.Fresh,
      });
    }
    const existing = this.pending.get(cacheKey);
    if (existing) {
      return existing;
    }
    const pending = this.fetchHydration(apiKey, repoNames)
      .then(async (result) => {
        if (result.status === BranchCloudHydrationStatus.Fresh) {
          this.persistFreshOverlays(identityKey, repoNames, result).catch(
            () => undefined
          );
          this.cache.set(cacheKey, {
            result,
            expiresAt: this.now() + ttlForScope(request.scope),
          });
          this.evictOverflow();
        }
        if (result.status === BranchCloudHydrationStatus.Failed && cached) {
          return {
            ...cached.result,
            status: BranchCloudHydrationStatus.Stale,
            ...(result.failure === undefined
              ? {}
              : { failure: result.failure }),
          };
        }
        if (result.status === BranchCloudHydrationStatus.Failed) {
          const persisted = await this.readPersistedOverlays(
            identityKey,
            repoNames
          );
          if (hasOverlays(persisted)) {
            return {
              status: BranchCloudHydrationStatus.Stale,
              ...(result.failure === undefined
                ? {}
                : { failure: result.failure }),
              overlays: persisted,
            };
          }
        }
        return result;
      })
      .finally(() => {
        this.pending.delete(cacheKey);
      });
    this.pending.set(cacheKey, pending);
    return pending;
  }

  private async fetchHydration(
    apiKey: string,
    repoNames: readonly string[]
  ): Promise<DesktopCloudGitHubHydrationResult> {
    try {
      const repositories = await this.getRepositories(apiKey);
      const selected = repositories.filter(
        (repo) =>
          repo.source === GitHubRepositorySource.Installation &&
          repoNames.includes(repo.fullName)
      );
      const responses = await Promise.all(
        selected.flatMap((repo) => [
          this.getBranches(
            apiKey,
            repo,
            `/integrations/github/repositories/${repo.id}/branches?limit=100`
          ),
          this.getPullRequests(
            apiKey,
            repo,
            `/integrations/github/repositories/${repo.id}/pull-requests?limit=100`
          ),
        ])
      );
      return {
        status: BranchCloudHydrationStatus.Fresh,
        overlays: buildCloudOverlays(responses),
      };
    } catch {
      return {
        status: BranchCloudHydrationStatus.Failed,
        failure: "cloud_pull_failed",
      };
    }
  }

  private async getRepositories(apiKey: string): Promise<CloudRepository[]> {
    const body = await this.getBody(
      apiKey,
      "/integrations/github/repositories"
    );
    return cloudRepositoriesSchema.parse(unwrapApiEnvelope(body));
  }

  private async getBranches(
    apiKey: string,
    repository: CloudRepository,
    path: string
  ): Promise<CloudHydrationResponse> {
    const body = await this.getBody(apiKey, path);
    return {
      repository,
      branches: cloudBranchesResponseSchema.parse(unwrapApiEnvelope(body))
        .branches,
      pullRequests: [],
    };
  }

  private async getPullRequests(
    apiKey: string,
    repository: CloudRepository,
    path: string
  ): Promise<CloudHydrationResponse> {
    const body = await this.getBody(apiKey, path);
    return {
      repository,
      branches: [],
      pullRequests: cloudPullRequestsResponseSchema.parse(
        unwrapApiEnvelope(body)
      ).pullRequests,
    };
  }

  private async getBody(apiKey: string, path: string): Promise<unknown> {
    const url = new URL(path, this.options.getApiOrigin());
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error("GitHub cloud hydration request failed");
    }
    return response.json();
  }

  private evictOverflow(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (!oldest) {
        return;
      }
      this.cache.delete(oldest);
    }
  }

  private async persistFreshOverlays(
    identityKey: string,
    repoNames: readonly string[],
    result: DesktopCloudGitHubHydrationResult
  ): Promise<void> {
    if (!result.overlays) {
      return;
    }
    await this.options.store
      ?.writeOverlays(
        identityKey,
        repoNames,
        result.overlays,
        new Date(this.now()).toISOString()
      )
      .catch(() => undefined);
  }

  private async readPersistedOverlays(
    identityKey: string,
    repoNames: readonly string[]
  ): Promise<Record<string, BranchCloudHydrationOverlay>> {
    return (
      (await this.options.store
        ?.readOverlays(identityKey, repoNames)
        .catch(() => ({}))) ?? {}
    );
  }
}

type CloudRepository = z.infer<typeof cloudRepositorySchema>;
type CloudBranch = z.infer<typeof cloudBranchSchema>;
type CloudPullRequest = z.infer<typeof cloudPullRequestSchema>;

type CloudHydrationResponse = {
  repository: CloudRepository;
  branches: CloudBranch[];
  pullRequests: CloudPullRequest[];
};

const cloudRepositorySchema = z
  .object({
    id: z.string(),
    fullName: z.string(),
    source: z.enum(GitHubRepositorySource),
  })
  .passthrough();
const cloudRepositoriesSchema = z.array(cloudRepositorySchema);
const cloudBranchSchema = z
  .object({
    name: z.string(),
    committedDate: z.string(),
  })
  .passthrough();
const cloudBranchesResponseSchema = z
  .object({
    branches: z.array(cloudBranchSchema),
  })
  .passthrough();
const cloudPullRequestSchema = z
  .object({
    number: z.number(),
    title: z.string(),
    htmlUrl: z.string(),
    headBranch: z.string(),
    baseBranch: z.string(),
    state: z.enum([
      GitHubPRState.Open,
      GitHubPRState.Closed,
      GitHubPRState.Merged,
    ]),
    updatedAt: z.string(),
    author: z.string(),
    additions: z.number().nullable().optional(),
    deletions: z.number().nullable().optional(),
    changedFiles: z.number().nullable().optional(),
    checksStatus: z
      .enum([
        ChecksStatus.Unknown,
        ChecksStatus.Pending,
        ChecksStatus.Passing,
        ChecksStatus.Failing,
      ])
      .nullable()
      .optional(),
    reviewDecision: z
      .enum([
        ReviewDecision.Approved,
        ReviewDecision.ChangesRequested,
        ReviewDecision.Commented,
        ReviewDecision.Dismissed,
      ])
      .nullable()
      .optional(),
  })
  .passthrough();
const cloudPullRequestsResponseSchema = z
  .object({
    pullRequests: z.array(cloudPullRequestSchema),
  })
  .passthrough();

function collectRepoNames(rows: readonly BranchRow[]): string[] {
  const repoNames = new Set<string>();
  for (const row of rows) {
    if (row.repoFullName) {
      repoNames.add(row.repoFullName);
    }
  }
  return [...repoNames].sort();
}

function cacheIdentity(
  apiKey: string,
  apiOrigin: string,
  scope: DesktopCloudGitHubHydrationIdentityScope | null
): string {
  return [
    keyFingerprint(apiKey),
    apiOrigin,
    scope?.organizationId ?? "unknown-org",
    scope?.userId ?? "unknown-user",
    scope?.profileId ?? "unknown-profile",
    scope?.computeTargetId ?? "unknown-target",
  ].join("|");
}

function keyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function ttlForScope(
  scope: DesktopCloudGitHubHydrationRequest["scope"]
): number {
  if (scope === "detail") {
    return DETAIL_TTL_MS;
  }
  return LIST_TTL_MS;
}

function buildCloudOverlays(
  responses: readonly CloudHydrationResponse[]
): Record<string, BranchCloudHydrationOverlay> {
  const overlays: Record<string, BranchCloudHydrationOverlay> =
    Object.create(null);
  for (const response of responses) {
    for (const branch of response.branches) {
      const key = cloudOverlayKey(response.repository.fullName, branch.name);
      overlays[key] = {
        ...overlays[key],
        lastActivityAt: maxIso(
          overlays[key]?.lastActivityAt,
          branch.committedDate
        ),
      };
    }
    for (const pullRequest of response.pullRequests) {
      const key = cloudOverlayKey(
        response.repository.fullName,
        pullRequest.headBranch
      );
      overlays[key] = {
        ...overlays[key],
        baseBranch: pullRequest.baseBranch,
        owner: pullRequest.author,
        status: deriveBranchStatus(pullRequest.state),
        prNumber: pullRequest.number,
        prTitle: pullRequest.title,
        prState: pullRequest.state,
        prUrl: pullRequest.htmlUrl,
        ...cloudPullRequestLocOverlay(pullRequest),
        checksStatus: pullRequest.checksStatus ?? null,
        reviewDecision: pullRequest.reviewDecision ?? null,
        lastActivityAt: maxIso(
          overlays[key]?.lastActivityAt,
          pullRequest.updatedAt
        ),
      };
    }
  }
  return overlays;
}

function cloudOverlayKey(repoFullName: string, branchName: string): string {
  return `${repoFullName}::${branchName}`;
}

function hasOverlays(
  overlays: Record<string, BranchCloudHydrationOverlay>
): boolean {
  return Object.keys(overlays).length > 0;
}

function deriveBranchStatus(prState: GitHubPRState): BranchStatus {
  if (prState === GitHubPRState.Merged) {
    return BranchStatus.Merged;
  }
  if (prState === GitHubPRState.Closed) {
    return BranchStatus.Closed;
  }
  return BranchStatus.Open;
}

function maxIso(left: string | null | undefined, right: string): string {
  if (!left) {
    return right;
  }
  if (Date.parse(right) > Date.parse(left)) {
    return right;
  }
  return left;
}

function cloudPullRequestLocOverlay(
  pullRequest: CloudPullRequest
): Pick<
  BranchCloudHydrationOverlay,
  "additions" | "deletions" | "filesChanged"
> {
  const overlay: Pick<
    BranchCloudHydrationOverlay,
    "additions" | "deletions" | "filesChanged"
  > = {};
  if (pullRequest.additions !== undefined) {
    overlay.additions = pullRequest.additions;
  }
  if (pullRequest.deletions !== undefined) {
    overlay.deletions = pullRequest.deletions;
  }
  if (pullRequest.changedFiles !== undefined) {
    overlay.filesChanged = pullRequest.changedFiles;
  }
  return overlay;
}
