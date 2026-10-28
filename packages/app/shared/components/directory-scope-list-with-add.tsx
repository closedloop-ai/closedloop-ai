"use client";

/**
 * @file ISS-12521: the directory scope list plus a control that adds a
 * directory discovery did not find, through the host's folder picker.
 *
 * It composes `DirectoryScopeList` (ISS-12520) unchanged. The host owns the
 * picker and the filesystem checks; this module owns which of the four
 * outcomes a pick resolves to, how each one renders, and whether a
 * successful pick lands as a new row.
 *
 * Design review 2026-10-16 settled three points this file encodes:
 * - a successful pick arrives INCLUDED, not left unchecked — a user who
 *   drives the native picker is choosing the directory, unlike a row
 *   discovery surfaces on its own;
 * - "duplicate" means already SELECTED (covered by inclusion, directly or
 *   through an included ancestor), not merely listed — a listed-but-
 *   unselected row takes the same path as a fresh pick instead of refusing;
 * - every outcome, success included, renders in the same visible alert slot,
 *   so a long list does not leave a successful add silent.
 *
 * Every string is a REQUIRED prop on `AddDirectoryControlCopy`, kept apart
 * from `DirectoryScopeListCopy` on purpose: the two contracts get approved
 * wording on separate schedules. ISS-12521's wording was approved by Cosimo
 * Corrigan on 2026-10-16; `DirectoryScopeListCopy` (ISS-12520) still has none
 * and is outside that ticket's own placeholder ruling, so its fixtures still
 * fill every slot with a glyph, never words.
 */

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import {
  CheckCircle2Icon,
  CopyIcon,
  FolderPlusIcon,
  FolderXIcon,
  LockIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type DirectoryScopeEntry,
  DirectoryScopeList,
  type DirectoryScopeListProps,
} from "./directory-scope-list";

/** What the host's folder picker returned, after its own filesystem checks. */
export type PickedDirectory = {
  /** Canonical id, in the same form the host uses for `entries` ids. */
  id: string;
  label: string;
  /**
   * The directory cannot be opened, or its readability could not be
   * determined. On desktop this is `PathReadability.Blocked` or `Unknown`
   * from `apps/desktop/src/main/collectors/engine/file-access-probe.ts`.
   */
  unreadable: boolean;
  /**
   * A macOS TCC-protected folder (`isTccProtectedPath` in
   * `apps/desktop/src/shared/sandbox-policy.ts`), which belongs in the list's
   * read-only automatic-exclusion group, never in `entries`.
   */
  tccProtected: boolean;
};

export const AddDirectoryOutcome = {
  Added: "added",
  Duplicate: "duplicate",
  Unreadable: "unreadable",
  Protected: "protected",
} as const;
export type AddDirectoryOutcome =
  (typeof AddDirectoryOutcome)[keyof typeof AddDirectoryOutcome];

export const AddDirectoryStatus = {
  Idle: "idle",
  Picking: "picking",
  ...AddDirectoryOutcome,
} as const;
export type AddDirectoryStatus =
  (typeof AddDirectoryStatus)[keyof typeof AddDirectoryStatus];

/** The words the add control needs. Approved by Cosimo Corrigan, 2026-10-16. */
export type AddDirectoryControlCopy = {
  /** Visible label of the add button. */
  trigger: string;
  /** Shown in the outcome alert after a directory is added or included. */
  added: string;
  /** The picked directory is already selected, directly or by inheritance. */
  duplicate: string;
  /** The picked directory exists but cannot be read. */
  unreadable: string;
  /** The picked directory is a protected folder, excluded automatically. */
  protectedFolder: string;
};

