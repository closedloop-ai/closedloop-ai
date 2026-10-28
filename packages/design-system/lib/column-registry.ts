/**
 * The typed column registry and capability schema for the Gridview column
 * system (ISS-9446, PRD-716 phase 02).
 *
 * `GridTableV2Column` is the table's RENDER prop — what `GridTableV2` needs to
 * paint a header. It carries id, label, className, three capability booleans, a
 * tooltip, an accessible name and a resolved alignment, and deliberately
 * nothing else. This module is
 * the DECLARATION that sits above it: what a column *is* (its field kind), how
 * wide it may get, which end of the cell it aligns to, whether it may be
 * hidden, moved, resized or pinned, and its metadata-only relative priority.
 * The registry validates a declaration set once and adapts it
 * down to the render prop with {@link ColumnRegistry.toGridColumns}, so a host
 * declares columns in one place instead of spreading the same facts across a
 * column array, a `gridTemplateColumns` string, a hidden-column list and a
 * `renderCell` switch.
 *
 * Project-agnostic by construction — no Closedloop domain concept appears here.
 * A domain column set (Sessions, Branches) declares its own
 * {@link ColumnDefinition} array in its feature slice under `packages/app` and
 * hands it to {@link createColumnRegistry}; the mapping from a domain field to a
 * {@link ColumnFieldKind} is that slice's job, not this module's.
 *
 * ## What this module deliberately does NOT own
 *
 * - **Cell and header rendering.** `GridTableV2` renders through one
 *   table-level `renderCell(columnId, item)`. {@link ColumnFieldKind} is
 *   therefore the *renderer selector* a host switches on, not a per-column
 *   render function: adding `render`/`edit` callbacks here would be a second,
 *   competing render model beside the one the grid already has.
 * - **Ordering, resizing and width application.** `lib/column-order` already
 *   owns `orderColumns`, `mergeColumnOrder`, `clampColumnWidth`,
 *   `resizeColumnByDirection` and `applyColumnWidths`, and works on anything
 *   with an `id` — so it composes with {@link ColumnDefinition} unchanged.
 * - **Persistence.** A registry is authored in source; the persisted view state
 *   that references it by id is the app layer's (ISS-9447).
 * - **A database, an IPC hop, an authorization surface, a host-specific half** —
 *   none of them, which ISS-9446 records as negative findings with their
 *   evidence in `docs/design/column-system-ownership.md` rather than leaving a
 *   reader to guess whether they were considered at all.
 *
 * ## What a declaration here now reaches, and what it still does not
 *
 * {@link ColumnDefinition.ariaLabel} was wired by ISS-9706: `toGridColumns`
 * hands it to `GridTableV2Column.ariaLabel`, `GridTableV2` forwards it, and the
 * header resolves it through `resolveColumnHeaderAriaLabel` /
 * `resolveColumnControlName` onto the `columnheader` element and that column's
 * own controls. A set that validates clean under
 * {@link ColumnRegistryIssueCode.MissingAccessibleName} therefore does mean its
 * blank-label columns announce a name.
 *
 * Phase 03 (ISS-9313) wired two more through `lib/column-layout`:
 * {@link ColumnDefinition.align} reaches the header label and the data cell, and
 * {@link ColumnDefinition.movable} is enforced PER COLUMN — a header grows a
 * drag affordance only for a column that permits one, with an omitted list
 * keeping the table-level behaviour every existing v2 consumer has.
 *
 * Two are declared and intentionally unread:
 *
 * - {@link ColumnDefinition.pinnable}. `GridTableV2` pins the fixed leading
 *   identity column and nothing else, so a data column has no pin to switch on.
 * - {@link ColumnDefinition.priority}. ISS-9451 Option A keeps every selected
 *   column in wide mode; `GridTableV2`'s narrow list projects the identity
 *   column independently of priority. Priority changes neither the stored
 *   visibility nor order, so neither this module nor the layout consumes it.
 */

