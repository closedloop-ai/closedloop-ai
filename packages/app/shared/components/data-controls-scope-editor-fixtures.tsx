"use client";

import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { Button } from "@repo/design-system/components/ui/button";
import { useEffect, useRef, useState } from "react";
import {
  type DataControlsLeaveRequest,
  type DataControlsPolicy,
  DataControlsScopeEditor,
  type DataControlsScopeEditorCopy,
} from "./data-controls-scope-editor";
import type {
  AutoExcludedDirectory,
  DirectoryScopeEntry,
  DirectoryScopeListCopy,
} from "./directory-scope-list";
import { POLICY_STATUS, type PolicyStatus } from "./policy-status-indicator";

/** How the fixture's pretend write settles. `hold` never settles. */
export const FIXTURE_SAVE_OUTCOME = {
  SUCCEED: "succeed",
  FAIL: "fail",
  HOLD: "hold",
} as const;

export type FixtureSaveOutcome =
  (typeof FIXTURE_SAVE_OUTCOME)[keyof typeof FIXTURE_SAVE_OUTCOME];

/**
 * A stand-in host for tests and stories, shared so the two exercise the same
 * fixture (the ISS-12528 pattern, PR #8870 review). Not a production host: it
 * pretends to write, and shows the status a real host would map from
 * `useLocalSyncPolicy` (see `PolicyStatusIndicator`): pending inside the save
 * handler, then active with the new policy, or failed with a retry that
 * writes the same stashed draft again. A discard drops the stashed draft and
 * the failed state with it, so retry can never write a discarded policy.
 *
 * The props are flattened so a story's controls panel can drive them.
 */
export type DataControlsScopeEditorFixtureHostProps = {
  initialSaved: DataControlsPolicy;
  /** A starting draft, to open a story already holding unsaved changes. */
  initialDraft?: DataControlsPolicy;
  /** Start with the status unavailable: no policy to show. */
  unavailable?: boolean;
  saveOutcome: FixtureSaveOutcome;
  saveDelayMs: number;
  entries: readonly DirectoryScopeEntry[];
  autoExcluded?: readonly AutoExcludedDirectory[];
  levels: readonly DataSyncLevel[];
  defaultExpandedIds?: readonly string[];
  copy: DataControlsScopeEditorCopy;
  scopeCopy: DirectoryScopeListCopy;
  statusLabels: Record<PolicyStatus, string>;
  retryLabel: string;
  /** The fixture's own pretend navigation, standing in for a host's. */
  leaveLabel: string;
  onSave: (draft: DataControlsPolicy) => void;
  onDiscard?: () => void;
  onLeave: () => void;
  onStay: () => void;
};

export function DataControlsScopeEditorFixtureHost({
  initialSaved,
  initialDraft,
  unavailable = false,
  saveOutcome,
  saveDelayMs,
  statusLabels,
  retryLabel,
  leaveLabel,
  onSave,
  onDiscard,
  onLeave,
  onStay,
  ...editorProps
}: DataControlsScopeEditorFixtureHostProps) {
  const [saved, setSaved] = useState(initialSaved);
  const [status, setStatus] = useState<PolicyStatus>(
    unavailable ? POLICY_STATUS.UNAVAILABLE : POLICY_STATUS.ACTIVE
  );
  const [leaveRequest, setLeaveRequest] =
    useState<DataControlsLeaveRequest | null>(null);
  const stashed = useRef<DataControlsPolicy | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    []
  );

  const write = (draft: DataControlsPolicy) => {
    onSave(draft);
    stashed.current = draft;
    setStatus(POLICY_STATUS.PENDING);
    if (saveOutcome === FIXTURE_SAVE_OUTCOME.HOLD) {
      return;
    }
    timer.current = setTimeout(() => {
      if (saveOutcome === FIXTURE_SAVE_OUTCOME.SUCCEED) {
        setSaved(draft);
        setStatus(POLICY_STATUS.ACTIVE);
      } else {
        setStatus(POLICY_STATUS.FAILED);
      }
    }, saveDelayMs);
  };

  return (
    <div className="flex flex-col gap-4">
      <DataControlsScopeEditor
        {...editorProps}
        defaultDraft={initialDraft}
        leaveRequest={leaveRequest}
        onDiscard={() => {
          onDiscard?.();
          // The saved policy is still the one in force; the failed write,
          // and its retry, went with the discarded draft.
          stashed.current = null;
          setStatus((current) =>
            current === POLICY_STATUS.FAILED ? POLICY_STATUS.ACTIVE : current
          );
        }}
        onSave={write}
        saved={saved}
        status={
          status === POLICY_STATUS.FAILED
            ? {
                status,
                label: statusLabels[status],
                retryLabel,
                onRetry: () => {
                  if (stashed.current) {
                    write(stashed.current);
                  }
                },
              }
            : { status, label: statusLabels[status] }
        }
      />
      <Button
        className="self-start"
        onClick={() =>
          setLeaveRequest({
            onLeave: () => {
              onLeave();
              setLeaveRequest(null);
            },
            onStay: () => {
              onStay();
              setLeaveRequest(null);
            },
          })
        }
        size="sm"
        type="button"
        variant="link"
      >
        {leaveLabel}
      </Button>
    </div>
  );
}
