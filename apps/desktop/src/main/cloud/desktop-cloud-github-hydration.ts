import {
  BranchCloudHydrationStatus,
  type BranchRow,
} from "@repo/api/src/types/branch";
import { GitHubRepositorySource } from "@repo/api/src/types/github";
import {
  type NormalizedPersistedRepositoryDefaultAuthority,
  type RepositoryDefaultAuthority,
  RepositoryDefaultReason,
} from "@repo/api/src/types/repository-default-identity";
import type { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { resolveDesktopCloudCredential } from "../auth/desktop-cloud-credential.js";
import { unwrapApiEnvelope } from "../util/api-response-utils.js";
import {
  applyCurrentForkAuthorityFreshness,
  buildCurrentEligibilityEvidence,
  type CloudHydrationRequest,
  CloudHydrationRequestKind,
  type CurrentEligibilityEvidence,
  collectHydrationResponses,
  hasCurrentRepositoryResponse,
  staleHydrationResult,
} from "./desktop-cloud-github-eligibility-authority.js";
import {
  applyCompletePullRequestCoverageToCandidates,
  applyCurrentAuthorityOverrides,
  buildCloudOverlays,
  collectAuthorityRepositories,
  collectPullRequestIncompleteReasons,
  mergeEligibilityOverlays,
} from "./desktop-cloud-github-eligibility-overlays.js";
import {
  cloudHydrationCacheIdentity,
  cloudHydrationKeyFingerprint,
  cloudHydrationSessionScope,
  cloudHydrationTtl,
  collectHydrationRepoNames,
  isSameCloudHydrationSession,
} from "./desktop-cloud-github-hydration-cache.js";
import {
  type CloudHydrationResponse,
  type CloudRepository,
  cloudBranchesResponseSchema,
  cloudPullRequestsResponseSchema,
  cloudRepositoriesSchema,
  isIncompletePullRequestResponse,
} from "./desktop-cloud-github-hydration-schema.js";
import {
  collectCloudRepositoryDefaultAuthorities,
  collectCloudRepositoryDefaultAuthorityOverrides,
} from "./desktop-cloud-repository-default-authority.js";

export type DesktopCloudGitHubHydrationOptions = {
  /**
   * Legacy stored `sk_live_*` desktop API key — used ONLY when no session
   * identity exists at all (a compute-target machine that is not signed in),
   * through the PLN-1535 M3 migration window. While a session identity is
   * present the key is NEVER consulted: fetching with a possibly
   * different-org key and persisting under the session identity would defeat
   * the cross-account isolation the identity exists for.
   */
  getApiKey?: () => string | null;
  /**
   * PLN-1535 M3: first-party Desktop session token — the PRIMARY cloud
   * credential, resolved through the desktop-wide
   * `resolveDesktopCloudCredential` policy. Resolved per hydration run
   * together with the cache identity in ONE lane decision (see
   * {@link DesktopCloudGitHubHydration.resolveCredential}); the rotating
   * token value itself never participates in cache identity.
   */
  getAccessToken?: () => Promise<string | null>;
  /**
   * The signed-in Desktop session's account identity
   * (`DesktopSessionManager.getIdentity()`). This is BOTH the session-lane
   * gate and its cache-identity discriminator: a non-null value selects the
   * session lane and scopes every cached/persisted overlay to
   * `session:<orgId>:<userId>`; null means no session (key lane or
   * NotConnected). A session token is never used without this identity —
   * an account-anonymous identity key would let one account read another's
   * persisted overlays on a shared machine.
   */
  getSessionIdentity?: () => DesktopCloudSessionIdentity | null;
  /**
   * Invoked on an HTTP 401 so the owner can invalidate the cached session
   * token (`DesktopSessionManager.invalidateAccessToken()`), matching the
   * other session-backed HTTP lanes. Without it a rejected token is replayed
   * until its natural expiry.
   */
  onUnauthorized?: () => void;
  getApiOrigin: () => string;
  getIdentityScope?: () => DesktopCloudGitHubHydrationIdentityScope | null;
  store?: DesktopCloudGitHubHydrationStore;
  fetch?: typeof fetch;
  now?: () => number;
  maxEntries?: number;
  timeoutMs?: number;
  /** Invoked once a `peekOrWarm`-triggered background fetch lands Fresh, so
   * the caller can push a refetch nudge (e.g. to the renderer). */
  onBackgroundRefresh?: () => void;
  /** Reports a best-effort authority cache write failure without row payloads. */
  onRepositoryDefaultAuthorityWriteFailure?: () => void;
};

export type DesktopCloudGitHubHydrationIdentityScope = {
  userId?: string | null;
  organizationId?: string | null;
  profileId?: string | null;
  computeTargetId?: string | null;
};

/** Shape of `DesktopSessionManager.getIdentity()` — non-null only while a
 * session (stored or live) exists, including during boot restore. */
export type DesktopCloudSessionIdentity = {
  userId: string;
  organizationId: string;
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
  /** Current-response fail-closed overrides; consumed only by eligibility. */
  repositoryDefaultAuthorityOverrides?: NormalizedPersistedRepositoryDefaultAuthority[];
  /** Requested repositories absent from the current repository-list response. */
  repositoryDefaultAuthorityUnavailableNames?: string[];
  /** Repository-scoped PR coverage gaps for PR-derived field completeness. */
  pullRequestIncompleteReasons?: Record<string, RepositoryDefaultReason>;
};

export type DesktopRepositoryDefaultEligibilityRequest = {
  rows: readonly {
    branchName: string;
    repoFullName: string | null;
  }[];
  forceRefresh?: boolean;
  scope: "list" | "detail";
};
export type BranchCloudHydrationOverlay = Partial<
  Pick<
    BranchRow,
    | "baseBranch"
    | "status"
    | "prNumber"
    | "prTitle"
    | "prState"
    | "prUrl"
    | "mergedAt"
    | "additions"
    | "deletions"
    | "filesChanged"
    | "checksStatus"
    | "reviewDecision"
    | "lastActivityAt"
  >
> & {
  /** Provider-qualified PR-head identity; omitted by legacy peers. */
  headRepositoryProvider?: VcsProviderKind;
  headRepositoryProviderId?: string;
  headRepositoryFullName?: string;
  /** Exact provider absence; never inferred from the base repo. */
  headRepositoryUnavailableReason?: RepositoryDefaultReason;
};
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
  /** Persist provider authority separately from Branch overlay state. */
  writeRepositoryDefaultAuthorities?: (
    identityKey: string,
    observations: readonly RepositoryDefaultAuthority[]
  ) => Promise<void>;
  /** Read a bounded provider-qualified set for the resolved Desktop account. */
  readRepositoryDefaultAuthoritiesByNames?: (
    identityKey: string,
    repositories: readonly RepositoryDefaultAuthorityReadName[]
  ) => Promise<NormalizedPersistedRepositoryDefaultAuthority[]>;
};
export type RepositoryDefaultAuthorityReadName = {
  provider: VcsProviderKind;
  fullName: string;
};
type DesktopRepositoryDefaultEligibilityBase =
  DesktopCloudGitHubHydrationResult & {
    authorities: NormalizedPersistedRepositoryDefaultAuthority[];
  };
