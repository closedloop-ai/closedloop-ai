/**
 * Harness-format conversion capability contract (FEA-4078).
 *
 * The convert UI (and, later, the convert engine — FEA-4079) needs a truthful,
 * pre-execution answer to "can this agentic component — of kind K, authored for
 * harness A — install on harness B, and what is lost in translation?" This
 * module is that answer as pure data + pure logic: a canonical capability map
 * keyed per `componentKind × sourceHarness × targetHarness`, and a **dry-run**
 * that reports what a convert WOULD do (the planned conversions and the skips)
 * WITHOUT installing or spawning anything. There is deliberately NO execution
 * engine here — that is FEA-4079's slice.
 *
 * Harness identity is the crewd `HarnessName` const (claude | codex | opencode)
 * — the ONE canonical enum every harness-aware surface drives from. We import it
 * verbatim rather than redeclaring the literals so the capability matrix stays
 * exhaustive over the real harness set: a newly added harness fails `tsc` here
 * (the `Record<HarnessName, …>` keys) until its conversion rules are authored.
 *
 * Component identity is the crewd-independent `AgentComponentKind` (skill /
 * command / subagent / mcp / hook / …). Two harness fields are kept distinct on
 * the dry-run item: `currentHarness` (the format the component is in now, which
 * keys the matrix) and an optional `sourceHarness` **provenance** (the harness
 * it was originally authored for), so the eventual converted-component identity
 * records where it came from across repeated conversions without re-charging
 * losses from a prior hop (FEA-4028 depends-on: provenance must be trustworthy
 * first).
 *
 * Pure, transport-neutral, and dependency-light (only the two harness/kind
 * consts + Zod for the wire schemas): it resolves identically in the browser,
 * the desktop renderer, and Node. It lives in `packages/api/src/types` because
 * BOTH `apps/app` and `apps/api` (and the desktop renderer) consume it.
 */

import { HarnessName, harnessNameSchema } from "@repo/crewd/model";
import { z } from "zod";
import { AgentComponentKind } from "./agent-component.ts";

/**
 * How well an agentic component of a given kind converts from one harness's
 * format to another's. The three states this contract owns:
 *
 *  - `Supported`   — a faithful conversion exists; nothing meaningful is dropped.
 *  - `Partial`     — a conversion exists but it is lossy; see `droppedFields`
 *                    for the fields the target format cannot represent.
 *  - `Unsupported` — no conversion exists; the component cannot install on the
 *                    target harness in this kind.
 *
 * Const-object enum (never TypeScript `enum`), per the repo-sanctioned idiom.
 */
export const ConversionSupport = {
  Supported: "supported",
  Partial: "partial",
  Unsupported: "unsupported",
} as const;
export type ConversionSupport =
  (typeof ConversionSupport)[keyof typeof ConversionSupport];

export const conversionSupportSchema = z.enum([
  ConversionSupport.Supported,
  ConversionSupport.Partial,
  ConversionSupport.Unsupported,
]);

/**
 * The 10 canonical {@link AgentComponentKind} values, enumerated for the wire
 * schema. The `satisfies` pins the array's element type to the union, and the
 * `AgentComponentKind extends (typeof …)[number]` half of
 * {@link agentComponentKindSchema}'s inferred type keeps drift impossible: a
 * kind added to the const but not listed here fails `tsc` where the schema is
 * asserted exhaustive (see the schema's inferred-type equality below), rather
 * than silently under-validating the wire.
 */
const AGENT_COMPONENT_KIND_VALUES = [
  AgentComponentKind.Subagent,
  AgentComponentKind.Command,
  AgentComponentKind.Skill,
  AgentComponentKind.Workflow,
  AgentComponentKind.Mcp,
  AgentComponentKind.Hook,
  AgentComponentKind.Config,
  AgentComponentKind.Plugin,
  AgentComponentKind.Tool,
  AgentComponentKind.Orchestration,
] as const satisfies readonly AgentComponentKind[];

/**
 * `true` iff `A` and `B` are mutually assignable (the same set), else `never`.
 * Used to assert a Zod schema's inferred output equals a canonical union.
 */
type AssignableBothWays<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

