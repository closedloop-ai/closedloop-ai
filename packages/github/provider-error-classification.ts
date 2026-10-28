import { z } from "zod";
// Explicit `.ts` (ISS-10452): `never-scheduled-runs.ts` now reaches this module,
// and that one is executed directly by `node` from
// `scripts/ci/ready-to-enqueue.ts`, which resolves ESM specifiers literally
// rather than probing extensions the way a bundler does.
import {
  GitHubOperationProviderResultStatus,
  type GitHubProviderResult,
  GitHubProviderResultStatus,
  type GitHubUserTokenProviderResult,
  GitHubUserTokenProviderResultStatus,
} from "./provider-result.ts";

/**
 * PLN-1525/PLN-1535: every provider-error classification the GitHub read layer
 * performs, in one module. Split out of `index.ts` by ISS-5093 — the file is on
 * the shrink-only grandfather list, so the work had to pay for its own lines.
 *
 * Depends only on `provider-result`; `index.ts` imports FROM here, never the
 * other way round.
 */

export type GitHubProviderErrorClassification =
  | {
      status: typeof GitHubProviderResultStatus.ProviderRateLimit;
      retryAfterSeconds: number | null;
    }
  | {
      status: typeof GitHubProviderResultStatus.ProviderPermissionFiltered;
    }
  | { status: typeof GitHubProviderResultStatus.ProviderUnavailable };

/**
 * Extract retry metadata from GitHub REST/GraphQL errors. `Retry-After` wins
 * over reset epochs because it is the provider's most specific instruction.
 */
export function getGitHubRetryAfterSeconds(
  error: unknown,
  nowMs = Date.now()
): number | null {
  const retryAfter = getGitHubErrorHeader(error, "retry-after");
  const retryAfterSeconds = parseRetryAfterHeader(retryAfter, nowMs);
  if (retryAfterSeconds !== null) {
    return retryAfterSeconds;
  }

  const resetEpoch = getGitHubErrorHeader(error, "x-ratelimit-reset");
  if (!resetEpoch) {
    return null;
  }
  const resetSeconds = Number(resetEpoch);
  if (!(Number.isFinite(resetSeconds) && resetSeconds > 0)) {
    return null;
  }
  const secondsUntilReset = Math.ceil((resetSeconds * 1000 - nowMs) / 1000);
  return secondsUntilReset > 0 ? secondsUntilReset : null;
}

/** Classify GitHub provider failures without exposing raw provider content. */
export function classifyGitHubProviderError(
  error: unknown,
  nowMs = Date.now()
): GitHubProviderErrorClassification {
  const status = getGitHubErrorStatus(error);
  const retryAfterSeconds = getGitHubRetryAfterSeconds(error, nowMs);
  if (
    status === 429 ||
    (status === 403 &&
      (retryAfterSeconds !== null || hasGitHubRateLimitEvidence(error))) ||
    hasGitHubRateLimitEvidence(error)
  ) {
    return {
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds,
    };
  }
  if (status === 403) {
    return {
      status: GitHubProviderResultStatus.ProviderPermissionFiltered,
    };
  }
  return { status: GitHubProviderResultStatus.ProviderUnavailable };
}

export type GitHubOperationProviderFailure =
  | {
      status: typeof GitHubProviderResultStatus.ProviderRateLimit;
      retryAfterSeconds: number | null;
    }
  | { status: typeof GitHubProviderResultStatus.ProviderPermissionFiltered }
  | { status: typeof GitHubProviderResultStatus.CredentialUnauthorized }
  | { status: typeof GitHubOperationProviderResultStatus.InvalidResponse }
  | { status: typeof GitHubProviderResultStatus.ProviderUnavailable };

const RETRYABLE_GITHUB_HTTP_STATUSES = new Set([408, 500, 502, 503, 504]);

/** Classify a same-client repository probe that disambiguates a 404. */
export function classifyGitHubRepositoryAccessProbeError(
  error: unknown,
  nowMs = Date.now()
):
  | GitHubOperationProviderFailure
  | { status: typeof GitHubProviderResultStatus.ProviderRepoNotFound } {
  const status = getGitHubErrorStatus(error);
  if (status === 404) {
    return { status: GitHubProviderResultStatus.ProviderRepoNotFound };
  }
  if (status === 401) {
    return { status: GitHubProviderResultStatus.CredentialUnauthorized };
  }
  return classifyStructuredGitHubOperationFailure(error, nowMs);
}

