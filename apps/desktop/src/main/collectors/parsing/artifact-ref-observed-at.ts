/**
 * @file artifact-ref-observed-at.ts
 * @description ISS-5236 — the ONE resolver for an artifact ref's `observed_at`,
 * so no extractor pass can silently reach for the import wall clock again.
 *
 * `observed_at` answers "when was this reference observed". Before ISS-5236 every
 * scan-time ref answered a different question — "when did Desktop happen to
 * import this session" — because `extractArtifactRefs(session, now)` built one
 * `ExtractContext.observedAt` from the caller's `now`. That value is not inert:
 * `resolveLinkObservedAt` (sync-source.ts) ships it to the cloud as
 * `artifactRef.observedAt`, `buildBranchLifecycleEventsForBranchLink` stamps
 * branch-lifecycle timeline instants from it, it seeds `artifacts.first_pushed_at`
 * (MIN-wins), and it orders several `branch-reads` queries. So an import-clock
 * value moved real timeline dots onto whatever moment a rebuild happened to run,
 * and — because the value churned on every rebuild — it also defeated the
 * synced-child-row "true sync no-op" path (ISS-5148).
 *
 * The rule this module encodes, in precedence order:
 *
 *  1. The ref's OWN source event instant, when the ref was derived from a
 *     transcript event that carries one (a tool use's `tu.timestamp`, a message's
 *     `msg.timestamp`). Applied at the call site, which is the only place that
 *     knows which event a ref came from.
 *  2. Otherwise {@link resolveSessionObservedAt} — the session's own
 *     `startedAt`. This is a genuinely SOURCE-derived instant, not a relabelled
 *     clock: the signals these refs are scanned out of (`session.gitBranch`,
 *     `session.cwd`, `session.slug`, `launch-metadata.json`) are all captured
 *     once, at session start, so session start IS when they were observed.
 *
 * We never fabricate an instant. This mirrors the guard `pushCommitRefs` already
 * applies to `committedAt` ("No transcript timestamp → leave committedAt unset —
 * do NOT fall back to observedAt/scan time") and the one `prLifecycleObservedAt`
 * applies to `commit_sha_correlation` links (emit NO instant rather than a
 * fabricated PR-raised time).
 *
 * `session_artifact_links.observed_at` is `TEXT NOT NULL`, so the resolver must
 * return a string. `startedAt` is falsy ONLY for a session the parser contract
 * says never reaches an importer at all ("`startedAt` falsy ⇒ the parser returns
 * null (caller skips)" — `NormalizedSession` in `@repo/lib/harness/types`), so
 * the `now` floor below is unreachable in production. It is retained rather than
 * throwing so a malformed/partial parse degrades to exactly the pre-ISS-5236
 * behaviour instead of aborting an import, and it is the ONLY path on which an
 * import-clock value can still be persisted.
 *
 * ## Why every step VALIDATES instead of coalescing (ISS-5236 review)
 *
 * A bare `??` chain treats any non-null string as a timestamp, and the source
 * strings here are NOT trustworthy. `toIso` (`@repo/lib/harness/parser-utils`)
 * returns an unparseable string VERBATIM rather than null, and Claude's `isoTs`
 * passes any string through with no parsing at all — deliberately, to mirror the
 * vendors' leniency. Those feed `session.startedAt` on all five harnesses and
 * `NormalizedToolUse.timestamp` on OpenCode (whose values come from arbitrary
 * TEXT columns in the user's `opencode.db`). So a junk string genuinely reaches
 * here, and `??` would prefer it precisely because it is non-null.
 *
 * That value would not stay local. `resolveLinkObservedAt` (sync-source.ts)
 * ships it as `artifactRef.observedAt`, where the cloud's `isoTimestampSchema`
 * (`packages/api/src/types/session-artifact-link.ts`) rejects anything
 * `Date.parse` cannot read — and the desktop payload is validated in ONE parse
 * of up to 200 sessions, so a single bad row 400s the whole batch and re-fails
 * on every retry until it dead-letters. `toSyncedCommitTimestamp` already guards
 * `committed_at` for exactly this reason (FEA-2731); `observed_at` had no
 * equivalent. Validating at the point of derivation also honours the repo rule
 * that a normalized record is valid-or-absent — we never persist a bad value and
 * then hope a downstream layer catches it.
 *
 * Validation reuses the canonical {@link validIso} (`database/db-helpers.ts`),
 * whose predicate is character-for-character the cloud's: a non-empty string
 * that `Date.parse` reads as finite. It is deliberately NOT a second hand-rolled
 * check, and deliberately NOT stricter than the wire contract — rejecting a
 * value the cloud would have accepted would silently discard a real instant.
 *
 * ## Why every step also CANONICALIZES (ISS-5427)
 *
 * Validating is necessary but not sufficient. `validIso` returns its input
 * VERBATIM, and the source instants it admits are not all in one format:
 * Claude's `isoTs` passes a transcript string through unparsed, so
 * `session.startedAt` — and an OpenCode `tu.timestamp` read out of an arbitrary
 * TEXT column — can be offset-form (`2026-08-06T10:00:00-05:00`) rather than
 * canonical UTC 'Z'. Before ISS-5236 that could not happen here, because every
 * scan-time ref was stamped from the import wall clock, which is canonical by
 * construction; taking the harness-supplied instant is what let a second format
 * into the column.
 *
 * That matters because `session_artifact_links.observed_at` is TEXT and every
 * consumer compares it LEXICALLY, where an offset form sorts by its wall-clock
 * digits instead of its real instant: `artifact-link-persistence.ts`'s
 * `first_pushed_at = MIN(COALESCE(first_pushed_at, $2), $2)` (SQLite `MIN()`
 * over TEXT is a string compare, and the slot is set-once so a wrong winner is
 * permanent), `branch-reads.ts`'s `ORDER BY sal.observed_at ASC`, and
 * `component-invocations.ts`'s `ORDER BY sal.observed_at ASC`. The value also
 * rides the wire as `artifactRef.observedAt`, and the cloud's
 * `isoTimestampSchema` accepts an offset form, so a non-canonical instant lands
 * there too.
 *
 * So both resolvers pass their validated value through {@link toCanonicalIso}
 * (FEA-3743), the same normalizer the rest of the desktop write path uses to
 * keep every lexically-compared timestamp column single-format. Rows written
 * between ISS-5236 and this change are healed on boot by
 * `timestamp-format-maintenance.ts`, which now covers this column.
 *
 * ## The scope of "only the spelling changes"
 *
 * That claim is exact for a ZONE-BEARING value — a 'Z' form or an offset form
 * fixes the instant unambiguously, so re-expressing it in UTC preserves it.
 * It is NOT exact for a ZONE-LESS date-time (`2026-08-06T10:00:00`), and the
 * distinction is worth stating because such a value is not rejected anywhere on
 * this path: `validIso` admits it, and the boot heal's predicate admits it too
 * (see the "bare no-zone form" note on `NON_CANONICAL_TIMESTAMP_PREDICATE`).
 * For that form the two readers in this system DISAGREE — `toCanonicalIso` is
 * `Date.parse`, which per ECMA-262 reads a zone-less date-TIME as LOCAL,
 * whereas SQLite's `unixepoch()` over the same text (local-insights.ts) reads
 * it as UTC. So canonicalizing one through bare `Date.parse` SHIFTS it by the
 * operator's UTC offset, and two desktops in different zones store different
 * text for the same row.
 *
 * ISS-5496 settled that disagreement for the boot heal only: it canonicalizes a
 * stored zone-less value as UTC (`canonicalizeStoredTimestamp`), matching what
 * `unixepoch()` and every lexical comparison over the column already assume, so
 * THAT PASS's output no longer depends on the machine that ran it. THIS write
 * path is unchanged and still calls `toCanonicalIso` directly, so the shift
 * described above is still what happens to a zone-less harness value at ingest.
 *
 * Which makes the heal's zone-independence durable for `sessions.started_at`
 * (set-once, so nothing rewrites it) but NOT for the four re-derivable ISS-5427
 * observation columns: an `EXTRACTOR_VERSION` bump re-runs this resolver over
 * the original harness text and re-derives the operator-local instant, which is
 * canonical and so is never healed again. Closing that would mean giving this
 * path the same UTC reading — deliberately not done here, because at INGEST the
 * harness's own intent, not the store's, is what a zone-less value would have to
 * be read against, and no harness emits one (see below).
 *
 * No harness emits that form today, which is why this is a documented boundary
 * and not a fix. Measured over the frozen golden corpus
 * (`packages/golden-sessions/`, 2026-08-07): every one of the 16,642
 * timestamp-typed field values in the raw transcripts, and all 15,209 in the
 * parsed `normalized.json` (`startedAt` / `endedAt` / `timestamp`), is canonical
 * `Z`-with-milliseconds — zero zone-less, zero offset-form. The offset and
 * no-zone strings that DO appear in those files sit inside message and
 * tool-output text, never in a field the collector reads as an instant. If a
 * harness ever does emit one, the right fix is to reject it at the parse
 * boundary rather than to let two readers disagree about what it means.
 */