type NonFreshEligibilityStatus = Exclude<
  BranchCloudHydrationStatus,
  typeof BranchCloudHydrationStatus.Fresh
>;
type SuccessfulRowHydrationResult = DesktopCloudGitHubHydrationResult & {
  status: typeof BranchCloudHydrationStatus.Fresh;
};

/** Eligibility inputs distinguish successful row evidence from unavailable reads. */
export type DesktopRepositoryDefaultEligibilityInputs =
  | (DesktopRepositoryDefaultEligibilityBase & {
      /** Eligibility-only readiness, independent from PR/branch enrichment. */
      eligibilityStatus?: typeof BranchCloudHydrationStatus.Fresh;
      /** The exact awaited result safe to project onto local Branch rows. */
      rowHydrationResult: SuccessfulRowHydrationResult;
      status: typeof BranchCloudHydrationStatus.Fresh;
    })
  | (DesktopRepositoryDefaultEligibilityBase & {
      /** Current repository authority can succeed when PR row hydration fails. */
      eligibilityStatus: typeof BranchCloudHydrationStatus.Fresh;
      rowHydrationResult?: never;
      status: NonFreshEligibilityStatus;
    })
  | (DesktopRepositoryDefaultEligibilityBase & {
      status: NonFreshEligibilityStatus;
      eligibilityStatus?: NonFreshEligibilityStatus;
      rowHydrationResult?: never;
    });