/** Classify GitHub App installation-token acquisition by its exact stage. */
export function classifyGitHubInstallationClientAcquisitionError(
  error: unknown,
  nowMs = Date.now()
):
  | GitHubOperationProviderFailure
  | { status: typeof GitHubProviderResultStatus.ProviderInstallationNotFound } {
  const status = getGitHubErrorStatus(error);
  if (status === 404) {
    return { status: GitHubProviderResultStatus.ProviderInstallationNotFound };
  }
  if (status === 401) {
    return { status: GitHubProviderResultStatus.CredentialUnauthorized };
  }
  return classifyStructuredGitHubOperationFailure(error, nowMs);
}

function classifyStructuredGitHubOperationFailure(
  error: unknown,
  nowMs: number
): GitHubOperationProviderFailure {
  const status = getGitHubErrorStatus(error);
  const retryAfterSeconds = getGitHubRetryAfterSeconds(error, nowMs);
  if (
    status === 429 ||
    retryAfterSeconds !== null ||
    hasStructuredRateLimitEvidence(error)
  ) {
    return {
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds,
    };
  }
  if (status === 403) {
    return {
      status: GitHubProviderResultStatus.ProviderPermissionFiltered,
    };
  }
  if (status === null) {
    return {
      status: hasMalformedStructuredStatus(error)
        ? GitHubOperationProviderResultStatus.InvalidResponse
        : GitHubProviderResultStatus.ProviderUnavailable,
    };
  }
  if (RETRYABLE_GITHUB_HTTP_STATUSES.has(status)) {
    return { status: GitHubProviderResultStatus.ProviderUnavailable };
  }
  return { status: GitHubOperationProviderResultStatus.InvalidResponse };
}

function hasMalformedStructuredStatus(error: unknown): boolean {
  if (!(error && typeof error === "object")) {
    return false;
  }
  if (Reflect.has(error, "status")) {
    return typeof Reflect.get(error, "status") !== "number";
  }
  if (!Reflect.has(error, "response")) {
    return false;
  }
  const response = Reflect.get(error, "response");
  return !(
    response &&
    typeof response === "object" &&
    typeof Reflect.get(response, "status") === "number"
  );
}

/**
 * Classify a thrown error into the same failure statuses the provider-result
 * read functions produce. Callers that resolve their own installation client
 * (PLN-1525 step 4) use this to fold a `getInstallationOctokit` rejection into
 * the errors-as-values contract instead of letting it escape as a throw.
 */
export function toGitHubProviderFailure(
  error: unknown
): Exclude<
  GitHubProviderResult<never>,
  { status: typeof GitHubProviderResultStatus.Success }
> {
  const classification = classifyGitHubProviderError(error);
  if (
    classification.status === GitHubProviderResultStatus.ProviderRateLimit ||
    classification.status ===
      GitHubProviderResultStatus.ProviderPermissionFiltered
  ) {
    return classification;
  }
  return { status: GitHubProviderResultStatus.ProviderUnavailable };
}

export function toGitHubUserTokenProviderFailure(
  error: unknown
): Exclude<
  GitHubUserTokenProviderResult<never>,
  { status: typeof GitHubProviderResultStatus.Success }
> {
  const classification = classifyGitHubProviderError(error);
  if (classification.status === GitHubProviderResultStatus.ProviderRateLimit) {
    return classification;
  }
  const status = getGitHubErrorStatus(error);
  if (status === 401) {
    return {
      status: GitHubUserTokenProviderResultStatus.CredentialUnauthorized,
    };
  }
  if (status === 403) {
    return {
      status: GitHubUserTokenProviderResultStatus.CredentialInsufficientScope,
    };
  }
  return { status: GitHubProviderResultStatus.ProviderUnavailable };
}

function parseRetryAfterHeader(value: string | null, nowMs: number) {
  if (!value) {
    return null;
  }
  const numericSeconds = Number(value);
  if (Number.isFinite(numericSeconds) && numericSeconds > 0) {
    return Math.ceil(numericSeconds);
  }
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) {
    return null;
  }
  const secondsUntilDate = Math.ceil((dateMs - nowMs) / 1000);
  return secondsUntilDate > 0 ? secondsUntilDate : null;
}

