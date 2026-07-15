import type {
  AgentComponentDetail,
  AgentComponentsChange,
} from "@repo/api/src/types/agent-component";
import type { AgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import { ApiError } from "@repo/app/shared/api/api-error";
import { runSource } from "../shared/run-source";
import type { DesktopApi } from "../types/desktop-api";

/**
 * Error code emitted by the local agent-components source when the data
 * retrieval fails. Kept as a module-level const (mirrors the sessions source).
 */
export const LOCAL_AGENT_COMPONENTS_SOURCE_ERROR_CODE =
  "LOCAL_AGENT_COMPONENTS_SOURCE_ERROR" as const;

/**
 * Error code emitted when a requested component slug is not found.
 */
export const LOCAL_AGENT_COMPONENTS_NOT_FOUND_CODE =
  "LOCAL_AGENT_COMPONENT_NOT_FOUND" as const;

/**
 * Error code emitted when the desktop preload does not yet expose the
 * agent-components IPC methods (`db.listAgentComponents` /
 * `db.getAgentComponentDetail`). The main-process/preload handlers land with the
 * desktop agent-components workspace route (follow-up to FEA-2923 PR2); until
 * then this source degrades to an explicit, sanitized error instead of a raw
 * `TypeError` from invoking an undefined preload method.
 */
export const LOCAL_AGENT_COMPONENTS_UNAVAILABLE_CODE =
  "LOCAL_AGENT_COMPONENTS_IPC_UNAVAILABLE" as const;

/**
 * The slice of the desktop preload API the local agent-components data source
 * needs. `onDbChanged` is optional: the live subscription is best-effort, and a
 * preload without it simply yields a source with no `subscribe`.
 */
type DesktopLocalAgentComponentsApi = Pick<DesktopApi, "db"> &
  Partial<Pick<DesktopApi, "onDbChanged">>;

/**
 * Desktop-local `AgentComponentsDataSource` (FEA-2923 / T-16.1).
 *
 * Routes the shared `@repo/app` agent-components read hooks straight to
 * `window.desktopApi.db.listAgentComponents` and
 * `window.desktopApi.db.getAgentComponentDetail` over Electron IPC — no
 * HTTP envelope and no network — and exposes the local DB's
 * `desktop:db:changed` push stream as `subscribe` so workspace views refresh
 * automatically when the local inventory changes (install/uninstall, scan).
 *
 * Error contract (mirrors `local-agent-sessions-data-source.ts`):
 * - `detail()` rejects with a 404 `ApiError` when the component is not found.
 * - Any underlying IPC failure rejects with a sanitized 500 `ApiError` so no
 *   local filesystem/SQL detail leaks to the renderer. `ApiError` also makes
 *   the shared query client skip the would-be transient-network retry.
 *
 * Plugin child-usage rollup (§1c): `listAgentComponents` in the main-process
 * handler (T-16.3 runtime wiring) computes the plugin `invocations`/`sessions`
 * totals on-read as a SUM over child component usage rows keyed by `packId`.
 * The data source itself is transport-only — the rollup lives in the IPC
 * handler (collocated with the DB), not in the renderer.
 */
export function createLocalAgentComponentsDataSource(
  desktopApi: DesktopLocalAgentComponentsApi
): AgentComponentsDataSource {
  const onDbChanged = desktopApi.onDbChanged;
  const sanitize = <T>(run: () => Promise<T>) =>
    runSource(
      run,
      "Agent components source failed.",
      LOCAL_AGENT_COMPONENTS_SOURCE_ERROR_CODE
    );

  // The agent-components IPC methods are exposed by the desktop preload only
  // once the main-process handlers land (with the desktop workspace route).
  // Guard on their presence so a build without them fails with a clear,
  // sanitized ApiError rather than an opaque "x is not a function" TypeError.
  const requireDbMethod = <
    M extends "listAgentComponents" | "getAgentComponentDetail",
  >(
    method: M
  ): NonNullable<DesktopApi["db"][M]> => {
    const fn = desktopApi.db[method];
    if (typeof fn !== "function") {
      throw new ApiError(
        "Agent components are not available on this desktop build.",
        501,
        LOCAL_AGENT_COMPONENTS_UNAVAILABLE_CODE
      );
    }
    return fn as NonNullable<DesktopApi["db"][M]>;
  };

  return {
    scope: "agent-components:local",

    list: (filters) => {
      // Resolve the method outside `sanitize` so the explicit 501 capability
      // error survives (runSource would otherwise re-wrap it as a generic 500).
      const listFn = requireDbMethod("listAgentComponents");
      return sanitize(() => listFn(filters));
    },

    detail: async (slug) => {
      const detailFn = requireDbMethod("getAgentComponentDetail");
      const data = await sanitize(() => detailFn(slug));
      if (!data) {
        throw new ApiError(
          "Agent component not found.",
          404,
          LOCAL_AGENT_COMPONENTS_NOT_FOUND_CODE
        );
      }
      // The IPC handler resolves AgentComponentDetail | null; a non-null return
      // is the full detail shape. Cast is safe: the main-process handler
      // constructs a conformant AgentComponentDetail.
      return data as AgentComponentDetail;
    },

    subscribe: onDbChanged
      ? (onChange: (change: AgentComponentsChange) => void) =>
          onDbChanged((payload) =>
            onChange(
              payload.sessionId ? { componentId: payload.sessionId } : {}
            )
          )
      : undefined,
  };
}
