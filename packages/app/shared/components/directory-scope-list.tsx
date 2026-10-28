"use client";

/**
 * @file ISS-12520: the directory scope list — which directories on this
 * machine are in scope for session collection — shared by first-time setup
 * (PRD-805 flow 1) and the Settings policy view (PRD-796 flow 2).
 *
 * It composes the design-system `CheckboxTree` (ISS-12517) and adds only the
 * data-control meaning: which rows are newly discovered, which are
 * unavailable, which folders macOS protection excluded automatically, and what
 * to say when there is nothing to list or nothing chosen.
 *
 * Selection follows the CheckboxTree contract unchanged (ISS-12517 thread
 * th_1Hq1TuI8wIaRb-w3-wsms): an included id covers its whole subtree,
 * directories added later included; ticking every child one by one does NOT
 * include the parent; ids the list cannot see are carried through. This
 * component hands `includedIds` to the tree and `onIncludedIdsChange` the set
 * the tree emits, without expanding, collapsing or filtering it, so a host can
 * persist it as given.
 *
 * Unavailable is a visual state, never a lock: an offline directory can be
 * included and excluded like any other. Keeping an inclusion through an outage
 * is fine; blocking its revocation is not (ISS-12520 review, superseding the
 * earlier "unavailable rows keep their state" decision). Only the automatic
 * exclusions below are read-only.
 *
 * The automatic exclusions are RENDER-ONLY. The emitted set is not filtered
 * against them: including an ancestor such as `~` emits just `~`, which on its
 * face covers `~/Documents`. The host or collector must still enforce
 * `TCC_PROTECTED_HOME_SUBDIRS` (apps/desktop/src/shared/sandbox-policy.ts)
 * itself; this list never does.
 *
 * Every string is a REQUIRED `copy` prop. None of this wording has a product
 * ruling yet (PRD-796), so the shared package ships no copy of its own; the
 * proposed wording lives on the ISS-12520 ticket thread
 * th_QgcklVVEYQVpH7ujiWRMF, and the stories render placeholders.
 */

import { Badge } from "@repo/design-system/components/ui/badge";
import {
  CheckboxTree,
  type CheckboxTreeNode,
} from "@repo/design-system/components/ui/checkbox-tree";
import {
  Empty,
  EmptyDescription,
} from "@repo/design-system/components/ui/empty";
import { cn } from "@repo/design-system/lib/utils";
import { useId, useMemo } from "react";

/** One directory the host discovered or the user added. */
export type DirectoryScopeEntry = {
  /**
   * Stable and unique across the whole list (the absolute path is the natural
   * choice). It is what `includedIds` records.
   */
  id: string;
  /**
   * What the row shows. The list does not shorten paths: pass a home-relative
   * path for a top-level row and the folder name for a nested one. A label too
   * long for the row end-truncates.
   */
  label: string;
  /** Found since the user last reviewed the list. Says nothing about scope. */
  newlyDiscovered?: boolean;
  /**
   * Missing, unmounted or unreadable right now. A visual state only: the row
   * shows a badge and the reason but stays fully toggleable, so the user can
   * revoke an offline directory. Left alone, an included directory stays
   * included for when it returns.
   */
  unavailable?: boolean;
  children?: readonly DirectoryScopeEntry[];
};

/**
 * A folder kept out of collection automatically (ISS-11914: macOS
 * TCC-protected folders such as Desktop, Documents and Downloads). Shown so the
 * user can see it is excluded; never toggleable.
 */
export type AutoExcludedDirectory = { id: string; label: string };

/** The words the list needs. No approved source supplies any of them yet. */
export type DirectoryScopeListCopy = {
  /** Accessible name of the directory tree. */
  treeLabel: string;
  /** Badge on a newly discovered row; also read as part of the row's name. */
  newlyDiscovered: string;
  /** Badge on an unavailable row; also read as part of the row's name. */
  unavailable: string;
  /**
   * Why a row is unavailable. Shown under the label and read as part of the
   * row's name, so the state is never carried by colour alone.
   */
  unavailableReason: string;
  /** Shown instead of the tree when there are no directories at all. */
  empty: string;
  /** Shown above the tree when no directory is included. */
  noSelection: string;
  /** Heading of the automatic-exclusion group; also names that tree. */
  autoExcludedHeading: string;
  /** Why an automatically excluded folder cannot be changed. */
  autoExcludedReason: string;
};