function getGitHubErrorStatus(error: unknown): number | null {
  if (!(error && typeof error === "object")) {
    return null;
  }
  const directStatus = Reflect.get(error, "status");
  if (typeof directStatus === "number") {
    return directStatus;
  }
  const response = Reflect.get(error, "response");
  if (response && typeof response === "object") {
    const responseStatus = Reflect.get(response, "status");
    return typeof responseStatus === "number" ? responseStatus : null;
  }
  return null;
}

function getGitHubErrorHeader(
  error: unknown,
  headerName: string
): string | null {
  if (!(error && typeof error === "object")) {
    return null;
  }
  const directHeaders = Reflect.get(error, "headers");
  const directValue = getHeaderValue(directHeaders, headerName);
  if (directValue) {
    return directValue;
  }
  const response = Reflect.get(error, "response");
  if (!(response && typeof response === "object")) {
    return null;
  }
  return getHeaderValue(Reflect.get(response, "headers"), headerName);
}

function getHeaderValue(headers: unknown, headerName: string): string | null {
  if (!(headers && typeof headers === "object")) {
    return null;
  }
  const getter = Reflect.get(headers, "get");
  if (typeof getter === "function") {
    const value = getter.call(headers, headerName);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  const lowerHeaderName = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerHeaderName) {
      continue;
    }
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  return null;
}

function hasGitHubRateLimitEvidence(error: unknown): boolean {
  const text = getGitHubErrorText(error).toLowerCase();
  return (
    text.includes("rate limit") ||
    text.includes("rate_limited") ||
    text.includes("rate-limited") ||
    text.includes("ratelimit") ||
    text.includes("secondary rate")
  );
}

function getGitHubErrorText(error: unknown): string {
  if (!(error && typeof error === "object")) {
    return "";
  }
  const messages: string[] = [];
  pushStringProperty(messages, error, "message");
  pushStringProperty(messages, error, "reason");
  const errors = Reflect.get(error, "errors");
  if (Array.isArray(errors)) {
    for (const item of errors) {
      pushErrorItemText(messages, item);
    }
  }
  return messages.join(" ");
}

function pushErrorItemText(messages: string[], item: unknown) {
  if (!(item && typeof item === "object")) {
    return;
  }
  pushStringProperty(messages, item, "message");
  pushStringProperty(messages, item, "type");
  pushStringProperty(messages, item, "reason");
}

function pushStringProperty(
  messages: string[],
  source: object,
  property: string
) {
  const value = Reflect.get(source, property);
  if (typeof value === "string") {
    messages.push(value);
  }
}

/**
 * ISS-5093: decide whether a failed *repo-scoped* GraphQL read means the
 * credential cannot reach the repository at all.
 *
 * This deliberately does NOT live in `classifyGitHubProviderError`. That
 * classifier is shared by REST readers where a 404 means a missing ref, PR, or
 * comment — not a missing repository — so repository meaning belongs at the
 * operation, the same way `SelectedPullRequestProviderOperation` keys its own
 * 404 handling.
 *
 * Scope is REPO-SCOPED GRAPHQL ACCESS, not one reader. Both repo-scoped GraphQL
 * reads call it: the paged bundled read and the by-number self-heal read
 * (`pull-requests-by-number.ts`), which passes `pagesFetched: 0` because a
 * single-shot query has no earlier page to have proved the repo reachable. A
 * future repo-scoped GraphQL reader belongs here too — what qualifies a caller
 * is that a denial means "cannot reach THIS repo", not which reader it is.
 *
 * A GraphQL denial never carries an HTTP status: the request itself returns
 * 200 and octokit throws once it sees `errors` in the body, so status-based
 * classification is blind here.
 *
 * Returns null — meaning "not a repo-access failure, fall through" — unless
 * every guard holds, because a false positive records a 6h no-access verdict
 * against a healthy credential and drops the repo out of the sweep.
 */
export function classifyRepositoryAccessFailure(
  error: unknown,
  pagesFetched: number
): GitHubBundledRepositoryAccessFailure | null {
  // Earlier pages already proved the repo reachable; a later page failing is
  // about that page. The rate-limit branch preserves those pages for the same
  // reason.
  if (pagesFetched > 0) {
    return null;
  }
  // GitHub reports rate limits as GraphQL errors too, and they outrank a
  // no-access reading: a throttled token is not an unreachable repo.
  // Structured evidence only — text matching would false-positive on a repo
  // or owner named "rate-limit" whose name appears in the error message.
  if (hasStructuredRateLimitEvidence(error)) {
    return null;
  }
  const envelope = graphqlResponseEnvelopeSchema.safeParse(error);
  if (!envelope.success) {
    return null;
  }
  if (!isRepositorySelectionUnresolved(envelope.data)) {
    return null;
  }
  return classifyRepositoryRootedGraphqlError(envelope.data);
}