import {
  clampColumnWidth,
  MIN_COLUMN_WIDTH_PX,
} from "@closedloop-ai/design-system/lib/column-order";
import type { GridTableV2Column } from "@closedloop-ai/design-system/lib/grid-table-v2-types";

/**
 * The shape of the value a column holds. This is the renderer selector — a host
 * switches on it in `renderCell` to reach the matching `Table*Cell` primitive —
 * and it is what {@link COLUMN_KIND_POLICY} keys the capability rules off.
 */
export const ColumnFieldKind = {
  /** Free-form text: a name, a description, an id. */
  Text: "text",
  /** A quantity. Right-aligned by default so digits line up across rows. */
  Number: "number",
  /** A point in time. */
  Date: "date",
  /** One value from a closed set: a status, a priority. */
  Choice: "choice",
  /** Zero or more values from a closed set: tags, labels. */
  ChoiceList: "choice-list",
  /** A single human: an owner, an author. */
  Person: "person",
  /** Zero or more humans: collaborators, reviewers. */
  PersonList: "person-list",
  /** A pointer at another record: a repository, a pull request, a branch. */
  Reference: "reference",
  /**
   * A column the host renders itself. The registry cannot police what it
   * contains, so every capability is permitted — an escape hatch, not a
   * default.
   */
  Custom: "custom",
} as const;
export type ColumnFieldKind =
  (typeof ColumnFieldKind)[keyof typeof ColumnFieldKind];

/** Which end of its cell a column's content sits at. */
export const ColumnAlignment = {
  Start: "start",
  Center: "center",
  End: "end",
} as const;
export type ColumnAlignment =
  (typeof ColumnAlignment)[keyof typeof ColumnAlignment];

/**
 * Relative importance metadata reserved for a separately approved contract.
 * Current responsive layout intentionally does not read this value: every
 * selected column remains present and in saved order in both cards and grids.
 */
export const ColumnPriority = {
  Essential: "essential",
  High: "high",
  Medium: "medium",
  Low: "low",
} as const;
export type ColumnPriority =
  (typeof ColumnPriority)[keyof typeof ColumnPriority];

/** Width bounds for a column, in CSS pixels. Every field is optional. */
export type ColumnWidthBounds = {
  /** Floor. May not sit below the shared {@link MIN_COLUMN_WIDTH_PX}. */
  min?: number;
  /** Natural width before any persisted override. */
  default?: number;
  /** Ceiling. May not sit below `min`. */
  max?: number;
};

/**
 * One column's full declaration. `id` and `kind` are the only required fields
 * beyond an accessible name, so a plain text column is a three-key literal.
 */
export type ColumnDefinition = {
  /**
   * Stable, unique identity. Persisted view state, `columnOrder`, the hidden set
   * and `renderCell` all key off it, so it outlives the column's label and must
   * never be reused for a different field.
   *
   * Compared verbatim, never trimmed — so an id with surrounding whitespace is
   * REFUSED rather than accepted as its own column: `" name"` would read as a
   * second `"name"` in source while missing every lookup and every persisted
   * `columnOrder` entry keyed on `"name"`. The blank check trims only to ask a
   * different question — whether there is any id at all.
   */
  id: string;
  /** Visible header text. May be empty only when {@link ariaLabel} is set. */
  label: string;
  kind: ColumnFieldKind;
  /**
   * Accessible name for a column whose visible label is intentionally empty (a
   * row-actions or icon column). Required in that case: a `columnheader` with no
   * name announces every cell beneath it under a blank column.
   */
  ariaLabel?: string;
  /** Header help text, surfaced through the header's info affordance. */
  tooltip?: string;
  /** Content alignment. Defaults to the kind's alignment when omitted. */
  align?: ColumnAlignment;
  width?: ColumnWidthBounds;
  /** Metadata-only relative importance; current layout never reads it. */
  priority?: ColumnPriority;
  /** Offers sorting in the header. */
  sortable?: boolean;
  /** Offers Filter in the header menu. */
  filterable?: boolean;
  /** Offers Group in the header menu. Refused for kinds with no natural bands. */
  groupable?: boolean;
  /**
   * May be hidden by the user. Defaults to true. Read it through
   * {@link resolveColumnCapabilities}, never off the raw field — an omitted
   * declaration is `undefined`, which is falsy and therefore the inverse of
   * this default.
   */
  hideable?: boolean;
  /** May be reordered by the user. Defaults to true; see {@link hideable}. */
  movable?: boolean;
  /** May be resized by the user. Defaults to true; see {@link hideable}. */
  resizable?: boolean;
  /**
   * May be pinned against the horizontal scroll. Defaults to false; see
   * {@link hideable}.
   */
  pinnable?: boolean;
  /** Starts hidden. Requires {@link hideable}, or the column is unreachable. */
  defaultHidden?: boolean;
  /**
   * Extra classes forwarded to the rendered HEADER cell. `GridTableV2` applies
   * a column's `className` to its header and not to its data cells, so this is
   * not a way to style a column's whole track.
   */
  className?: string;
};

