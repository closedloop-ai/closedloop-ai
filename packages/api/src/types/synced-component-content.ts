/**
 * @file synced-component-content.ts
 * @description Transport budgets for a synced component's definition BODY, plus
 * the optional retained-variant wire shape that rides alongside it.
 *
 * Split out of `agent-session.ts` (ISS-4662): these constants and the serialized
 * byte-size helper are one cohesive concern — "how many bytes of definition text
 * may cross `POST /desktop/components/sync`, and how is that measured" — shared
 * verbatim by the desktop packer, the desktop transport chunker, and the cloud
 * ingest Zod schema. They are not session shapes, and `agent-session.ts` is a
 * grandfathered over-ceiling module, so they live here instead.
 */

/**
 * Upper bound on a synced definition's `content` length (characters). The
 * detail Prompt panel needs the file text, but org-wide sync of unbounded
 * definition bodies is a memory/egress risk (this repo has a db-host OOM
 * history, FEA-3132). The desktop truncates beyond this before sending; the
 * cloud ingest Zod schema rejects anything larger. 256 KiB comfortably covers
 * real agent/skill/command definitions while capping pathological files.
 */
export const SYNCED_COMPONENT_CONTENT_MAX_CHARS = 262_144;

/**
 * FEA-3626: transport-side upper bound on a synced definition's `content`
 * measured in **UTF-8 bytes**, not characters. Superseded for clamping by
 * {@link SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES} (raw bytes undercount
 * the escape-inflated wire size); retained as the documented historical bound.
 */
export const SYNCED_COMPONENT_CONTENT_MAX_BYTES = 98_304; // 96 KiB

/**
 * FEA-3692: transport budget for a synced definition's `content` measured by its
 * **serialized (JSON-escaped) UTF-8 byte size** — the size the transport chunker
 * (`COMPONENTS_CHUNK_BYTE_BUDGET`, ~248 KiB) actually enforces on the wire.
 *
 * The older {@link SYNCED_COMPONENT_CONTENT_MAX_BYTES} (96 KiB) clamps the RAW
 * UTF-8 bytes of the string, but JSON string-escaping can inflate that far past
 * the raw count: a control char (NUL, `\b`, etc.) escapes to the 6-byte `\uXXXX`
 * form. A 512 KiB NUL-filled definition clamps to 98 304 raw bytes yet serializes
 * to ~576 KiB (a 6x blow-up) — so the chunker classifies it oversized, emits zero
 * chunks and one oversized entry, and the component's existence row silently never
 * reaches the cloud. Measuring the SERIALIZED size instead guarantees the clamped
 * body always fits a sub-cap request no matter how escape-heavy it is.
 *
 * 131 072 (128 KiB) leaves ~120 KiB of the ~248 KiB chunk budget for the JSON
 * envelope plus every sibling field (name/kind/hash/installPath/metadata/…), so a
 * single component with a clamped body can never on its own exceed the chunk
 * budget. A body clamped to <= 128 KiB serialized is also always <= the
 * {@link SYNCED_COMPONENT_CONTENT_MAX_CHARS} char cap (serialized bytes >= chars),
 * so the cloud ingest Zod `.max(...)` still accepts it.
 */
export const SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES = 131_072; // 128 KiB

/**
 * FEA-3692: serialized (JSON-escaped) UTF-8 byte size of a string — i.e. the byte
 * length of `JSON.stringify(value)` MINUS the two surrounding quotes, without
 * allocating that serialized string. This is the size the component-sync chunker
 * measures on the wire, so the desktop clamps `content` against it.
 *
 * Iterating by code point (`for…of`) folds a well-formed surrogate PAIR into one
 * astral scalar, and — critically — reports a LONE surrogate (U+D800–U+DFFF, an
 * unpaired high/low half) as 6 serialized bytes, exactly as `JSON.stringify`
 * escapes it to `\uXXXX`. A naive `TextEncoder().encode(value).byteLength` would
 * instead count a lone surrogate as the 3 bytes of its U+FFFD replacement and
 * UNDERCOUNT the true wire size — the subtlety that lets an escape-heavy body slip
 * back over the budget. Per code point:
 *   - control chars (< 0x20) and `"`/`\` → 2 bytes (`\n`/`\t`/`\"`/`\\`) except
 *     the five non-shorthand controls, which escape to the 6-byte `\uXXXX` form;
 *   - a lone surrogate → 6 bytes (`\uXXXX`);
 *   - everything else → its plain UTF-8 byte length (1–4).
 */