const graphqlErrorEntrySchema = z.object({
  type: z.string().optional(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
});

const graphqlResponseEnvelopeSchema = z.object({
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  errors: z.array(graphqlErrorEntrySchema).optional(),
});

type GraphqlResponseEnvelope = z.infer<typeof graphqlResponseEnvelopeSchema>;

function hasStructuredRateLimitEvidence(error: unknown): boolean {
  if (getGitHubErrorStatus(error) === 429) {
    return true;
  }
  if (getGitHubRetryAfterSeconds(error) !== null) {
    return true;
  }
  const parsed = graphqlResponseEnvelopeSchema.safeParse(error);
  if (!parsed.success) {
    return false;
  }
  return (
    parsed.data.errors?.some((e) => e.type === GRAPHQL_RATE_LIMITED_TYPE) ??
    false
  );
}

/**
 * True when the query's root `repository` selection produced no value. A nested
 * failure under a non-null field bubbles null up to the same place, so this is
 * necessary but not sufficient — the caller also checks error attribution.
 */
function isRepositorySelectionUnresolved(
  envelope: GraphqlResponseEnvelope
): boolean {
  const { data } = envelope;
  if (data === null || data === undefined) {
    return true;
  }
  const repository = data[GITHUB_GRAPHQL_REPOSITORY_SELECTION];
  return repository === null || repository === undefined;
}

function classifyRepositoryRootedGraphqlError(
  envelope: GraphqlResponseEnvelope
): GitHubBundledRepositoryAccessFailure | null {
  const { errors } = envelope;
  if (!errors) {
    return null;
  }
  for (const entry of errors) {
    const type = repositoryRootedErrorType(entry);
    if (type === GITHUB_GRAPHQL_NOT_FOUND_TYPE) {
      return { status: GitHubProviderResultStatus.ProviderRepoNotFound };
    }
    if (type === GITHUB_GRAPHQL_FORBIDDEN_TYPE) {
      return { status: GitHubProviderResultStatus.ProviderRepoForbidden };
    }
  }
  return null;
}

/**
 * The error's `type`, but only when it is attributed to the root `repository`
 * selection by an exact single-segment path. A longer path is a nested field
 * failure, `rateLimit` is a second independent root selection, and an absent
 * path cannot be attributed to either — none of which may be read as the
 * repository being unreachable.
 */
function repositoryRootedErrorType(
  entry: z.infer<typeof graphqlErrorEntrySchema>
): string | null {
  const { path, type } = entry;
  if (
    !Array.isArray(path) ||
    path.length !== 1 ||
    path[0] !== GITHUB_GRAPHQL_REPOSITORY_SELECTION
  ) {
    return null;
  }
  return type ?? null;
}

/** Root selection of the bundled query; `rateLimit` is the other one. */
const GITHUB_GRAPHQL_REPOSITORY_SELECTION = "repository";
/** GitHub cloaks a private repo it will not show you as NOT_FOUND. */
const GITHUB_GRAPHQL_NOT_FOUND_TYPE = "NOT_FOUND";
const GITHUB_GRAPHQL_FORBIDDEN_TYPE = "FORBIDDEN";
const GRAPHQL_RATE_LIMITED_TYPE = "RATE_LIMITED";

/**
 * The two repo-reachability verdicts the bundled read can reach.
 *
 * Both are exclusive to this helper. Nothing else in the package produces them,
 * which is what lets a caller treat either as "this credential cannot reach
 * this repo" without re-deriving the guards — a generic 403 stays
 * `ProviderPermissionFiltered` and carries no repo-level meaning.
 */
export type GitHubBundledRepositoryAccessFailure =
  | { status: typeof GitHubProviderResultStatus.ProviderRepoForbidden }
  | { status: typeof GitHubProviderResultStatus.ProviderRepoNotFound };

/**
 * The partial `data` GitHub still returned alongside a thrown GraphQL error,
 * paired with the `errors` from the same wrapper — the first candidate whose
 * data passes the caller's own shape guard, since only that guard can say
 * which wrapper holds ITS response.
 *
 * GitHub answers an aliased or multi-selection query with HTTP 200, a populated
 * `data`, AND an `errors[]` for the selections it could not resolve — and
 * octokit throws on that. Discarding it would throw away the selections that DID
 * resolve. The errors come back with the data because reading `error.errors`
 * instead misses a nested `response.data.data` payload's errors (ISS-10489).
 *
 * A candidate with no errors of its own does not qualify (marisolashgrove on
 * #7440): its errors live on another wrapper, so salvaging it would attribute
 * nothing and report every unresolved selection as cleanly absent. Every
 * salvage in this package, `recoverPartialOpenPullRequests` included, routes
 * through here so that rule has one owner.
 */
export function recoverPartialGraphqlEnvelope<T>(
  error: unknown,
  isData: (value: unknown) => value is T
): { data: T; errors: readonly unknown[] } | null {
  for (const candidate of partialGraphqlEnvelopeCandidates(error)) {
    if (candidate.errors.length > 0 && isData(candidate.data)) {
      return { data: candidate.data, errors: candidate.errors };
    }
  }
  return null;
}

/**
 * One wrapper's partial `data` TOGETHER WITH the `errors` that came in the same
 * envelope, so a caller can attribute the errors to the data it salvaged.
 *
 * Pairing them is the point (ISS-10452, raised by tamsinb on #7440). A caller
 * that recovers `data` from `error.response.data.data` and then reads
 * `error.errors` gets an empty array — that wrapper's errors live at
 * `error.response.data.errors` — so every per-node attribution silently comes
 * back "nothing refused" over an answer GitHub demonstrably refused part of.
 */
export type PartialGraphqlEnvelope = {
  data: unknown;
  errors: readonly unknown[];
};

/**
 * The envelopes a thrown GraphQL error can carry, newest wrapper first.
 *
 * The three shapes are octokit's `GraphqlResponseError` (`data` + `errors` hung
 * off the error), the raw response body, and the body's own `data`. Each pairs
 * with the `errors` that belong to IT — see {@link PartialGraphqlEnvelope}.
 */
function partialGraphqlEnvelopeCandidates(
  error: unknown
): PartialGraphqlEnvelope[] {
  const responseData = (error as { response?: { data?: unknown } } | null)
    ?.response?.data;
  return [
    {
      data: (error as { data?: unknown } | null)?.data,
      errors: errorsOf(error),
    },
    { data: responseData, errors: errorsOf(responseData) },
    {
      data: (responseData as { data?: unknown } | null)?.data,
      errors: errorsOf(responseData),
    },
  ];
}

function errorsOf(value: unknown): readonly unknown[] {
  const errors = (value as { errors?: unknown } | null)?.errors;
  return Array.isArray(errors) ? errors : [];
}

/**
 * The error entries a thrown GraphQL error carries, from whichever wrapper has
 * them — for a caller that wants the entries without caring which envelope the
 * data came from, such as a failure detail on a read it could NOT salvage.
 */
export function graphqlErrorEntries(error: unknown): readonly unknown[] {
  return (
    partialGraphqlEnvelopeCandidates(error).find(
      (candidate) => candidate.errors.length > 0
    )?.errors ?? []
  );
}

/**
 * The first `limit` GraphQL error `path`s, dotted, for a failure detail.
 *
 * `path` is the only field that names WHICH selection GitHub refused, and
 * `message` — the one thing callers used to keep — repeats verbatim across every
 * entry (`Resource not accessible by integration`), so a detail built from the
 * message alone says a node was unreadable without saying which. Bounded because
 * one answer can carry hundreds of entries and this string is logged every tick.
 *
 * Takes the entries rather than the error, so the caller decides which
 * envelope's errors these are — see {@link partialGraphqlEnvelopeCandidates}.
 */
export function graphqlErrorPaths(
  errors: readonly unknown[],
  limit: number
): string[] {
  const paths: string[] = [];
  for (const entry of errors) {
    if (paths.length >= limit) {
      break;
    }
    const path = (entry as { path?: unknown } | null)?.path;
    if (Array.isArray(path)) {
      paths.push(path.join("."));
    }
  }
  return paths;
}
