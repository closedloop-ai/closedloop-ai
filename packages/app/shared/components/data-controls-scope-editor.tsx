"use client";

import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { useEffect, useRef, useState } from "react";
import { ConfirmationDialog } from "./confirmation-dialog";
import { DataSyncLevelPicker } from "./data-sync-level-picker";
import {
  type AutoExcludedDirectory,
  type DirectoryScopeEntry,
  DirectoryScopeList,
  type DirectoryScopeListCopy,
} from "./directory-scope-list";
import {
  POLICY_STATUS,
  PolicyStatusIndicator,
  type PolicyStatusIndicatorProps,
} from "./policy-status-indicator";

/**
 * @file ISS-12527 (PRD-806, data controls flow 2): the Settings editor for the
 * collection policy, directory scope and sync level together, held as an
 * explicit draft that is saved or discarded.
 *
 * It composes three shipped parts and adds only the draft:
 * - `DirectoryScopeList` (ISS-12520) for the directories in scope,
 * - `DataSyncLevelPicker` (FEA-3907 / ISS-6147), the one sync-level control,
 * - `PolicyStatusIndicator` (ISS-12526) for whether the saved policy is
 *   active, a save is pending, applying failed, or the policy is unavailable.
 *
 * The draft starts as `saved`. Edits change only the draft; nothing reaches
 * the host until save, which hands the whole draft to `onSave`. Discard puts
 * the draft back to `saved`.
 *
 * The status is the HOST's, not inferred here: a host sets `pending` inside
 * its `onSave` handler (as ISS-12528 asks of the pause control), and `active`
 * or `failed` when its write settles, using the mapping documented on
 * `PolicyStatusIndicator`. While the status is pending the editor is locked,
 * so the draft cannot drift from what was submitted. While it is unavailable
 * the editor is locked too, since there is no policy to write to; discard
 * still works, as it only drops the local draft. Whether an unavailable
 * policy should be editable at all is for the PRD-796 owners (PR #8876
 * review); locking is the choice that writes nothing in the meantime.
 *
 * Discard tells the host through `onDiscard`, so a host holding a failed
 * write for retry can drop it: retrying after a discard would otherwise write
 * the policy the user just threw away.
 *
 * When `saved` changes, the draft follows it if the user had nothing unsaved
 * or `saved` is now exactly what the user last submitted; otherwise the draft is kept, so a change from elsewhere
 * never silently throws away the user's edits. Whether the policy can change
 * from elsewhere at all is open on PRD-806 ("editable remotely or only
 * on-device"); this rule holds either way.
 *
 * Leaving with unsaved changes: the host owns its navigation, so it reports a
 * leave attempt through `leaveRequest`. With nothing unsaved the editor lets
 * the host go at once; otherwise it asks, through the shared
 * `ConfirmationDialog`, whether to stay or discard and leave. While a save is
 * pending the editor holds the leave unanswered: discarding cannot cancel a
 * write already started, so offering it would misstate what happens. Once the
 * status settles, a write that landed leaves the draft clean and the host
 * goes at once; a write that failed brings up the prompt. `onDirtyChange`
 * lets a host that cannot route a leave through here know there is a draft.
 *
 * The editor answers each leave request exactly once (one `onLeave` or one
 * `onStay`), counting a request from when `leaveRequest` becomes non-null to
 * when the host sets it back to null. The object's identity does not matter,
 * so a host may build it afresh on every render; it must set it to null after
 * either answer before it reports another leave.
 *
 * Every string is a required prop. None of it has an approved source yet, and
 * the shared package ships no copy of its own (AGENTS.md Human Provenance).
 * No production host renders it yet: the desktop has no directory-scope
 * setting to read or write (PRD-806 "Non-component dependencies").
 */

/** The policy the editor edits: the directories in scope and the level. */
export type DataControlsPolicy<L extends DataSyncLevel = DataSyncLevel> = {
  /** Stored exactly as `DirectoryScopeList` emits it. */
  includedIds: readonly string[];
  level: L;
};