export function serializedJsonUtf8ByteSize(value: string): number {
  let total = 0;
  for (const codePoint of value) {
    const cp = codePoint.codePointAt(0) as number;
    if (cp >= 0xd8_00 && cp <= 0xdf_ff) {
      // Lone surrogate: JSON.stringify emits `\uXXXX` (6 bytes).
      total += 6;
      continue;
    }
    if (cp === 0x22 /* " */ || cp === 0x5c /* \\ */) {
      total += 2; // \" or \\
      continue;
    }
    if (cp < 0x20) {
      // \b \t \n \f \r have 2-byte shorthands; the rest escape to \u00XX (6).
      total +=
        cp === 0x08 || cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d
          ? 2
          : 6;
      continue;
    }
    // Plain scalar: its UTF-8 byte length.
    if (cp < 0x80) {
      total += 1;
    } else if (cp < 0x8_00) {
      total += 2;
    } else if (cp < 0x1_00_00) {
      total += 3;
    } else {
      total += 4;
    }
  }
  return total;
}

/**
 * ISS-4662 (item 1) — one RETAINED lower-precedence content variant of a synced
 * component, carried additively on `SyncedComponent.variants[]`.
 *
 * ISS-4564 made the desktop retain every distinct content hash of a same-name
 * definition in its local `agent_component_versions` table, but the sync payload
 * is packed from `agent_components` — one winning (primary) row per identity — so
 * the extra revisions never left the device: Desktop's detail Prompt panel showed
 * both revisions while the web/cloud panel showed only the primary. This carries
 * the retained bytes so the cloud can accumulate the SAME per-content-hash
 * version history.
 *
 * Identity is the content hash itself and NOTHING else (FEA-4335 content-based
 * identity). `contentHash` is the desktop's already-computed
 * `agent_component_versions.content_hash`, forwarded VERBATIM — the desktop never
 * re-derives it here and the cloud never re-keys a version row on anything but
 * the hash it is given plus the parent component's own kind/key. A variant
 * therefore carries no id, no path, and no precedence marker: which bytes WON the
 * display row is `SyncedComponent.content`/`contentHash`, and that precedence
 * decision stays entirely on the desktop.
 *
 * `format` is the desktop's own `inferComponentFormat` result for the revision,
 * forwarded so the cloud does not have to re-infer it from an `installPath` that
 * belongs to the PRIMARY variant rather than this one (a mis-inferred format is
 * what made non-markdown definitions render as Markdown on the web panel).
 * Optional: an omitted/unknown value degrades to the cloud's existing
 * `inferComponentFormat` fallback, never to a fabricated one.
 */
export type SyncedComponentVariant = {
  /** sha256 hex of the untruncated variant body; the sole version identity. */
  contentHash: string;
  /** Variant body, clamped to the remaining per-component transport budget. */
  content: string;
  /** Desktop-inferred definition format ("md" | "json" | "yml" | …). */
  format?: string | null;
  /** ISO; when this exact hash was first observed locally. */
  firstSeenAt?: string | null;
  /** ISO; when this exact hash was last observed locally. */
  lastSeenAt?: string | null;
};

/**
 * ISS-4662: hard cap on how many retained variants ride with one component.
 * A same-name collision realistically produces 1–2 extra revisions; the cap
 * bounds a pathological identity rather than describing the normal case.
 */