export type DirectoryScopeListProps = {
  entries: readonly DirectoryScopeEntry[];
  /** Controlled: the included set, stored exactly as the tree emitted it. */
  includedIds: readonly string[];
  /**
   * Receives the included set after a toggle, exactly as the tree emitted it.
   * It is NOT filtered against `autoExcluded`: including an ancestor such as
   * `~` emits just `~`. The host or collector must still enforce
   * `TCC_PROTECTED_HOME_SUBDIRS` (apps/desktop/src/shared/sandbox-policy.ts)
   * itself.
   */
  onIncludedIdsChange?: (includedIds: string[]) => void;
  /**
   * Rendered as their own read-only group, never inside `entries`: an
   * included parent would otherwise draw a protected child as included by
   * inheritance, and these folders are excluded whatever the selection says.
   */
  autoExcluded?: readonly AutoExcludedDirectory[];
  copy: DirectoryScopeListCopy;
  expandedIds?: readonly string[];
  defaultExpandedIds?: readonly string[];
  onExpandedChange?: (expandedIds: string[]) => void;
  /**
   * ISS-12531: when set, the whole list is read-only. Every top-level row is
   * locked with this reason, the lock covers its subtree, and no toggle is
   * emitted, so `onIncludedIdsChange` is never called. For a scope that is set
   * somewhere else and only reported here, such as a desktop's scope shown on
   * web. Supplied by the host: the list owns no copy. Expanding and collapsing
   * still work. An empty or whitespace-only string counts as unset: it would
   * lock the list behind a blank reason row, which no reader can act on.
   */
  readOnlyReason?: string;
  className?: string;
};

/** Maps the host's entries onto the tree primitive's nodes. */
function toDirectoryScopeNodes(
  entries: readonly DirectoryScopeEntry[],
  copy: Pick<
    DirectoryScopeListCopy,
    "newlyDiscovered" | "unavailable" | "unavailableReason"
  >,
  readOnlyReason?: string
): CheckboxTreeNode[] {
  return entries.map((entry) => {
    // Only the top level gets `readOnlyReason`: the tree carries a lock down
    // to every descendant, and repeating the reason under each child would
    // print the same line once per row.
    const children = entry.children
      ? toDirectoryScopeNodes(entry.children, copy)
      : undefined;
    const label = (
      <DirectoryScopeLabel
        key={entry.id}
        label={entry.label}
        newlyDiscovered={entry.newlyDiscovered ? copy.newlyDiscovered : null}
        unavailable={
          entry.unavailable
            ? { badge: copy.unavailable, reason: copy.unavailableReason }
            : null
        }
      />
    );
    // An unavailable row is never `disabled` or `readOnly`: a locked row keeps
    // its state, and an included parent would then write an offline child back
    // on uncheck, so no click sequence could exclude it. Its badge and reason
    // live in the label instead. A read-only list (ISS-12531) is the exception
    // that does not break this: nothing in it can be excluded anyway.
    if (readOnlyReason !== undefined) {
      return {
        children,
        id: entry.id,
        label,
        readOnly: true,
        reason: readOnlyReason,
      };
    }
    return { children, id: entry.id, label };
  });
}

function toAutoExcludedNodes(
  folders: readonly AutoExcludedDirectory[],
  reason: string
): CheckboxTreeNode[] {
  return folders.map((folder) => ({
    id: folder.id,
    label: (
      <DirectoryScopeLabel
        key={folder.id}
        label={folder.label}
        newlyDiscovered={null}
        unavailable={null}
      />
    ),
    readOnly: true,
    reason,
  }));
}

/**
 * The row label. The badges sit inside the labelled element, so a screen
 * reader hears the state in words rather than a colour-only cue. The space
 * before each is dropped by the flex layout but keeps the accessible name
 * "orbit-docs New" rather than "orbit-docsNew".
 *
 * The tree only takes a `reason` for a locked row, and an unavailable row is
 * not locked, so its reason is drawn here, on its own line under the name,
 * and is read as part of the row's name.
 */
