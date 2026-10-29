/**
 * @file Fixtures for `DataControlsPrototypeDemo` (ISS-12519), read by the
 * `data-controls` prototype. No shipped render path imports this module.
 *
 * Every directory, machine, organization and session is fictional. Every
 * string a component shows has no approved wording yet, so each slot is a
 * neutral placeholder named after it, allowed for design-only fixtures by
 * operator ruling (Nerys, 2026-10-15, thread th_Dc0RuSiAdyCvLQpC_X2G4). Three
 * sources are reused, not written: the four flow titles are PRD-796's own
 * headings, verbatim; the add control's copy is the wording Cosimo Corrigan
 * approved for ISS-12521 (`directory-scope-list-with-add-fixtures.ts`); and
 * the sync-level cards read the shipped `data-sync-copy` through the picker.
 */

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
// The settings slice hosts the prototype's composition; the share exception
// list it mounts lives in the sessions slice, so its copy type comes from
// there (packages/app/AGENTS.md: explicit, narrow cross-slice import).
import type { SessionShareExceptionListCopy } from "../../agents/components/sessions/session-share-exception-list";
import type { DataControlsScopeEditorCopy } from "../../shared/components/data-controls-scope-editor";
import type { DeletionRequestTrackerCopy } from "../../shared/components/deletion-request-tracker";
import type { DeletionEffects } from "../../shared/components/deletion-scope-review";
import type { DirectoryScopeEntry } from "../../shared/components/directory-scope-list";
import type { UploadQueueViewCopy } from "../../shared/components/upload-queue-view";
import { ShareAudience } from "../../shared/lib/share-audience";
import { SessionUploadState } from "../../shared/lib/upload-state";

/** PRD-796 "Proposed experience and prototype flows", headings 1-4 verbatim. */
export const PRD_796_FLOW_TITLES = {
  scope: "Choose collection and upload scope upfront.",
  policy: "See and change the active policy.",
  share: "Selectively share one session.",
  delete: "Recover from an accidental upload.",
} as const;

export const PLACEHOLDER_DATA_CONTROLS_COPY = {
  scopeList: {
    autoExcludedHeading: "Placeholder: auto-excluded heading",
    autoExcludedReason: "Placeholder: auto-excluded reason",
    empty: "Placeholder: empty",
    newlyDiscovered: "Placeholder: newly discovered",
    noSelection: "Placeholder: no selection",
    treeLabel: "Placeholder: tree label",
    unavailable: "Placeholder: unavailable",
    unavailableReason: "Placeholder: unavailable reason",
  },
  scopeEditor: {
    discardLabel: "Placeholder: discard",
    leaveDescription: "Placeholder: leave description",
    leaveDiscardLabel: "Placeholder: discard and leave",
    leaveStayLabel: "Placeholder: stay",
    leaveTitle: "Placeholder: leave title",
    levelHeading: "Placeholder: sync level heading",
    levelLabel: "Placeholder: sync level label",
    saveLabel: "Placeholder: save",
    scopeHeading: "Placeholder: directories heading",
    unsavedChanges: "Placeholder: unsaved changes",
  } satisfies DataControlsScopeEditorCopy,
  policyStatus: {
    active: "Placeholder: active",
    pending: "Placeholder: pending",
  },
  summaryDirectoryScope: "Placeholder: directories in scope label",
  summaryAppliesTo: "Placeholder: applies to label",
  uploads: {
    heading: "Placeholder: uploads heading",
    uploadingSummary: "Placeholder: uploading summary",
    pausedSummary: "Placeholder: paused summary",
    pauseLabel: "Placeholder: pause",
    resumeLabel: "Placeholder: resume",
    pausedLabel: "Placeholder: paused",
  },
  uploadQueue: {
    emptyText: "Placeholder: queue empty",
    failedLabel: "Placeholder: failed",
    heading: "Placeholder: upload queue heading",
    inFlightLabel: "Placeholder: in flight",
    queuedLabel: "Placeholder: queued",
    unmeasuredText: "Placeholder: queue not measured",
  } satisfies UploadQueueViewCopy,
  sessionUploadState: {
    [SessionUploadState.LocalOnly]: "Placeholder: local only",
    [SessionUploadState.Uploading]: "Placeholder: uploading",
    [SessionUploadState.Shared]: "Placeholder: shared",
    [SessionUploadState.Failed]: "Placeholder: upload failed",
  },
  sessionRetry: "Placeholder: retry upload",
  shareExceptions: {
    audienceLabel: {
      [ShareAudience.OnlyMe]: "Placeholder: only me",
      [ShareAudience.Organization]: "Placeholder: organization",
    },
    blockedLabel: "Placeholder: blocked",
    emptyText: "Placeholder: no shared sessions",
    excludedDirectoryLabel: "Placeholder: excluded directory",
    heading: "Placeholder: shared sessions heading",
    retryLabel: "Placeholder: retry upload",
    uploadStateLabel: {
      [SessionUploadState.LocalOnly]: "Placeholder: local only",
      [SessionUploadState.Uploading]: "Placeholder: uploading",
      [SessionUploadState.Shared]: "Placeholder: shared",
      [SessionUploadState.Failed]: "Placeholder: upload failed",
    },
  } satisfies SessionShareExceptionListCopy,
  deletion: {
    triggerLabel: "Placeholder: delete trigger",
    title: "Placeholder: deletion title",
    itemName: "Placeholder: deletion item name",
    scopeLabel: "Placeholder: deletion scope",
    effectsLabel: "Placeholder: deletion effects",
  },
  // PRD-796 flow 4: copy about deletion timing, retained copies or completed
  // removal must be technically verified first, so every statement here is a
  // slot name and asserts nothing.
  deletionEffects: {
    futureReupload: {
      label: "Placeholder: future re-upload",
      statement: "Placeholder: future re-upload statement",
    },
    localCopies: {
      label: "Placeholder: local copies",
      statement: "Placeholder: local copies statement",
    },
    serverData: {
      label: "Placeholder: server data",
      statement: "Placeholder: server data statement",
    },
    sharedAccess: {
      label: "Placeholder: shared access",
      statement: "Placeholder: shared access statement",
    },
  } satisfies DeletionEffects,
  deletionTracker: {
    completedLabel: "Placeholder: completed",
    failedLabel: "Placeholder: failed",
    pendingLabel: "Placeholder: pending",
    retryLabel: "Placeholder: retry deletion",
    unavailableExplanation: "Placeholder: unavailable explanation",
    unavailableLabel: "Placeholder: unavailable",
  } satisfies DeletionRequestTrackerCopy,
} as const;