export const SYNCED_COMPONENT_VARIANTS_MAX = 8;

/**
 * ISS-4662: TOTAL serialized-byte budget the `variants[]` array may occupy on
 * one component — the load-bearing safety constraint of this whole field.
 *
 * The transport chunker dead-letters any SINGLE component whose serialized JSON
 * exceeds `COMPONENTS_CHUNK_BYTE_BUDGET` (~248 KiB) — it can never fit a request,
 * so it is dropped wholesale and its existence row never reaches the cloud. The
 * primary `content` already spends up to
 * {@link SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES} (128 KiB) of that. Sending
 * variants unbudgeted would therefore push exactly the components this feature
 * targets — the ones WITH extra revisions — over the ceiling and make them vanish
 * from the cloud entirely: a strict regression on the rows it means to enrich.
 *
 * 65 536 (64 KiB) keeps the worst case at 128 + 64 = 192 KiB, ~56 KiB clear of the
 * chunk budget for the envelope and every sibling field. The packer fills variants
 * newest-first and STOPS at this budget (a `break`, not a skip-and-continue — see
 * `selectSyncedVariants`), so the shipped set is the N most recent that fit and an
 * over-budget variant simply stays desktop-local rather than taking the whole
 * component down with it.
 *
 * This is a CEILING, not the whole story: the real constraint is the component's
 * own total serialized size, which the packer measures directly against
 * {@link SYNCED_COMPONENT_MAX_SERIALIZED_BYTES}. A component already fat with
 * metadata gets less than this.
 */
export const SYNCED_COMPONENT_VARIANTS_MAX_SERIALIZED_BYTES = 65_536; // 64 KiB

/**
 * ISS-4662: the serialized-byte ceiling ONE component may occupy on the wire —
 * the limit the desktop transport chunker actually enforces per component
 * (`COMPONENTS_CHUNK_BYTE_BUDGET` in `desktop-components-client.ts`: the 256 KiB
 * request cap less an 8 KiB envelope headroom).
 *
 * Duplicated here as a plain number rather than imported because this contract is
 * shared with the cloud and must not pull in a desktop main-process module; the
 * `component-sync-source` tests pin the two against each other so they cannot
 * drift.
 *
 * The packer measures a component's REAL `JSON.stringify` size against this and
 * spends only what is left on variants. Summing `content` + `contentHash` alone
 * (as the first cut did) undercounts: the component also carries metadata, paths,
 * dates, format, and the variant object KEYS themselves, so a component that fit
 * before variants were added could cross the ceiling once they are and be
 * dead-lettered — losing the existence row this lane exists to enrich.
 */
export const SYNCED_COMPONENT_MAX_SERIALIZED_BYTES = 253_952; // 248 KiB

/**
 * Safety margin held back from {@link SYNCED_COMPONENT_MAX_SERIALIZED_BYTES} when
 * budgeting variants, so a component packed right up to the computed limit still
 * clears the chunker after any envelope/serialization rounding.
 */
export const SYNCED_COMPONENT_VARIANTS_BUDGET_HEADROOM_BYTES = 4096; // 4 KiB

/**
 * ISS-4662 + ISS-5029 — the retained-variant fields a `SyncedComponent` carries.
 *
 * Kept here rather than inline on `SyncedComponent` (`agent-session.ts`) for the
 * reason stated at the top of this file: these are the retained-variant wire
 * concern, not a session shape, and `agent-session.ts` is a grandfathered
 * over-ceiling module. `SyncedComponent` intersects this, so the two fields —
 * "which extra revisions ride along" and "were there more we could not send" —
 * live together, next to the budget constants that decide both.
 */
