/**
 * Bounded-`unknown` predicate and producer-side clamp for the historical-parse
 * worker boundary (ISS-5797, porting closedloop-ai/closedloop-ai#61).
 *
 * Extracted from `historical-parse-worker-protocol.ts` so the protocol module
 * keeps the schema/response code and this module owns the one question "is this
 * payload representable across the worker boundary, and if not, what is the
 * nearest thing that is?". The predicate is what
 * `boundedUnknownValueSchema` validates on the CONSUMER side; the clamp is what
 * the PRODUCER must apply so the two can never disagree.
 *
 * Why this exists: `sliceSessionArrays` bounds array LENGTHS only. Without a
 * content clamp, one oversized tool-use payload (a >2MB `Write` input is enough)
 * fails the whole response, the parse job degrades to a Failed envelope, and the
 * source is re-parsed and re-rejected on every collector cycle — permanently
 * missing from metrics. This is the FEA-3701 failure class at another boundary,
 * so the coverage tables at the bottom of this file make the producer and the
 * schema unable to drift silently.
 */

import { truncateUtf8 } from "@closedloop-ai/loops-api/observability";
import type {
  NormalizedDefinitionSnapshot,
  NormalizedPrRef,
  NormalizedSession,
  NormalizedSubagent,
  NormalizedToolUse,
} from "../types.js";
import { HistoricalParseWorkerLimits } from "./historical-parse-worker-limits.js";

const MAX_UNKNOWN_DEPTH = HistoricalParseWorkerLimits.maxUnknownDepth;
const MAX_UNKNOWN_ARRAY_ITEMS =
  HistoricalParseWorkerLimits.maxUnknownArrayItems;
const MAX_UNKNOWN_OBJECT_KEYS =
  HistoricalParseWorkerLimits.maxUnknownObjectKeys;
const MAX_SHORT_TEXT_LENGTH = HistoricalParseWorkerLimits.maxShortTextLength;
const MAX_LONG_TEXT_LENGTH = HistoricalParseWorkerLimits.maxLongTextLength;

/** Replaces payloads the bounded-unknown validator would reject outright. */
export const TRUNCATED_UNKNOWN_VALUE = "[truncated]";

/**
 * Marks a string this module SHORTENED rather than replaced.
 *
 * ISS-5797 (codex review): a clamp that silently shortens a value and then lets
 * the response be accepted leaves a partial payload persisted as though it were
 * complete, and no downstream consumer can tell the difference. Every truncation
 * this module performs is therefore self-describing in the value itself — the
 * same job {@link TRUNCATED_UNKNOWN_VALUE} already did for a payload that had no
 * bounded representation at all. The marker is included INSIDE the cap (the
 * content is shortened by the marker's own width), so a marked value still
 * satisfies the bound the consumer schema enforces.
 *
 * Object KEYS are deliberately left unmarked: a key is an identifier, not
 * content, and {@link takeDistinctKey} already rewrites truncated keys to keep
 * them distinct — a second rewrite would only make collisions likelier without
 * telling a consumer anything the value's own marker does not.
 */
export const TRUNCATED_TEXT_SUFFIX = "…[truncated]";

/**
 * The consumer-side contract: exactly what `boundedUnknownValueSchema` accepts.
 * Kept in this module beside the clamp that must satisfy it.
 */
export function isBoundedUnknownValue(value: unknown, depth: number): boolean {
  if (depth > MAX_UNKNOWN_DEPTH) {
    return false;
  }
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "string") {
    return Buffer.byteLength(value) <= MAX_LONG_TEXT_LENGTH;
  }
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_UNKNOWN_ARRAY_ITEMS &&
      value.every((item) => isBoundedUnknownValue(item, depth + 1))
    );
  }
  if (isPlainRecord(value)) {
    return isBoundedRecord(value, depth);
  }
  return false;
}