import type { NormalizedSession } from "@repo/lib/harness/types";
import { toCanonicalIso, validIso } from "../../database/db-helpers.js";

/**
 * The session-scoped source instant every scan-time artifact ref falls back to.
 *
 * Always canonical UTC 'Z' (ISS-5427): a parseable source value is normalized
 * with {@link toCanonicalIso}, and the unreachable `now`-less floor is minted by
 * `toISOString()`, which is canonical already.
 *
 * @param session the parsed session the refs are being extracted from.
 * @param now the caller's import clock — the last-resort floor only (see the
 *   file header); pass the same value the importer uses elsewhere.
 */
export function resolveSessionObservedAt(
  session: Pick<NormalizedSession, "startedAt">,
  now?: string
): string {
  const source = validIso(session.startedAt) ?? validIso(now);
  return source === null ? new Date().toISOString() : toCanonicalIso(source);
}

/**
 * The instant ONE artifact ref is stamped with: its own source event instant
 * when that instant is real, else the session-scoped fallback.
 *
 * Every extractor pass that has an event in scope must route through this rather
 * than writing `event.timestamp ?? ctx.observedAt` inline — the bare `??` has the
 * same defect the file header describes, one layer up: a junk `tu.timestamp` is
 * non-null, so it would win and `resolveSessionObservedAt`'s validated value
 * would never get a chance.
 *
 * Always canonical UTC 'Z' (ISS-5427): a real event instant is normalized with
 * {@link toCanonicalIso}, and the fallback arrives already canonical from
 * {@link resolveSessionObservedAt}.
 *
 * @param eventTime the ref's own instant (`tu.timestamp`, `msg.timestamp`,
 *   `committedAt`), unvalidated as it comes off the parser.
 * @param sessionObservedAt the already-resolved `ctx.observedAt` fallback.
 */
export function resolveRefObservedAt(
  eventTime: string | null | undefined,
  sessionObservedAt: string
): string {
  const own = validIso(eventTime);
  return own === null ? sessionObservedAt : toCanonicalIso(own);
}
