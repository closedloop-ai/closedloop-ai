/**
 * ISS-9348 — the one contract every inline editable cell is built against.
 *
 * A grid cell the user EDITS IN PLACE. Ten approved variants (text, number,
 * date, enum, status, priority, person, multi-person, tag, reference), one
 * champion, no parallel components — and this module is the prop/state/event
 * shape that claim is checkable against. It is the handoff ISS-9349 implements;
 * it deliberately builds no component.
 *
 * **Why it is here and domain-free.** The variants differ in how a value is
 * PICKED, never in what the value means. A person id, a tag id, a priority
 * member and a reference id are all opaque member ids at this layer, so the
 * whole model is project-agnostic and sits beside `priority-order.ts` and
 * `column-registry.ts` rather than in a feature slice. What each member LOOKS
 * like, which members exist, and who may write one are the domain adapter's, in
 * `packages/app`. `no-design-system-domain-import` (`pnpm check:source-gates`)
 * is what keeps that line here.
 *
 * **What this contract is NOT.** It does not map a variant to a component and
 * does not convert a domain value to and from an editor's transport value —
 * that pair is the registry and the codecs, ISS-9484. The boundary helpers
 * below resolve MEMBERSHIP (is this id one the surface knows?) and CLASSIFY a
 * refusal; neither parses, formats, or round-trips a value.
 *
 * **It carries no user-visible words.** Every vocabulary here is a machine
 * member. A label, an empty state, a validation sentence or a conflict notice is
 * a human's to write and an adapter's to supply — see the root `AGENTS.md`,
 * Human Provenance for Product Behavior.
 *
 * Ownership per layer — presentation, domain mapping, data access, mutations,
 * rollout flags — is in this package's `AGENTS.md`, under
 * "Inline editable cell ownership".
 */

/**
 * The approved editor vocabulary (PRD-722 scope contract).
 *
 * `Status` and `Priority` are stated separately from `Enum` although all three
 * pick one member from a closed set: they are different CONTEXTS with different
 * marks and different write authorities, and one can change without the others.
 * Same reasoning `ArtifactPriorityVariant` already uses for `Filter` vs
 * `IconOnly`.
 */
export const InlineCellVariant = {
  Text: "text",
  Number: "number",
  Date: "date",
  Enum: "enum",
  Status: "status",
  Priority: "priority",
  Person: "person",
  MultiPerson: "multi-person",
  Tag: "tag",
  Reference: "reference",
} as const;
export type InlineCellVariant =
  (typeof InlineCellVariant)[keyof typeof InlineCellVariant];

/** How the editor is reached from the resting cell. */
export const InlineCellEntry = {
  /** The committed value is replaced in place by a focusable text control. */
  Field: "field",
  /** Activation opens a menu or popover anchored to the cell. */
  Overlay: "overlay",
} as const;
export type InlineCellEntry =
  (typeof InlineCellEntry)[keyof typeof InlineCellEntry];

/** How many members the cell holds at once. */
export const InlineCellCardinality = {
  Single: "single",
  Multiple: "multiple",
} as const;
export type InlineCellCardinality =
  (typeof InlineCellCardinality)[keyof typeof InlineCellCardinality];

/**
 * What a commit IS, which is what decides what Enter, Escape, Tab and blur mean.
 *
 * `Draft` cells hold an uncommitted edit, so they need the blur/Escape interlock
 * `InlineScalarCell` documents, and Tab commits and moves on. `Selection` cells
 * hold none: choosing an option IS the write, and dismissal writes nothing by
 * construction rather than by an interlock (see `InlineDateCell`). Escape on a
 * `Selection` cell therefore has nothing to revert, and a contract that gave
 * both the same cancel semantics would promise one of them something it cannot
 * do.
 */
export const InlineCellCommit = {
  Draft: "draft",
  Selection: "selection",
} as const;
export type InlineCellCommit =
  (typeof InlineCellCommit)[keyof typeof InlineCellCommit];

/**
 * What the user presses to start editing.
 *
 * Every approved variant admits {@link InlineCellAffordance.WholeCell}: no
 * dropdown caret, no hover-revealed action icon, nothing that changes the
 * cell's size between resting and hover. `Tag` alone also admits
 * `AdjacentControl`, because production ships it: the Documents grid routes a
 * chip press to search (`packages/app/documents/components/table/cells/tags-cell.tsx`
 * through `EntityTagsCell`'s `onChipClick`), a navigable chip is its own button,
 * and a button cannot nest inside the picker's trigger — so there the chips
 * ride beside the trigger instead of inside it. A variant that later needs the
 * second shape has to SAY so in the spec table rather than grow a caret nobody
 * decided on.
 */
