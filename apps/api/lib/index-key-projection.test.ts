/**
 * ISS-8069: the index-key projection's own contract.
 *
 * Every fixture here is built from literal bytes, never from
 * `INDEX_KEY_MAX_BYTES` arithmetic against the module under test — a fixture
 * derived from the constant it polices moves with the bug. The one place the
 * constant appears is the assertion that a projected value FITS it, which is the
 * property being claimed rather than the input being chosen.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  countProjected,
  INDEX_KEY_MAX_BYTES,
  INDEX_KEY_PROJECTION_MARKER,
  indexKeyCandidates,
  isReservedIndexKey,
  projectIndexKey,
  projectNullableIndexKey,
  resolveStoredIndexKey,
  storedIndexKeyCandidates,
} from "./index-key-projection";

/** A real sha256 hex — 64 ASCII bytes, the shape these columns actually carry. */
const REALISTIC_CONTENT_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** `owner/repo` at GitHub's own ceiling (39 + 1 + 100). */
const LONGEST_REAL_REPOSITORY = `${"o".repeat(39)}/${"r".repeat(100)}`;

/** Past the 2704-byte btree index-tuple limit on its own. */
const OVER_TUPLE_LIMIT = "z".repeat(4000);

/** Multibyte: 2000 code points, 3 bytes each in UTF-8 — 6000 bytes. */
const MULTIBYTE_OVER_LIMIT = "中".repeat(2000);

/**
 * Two over-long identities differing ONLY by which unpaired surrogate sits
 * early enough to be inside the retained head. 430 ASCII bytes puts it there
 * with room to spare under the head budget.
 */
const SURROGATE_LEFT = `${"z".repeat(430)}\uD800${OVER_TUPLE_LIMIT}`;
const SURROGATE_RIGHT = `${"z".repeat(430)}\uD801${OVER_TUPLE_LIMIT}`;

/**
 * The head exactly as Postgres keeps it: a `text` column is UTF-8, so the
 * unpaired surrogate the head still carries in JS is stored as U+FFFD.
 */
function storedHeadOf(value: string): string {
  const projected = projectIndexKey(value).value;
  const head = projected.slice(
    0,
    projected.indexOf(INDEX_KEY_PROJECTION_MARKER)
  );
  return Buffer.from(head, "utf8").toString("utf8");
}

describe("projectIndexKey — values that already fit are untouched", () => {
  it.each([
    ["a sha256 hex", REALISTIC_CONTENT_HASH],
    ["the longest real repository name", LONGEST_REAL_REPOSITORY],
    ["a harness name", "claude-code"],
    ["a model name", "claude-opus-4-20250514"],
    ["a session uuid", "0f5a1c2d-3e4b-4a1d-9b7e-2c9f0b715f4e"],
    ["an empty string", ""],
  ])(
    "passes %s through verbatim and reports no projection",
    (_label, value) => {
      const result = projectIndexKey(value);

      expect(result.value).toBe(value);
      expect(result.projected).toBe(false);
    }
  );
});