/**
 * The record half of {@link isBoundedUnknownValue}, in ONE early-exiting pass.
 *
 * ISS-5797 (wongk review): this used to be `Object.entries(value)` — which
 * materializes a key/value pair for EVERY entry — followed by `.every(...)`, and
 * then `clampRecordEntries` paid for a second full materialization of the same
 * record. A malformed transcript carrying a 200k-entry metadata map therefore
 * allocated ~400k pairs before either bound applied. Walking the keys directly
 * and returning on the first violation allocates nothing and stops at entry 251.
 */
function isBoundedRecord(
  value: Record<string, unknown>,
  depth: number
): boolean {
  let count = 0;
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      count++;
      if (
        count > MAX_UNKNOWN_OBJECT_KEYS ||
        key.length > MAX_SHORT_TEXT_LENGTH ||
        !isBoundedUnknownValue(value[key], depth + 1)
      ) {
        return false;
      }
    }
  }
  return true;
}

export function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Degrade an out-of-bounds unknown value to the nearest in-bounds shape:
 * oversized strings truncate, oversized arrays/objects drop trailing entries,
 * non-finite numbers become null, and containers at the depth cap (whose
 * children the validator rejects wholesale) collapse to a marker string.
 * Already-bounded values return BY REFERENCE, so the common case allocates
 * nothing.
 */
export function clampUnknownValue(value: unknown, depth: number): unknown {
  if (isBoundedUnknownValue(value, depth)) {
    return value;
  }
  if (typeof value === "number") {
    // Only a non-finite number fails the bounded check above.
    return null;
  }
  if (typeof value === "string") {
    return truncateMarkedBytes(value, MAX_LONG_TEXT_LENGTH);
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_UNKNOWN_DEPTH) {
      return TRUNCATED_UNKNOWN_VALUE;
    }
    return clampArrayItems(value, depth + 1);
  }
  if (isPlainRecord(value)) {
    if (depth >= MAX_UNKNOWN_DEPTH) {
      return TRUNCATED_UNKNOWN_VALUE;
    }
    return clampRecordEntries(value, depth + 1);
  }
  // null/boolean/finite numbers are always bounded; anything else (undefined,
  // bigint, function, class instance) has no bounded representation.
  return TRUNCATED_UNKNOWN_VALUE;
}

/** Headroom reserved for the `~N` suffix that disambiguates a truncated key. */
export const CLAMPED_KEY_SUFFIX_HEADROOM = 5;

/**
 * Cap a record's entry COUNT, bound each key, and keep truncated keys DISTINCT.
 *
 * The distinctness matters: two keys sharing a >8192-character prefix truncate
 * to the same string, and `Object.fromEntries` is last-wins, so one value would
 * silently disappear — a bad value coerced away with no signal, which is exactly
 * what this boundary is not allowed to do. Disambiguating inside the entry LIST
 * (rather than assigning into a fresh object) also keeps `Object.fromEntries`'
 * define-semantics: plain assignment would let a `__proto__` key reach the
 * prototype setter.
 */
function clampRecordEntries(
  value: Record<string, unknown>,
  childDepth: number
): Record<string, unknown> {
  // Take ONE more than the cap: the extra entry is the proof that a tail was
  // dropped, and stopping there is what keeps this bounded for a record with
  // hundreds of thousands of entries (wongk review).
  const probed = takeEntries(value, MAX_UNKNOWN_OBJECT_KEYS + 1);
  const droppedTail = probed.length > MAX_UNKNOWN_OBJECT_KEYS;
  const kept = droppedTail
    ? probed.slice(0, MAX_UNKNOWN_OBJECT_KEYS - 1)
    : probed;
  const taken = new Set<string>();
  const entries: [string, unknown][] = kept.map(([key, item]) => [
    takeDistinctKey(taken, clampObjectKey(key)),
    clampUnknownValue(item, childDepth),
  ]);
  if (droppedTail) {
    // Spend the last slot saying so, rather than handing the consumer 250
    // entries that look like the whole map.
    entries.push([
      takeDistinctKey(taken, TRUNCATED_UNKNOWN_VALUE),
      TRUNCATED_UNKNOWN_VALUE,
    ]);
  }
  return Object.fromEntries(entries);
}