type CacheEntry = {
  authorityPersistenceFailed: boolean;
  eligibilityEvidence: CurrentEligibilityEvidence;
  expiresAt: number;
  result: DesktopCloudGitHubHydrationResult;
};

const DEFAULT_MAX_ENTRIES = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_HYDRATION_PAGE_CAP = 100;
const REPOSITORY_DEFAULT_AUTHORITY_STORE_BATCH_SIZE = 100;

/** Main-process owner for desktop GitHub cloud hydration and stale fallback. */
export class DesktopCloudGitHubHydration {
  private readonly authorityPersistenceFailedResults = new WeakSet<object>();
  private readonly currentEligibilityEvidence = new WeakMap<
    object,
    CurrentEligibilityEvidence
  >();
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

  async hydrate(
    request: DesktopCloudGitHubHydrationRequest
  ): Promise<DesktopCloudGitHubHydrationResult> {
    const resolution = await this.resolveRequestContext(request);
    if (!resolution.context) {
      return { status: resolution.status };
    }
    return this.hydrateResolved(request, resolution.context);
  }

  private hydrateResolved(
    request: DesktopRepositoryDefaultEligibilityRequest,
    context: ResolvedRequestContext
  ): Promise<DesktopCloudGitHubHydrationResult> {
    const { token, repoNames, cacheKey } = context;
    const cached = this.cache.get(cacheKey);
    if (cached && !request.forceRefresh && cached.expiresAt > this.now()) {
      const cachedResult = {
        ...cached.result,
        status: BranchCloudHydrationStatus.Fresh,
      };
      if (cached.authorityPersistenceFailed) {
        this.authorityPersistenceFailedResults.add(cachedResult);
      }
      this.currentEligibilityEvidence.set(
        cachedResult,
        cached.eligibilityEvidence
      );
      return Promise.resolve(cachedResult);
    }
    const existing = this.pending.get(cacheKey);
    if (existing) {
      return existing;
    }
    const pending = this.fetchHydration(token, repoNames)
      .then((fetched) =>
        this.finalizeHydration(request, context, cached, fetched)
      )
      .finally(() => {
        this.pending.delete(cacheKey);
      });
    this.pending.set(cacheKey, pending);
    return pending;
  }

  private async finalizeHydration(
    request: DesktopRepositoryDefaultEligibilityRequest,
    context: ResolvedRequestContext,
    cached: CacheEntry | undefined,
    fetched: CloudHydrationFetchResult
  ): Promise<DesktopCloudGitHubHydrationResult> {
    const { identityKey, repoNames, cacheKey } = context;
    const {
      result,
      authorityObservations,
      currentAuthorityObservations,
      completePullRequestRepositoryNames,
      currentPullRequestBranchKeys,
      failedRequestKinds,
    } = fetched;
    const eligibilityEvidence = buildCurrentEligibilityEvidence(
      currentAuthorityObservations,
      completePullRequestRepositoryNames,
      currentPullRequestBranchKeys,
      failedRequestKinds
    );
    let authorityPersistenceFailed = false;
    await this.persistAuthorityObservations(
      identityKey,
      authorityObservations
    ).catch(() => {
      authorityPersistenceFailed = true;
      this.reportAuthorityWriteFailure();
    });
    if (hasOverlays(result.overlays ?? {})) {
      this.persistFreshOverlays(identityKey, repoNames, result).catch(
        () => undefined
      );
    }
    if (result.status === BranchCloudHydrationStatus.Fresh) {
      this.cache.set(cacheKey, {
        authorityPersistenceFailed,
        eligibilityEvidence,
        result,
        expiresAt: this.now() + cloudHydrationTtl(request.scope),
      });
      this.evictOverflow();
      if (authorityPersistenceFailed) {
        this.authorityPersistenceFailedResults.add(result);
      }
      this.currentEligibilityEvidence.set(result, eligibilityEvidence);
      return result;
    }
    let fallbackResult = result;
    if (cached) {
      fallbackResult = staleHydrationResult(cached.result, result);
    } else {
      const persisted = await this.readPersistedOverlays(
        identityKey,
        repoNames
      );
      if (hasOverlays(persisted)) {
        fallbackResult = staleHydrationResult({ overlays: persisted }, result);
      }
    }
    if (authorityPersistenceFailed) {
      this.authorityPersistenceFailedResults.add(fallbackResult);
    }
    this.currentEligibilityEvidence.set(fallbackResult, eligibilityEvidence);
    return fallbackResult;
  }

