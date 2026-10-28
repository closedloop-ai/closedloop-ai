import type { OperationReceipt } from "./attribution-evidence.ts";
import type { JsonObject } from "./common.ts";

export const GRID_PREFERENCE_ROUTE = "/settings/grid-preferences";

export const GRID_PREFERENCE_CONTRACT_VERSION = 1 as const;

export const GRID_PREFERENCE_VALUE_MAX_BYTES = 65_536;

/** Highest revision value that can be stored in PostgreSQL INTEGER columns. */
export const GRID_PREFERENCE_REVISION_MAX = 2_147_483_647;

export const GridPreferenceGridKey = {
  Sessions: "sessions",
  Branches: "branches",
  Agents: "agents",
  ProjectArtifacts: "project-artifacts",
} as const;

export type GridPreferenceGridKey =
  (typeof GridPreferenceGridKey)[keyof typeof GridPreferenceGridKey];

export const GridPreferenceKind = {
  ViewState: "view-state",
} as const;

export type GridPreferenceKind =
  (typeof GridPreferenceKind)[keyof typeof GridPreferenceKind];

export const GridPreferenceScopeKey = {
  Default: "default",
  Approved: "approved",
} as const;

export const PROJECT_GRID_PREFERENCE_SCOPE_PREFIX = "project:" as const;
export type ProjectGridPreferenceScopeKey =
  `${typeof PROJECT_GRID_PREFERENCE_SCOPE_PREFIX}${string}`;

export type GridPreferenceScopeKey =
  | (typeof GridPreferenceScopeKey)[keyof typeof GridPreferenceScopeKey]
  | ProjectGridPreferenceScopeKey;

export const GridPreferenceReadStatus = {
  List: "list",
  Found: "found",
  Missing: "missing",
} as const;

export type GridPreferenceReadStatus =
  (typeof GridPreferenceReadStatus)[keyof typeof GridPreferenceReadStatus];

export const GridPreferenceWriteStatus = {
  Stored: "stored",
} as const;

export type GridPreferenceWriteStatus =
  (typeof GridPreferenceWriteStatus)[keyof typeof GridPreferenceWriteStatus];

export const GridPreferenceResetStatus = {
  Deleted: "deleted",
  Missing: "missing",
} as const;

export type GridPreferenceResetStatus =
  (typeof GridPreferenceResetStatus)[keyof typeof GridPreferenceResetStatus];

export const GridPreferenceErrorCode = {
  StaleRevision: "grid_preference_stale_revision",
} as const;

export type GridPreferenceErrorCode =
  (typeof GridPreferenceErrorCode)[keyof typeof GridPreferenceErrorCode];

export type GridPreferenceSelector = {
  gridKey: GridPreferenceGridKey;
  preferenceKind: GridPreferenceKind;
  scopeKey: GridPreferenceScopeKey;
};

export type GridPreference = GridPreferenceSelector & {
  value: JsonObject;
  revision: number;
  createdAt: string;
  updatedAt: string;
  contractVersion: typeof GRID_PREFERENCE_CONTRACT_VERSION;
};

export type GridPreferenceReadQuery =
  | { selector?: undefined }
  | { selector: GridPreferenceSelector };

export type GridPreferenceReadResponse =
  | {
      status: typeof GridPreferenceReadStatus.List;
      preferences: readonly GridPreference[];
      contractVersion: typeof GRID_PREFERENCE_CONTRACT_VERSION;
    }
  | {
      status: typeof GridPreferenceReadStatus.Found;
      preference: GridPreference;
      contractVersion: typeof GRID_PREFERENCE_CONTRACT_VERSION;
    }
  | {
      status: typeof GridPreferenceReadStatus.Missing;
      selector: GridPreferenceSelector;
      contractVersion: typeof GRID_PREFERENCE_CONTRACT_VERSION;
    };

export type GridPreferenceUpsertRequest = GridPreferenceSelector & {
  value: JsonObject;
  expectedRevision?: number;
};

export type GridPreferenceUpsertResponse = {
  status: typeof GridPreferenceWriteStatus.Stored;
  preference: GridPreference;
  contractVersion: typeof GRID_PREFERENCE_CONTRACT_VERSION;
  /** ISS-12552: present only on an API-key write that recorded a receipt. */
  operationReceipt?: OperationReceipt;
};

export type GridPreferenceResetRequest = GridPreferenceSelector & {
  expectedRevision?: number;
};

export type GridPreferenceResetResponse =
  | {
      status: typeof GridPreferenceResetStatus.Deleted;
      selector: GridPreferenceSelector;
      previousRevision: number;
      contractVersion: typeof GRID_PREFERENCE_CONTRACT_VERSION;
      /** ISS-12552: present only on an API-key write that recorded a receipt. */
      operationReceipt?: OperationReceipt;
    }
  | {
      status: typeof GridPreferenceResetStatus.Missing;
      selector: GridPreferenceSelector;
      contractVersion: typeof GRID_PREFERENCE_CONTRACT_VERSION;
      /** ISS-12552: present only on an API-key write that recorded a receipt. */
      operationReceipt?: OperationReceipt;
    };

export type GridPreferenceRevisionConflict = {
  code: typeof GridPreferenceErrorCode.StaleRevision;
  selector: GridPreferenceSelector;
  expectedRevision: number;
  contractVersion: typeof GRID_PREFERENCE_CONTRACT_VERSION;
  currentRevision?: number;
  current?: GridPreference;
};

export function isGridPreferenceGridKey(
  value: unknown
): value is GridPreferenceGridKey {
  return isConstValue(GridPreferenceGridKey, value);
}

export function isGridPreferenceKind(
  value: unknown
): value is GridPreferenceKind {
  return isConstValue(GridPreferenceKind, value);
}

export function isGridPreferenceScopeKey(
  value: unknown
): value is GridPreferenceScopeKey {
  return (
    isConstValue(GridPreferenceScopeKey, value) ||
    (typeof value === "string" &&
      PROJECT_GRID_PREFERENCE_SCOPE_KEY_RE.test(value))
  );
}

/** Isolate Project Artifact view preferences to one project row. */
export function projectGridPreferenceScopeKey(
  projectId: string
): ProjectGridPreferenceScopeKey {
  return `${PROJECT_GRID_PREFERENCE_SCOPE_PREFIX}${projectId}`;
}

/**
 * `approved` is reserved for the Branches approved-row projection; other grids
 * use `default` until a later adoption ticket adds an explicit scope.
 */
export function isSupportedGridPreferenceSelector(
  selector: GridPreferenceSelector
): boolean {
  if (selector.scopeKey === GridPreferenceScopeKey.Approved) {
    return selector.gridKey === GridPreferenceGridKey.Branches;
  }
  if (PROJECT_GRID_PREFERENCE_SCOPE_KEY_RE.test(selector.scopeKey)) {
    return selector.gridKey === GridPreferenceGridKey.ProjectArtifacts;
  }
  return true;
}

export const PROJECT_GRID_PREFERENCE_SCOPE_KEY_RE =
  /^project:[A-Za-z0-9_-]{1,128}$/;

function isConstValue<T extends Record<string, string>>(
  values: T,
  value: unknown
): value is T[keyof T] {
  return typeof value === "string" && Object.values(values).includes(value);
}
