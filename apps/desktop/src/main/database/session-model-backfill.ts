/**
 * @file session-model-backfill.ts
 * @description ISS-4649 finding 8 — the null-`sessions.model` backfill, lifted
 * out of `write-core.ts`'s token-usage import phase (that file is on the
 * `noExcessiveLinesPerFile` grandfather list, so extracting a cohesive unit is
 * part of touching it) and corrected to pick the LATEST record by timestamp.
 *
 * FEA-1459 Fix 9 backfills `sessions.model` from `tokensByModel` when the parser
 * could not name a model. With ONE model key the choice is trivial; with several
 * the intent is "the model of the session's latest round trip", which the
 * previous code read positionally as `tokenSeries.at(-1)`. That is only the
 * latest record when `tokenSeries` is time-ordered, and BOTH subagent folds break
 * that ordering: `foldCodexDescendants` (codex) and `foldOpencodeSubagents`
 * (opencode) each APPEND a child's series after the root's own, in
 * child-enumeration order — and OpenCode enumerates sessions `time_updated DESC`,
 * so the LAST appended record is frequently the OLDEST. A root with
 * differently-modeled children therefore backfilled whichever child happened to
 * be folded last.
 *
 * Fixing it at this single shared consumer repairs BOTH fold lanes at once and
 * leaves them byte-identical to each other, which is the point: the two folds are
 * at deliberate parity, and sorting either one's output instead would reorder the
 * byte-compared golden Layer 1 oracles.
 *
 * Ordering is only half of it, though. The record the series points at also has
 * to be one this session's model could legitimately be — the aggregate, not the
 * raw series, is the candidate vocabulary, and a folded subagent's turn is not
 * the parent's model. And when several models are in play with no chronology to
 * order them, there is no honest answer at all. Those three constraints live in
 * {@link latestTokenRecordModel}. Finally, because the previous heuristic already
 * persisted wrong values that `AND model IS NULL` would preserve forever,
 * {@link backfillSessionModel} re-derives a stored value this derivation owns
 * instead of only filling nulls.
 */
import type {
  NormalizedSession,
  NormalizedTokenRecord,
} from "../collectors/types.js";

/**
 * The only transaction capability this backfill needs, declared structurally so
 * that `Prisma.TransactionClient` satisfies it at the call site (its
 * `PrismaPromise` is a `PromiseLike`) AND a plain recording double satisfies it
 * in a test — no cast at either end.
 */
type RawExecutor = {
  $executeRawUnsafe(sql: string, ...values: unknown[]): PromiseLike<number>;
};

/**
 * The model named by the LATEST token record the session's own aggregate
 * vouches for, or `null` when the series cannot name one honestly.
 *
 * Three filters decide which records are even candidates, and each closes a way
 * this selector could otherwise persist a value that is not the session's model:
 *
 * 1. **Present in `tokensByModel`.** `tokenSeries` and the aggregate are NOT the
 *    same vocabulary. The Codex parser deliberately remaps `codex-auto-review`
 *    out of `tokensByModel` (`buildTokensByModel`, parse-codex.ts) because it is
 *    a reviewer label rather than a model — but leaves it in `tokenSeries`, with
 *    a comment saying the point is that the backfill never picks it up. Reading
 *    the series directly would walk straight back into that. The aggregate keys
 *    are the authoritative candidate set; the series only orders them.
 * 2. **Nonblank after trimming.** A `""` or whitespace-only model is a bad value,
 *    not a model, and the old `??` chain did not catch it.
 * 3. **The parent's own round trips, when it has any.** `subagentId` present
 *    means the record came from a folded SUBAGENT (`NormalizedTokenRecord`,
 *    packages/lib/harness/types.ts); absent means the parent's own round trip.
 *    `session_turn_bucket` already honors that convention
 *    (`turn-buckets.ts`), and `sessions.model` describes the session, so a
 *    subagent's newest turn must not advertise a model the parent never ran.
 *    Folding is exactly what creates the multi-key case in the first place —
 *    `mergeTokensByModel` merges each child's aggregate into the root — so
 *    without this filter the multi-key branch is entered BECAUSE of the child
 *    and then answered BY the child. When the parent contributes no usable
 *    record at all, the whole candidate set is used rather than giving up.
 *
 * Ordering, once the candidates are chosen: by parsed `timestamp`, not by
 * position, because both folds APPEND a child's series after the root's own in
 * child-enumeration order (see the file header), and OpenCode enumerates
 * `time_updated DESC` so the last element is routinely the OLDEST. Ties resolve
 * to the positionally-later record, so a genuinely time-ordered series yields
 * what the previous positional read yielded.
 *
 * When the candidates name exactly ONE distinct model, that model is returned
 * without consulting timestamps — there is no ordering question to answer. When
 * they name several and NONE carries a parseable timestamp, this returns `null`:
 * with no chronology, both "the last one positionally" and "the first aggregate
 * key" are arbitrary, and an arbitrary pick would be persisted and then made
 * sticky by the `model IS NULL` backfill predicate. Unknown is the honest
 * answer, and the caller leaves the row unset rather than guessing.
 */
