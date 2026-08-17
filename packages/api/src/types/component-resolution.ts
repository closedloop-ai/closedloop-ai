/**
 * FEA-3704 — the ONE shared resolution model + labels for the agents workspace,
 * consumed by BOTH the web surface (`apps/app` / `packages/app`) and the desktop
 * renderer. Canonical location per CLAUDE.md ("Never duplicate types"); do NOT
 * re-declare these string literals or the derivation anywhere else.
 *
 * Component APIs already ship the raw resolution metadata — the persisted
 * `ComponentResolvedState` (DB enum: resolved | unresolved | inaccessible |
 * missing) plus, per revision, the exact `definitionHash` and the
 * `normalizerContractVersion` under which it was produced. Nothing product-facing
 * consumed any of it. This module turns that raw metadata into a single honest
 * DISPLAY state a surface can render truthfully, and never lies:
 *
 *  - `resolved`          — backed by an exact definition the org can read.
 *  - `unresolved`        — name-only / label-minted / legacy row; no definition.
 *  - `stale-definition`  — resolved, but the revision the session ran against
 *                          (`definitionHash`) differs from the component's
 *                          current definition (definition drifted since capture).
 *  - `contract-mismatch` — a `definitionHash` was captured under a
 *                          `normalizerContractVersion` this client does not
 *                          understand, so the fingerprint can't be trusted for an
 *                          exact-identity comparison.
 *  - `unavailable`       — the definition body was present but could not be read
 *                          (permission-denied / `inaccessible`, or deleted /
 *                          `missing`). Last-known-good is preserved — never
 *                          collapsed into a false "resolved".
 *  - `malformed`         — the resolution metadata itself is not a recognized
 *                          shape (unknown/absent `resolvedState`); rendered
 *                          honestly rather than silently coerced to "resolved".
 *
 * CRITICAL invariants (mirror the cloud service's `reduceResolvedState` doc):
 *  - `inaccessible` (permission-denied, last-known-good preserved) is NEVER
 *    collapsed into `missing` (deleted/absent); both map to the neutral,
 *    non-lying `unavailable` display state.
 *  - An unknown/absent raw state is `malformed`, never `resolved`.
 */

import { NORMALIZER_CONTRACT_VERSION } from "../definition-fingerprint";
import {
  ComponentResolvedState,
  type SourceOccurrence,
} from "./agent-component";

/**
 * The display-level resolution state a surface renders. Derived from the raw
 * persisted `ComponentResolvedState` plus optional revision fingerprint metadata
 * — see {@link deriveResolutionDisplay}. Const-object enum (never TS `enum`),
 * matching the repo idiom.
 */
export const ComponentResolutionDisplayState = {
  Resolved: "resolved",
  Unresolved: "unresolved",
  StaleDefinition: "stale-definition",
  ContractMismatch: "contract-mismatch",
  Unavailable: "unavailable",
  Malformed: "malformed",
} as const;
export type ComponentResolutionDisplayState =
  (typeof ComponentResolutionDisplayState)[keyof typeof ComponentResolutionDisplayState];

/**
 * Presentational descriptor for a display state — the ONE place the human label,
 * one-line description, and severity/tone live so web and desktop render the
 * identical model. `tone` is a surface-neutral severity the renderer maps to its
 * own token/variant (e.g. a Chip variant); this module never imports a UI kit.
 */
export type ComponentResolutionLabel = {
  state: ComponentResolutionDisplayState;
  /** Short human label, e.g. "Resolved", "Stale definition". */
  label: string;
  /** One-line, honest description of what the state means. */
  description: string;
  /** Surface-neutral severity the renderer maps to its own variant/token. */
  tone: "positive" | "neutral" | "warning" | "danger";
};

/**
 * SSOT label/description/tone per display state. Exhaustive `Record` so adding a
 * new display state fails to compile until it is labeled here (CLAUDE.md
 * "Exhaustiveness").
 */
export const COMPONENT_RESOLUTION_LABELS: Record<
  ComponentResolutionDisplayState,
  ComponentResolutionLabel
