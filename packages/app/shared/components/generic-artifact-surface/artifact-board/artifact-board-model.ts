import {
  type GridSelectionModifiers,
  resolveGridRowSelection,
} from "@repo/design-system/lib/grid-table-v2-selection";
import type { ReactNode } from "react";

/** The fields the shared Artifact Board can show or omit when grouping. */
export type ArtifactBoardFieldDefinition = {
  id: string;
  label: string;
  tier: "primary" | "secondary";
};

/** Serializable fallback values used when a host does not inject a renderer. */
export type ArtifactBoardFieldValue =
  | boolean
  | number
  | string
  | readonly string[]
  | null;

/**
 * Fixture-free row model for the shared board.
 *
 * `rootId` is explicit so a filtered or truncated read never promotes a child
 * merely because its parent is absent from the current payload.
 */
export type ArtifactBoardItem = {
  id: string;
  rootId: string;
  parentId: string | null;
  laneId: string;
  slug: string;
  title: string;
  typeLabel: string;
  fieldValues: Readonly<Record<string, ArtifactBoardFieldValue>>;
};

/** One field-group lane. `rootIds` is the committed display order. */
export type ArtifactBoardLane = {
  collapsed?: boolean;
  count?: number;
  id: string;
  label: string;
  rootIds: readonly string[];
  header?: ReactNode;
};

export const ArtifactBoardDropPosition = {
  After: "after",
  Before: "before",
  End: "end",
} as const;
export type ArtifactBoardDropPosition =
  (typeof ArtifactBoardDropPosition)[keyof typeof ArtifactBoardDropPosition];

/** Canonical target shared by pointer, keyboard and menu move paths. */
export type ArtifactBoardMoveTarget = {
  laneId: string;
  position: ArtifactBoardDropPosition;
  referenceRootId?: string;
};

/** One board gesture, normalized to logical roots in visible order. */
export type ArtifactBoardMove = {
  rootIds: readonly string[];
  sourceLaneId: string;
  target: ArtifactBoardMoveTarget;
};

export const ArtifactBoardSelectionIntent = {
  Range: "range",
  Replace: "replace",
  Toggle: "toggle",
} as const;
export type ArtifactBoardSelectionIntent =
  (typeof ArtifactBoardSelectionIntent)[keyof typeof ArtifactBoardSelectionIntent];

export const ArtifactBoardMutationState = {
  Error: "error",
  Idle: "idle",
  Pending: "pending",
} as const;
export type ArtifactBoardMutationState =
  (typeof ArtifactBoardMutationState)[keyof typeof ArtifactBoardMutationState];

export type ArtifactBoardRenderers = {
  renderActions?: (
    item: ArtifactBoardItem,
    move: (target: ArtifactBoardMoveTarget) => void
  ) => ReactNode;
  renderField?: (
    item: ArtifactBoardItem,
    field: ArtifactBoardFieldDefinition
  ) => ReactNode;
  renderTitle?: (item: ArtifactBoardItem, open: () => void) => ReactNode;
  renderTypeIcon?: (item: ArtifactBoardItem) => ReactNode;
};

/** Return only logical roots, preserving the canonical `items` order. */
export function artifactBoardRoots(
  items: readonly ArtifactBoardItem[]
): ArtifactBoardItem[] {
  return items.filter((item) => item.rootId === item.id);
}

/**
 * Normalize a selected set to roots and preserve the board's visible order.
 * A selected ancestor and descendant therefore move as one subtree.
 */
export function normalizeArtifactBoardSelectedRoots(
  items: readonly ArtifactBoardItem[],
  selectedIds: ReadonlySet<string>
): string[] {
  const selectedRootIds = new Set<string>();
  for (const item of items) {
    if (selectedIds.has(item.id)) {
      selectedRootIds.add(item.rootId);
    }
  }
  return artifactBoardRoots(items)
    .filter((item) => selectedRootIds.has(item.id))
    .map((item) => item.id);
}

/** Omit both grouping attributes from every card. */
export function visibleArtifactBoardFields(
  fields: readonly ArtifactBoardFieldDefinition[],
  visibleFieldIds: ReadonlySet<string>,
  primaryGroupFieldId: string,
  secondaryGroupFieldId: string | null
): ArtifactBoardFieldDefinition[] {
  return fields.filter(
    (field) =>
      visibleFieldIds.has(field.id) &&
      field.id !== primaryGroupFieldId &&
      field.id !== secondaryGroupFieldId
  );
}

/** Resolve the roots moved when a drag starts from one visible card. */
export function artifactBoardMoveRootIds(
  items: readonly ArtifactBoardItem[],
  activeRootId: string,
  selectedIds: ReadonlySet<string>
): string[] {
  const normalized = normalizeArtifactBoardSelectedRoots(items, selectedIds);
  return normalized.includes(activeRootId) ? normalized : [activeRootId];
}

/**
 * Apply one selection intent in root order and maintain the range anchor.
 * Routes through the shared `resolveGridRowSelection` (PRD-718 AC4), so a
 * board range whose anchor is no longer painted falls back to a plain click
 * exactly as every grid does.
 */
export function artifactBoardSelectionFromIntent(
  current: readonly string[],
  rootIds: readonly string[],
  itemId: string,
  intent: ArtifactBoardSelectionIntent,
  anchorRef: { current: string | null }
): string[] {
  const next = resolveGridRowSelection(
    { anchorId: anchorRef.current, selectedIds: new Set(current) },
    itemId,
    SELECTION_MODIFIERS_BY_INTENT[intent],
    rootIds
  );
  anchorRef.current = next.anchorId;
  return [...next.selectedIds];
}

/** Default display used only when the host does not inject a canonical cell. */
export function artifactBoardFieldFallback(
  value: ArtifactBoardFieldValue
): ReactNode {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (value === null || value === false) {
    return null;
  }
  return String(value);
}

/** The surface's own name, from PRD-724 ("Artifact Board and Board Card"). */
export const ARTIFACT_BOARD_LABEL = "Artifact Board";

const SELECTION_MODIFIERS_BY_INTENT: Readonly<
  Record<ArtifactBoardSelectionIntent, GridSelectionModifiers>
> = {
  [ArtifactBoardSelectionIntent.Range]: {
    ctrlKey: false,
    metaKey: false,
    shiftKey: true,
  },
  [ArtifactBoardSelectionIntent.Replace]: {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  },
  [ArtifactBoardSelectionIntent.Toggle]: {
    ctrlKey: false,
    metaKey: true,
    shiftKey: false,
  },
};