/** Host-owned picker wiring. Omitted where there is no local filesystem. */
export type AddDirectoryAdapter = {
  /** Resolves `null` when the user cancels the picker. */
  pickDirectory: () => Promise<PickedDirectory | null>;
  /**
   * Receives a brand-new entry; the host decides where it goes in `entries`.
   * Not called when the picked path is already a row but unselected — the
   * control includes that row instead of adding a second one for it.
   */
  onAdd: (entry: DirectoryScopeEntry) => void;
  /** A rejected pick. The control returns to idle and draws nothing for it. */
  onPickError: (error: unknown) => void;
  copy: AddDirectoryControlCopy;
};

export type DirectoryScopeListWithAddProps = DirectoryScopeListProps & {
  /** ISS-12521 AC-003: leave unset on web, and the add control is absent. */
  add?: AddDirectoryAdapter;
};

export function DirectoryScopeListWithAdd({
  add,
  className,
  ...listProps
}: DirectoryScopeListWithAddProps) {
  return (
    <div
      className={cn("flex flex-col gap-3", className)}
      data-slot="directory-scope-list-with-add"
    >
      {add ? (
        <AddDirectoryControl
          adapter={add}
          entries={listProps.entries}
          includedIds={listProps.includedIds}
          onIncludedIdsChange={listProps.onIncludedIdsChange}
        />
      ) : null}
      <DirectoryScopeList {...listProps} />
    </div>
  );
}

/**
 * Protected wins over every other verdict, including coverage: a TCC folder
 * can never be a row or a member of `includedIds` (ISS-12520 keeps it in its
 * own read-only group, "whatever the selection says"), so a path-prefix
 * coverage match is never trustworthy for one — the ancestor that matched is
 * someone else's inclusion, not this folder's (design review 2026-10-16,
 * round 2, item 1: `~` included, then picking `~/Documents` must not read as
 * already selected).
 *
 * Duplicate ("already selected") comes next, and means covered by the current
 * selection — included directly, or nested under an included ancestor
 * (ISS-12520's inheritance contract) — not merely listed. A listed-but-
 * unselected row is not a duplicate: it resolves to Added, and
 * `AddDirectoryControl` includes it rather than re-adding it (round 1, item
 * 3). Unreadable comes last: a listed directory that has gone unreadable
 * already says so on its own row, so only a path with no row and no
 * coverage reaches this check.
 */
export function resolveAddDirectoryOutcome(
  picked: PickedDirectory,
  includedIds: readonly string[]
): AddDirectoryOutcome {
  if (picked.tccProtected) {
    return AddDirectoryOutcome.Protected;
  }
  if (isCoveredByInclusion(picked.id, includedIds)) {
    return AddDirectoryOutcome.Duplicate;
  }
  if (picked.unreadable) {
    return AddDirectoryOutcome.Unreadable;
  }
  return AddDirectoryOutcome.Added;
}

const OUTCOME_TREATMENT: Record<
  AddDirectoryOutcome,
  {
    icon: LucideIcon;
    variant: "default" | "warning" | "success";
    copyKey: keyof AddDirectoryControlCopy;
  }
> = {
  [AddDirectoryOutcome.Added]: {
    copyKey: "added",
    icon: CheckCircle2Icon,
    variant: "success",
  },
  [AddDirectoryOutcome.Duplicate]: {
    copyKey: "duplicate",
    icon: CopyIcon,
    variant: "default",
  },
  [AddDirectoryOutcome.Unreadable]: {
    copyKey: "unreadable",
    icon: FolderXIcon,
    variant: "warning",
  },
  // Same tone as Unreadable (design review 2026-10-16, item 7): a denied read
  // and an automatic exclusion are both refusals the user cannot override
  // from here, not merely informational, so they read as equally serious.
  // The icon, not the tone, tells them apart — the same lock the
  // automatic-exclusion group draws on its own rows.
  [AddDirectoryOutcome.Protected]: {
    copyKey: "protectedFolder",
    icon: LockIcon,
    variant: "warning",
  },
};