/** Wire schema for {@link AgentComponentKind} (the 10 canonical kinds). */
export const agentComponentKindSchema = z.enum(AGENT_COMPONENT_KIND_VALUES);

/**
 * Compile-time proof that {@link agentComponentKindSchema} accepts EXACTLY the
 * {@link AgentComponentKind} union — no wider, no narrower. If
 * {@link AGENT_COMPONENT_KIND_VALUES} drifts from the const (a kind added to one
 * but not the other), this assignment fails `tsc` because the mutual-assignment
 * check collapses to `never`, rather than the schema silently under- or
 * over-validating the wire. Exported so it is a referenced symbol.
 */
export const agentComponentKindSchemaIsExhaustive: true =
  true satisfies AssignableBothWays<
    z.infer<typeof agentComponentKindSchema>,
    AgentComponentKind
  >;

/**
 * One cell of the capability matrix: the support level for a single
 * `(componentKind, sourceHarness, targetHarness)` triple, plus the ordered list
 * of source-format field names the target format cannot carry.
 *
 * `droppedFields` is non-empty only for {@link ConversionSupport.Partial}; a
 * `Supported` cell drops nothing and an `Unsupported` cell has nothing to drop
 * (the whole component is skipped, not partially carried). Keeping the field a
 * `readonly string[]` — the source-format field names — lets the UI render a
 * precise "what's lost" preview without the convert engine.
 */
export type ConversionCapability = {
  readonly support: ConversionSupport;
  readonly droppedFields: readonly string[];
};

/**
 * The per-source-harness → per-target-harness capability matrix for ONE
 * component kind. Exhaustive over {@link HarnessName} on BOTH axes — the
 * `Record<HarnessName, …>` keys make a missing harness a `tsc` error, not a
 * silent runtime gap.
 */
export type HarnessConversionMatrix = Record<
  HarnessName,
  Record<HarnessName, ConversionCapability>
>;

/**
 * The full capability map: one {@link HarnessConversionMatrix} per
 * {@link AgentComponentKind}. Exhaustive over every kind AND — via the matrix
 * type — every source/target harness pair. This is the single source of truth
 * the dry-run and (later) the convert engine both read; do not resolve
 * capability from anywhere else.
 */
export type HarnessConversionCapabilityMap = Record<
  AgentComponentKind,
  HarnessConversionMatrix
>;

/**
 * The harness roster the conversion rules below were authored and reviewed
 * against — a compile-time anchor, NOT a second source of harness identity. The
 * `Record<HarnessName, true>` keys mean adding a harness to the canonical crewd
 * `HarnessName` const fails `tsc` HERE until a human adds its entry, which is
 * the forcing function: `buildMatrix` materializes every `HarnessName` pair from
 * blanket `crossHarness`/`identity` defaults, so without this anchor a new
 * harness would silently inherit (e.g.) `crossHarness: SUPPORTED` and the
 * dry-run would report an UNVERIFIED conversion as lossless. Touching this
 * roster is the signal to revisit each kind's cross-harness rules for the new
 * harness before shipping it.
 */
const REVIEWED_HARNESSES: Record<HarnessName, true> = {
  [HarnessName.Claude]: true,
  [HarnessName.Codex]: true,
  [HarnessName.Opencode]: true,
};

/**
 * Every {@link HarnessName}, derived from the canonical crewd const rather than
 * re-listed here — so a harness added to `HarnessName` is materialized into
 * every matrix automatically and cannot silently lag behind the union (the
 * drift a hand-maintained copy would allow). Keyed off {@link REVIEWED_HARNESSES}
 * so this set and the reviewed roster cannot drift: they are the same keys, and
 * a new harness fails `tsc` at the roster before it can reach a matrix.
 */
const HARNESS_NAMES: readonly HarnessName[] = Object.keys(
  REVIEWED_HARNESSES
) as HarnessName[];

/**
 * A fully-supported, lossless cell — the identity conversion and any pair that
 * carries every field. Shared const so cells that lose nothing all point at ONE
 * frozen object instead of re-spelling the empty-drop shape.
 */
const SUPPORTED: ConversionCapability = {
  support: ConversionSupport.Supported,
  droppedFields: [],
};

/** An unsupported cell — no conversion exists for this kind on this pair. */
const UNSUPPORTED: ConversionCapability = {
  support: ConversionSupport.Unsupported,
  droppedFields: [],
};