/**
 * The first `max` own enumerable entries of a record, without materializing the
 * rest. `Object.entries().slice()` builds a pair for every entry first; this
 * stops as soon as it has what the caller asked for.
 */
function takeEntries(
  value: Record<string, unknown>,
  max: number
): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      if (entries.length >= max) {
        return entries;
      }
      entries.push([key, value[key]]);
    }
  }
  return entries;
}

/**
 * Cap an unknown array's LENGTH, marking a dropped tail in the last slot so a
 * consumer seeing exactly `MAX_UNKNOWN_ARRAY_ITEMS` items can tell a full array
 * from a truncated one.
 */
function clampArrayItems(value: unknown[], childDepth: number): unknown[] {
  if (value.length <= MAX_UNKNOWN_ARRAY_ITEMS) {
    return value.map((item) => clampUnknownValue(item, childDepth));
  }
  const kept: unknown[] = value
    .slice(0, MAX_UNKNOWN_ARRAY_ITEMS - 1)
    .map((item) => clampUnknownValue(item, childDepth));
  kept.push(TRUNCATED_UNKNOWN_VALUE);
  return kept;
}

/**
 * Truncate an object key to the schema's key cap without splitting a UTF-16
 * surrogate pair. `clampLongText` is codepoint-safe for VALUES via
 * `truncateUtf8`; a key has no reason to be less careful and leave a lone
 * surrogate in text that gets persisted.
 */
function clampObjectKey(key: string): string {
  return sliceCodeUnits(key, MAX_SHORT_TEXT_LENGTH);
}

/**
 * Slice `text` to at most `maxUnits` UTF-16 code units WITHOUT splitting a
 * surrogate pair.
 *
 * ISS-5797 (wongk review): every code-unit slice in this module has to go
 * through here. The key clamp above guarded its own boundary, but
 * {@link takeDistinctKey} then re-sliced the same key five units shorter with no
 * guard — so a key whose astral character straddled THAT boundary came back as a
 * lone high surrogate, reintroducing exactly the corruption the first guard
 * prevents. One helper, used by both, is what makes that unrepeatable.
 */
function sliceCodeUnits(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) {
    return text;
  }
  const sliced = text.slice(0, Math.max(0, maxUnits));
  const lastUnit = sliced.charCodeAt(sliced.length - 1);
  const endsOnLoneHighSurrogate = lastUnit >= 0xd8_00 && lastUnit <= 0xdb_ff;
  return endsOnLoneHighSurrogate ? sliced.slice(0, -1) : sliced;
}

/**
 * Truncate to a UTF-16 code-unit cap and mark the result as partial. Used for
 * the plain `z.string().max(...)` fields, whose cap Zod also measures in code
 * units.
 */
function truncateMarkedCodeUnits(text: string, maxUnits: number): string {
  if (maxUnits < TRUNCATED_TEXT_SUFFIX.length) {
    return sliceCodeUnits(text, maxUnits);
  }
  const kept = sliceCodeUnits(text, maxUnits - TRUNCATED_TEXT_SUFFIX.length);
  return `${kept}${TRUNCATED_TEXT_SUFFIX}`;
}

/**
 * Truncate to a UTF-8 BYTE cap and mark the result as partial. Used for the
 * schema-`unknown` payloads, whose bound {@link isBoundedUnknownValue} measures
 * in bytes.
 */
function truncateMarkedBytes(text: string, maxBytes: number): string {
  const suffixBytes = Buffer.byteLength(TRUNCATED_TEXT_SUFFIX);
  if (maxBytes < suffixBytes) {
    return truncateUtf8(text, maxBytes);
  }
  return `${truncateUtf8(text, maxBytes - suffixBytes)}${TRUNCATED_TEXT_SUFFIX}`;
}

