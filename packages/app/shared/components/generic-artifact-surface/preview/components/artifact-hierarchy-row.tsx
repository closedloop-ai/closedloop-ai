"use client";

import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { GenericArtifact } from "../fixtures";

/**
 * Indentation by design-system spacing steps, one per hierarchy level. A depth
 * beyond the spec's four levels cannot render, so the last step is the floor.
 */
const HIERARCHY_INDENT_CLASSES = ["", "ps-6", "ps-12", "ps-18"] as const;

function indentClassForDepth(depth: number): string {
  return (
    HIERARCHY_INDENT_CLASSES[
      Math.min(Math.max(depth, 0), HIERARCHY_INDENT_CLASSES.length - 1)
    ] ?? ""
  );
}

/**
 * Wraps a list row's lead cell with its hierarchy affordances.
 *
 * Depth is stated in the accessibility tree as text, never by indentation
 * alone (WCAG 1.4.1 in its structural form): a screen reader user gets the
 * level, a sighted user gets the indent, and each fact is stated exactly once.
 */
export function ArtifactHierarchyLead({
  artifact,
  children,
  depth,
  expanded,
  hasChildren,
  onToggleExpanded,
  reorderControl,
}: {
  artifact: GenericArtifact;
  children: ReactNode;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  onToggleExpanded: (artifactId: string) => void;
  reorderControl?: ReactNode;
}) {
  const ExpandIcon = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="flex min-w-0 items-center">
      {reorderControl}
      <div
        className={`flex min-w-0 flex-1 items-center ${indentClassForDepth(depth)}`}
      >
        {depth > 0 ? (
          <span className="sr-only">{`Level ${depth + 1}`}</span>
        ) : null}
        {hasChildren ? (
          <button
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${artifact.slug}`}
            className="mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-preserve-artifact-selection=""
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpanded(artifact.id);
            }}
            type="button"
          >
            <ExpandIcon className="size-4" />
          </button>
        ) : (
          <span aria-hidden className="mr-1 size-5 shrink-0" />
        )}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