function AddDirectoryControl({
  adapter,
  entries,
  includedIds,
  onIncludedIdsChange,
}: {
  adapter: AddDirectoryAdapter;
  entries: readonly DirectoryScopeEntry[];
  includedIds: readonly string[];
  onIncludedIdsChange?: (includedIds: string[]) => void;
}) {
  const { pickDirectory, onAdd, onPickError, copy } = adapter;
  const [status, setStatus] = useState<AddDirectoryStatus>(
    AddDirectoryStatus.Idle
  );
  // Keys the outcome regions so a repeat of the same outcome remounts and is
  // announced again.
  const [attempt, setAttempt] = useState(0);
  // Discovery or another control can change `entries`/`includedIds` while the
  // native picker is open, so both checks read the current value when the
  // pick resolves, not a stale closure from when the picker opened.
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);
  const includedIdsRef = useRef(includedIds);
  useEffect(() => {
    includedIdsRef.current = includedIds;
  }, [includedIds]);
  // What `includedIds` was true when the current outcome was resolved (the
  // post-add set for Added, the as-is set otherwise). Added and Duplicate now
  // describe the SELECTION, not just the pick, so a later change to that
  // selection — someone unticking the row this alert is about, say — makes
  // the alert describe a state that no longer holds (design review round 2,
  // item 2). `null` while idle/picking/refused-on-filesystem-grounds, where
  // the outcome does not depend on the selection.
  //
  // Compared by CONTENTS, never by reference: a host that copies, sorts,
  // dedupes or case-normalizes the ids before storing them hands back a new
  // array on the next render, and a reference check would read that as the
  // selection changing and clear the alert the moment it appeared.
  const outcomeBaselineIncludedIds = useRef<readonly string[] | null>(null);
  useEffect(() => {
    const baseline = outcomeBaselineIncludedIds.current;
    if (baseline !== null && !selectsSamePaths(baseline, includedIds)) {
      setStatus(AddDirectoryStatus.Idle);
      outcomeBaselineIncludedIds.current = null;
    }
  }, [includedIds]);

  const pick = async () => {
    setStatus(AddDirectoryStatus.Picking);
    setAttempt((previous) => previous + 1);
    outcomeBaselineIncludedIds.current = null;
    let picked: PickedDirectory | null;
    try {
      picked = await pickDirectory();
    } catch (error) {
      setStatus(AddDirectoryStatus.Idle);
      onPickError(error);
      return;
    }
    if (picked === null) {
      setStatus(AddDirectoryStatus.Idle);
      return;
    }
    const outcome = resolveAddDirectoryOutcome(picked, includedIdsRef.current);
    let baseline: readonly string[] = includedIdsRef.current;
    if (outcome === AddDirectoryOutcome.Added) {
      // Create a row only when the path has none yet; a listed-but-unselected
      // row is included below instead of duplicated (design review item 3).
      const listedEntryId = findEntryId(entriesRef.current, picked.id);
      if (listedEntryId === undefined) {
        onAdd({ id: picked.id, label: picked.label, newlyDiscovered: true });
      }
      // A picked directory arrives included: the user chose it, unlike a row
      // discovery surfaces on its own (design review item 1). The row's OWN id
      // goes in, not the pick's: the lookup folds case but `CheckboxTree`
      // resolves ticks with an exact `checkedIds.has(node.id)`, so a
      // differently-cased pick of a listed row would otherwise leave that row
      // unticked while the alert claims it was added.
      const nextIncludedIds: string[] = [
        ...includedIdsRef.current,
        listedEntryId ?? picked.id,
      ];
      onIncludedIdsChange?.(nextIncludedIds);
      baseline = nextIncludedIds;
    }
    if (
      outcome === AddDirectoryOutcome.Added ||
      outcome === AddDirectoryOutcome.Duplicate
    ) {
      outcomeBaselineIncludedIds.current = baseline;
    }
    setStatus(outcome);
  };

  return (
    <div
      className="flex flex-col gap-2"
      data-slot="directory-scope-add"
      data-state={status}
    >
      <Button
        className="self-start"
        data-slot="directory-scope-add-trigger"
        disabled={status === AddDirectoryStatus.Picking}
        onClick={pick}
        size="sm"
        type="button"
        variant="outline"
      >
        <FolderPlusIcon aria-hidden="true" />
        {copy.trigger}
      </Button>
      {isOutcome(status) ? (
        <AddDirectoryOutcomeAlert
          copy={copy}
          key={`outcome-${attempt}`}
          outcome={status}
        />
      ) : null}
    </div>
  );
}