/** A partial (lossy) cell carrying the named source fields the target drops. */
function partial(droppedFields: readonly string[]): ConversionCapability {
  return { support: ConversionSupport.Partial, droppedFields };
}

/**
 * Rule table for one kind's matrix. `identity` is the cell for a same-harness
 * pair (source === target); `crossHarness` is the default for a distinct pair.
 * Splitting the two lets an observable-only kind be unconvertible EVEN to its
 * own harness (identity `unsupported`), while an installable-but-non-portable
 * kind like a hook stays lossless to itself yet unsupported across harnesses.
 * `overrides` pins specific `[source][target]` pairs (e.g. the subagent
 * asymmetry) and wins over both defaults.
 */
type MatrixRules = {
  readonly identity: ConversionCapability;
  readonly crossHarness: ConversionCapability;
  readonly overrides?: Partial<
    Record<HarnessName, Partial<Record<HarnessName, ConversionCapability>>>
  >;
};

/**
 * Build a kind's source→target matrix from a {@link MatrixRules} table,
 * materializing every {@link HarnessName} pair so the result is exhaustive over
 * both axes (a missing harness is a `tsc` error at the `Record<HarnessName, …>`
 * type, never a silent runtime gap).
 */
function buildMatrix(rules: MatrixRules): HarnessConversionMatrix {
  const matrix = Object.create(null) as HarnessConversionMatrix;
  for (const source of HARNESS_NAMES) {
    const row = Object.create(null) as Record<
      HarnessName,
      ConversionCapability
    >;
    for (const target of HARNESS_NAMES) {
      const override = rules.overrides?.[source]?.[target];
      if (override) {
        row[target] = override;
      } else if (source === target) {
        row[target] = rules.identity;
      } else {
        row[target] = rules.crossHarness;
      }
    }
    matrix[source] = row;
  }
  return matrix;
}

/** A kind that converts losslessly across every harness (portable text). */
const PORTABLE: MatrixRules = {
  identity: SUPPORTED,
  crossHarness: SUPPORTED,
};

/**
 * A kind that is not installable/authored at all (observed only) — unconvertible
 * in EVERY direction, identity included, so the convert affordance never offers
 * it.
 */
const OBSERVABLE_ONLY: MatrixRules = {
  identity: UNSUPPORTED,
  crossHarness: UNSUPPORTED,
};

/**
 * The canonical harness-format conversion capability map (FEA-4078).
 *
 * Rules encode the current reality of each format:
 *  - `Skill`/`Command`/`Config` are portable prompt/config text — they convert
 *    losslessly across every harness.
 *  - `Subagent` carries a claude-specific model/tool-permission preamble.
 *    Converting FROM claude TO codex/opencode drops those fields (partial),
 *    but converting INTO claude (the richest subagent format) is lossless, so
 *    only the claude-source row is partial — an asymmetry the matrix encodes
 *    explicitly rather than flattening to a single cross-harness default.
 *  - `Hook` is claude-shaped event wiring; other harnesses have no equivalent
 *    surface (unsupported).
 *  - `Mcp`, `Tool`, and `Orchestration` are OBSERVED, not authored/installable,
 *    so they are not convertible in any direction (unsupported) — the convert
 *    affordance must never offer them.
 *  - `Plugin`/`Workflow` bundle harness-specific structure; they carry to
 *    another harness only partially, dropping the harness-specific manifest bits.
 *
 * Exhaustive over {@link AgentComponentKind} (a new kind fails `tsc` until its
 * matrix is authored) and, per matrix, over {@link HarnessName}.
 */
