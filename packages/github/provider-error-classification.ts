import { z } from "zod";
import {
  type GitHubProviderResult,
  GitHubProviderResultStatus,
  type GitHubUserTokenProviderResult,
  GitHubUserTokenProviderResultStatus,
} from "./provider-result";

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
 * 404 handling. Only the bundled pull-request read calls this.
 *
 * A GraphQL denial never carries an HTTP status: the request itself returns
 * 200 and octokit throws once it sees `errors` in the body, so status-based
 * classification is blind here.
 *
 * Returns null — meaning "not a repo-access failure, fall through" — unless
 * every guard holds, because a false positive records a 6h no-access verdict
 * against a healthy credential and drops the repo out of the sweep.
 */
export function classifyBundledRepositoryAccessFailure(
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
