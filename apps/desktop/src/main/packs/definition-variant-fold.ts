/**
 * @file definition-variant-fold.ts
 * @description ISS-4662 item 2 — the per-identity VARIANT FOLD and version
 * persistence concern, extracted out of `definition-content-collector.ts`
 * (reviewer shafty023 on PR #4116: that file carries the whole definition
 * pipeline and had grown past the 500-line smell).
 *
 * One cohesive job lives here: given definitions discovered under several scan
 * roots, decide which one is the precedence-winning `primary` for an identity,
 * retain every OTHER distinct-content body as a `variant`, and append each
 * distinct content hash to `agent_component_versions`. Discovery (which roots to
 * walk, how to read a file) and display-row persistence (`agent_components`)
 * stay in the collector, which drives this module.
 *
 * Behavior is unchanged by the move — identity still keys off the content hash
 * (`sha256(content)`), never a name, path, or root, so no existing row is
 * re-identified.
 */
import { createHash } from "node:crypto";
import { Harness } from "@repo/api/src/types/agent-component";
import { inferComponentFormat } from "@repo/api/src/types/agent-component-properties";
import type { PackScannerDb } from "./pack-scanner.js";

// Version identity — `(component, source, content_hash)`, NOT the invoking
// owner. `source` is collapsed to "" for filesystem-discovered definitions
// (the source dimension is reserved; the key is forward-compatible if it is
// later populated).
const DEFINITION_SOURCE = "";

export type DiscoveredDefinition = {
  kind: "skill" | "subagent" | "command";
  /** Dedup key — MUST equal the event-driven `component_key` for this kind. */
  externalId: string;
  name: string;
  installPath: string;
  content: string;
  /** Owning project root (if the file was found under one) — for scope. */
  projectPath?: string;
  /**
   * Originating harness (FEA-4028), taken from the scan ROOT this definition
   * was discovered under (the resolved Claude vs Codex home). Null when the
   * root carries no harness signal (a harness-agnostic `.agents/skills` tree)
   * — never guessed. Folded to `Harness.Both` at collection time when the same
   * identity is also discovered under a root of a different harness.
   */
  harness: Harness | null;
};

/**
 * The fold result for one `externalId`: the precedence-winning `primary`
 * variant (first-scanned root — it drives the `agent_components` "active"/display
 * row) plus every OTHER distinct-content variant discovered under a later root
 * (ISS-4564, shafty023).
 *
 * Precedence and persistence are DECOUPLED here: precedence decides which
 * variant is `primary`, but a same-name definition with DIFFERENT bytes under a
 * lower-precedence root is NOT discarded — its bytes are retained as a `variant`
 * so every distinct content hash still reaches `agent_component_versions`
 * (content-based identity: identity keys off content hash, not name/path/root).
 * Before this, the fold kept only the first-scanned copy, so a project agent
 * with the same name but different content as the global-home one had its bytes
 * dropped and never versioned.
 *
 * `variants` holds only content hashes DISTINCT from the primary's and from each
 * other (dedup on `sha256(content)`), so genuinely-identical content in two
 * roots still yields exactly one version row — never a double-count.
 */
export type DefinitionVariants = {
  primary: DiscoveredDefinition;
  /** Additional distinct-content variants (never includes the primary). */
  variants: DiscoveredDefinition[];
  /**
   * The `sha256(content)` of the primary plus every recorded variant, kept on
   * the accumulator so `foldDiscovered` hashes each body EXACTLY ONCE (shafty023
   * / wongk). Rebuilding this set per discovery would re-hash every retained body
   * for every same-name definition — O(N²) full-content hashes in the DB host, a
   * CPU/availability problem for a project root with many same-name SKILL.md
   * variants. Seeded with the primary's hash on creation; each new distinct
   * variant adds its hash here as it is pushed.
   */
  seenHashes: Set<string>;
};

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Fold a newly-discovered harness into a definition's accumulated harness
 * attribution (FEA-4028). A definition is attributed by the scan ROOT it was
 * found under; the SAME identity (skill name, `/command`, sub-agent name) can
 * be dual-installed under two harness homes (e.g. a skill under both
 * `~/.claude/skills` and `~/.codex/skills`). When the two disagree we resolve
 * to `Harness.Both` — the same "used across harnesses" collapse the cloud
 * rollup applies (`resolveComponentHarness` in the API service) — rather than
 * letting whichever root was scanned first silently win (which is what made a
 * dual-installed skill read back as Claude, since the Claude root is scanned
 * first). A null on either side degrades to the other; two nulls stay null.
 */