/**
 * Covers every outcome, including Added: `role="alert"` already announces
 * the refusals on arrival with no separate live region, so a success message
 * drawn the same way needs none either (design review item 2) — the prior
 * screen-reader-only paragraph was redundant with this and is gone.
 */
function AddDirectoryOutcomeAlert({
  outcome,
  copy,
}: {
  outcome: AddDirectoryOutcome;
  copy: AddDirectoryControlCopy;
}) {
  const { icon: Icon, variant, copyKey } = OUTCOME_TREATMENT[outcome];
  return (
    <Alert
      data-outcome={outcome}
      data-slot="directory-scope-add-outcome"
      variant={variant}
    >
      <Icon
        aria-hidden="true"
        data-slot={`directory-scope-add-${outcome}-icon`}
      />
      <AlertDescription>{copy[copyKey]}</AlertDescription>
    </Alert>
  );
}

function isOutcome(status: AddDirectoryStatus): status is AddDirectoryOutcome {
  return (
    status !== AddDirectoryStatus.Idle && status !== AddDirectoryStatus.Picking
  );
}

/**
 * Whether `path` is already in scope under ISS-12520's inheritance contract:
 * included directly, or nested under an id that is. Ids are absolute/
 * home-relative paths (that ticket's decision), so coverage is a path-prefix
 * check — it can answer for a path that is not even a row yet (design review
 * round 1, item 5: a subfolder of an included parent).
 */
function isCoveredByInclusion(
  path: string,
  includedIds: readonly string[]
): boolean {
  const normalized = normalizePath(path);
  return includedIds.some((includedId) => {
    const normalizedIncludedId = normalizePath(includedId);
    return (
      normalized === normalizedIncludedId ||
      normalized.startsWith(`${normalizedIncludedId}/`)
    );
  });
}

/**
 * The listed row's OWN id for `id`, or `undefined` when no row matches. It
 * returns the id rather than a boolean because the match folds case while
 * every consumer of `includedIds` compares exactly, so a caller that acted on
 * a positive match has to carry the row's spelling forward, not the caller's.
 */
function findEntryId(
  entries: readonly DirectoryScopeEntry[],
  id: string
): string | undefined {
  const normalized = normalizePath(id);
  for (const entry of entries) {
    if (normalizePath(entry.id) === normalized) {
      return entry.id;
    }
    if (entry.children !== undefined) {
      const nested = findEntryId(entry.children, id);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

/**
 * macOS and Windows filesystems are case-insensitive by default, so two
 * differently-cased picks of the same folder must compare equal (design
 * review round 2, item 4) — the same reasoning as the sibling
 * `pathsEqualIgnoreCase` in `apps/desktop/src/shared/sandbox-policy.ts`,
 * duplicated here (not imported) because that module is Node-only and this
 * package cannot import across the app/package boundary. Folding to
 * lowercase, not a locale-aware casefold, matches that sibling exactly.
 */
function normalizePath(path: string): string {
  return path.toLowerCase();
}

/**
 * Whether two `includedIds` values select the same paths. Compared as a set of
 * normalized paths, so the four things a real host does to the ids on its way
 * to a persisted setting — copy, reorder, dedupe, case-normalize — do not read
 * as the user changing the selection.
 */
function selectsSamePaths(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(normalizePath));
  const right = new Set(b.map(normalizePath));
  if (left.size !== right.size) {
    return false;
  }
  for (const path of left) {
    if (!right.has(path)) {
      return false;
    }
  }
  return true;
}