function DirectoryScopeLabel({
  label,
  newlyDiscovered,
  unavailable,
}: {
  label: string;
  newlyDiscovered: string | null;
  unavailable: { badge: string; reason: string } | null;
}) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate">{label}</span>
        {newlyDiscovered === null ? null : (
          <>
            {" "}
            <Badge data-slot="directory-scope-new" variant="info">
              {newlyDiscovered}
            </Badge>
          </>
        )}
        {unavailable === null ? null : (
          <>
            {" "}
            <Badge data-slot="directory-scope-unavailable" variant="warning">
              {unavailable.badge}
            </Badge>
          </>
        )}
      </span>
      {unavailable === null ? null : (
        <>
          {" "}
          <span
            className="whitespace-normal text-muted-foreground text-xs"
            data-slot="directory-scope-unavailable-reason"
          >
            {unavailable.reason}
          </span>
        </>
      )}
    </span>
  );
}

export function DirectoryScopeList({
  entries,
  includedIds,
  onIncludedIdsChange,
  autoExcluded = NO_FOLDERS,
  copy,
  expandedIds,
  defaultExpandedIds,
  onExpandedChange,
  readOnlyReason,
  className,
}: DirectoryScopeListProps) {
  const autoExcludedHeadingId = useId();
  // A blank reason is treated as no reason (see the prop doc).
  const lockReason = readOnlyReason?.trim() ? readOnlyReason : undefined;
  const {
    newlyDiscovered,
    unavailable,
    unavailableReason,
    autoExcludedReason,
  } = copy;
  // Stable nodes keep the tree's normalize/derive memos from re-running on
  // every parent render.
  const nodes = useMemo(
    () =>
      toDirectoryScopeNodes(
        entries,
        {
          newlyDiscovered,
          unavailable,
          unavailableReason,
        },
        lockReason
      ),
    [entries, newlyDiscovered, unavailable, unavailableReason, lockReason]
  );
  const autoExcludedNodes = useMemo(
    () => toAutoExcludedNodes(autoExcluded, autoExcludedReason),
    [autoExcluded, autoExcludedReason]
  );
  // A protected folder is excluded whatever the selection says, so an id
  // naming one does not count as something chosen. This only decides what to
  // draw: the emitted set is never filtered, so the collector must still
  // enforce the protected folders itself (see the file doc). Any other id does, even
  // one the list cannot show (an offline or not-yet-loaded directory).
  const hasSelection = includedIds.some(
    (id) => !autoExcluded.some((folder) => folder.id === id)
  );
  return (
    <div
      className={cn("flex flex-col gap-3", className)}
      data-slot="directory-scope-list"
    >
      {entries.length === 0 ? (
        <Empty
          className="border px-3 py-4 md:px-3 md:py-4"
          data-slot="directory-scope-empty"
        >
          <EmptyDescription>{copy.empty}</EmptyDescription>
        </Empty>
      ) : (
        <>
          {/* The live region stays mounted and only its text changes: a
              status region that appears already filled is often not read. */}
          <p
            className="text-muted-foreground text-sm empty:hidden"
            data-slot="directory-scope-no-selection"
            role="status"
          >
            {hasSelection ? null : copy.noSelection}
          </p>
          <CheckboxTree
            aria-label={copy.treeLabel}
            checkedIds={includedIds}
            defaultExpandedIds={defaultExpandedIds}
            expandedIds={expandedIds}
            nodes={nodes}
            onCheckedChange={
              lockReason === undefined ? onIncludedIdsChange : undefined
            }
            onExpandedChange={onExpandedChange}
          />
        </>
      )}
      {autoExcluded.length > 0 ? (
        <section
          className="flex flex-col gap-1 border-t pt-3"
          data-slot="directory-scope-auto-excluded"
        >
          {/* Not a heading element: the host owns the page outline, and a
              fixed level here would break it in one of the two hosts. */}
          <p
            className="font-medium text-muted-foreground text-xs"
            id={autoExcludedHeadingId}
          >
            {copy.autoExcludedHeading}
          </p>
          <CheckboxTree
            aria-labelledby={autoExcludedHeadingId}
            checkedIds={NOTHING_INCLUDED}
            nodes={autoExcludedNodes}
          />
        </section>
      ) : null}
    </div>
  );
}

const NOTHING_INCLUDED: readonly string[] = [];
const NO_FOLDERS: readonly AutoExcludedDirectory[] = [];