  /**
   * Non-blocking counterpart to `hydrate()` for read paths that must never
   * stall first paint on a live GitHub round trip (a cold cache can take 5s+
   * — see the FEA-3056 follow-up `branches-perf`/`cloud-hydration` timing
   * logs). Returns the best snapshot available WITHOUT making a network
   * call: an in-memory Fresh/Stale cache hit, the last persisted overlay
   * snapshot (Stale), or an overlay-less Stale result if neither exists yet.
   * Always also kicks off a real `hydrate()` in the background — deduped
   * against any fetch already in flight via the same `pending` map
   * `hydrate()` uses — so the cache is warm for the next read;
   * `onBackgroundRefresh` fires once that background fetch lands Fresh.
   */
  async peekOrWarm(
    request: DesktopCloudGitHubHydrationRequest
  ): Promise<DesktopCloudGitHubHydrationResult> {
    const resolution = await this.resolveRequestContext(request);
    if (!resolution.context) {
      return { status: resolution.status };
    }
    return this.peekOrWarmResolved(request, resolution.context);
  }

  private async peekOrWarmResolved(
    request: DesktopRepositoryDefaultEligibilityRequest,
    key: ResolvedRequestContext
  ): Promise<DesktopCloudGitHubHydrationResult> {
    const cached = this.cache.get(key.cacheKey);
    if (cached) {
      const fresh = cached.expiresAt > this.now();
      if (!fresh) {
        this.warmInBackground(request, key.cacheKey);
      }
      const cachedResult = {
        ...cached.result,
        status: fresh
          ? BranchCloudHydrationStatus.Fresh
          : BranchCloudHydrationStatus.Stale,
      };
      if (cached.authorityPersistenceFailed) {
        this.authorityPersistenceFailedResults.add(cachedResult);
      }
      this.currentEligibilityEvidence.set(
        cachedResult,
        cached.eligibilityEvidence
      );
      return cachedResult;
    }
    this.warmInBackground(request, key.cacheKey);
    const persisted = await this.readPersistedOverlays(
      key.identityKey,
      key.repoNames
    );
    return hasOverlays(persisted)
      ? { status: BranchCloudHydrationStatus.Stale, overlays: persisted }
      : { status: BranchCloudHydrationStatus.Stale };
  }

  /**
   * Read account-scoped authority without exposing its credential-derived key.
   * Cold reads await bounded hydration so pending and settled unavailability
   * remain distinct at the query boundary.
   */
  async resolveRepositoryDefaultEligibilityInputs(
    request: DesktopRepositoryDefaultEligibilityRequest
  ): Promise<DesktopRepositoryDefaultEligibilityInputs> {
    const resolution = await this.resolveRequestContext(request);
    if (!resolution.context) {
      return { status: resolution.status, authorities: [] };
    }
    const result = await this.hydrateResolved(request, resolution.context);
    const persistedOverlays = await this.readPersistedOverlays(
      resolution.context.identityKey,
      resolution.context.repoNames
    );
    const currentEvidence = this.currentEligibilityEvidence.get(result);
    const currentOverlays = currentEvidence
      ? applyCompletePullRequestCoverageToCandidates(
          result.overlays,
          currentEvidence.completePullRequestRepositoryNames,
          currentEvidence.currentPullRequestBranchKeys,
          request.rows
        )
      : result.overlays;
    const overlays = mergeEligibilityOverlays(
      persistedOverlays,
      currentOverlays,
      result.pullRequestIncompleteReasons
    );
    if (this.authorityPersistenceFailedResults.has(result)) {
      return {
        ...result,
        status: BranchCloudHydrationStatus.Failed,
        failure: "repository_default_authority_write_failed",
        ...(hasOverlays(overlays) ? { overlays } : {}),
        authorities: [],
      };
    }
    const repositories = collectAuthorityRepositories(
      resolution.context.repoNames,
      overlays
    );
    let authorities: NormalizedPersistedRepositoryDefaultAuthority[];
    try {
      authorities = await this.readRepositoryDefaultAuthoritiesByNames(
        resolution.context.identityKey,
        repositories
      );
    } catch {
      return {
        ...result,
        status: BranchCloudHydrationStatus.Failed,
        failure: "repository_default_authority_read_failed",
        ...(hasOverlays(overlays) ? { overlays } : {}),
        authorities: [],
      };
    }
    const authoritiesWithOverrides = applyCurrentAuthorityOverrides(
      authorities,
      [
        ...(currentEvidence?.authorities ?? []),
        ...(result.repositoryDefaultAuthorityOverrides ?? []),
      ],
      result.repositoryDefaultAuthorityUnavailableNames ?? []
    );
    const currentAuthorities = currentEvidence
      ? applyCurrentForkAuthorityFreshness(
          authoritiesWithOverrides,
          overlays,
          resolution.context.repoNames,
          currentEvidence.completeAuthorityKeys
        )
      : authoritiesWithOverrides;
    return buildEligibilityInputs(
      result,
      overlays,
      currentAuthorities,
      currentEvidence
    );
  }

