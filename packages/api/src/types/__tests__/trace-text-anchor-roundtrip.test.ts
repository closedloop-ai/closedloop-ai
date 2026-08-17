/**
 * @file trace-text-anchor-roundtrip.test.ts
 * @description ISS-5589 — round-trip regression coverage for the
 * {@link traceTextAnchorSchema} wire boundary.
 *
 * `TraceTextAnchor` crosses a real trust boundary: the trace renderer emits it,
 * `apps/api` persists it in comment metadata, and
 * `apps/desktop/src/main/dashboard/agent-dashboard-trace-comment-sync.ts` reads
 * it back on the desktop side.
 *
 * What was already covered before this file: `service-mcp-projection.test.ts`
 * parses a populated anchor and persists it through `traceCommentsService.create`,
 * and `trace-comment-metadata.test.ts` exercises the read parser. Both are
 * happy-path/projection tests. What was missing — and what this file adds — is
 * EXHAUSTIVE coverage of the contract's shape (every optional present, absent,
 * and explicitly null, including inside the nested `actor`) plus the NEGATIVE
 * cases: each declared bound is asserted to actually reject, rather than merely
 * being declared on the schema.
 *
 * The failure this guards is the FEA-3701 class recorded in the root
 * `AGENTS.md`, in its QUIETER form. `traceTextAnchorSchema` is a plain
 * `z.object`, not `.strict()`, so an untaught field is not rejected — it is
 * silently STRIPPED. A conditionally-emitted anchor field that the producer
 * starts sending but the schema was never taught would therefore vanish on
 * every persist and every read, with nothing failing anywhere. A hand-written
 * minimal happy-path fixture would sail straight past that, which is exactly
 * why the maximal payload below carries every optional, including the nested
 * nullable `actor`.
 */
import { describe, expect, it } from "vitest";
import type { TraceTextAnchor } from "../comment";
import {
  TRACE_COMMENT_ANCHOR_TEXT_MAX_LENGTH,
  TRACE_COMMENT_ID_MAX_LENGTH,
  traceTextAnchorSchema,
} from "../comment";

/**
 * A realistic MAXIMAL anchor: every optional populated, `actor` present with
 * both of its nullable members set. Typed as `TraceTextAnchor` so that removing
 * a field from the contract also fails this file at `tsc`, not just at runtime.
 *
 * Maintenance note: `tsc` does NOT force this fixture to grow when a new
 * OPTIONAL field is added to `TraceTextAnchor` (omitting an optional is legal),
 * so "maximal" can silently drift. The schema side is still protected — the
 * `satisfies Record<keyof TraceTextAnchor, z.ZodTypeAny>` guard on
 * `traceTextAnchorShape` fails `tsc` until the new field is taught to the
 * schema. When you add an optional field, populate it here too.
 */
const MAXIMAL_ANCHOR: TraceTextAnchor = {
  traceId: "trace-9f2c",
  turnId: "turn-004",
  row: 12,
  selectedText: "the collector dropped the session",
  sourceText: "…and then the collector dropped the session on retry…",
  startOffset: 8,
  endOffset: 41,
  sessionId: "sess-7731",
  actor: { name: "claude", human: "mike" },
};

/**
 * The narrowest anchor the contract allows: every optional absent.
 *
 * Its coordinates are kept CONSISTENT (`sourceText.slice(startOffset,
 * endOffset) === selectedText`) because that is the invariant the producer in
 * `packages/app/agents/components/detail/session-trace.tsx` enforces before it
 * ever emits an anchor — it returns `null` when the slice does not match. A
 * shared base fixture that violates it would make every spread below start from
 * a payload the real system cannot produce.
 */
const MINIMAL_ANCHOR: TraceTextAnchor = {
  traceId: "trace-9f2c",
  turnId: "turn-004",
  row: 0,
  selectedText: "x",
  sourceText: "x",
  startOffset: 0,
  endOffset: 1,
};