export type SyncedComponentVariantsEnvelope = {
  /**
   * ISS-4662 (item 1) — RETAINED lower-precedence content variants of this same
   * identity (ISS-4564), so the cloud accumulates the same per-content-hash
   * version history the desktop already keeps locally. NEVER includes the
   * primary revision: those bytes are `content`/`contentHash` on the component.
   *
   * Additive/optional and OMITTED (not `[]`, not `null`) whenever the component
   * has no extra revisions — which is the overwhelmingly common case — so the
   * payload and every older cloud build are byte-for-byte unaffected. An older
   * cloud drops the key (the ingest schema is non-strict, so unknown keys are
   * stripped rather than rejecting the batch); an older desktop omits it and the
   * cloud writes exactly the one primary version row it always did.
   */
  variants?: SyncedComponentVariant[];
  /**
   * ISS-5029 — TRUE when the packer dropped at least one retained revision this
   * component actually has, because a per-family cap or the per-component
   * variant byte budget bound. It is the difference between "this identity has N
   * revisions" and "this identity has MORE than N revisions and we stopped".
   *
   * Set where the cap BINDS (an eligible revision existed and could not be
   * emitted), never inferred from `variants.length` — a length comparison is
   * wrong the moment the primary-hash skip, a NULL body, or the cloud's own
   * dedupe changes the count.
   *
   * A marker-aware packer sends this on EVERY component, `false` included
   * (wongk, #4391). The three states are distinct and the cloud writer treats
   * them differently: `true` claims truncation, `false` is a marker-aware
   * producer CLEARING a previously-stored claim, and ABSENT is a desktop that
   * predates the marker and therefore has no opinion — a stored value it must
   * not overwrite. Absent is still additive/optional so an older desktop is
   * accepted unchanged, and an older cloud strips the unknown key.
   */
  variantsTruncated?: boolean;
  /**
   * ISS-5029 — WHICH cap bound, sent only alongside `variantsTruncated: true`.
   *
   * The cloud cannot treat the two the same (wongk, #4391). Its detail read
   * proves partiality by reconciling the marker against the count it stores, and
   * that proof needs a lower bound on what the device actually holds:
   *  - {@link SyncedComponentVariantsTruncatedReason.FamilyCap} gives one — the
   *    packer's per-family candidate rank/entry cap only binds when the family
   *    holds more revisions than a single sync can carry, so a stored count at
   *    or under that ceiling is provably short.
   *  - {@link SyncedComponentVariantsTruncatedReason.ByteBudget} gives none — a
   *    component with large bodies can byte-truncate at two shipped revisions on
   *    every sync while the cloud, which accumulates the union of every subset
   *    ever sent, already holds the whole history. Treating it as proof printed
   *    "incomplete" over a complete list.
   *
   * Additive/optional and unconstrained on the wire on purpose: the cloud maps
   * any unknown value to "no proof" rather than rejecting it, so a future reason
   * from a newer desktop degrades to today's rendering instead of failing a
   * batch. The receiving contract declares it nullable for the same reason — a
   * client that serializes an absent optional as `null` must not take a
   * 200-component batch down with it — but the packer omits rather than nulls.
   */
  variantsTruncatedReason?: string | null;
};

/**
 * ISS-5029 — the cap that bound when a packer set `variantsTruncated`.
 *
 * Const object rather than a TS `enum` (Biome forbids `enum`), and the wire type
 * is a plain `string` so an unknown value from a newer desktop degrades instead
 * of rejecting a 200-component batch.
 */
export const SyncedComponentVariantsTruncatedReason = {
  /**
   * The per-family candidate cap bound: the family holds more retained revisions
   * than the packer will consider or emit in one sync. This is the reason that
   * carries a lower bound on the device's holdings, so it is the only one the
   * cloud can reconcile into a proof.
   */
  FamilyCap: "family_cap",
  /**
   * The per-component variant byte budget bound: an eligible revision existed
   * but would not fit. Carries NO lower bound on how many revisions the device
   * holds, so it never proves the cloud is missing anything.
   */
  ByteBudget: "byte_budget",
} as const;

export type SyncedComponentVariantsTruncatedReason =
  (typeof SyncedComponentVariantsTruncatedReason)[keyof typeof SyncedComponentVariantsTruncatedReason];