  private warmInBackground(
    request: DesktopRepositoryDefaultEligibilityRequest,
    cacheKey: string
  ): void {
    if (this.pending.has(cacheKey)) {
      return;
    }
    this.resolveRequestContext(request)
      .then((resolution) =>
        resolution.context
          ? this.hydrateResolved(request, resolution.context)
          : { status: resolution.status }
      )
      .then((result) => {
        if (result.status === BranchCloudHydrationStatus.Fresh) {
          this.options.onBackgroundRefresh?.();
        }
      })
      .catch(() => undefined);
  }

  private async resolveRequestContext(
    request: Pick<DesktopRepositoryDefaultEligibilityRequest, "rows" | "scope">
  ): Promise<RequestContextResolution> {
    const repoNames = collectHydrationRepoNames(request.rows);
    if (repoNames.length === 0) {
      // Nothing carries a repo identity, so GitHub has nothing to enrich —
      // connecting GitHub IS the remedy. Same condition
      // `resolveBranchListBanner` derives from `repoFullName`.
      return { context: null, status: BranchCloudHydrationStatus.NotConnected };
    }
    const credential = await this.resolveCredential();
    if (!credential) {
      // Repos ARE present but this Desktop holds no cloud credential at all.
      // Reporting NotConnected here sent a signed-out user to a GitHub-connect
      // CTA that could never resolve their problem (PLN-1535 M3.2).
      return {
        context: null,
        status: BranchCloudHydrationStatus.CredentialMissing,
      };
    }
    const identityKey = cloudHydrationCacheIdentity(
      credential.credentialScope,
      this.options.getApiOrigin(),
      this.options.getIdentityScope?.() ?? null
    );
    const cacheKey = [request.scope, identityKey, repoNames.join(",")].join(
      ":"
    );
    return {
      context: { token: credential.token, identityKey, repoNames, cacheKey },
    };
  }

  /**
   * The SINGLE lane decision: which credential is in play, its stable
   * cache-identity scope, and the bearer token — resolved together so they
   * can never disagree (the PR #3994 review P1: pre-deciding the scope from a
   * sync probe let key-fetched data be cached under the session identity).
   *
   * - **Session lane** (a session identity exists, incl. during boot restore):
   *   scope is `session:<orgId>:<userId>`; token is the session token or
   *   `null` when unavailable (offline restore, retryable refresh failure) —
   *   the caller then reports Failed and serves the stale/persisted fallback
   *   under this SAME account identity. The API key is deliberately never a
   *   fallback here: it may belong to a different org.
   * - **Key lane** (no session at all): the key's sha256 fingerprint scope —
   *   identical to the pre-M3 identity composition, so not-signed-in
   *   key-auth installs keep their persisted overlay snapshots. (An install
   *   holding BOTH a key and a live session hydrates on the session lane, so
   *   its old fingerprint-scoped rows cold-start once — accepted; it is a
   *   display cache that re-warms on first hydration.)
   * - Neither → undefined → the caller reports `CredentialMissing` (PLN-1535
   *   M3.2), NOT `NotConnected`: repo identity is present, so this is a
   *   sign-in problem, not a GitHub-connect one. A session token without a
   *   resolved account identity never hydrates — there is no safe cache
   *   identity for it.
   */
  private async resolveCredential(): Promise<
    { credentialScope: string; token: string | null } | undefined
  > {
    const sessionIdentity = this.options.getSessionIdentity?.() ?? null;
    if (sessionIdentity) {
      const credential = await resolveDesktopCloudCredential({
        getAccessToken: this.options.getAccessToken,
      });
      const currentSessionIdentity =
        this.options.getSessionIdentity?.() ?? null;
      if (
        !isSameCloudHydrationSession(sessionIdentity, currentSessionIdentity)
      ) {
        return undefined;
      }
      return {
        credentialScope: cloudHydrationSessionScope(sessionIdentity),
        token: credential?.token ?? null,
      };
    }
    const apiKey = this.options.getApiKey?.();
    if (apiKey) {
      return {
        credentialScope: cloudHydrationKeyFingerprint(apiKey),
        token: apiKey,
      };
    }
    return undefined;
  }