export const InlineCellAffordance = {
  WholeCell: "whole-cell",
  AdjacentControl: "adjacent-control",
} as const;
export type InlineCellAffordance =
  (typeof InlineCellAffordance)[keyof typeof InlineCellAffordance];

/**
 * `affordances` and `cardinalities` are the SETS a variant admits, not one
 * answer, because production ships both forms of some variants; each cell
 * states which member it uses through {@link InlineCellContract}.
 */
export type InlineCellVariantSpec = Readonly<{
  affordances: readonly [InlineCellAffordance, ...InlineCellAffordance[]];
  cardinalities: readonly [InlineCellCardinality, ...InlineCellCardinality[]];
  commit: InlineCellCommit;
  entry: InlineCellEntry;
}>;

/**
 * Exhaustive by type: a variant added to the vocabulary fails `tsc` here until
 * it states its four answers, so the champion can never acquire a variant that
 * falls through to another one's interaction model.
 *
 * Every derived list in this module reads THIS table rather than repeating a
 * subset of the members, because a hand-written `["text", "number"]` still
 * compiles after an eleventh variant arrives and silently sends it down the
 * default branch.
 *
 * `Enum` and `Reference` admit both cardinalities because custom fields store
 * both forms of each — `ENUM` and `MULTI_ENUM`, `REFERENCE` and
 * `REFERENCE_MULTI` (`CUSTOM_FIELD_CARDINALITY`,
 * `packages/api/src/types/custom-field-capabilities.ts`). Fixing either
 * to one would make a registry misclassify the other form or state a second
 * cardinality rule of its own.
 */
export const INLINE_CELL_VARIANT_SPEC = {
  [InlineCellVariant.Text]: {
    affordances: [InlineCellAffordance.WholeCell],
    cardinalities: [InlineCellCardinality.Single],
    commit: InlineCellCommit.Draft,
    entry: InlineCellEntry.Field,
  },
  [InlineCellVariant.Number]: {
    affordances: [InlineCellAffordance.WholeCell],
    cardinalities: [InlineCellCardinality.Single],
    commit: InlineCellCommit.Draft,
    entry: InlineCellEntry.Field,
  },
  // A calendar, not `<input type="date">`: the native control ships the
  // browser's own unstyled picker, which the design system cannot reach.
  // `InlineDateCell` records why, and delegating to a popover is what makes
  // this an overlay rather than a field.
  [InlineCellVariant.Date]: {
    affordances: [InlineCellAffordance.WholeCell],
    cardinalities: [InlineCellCardinality.Single],
    commit: InlineCellCommit.Selection,
    entry: InlineCellEntry.Overlay,
  },
  [InlineCellVariant.Enum]: {
    affordances: [InlineCellAffordance.WholeCell],
    cardinalities: [InlineCellCardinality.Single, InlineCellCardinality.Multiple],
    commit: InlineCellCommit.Selection,
    entry: InlineCellEntry.Overlay,
  },
  [InlineCellVariant.Status]: {
    affordances: [InlineCellAffordance.WholeCell],
    cardinalities: [InlineCellCardinality.Single],
    commit: InlineCellCommit.Selection,
    entry: InlineCellEntry.Overlay,
  },
  [InlineCellVariant.Priority]: {
    affordances: [InlineCellAffordance.WholeCell],
    cardinalities: [InlineCellCardinality.Single],
    commit: InlineCellCommit.Selection,
    entry: InlineCellEntry.Overlay,
  },
  [InlineCellVariant.Person]: {
    affordances: [InlineCellAffordance.WholeCell],
    cardinalities: [InlineCellCardinality.Single],
    commit: InlineCellCommit.Selection,
    entry: InlineCellEntry.Overlay,
  },
  [InlineCellVariant.MultiPerson]: {
    affordances: [InlineCellAffordance.WholeCell],
    cardinalities: [InlineCellCardinality.Multiple],
    commit: InlineCellCommit.Selection,
    entry: InlineCellEntry.Overlay,
  },
  [InlineCellVariant.Tag]: {
    affordances: [
      InlineCellAffordance.WholeCell,
      InlineCellAffordance.AdjacentControl,
    ],
    cardinalities: [InlineCellCardinality.Multiple],
    commit: InlineCellCommit.Selection,
    entry: InlineCellEntry.Overlay,
  },
  [InlineCellVariant.Reference]: {
    affordances: [InlineCellAffordance.WholeCell],
    cardinalities: [InlineCellCardinality.Single, InlineCellCardinality.Multiple],
    commit: InlineCellCommit.Selection,
    entry: InlineCellEntry.Overlay,
  },
} as const satisfies Readonly<Record<InlineCellVariant, InlineCellVariantSpec>>;