/** The rules a {@link ColumnFieldKind} imposes on a column that declares it. */
export type ColumnKindPolicy = {
  /**
   * Whether a column of this kind may declare `groupable`. Continuous and
   * free-form values are refused: grouping them yields one band per row, which
   * is a broken table rather than a grouped one.
   */
  groupable: boolean;
  /** Alignment a column of this kind takes when it declares none. */
  defaultAlign: ColumnAlignment;
};

/**
 * Per-kind rules, as an EXHAUSTIVE record: a kind added to
 * {@link ColumnFieldKind} without a policy entry fails `tsc` here rather than
 * silently falling through a lookup to a permissive default.
 */
export const COLUMN_KIND_POLICY: Record<ColumnFieldKind, ColumnKindPolicy> = {
  [ColumnFieldKind.Text]: {
    groupable: false,
    defaultAlign: ColumnAlignment.Start,
  },
  [ColumnFieldKind.Number]: {
    groupable: false,
    defaultAlign: ColumnAlignment.End,
  },
  [ColumnFieldKind.Date]: {
    groupable: false,
    defaultAlign: ColumnAlignment.Start,
  },
  [ColumnFieldKind.Choice]: {
    groupable: true,
    defaultAlign: ColumnAlignment.Start,
  },
  [ColumnFieldKind.ChoiceList]: {
    groupable: true,
    defaultAlign: ColumnAlignment.Start,
  },
  [ColumnFieldKind.Person]: {
    groupable: true,
    defaultAlign: ColumnAlignment.Start,
  },
  [ColumnFieldKind.PersonList]: {
    groupable: true,
    defaultAlign: ColumnAlignment.Start,
  },
  [ColumnFieldKind.Reference]: {
    groupable: true,
    defaultAlign: ColumnAlignment.Start,
  },
  [ColumnFieldKind.Custom]: {
    groupable: true,
    defaultAlign: ColumnAlignment.Start,
  },
};

/** Why a column declaration was refused. */
export const ColumnRegistryIssueCode = {
  /** Two columns declared the same `id`. */
  DuplicateId: "duplicate-id",
  /** `id` was empty or whitespace, so nothing can key off it. */
  BlankId: "blank-id",
  /** Neither a visible `label` nor an `ariaLabel`, so the header is unnamed. */
  MissingAccessibleName: "missing-accessible-name",
  /** A width bound was non-finite, below the shared floor, or inverted. */
  InvalidWidthBounds: "invalid-width-bounds",
  /** A capability the column's `kind` does not permit. */
  UnsupportedCapability: "unsupported-capability",
  /** Starts hidden but can never be shown again. */
  UnreachableColumn: "unreachable-column",
} as const;
export type ColumnRegistryIssueCode =
  (typeof ColumnRegistryIssueCode)[keyof typeof ColumnRegistryIssueCode];

/** One refused declaration, carrying the column it came from and why. */
export type ColumnRegistryIssue = {
  code: ColumnRegistryIssueCode;
  /** The offending column's `id`, or its index when the id itself is blank. */
  columnId: string;
  message: string;
};

