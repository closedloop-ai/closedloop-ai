import type {
  AgentComponentDetail,
  AgentComponentsChange,
} from "@repo/api/src/types/agent-component";
import { AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS } from "@repo/api/src/types/agent-component";
import type { AgentComponentPageDataRequest } from "@repo/api/src/utils/agent-component-page-data";
import type { AgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import { parseAgentComponentFrequency } from "@repo/app/agents/data-source/agent-components-data-source";
import { ApiError } from "@repo/app/shared/api/api-error";
import { SHARED_AGENT_COMPONENTS_TRANSIENT_ERROR_CODE } from "../../shared/shared-agent-components-contract";
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
 * needs. Every member is optional because this is a preload trust boundary, not
 * an in-process value: `db` is absent on a preload that has not wired the DB
 * namespace, and `onDbChanged` is absent when the best-effort live subscription
 * is unavailable, which simply yields a source with no `subscribe`.
 */
type DesktopLocalAgentComponentsApi = Partial<
  Pick<DesktopApi, "db" | "onDbChanged">
>;

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
  // ISS-6822: probed at construction, so it must tolerate a preload that has not
  // wired the `db` namespace at all — this factory runs for EVERY desktop app-core
  // mount, not just the Agents route, and a throw here takes the whole stack down.
  const pageDataFn = desktopApi.db?.getAgentComponentsPageData;
  // ISS-10467/ISS-10468: probed at construction like `pageData` above, and for
  // the same reason — this factory runs for EVERY desktop app-core mount, so it
  // must tolerate a preload that never wired the `db` namespace at all.
  const versionUsageFn = desktopApi.db?.getAgentComponentVersionUsage;
  const sanitize = <T>(run: () => Promise<T>) =>
    runSource(
      run,
      "Agent components source failed.",
      LOCAL_AGENT_COMPONENTS_SOURCE_ERROR_CODE,
      SHARED_AGENT_COMPONENTS_TRANSIENT_ERROR_CODE
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
    const fn = desktopApi.db?.[method];
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
    ...(typeof desktopApi.db?.getAgentComponentFrequency === "function"
      ? {
          frequency: async (slug: string, windowDays: number) => {
            const read = desktopApi.db?.getAgentComponentFrequency;
            if (!read) {
              throw new ApiError(
                "Agent components are not available on this desktop build.",
                501,
                LOCAL_AGENT_COMPONENTS_UNAVAILABLE_CODE
              );
            }
            const result = await sanitize(() => read(slug, windowDays));
            if (!result) {
              throw new ApiError(
                "Agent component not found.",
                404,
                LOCAL_AGENT_COMPONENTS_NOT_FOUND_CODE
              );
            }
            return parseAgentComponentFrequency(result);
          },
        }
      : {}),

    // ISS-6888: TRUE, and traced rather than assumed. FEA-3196 wired the window
    // end to end on this path — `list` below forwards the whole filters object
    // over IPC unchanged, `coerceAgentComponentFilters` keeps `startDate`/
    // `endDate`, and `toUsageWindow` puts both into every usage lane's SQL, so a
    // bounded read returns a genuinely different population from an unbounded
    // one. The declaration says what this source DOES; whether the shared list is
    // yet allowed to act on it is a rollout question, answered one level up by
    // `DesktopAgentComponentsViewSource`.
    honorsDateWindow: true,

    // ISS-11170: an `AbortSignal` cannot cross IPC and this preload exposes no
    // cancel bridge, so an abort would only discard a read that still runs and
    // cost a second one on remount (ISS-9741).
    cancelsInFlightReads: false,

    list: (filters) => {
      // Resolve the method outside `sanitize` so the explicit 501 capability
      // error survives (runSource would otherwise re-wrap it as a generic 500).
      const listFn = requireDbMethod("listAgentComponents");
      return sanitize(() => listFn(filters));
    },

    // ISS-6822: the bounded page-data read, wired ONLY when this build's preload
    // exposes the channel. An older preload has no `getAgentComponentsPageData`,
    // so the port's optional `pageData` stays absent and the shared Agents list
    // keeps reading through `list` — the compatibility window the ticket asks
    // for, expressed as a capability probe rather than a version check.
    ...(typeof pageDataFn === "function"
      ? {
          pageData: (request: AgentComponentPageDataRequest) =>
            sanitize(() => pageDataFn(request)),
        }
      : {}),

    // ISS-10467/ISS-10468: the per-content-version usage drill-down, wired ONLY
    // when this build's preload exposes the channel. An older preload leaves the
    // port's optional `versionUsage` absent, and the shared panel renders its
    // explicit "this source cannot scope usage by version" state — a capability
    // answer, never a fabricated zero.
    ...(typeof versionUsageFn === "function"
      ? {
          versionUsage: async (
            slug: string,
            versionHashes: readonly string[]
          ) => {
            const data = await sanitize(() =>
              versionUsageFn(slug, versionHashes)
            );
            if (!data) {
              throw new ApiError(
                "Agent component not found.",
                404,
                LOCAL_AGENT_COMPONENTS_NOT_FOUND_CODE
              );
            }
            return data;
          },
        }
      : {}),

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
      const detail = data as AgentComponentDetail;
      return {
        ...detail,
        sessionsTab: detail.sessionsTab.slice(
          0,
          AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
        ),
        ...(detail.sessionsTab.length >
        AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
          ? {
              sessionsTabNextCursor: String(
                AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
              ),
            }
          : {}),
      };
    },
    sessionPage: async (slug, cursor) => {
      const offset = Number(cursor);
      if (
        !(
          LOCAL_PAGE_CURSOR_PATTERN.test(cursor) && Number.isSafeInteger(offset)
        ) ||
        offset >
          Number.MAX_SAFE_INTEGER - AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
      ) {
        throw new ApiError("Invalid cursor", 400);
      }
      const detailFn = requireDbMethod("getAgentComponentDetail");
      const detail = await sanitize(() => detailFn(slug));
      if (!detail) {
        throw new ApiError(
          "Agent component not found.",
          404,
          LOCAL_AGENT_COMPONENTS_NOT_FOUND_CODE
        );
      }
      const end = offset + AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS;
      return {
        items: detail.sessionsTab.slice(offset, end),
        total: detail.sessions,
        nextCursor: end < detail.sessionsTab.length ? String(end) : null,
      };
    },

    // ISS-6882: `desktop:db:changed` carries `{ sessionId? }` — an agent-SESSION
    // id, which is never a component identity. Forwarding it as `componentId`
    // announced a scoped change for a component that does not exist, so the live
    // bridge narrowed to a detail key nothing is registered under and left every
    // open component detail stale. A local DB mutation says only "the inventory
    // moved", so every change is BROAD here, exactly as the local branches
    // source maps the same payload.
    subscribe: onDbChanged
      ? (onChange: (change: AgentComponentsChange) => void) =>
          onDbChanged(() => onChange({}))
      : undefined,
  };
}