/** The words the editor needs around the parts it composes. */
export type DataControlsScopeEditorCopy = {
  /** Heading over the directory scope list. */
  scopeHeading: string;
  /** Heading over the sync-level picker. */
  levelHeading: string;
  /** Accessible name of the sync-level radio group. */
  levelLabel: string;
  /** Shown while the draft differs from the saved policy. */
  unsavedChanges: string;
  saveLabel: string;
  discardLabel: string;
  /** The leave prompt: title, body and its two choices. */
  leaveTitle: string;
  leaveDescription: string;
  leaveStayLabel: string;
  leaveDiscardLabel: string;
};

/**
 * A leave attempt the host has paused until the editor answers. Answered
 * once; the host sets `leaveRequest` back to null after either callback.
 */
export type DataControlsLeaveRequest = {
  /** Go ahead with the navigation. Called after any draft is discarded. */
  onLeave: () => void;
  /** The user chose to stay; cancel the navigation. */
  onStay: () => void;
};

export type DataControlsScopeEditorProps<L extends DataSyncLevel> = {
  /** The policy in force, as the host last read or wrote it. */
  saved: DataControlsPolicy<L>;
  /**
   * A draft to start from instead of `saved`, e.g. one the host kept while
   * the user was elsewhere. Read on mount only.
   */
  defaultDraft?: DataControlsPolicy<L>;
  /** Receives the whole draft on save. The host sets status pending here. */
  onSave: (draft: DataControlsPolicy<L>) => void;
  /**
   * The user discarded the draft, from the discard button or by discarding
   * and leaving. A host holding a failed write for retry drops it here.
   */
  onDiscard?: () => void;
  /** The host's policy status, passed straight to `PolicyStatusIndicator`. */
  status: PolicyStatusIndicatorProps;
  entries: readonly DirectoryScopeEntry[];
  autoExcluded?: readonly AutoExcludedDirectory[];
  scopeCopy: DirectoryScopeListCopy;
  /** The levels this host offers; the picker orders them. */
  levels: readonly L[];
  copy: DataControlsScopeEditorCopy;
  /** Set while the host holds a navigation for the editor to answer. */
  leaveRequest?: DataControlsLeaveRequest | null;
  /** Fires when the draft becomes, or stops being, different from `saved`. */
  onDirtyChange?: (dirty: boolean) => void;
  defaultExpandedIds?: readonly string[];
  className?: string;
};

/** Same level and the same included set, in any order. */
export function isSameDataControlsPolicy(
  a: DataControlsPolicy,
  b: DataControlsPolicy
): boolean {
  if (a.level !== b.level || a.includedIds.length !== b.includedIds.length) {
    return false;
  }
  const included = new Set(a.includedIds);
  return b.includedIds.every((id) => included.has(id));
}