  private async fetchHydration(
    token: string | null,
    repoNames: readonly string[]
  ): Promise<CloudHydrationFetchResult> {
    try {
      if (!token) {
        // Session lane with no resolvable token (offline boot restore, or a
        // retryable refresh failure). Failed — not NotConnected — so the
        // caller's stale/persisted-overlay fallback still serves the last
        // snapshot (under the SAME account identity) instead of blanking to a
        // connect CTA; the next read after the session heals fetches Fresh.
        return {
          result: {
            status: BranchCloudHydrationStatus.Failed,
            failure: "cloud_pull_failed",
          },
          authorityObservations: [],
          currentAuthorityObservations: [],
          completePullRequestRepositoryNames: new Set(),
          currentPullRequestBranchKeys: new Set(),
          failedRequestKinds: new Set([CloudHydrationRequestKind.Repository]),
        };
      }
      const repositories = await this.getRepositories(token);
      const returnedRepositoryNames = new Set(
        repositories.map((repository) => repository.fullName.toLowerCase())
      );
      const repositoryDefaultAuthorityUnavailableNames = repoNames.filter(
        (repoName) => !returnedRepositoryNames.has(repoName.toLowerCase())
      );
      const selected = repositories.filter(
        (repo) =>
          repo.source === GitHubRepositorySource.Installation &&
          repoNames.includes(repo.fullName)
      );
      const requests: CloudHydrationRequest[] = selected.flatMap(
        (repository) => [
          {
            kind: CloudHydrationRequestKind.Branches,
            repository,
            promise: this.getBranches(
              token,
              repository,
              `/integrations/github/repositories/${repository.id}/branches?limit=${GITHUB_HYDRATION_PAGE_CAP}`
            ),
          },
          {
            kind: CloudHydrationRequestKind.PullRequests,
            repository,
            promise: this.getPullRequests(
              token,
              repository,
              `/integrations/github/repositories/${repository.id}/pull-requests?limit=${GITHUB_HYDRATION_PAGE_CAP}`
            ),
          },
        ]
      );
      const responseResults = await Promise.allSettled(
        requests.map((request) => request.promise)
      );
      const {
        responses,
        completePullRequestRepositoryNames,
        currentPullRequestBranchKeys,
        failedRequestKinds,
      } = collectHydrationResponses(requests, responseResults);
      const authorityObservations = collectCloudRepositoryDefaultAuthorities(
        repositories,
        responses.flatMap((response) => response.pullRequests),
        repoNames
      );
      const currentAuthorityObservations =
        collectCloudRepositoryDefaultAuthorities(
          repositories,
          responses.flatMap((response) => response.pullRequests),
          repositories.map((repository) => repository.fullName)
        );
      const repositoryDefaultAuthorityOverrides =
        collectCloudRepositoryDefaultAuthorityOverrides(
          repositories,
          repoNames
        );
      const overlays = buildCloudOverlays(responses);
      const pullRequestIncompleteReasons =
        collectPullRequestIncompleteReasons(responses);
      if (failedRequestKinds.size > 0) {
        return {
          result: {
            status: BranchCloudHydrationStatus.Failed,
            failure: "cloud_pull_failed",
            ...(hasOverlays(overlays) ? { overlays } : {}),
            ...(repositoryDefaultAuthorityOverrides.length > 0
              ? { repositoryDefaultAuthorityOverrides }
              : {}),
            ...(repositoryDefaultAuthorityUnavailableNames.length > 0
              ? { repositoryDefaultAuthorityUnavailableNames }
              : {}),
            pullRequestIncompleteReasons,
          },
          authorityObservations,
          currentAuthorityObservations,
          completePullRequestRepositoryNames,
          currentPullRequestBranchKeys,
          failedRequestKinds,
        };
      }
      return {
        result: {
          status: BranchCloudHydrationStatus.Fresh,
          overlays,
          ...(repositoryDefaultAuthorityOverrides.length > 0
            ? { repositoryDefaultAuthorityOverrides }
            : {}),
          ...(repositoryDefaultAuthorityUnavailableNames.length > 0
            ? { repositoryDefaultAuthorityUnavailableNames }
            : {}),
          pullRequestIncompleteReasons,
        },
        authorityObservations,
        currentAuthorityObservations,
        completePullRequestRepositoryNames,
        currentPullRequestBranchKeys,
        failedRequestKinds,
      };
    } catch {
      return {
        result: {
          status: BranchCloudHydrationStatus.Failed,
          failure: "cloud_pull_failed",
        },
        authorityObservations: [],
        currentAuthorityObservations: [],
        completePullRequestRepositoryNames: new Set(),
        currentPullRequestBranchKeys: new Set(),
        failedRequestKinds: new Set([CloudHydrationRequestKind.Repository]),
      };
    }
  }