describe("traceTextAnchorSchema round-trip", () => {
  it("round-trips a maximal anchor with every optional field intact", () => {
    const parsed = traceTextAnchorSchema.parse(MAXIMAL_ANCHOR);
    // deep equality, not field spot-checks: a silently stripped key fails here.
    expect(parsed).toEqual(MAXIMAL_ANCHOR);
  });

  it("keeps absent optionals OMITTED rather than materializing them as null", () => {
    const parsed = traceTextAnchorSchema.parse(MINIMAL_ANCHOR);
    // AGENTS.md: an absent optional stays omitted on a cross-surface payload; it
    // is never serialized as `null` unless the receiving contract declares the
    // field nullable. `hasOwn` (not `=== null`) is what catches a future
    // `.default(null)` or `.nullable()` regression.
    expect(Object.hasOwn(parsed, "sessionId")).toBe(false);
    expect(Object.hasOwn(parsed, "actor")).toBe(false);
  });

  it("preserves an explicit null on the nullable optionals", () => {
    // `sessionId` and `actor` are `?: T | null`, so an explicit null is a
    // DISTINCT, legal state from absence and must survive the round-trip.
    const parsed = traceTextAnchorSchema.parse({
      ...MINIMAL_ANCHOR,
      sessionId: null,
      actor: null,
    });
    expect(parsed.sessionId).toBeNull();
    expect(parsed.actor).toBeNull();
  });

  it("preserves nulls INSIDE a present actor", () => {
    const parsed = traceTextAnchorSchema.parse({
      ...MAXIMAL_ANCHOR,
      actor: { name: null, human: null },
    });
    expect(parsed.actor).toEqual({ name: null, human: null });
  });

  it("silently STRIPS an unknown field from a newer producer", () => {
    // Pinning current behaviour deliberately. The schema is not `.strict()`, so
    // a version-skewed producer's extra field degrades (dropped) rather than
    // sinking the whole anchor. That is the right call for a wire contract per
    // the AGENTS.md cross-repo rule — but it is also precisely why the
    // keys-covered guard on the shape matters: nothing at runtime would ever
    // tell us a field we OWN went untaught.
    const parsed = traceTextAnchorSchema.parse({
      ...MAXIMAL_ANCHOR,
      anchorRevision: 3,
    });
    expect(parsed).toEqual(MAXIMAL_ANCHOR);
    expect(Object.hasOwn(parsed, "anchorRevision")).toBe(false);
  });

  it("rejects an inverted offset range", () => {
    const result = traceTextAnchorSchema.safeParse({
      ...MINIMAL_ANCHOR,
      startOffset: 9,
      endOffset: 4,
    });
    expect(result.success).toBe(false);
  });

  it("accepts an empty sourceText (only selectedText carries .min(1))", () => {
    // Deliberate asymmetry in the contract: `selectedText` is `.min(1)` but
    // `sourceText` is not, so a blank trace row is representable. Pinned so the
    // bound is not "tidied" onto sourceText, which would reject persisted rows.
    const result = traceTextAnchorSchema.safeParse({
      ...MINIMAL_ANCHOR,
      selectedText: "x",
      sourceText: "",
      startOffset: 0,
      endOffset: 0,
    });
    expect(result.success).toBe(true);
  });

  it("does NOT enforce selectedText/sourceText coordinate consistency", () => {
    // Characterizing deliberate scope, not endorsing the gap. The
    // `sourceText.slice(startOffset, endOffset) === selectedText` invariant is
    // enforced by the PRODUCER
    // (packages/app/agents/components/detail/session-trace.tsx returns null when
    // the slice does not match), never by this schema.
    //
    // It must stay that way: the same schema is the READ parser for already
    // persisted metadata, and a failed parse makes mapTraceCommentRow drop the
    // comment entirely rather than surface an error — so adding the refinement
    // here would silently disappear any historical row whose stored text drifted
    // from its offsets. Adding it is a migration, not a validation tweak.
    const inconsistent = {
      ...MINIMAL_ANCHOR,
      selectedText: "zzz",
      sourceText: "abcdef",
      startOffset: 0,
      endOffset: 3,
    };
    expect(traceTextAnchorSchema.safeParse(inconsistent).success).toBe(true);
  });
});