describe("projectIndexKey — values that cannot fit a btree tuple", () => {
  it("bounds a value past the 2704-byte index-tuple limit and says it bound", () => {
    const result = projectIndexKey(OVER_TUPLE_LIMIT);

    expect(result.projected).toBe(true);
    expect(Buffer.byteLength(result.value, "utf8")).toBeLessThanOrEqual(
      INDEX_KEY_MAX_BYTES
    );
    // Well under 2704 even when three of these share one tuple.
    expect(Buffer.byteLength(result.value, "utf8") * 3).toBeLessThan(2704);
  });

  it("bounds by BYTES, not characters, so multibyte text cannot slip through", () => {
    // 2000 characters — inside any 512-CHARACTER cap — but 6000 bytes, which is
    // more than twice the whole tuple budget. This is the case a character cap
    // cannot see.
    expect(MULTIBYTE_OVER_LIMIT.length).toBe(2000);
    expect(Buffer.byteLength(MULTIBYTE_OVER_LIMIT, "utf8")).toBe(6000);

    const result = projectIndexKey(MULTIBYTE_OVER_LIMIT);

    expect(result.projected).toBe(true);
    expect(Buffer.byteLength(result.value, "utf8")).toBeLessThanOrEqual(
      INDEX_KEY_MAX_BYTES
    );
  });

  it("never emits a replacement character when the cut lands mid-sequence", () => {
    const result = projectIndexKey(MULTIBYTE_OVER_LIMIT);

    expect(result.value).not.toContain("�");
  });

  it("is deterministic, so a retry and a later re-sync resolve to the same row", () => {
    const first = projectIndexKey(OVER_TUPLE_LIMIT);
    const second = projectIndexKey(OVER_TUPLE_LIMIT);

    expect(second.value).toBe(first.value);
  });

  it("keeps two distinct over-long identities distinct", () => {
    // The defining risk of a plain truncation on an identity column: these two
    // share their first 4000 characters, so any prefix-only bound folds two
    // different sessions onto one row.
    const left = `${OVER_TUPLE_LIMIT}-alpha`;
    const right = `${OVER_TUPLE_LIMIT}-beta`;

    expect(projectIndexKey(left).value).not.toBe(projectIndexKey(right).value);
  });

  it("carries the marker and the digest of the WHOLE original", () => {
    const result = projectIndexKey(OVER_TUPLE_LIMIT);
    // UTF-16LE, not UTF-8, and that is the contract — see the unpaired-surrogate
    // case below for why the digest cannot be taken over a lossy encoding.
    const digest = createHash("sha256")
      .update(Buffer.from(OVER_TUPLE_LIMIT, "utf16le"))
      .digest("hex");

    expect(result.value).toContain(INDEX_KEY_PROJECTION_MARKER);
    expect(result.value.endsWith(digest)).toBe(true);
    // The head is retained, so the stored key still reads as the value it came
    // from rather than as an opaque hash.
    expect(result.value.startsWith("zzzz")).toBe(true);
  });

  it("keeps two identities distinct when the STORED head collapses them", () => {
    // ISS-8069 (review, codex): `JSON.parse` accepts a `\uD800` escape, so an
    // accepted `z.string()` reaches this module carrying an unpaired surrogate.
    // Postgres cannot store one, so both heads land as the same U+FFFD bytes —
    // asserted below, because it is what makes the digest load-bearing rather
    // than belt-and-braces. Node's UTF-8 encoder collapses the surrogate the
    // same way, so a UTF-8 digest collided too and the whole projected key
    // matched: two distinct sessions MERGED onto one row by the upsert.
    //
    // The surrogate sits inside the retained head on purpose. Past the head it
    // would only ever reach the digest, and the test would pass without
    // exercising the collapse it names.
    expect(SURROGATE_LEFT).not.toBe(SURROGATE_RIGHT);
    expect(storedHeadOf(SURROGATE_LEFT)).toBe(storedHeadOf(SURROGATE_RIGHT));

    expect(projectIndexKey(SURROGATE_LEFT).value).not.toBe(
      projectIndexKey(SURROGATE_RIGHT).value
    );
  });
});

describe("projectNullableIndexKey", () => {
  it("passes an absent value through as null and counts no projection", () => {
    expect(projectNullableIndexKey(null)).toEqual({
      value: null,
      projected: false,
    });
    expect(projectNullableIndexKey(undefined)).toEqual({
      value: null,
      projected: false,
    });
  });

  it("projects a present over-long value exactly like the required form", () => {
    expect(projectNullableIndexKey(OVER_TUPLE_LIMIT)).toEqual(
      projectIndexKey(OVER_TUPLE_LIMIT)
    );
  });
});

describe("countProjected", () => {
  it("counts only the projections that bound", () => {
    expect(
      countProjected(
        projectIndexKey(REALISTIC_CONTENT_HASH),
        projectIndexKey(OVER_TUPLE_LIMIT),
        projectNullableIndexKey(null),
        projectIndexKey(MULTIBYTE_OVER_LIMIT)
      )
    ).toBe(2);
  });

  it("is zero for an all-healthy batch, so the tally cannot measure traffic", () => {
    expect(
      countProjected(
        projectIndexKey(REALISTIC_CONTENT_HASH),
        projectIndexKey(LONGEST_REAL_REPOSITORY),
        projectNullableIndexKey(null)
      )
    ).toBe(0);
  });
});