/**
 * Return `key`, or the first free `key~N` when truncation already claimed it.
 * Bounded work: at most `MAX_UNKNOWN_OBJECT_KEYS` entries reach here, so the
 * ordinal stays short and the trimmed base keeps the result within the cap.
 */
function takeDistinctKey(taken: Set<string>, key: string): string {
  if (!taken.has(key)) {
    taken.add(key);
    return key;
  }
  const base = sliceCodeUnits(
    key,
    MAX_SHORT_TEXT_LENGTH - CLAMPED_KEY_SUFFIX_HEADROOM
  );
  let ordinal = 2;
  while (taken.has(`${base}~${ordinal}`)) {
    ordinal++;
  }
  const distinct = `${base}~${ordinal}`;
  taken.add(distinct);
  return distinct;
}

/**
 * Truncate one schema-bounded LONG-text field to its byte cap.
 *
 * `unknown` payloads are not the only way a session can fail this boundary: the
 * response schema also caps a dozen plain `z.string()` fields at
 * `maxLongTextLength`, and those are just as reachable (an assistant message
 * that echoes a large file, a captured skill definition, a hook command). An
 * oversized one of those fails the SAME `.strict()` response wholesale and
 * re-fails the source on every collector cycle — the identical defect through a
 * different field, so it is fixed here rather than left for the next incident.
 *
 * Absence is preserved exactly: `null` stays `null`, `undefined` stays
 * `undefined` (never materialized into `null`), and an in-bounds string returns
 * BY REFERENCE so the common case allocates nothing.
 *
 * ISS-5797 (wongk review): the cap is measured in UTF-16 CODE UNITS, because
 * that is what `z.string().max(MAX_LONG_TEXT_LENGTH)` measures on the consumer
 * side. Measuring bytes here instead made the producer strictly stricter than
 * the schema, so a schema-VALID 1.1M-character string of `é` (1.1M code units,
 * 2.2M bytes) was truncated for no reason — content destroyed to satisfy a bound
 * that was never going to reject it. The schema-`unknown` payloads keep their
 * byte measure, because {@link isBoundedUnknownValue} — the predicate
 * `boundedUnknownValueSchema` actually enforces — measures bytes. Each clamp
 * matches the bound it has to satisfy; that is the whole point.
 */
function clampLongText<Value extends string | null | undefined>(
  value: Value
): Value {
  if (typeof value !== "string") {
    return value;
  }
  if (value.length <= MAX_LONG_TEXT_LENGTH) {
    return value;
  }
  return truncateMarkedCodeUnits(value, MAX_LONG_TEXT_LENGTH) as Value;
}

/**
 * Bound every payload a session can carry that the response schema constrains:
 * the schema-`unknown` values AND the capped long-text fields. Run BEFORE
 * `sliceSessionArrays`, which trims array lengths and would otherwise leave an
 * oversized tool input in place. Sessions whose payloads are already bounded are
 * still rebuilt at the top level, but their leaf values pass through by
 * reference.
 */