> = {
  [ComponentResolutionDisplayState.Resolved]: {
    state: ComponentResolutionDisplayState.Resolved,
    label: "Resolved",
    description: "Backed by an exact definition this org can read.",
    tone: "positive",
  },
  [ComponentResolutionDisplayState.Unresolved]: {
    state: ComponentResolutionDisplayState.Unresolved,
    label: "Unresolved",
    description:
      "Name-only reference — no definition has been captured for this component.",
    tone: "neutral",
  },
  [ComponentResolutionDisplayState.StaleDefinition]: {
    state: ComponentResolutionDisplayState.StaleDefinition,
    label: "Stale definition",
    description:
      "The captured revision differs from the component's current definition.",
    tone: "warning",
  },
  [ComponentResolutionDisplayState.ContractMismatch]: {
    state: ComponentResolutionDisplayState.ContractMismatch,
    label: "Contract mismatch",
    description:
      "Fingerprinted under a normalizer contract this client does not understand.",
    tone: "warning",
  },
  [ComponentResolutionDisplayState.Unavailable]: {
    state: ComponentResolutionDisplayState.Unavailable,
    label: "Unavailable",
    description:
      "The definition body could not be read (permission-denied or removed); last-known-good is preserved.",
    tone: "danger",
  },
  [ComponentResolutionDisplayState.Malformed]: {
    state: ComponentResolutionDisplayState.Malformed,
    label: "Malformed",
    description:
      "The resolution metadata was not a recognized shape and cannot be trusted.",
    tone: "danger",
  },
};

/**
 * The raw resolution metadata a surface has for one component — the fields the
 * component APIs already ship. Every field beyond `resolvedState` is optional so
 * OLDER desktop clients (which omit the fingerprint metadata entirely) preserve
 * their behavior: with no fingerprint inputs, derivation falls back to the raw
 * `resolvedState` mapping and never fabricates a stale/contract-mismatch state
 * (FEA-3704 optional-field compat).
 */
export type ComponentResolutionInput = {
  /**
   * The persisted org-level resolution. Typed loosely as `string | null |
   * undefined` on purpose: an unknown/absent value is honestly surfaced as
   * `malformed`, never coerced to `resolved`.
   */
  resolvedState: ComponentResolvedState | string | null | undefined;
  /**
   * The exact fingerprint of the revision a session ran against, when known.
   * Optional — absent for pre-F1 / still-unlinked revisions and older clients.
   */
  observedDefinitionHash?: string | null;
  /**
   * The component's CURRENT exact fingerprint, when known. When both this and
   * `observedDefinitionHash` are present and differ, the component is
   * `stale-definition`.
   */
  currentDefinitionHash?: string | null;
  /**
   * The `normalizerContractVersion` the `observedDefinitionHash` was produced
   * under. When present and not equal to {@link NORMALIZER_CONTRACT_VERSION} this
   * client understands, the component is `contract-mismatch`.
   */
  normalizerContractVersion?: number | null;
};

/**
 * The set of raw `ComponentResolvedState` values, for a fast membership check
 * that never coerces an unknown string into the enum.
 */
const RAW_RESOLVED_STATES: ReadonlySet<string> = new Set<string>(
  Object.values(ComponentResolvedState)
);

/**
 * Derive the honest DISPLAY resolution state from raw metadata. This is the ONE
 * derivation both surfaces call — never re-implement it.
 *
 * Precedence (most-specific first) is deliberate:
 *  1. `malformed`          — the raw state is unknown/absent; trust nothing.
 *  2. `unavailable`        — `inaccessible` OR `missing` (kept distinct upstream,
 *                            merged here into one non-lying display state).
 *  3. `unresolved`         — no definition captured.
 *  4. `contract-mismatch`  — resolved, but the observed fingerprint was minted
 *                            under an unknown normalizer contract.
 *  5. `stale-definition`   — resolved, understood contract, but the observed
 *                            fingerprint differs from the current one.
 *  6. `resolved`           — resolved and (when comparable) current.
 *
 * The fingerprint-derived states (4/5) only ever REFINE `resolved`; a
 * non-resolved raw state is never upgraded by fingerprint inputs, and absent
 * fingerprint inputs leave a resolved component `resolved` (older-client compat).
 */