/** Parse outcome only — the assertion itself stays inside each `it()`. */
function accepts(anchor: unknown): boolean {
  return traceTextAnchorSchema.safeParse(anchor).success;
}

function withoutKey(key: keyof TraceTextAnchor): Record<string, unknown> {
  const partial: Record<string, unknown> = { ...MINIMAL_ANCHOR };
  Reflect.deleteProperty(partial, key);
  return partial;
}

/**
 * Malformed input IS reachable here: the anchor is read back out of persisted
 * comment metadata and off the wire from clients this repo does not control, so
 * per the AGENTS.md trust-boundary carve-out these are not type-forbidden cases.
 * Each bound below exists to stop hostile or oversized input being stored; these
 * assert the bound is actually enforced rather than merely declared.
 */
describe("traceTextAnchorSchema rejects malformed input", () => {
  it("rejects a missing required field (truncated or corrupt persisted row)", () => {
    const required = [
      "traceId",
      "turnId",
      "row",
      "selectedText",
      "sourceText",
      "startOffset",
      "endOffset",
    ] as const;
    expect(required.map((key) => accepts(withoutKey(key)))).toEqual(
      required.map(() => false)
    );
  });

  it("rejects empty strings on the .min(1) identity fields", () => {
    expect(accepts({ ...MINIMAL_ANCHOR, traceId: "" })).toBe(false);
    expect(accepts({ ...MINIMAL_ANCHOR, turnId: "" })).toBe(false);
    expect(accepts({ ...MINIMAL_ANCHOR, selectedText: "" })).toBe(false);
  });

  it("rejects text and identifiers beyond their stored-size caps", () => {
    const overText = "x".repeat(TRACE_COMMENT_ANCHOR_TEXT_MAX_LENGTH + 1);
    const overId = "x".repeat(TRACE_COMMENT_ID_MAX_LENGTH + 1);
    expect(accepts({ ...MINIMAL_ANCHOR, selectedText: overText })).toBe(false);
    expect(accepts({ ...MINIMAL_ANCHOR, sourceText: overText })).toBe(false);
    expect(accepts({ ...MINIMAL_ANCHOR, traceId: overId })).toBe(false);
    expect(accepts({ ...MINIMAL_ANCHOR, turnId: overId })).toBe(false);
  });

  it("rejects over-cap values on the OPTIONAL identifiers too", () => {
    // These are the caps the required-field cases above cannot reach. Without
    // them, deleting the `.max(TRACE_COMMENT_ID_MAX_LENGTH)` from `sessionId` or
    // from either `actor` member leaves the whole suite green — the bound would
    // be declared but never proven, and unbounded text would reach the column.
    const overId = "x".repeat(TRACE_COMMENT_ID_MAX_LENGTH + 1);
    expect(accepts({ ...MINIMAL_ANCHOR, sessionId: overId })).toBe(false);
    expect(
      accepts({ ...MINIMAL_ANCHOR, actor: { name: overId, human: null } })
    ).toBe(false);
    expect(
      accepts({ ...MINIMAL_ANCHOR, actor: { name: null, human: overId } })
    ).toBe(false);
  });

  it("rejects non-integer and negative row/offset values", () => {
    expect(accepts({ ...MINIMAL_ANCHOR, row: 1.5 })).toBe(false);
    expect(accepts({ ...MINIMAL_ANCHOR, row: -1 })).toBe(false);
    expect(accepts({ ...MINIMAL_ANCHOR, startOffset: -1, endOffset: 0 })).toBe(
      false
    );
    expect(accepts({ ...MINIMAL_ANCHOR, startOffset: 0, endOffset: 2.5 })).toBe(
      false
    );
  });

  it("rejects a grossly malformed top-level value", () => {
    const values: unknown[] = [null, undefined, "anchor", 7, [], true];
    expect(values.map(accepts)).toEqual(values.map(() => false));
  });
});