export function clampSessionPayloads(
  session: NormalizedSession
): NormalizedSession {
  const clamped: NormalizedSession = {
    ...session,
    name: clampLongText(session.name),
    teams: session.teams.map((item) => clampUnknownValue(item, 0)),
    toolUses: session.toolUses.map((toolUse) => clampToolUsePayloads(toolUse)),
    compactions: session.compactions.map((item) => clampUnknownValue(item, 0)),
    messages: session.messages.map((message) =>
      message.text === clampLongText(message.text)
        ? message
        : { ...message, text: clampLongText(message.text) }
    ),
    apiErrors: session.apiErrors.map((apiError) =>
      apiError.message === clampLongText(apiError.message)
        ? apiError
        : { ...apiError, message: clampLongText(apiError.message) }
    ),
    toolResultErrors: session.toolResultErrors.map((toolResultError) =>
      toolResultError.content === clampLongText(toolResultError.content)
        ? toolResultError
        : {
            ...toolResultError,
            content: clampLongText(toolResultError.content),
          }
    ),
    hooks: session.hooks.map((hook) =>
      hook.command === clampLongText(hook.command)
        ? hook
        : { ...hook, command: clampLongText(hook.command) }
    ),
    prLinks: session.prLinks.map((prLink) => clampPrRefPayloads(prLink)),
    artifacts: {
      ...session.artifacts,
      prs: session.artifacts.prs.map((prRef) => clampPrRefPayloads(prRef)),
    },
    slashCommands: session.slashCommands.map((slashCommand) =>
      clampDefinitionSnapshotOwner(slashCommand)
    ),
    skills: session.skills.map((skill) => clampDefinitionSnapshotOwner(skill)),
    usageExtras: {
      ...session.usageExtras,
      service_tiers: session.usageExtras.service_tiers.map((item) =>
        clampUnknownValue(item, 0)
      ),
      speeds: session.usageExtras.speeds.map((item) =>
        clampUnknownValue(item, 0)
      ),
      inference_geos: session.usageExtras.inference_geos.map((item) =>
        clampUnknownValue(item, 0)
      ),
    },
  };
  if (session.plans) {
    clamped.plans = session.plans.map((plan) =>
      plan.content === clampLongText(plan.content)
        ? plan
        : { ...plan, content: clampLongText(plan.content) }
    );
  }
  if (session.subagents) {
    clamped.subagents = session.subagents.map((subagent) =>
      clampSubagentPayloads(subagent)
    );
  }
  return clamped;
}

/**
 * Truncate the captured definition body on any record that carries one
 * (`toolUse`, `subagent`, `slashCommand`, `skill`). A captured definition is
 * verbatim file content, so it is the most likely long-text field to blow the
 * cap after a message body.
 */
function clampDefinitionSnapshotOwner<
  Owner extends { definitionSnapshot?: NormalizedDefinitionSnapshot },
>(owner: Owner): Owner {
  const snapshot = owner.definitionSnapshot;
  if (!snapshot) {
    return owner;
  }
  const content = clampLongText(snapshot.content);
  if (content === snapshot.content) {
    return owner;
  }
  return { ...owner, definitionSnapshot: { ...snapshot, content } };
}

function clampPrRefPayloads(prRef: NormalizedPrRef): NormalizedPrRef {
  const url = clampLongText(prRef.url);
  if (url === prRef.url) {
    return prRef;
  }
  return { ...prRef, url };
}

function clampSubagentPayloads(
  subagent: NormalizedSubagent
): NormalizedSubagent {
  const clamped: NormalizedSubagent = clampDefinitionSnapshotOwner({
    ...subagent,
    task: clampLongText(subagent.task),
    toolUses: subagent.toolUses?.map((toolUse) =>
      clampToolUsePayloads(toolUse)
    ),
  });
  if (subagent.metadata) {
    // Bound the KEYS and the ENTRY COUNT, not just the values. `metadata` is the
    // one unknown-carrying field whose outer container is a Zod `z.record`
    // rather than a `boundedUnknownValueSchema`, so neither its keys nor its
    // size are bounded by `isBoundedUnknownValue` — and `z.record` has no
    // entry-count cap to fall back on, `sliceSessionArrays` never touches this
    // field, and `summarizeWorkerResponsePayload` counts array elements but not
    // record entries, so the response-wide budget would not catch it either.
    // Without this, a metadata map of 200k small entries had NO bound at all,
    // while every sibling unknown record is capped at 250. Values are clamped at
    // depth 0 because that is the depth the schema validates each one at.
    clamped.metadata = clampRecordEntries(subagent.metadata, 0);
  }
  return clamped;
}