export const HARNESS_CONVERSION_CAPABILITIES: HarnessConversionCapabilityMap = {
  [AgentComponentKind.Skill]: buildMatrix(PORTABLE),
  [AgentComponentKind.Command]: buildMatrix(PORTABLE),
  [AgentComponentKind.Config]: buildMatrix(PORTABLE),
  [AgentComponentKind.Subagent]: buildMatrix({
    identity: SUPPORTED,
    crossHarness: SUPPORTED,
    overrides: {
      [HarnessName.Claude]: {
        [HarnessName.Codex]: partial(["model", "allowedTools"]),
        [HarnessName.Opencode]: partial(["model", "allowedTools"]),
      },
    },
  }),
  // Hooks convert losslessly to their own harness but have no equivalent event
  // surface on another harness (unsupported cross-harness).
  [AgentComponentKind.Hook]: buildMatrix({
    identity: SUPPORTED,
    crossHarness: UNSUPPORTED,
  }),
  // Plugin/Workflow carry to another harness only partially, dropping the
  // harness-specific bundle/orchestration structure; lossless to their own
  // harness. A Workflow's own component fields are `maxConcurrency` and
  // `orchestrates` (see AgentComponentDetail) — the orchestration wiring another
  // harness cannot represent. (`nativeSchedule` is a HARNESS capability, not a
  // Workflow field, so it is not what a Workflow conversion drops.)
  [AgentComponentKind.Workflow]: buildMatrix({
    identity: SUPPORTED,
    crossHarness: partial(["maxConcurrency", "orchestrates"]),
  }),
  [AgentComponentKind.Plugin]: buildMatrix({
    identity: SUPPORTED,
    crossHarness: partial(["manifest"]),
  }),
  [AgentComponentKind.Mcp]: buildMatrix(OBSERVABLE_ONLY),
  [AgentComponentKind.Tool]: buildMatrix(OBSERVABLE_ONLY),
  [AgentComponentKind.Orchestration]: buildMatrix(OBSERVABLE_ONLY),
};

/**
 * Resolve the {@link ConversionCapability} for a single
 * `(componentKind, currentHarness, targetHarness)` triple. `currentHarness` is
 * the harness whose FORMAT the component is currently in — the axis the matrix
 * is keyed on — NOT its original authored-for provenance, which can differ once
 * a component has already been converted. Pure lookup against
 * {@link HARNESS_CONVERSION_CAPABILITIES}; the map's exhaustive typing means
 * every valid triple resolves to a real cell.
 */
export function resolveConversionCapability(
  kind: AgentComponentKind,
  currentHarness: HarnessName,
  targetHarness: HarnessName
): ConversionCapability {
  return HARNESS_CONVERSION_CAPABILITIES[kind][currentHarness][targetHarness];
}

// --- Dry-run request/response contract ---

/**
 * One component the caller wants to convert, in the dry-run request. Minimal by
 * design: the dry-run reasons purely over identity + kind + harness, so the web
 * preview can ask "what would happen?" without shipping definition bodies.
 *
 * Two harness fields, because they answer two different questions and MUST NOT
 * be conflated (a single field silently reports already-happened losses on the
 * second hop and mis-keys the matrix):
 *  - `currentHarness` — the harness whose FORMAT the component is in RIGHT NOW.
 *    This is the axis the capability matrix is keyed on; the dry-run resolves
 *    `currentHarness → targetHarness`. After a Claude→Codex conversion a
 *    component's `currentHarness` is `codex`, so a later Codex→OpenCode dry-run
 *    resolves the Codex row and does not re-report the Claude-preamble loss that
 *    already happened.
 *  - `sourceHarness` — OPTIONAL original provenance: the harness the component
 *    was first authored for (FEA-4028). Carried through to the converted
 *    identity untouched so provenance survives repeated conversions. When
 *    omitted, provenance defaults to `currentHarness` (a never-converted
 *    component's format IS its origin).
 *
 * A multi-harness component (one that has run under more than one harness, so
 * its component-level `Harness` is `Harness.Both`) is normalized by the caller
 * to the single concrete `currentHarness` it is being converted FROM before it
 * reaches this contract; the matrix has no `both` axis by design.
 *
 * `id` is the caller's opaque handle (echoed back on the result so the UI can
 * correlate).
 */
export type ConversionDryRunComponent = {
  readonly id: string;
  readonly name: string;
  readonly kind: AgentComponentKind;
  /** The harness whose format the component is currently in (matrix key). */
  readonly currentHarness: HarnessName;
  /**
   * Optional original provenance; defaults to {@link currentHarness} when the
   * component has never been converted.
   */
  readonly sourceHarness?: HarnessName;
};

export const conversionDryRunComponentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: agentComponentKindSchema,
  currentHarness: harnessNameSchema,
  sourceHarness: harnessNameSchema.optional(),
});