describe("indexKeyCandidates", () => {
  it("asks for one key when the budget did not bind", () => {
    // The ordinary path: one candidate means the lookup this replaced still
    // costs exactly one indexed read.
    expect(indexKeyCandidates(REALISTIC_CONTENT_HASH)).toEqual([
      REALISTIC_CONTENT_HASH,
    ]);
  });

  it("also asks for the RAW key when the budget bound, projected first", () => {
    // ISS-8069 (review, whitlockk): 512 bytes is the per-string bound, 2704 is the
    // btree tuple budget, so a value between them stored fine before this ticket
    // and is sitting in the database under its raw form right now.
    expect(indexKeyCandidates(OVER_TUPLE_LIMIT)).toEqual([
      projectIndexKey(OVER_TUPLE_LIMIT).value,
      OVER_TUPLE_LIMIT,
    ]);
  });
});

describe("resolveStoredIndexKey", () => {
  it("adopts the key an existing row is already stored under", () => {
    // Re-keying the row would orphan every child that references the old value
    // and mint a second row for a session that already has one.
    expect(resolveStoredIndexKey(OVER_TUPLE_LIMIT, OVER_TUPLE_LIMIT)).toEqual({
      value: OVER_TUPLE_LIMIT,
      projected: false,
    });
  });

  it("reports no projection when a legacy raw key is adopted", () => {
    // The tally measures bound values that LANDED, so counting an adopted raw
    // key would report a trade that did not happen.
    expect(
      countProjected(resolveStoredIndexKey(OVER_TUPLE_LIMIT, OVER_TUPLE_LIMIT))
    ).toBe(0);
  });

  it("projects when no row exists yet, and counts that projection", () => {
    const resolved = resolveStoredIndexKey(OVER_TUPLE_LIMIT, null);

    expect(resolved).toEqual(projectIndexKey(OVER_TUPLE_LIMIT));
    expect(countProjected(resolved)).toBe(1);
  });

  it("still counts a projection when the stored row already holds the projected key", () => {
    const projected = projectIndexKey(OVER_TUPLE_LIMIT).value;

    expect(resolveStoredIndexKey(OVER_TUPLE_LIMIT, projected)).toEqual({
      value: projected,
      projected: true,
    });
  });

  it("leaves a value inside the budget alone whether or not a row exists", () => {
    expect(
      resolveStoredIndexKey(REALISTIC_CONTENT_HASH, REALISTIC_CONTENT_HASH)
    ).toEqual({ value: REALISTIC_CONTENT_HASH, projected: false });
    expect(resolveStoredIndexKey(REALISTIC_CONTENT_HASH, null)).toEqual({
      value: REALISTIC_CONTENT_HASH,
      projected: false,
    });
  });
});

/**
 * ISS-8254 — the projected namespace must be reserved.
 *
 * Written as the ATTACK rather than as a property. `PROJECTED_OF_LONG` is not a
 * hand-written fixture: it is whatever `projectIndexKey` actually emits for a
 * long value, which is exactly what an attacker reads off the wire (or out of an
 * error, a log, or the column itself) and replays as a short RAW identity. Every
 * assertion below is about the two landing APART.
 */