/**
 * Why the cell is not editable right now — four distinct claims that must not
 * collapse, because they answer different questions for the reader.
 *
 * This is the editability half of the state model. It is orthogonal to
 * {@link InlineCellValueState} and to {@link InlineCellCommitFailure}: a cell
 * can be `Forbidden` and `Loading`, or `Editable` and `Unavailable`, and a
 * single flat enum over all three would make most of those unrepresentable.
 */
export const InlineCellEditability = {
  Editable: "editable",
  /** This surface does not offer editing for this field at all. */
  ReadOnly: "read-only",
  /** Not actionable for a transient reason — a write already in flight, a busy row. */
  Disabled: "disabled",
  /** The surface offers the editor; this viewer may not write it. */
  Forbidden: "forbidden",
} as const;
export type InlineCellEditability =
  (typeof InlineCellEditability)[keyof typeof InlineCellEditability];

export type InlineCellEditabilitySpec = Readonly<{
  /** Whether an editor is reachable at all. */
  offersEditor: boolean;
  /**
   * Whether the SAME viewer on the SAME row could see this become editable
   * without a permission change. True only for {@link
   * InlineCellEditability.Disabled}, whose blocker is transient — which is what
   * separates `Disabled` from the other two non-editable members, and nothing
   * more.
   */
  transient: boolean;
}>;

/**
 * Exhaustive by type, same guarantee as the variant table.
 *
 * `ReadOnly` and `Forbidden` give the same answer on both axes: neither reaches
 * an editor and neither clears on its own. What separates them is WHO decided —
 * the surface, or this viewer's permission — and nothing the cell derives
 * depends on that, so a consumer that must tell them apart branches on the
 * {@link InlineCellEditability} member itself, which the adapter passes in.
 *
 * It states no copy. Which of these the surface explains to the reader, and in
 * what words, is a product decision and a human's to make.
 */
export const INLINE_CELL_EDITABILITY_SPEC: Readonly<
  Record<InlineCellEditability, InlineCellEditabilitySpec>
> = {
  [InlineCellEditability.Editable]: { offersEditor: true, transient: false },
  [InlineCellEditability.ReadOnly]: { offersEditor: false, transient: false },
  [InlineCellEditability.Disabled]: { offersEditor: false, transient: true },
  [InlineCellEditability.Forbidden]: { offersEditor: false, transient: false },
};

/**
 * What the cell knows about its own value — the `packages/app` rule that
 * loading, unavailable and a real absence are three different claims, made into
 * a type so a cell cannot render one as another.
 *
 * `Unavailable` is the partial-load case: the row arrived, this field did not.
 * It is not `Empty`, and rendering it as `Empty` tells the reader nobody set the
 * value when in fact nobody fetched it.
 */
export const InlineCellValueState = {
  Present: "present",
  /** Genuinely no value. The user cleared it, or never set one. */
  Empty: "empty",
  /** The producer did not carry this field on this row. */
  Unavailable: "unavailable",
  /** Still arriving. */
  Loading: "loading",
} as const;
export type InlineCellValueState =
  (typeof InlineCellValueState)[keyof typeof InlineCellValueState];

/**
 * The value and what is known about it, as one discriminated union rather than
 * a value plus a separate state flag.
 *
 * A pair would make `{ state: "loading", value: "…" }` representable, and a
 * champion reading `value` without checking the flag would render a stale value
 * as a live one. Here there is no value to read outside `Present`, so the lie is
 * unrepresentable rather than merely discouraged — the same reason
 * `GridColumnTracks` discriminates on `hasLeadingUtility`.
 *
 * `Present` carries `NonNullable<TValue>` for the same reason: an adapter whose
 * field data is nullable would otherwise write `{ state: "present", value: null }`
 * and bypass `Empty`, which is the one member that means "no value".
 */
export type InlineCellValue<TValue> =
  | Readonly<{
      state: typeof InlineCellValueState.Present;
      value: NonNullable<TValue>;
    }>
  | Readonly<{ state: typeof InlineCellValueState.Empty }>
  | Readonly<{ state: typeof InlineCellValueState.Unavailable }>
  | Readonly<{ state: typeof InlineCellValueState.Loading }>;

/**
 * Why a commit did not stick. Closed, and the champion switches on the member
 * rather than on a transport error — an adapter classifies, presentation reacts,
 * and the host hears which one through `InlineCellContract.onCommitFailure`.
 *
 * The three route differently and so cannot be one member: `Validation` is local
 * and the draft is still the user's to repair, `Rejected` is the write failing
 * and retrying is meaningful, and `Conflict` means the authoritative value moved
 * under the write so the draft is answering a question that changed.
 */
