/**
 * The field names the web/desktop API client is allowed to revive into `Date`
 * (ISS-5771).
 *
 * ## Why this exists
 *
 * `useApiClient` parses every response through `reviveWithDates`. That reviver
 * used to key off VALUE SHAPE alone — *any* ISO-8601 string became a `Date`.
 * So every field a shared contract declares as `string` but populates with an
 * ISO timestamp was a `Date` at runtime, app-wide and silently, and `tsc` could
 * not see it because it had been told `string`. The confirmed casualty was
 * `AgentComponentInvocationReadRow.invokedAt` (declared `string | null`), whose
 * comparator called `.localeCompare` and took the component detail page into its
 * error boundary for any component with two or more invocations.
 *
 * A shape-based rule is also unbounded in the other direction: user-authored
 * free text that happens to be exactly an ISO instant — a title, a branch name,
 * a commit message, a document body — was silently converted too.
 *
 * ## The rule
 *
 * Revive a key **only when a RESPONSE CONTRACT declares that property as a
 * `Date`.** Everything else keeps the string the server sent, which is what the
 * contract says it is.
 *
 * ## What counts as a "response contract"
 *
 * A response contract is a type an `apps/api` route declares as the payload it
 * serializes — the first type argument of its route-auth wrapper
 * (`withAnyAuth<TResponse, …>`, `withAuth<TResponse, …>` and siblings) — plus
 * every type reachable from one through `@repo/api`'s REST types and
 * `@closedloop-ai/loops-api`.
 *
 * That anchor is deliberate, and it is narrower than "a type that lives in the
 * contract packages". The reviver only ever sees a RESPONSE BODY, so the only
 * authoritative statement about what a response body contains is the server's
 * own declaration of what it serializes, written at the route boundary. Merely
 * living under a contract directory proves nothing:
 *
 * - `search-query.ts`'s `UpdatedFilter` declares `date`, `from` and `to` as
 *   `Date`, but it is a PARSED-QUERY model that never crosses the wire — while
 *   `TimeSeriesPoint.date` and `PhaseLoopback.from`/`.to` are real response
 *   fields declared `string`. Collecting `UpdatedFilter` put those three names
 *   on the revive side, pointed straight at contracts that say `string`.
 * - `artifact.ts`'s `BranchDetail`/`SessionDetail` declare
 *   `lastSyncStartedAt`, `headShaObservedAt`, `sessionStartedAt` and friends as
 *   `Date`, but nothing serves them — `ArtifactWithDetail` has no route and no
 *   caller. The shapes actually served under those names,
 *   `BranchViewBranch` and `TokenTrendPoint`, declare them `string`. So the
 *   directory scan revived four live Branch View fields and the token-trend
 *   `sessionStartedAt` against their own contracts — the ISS-5771 defect
 *   reproduced in miniature, which is why `bucketDay` had to grow a
 *   `value instanceof Date` branch for a field typed `string`.
 *
 * Client-side call sites (`apiClient.get<T>`) are NOT used as the anchor even
 * though they look symmetrical: a call site often names the MATERIALIZED model
 * rather than the wire shape (`apiClient.get<ComputeTargetWire[]>` exists
 * precisely because `ComputeTarget` carries `Date`s the wire does not), so
 * seeding from them would re-admit display models. Empirically they also add no
 * key the route payloads do not already reach.
 *
 * A key-name allowlist is the only axis a JSON reviver has on its own: it sees
 * keys and values, never the static type of the field it is filling, and the
 * same key name is declared both ways across different response contracts
 * (`createdAt`, `startedAt`, `updatedAt` and others are `Date` on one and
 * `string` on another). This list therefore answers only "does SOME response
 * contract declare this key a `Date`?"; the win is the ~1,100 string-only keys,
 * and every free-text key, that stop being converted at all.
 *
 * It is NOT the whole answer. ISS-6208 added the missing axis: the client knows
 * the URL it requested, so `endpoint-date-revival.ts` suppresses a key on the
 * endpoints whose own payloads declare it only as a `string` — which is what
 * kept `ComponentVersion.createdAt` and `SyncedAgentSessionEvent.createdAt`
 * arriving as `Date`s against their own contracts. Read the two together: this
 * list is the ceiling, that table is the per-endpoint carve-out.
 *
 * `timestamp` is the sharpest illustration of why the scope is narrow. Every
 * response contract declares it `string` — including `ApiResult`'s failure
 * envelope, whose `rawErrorBodySchema` validates it with `z.string()`. Reviving
 * it (a `Date` only on client display models) turned that `safeParse` into a
 * whole-object failure and replaced the backend's real error message with a
 * generic fallback.
 *
 * ## Keeping it honest
 *
 * This list is not hand-maintained by inspection.
 * `date-revival-keys-covered.test.ts` re-derives it by walking the response
 * payload types out of the route declarations and fails when the two disagree —
 * in BOTH directions — so adding a `Date`-typed response field this list has
 * never heard of breaks the build rather than silently shipping a field typed
 * `Date` that arrives as a `string`.
 */
const DATE_REVIVAL_KEY_LIST = [
  "awaitingInputSince",
  "checkedAt",
  "closedAt",
  "completedAt",
  "createdAt",
  "dateValue",
  "deletedAt",
  "dueDate",
  "earnedAt",
  "editedAt",
  "endedAt",
  "expiresAt",
  "failedAt",
  "lastActivityAt",
  "lastAgentSessionSyncAt",
  "lastAgentSessionSyncAttemptAt",
  "lastIndexedAt",
  "lastRefreshAttemptAt",
  "lastSeenAt",
  "lastSyncedAt",
  "lastUsedAt",
  "lastVerifiedAt",
  "linkCreatedAt",
  "mergedAt",
  // ISS-6005: `AgentSessionListItem.recordUpdatedAt` — declared `Date` on the
  // sessions list/detail response contract.
  "recordUpdatedAt",
  "resolvedAt",
  "revokedAt",
  "startedAt",
  "targetDate",
  "updatedAt",
] as const;

/** Read-only view of the allowlist, for the coverage guard and tests. */
export const DATE_REVIVAL_KEYS: ReadonlySet<string> = new Set(
  DATE_REVIVAL_KEY_LIST
);

/**
 * Whether a JSON key may hold a revived `Date`.
 *
 * `JSON.parse` calls its reviver with the array INDEX for array elements, so a
 * numeric key is never a declared field and is rejected here. No contract
 * declares an array of `Date` today, and the coverage guard fails if one is ever
 * added, so this cannot silently under-revive.
 */
export function isDateRevivalKey(key: string): boolean {
  return DATE_REVIVAL_KEYS.has(key);
}