  private async getRepositories(token: string): Promise<CloudRepository[]> {
    const body = await this.getBody(token, "/integrations/github/repositories");
    return cloudRepositoriesSchema.parse(unwrapApiEnvelope(body));
  }

  private async getBranches(
    token: string,
    repository: CloudRepository,
    path: string
  ): Promise<CloudHydrationResponse> {
    const body = await this.getBody(token, path);
    return {
      repository,
      branches: cloudBranchesResponseSchema.parse(unwrapApiEnvelope(body))
        .branches,
      pullRequests: [],
    };
  }

  private async getPullRequests(
    token: string,
    repository: CloudRepository,
    path: string
  ): Promise<CloudHydrationResponse> {
    const body = await this.getBody(token, path);
    const parsed = cloudPullRequestsResponseSchema.parse(
      unwrapApiEnvelope(body)
    );
    return {
      repository,
      branches: [],
      pullRequests: parsed.pullRequests,
      ...(isIncompletePullRequestResponse(parsed, GITHUB_HYDRATION_PAGE_CAP)
        ? { pullRequestIncompleteReason: RepositoryDefaultReason.Capped }
        : {}),
    };
  }

  private async getBody(token: string, path: string): Promise<unknown> {
    const url = new URL(path, this.options.getApiOrigin());
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      if (response.status === 401) {
        // Early revocation/rotation: let the owner invalidate the cached
        // session token (matching the other session-backed HTTP lanes) so
        // the rejected token is not replayed until its natural expiry.
        this.options.onUnauthorized?.();
      }
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
    let overlays = result.overlays;
    if (Object.keys(result.pullRequestIncompleteReasons ?? {}).length > 0) {
      // The store cannot infer whether omitted PR fields mean complete absence
      // or incomplete coverage. Persist the eligibility merge for returned
      // branch keys so exact retained fork evidence survives this write.
      const persisted = await this.readPersistedOverlays(
        identityKey,
        repoNames
      );
      const merged = mergeEligibilityOverlays(
        persisted,
        overlays,
        result.pullRequestIncompleteReasons
      );
      overlays = Object.fromEntries(
        Object.entries(overlays).map(([key, overlay]) => [
          key,
          merged[key] ?? overlay,
        ])
      );
    }
    await this.options.store?.writeOverlays(
      identityKey,
      repoNames,
      overlays,
      new Date(this.now()).toISOString()
    );
  }

  private async persistAuthorityObservations(
    identityKey: string,
    authorityObservations: readonly RepositoryDefaultAuthority[]
  ): Promise<void> {
    if (authorityObservations.length === 0) {
      return;
    }
    const write = this.options.store?.writeRepositoryDefaultAuthorities;
    if (!write) {
      return;
    }
    const unique = uniqueAuthorityObservations(authorityObservations);
    for (
      let offset = 0;
      offset < unique.length;
      offset += REPOSITORY_DEFAULT_AUTHORITY_STORE_BATCH_SIZE
    ) {
      await write(
        identityKey,
        unique.slice(
          offset,
          offset + REPOSITORY_DEFAULT_AUTHORITY_STORE_BATCH_SIZE
        )
      );
    }
  }