export const InlineCellCommitFailure = {
  Validation: "validation",
  Rejected: "rejected",
  Conflict: "conflict",
} as const;
export type InlineCellCommitFailure =
  (typeof InlineCellCommitFailure)[keyof typeof InlineCellCommitFailure];

/** A member id resolved against the set the surface actually knows. */
export const InlineCellSelectionKind = {
  /** The surface offers this member. */
  Known: "known",
  /**
   * A well-formed id the surface does not know — the version-skew case, where a
   * newer peer wrote a member this build has never heard of. It keeps its raw
   * id so the render shows what is stored instead of a fabricated label or a
   * silent fallback to a default member.
   */
  Unknown: "unknown",
  /** No member. */
  Absent: "absent",
  /** Something is stored and it cannot be a member id. */
  Malformed: "malformed",
} as const;
export type InlineCellSelectionKind =
  (typeof InlineCellSelectionKind)[keyof typeof InlineCellSelectionKind];

export type InlineCellSelection =
  | Readonly<{ kind: typeof InlineCellSelectionKind.Known; memberId: string }>
  | Readonly<{ kind: typeof InlineCellSelectionKind.Unknown; memberId: string }>
  | Readonly<{ kind: typeof InlineCellSelectionKind.Absent }>
  | Readonly<{ kind: typeof InlineCellSelectionKind.Malformed }>;

/**
 * The champion's prop and event contract, generic over the committed value.
 *
 * Generic on purpose: the fixture-bound editors this replaces
 * (`packages/app/shared/components/generic-artifact-surface/editable-cells.tsx`)
 * each named a fixture type in their props — `ArtifactRow`, `ArtifactStatus`,
 * `TablePerson` — which is exactly what made them unreusable outside the one
 * surface that owned the fixture. Nothing here names a domain type, a fixture,
 * a transport, or a query client.
 *
 * Everything the cell cannot compute is passed IN, already resolved by the
 * adapter: what the viewer may do, whether the field arrived, what the members
 * are. The cell owns the interaction and nothing else.
 */
export type InlineCellContract<TValue> = InlineCellVariantShape &
  Readonly<{
    /**
     * Accessible name for the editor. A table renders a column of otherwise
     * identical controls, so this must name WHICH row it opens — the adapter
     * composes it, because only the adapter knows the row. This contract never
     * builds one.
     */
    label: string;
    value: InlineCellValue<TValue>;
    editability: InlineCellEditability;
    /**
     * Signals a refusal by rejecting, and the cell restores the newest value that
     * was not refused. Rejecting with an {@link InlineCellCommitFailure} member
     * says WHY; rejecting with anything else still rolls back, classified through
     * {@link classifyInlineCellCommitFailure}. Either way the classified member
     * reaches `onCommitFailure`.
     *
     * **`useCommitLedger` owns that rollback for every champion**
     * (`components/ui/use-commit-ledger.ts`). It is generic over `TValue`: a
     * scalar submission and a multi-value submission's whole next set are each
     * one fact ordered by a monotonic token. The ledger does not compare set
     * members or infer domain equality; it restores the newest accepted or
     * still-pending submitted value as a unit.
     */
    onCommit: (next: TValue) => Promise<unknown> | void;
    /**
     * Fires when the user leaves the editor without writing — Escape on a `Draft`
     * variant, dismissal on a `Selection` one. Optional: a cell that restores its
     * own focus needs no host involvement.
     */
    onCancel?: () => void;
    /**
     * Reports a refused commit to the host, classified through {@link
     * classifyInlineCellCommitFailure}. The cell's own reaction does not depend
     * on it; the host's can: `Conflict` means the authoritative value moved under
     * the write, and only the host can refetch the row. Optional, because a host
     * with nothing to route has nothing to do.
     */
    onCommitFailure?: (failure: InlineCellCommitFailure) => void;
  }>;

/**
 * The variant and the two per-cell choices its spec admits, typed FROM the spec
 * table: a `Person` cell holding a list, or a `Text` cell given an adjacent
 * control, does not compile.
 */
type InlineCellVariantShape = {
  [V in InlineCellVariant]: Readonly<{
    variant: V;
    /** Which of this variant's admitted press targets the cell uses. */
    affordance: (typeof INLINE_CELL_VARIANT_SPEC)[V]["affordances"][number];
    /** Which of this variant's admitted cardinalities the cell holds. */
    cardinality: (typeof INLINE_CELL_VARIANT_SPEC)[V]["cardinalities"][number];
  }>;
}[InlineCellVariant];