/** The dry-run request: a set of components and the harness to convert them to. */
export type ConversionDryRunRequest = {
  readonly targetHarness: HarnessName;
  readonly components: readonly ConversionDryRunComponent[];
};

export const conversionDryRunRequestSchema = z.object({
  targetHarness: harnessNameSchema,
  components: z.array(conversionDryRunComponentSchema),
});

/**
 * The identity a converted component WOULD carry — planned, not installed. It
 * preserves the ORIGINAL provenance (`sourceHarness`) alongside the harness it
 * was converted FROM (`currentHarness`) and the harness it converts TO
 * (`targetHarness`), so a converted component always records where it came from
 * (FEA-4028) without losing that origin across repeated conversions.
 */
export type ConvertedComponentIdentity = {
  readonly id: string;
  readonly name: string;
  readonly kind: AgentComponentKind;
  /** Provenance: the harness the component was ORIGINALLY authored for. */
  readonly sourceHarness: HarnessName;
  /** The harness format this conversion started from (the matrix source axis). */
  readonly currentHarness: HarnessName;
  /** The harness this planned conversion targets. */
  readonly targetHarness: HarnessName;
};

/**
 * A component the dry-run plans to convert (support `supported` or `partial`),
 * carrying the resolved capability so the UI can render the "what's lost"
 * preview for partial conversions.
 */
export type PlannedConversion = {
  readonly identity: ConvertedComponentIdentity;
  readonly capability: ConversionCapability;
};

/**
 * A component the dry-run plans to SKIP because it cannot convert
 * (`unsupported`), including the identity-in-question so the UI can name it.
 */
export type SkippedConversion = {
  readonly id: string;
  readonly name: string;
  readonly kind: AgentComponentKind;
  /** Provenance: the harness the component was ORIGINALLY authored for. */
  readonly sourceHarness: HarnessName;
  /** The harness format that was attempted as the conversion source. */
  readonly currentHarness: HarnessName;
  readonly targetHarness: HarnessName;
  readonly capability: ConversionCapability;
};

/**
 * The dry-run response: what a convert WOULD do. `conversions` are the
 * components that would install (lossless or lossy); `skips` are the ones the
 * convert would refuse. Nothing here is executed — this is a plan, not a result.
 */
export type ConversionDryRunResult = {
  readonly targetHarness: HarnessName;
  readonly conversions: readonly PlannedConversion[];
  readonly skips: readonly SkippedConversion[];
};

/**
 * Pure dry-run: given a set of components and a target harness, report the
 * planned conversions and skips WITHOUT installing anything. Capability is
 * resolved on the `(kind, currentHarness → targetHarness)` triple — the
 * component's CURRENT format, not its original provenance — so an already-once
 * converted component is not charged again for losses on a prior hop. A triple
 * that resolves to `unsupported` lands in `skips`; everything else (supported or
 * partial) lands in `conversions`. Original provenance (`sourceHarness`) is
 * preserved into the result untouched, defaulting to `currentHarness` for a
 * never-converted component.
 *
 * Deterministic and side-effect-free: it only reads
 * {@link HARNESS_CONVERSION_CAPABILITIES}. The convert engine (FEA-4079) is the
 * separate slice that acts on this plan.
 */
export function planConversionDryRun(
  request: ConversionDryRunRequest
): ConversionDryRunResult {
  const { targetHarness, components } = request;
  const conversions: PlannedConversion[] = [];
  const skips: SkippedConversion[] = [];

  for (const component of components) {
    const { currentHarness } = component;
    const sourceHarness = component.sourceHarness ?? currentHarness;
    const capability = resolveConversionCapability(
      component.kind,
      currentHarness,
      targetHarness
    );
    if (capability.support === ConversionSupport.Unsupported) {
      skips.push({
        id: component.id,
        name: component.name,
        kind: component.kind,
        sourceHarness,
        currentHarness,
        targetHarness,
        capability,
      });
      continue;
    }
    conversions.push({
      identity: {
        id: component.id,
        name: component.name,
        kind: component.kind,
        sourceHarness,
        currentHarness,
        targetHarness,
      },
      capability,
    });
  }

  return { targetHarness, conversions, skips };
}