/**
 * A validated column set, keyed for lookup and adaptable to the render prop.
 *
 * The declarations it hands out are frozen copies, not aliases of the array the
 * caller passed in, so nothing a caller does after construction can desync the
 * `byId` key from what {@link ColumnRegistry.toGridColumns} renders.
 */
export type ColumnRegistry = {
  /** The declarations, in declaration order. Frozen. */
  definitions: readonly Readonly<ColumnDefinition>[];
  /**
   * One declaration by id, or `undefined` for an id this registry never had.
   * Frozen: writing to it throws rather than silently forking the registry.
   */
  get(id: string): Readonly<ColumnDefinition> | undefined;
  /**
   * The subset `GridTableV2` renders against. Ordering and visibility stay with
   * the caller — `orderColumns` from `lib/column-order` takes this array or the
   * declarations directly, since both carry an `id`.
   */
  toGridColumns(): GridTableV2Column[];
};

/**
 * Check a column declaration set and return every problem found — all of them,
 * not the first, so one pass names the whole fix. An empty array means the set
 * is valid.
 */
export function validateColumnDefinitions(
  definitions: readonly ColumnDefinition[]
): ColumnRegistryIssue[] {
  const issues: ColumnRegistryIssue[] = [];
  const seen = new Set<string>();
  definitions.forEach((definition, index) => {
    const columnId = displayColumnId(definition, index);
    if (seen.has(definition.id)) {
      issues.push({
        code: ColumnRegistryIssueCode.DuplicateId,
        columnId,
        message: `column id "${definition.id}" is declared more than once`,
      });
    }
    seen.add(definition.id);
    collectDefinitionIssues(definition, columnId, issues);
  });
  return issues;
}

/** The alignment a column renders at: its own declaration, else its kind's. */
export function resolveColumnAlignment(
  definition: ColumnDefinition
): ColumnAlignment {
  return definition.align ?? COLUMN_KIND_POLICY[definition.kind].defaultAlign;
}

/**
 * The width a column starts at, clamped to the shared floor. Falls back to
 * {@link MIN_COLUMN_WIDTH_PX} when the column declares no default, which is the
 * same fallback `GridTableV2` already applies to a column with no persisted
 * width.
 */
export function resolveColumnDefaultWidth(definition: ColumnDefinition): number {
  const declared = definition.width?.default ?? definition.width?.min;
  if (declared === undefined) {
    return MIN_COLUMN_WIDTH_PX;
  }
  return clampColumnWidthToBounds(definition, declared);
}

/**
 * Hold a width inside the bounds the COLUMN declares, not merely the shared
 * floor.
 *
 * `clampColumnWidth` answers to {@link MIN_COLUMN_WIDTH_PX} alone, because it
 * serves callers that have no declaration to consult. A registry column does,
 * and a persisted override restored from an older view state — or one written
 * before the column narrowed its bounds — otherwise paints a track its own
 * declaration forbids.
 */
export function clampColumnWidthToBounds(
  definition: ColumnDefinition,
  width: number
): number {
  const bounds = definition.width;
  let resolved = clampColumnWidth(width);
  if (bounds?.max !== undefined) {
    resolved = Math.min(resolved, clampColumnWidth(bounds.max));
  }
  // The declared floor is applied last so an inverted `max < min` set — which
  // the validator refuses, but which this resolver can still be handed — yields
  // a column at least as wide as its own minimum rather than narrower than it.
  if (bounds?.min !== undefined) {
    resolved = Math.max(resolved, clampColumnWidth(bounds.min));
  }
  return resolved;
}

/**
 * The four user-capability flags a column can declare, every one resolved to a
 * concrete boolean. Adding a capability here fails `tsc` at
 * {@link COLUMN_CAPABILITY_DEFAULTS} and at the object literal
 * {@link resolveColumnCapabilities} returns, so a new flag cannot be declared
 * without also being given a default and resolved.
 */
export type ResolvedColumnCapabilities = {
  hideable: boolean;
  movable: boolean;
  resizable: boolean;
  pinnable: boolean;
};