export function DataControlsScopeEditor<L extends DataSyncLevel>({
  saved,
  defaultDraft,
  onSave,
  onDiscard,
  status,
  entries,
  autoExcluded,
  scopeCopy,
  levels,
  copy,
  leaveRequest = null,
  onDirtyChange,
  defaultExpandedIds,
  className,
}: DataControlsScopeEditorProps<L>) {
  const [draft, setDraft] = useState<DataControlsPolicy<L>>(
    defaultDraft ?? saved
  );
  const [baseline, setBaseline] = useState<DataControlsPolicy<L>>(saved);
  // The draft last handed to `onSave`, until `saved` next changes or the
  // user edits again. Kept as the policy, not a flag, so a failed save
  // followed by a change from elsewhere does not replace the draft.
  const [submitted, setSubmitted] = useState<DataControlsPolicy<L> | null>(
    null
  );

  // Follow a new `saved` during render rather than in an effect, so the
  // editor never paints one frame of the old draft against the new policy.
  if (!isSameDataControlsPolicy(baseline, saved)) {
    setBaseline(saved);
    if (
      (submitted !== null && isSameDataControlsPolicy(saved, submitted)) ||
      isSameDataControlsPolicy(draft, baseline)
    ) {
      setDraft(saved);
    }
    setSubmitted(null);
  }

  const dirty = !isSameDataControlsPolicy(draft, saved);
  const saving = status.status === POLICY_STATUS.PENDING;
  const locked = saving || status.status === POLICY_STATUS.UNAVAILABLE;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // The current request, read by the effects below without keying on its
  // identity: a host may build a fresh object on every render.
  const leaveRequestRef = useRef(leaveRequest);
  useEffect(() => {
    leaveRequestRef.current = leaveRequest;
  });
  const leavePending = leaveRequest !== null;

  // Set once the current request has had its one answer, so it is never
  // answered twice; cleared when the host clears the request.
  const answeredRef = useRef(false);
  useEffect(() => {
    if (!leavePending) {
      answeredRef.current = false;
    }
  }, [leavePending]);

  // Nothing to lose: let the host's navigation through without asking.
  useEffect(() => {
    if (leavePending && !dirty && !answeredRef.current) {
      answeredRef.current = true;
      leaveRequestRef.current?.onLeave();
    }
  }, [leavePending, dirty]);

  const edit = (next: Partial<DataControlsPolicy<L>>) => {
    setSubmitted(null);
    setDraft((current) => ({ ...current, ...next }));
  };
  const discard = () => {
    setSubmitted(null);
    setDraft(saved);
    onDiscard?.();
  };

  return (
    <div
      className={cn("flex flex-col gap-6", className)}
      data-dirty={dirty ? "true" : undefined}
      data-testid="data-controls-scope-editor"
    >
      <PolicyStatusIndicator {...status} />
      {/* `inert` while a save is pending: the tree has no disabled state of
          its own, and a draft edited mid-save would no longer be what the
          host is applying. Also while unavailable: nothing to write to. */}
      <section className="flex flex-col gap-2" inert={locked}>
        {/* Not heading elements: the host owns the page outline. */}
        <p className="font-medium text-sm">{copy.scopeHeading}</p>
        <DirectoryScopeList
          autoExcluded={autoExcluded}
          copy={scopeCopy}
          defaultExpandedIds={defaultExpandedIds}
          entries={entries}
          includedIds={draft.includedIds}
          onIncludedIdsChange={(includedIds) => edit({ includedIds })}
        />
      </section>
      <section className="flex flex-col gap-2">
        <p className="font-medium text-sm">{copy.levelHeading}</p>
        <DataSyncLevelPicker
          disabled={locked}
          label={copy.levelLabel}
          levels={levels}
          onSelect={(level) => edit({ level })}
          selected={draft.level}
        />
      </section>
      <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-3">
        {/* Stays mounted so the text change is announced. */}
        <p
          className="mr-auto text-muted-foreground text-xs empty:hidden"
          data-testid="data-controls-unsaved"
          role="status"
        >
          {dirty ? copy.unsavedChanges : null}
        </p>
        <Button
          disabled={!dirty || saving}
          onClick={discard}
          size="sm"
          type="button"
          variant="outline"
        >
          {copy.discardLabel}
        </Button>
        <Button
          disabled={!dirty || locked}
          onClick={() => {
            setSubmitted(draft);
            onSave(draft);
          }}
          size="sm"
          type="button"
        >
          {copy.saveLabel}
        </Button>
      </div>
      <ConfirmationDialog
        cancelLabel={copy.leaveStayLabel}
        confirmLabel={copy.leaveDiscardLabel}
        description={copy.leaveDescription}
        onConfirm={() => {
          if (answeredRef.current) {
            return;
          }
          answeredRef.current = true;
          discard();
          leaveRequestRef.current?.onLeave();
        }}
        onOpenChange={(open) => {
          if (!(open || answeredRef.current)) {
            answeredRef.current = true;
            leaveRequestRef.current?.onStay();
          }
        }}
        // Held while a save is pending; see the file docblock.
        open={leavePending && dirty && !saving}
        title={copy.leaveTitle}
      />
    </div>
  );
}