/**
 * Whether a variant opens an overlay, derived from the spec table so an
 * eleventh variant cannot be omitted from it.
 */
export function opensInlineCellOverlay(variant: InlineCellVariant): boolean {
  return INLINE_CELL_VARIANT_SPEC[variant].entry === InlineCellEntry.Overlay;
}

/**
 * Whether a variant holds an uncommitted draft, and therefore owes Escape a
 * revert, blur a commit, and Tab a commit-and-advance. Derived, for the same
 * reason as above.
 */
export function holdsInlineCellDraft(variant: InlineCellVariant): boolean {
  return INLINE_CELL_VARIANT_SPEC[variant].commit === InlineCellCommit.Draft;
}

/** Whether this editability state reaches an editor at all. */
export function offersInlineCellEditor(
  editability: InlineCellEditability
): boolean {
  return INLINE_CELL_EDITABILITY_SPEC[editability].offersEditor;
}

/**
 * Resolve one stored member id against the members this surface knows.
 *
 * The trust boundary. `raw` arrives from an API response, a persisted row, or a
 * peer on another version, so it is `unknown` and not `string` — a type
 * annotation constrains nobody at runtime, and the failure this exists to stop
 * is a cell confidently rendering a value it could not read.
 *
 * - `null`, `undefined` and `""` are `Absent`. The empty string is this repo's
 *   established spelling of "no value" for an inline scalar, so honouring it
 *   here keeps one answer rather than two.
 * - A non-empty string the surface does not know is `Unknown`, not `Absent` and
 *   not coerced to a default. Something IS set; this build just cannot name it.
 * - A string that is blank only after trimming is `Malformed`, not `Absent`. It
 *   is not the repo's spelling of absence and it is not a usable id either, so
 *   it has no honest reading — calling it `Absent` would claim nobody set a
 *   value, and calling it `Unknown` would render whitespace as one.
 * - Every other shape — a number, a boolean, an object, an array — is
 *   `Malformed`.
 */
export function resolveInlineCellSelection(
  raw: unknown,
  knownMemberIds: readonly string[]
): InlineCellSelection {
  if (raw === null || raw === undefined || raw === "") {
    return { kind: InlineCellSelectionKind.Absent };
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    return { kind: InlineCellSelectionKind.Malformed };
  }
  if (knownMemberIds.includes(raw)) {
    return { kind: InlineCellSelectionKind.Known, memberId: raw };
  }
  return { kind: InlineCellSelectionKind.Unknown, memberId: raw };
}

/**
 * The same boundary for a multi-valued cell (multi-person, tag, reference).
 *
 * A missing list is no members, which is the same fact as an empty one. A
 * present non-list is one `Malformed` member rather than an empty list, so the
 * cell says "something is here and it is wrong" instead of "nothing is here" —
 * those are different claims and only one of them is true. Entries are resolved
 * individually and kept in order: a malformed or unknown member is reported,
 * never dropped, because dropping it is the silent coercion that makes a cell
 * disagree with what is stored.
 *
 * A repeated member id is one member, not two, so only its first occurrence is
 * kept — otherwise the cell draws the same chip twice. Entries that carry no id
 * (`Absent`, `Malformed`) are each reported.
 */
export function resolveInlineCellSelections(
  raw: unknown,
  knownMemberIds: readonly string[]
): readonly InlineCellSelection[] {
  if (raw === null || raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return [{ kind: InlineCellSelectionKind.Malformed }];
  }
  const seenMemberIds = new Set<string>();
  return raw
    .map((entry) => resolveInlineCellSelection(entry, knownMemberIds))
    .filter((selection) => {
      if (!("memberId" in selection)) {
        return true;
      }
      if (seenMemberIds.has(selection.memberId)) {
        return false;
      }
      seenMemberIds.add(selection.memberId);
      return true;
    });
}

/**
 * Classify whatever a refused commit rejected with.
 *
 * A reason this build does not recognise degrades to
 * {@link InlineCellCommitFailure.Rejected} — the repo's cross-repo rule that an
 * unknown reason maps to the generic one rather than crashing or inventing a
 * classification. The rollback is identical either way; only what the surface
 * may say about it changes, and saying nothing is always available.
 */
export function classifyInlineCellCommitFailure(
  reason: unknown
): InlineCellCommitFailure {
  for (const member of Object.values(InlineCellCommitFailure)) {
    if (reason === member) {
      return member;
    }
  }
  return InlineCellCommitFailure.Rejected;
}