/** What each capability means when a column declares nothing. */
const COLUMN_CAPABILITY_DEFAULTS: Readonly<ResolvedColumnCapabilities> = {
  hideable: true,
  movable: true,
  resizable: true,
  pinnable: false,
};

/**
 * Resolve a column's capability flags against their documented defaults.
 *
 * Three of the four default to TRUE while an omitted declaration is
 * `undefined`, so reading the raw field gives every non-opting column the
 * inverse of its documented default. Every consumer — this module's own
 * unreachable-column rule included — comes through here rather than spelling
 * `?? true` at each call site.
 */
export function resolveColumnCapabilities(
  definition: ColumnDefinition
): ResolvedColumnCapabilities {
  return {
    hideable: definition.hideable ?? COLUMN_CAPABILITY_DEFAULTS.hideable,
    movable: definition.movable ?? COLUMN_CAPABILITY_DEFAULTS.movable,
    resizable: definition.resizable ?? COLUMN_CAPABILITY_DEFAULTS.resizable,
    pinnable: definition.pinnable ?? COLUMN_CAPABILITY_DEFAULTS.pinnable,
  };
}

/**
 * Build a registry from a column declaration set, THROWING when any declaration
 * is refused.
 *
 * Throwing is right here and a fail-soft degrade would not be: a registry is
 * authored in source at module scope, not parsed from a persisted blob or a
 * wire payload, so a duplicate id or an unsupported capability is a programming
 * error that every render of every row would carry. It surfaces at import, in
 * the author's own test run, rather than as a silently dropped column in
 * production. Untrusted persisted state that REFERENCES these ids stays
 * fail-soft in its own codec — an id this registry never had is an unknown
 * column to ignore, not a throw.
 */
export function createColumnRegistry(
  definitions: readonly ColumnDefinition[]
): ColumnRegistry {
  const issues = validateColumnDefinitions(definitions);
  if (issues.length > 0) {
    const detail = issues
      .map((issue) => `${issue.columnId}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid column registry — ${detail}`);
  }
  const declared = definitions.map(freezeDefinition);
  const byId = new Map(
    declared.map((definition) => [definition.id, definition])
  );
  return {
    definitions: declared,
    get: (id: string) => byId.get(id),
    toGridColumns: () => declared.map(toGridColumn),
  };
}

/**
 * Adapt ONE declaration down to the render prop.
 *
 * Exported so `lib/column-layout`, which emits an ordered and filtered subset,
 * shares this mapping rather than keeping a second one that would drift the
 * moment a field is added here.
 *
 * `align` is RESOLVED, not passed through: the renderer needs a concrete end to
 * put the content at, and only this module knows a column's kind default.
 */
export function toGridColumn(
  definition: ColumnDefinition
): GridTableV2Column {
  return {
    id: definition.id,
    label: definition.label,
    className: definition.className,
    sortable: definition.sortable,
    filterable: definition.filterable,
    groupable: definition.groupable,
    tooltip: definition.tooltip,
    ariaLabel: definition.ariaLabel,
    align: resolveColumnAlignment(definition),
  };
}

/**
 * Copy a declaration and freeze the copy, bounds object included.
 *
 * A shallow array copy alone would leave the registry holding the caller's own
 * objects: mutating one after construction would change `toGridColumns()` while
 * `byId` — keyed at construction — kept answering to the old id, so the same
 * registry would disagree with itself about which columns exist. Copying rather
 * than freezing the argument in place keeps that guarantee off the caller's
 * literal, which is theirs.
 */
function freezeDefinition(
  definition: ColumnDefinition
): Readonly<ColumnDefinition> {
  const copy = { ...definition };
  if (copy.width) {
    copy.width = Object.freeze({ ...copy.width });
  }
  return Object.freeze(copy);
}

function displayColumnId(
  definition: ColumnDefinition,
  index: number
): string {
  return definition.id.trim() === "" ? `#${index}` : definition.id;
}

function isPositiveWidth(value: number | undefined): boolean {
  return value === undefined || (Number.isFinite(value) && value > 0);
}