function clampToolUsePayloads(toolUse: NormalizedToolUse): NormalizedToolUse {
  const input =
    toolUse.input === undefined
      ? undefined
      : clampUnknownValue(toolUse.input, 0);
  const output =
    toolUse.output === undefined
      ? undefined
      : clampUnknownValue(toolUse.output, 0);
  if (input === toolUse.input && output === toolUse.output) {
    return clampDefinitionSnapshotOwner(toolUse);
  }
  return clampDefinitionSnapshotOwner({ ...toolUse, input, output });
}

/**
 * How a normalized field relates to the worker boundary's schema-`unknown`
 * payloads. Used only by the compile-time coverage tables below.
 */
export const UnknownPayloadCoverage = {
  /** Carries a schema-`unknown` payload that the clamp above bounds directly. */
  Direct: "direct",
  /** Delegates to another coverage table in this file. */
  Nested: "nested",
  /**
   * Carries no schema-`unknown` payload, but does carry a capped long-text
   * field — on itself or on its elements — that `clampLongText` truncates.
   */
  Text: "text",
  /** Carries nothing the response schema caps; nothing for the clamp to do. */
  None: "none",
} as const;
export type UnknownPayloadCoverage =
  (typeof UnknownPayloadCoverage)[keyof typeof UnknownPayloadCoverage];

/**
 * The ONLY marker legal for one field, given its declared type. A field whose
 * type can hold a schema-`unknown` payload (`unknown`, `unknown[]`, or
 * `Record<string, unknown>`) MUST be `Direct` — it cannot be quietly written off
 * as `None`, which is the mislabelling that would otherwise reintroduce
 * FEA-3701 with no compile-time or test signal. Every other field is `None` or
 * `Nested`, and cannot be labelled `Direct` because the clamp would have nothing
 * to bind to. Both mistakes are therefore `tsc` failures, not review catches.
 */
type UnknownPayloadCoverageFor<Value> =
  CarriesUnknownPayload<Value> extends true
    ? typeof UnknownPayloadCoverage.Direct
    :
        | typeof UnknownPayloadCoverage.None
        | typeof UnknownPayloadCoverage.Nested
        | typeof UnknownPayloadCoverage.Text;

/**
 * True for the three ways this boundary spells "arbitrary payload". NOTE: it
 * recognizes those three SPELLINGS, not every structurally-equivalent type — a
 * future field typed as a named recursive JSON alias, or as
 * `Record<string, unknown[]>`, would resolve `false` here and could then be
 * mislabelled `None` with no `tsc` complaint. If you add an unknown-content
 * field, spell it `unknown`, `unknown[]`, or `Record<string, unknown>` so this
 * guard can see it.
 */
type CarriesUnknownPayload<Value> = unknown extends Value
  ? true
  : unknown[] extends Value
    ? true
    : Record<string, unknown> extends Value
      ? true
      : false;

/**
 * FEA-3701 guard, clamp half. `assertWorkerSchemaKeysCovered` in the protocol
 * module keeps the SCHEMA taught about every normalized key; these tables keep
 * the PRODUCER CLAMP taught about it too. Because callers use `satisfies` over a
 * fresh object literal, both directions fail `tsc`: a key added to the
 * normalized type is missing here, and a key removed from it is an excess
 * property here.
 *
 * The tables declare intent, and the type above stops a field being labelled
 * `Direct` when it cannot hold an unknown payload. What they cannot prove on
 * their own is that a field marked `Direct`/`Nested` is genuinely degraded at
 * runtime — `historical-parse-worker-bounded-value.test.ts` executes the clamp
 * over an out-of-bounds value for each such field to close that gap. Add a case
 * there whenever you add a marker here.
 */
type UnknownPayloadCoverageOf<T> = {
  [Key in keyof T]-?: UnknownPayloadCoverageFor<T[Key]>;
};