function foldHarness(
  current: Harness | null,
  next: Harness | null
): Harness | null {
  if (current === null) {
    return next;
  }
  if (next === null || next === current) {
    return current;
  }
  return Harness.Both;
}

/**
 * Fold a freshly-discovered definition into the by-identity accumulator
 * (ISS-4564). The FIRST-observed root wins the `primary` variant's
 * content/installPath/projectPath (roots are scanned in caller order — global
 * home before project, so precedence is caller-defined); a later root only
 * upgrades the `primary`'s `harness` attribution (to `Harness.Both`) when the
 * harness differs.
 *
 * Crucially, precedence is decoupled from persistence: a later root carrying the
 * SAME name but a DIFFERENT content hash is NOT discarded — it is retained as a
 * `variant` so its bytes still reach `agent_component_versions`. Only its
 * content is kept as a variant; the primary keeps owning the display row. A
 * later root whose content hash matches the primary (or an already-recorded
 * variant) contributes no new variant (dedup on `sha256(content)`), so
 * genuinely-identical content in two roots stays a single version row — no
 * double-count. This is what keeps a dual-installed same-content skill attributed
 * `both` with one row (wongk review, FEA-4028) while a same-name
 * DIFFERENT-content project agent no longer loses its bytes (shafty023,
 * ISS-4564).
 */
export function foldDiscovered(
  byId: Map<string, DefinitionVariants>,
  discovered: DiscoveredDefinition
): void {
  const existing = byId.get(discovered.externalId);
  if (!existing) {
    byId.set(discovered.externalId, {
      primary: discovered,
      variants: [],
      // Seed the seen-hash set with the primary so later same-name variants
      // dedup against it; each body is hashed exactly once (shafty023 / wongk).
      seenHashes: new Set([sha256Hex(discovered.content)]),
    });
    return;
  }
  existing.primary.harness = foldHarness(
    existing.primary.harness,
    discovered.harness
  );
  // Hash this body once and check the accumulator's set — no per-discovery
  // rebuild over every retained body (the O(N²) full-content hashing the review
  // flagged). A new distinct hash records its variant and its hash.
  const nextHash = sha256Hex(discovered.content);
  if (!existing.seenHashes.has(nextHash)) {
    existing.variants.push(discovered);
    existing.seenHashes.add(nextHash);
  }
}

/**
 * Append one `agent_component_versions` revision row for a discovered variant
 * (ISS-4564). A changed hash inserts a NEW revision; an unchanged hash just
 * refreshes `last_seen_at` (dedup on the `(kind, key, source, content_hash)`
 * identity). Called for the primary variant AND for every additional
 * distinct-content variant of the same `externalId`, so every content hash's
 * bytes are retained in the versions table regardless of which root won the
 * `agent_components` display row — precedence never drops a variant's bytes.
 */
export async function upsertDefinitionVersion(
  db: PackScannerDb,
  def: DiscoveredDefinition,
  hash: string,
  now: string
): Promise<void> {
  const versionId = createHash("sha256")
    .update(`${def.kind}|${def.externalId}|${DEFINITION_SOURCE}|${hash}`)
    .digest("hex")
    .slice(0, 32);
  const format = inferComponentFormat(def.kind, def.installPath);
  await db.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_component_versions
         (id, component_kind, component_key, source, content_hash, content,
          format, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (component_kind, component_key, source, content_hash)
       DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      versionId,
      def.kind,
      def.externalId,
      DEFINITION_SOURCE,
      hash,
      def.content,
      format,
      now
    )
  );
}