function collectWidthIssues(
  definition: ColumnDefinition,
  columnId: string,
  issues: ColumnRegistryIssue[]
): void {
  const { width } = definition;
  if (!width) {
    return;
  }
  const push = (message: string) => {
    issues.push({
      code: ColumnRegistryIssueCode.InvalidWidthBounds,
      columnId,
      message,
    });
  };
  if (
    !(
      isPositiveWidth(width.min) &&
      isPositiveWidth(width.default) &&
      isPositiveWidth(width.max)
    )
  ) {
    push("width bounds must be finite and positive");
    return;
  }
  // Every declared bound, not just `min`: the resize handles clamp any width to
  // the shared floor, so a bound below it is a number the grid would silently
  // overrule — a declaration that does not describe what renders.
  for (const [name, value] of [
    ["min", width.min],
    ["default", width.default],
    ["max", width.max],
  ] as const) {
    if (value === undefined) {
      continue;
    }
    if (value < MIN_COLUMN_WIDTH_PX) {
      push(`width.${name} ${value} is below the ${MIN_COLUMN_WIDTH_PX}px floor`);
    }
    // A fractional bound is the same defect one decimal place down: the resize
    // path rounds to whole pixels, so 120.7 is a number nothing ever renders.
    // A magnitude past the safe-integer range is the defect one order of
    // magnitude up — `MAX_SAFE_INTEGER + 1` is finite AND an integer, so
    // neither the finiteness gate nor `Number.isInteger` refuses it, and it
    // arrives as a width no layout can honor and no arithmetic can round-trip.
    if (!Number.isSafeInteger(value)) {
      push(
        Number.isInteger(value)
          ? `width.${name} ${value} exceeds the safe integer range`
          : `width.${name} ${value} must be a whole number of pixels`
      );
    }
  }
  if (
    width.min !== undefined &&
    width.max !== undefined &&
    width.max < width.min
  ) {
    push(`width.max ${width.max} is below width.min ${width.min}`);
  }
  if (width.default !== undefined) {
    const belowMin = width.min !== undefined && width.default < width.min;
    const aboveMax = width.max !== undefined && width.default > width.max;
    if (belowMin || aboveMax) {
      push(`width.default ${width.default} sits outside its own bounds`);
    }
  }
}

function collectDefinitionIssues(
  definition: ColumnDefinition,
  columnId: string,
  issues: ColumnRegistryIssue[]
): void {
  if (definition.id.trim() === "") {
    issues.push({
      code: ColumnRegistryIssueCode.BlankId,
      columnId,
      message: "a column id must be a non-empty string",
    });
  } else if (definition.id !== definition.id.trim()) {
    // Surrounding whitespace makes the two halves of the id rule disagree: the
    // blank check trims and the duplicate check does not, so `" name"` reads as
    // a second column in source and misses every lookup keyed on `"name"`.
    issues.push({
      code: ColumnRegistryIssueCode.BlankId,
      columnId,
      message: `column id "${definition.id}" must not have surrounding whitespace`,
    });
  }
  const hasAriaLabel = (definition.ariaLabel ?? "").trim() !== "";
  if (definition.label.trim() === "" && !hasAriaLabel) {
    issues.push({
      code: ColumnRegistryIssueCode.MissingAccessibleName,
      columnId,
      message:
        "a column with a blank label must declare ariaLabel, or its header announces no name",
    });
  }
  if (definition.groupable && !COLUMN_KIND_POLICY[definition.kind].groupable) {
    issues.push({
      code: ColumnRegistryIssueCode.UnsupportedCapability,
      columnId,
      message: `kind "${definition.kind}" cannot declare groupable — grouping it yields one band per row`,
    });
  }
  if (definition.defaultHidden && !resolveColumnCapabilities(definition).hideable) {
    issues.push({
      code: ColumnRegistryIssueCode.UnreachableColumn,
      columnId,
      message:
        "defaultHidden with hideable:false leaves the column permanently unreachable",
    });
  }
  collectWidthIssues(definition, columnId, issues);
}