/**
 * ISS-6888 — the local source with its date-window declaration WITHHELD.
 *
 * The pre-rollout shape of the source, for the closed side of the
 * `agents-local-date-window` gate. It withholds a capability and can never grant
 * one: `honorsDateWindow` is forced to `false` outright, so calling it on a
 * source that genuinely ignores the window is a no-op rather than a promotion,
 * and the shared list keeps suppressing the preceding-window read rather than
 * computing a fabricated 0% baseline.
 *
 * Only the declaration changes. `list`, `detail`, `pageData`, and `subscribe`
 * ride through untouched — a gate that also dropped the live-refresh bridge or
 * the bounded read would take far more from a flag-off desktop user than the one
 * comparison it is meant to hold back.
 *
 * This is the whole-shape half of a flag branch whose OTHER half is the source
 * verbatim; the caller picks between the two so the boolean never crosses this
 * boundary (`scripts/lint/rules/no-threaded-feature-flag.ts`). It applies to the
 * LOCAL source alone, deliberately — the HTTP source has served both
 * window-relative reads since FEA-3178, so gating inside the shared component
 * would have withdrawn a shipped web capability for a desktop rollout.
 */
export function withLocalDateWindowWithheld(
  source: AgentComponentsDataSource
): AgentComponentsDataSource {
  return { ...source, honorsDateWindow: false };
}

const LOCAL_PAGE_CURSOR_PATTERN = /^\d+$/;