export const SESSION_UNKNOWN_PAYLOAD_COVERAGE = {
  sessionId: UnknownPayloadCoverage.None,
  name: UnknownPayloadCoverage.Text,
  cwd: UnknownPayloadCoverage.None,
  model: UnknownPayloadCoverage.None,
  modelIsFallback: UnknownPayloadCoverage.None,
  version: UnknownPayloadCoverage.None,
  slug: UnknownPayloadCoverage.None,
  gitBranch: UnknownPayloadCoverage.None,
  startedAt: UnknownPayloadCoverage.None,
  endedAt: UnknownPayloadCoverage.None,
  teams: UnknownPayloadCoverage.Direct,
  userMessages: UnknownPayloadCoverage.None,
  assistantMessages: UnknownPayloadCoverage.None,
  tokensByModel: UnknownPayloadCoverage.None,
  messageTimestamps: UnknownPayloadCoverage.None,
  toolUses: UnknownPayloadCoverage.Nested,
  importMode: UnknownPayloadCoverage.None,
  invocationDefinitionEvidence: UnknownPayloadCoverage.None,
  subagents: UnknownPayloadCoverage.Nested,
  plans: UnknownPayloadCoverage.Text,
  parseQuality: UnknownPayloadCoverage.None,
  compactions: UnknownPayloadCoverage.Direct,
  apiErrors: UnknownPayloadCoverage.Text,
  fileModifiedAt: UnknownPayloadCoverage.None,
  turnDurations: UnknownPayloadCoverage.None,
  entrypoint: UnknownPayloadCoverage.None,
  permissionMode: UnknownPayloadCoverage.None,
  thinkingBlockCount: UnknownPayloadCoverage.None,
  toolResultErrors: UnknownPayloadCoverage.Text,
  usageExtras: UnknownPayloadCoverage.Nested,
  messages: UnknownPayloadCoverage.Text,
  tokenSeries: UnknownPayloadCoverage.None,
  codexLastTokenUsage: UnknownPayloadCoverage.None,
  diffStats: UnknownPayloadCoverage.None,
  slashCommands: UnknownPayloadCoverage.Text,
  skills: UnknownPayloadCoverage.Text,
  hooks: UnknownPayloadCoverage.Text,
  artifacts: UnknownPayloadCoverage.Text,
  prLinks: UnknownPayloadCoverage.Text,
  modelContextWindow: UnknownPayloadCoverage.None,
  codexRateLimits: UnknownPayloadCoverage.None,
  codexForkedFromId: UnknownPayloadCoverage.None,
  codexProtocolSupport: UnknownPayloadCoverage.None,
  endedOnUnrecoveredError: UnknownPayloadCoverage.None,
} satisfies UnknownPayloadCoverageOf<NormalizedSession>;

export const SESSION_USAGE_EXTRAS_UNKNOWN_PAYLOAD_COVERAGE = {
  service_tiers: UnknownPayloadCoverage.Direct,
  speeds: UnknownPayloadCoverage.Direct,
  inference_geos: UnknownPayloadCoverage.Direct,
  reasoning_output_tokens: UnknownPayloadCoverage.None,
  web_search_requests: UnknownPayloadCoverage.None,
} satisfies UnknownPayloadCoverageOf<NormalizedSession["usageExtras"]>;

export const TOOL_USE_UNKNOWN_PAYLOAD_COVERAGE = {
  name: UnknownPayloadCoverage.None,
  rawName: UnknownPayloadCoverage.None,
  normalizedName: UnknownPayloadCoverage.None,
  kind: UnknownPayloadCoverage.None,
  timestamp: UnknownPayloadCoverage.None,
  input: UnknownPayloadCoverage.Direct,
  output: UnknownPayloadCoverage.Direct,
  isError: UnknownPayloadCoverage.None,
  mcpServer: UnknownPayloadCoverage.None,
  mcpMethod: UnknownPayloadCoverage.None,
  skillName: UnknownPayloadCoverage.None,
  diffDelta: UnknownPayloadCoverage.None,
  id: UnknownPayloadCoverage.None,
  providerToolUseId: UnknownPayloadCoverage.None,
  definitionSnapshot: UnknownPayloadCoverage.Text,
  resultTimestamp: UnknownPayloadCoverage.None,
  gitBranch: UnknownPayloadCoverage.None,
  subagentId: UnknownPayloadCoverage.None,
} satisfies UnknownPayloadCoverageOf<NormalizedToolUse>;