describe("ISS-8254 — a long value's projected output replayed as a raw identity", () => {
  /** What the attacker captures: the stored key for a long identity. */
  const PROJECTED_OF_LONG = projectIndexKey(OVER_TUPLE_LIMIT).value;

  it("is a value the wire actually accepts, which is what makes this reachable", () => {
    // `transcriptFileIdentitySchema` constrains only the SHAPE of
    // `externalSessionId` — PATH_SAFE_SEGMENT is /^[^/]+$/. If the projected
    // form ever contained a slash this attack would be blocked by the schema and
    // this whole suite would be theatre, so the premise is asserted, not assumed.
    expect(PROJECTED_OF_LONG).not.toContain("/");
    expect(PROJECTED_OF_LONG).toContain(INDEX_KEY_PROJECTION_MARKER);
  });

  it("does not resolve to the same stored key as the long value it came from", () => {
    // THE vulnerability. Before ISS-8254 both sides of this were
    // `PROJECTED_OF_LONG`: the long value projected to it, and the replayed copy
    // was inside the budget so it passed through untouched onto the same row.
    expect(projectIndexKey(PROJECTED_OF_LONG).value).not.toBe(
      projectIndexKey(OVER_TUPLE_LIMIT).value
    );
  });

  it("is itself projected, even though it is inside the byte budget", () => {
    const replayed = projectIndexKey(PROJECTED_OF_LONG);

    expect(Buffer.byteLength(PROJECTED_OF_LONG, "utf8")).toBeLessThanOrEqual(
      INDEX_KEY_MAX_BYTES
    );
    expect(replayed.projected).toBe(true);
    expect(replayed.value).not.toBe(PROJECTED_OF_LONG);
  });

  it("is never offered back as a legacy raw candidate", () => {
    // The read-side half. Reserving only the WRITE would leave every row already
    // stored under `PROJECTED_OF_LONG` reachable by replaying it: the candidate
    // list would still carry the raw form and route the attacker onto that row.
    const candidates = indexKeyCandidates(PROJECTED_OF_LONG);

    expect(candidates).not.toContain(PROJECTED_OF_LONG);
    expect(candidates).toEqual([projectIndexKey(PROJECTED_OF_LONG).value]);
  });

  it("cannot be adopted as a stored key by resolveStoredIndexKey", () => {
    // `resolveStoredIndexKey` trusts its `storedKey` because that argument can
    // only be a candidate. With the raw form gone from the candidate list, the
    // only key it can adopt for a replayed value is the replay's own projection.
    const resolved = resolveStoredIndexKey(
      PROJECTED_OF_LONG,
      indexKeyCandidates(PROJECTED_OF_LONG)[0]
    );

    expect(resolved.value).not.toBe(PROJECTED_OF_LONG);
    expect(resolved.value).toBe(projectIndexKey(PROJECTED_OF_LONG).value);
  });

  it("keeps the long value's own lookup intact — both candidates, unchanged key", () => {
    // The regression guard on the fix itself. Reserving the namespace must not
    // re-key the rows ISS-8069 already projected: the WIRE value is the long
    // one, which contains no marker, so it still projects to the same stored key
    // and still offers its legacy raw form.
    expect(projectIndexKey(OVER_TUPLE_LIMIT).value).toBe(PROJECTED_OF_LONG);
    expect(indexKeyCandidates(OVER_TUPLE_LIMIT)).toEqual([
      PROJECTED_OF_LONG,
      OVER_TUPLE_LIMIT,
    ]);
  });

  it("separates two different long values whose projections are both replayed", () => {
    // Injectivity across the projected branch survives a second round: replaying
    // two distinct captured keys must stay two distinct identities, not collapse
    // onto one because they share the marker.
    const otherLong = `${OVER_TUPLE_LIMIT}-other`;

    expect(projectIndexKey(projectIndexKey(otherLong).value).value).not.toBe(
      projectIndexKey(PROJECTED_OF_LONG).value
    );
  });
});

/**
 * ISS-8254 review (codex P2, whitlockk) — the legacy identity that merely CONTAINS
 * the marker.
 *
 * `isReservedIndexKey` is a containment test, so the first cut of the read-side
 * fix suppressed the raw candidate for these too. They were accepted and stored
 * VERBATIM before this ticket, so their next sync would have looked only for the
 * digest form, missed the existing row and minted a second `SessionDetail` —
 * with old and new API instances updating different rows through a rolling
 * deploy. These pin the narrowing that keeps them reachable without reopening
 * the replay attack above.
 */
describe("ISS-8254 — a legacy raw identity containing the marker", () => {
  /** Marker in the middle, digest tail absent: no projection can emit this. */
  const LEGACY_CONTAINING_MARKER = `foo${INDEX_KEY_PROJECTION_MARKER}bar`;

  it("is still offered back as a legacy raw candidate", () => {
    const candidates = indexKeyCandidates(LEGACY_CONTAINING_MARKER);

    // Without this the existing row is unreachable and the upsert beside the
    // lookup mints a second one.
    expect(candidates).toContain(LEGACY_CONTAINING_MARKER);
    expect(candidates).toEqual([
      projectIndexKey(LEGACY_CONTAINING_MARKER).value,
      LEGACY_CONTAINING_MARKER,
    ]);
  });

  it("keeps its existing key when the lookup finds that legacy row", () => {
    const resolved = resolveStoredIndexKey(
      LEGACY_CONTAINING_MARKER,
      LEGACY_CONTAINING_MARKER
    );

    // Adopted, not re-keyed — re-keying orphans every child row. And the tally
    // reports no projection, because none happened.
    expect(resolved.value).toBe(LEGACY_CONTAINING_MARKER);
    expect(resolved.projected).toBe(false);
  });

  it("is unreachable by any other value's projection, which is why adopting it is safe", () => {
    // The collision-freedom argument, executed rather than asserted in prose:
    // every emitted key ends with the marker plus the digest, so a value this
    // shape can never be produced by projecting something else.
    for (const source of [
      OVER_TUPLE_LIMIT,
      MULTIBYTE_OVER_LIMIT,
      `${OVER_TUPLE_LIMIT}-other`,
      LEGACY_CONTAINING_MARKER,
    ]) {
      expect(projectIndexKey(source).value).not.toBe(LEGACY_CONTAINING_MARKER);
    }
  });

  it("is still PROJECTED on the write side — reservation stays broad", () => {
    // Only the READ side narrowed. A new row for this value is still written
    // under the digest form, so the write-side namespace stays closed.
    expect(isReservedIndexKey(LEGACY_CONTAINING_MARKER)).toBe(true);
    expect(projectIndexKey(LEGACY_CONTAINING_MARKER).projected).toBe(true);
    expect(projectIndexKey(LEGACY_CONTAINING_MARKER).value).not.toBe(
      LEGACY_CONTAINING_MARKER
    );
  });

  it("does not extend the same courtesy to a real captured projection", () => {
    // The line between the two threads: containing the marker is forgiven, HAVING
    // the emitted shape is not. Losing this distinction is what reopens ISS-8254.
    const captured = projectIndexKey(OVER_TUPLE_LIMIT).value;

    expect(indexKeyCandidates(captured)).not.toContain(captured);
    expect(indexKeyCandidates(LEGACY_CONTAINING_MARKER)).toContain(
      LEGACY_CONTAINING_MARKER
    );
  });
});