export type DataControlsPrototypeCopy = typeof PLACEHOLDER_DATA_CONTROLS_COPY;

export const FIXTURE_MACHINE_NAME = "Harbor MacBook Pro";
export const FIXTURE_ORG_NAME = "Harbor Works";

/** The directory the "excluded directory" preset leaves out of scope. */
export const FIXTURE_EXCLUDED_DIRECTORY = {
  id: "~/scratch",
  label: "~/scratch",
} as const;

/** What discovery found on the fictional machine, before any preset. */
export const FIXTURE_BASE_ENTRIES: readonly DirectoryScopeEntry[] = [
  {
    id: "~/work",
    label: "~/work",
    children: [
      { id: "~/work/harbor-api", label: "harbor-api" },
      { id: "~/work/harbor-app", label: "harbor-app" },
    ],
  },
  { ...FIXTURE_EXCLUDED_DIRECTORY },
];

/** Added under `~/work` by the "newly discovered directory" preset. */
export const FIXTURE_NEWLY_DISCOVERED_ENTRY: DirectoryScopeEntry = {
  id: "~/work/harbor-docs",
  label: "harbor-docs",
  newlyDiscovered: true,
};

/** Added under `~/work` by the "unavailable directory" preset. */
export const FIXTURE_UNAVAILABLE_ENTRY: DirectoryScopeEntry = {
  id: "~/work/old-ledger",
  label: "old-ledger",
  unavailable: true,
};

export const FIXTURE_BASE_INCLUDED_IDS: readonly string[] = [
  "~/work/harbor-api",
  "~/work/harbor-app",
  FIXTURE_EXCLUDED_DIRECTORY.id,
];

export const FIXTURE_EXPANDED_IDS: readonly string[] = ["~/work"];

/** A returning user's saved level, before any preset. */
export const FIXTURE_RETURNING_LEVEL = DataSyncLevel.Metadata;

/** The upload queue a returning user's machine reports. */
export const FIXTURE_UPLOAD_QUEUE = { failed: 0, inFlight: 1, queued: 3 };

/**
 * The one session flows 3 and 4 act on. It was recorded in
 * `FIXTURE_EXCLUDED_DIRECTORY`, so the "excluded directory" preset shows how a
 * one-session exception meets a directory exclusion.
 */
export const FIXTURE_SESSION = {
  id: "session-scratch-csv-importer",
  name: "Sketch a CSV importer",
  audience: ShareAudience.OnlyMe,
} as const;

/**
 * Reviewer-facing labels for the scenario panel: prototype controls, not
 * product copy. Each preset's accessible name is its ISS-12519 AC-002 name,
 * verbatim, and each flow's is its PRD-796 heading.
 */
export const SCENARIO_PANEL_COPY = {
  ariaLabel: "Data controls prototype scenarios",
  flow: { label: "Flow:", ariaLabel: "PRD-796 flow" },
  user: {
    label: "User:",
    ariaLabel: "First-time setup or returning-user changes",
    firstTime: "First-time",
    returning: "Returning",
  },
  on: "On",
  off: "Off",
  presets: {
    newlyDiscovered: {
      label: "New directory:",
      ariaLabel: "Newly discovered directory",
    },
    excluded: { label: "Excluded:", ariaLabel: "Excluded directory" },
    unavailable: { label: "Unavailable:", ariaLabel: "Unavailable directory" },
    emptySelection: { label: "No selection:", ariaLabel: "Empty selection" },
    unsetPolicy: { label: "Unset policy:", ariaLabel: "Unset policy" },
    uploadFailed: { label: "Upload failed:", ariaLabel: "Upload failed" },
    sessionShared: { label: "Shared:", ariaLabel: "Session shared" },
    deletionPending: { label: "Del. pending:", ariaLabel: "Deletion pending" },
    deletionFailed: { label: "Del. failed:", ariaLabel: "Deletion failed" },
  },
} as const;

export type DataControlsScenarioPanelCopy = typeof SCENARIO_PANEL_COPY;