export function deriveResolutionDisplay(
  input: ComponentResolutionInput
): ComponentResolutionDisplayState {
  const raw = input.resolvedState;

  if (typeof raw !== "string" || !RAW_RESOLVED_STATES.has(raw)) {
    return ComponentResolutionDisplayState.Malformed;
  }

  if (
    raw === ComponentResolvedState.Inaccessible ||
    raw === ComponentResolvedState.Missing
  ) {
    return ComponentResolutionDisplayState.Unavailable;
  }

  if (raw === ComponentResolvedState.Unresolved) {
    return ComponentResolutionDisplayState.Unresolved;
  }

  // raw === ComponentResolvedState.Resolved — refine with fingerprint metadata.
  if (
    input.normalizerContractVersion != null &&
    input.normalizerContractVersion !== NORMALIZER_CONTRACT_VERSION
  ) {
    return ComponentResolutionDisplayState.ContractMismatch;
  }

  if (
    input.observedDefinitionHash != null &&
    input.currentDefinitionHash != null &&
    input.observedDefinitionHash !== input.currentDefinitionHash
  ) {
    return ComponentResolutionDisplayState.StaleDefinition;
  }

  return ComponentResolutionDisplayState.Resolved;
}

/**
 * Convenience: derive the display state AND its presentational label in one call.
 */
export function resolutionLabel(
  input: ComponentResolutionInput
): ComponentResolutionLabel {
  return COMPONENT_RESOLUTION_LABELS[deriveResolutionDisplay(input)];
}

// ---------------------------------------------------------------------------
// Org-level resolution fold (FEA-3704) — the ONE shared precedence + reducer
// ---------------------------------------------------------------------------

/**
 * Precedence for folding many per-device raw `ComponentResolvedState` values into
 * ONE org-level state (highest wins). This is the single source of truth shared
 * by the cloud service (`apps/api`) and the desktop dashboard
 * (`apps/desktop`) so both surfaces agree exactly:
 *   `resolved > inaccessible > unresolved > missing`
 *
 * CRITICALLY, `inaccessible` (permission-denied, last-known-good preserved) is
 * NEVER collapsed into `missing` (deleted/absent); `resolved` wins whenever ANY
 * device honestly backs the definition, and `missing` only wins when every device
 * agrees the definition is gone. Empty input is the DB default `unresolved` — a
 * name-only identity, never "resolved". Exhaustive `Record` so a new
 * `ComponentResolvedState` fails to compile until it is ranked here.
 */
export const RESOLVED_STATE_PRECEDENCE: Record<ComponentResolvedState, number> =
  {
    [ComponentResolvedState.Resolved]: 3,
    [ComponentResolvedState.Inaccessible]: 2,
    [ComponentResolvedState.Unresolved]: 1,
    [ComponentResolvedState.Missing]: 0,
  };

/**
 * Fold two per-device resolution states into the higher-precedence one, per
 * {@link RESOLVED_STATE_PRECEDENCE}. Pure and associative/commutative so callers
 * can accumulate over a stream in any order.
 */
export function foldResolvedState(
  a: ComponentResolvedState,
  b: ComponentResolvedState
): ComponentResolvedState {
  return RESOLVED_STATE_PRECEDENCE[b] > RESOLVED_STATE_PRECEDENCE[a] ? b : a;
}

/**
 * Reduce many per-device raw resolution states into the ONE org-level state,
 * using {@link foldResolvedState}. Empty input is the DB default `unresolved`
 * (a name-only identity), never "resolved".
 */
export function reduceResolvedState(
  states: Iterable<ComponentResolvedState>
): ComponentResolvedState {
  let best: ComponentResolvedState = ComponentResolvedState.Unresolved;
  let bestRank = -1;
  for (const state of states) {
    const rank = RESOLVED_STATE_PRECEDENCE[state];
    if (rank > bestRank) {
      bestRank = rank;
      best = state;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Source-occurrence read contract (FEA-3704)
// ---------------------------------------------------------------------------

/**
 * Paginated org-scoped source-occurrence response. `items` are pure provenance
 * (never a definition body); `total` is the org-scoped count for the version so
 * the caller can page without a second request. `hasMore` mirrors the list
 * response convention.
 */
export type SourceOccurrenceListResponse = {
  items: SourceOccurrence[];
  total: number;
  hasMore: boolean;
};