export function latestTokenRecordModel(
  tokenSeries: readonly NormalizedTokenRecord[],
  aggregateModels: ReadonlySet<string>
): string | null {
  const parentOwned: NormalizedTokenRecord[] = [];
  const anyOwner: NormalizedTokenRecord[] = [];
  for (const record of tokenSeries) {
    const model = record.model?.trim();
    if (!(model && aggregateModels.has(model))) {
      continue;
    }
    anyOwner.push(record);
    // Absent ⇒ the parent's own round trip. Only sound because the field is
    // omission-preserving; an explicit `null` would read as parent here.
    if (record.subagentId === undefined) {
      parentOwned.push(record);
    }
  }
  const candidates = parentOwned.length > 0 ? parentOwned : anyOwner;
  return selectLatestModel(candidates);
}

/**
 * The single distinct model of `candidates`, else the model of the candidate
 * with the greatest parseable timestamp, else `null`.
 */
function selectLatestModel(
  candidates: readonly NormalizedTokenRecord[]
): string | null {
  const distinct = new Set(candidates.map((record) => record.model.trim()));
  if (distinct.size === 0) {
    return null;
  }
  const [only] = distinct;
  if (distinct.size === 1 && only !== undefined) {
    return only;
  }
  let latestModel: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const record of candidates) {
    const time = Date.parse(record.timestamp);
    if (Number.isNaN(time)) {
      continue;
    }
    if (time >= latestTime) {
      latestTime = time;
      latestModel = record.model.trim();
    }
  }
  return latestModel;
}

/**
 * The `tokensByModel` keys that are usable as a session model: trimmed and
 * nonblank. A blank aggregate key is a bad value, never a backfill candidate.
 */
export function usableAggregateModels(session: NormalizedSession): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const rawKey of Object.keys(session.tokensByModel ?? {})) {
    const key = rawKey.trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * FEA-1459 Fix 9: derive `sessions.model` from `tokensByModel` when the parsed
 * session did not name one. A single usable key is unambiguous and is used
 * directly; several keys resolve through {@link latestTokenRecordModel}, which
 * answers `null` when no honest choice exists.
 *
 * REPAIR, not only backfill (ISS-4649 finding 8). The predicate is deliberately
 * wider than the original `AND model IS NULL`, because that alone left every row
 * the old positional heuristic had already mis-filled wrong forever: on
 * re-import the session upsert writes `model = COALESCE(model, $2)` and this
 * function's own `$2` is null, so a wrong child model survived every re-import
 * and every rebuild. A value this derivation could itself have produced — a
 * member of the session's current `tokensByModel` — is therefore re-derived
 * rather than preserved.
 *
 * The repair set is every value the derivation — old or new — could itself have
 * written from THIS session's data: the aggregate keys as stored and trimmed,
 * plus the models named in `tokenSeries`. The series half matters because the
 * old code read `tokenSeries.at(-1)?.model` directly, so it could persist a
 * label the aggregate never contained (`codex-auto-review` is exactly that);
 * keying the repair on the aggregate alone would leave those rows unrepairable.
 *
 * What it still will not touch: a stored model outside that set. That value did
 * not come from this derivation, so it is not this function's to overwrite.
 *
 * `updated_at` is the sync watermark, so every path here writes only when the
 * stored value would actually change; a row already carrying the derived model
 * is left completely untouched rather than re-synced to the cloud.
 */
export async function backfillSessionModel(
  tx: RawExecutor,
  session: NormalizedSession,
  tokenSeries: readonly NormalizedTokenRecord[],
  now: string
): Promise<void> {
  const modelKeys = usableAggregateModels(session);
  if (session.model || modelKeys.length === 0) {
    return;
  }
  const derivedModel =
    modelKeys.length === 1
      ? (modelKeys[0] ?? null)
      : latestTokenRecordModel(tokenSeries, new Set(modelKeys));
  const repairable = repairableStoredModels(session, tokenSeries);

  if (derivedModel === null) {
    // No honest choice. Clear a previously-derived value so the row says
    // "unknown" rather than keeping an arbitrary pick sticky; leave a NULL row
    // untouched so this cannot bump the sync watermark for nothing.
    await tx.$executeRawUnsafe(
      `UPDATE sessions SET model = NULL, updated_at = $1 WHERE id = $2 AND model IN (${placeholders(repairable, 2)})`,
      now,
      session.sessionId,
      ...repairable
    );
    return;
  }

  await tx.$executeRawUnsafe(
    `UPDATE sessions SET model = $1, updated_at = $2 WHERE id = $3 AND (model IS NULL OR (model <> $1 AND model IN (${placeholders(repairable, 3)})))`,
    derivedModel,
    now,
    session.sessionId,
    ...repairable
  );
}

/**
 * Every stored `sessions.model` value this derivation could itself have written
 * for this session — the repair target set. See {@link backfillSessionModel}.
 */
export function repairableStoredModels(
  session: NormalizedSession,
  tokenSeries: readonly NormalizedTokenRecord[]
): string[] {
  const values = new Set<string>();
  for (const rawKey of Object.keys(session.tokensByModel ?? {})) {
    if (rawKey) {
      values.add(rawKey);
    }
    const trimmed = rawKey.trim();
    if (trimmed) {
      values.add(trimmed);
    }
  }
  for (const record of tokenSeries) {
    if (record.model) {
      values.add(record.model);
    }
  }
  return [...values];
}

/**
 * Positional placeholders for an `IN (...)` list appended after `fixedParams`
 * leading parameters. Kept as a helper so the two statements cannot silently
 * drift out of sync with their own parameter counts.
 */
function placeholders(values: readonly string[], fixedParams: number): string {
  return values
    .map((_value, index) => `$${index + fixedParams + 1}`)
    .join(", ");
}
