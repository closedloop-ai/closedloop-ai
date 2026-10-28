"use client";

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { SlidersHorizontalIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// The settings slice hosts this composition. It mounts the sessions slice's
// upload badge and share exception list (ISS-12532, ISS-12535) and the shell
// slice's prototype scenario panel (ISS-12518), the narrowest surfaces that
// own those parts (packages/app/AGENTS.md: explicit cross-slice imports).
import {
  type SessionShareException,
  SessionShareExceptionList,
  ShareExceptionPrecedence,
} from "../../agents/components/sessions/session-share-exception-list";
import { SessionSyncStatusBadge } from "../../agents/components/sessions/session-sync-status-badge";
import {
  type DataControlsPolicy,
  DataControlsScopeEditor,
} from "../../shared/components/data-controls-scope-editor";
import { DataSyncPolicyChoice } from "../../shared/components/data-sync-policy-choice";
import { DataSyncPolicySummary } from "../../shared/components/data-sync-policy-summary";
import { DeletionEntryPoint } from "../../shared/components/deletion-entry-point";
import {
  DELETION_REQUEST_STATUS,
  type DeletionRequest,
  DeletionRequestTracker,
} from "../../shared/components/deletion-request-tracker";
import { DELETION_SCOPE_ITEM_KIND } from "../../shared/components/deletion-scope-review";
import type { DirectoryScopeEntry } from "../../shared/components/directory-scope-list";
import {
  AddDirectoryOutcome,
  DirectoryScopeListWithAdd,
} from "../../shared/components/directory-scope-list-with-add";
import {
  ADD_DIRECTORY_CONTROL_COPY,
  FIXTURE_AUTO_EXCLUDED,
  FIXTURE_PICKS,
} from "../../shared/components/directory-scope-list-with-add-fixtures";
import { POLICY_STATUS } from "../../shared/components/policy-status-indicator";
import { UploadQueueView } from "../../shared/components/upload-queue-view";
import { UPLOADS_STATE } from "../../shared/components/uploads-pause-control";
import { UploadsPauseControlFixtureHost } from "../../shared/components/uploads-pause-control-fixtures";
import { offeredDataSyncLevelsWithoutRedaction } from "../../shared/lib/data-sync-level-options";
import { SessionUploadState } from "../../shared/lib/upload-state";
import {
  PrototypeScenarioPanel,
  type ScenarioPanelCondition,
} from "../../shell/v2/components/prototype-scenario-panel";
import {
  type DataControlsPrototypeCopy,
  type DataControlsScenarioPanelCopy,
  FIXTURE_BASE_ENTRIES,
  FIXTURE_BASE_INCLUDED_IDS,
  FIXTURE_EXCLUDED_DIRECTORY,
  FIXTURE_EXPANDED_IDS,
  FIXTURE_MACHINE_NAME,
  FIXTURE_NEWLY_DISCOVERED_ENTRY,
  FIXTURE_ORG_NAME,
  FIXTURE_RETURNING_LEVEL,
  FIXTURE_SESSION,
  FIXTURE_UNAVAILABLE_ENTRY,
  FIXTURE_UPLOAD_QUEUE,
  type PRD_796_FLOW_TITLES,
} from "./data-controls-prototype-fixtures";

/**
 * @file ISS-12519 (PRD-796): the one resettable clickable prototype of the four
 * data-control flows, first-time setup and returning-user changes. It is a
 * mock host only: every part it renders is a shipped PRD-796 component, and
 * this module adds the fixture state that joins them, so a choice made in one
 * flow is what the next flow shows.
 *
 * The scenario presets ride on the shared `PrototypeScenarioPanel`
 * (ISS-12518). Changing any preset, or pressing the panel's Reset, rebuilds
 * the flows from the fixtures, which is what makes the prototype resettable.
 * The flow is a panel condition too, mirrored into `?flow=` so each flow has a
 * link of its own. No API, auth, IPC or persistence is reached.
 *
 * Owned here, not in `apps/prototypes`, because
 * `scripts/lint/production-bound-prototype-route.ts` allows a production-bound
 * route no markup beyond its `main` landmark. This module originates no words:
 * every string arrives through `copy`, `panelCopy` and `flowTitles`.
 */

const DataControlsFlow = {
  Scope: "scope",
  Policy: "policy",
  Share: "share",
  Delete: "delete",
} as const;
type DataControlsFlow =
  (typeof DataControlsFlow)[keyof typeof DataControlsFlow];

const FLOW_ORDER: readonly DataControlsFlow[] = [
  DataControlsFlow.Scope,
  DataControlsFlow.Policy,
  DataControlsFlow.Share,
  DataControlsFlow.Delete,
];

function isDataControlsFlow(value: unknown): value is DataControlsFlow {
  return (FLOW_ORDER as readonly unknown[]).includes(value);
}

const DataControlsUser = {
  FirstTime: "first-time",
  Returning: "returning",
} as const;
type DataControlsUser =
  (typeof DataControlsUser)[keyof typeof DataControlsUser];

const PRESET_IDS = [
  "newlyDiscovered",
  "excluded",
  "unavailable",
  "emptySelection",
  "unsetPolicy",
  "uploadFailed",
  "sessionShared",
  "deletionPending",
  "deletionFailed",
] as const;
type PresetId = (typeof PRESET_IDS)[number];

const ON = "on";
const OFF = "off";

type DataControlsScenario = {
  user: DataControlsUser;
  presets: Record<PresetId, boolean>;
};

const DEFAULT_SCENARIO: DataControlsScenario = {
  user: DataControlsUser.FirstTime,
  presets: Object.fromEntries(PRESET_IDS.map((id) => [id, false])) as Record<
    PresetId,
    boolean
  >,
};

/** How long the mock policy write stays pending before it lands. */
const MOCK_SAVE_DELAY_MS = 800;
const PANEL_POSITION_STORAGE_KEY =
  "closedloop-prototype-data-controls-panel-position";

export type DataControlsPrototypeDemoProps = {
  readonly copy: DataControlsPrototypeCopy;
  readonly panelCopy: DataControlsScenarioPanelCopy;
  readonly flowTitles: typeof PRD_796_FLOW_TITLES;
  /**
   * The raw `?flow=` value, read by a server route. A known flow is the one
   * the prototype opens on and Reset returns to; anything else opens flow 1.
   */
  readonly requestedFlow?: string;
};

export function DataControlsPrototypeDemo({
  copy,
  panelCopy,
  flowTitles,
  requestedFlow,
}: DataControlsPrototypeDemoProps) {
  const initialFlow = isDataControlsFlow(requestedFlow)
    ? requestedFlow
    : DataControlsFlow.Scope;
  const [flow, setFlow] = useState<DataControlsFlow>(initialFlow);
  const [scenario, setScenario] = useState(DEFAULT_SCENARIO);
  // Bumped by every preset change and by Reset, so the flows remount from the
  // fixtures even when Reset lands on the values already showing.
  const [generation, setGeneration] = useState(0);

  const selectFlow = useCallback((value: string) => {
    if (!isDataControlsFlow(value)) {
      return;
    }
    setFlow(value);
    const url = new URL(globalThis.window.location.href);
    url.searchParams.set("flow", value);
    globalThis.window.history.replaceState(null, "", url);
  }, []);

  const conditions = useMemo<readonly ScenarioPanelCondition[]>(() => {
    const toggle = (id: PresetId): ScenarioPanelCondition => ({
      ariaLabel: panelCopy.presets[id].ariaLabel,
      default: OFF,
      id,
      label: panelCopy.presets[id].label,
      onChange: (value) => {
        setScenario((current) => ({
          ...current,
          presets: { ...current.presets, [id]: value === ON },
        }));
        setGeneration((current) => current + 1);
      },
      options: [
        {
          ariaLabel: `${panelCopy.presets[id].ariaLabel}: ${panelCopy.off}`,
          label: panelCopy.off,
          value: OFF,
        },
        {
          ariaLabel: `${panelCopy.presets[id].ariaLabel}: ${panelCopy.on}`,
          label: panelCopy.on,
          value: ON,
        },
      ],
    });
    return [
      {
        ariaLabel: panelCopy.flow.ariaLabel,
        default: initialFlow,
        icon: SlidersHorizontalIcon,
        id: "flow",
        label: panelCopy.flow.label,
        onChange: selectFlow,
        options: FLOW_ORDER.map((value, index) => ({
          ariaLabel: flowTitles[value],
          label: String(index + 1),
          value,
        })),
      },
      {
        ariaLabel: panelCopy.user.ariaLabel,
        default: DataControlsUser.FirstTime,
        id: "user",
        label: panelCopy.user.label,
        onChange: (value) => {
          setScenario((current) => ({
            ...current,
            user:
              value === DataControlsUser.Returning
                ? DataControlsUser.Returning
                : DataControlsUser.FirstTime,
          }));
          setGeneration((current) => current + 1);
        },
        options: [
          {
            label: panelCopy.user.firstTime,
            value: DataControlsUser.FirstTime,
          },
          {
            label: panelCopy.user.returning,
            value: DataControlsUser.Returning,
          },
        ],
      },
      ...PRESET_IDS.map(toggle),
    ];
  }, [flowTitles, initialFlow, panelCopy, selectFlow]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10 md:px-8">
      <PrototypeScenarioPanel
        ariaLabel={panelCopy.ariaLabel}
        conditions={conditions}
        positionStorageKey={PANEL_POSITION_STORAGE_KEY}
      />
      <h1 className="font-semibold text-lg">{flowTitles[flow]}</h1>
      <DataControlsFlows
        copy={copy}
        flow={flow}
        key={generation}
        scenario={scenario}
      />
    </div>
  );
}

function scenarioEntries(
  presets: DataControlsScenario["presets"]
): readonly DirectoryScopeEntry[] {
  const extraChildren = [
    ...(presets.newlyDiscovered ? [FIXTURE_NEWLY_DISCOVERED_ENTRY] : []),
    ...(presets.unavailable ? [FIXTURE_UNAVAILABLE_ENTRY] : []),
  ];
  return FIXTURE_BASE_ENTRIES.map((entry) =>
    entry.children && extraChildren.length > 0
      ? { ...entry, children: [...entry.children, ...extraChildren] }
      : entry
  );
}

function scenarioIncludedIds(
  presets: DataControlsScenario["presets"]
): readonly string[] {
  if (presets.emptySelection) {
    return [];
  }
  // A newly discovered directory is never included on discovery (PRD-796:
  // discovery does not imply permission to upload).
  return presets.excluded
    ? FIXTURE_BASE_INCLUDED_IDS.filter(
        (id) => id !== FIXTURE_EXCLUDED_DIRECTORY.id
      )
    : FIXTURE_BASE_INCLUDED_IDS;
}

function scenarioLevel(scenario: DataControlsScenario): DataSyncLevel | null {
  return scenario.user === DataControlsUser.FirstTime ||
    scenario.presets.unsetPolicy
    ? null
    : FIXTURE_RETURNING_LEVEL;
}

function scenarioSessionState(
  presets: DataControlsScenario["presets"]
): SessionUploadState {
  if (presets.uploadFailed) {
    return SessionUploadState.Failed;
  }
  return presets.sessionShared
    ? SessionUploadState.Shared
    : SessionUploadState.LocalOnly;
}

/** Failed wins when both deletion presets are on: it is the state with a retry. */
function scenarioDeletionRequest(
  presets: DataControlsScenario["presets"]
): DeletionRequest | null {
  if (presets.deletionFailed) {
    return { status: DELETION_REQUEST_STATUS.FAILED };
  }
  return presets.deletionPending
    ? { status: DELETION_REQUEST_STATUS.PENDING }
    : null;
}

/**
 * The fixture state every flow reads, seeded from the scenario. Remounted by
 * the parent on any preset change or Reset.
 */
function DataControlsFlows({
  copy,
  flow,
  scenario,
}: {
  copy: DataControlsPrototypeCopy;
  flow: DataControlsFlow;
  scenario: DataControlsScenario;
}) {
  const { presets } = scenario;
  const [entries, setEntries] = useState(() => scenarioEntries(presets));
  const [includedIds, setIncludedIds] = useState(() =>
    scenarioIncludedIds(presets)
  );
  const [savedLevel, setSavedLevel] = useState(() => scenarioLevel(scenario));
  const [selectedLevel, setSelectedLevel] = useState(savedLevel);
  // The mock write always lands, so the editor shows only active and
  // pending; the failed and unavailable states are the indicator's own stories.
  const [policyStatus, setPolicyStatus] = useState<
    typeof POLICY_STATUS.ACTIVE | typeof POLICY_STATUS.PENDING
  >(POLICY_STATUS.ACTIVE);
  const [sessionState, setSessionState] = useState(() =>
    scenarioSessionState(presets)
  );
  const [deletionRequest, setDeletionRequest] = useState(() =>
    scenarioDeletionRequest(presets)
  );
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
    },
    []
  );

  const levels = offeredDataSyncLevelsWithoutRedaction(savedLevel);

  const saveLevel = (level: DataSyncLevel) => {
    setSavedLevel(level);
    setSelectedLevel(level);
  };

  // A flow 1 edit made while a policy save is still pending is the newer
  // one, so it cancels that save instead of being overwritten when it lands.
  const cancelPendingSave = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      setPolicyStatus(POLICY_STATUS.ACTIVE);
    }
  };

  const changeIncludedIds = (ids: readonly string[]) => {
    cancelPendingSave();
    setIncludedIds(ids);
  };

  const saveLevelFromChoice = (level: DataSyncLevel) => {
    cancelPendingSave();
    saveLevel(level);
  };

  // Pending inside the save handler, then active with the new policy, as
  // `DataControlsScopeEditorFixtureHost` models a host doing it.
  const savePolicy = (draft: DataControlsPolicy) => {
    setPolicyStatus(POLICY_STATUS.PENDING);
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
    }
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      setIncludedIds(draft.includedIds);
      saveLevel(draft.level);
      setPolicyStatus(POLICY_STATUS.ACTIVE);
    }, MOCK_SAVE_DELAY_MS);
  };

  const retryUpload = () => setSessionState(SessionUploadState.Uploading);

  // Nothing is queued while no level is saved, or the saved level is off.
  const uploadQueue =
    savedLevel === null || savedLevel === DataSyncLevel.Off
      ? { failed: 0, inFlight: 0, queued: 0 }
      : {
          ...FIXTURE_UPLOAD_QUEUE,
          failed: presets.uploadFailed ? 1 : 0,
        };

  const exceptions: SessionShareException[] = presets.sessionShared
    ? [
        {
          audience: FIXTURE_SESSION.audience,
          // Read from the live selection, so excluding the directory in
          // flow 1 marks the shared session here.
          excludedDirectory: includedIds.includes(FIXTURE_EXCLUDED_DIRECTORY.id)
            ? undefined
            : { ...FIXTURE_EXCLUDED_DIRECTORY },
          id: FIXTURE_SESSION.id,
          sessionName: FIXTURE_SESSION.name,
          uploadState: sessionState,
        },
      ]
    : [];

  switch (flow) {
    case DataControlsFlow.Scope:
      return (
        <div className="flex flex-col gap-8">
          <DirectoryScopeListWithAdd
            add={{
              copy: ADD_DIRECTORY_CONTROL_COPY,
              onAdd: (entry) => setEntries((previous) => [...previous, entry]),
              onPickError: () => undefined,
              pickDirectory: () =>
                Promise.resolve(FIXTURE_PICKS[AddDirectoryOutcome.Added]),
            }}
            autoExcluded={FIXTURE_AUTO_EXCLUDED}
            copy={copy.scopeList}
            defaultExpandedIds={FIXTURE_EXPANDED_IDS}
            entries={entries}
            includedIds={includedIds}
            onIncludedIdsChange={changeIncludedIds}
          />
          <DataSyncPolicyChoice
            currentLevel={savedLevel}
            isWriting={false}
            levels={levels}
            onSave={saveLevelFromChoice}
            onSelect={setSelectedLevel}
            selectedLevel={selectedLevel}
          />
        </div>
      );
    case DataControlsFlow.Policy:
      return (
        <div className="flex flex-col gap-8">
          {savedLevel === null ? (
            // Unset is not no-sync (ISS-12523): there is no policy to edit
            // until a level is chosen, so the choice stands in for the editor.
            <DataSyncPolicyChoice
              currentLevel={savedLevel}
              isWriting={false}
              levels={levels}
              onSave={saveLevel}
              onSelect={setSelectedLevel}
              selectedLevel={selectedLevel}
            />
          ) : (
            <>
              <DataSyncPolicySummary
                appliesTo={{
                  label: copy.summaryAppliesTo,
                  machineName: FIXTURE_MACHINE_NAME,
                  orgName: FIXTURE_ORG_NAME,
                }}
                directoryScope={{
                  count: includedIds.length,
                  label: copy.summaryDirectoryScope,
                }}
                level={savedLevel}
              />
              <DataControlsScopeEditor
                autoExcluded={FIXTURE_AUTO_EXCLUDED}
                copy={copy.scopeEditor}
                defaultExpandedIds={FIXTURE_EXPANDED_IDS}
                entries={entries}
                levels={levels}
                onSave={savePolicy}
                saved={{ includedIds, level: savedLevel }}
                scopeCopy={copy.scopeList}
                status={{
                  label: copy.policyStatus[policyStatus],
                  status: policyStatus,
                }}
              />
            </>
          )}
          <UploadsPauseControlFixtureHost
            heading={copy.uploads.heading}
            onPause={() => undefined}
            onResume={() => undefined}
            pausedLabel={copy.uploads.pausedLabel}
            pausedSummary={copy.uploads.pausedSummary}
            pauseLabel={copy.uploads.pauseLabel}
            resumeLabel={copy.uploads.resumeLabel}
            state={UPLOADS_STATE.UPLOADING}
            uploadingSummary={copy.uploads.uploadingSummary}
          />
          <UploadQueueView copy={copy.uploadQueue} counts={uploadQueue} />
        </div>
      );
    case DataControlsFlow.Share:
      return (
        <div className="flex flex-col gap-8">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <span className="font-medium text-sm">{FIXTURE_SESSION.name}</span>
            {sessionState === SessionUploadState.Failed ? (
              <SessionSyncStatusBadge
                label={copy.sessionUploadState[sessionState]}
                onRetry={retryUpload}
                retryLabel={copy.sessionRetry}
                uploadState={sessionState}
              />
            ) : (
              <SessionSyncStatusBadge
                label={copy.sessionUploadState[sessionState]}
                uploadState={sessionState}
              />
            )}
          </div>
          <SessionShareExceptionList
            copy={copy.shareExceptions}
            exceptions={exceptions}
            onRetryUpload={retryUpload}
            precedence={ShareExceptionPrecedence.ExceptionWins}
          />
        </div>
      );
    case DataControlsFlow.Delete:
      return (
        <div className="flex flex-col gap-8">
          <DeletionEntryPoint
            effects={copy.deletionEffects}
            effectsLabel={copy.deletion.effectsLabel}
            itemName={copy.deletion.itemName}
            items={[
              {
                id: FIXTURE_SESSION.id,
                kind: DELETION_SCOPE_ITEM_KIND.SESSION,
                label: FIXTURE_SESSION.name,
              },
              {
                id: FIXTURE_EXCLUDED_DIRECTORY.id,
                kind: DELETION_SCOPE_ITEM_KIND.DIRECTORY,
                label: FIXTURE_EXCLUDED_DIRECTORY.label,
              },
            ]}
            onConfirm={() => {
              setDeletionRequest({ status: DELETION_REQUEST_STATUS.PENDING });
              return Promise.resolve(true);
            }}
            scopeLabel={copy.deletion.scopeLabel}
            title={copy.deletion.title}
            triggerLabel={copy.deletion.triggerLabel}
          />
          {deletionRequest ? (
            <DeletionRequestTracker
              copy={copy.deletionTracker}
              onRetry={() =>
                setDeletionRequest({ status: DELETION_REQUEST_STATUS.PENDING })
              }
              request={deletionRequest}
            />
          ) : null}
        </div>
      );
    default:
      return null;
  }
}