export const SUBAGENT_UNKNOWN_PAYLOAD_COVERAGE = {
  id: UnknownPayloadCoverage.None,
  parentId: UnknownPayloadCoverage.None,
  childSessionId: UnknownPayloadCoverage.None,
  name: UnknownPayloadCoverage.None,
  rawName: UnknownPayloadCoverage.None,
  normalizedName: UnknownPayloadCoverage.None,
  type: UnknownPayloadCoverage.None,
  task: UnknownPayloadCoverage.Text,
  startedAt: UnknownPayloadCoverage.None,
  endedAt: UnknownPayloadCoverage.None,
  status: UnknownPayloadCoverage.None,
  nativeSubagentId: UnknownPayloadCoverage.None,
  toolUses: UnknownPayloadCoverage.Nested,
  tokensByModel: UnknownPayloadCoverage.None,
  tokenSeries: UnknownPayloadCoverage.None,
  definitionSnapshot: UnknownPayloadCoverage.Text,
  metadata: UnknownPayloadCoverage.Direct,
} satisfies UnknownPayloadCoverageOf<NormalizedSubagent>;

/**
 * The floor the response-wide text strategy may shrink a string to.
 *
 * Below this cap the strategy would start truncating SHORT-capped fields, which
 * at this boundary are identifiers and paths — `sessionId`, `cwd`, `slug`,
 * `gitBranch`, timestamps. Shortening those does not degrade a payload, it
 * corrupts identity: two distinct sessions can truncate to the same
 * `sessionId` and silently merge downstream. The strategy stops here and lets an
 * over-budget response fail honestly instead.
 */
export const MIN_RESPONSE_TEXT_CAP = MAX_SHORT_TEXT_LENGTH;

/**
 * Shorten EVERY string in an already-clamped session to `maxUnits` UTF-16 code
 * units, structurally unchanged otherwise.
 *
 * ISS-5797 (wongk review): the response-wide budget was only ever defended by
 * shrinking ARRAYS, so a handful of sessions each carrying a 2MB fixed field
 * (`name` is the reachable one) stayed over the 8MB aggregate budget after the
 * array limit reached zero — the whole response then failed and the source
 * re-failed on every collector cycle, which is the exact defect this change
 * exists to remove. This is the final strategy for those fixed fields.
 *
 * Deliberately field-agnostic: it walks the value tree rather than enumerating
 * fields, so a new long-text field is covered the day it is added instead of the
 * day someone remembers to list it here. `maxUnits` is floored at
 * {@link MIN_RESPONSE_TEXT_CAP} by the caller, so identifier-width fields are
 * never touched.
 */
export function shrinkSessionText(
  session: NormalizedSession,
  maxUnits: number
): NormalizedSession {
  return shrinkTextValues(session, maxUnits) as NormalizedSession;
}

function shrinkTextValues(value: unknown, maxUnits: number): unknown {
  if (typeof value === "string") {
    return value.length <= maxUnits
      ? value
      : truncateMarkedCodeUnits(value, maxUnits);
  }
  if (Array.isArray(value)) {
    return value.map((item) => shrinkTextValues(item, maxUnits));
  }
  if (isPlainRecord(value)) {
    // Keys are left alone: they are the schema's field names here, and the
    // record's own key bound was already applied by the clamp above.
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        shrinkTextValues(item, maxUnits),
      ])
    );
  }
  return value;
}