  private reportAuthorityWriteFailure(): void {
    try {
      this.options.onRepositoryDefaultAuthorityWriteFailure?.();
    } catch {
      // Reporting is best-effort and must not change hydration behavior.
    }
  }

  private async readRepositoryDefaultAuthoritiesByNames(
    identityKey: string,
    repositories: readonly RepositoryDefaultAuthorityReadName[]
  ): Promise<NormalizedPersistedRepositoryDefaultAuthority[]> {
    const read = this.options.store?.readRepositoryDefaultAuthoritiesByNames;
    if (!read) {
      return [];
    }
    const authorities: NormalizedPersistedRepositoryDefaultAuthority[] = [];
    for (
      let offset = 0;
      offset < repositories.length;
      offset += REPOSITORY_DEFAULT_AUTHORITY_STORE_BATCH_SIZE
    ) {
      const chunk = repositories.slice(
        offset,
        offset + REPOSITORY_DEFAULT_AUTHORITY_STORE_BATCH_SIZE
      );
      const result = await read(identityKey, chunk);
      authorities.push(...result);
    }
    return authorities;
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

function hasOverlays(
  overlays: Record<string, BranchCloudHydrationOverlay>
): boolean {
  return Object.keys(overlays).length > 0;
}

function buildEligibilityInputs(
  result: DesktopCloudGitHubHydrationResult,
  overlays: Record<string, BranchCloudHydrationOverlay>,
  authorities: NormalizedPersistedRepositoryDefaultAuthority[],
  currentEvidence: CurrentEligibilityEvidence | undefined
): DesktopRepositoryDefaultEligibilityInputs {
  const base = {
    ...result,
    ...(hasOverlays(overlays) ? { overlays } : {}),
    authorities,
  };
  if (result.status !== BranchCloudHydrationStatus.Fresh) {
    return currentEvidence && hasCurrentRepositoryResponse(currentEvidence)
      ? {
          ...base,
          status: result.status,
          eligibilityStatus: BranchCloudHydrationStatus.Fresh,
        }
      : { ...base, status: result.status };
  }
  assertSuccessfulRowHydrationResult(result);
  return {
    ...base,
    status: result.status,
    eligibilityStatus: BranchCloudHydrationStatus.Fresh,
    rowHydrationResult: result,
  };
}

function assertSuccessfulRowHydrationResult(
  result: DesktopCloudGitHubHydrationResult
): asserts result is SuccessfulRowHydrationResult {
  if (result.status !== BranchCloudHydrationStatus.Fresh) {
    throw new Error("row hydration result is not fresh");
  }
}

function uniqueAuthorityObservations(
  observations: readonly RepositoryDefaultAuthority[]
): RepositoryDefaultAuthority[] {
  const unique = new Map<string, RepositoryDefaultAuthority>();
  for (const observation of observations) {
    unique.set(JSON.stringify(observation), observation);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, observation]) => observation);
}

/** The hydration inputs a pass needs once a credential and repo set resolve. */
type ResolvedRequestContext = {
  token: string | null;
  identityKey: string;
  repoNames: string[];
  cacheKey: string;
};

/** Internal fetch result; authority never crosses the public hydration result. */
type CloudHydrationFetchResult = {
  result: DesktopCloudGitHubHydrationResult;
  authorityObservations: RepositoryDefaultAuthority[];
  currentAuthorityObservations: RepositoryDefaultAuthority[];
  completePullRequestRepositoryNames: ReadonlySet<string>;
  currentPullRequestBranchKeys: ReadonlySet<string>;
  failedRequestKinds: ReadonlySet<CloudHydrationRequestKind>;
};

/**
 * Either the resolved context, or the status to report when the pass cannot
 * run at all. The two no-hydration reasons are kept DISTINCT here (PLN-1535
 * M3.2) so the renderer can tell "GitHub has nothing to enrich" (connect
 * GitHub) apart from "this Desktop holds no cloud credential" (sign in) —
 * previously both collapsed to `NotConnected` and pointed a signed-out user at
 * a GitHub-connect CTA that could not help them.
 */
type RequestContextResolution =
  | { context: ResolvedRequestContext }
  | { context: null; status: NonFreshEligibilityStatus };