describe("isReservedIndexKey", () => {
  it("accepts the values these columns really carry", () => {
    expect(isReservedIndexKey(REALISTIC_CONTENT_HASH)).toBe(false);
    expect(isReservedIndexKey(LONGEST_REAL_REPOSITORY)).toBe(false);
    expect(isReservedIndexKey("claude-code")).toBe(false);
    expect(isReservedIndexKey("")).toBe(false);
  });

  it("reserves anything carrying the marker, at any length or position", () => {
    expect(isReservedIndexKey(projectIndexKey(OVER_TUPLE_LIMIT).value)).toBe(
      true
    );
    expect(isReservedIndexKey(INDEX_KEY_PROJECTION_MARKER)).toBe(true);
    expect(isReservedIndexKey(`a${INDEX_KEY_PROJECTION_MARKER}b`)).toBe(true);
  });
});

describe("storedIndexKeyCandidates", () => {
  it("offers a projected stored key as ITSELF, never re-projected", () => {
    // ISS-8125 (operator review): the value came OUT of an indexed column, so it
    // already IS the stored key. `projectIndexKey` is not idempotent — ISS-8254
    // reserved the marker — so re-applying it digests the projection rather than
    // the original and yields a key no sibling table holds. Nothing throws; the
    // lookup just misses, forever.
    const stored = projectIndexKey(OVER_TUPLE_LIMIT).value;

    expect(storedIndexKeyCandidates(stored)).toEqual([stored]);
    expect(storedIndexKeyCandidates(stored)).not.toContain(
      projectIndexKey(stored).value
    );
    // The re-projection really is a different key, so the assertion above is not
    // vacuously true.
    expect(projectIndexKey(stored).value).not.toBe(stored);
  });

  it("offers the projection too for a stored key still held raw", () => {
    // A row written before this repo projected that column: the sibling table
    // was already storing the projected form, so both have to be asked for.
    expect(storedIndexKeyCandidates(OVER_TUPLE_LIMIT)).toEqual([
      OVER_TUPLE_LIMIT,
      projectIndexKey(OVER_TUPLE_LIMIT).value,
    ]);
  });

  it("degenerates to one candidate for the values these columns really carry", () => {
    for (const value of [
      REALISTIC_CONTENT_HASH,
      LONGEST_REAL_REPOSITORY,
      "claude-code",
    ]) {
      expect(storedIndexKeyCandidates(value)).toEqual([value]);
    }
  });

  it("keeps a legacy raw key that merely CONTAINS the marker reachable", () => {
    // The ISS-8254 review distinction, carried over: containment is forgiven,
    // the emitted shape is not. `foo~idxsha256:bar` was accepted and stored
    // verbatim before that ticket, so dropping its raw candidate would strand it.
    const legacy = `foo${INDEX_KEY_PROJECTION_MARKER}bar`;

    expect(storedIndexKeyCandidates(legacy)).toContain(legacy);
    expect(storedIndexKeyCandidates(legacy)).toContain(
      projectIndexKey(legacy).value
    );
  });
});
