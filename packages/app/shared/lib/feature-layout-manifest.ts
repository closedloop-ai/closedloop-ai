import {
  ShellNavigationRouteId,
  type ShellNavigationRouteId as ShellNavigationRouteIdType,
} from "./shell-navigation-contract";

/**
 * ISS-11262: where every product feature's code lives, layer by layer.
 *
 * A feature that ships on both shells spans six or more top-level locations
 * (web route, shared UI slice, desktop renderer, desktop main, API, contracts,
 * pure logic), and its NAME drifts between them: Sessions is `sessions` on the
 * web route, `packages/app/agents` in shared UI, `agent-sessions` in the API,
 * and `main/session` plus `agent-sync` in desktop main. Before this manifest
 * that map existed only in people's heads, so an agent asked to change a
 * feature had to rediscover it, and a new file landed wherever the nearest
 * example happened to sit.
 *
 * This module is the single statement of that map. It is pure data (no React,
 * no Node) so every consumer can import it:
 *   - `scripts/lint/rules/feature-layout-manifest.ts` checks every declared
 *     location still exists and that new feature-named files land inside
 *     their feature's declared locations;
 *   - the `control` skill's FEATURE_MAP generator reads it to describe each
 *     feature's code surface;
 *   - agents resolve "the sessions feature" to concrete paths from it.
 *
 * It does not restate route reachability or mastery. Those stay owned by
 * `shell-navigation-contract.ts` and `complete-surface-registry.ts`; an entry
 * here only names the shell route ids it serves.
 *
 * A location is a repo-relative POSIX PATH PREFIX: a directory when it ends in
 * `/`, otherwise a file-name prefix inside a layer-organized directory (for
 * example `apps/desktop/src/main/database/branch-`, because desktop main keeps
 * every feature's SQLite reads in one directory).
 */

export const FeatureId = {
  Branches: "branches",
  Sessions: "sessions",
  Agents: "agents",
  Packs: "packs",
  Documents: "documents",
  Inbox: "inbox",
  MyTasks: "my-tasks",
} as const;
export type FeatureId = (typeof FeatureId)[keyof typeof FeatureId];

export const FeatureLayer = {
  /** Next app router segments under `apps/app/app`. */
  WebRoute: "web-route",
  /** Web-only host composition outside the route segment. */
  WebHost: "web-host",
  /** The shared UI slice in `packages/app`. */
  SharedUi: "shared-ui",
  /** Desktop renderer views, hosts and local data sources. */
  DesktopRenderer: "desktop-renderer",
  /** Desktop main process: IPC handlers, SQLite reads, sync lanes. */
  DesktopMain: "desktop-main",
  /** Modules under `apps/desktop/src/shared` imported by main and renderer. */
  DesktopShared: "desktop-shared",
  /** Cloud API routes, services and app-local helpers in `apps/api`. */
  Api: "api",
  /** Wire contracts in `packages/api/src`. */
  Contracts: "contracts",
  /** Pure projections in `packages/lib`. */
  PureLogic: "pure-logic",
} as const;
export type FeatureLayer = (typeof FeatureLayer)[keyof typeof FeatureLayer];

/** Every layer, in the order a reader traces a request from UI to storage. */
export const FEATURE_LAYERS: readonly FeatureLayer[] = [
  FeatureLayer.WebRoute,
  FeatureLayer.WebHost,
  FeatureLayer.SharedUi,
  FeatureLayer.DesktopRenderer,
  FeatureLayer.DesktopShared,
  FeatureLayer.DesktopMain,
  FeatureLayer.Api,
  FeatureLayer.Contracts,
  FeatureLayer.PureLogic,
];

export const FeatureShells = {
  WebAndDesktop: "web-and-desktop",
  WebOnly: "web-only",
} as const;
export type FeatureShells = (typeof FeatureShells)[keyof typeof FeatureShells];

export type FeatureLayoutEntry = {
  readonly id: FeatureId;
  readonly label: string;
  readonly shells: FeatureShells;
  /** Shell navigation routes this feature serves. */
  readonly routeIds: readonly ShellNavigationRouteIdType[];
  /**
   * Other names the feature goes by, per layer. Informational: it is how a
   * reader maps "packs" to `apps/api/app/catalog`.
   */
  readonly aliases: readonly string[];
  /**
   * File-name prefixes that mark a source file as belonging to this feature.
   * A non-test source file whose base name starts with one of these must sit
   * inside one of {@link locations}.
   */
  readonly filePrefixes: readonly string[];
  /** Declared locations per layer. An absent layer has no code there. */
  readonly locations: Readonly<
    Partial<Record<FeatureLayer, readonly string[]>>
  >;
};

const ORG_ROUTE = "apps/app/app/(authenticated)/[orgSlug]";

export const FEATURE_LAYOUT_MANIFEST: Readonly<
  Record<FeatureId, FeatureLayoutEntry>
> = {
  [FeatureId.Branches]: {
    id: FeatureId.Branches,
    label: "Branches",
    shells: FeatureShells.WebAndDesktop,
    routeIds: [ShellNavigationRouteId.Branches],
    aliases: ["branch", "pull-request"],
    filePrefixes: ["branch-", "branches-"],
    locations: {
      [FeatureLayer.WebRoute]: [
        `${ORG_ROUTE}/branches/`,
        `${ORG_ROUTE}/build/`,
      ],
      [FeatureLayer.WebHost]: ["apps/app/lib/branches/"],
      [FeatureLayer.SharedUi]: ["packages/app/branches/"],
      [FeatureLayer.DesktopRenderer]: [
        "apps/desktop/src/renderer/components/branches/",
        "apps/desktop/src/renderer/shared-branches/",
      ],
      [FeatureLayer.DesktopShared]: [
        "apps/desktop/src/shared/shared-branches-contract",
      ],
      [FeatureLayer.DesktopMain]: [
        "apps/desktop/src/main/branch/",
        "apps/desktop/src/main/database/branch-",
        "apps/desktop/src/main/enrichment/branch-",
        "apps/desktop/src/main/telemetry/branch-",
      ],
      [FeatureLayer.Api]: [
        "apps/api/app/branches/",
        "apps/api/lib/branch",
        "apps/api/app/agent-sessions/service/artifact-links/branch-",
        "apps/api/app/webhooks/github/handlers/branch-",
      ],
      [FeatureLayer.Contracts]: [
        "packages/api/src/types/branch",
        "packages/api/src/branch-",
      ],
      [FeatureLayer.PureLogic]: ["packages/lib/branches/"],
    },
  },
  [FeatureId.Sessions]: {
    id: FeatureId.Sessions,
    label: "Sessions",
    shells: FeatureShells.WebAndDesktop,
    routeIds: [ShellNavigationRouteId.Sessions],
    aliases: ["agent-sessions", "agents (packages/app slice)", "session"],
    filePrefixes: ["session-", "sessions-", "agent-session"],
    locations: {
      [FeatureLayer.WebRoute]: [
        `${ORG_ROUTE}/sessions/`,
        "apps/app/app/(authenticated)/sessions/",
        "apps/app/app/(authenticated)/sessions-route-state",
      ],
      [FeatureLayer.WebHost]: ["apps/app/components/agent-sessions/"],
      [FeatureLayer.SharedUi]: [
        "packages/app/agents/",
        "packages/app/shared/counts/session-count-",
        "packages/app/shared/lib/sessions-scroll-contract",
        "packages/app/shared/components/generic-artifact-surface/preview/components/experimental/session/",
      ],
      [FeatureLayer.DesktopRenderer]: [
        "apps/desktop/src/renderer/components/sessions/",
        "apps/desktop/src/renderer/shared-agent-sessions/",
      ],
      [FeatureLayer.DesktopShared]: [
        "apps/desktop/src/shared/shared-agent-sessions-contract",
        "apps/desktop/src/shared/session-",
        "apps/desktop/src/shared/local-session-source-status",
      ],
      [FeatureLayer.DesktopMain]: [
        "apps/desktop/src/main/session/",
        "apps/desktop/src/main/session-mesh/",
        "apps/desktop/src/main/agent-sync/",
        "apps/desktop/src/main/transcript-sync/",
        "apps/desktop/src/main/database/session",
        "apps/desktop/src/main/dashboard/agent-dashboard-session-",
        "apps/desktop/src/main/collectors/engine/session-",
        "apps/desktop/src/main/database/agent-session",
        "apps/desktop/src/main/database/db-host/session-",
      ],
      [FeatureLayer.Api]: [
        "apps/api/app/agent-sessions/",
        "apps/api/lib/agent-session",
        "apps/api/lib/desktop-agent-session",
        "apps/api/app/artifacts/session-displayed-status-",
        "apps/api/lib/observability/session-ingestion-",
        "apps/api/lib/session-pr-links",
      ],
      [FeatureLayer.Contracts]: [
        "packages/api/src/types/agent-session",
        "packages/api/src/types/session",
        "packages/api/src/agent-session-",
        "packages/api/src/session-",
        "packages/api/src/utils/session-",
      ],
      [FeatureLayer.PureLogic]: [
        "packages/lib/sessions/",
        "packages/lib/agent-sessions/",
        "packages/lib/session-trace/",
        // ISS-12552: the parent plus sidecar tool-use stream, moved here from
        // the desktop collectors so claim extraction shares it.
        "packages/lib/harness/session-",
      ],
    },
  },
  [FeatureId.Agents]: {
    id: FeatureId.Agents,
    label: "Agents",
    shells: FeatureShells.WebAndDesktop,
    routeIds: [ShellNavigationRouteId.Agents],
    aliases: ["agent-components", "components"],
    filePrefixes: ["agent-component"],
    locations: {
      [FeatureLayer.WebRoute]: [`${ORG_ROUTE}/agents/`],
      [FeatureLayer.SharedUi]: ["packages/app/agents/"],
      [FeatureLayer.DesktopRenderer]: [
        "apps/desktop/src/renderer/components/agents/",
        "apps/desktop/src/renderer/shared-agent-sessions/local-agent-components-data-source",
      ],
      [FeatureLayer.DesktopShared]: [
        "apps/desktop/src/shared/shared-agent-components-contract",
      ],
      [FeatureLayer.DesktopMain]: [
        "apps/desktop/src/main/agent-sync/agent-component",
        "apps/desktop/src/main/dashboard/agent-component",
        "apps/desktop/src/main/dashboard/shared-agent-components-",
        "apps/desktop/src/main/database/component",
      ],
      [FeatureLayer.Api]: ["apps/api/app/agent-components/"],
      [FeatureLayer.Contracts]: [
        "packages/api/src/types/agent-component",
        "packages/api/src/agent-component-",
        "packages/api/src/utils/agent-component-",
      ],
    },
  },
  [FeatureId.Packs]: {
    id: FeatureId.Packs,
    label: "Packs",
    shells: FeatureShells.WebAndDesktop,
    routeIds: [ShellNavigationRouteId.Packs],
    aliases: ["catalog (api)", "distributions (api)", "CatalogItem (db)"],
    filePrefixes: ["pack-", "packs-", "catalog-", "distribution"],
    locations: {
      [FeatureLayer.WebRoute]: [
        `${ORG_ROUTE}/packs/`,
        `${ORG_ROUTE}/admin/catalog/`,
      ],
      [FeatureLayer.SharedUi]: ["packages/app/packs/"],
      [FeatureLayer.DesktopRenderer]: [
        "apps/desktop/src/renderer/components/packs/",
      ],
      [FeatureLayer.DesktopShared]: [
        "apps/desktop/src/shared/pack-",
        "apps/desktop/src/shared/normalize-pack-id",
        "apps/desktop/src/shared/distributions-channel",
      ],
      [FeatureLayer.DesktopMain]: [
        "apps/desktop/src/main/packs/",
        "apps/desktop/src/main/dashboard/agent-dashboard-catalog-pack-",
        "apps/desktop/src/main/telemetry/distribution-",
      ],
      [FeatureLayer.Api]: [
        "apps/api/app/catalog/",
        "apps/api/app/distributions/",
        "apps/api/app/agent-components/pack",
      ],
      [FeatureLayer.Contracts]: [
        "packages/api/src/types/distribution",
        "packages/api/src/types/member-pack",
        "packages/api/src/catalog-",
      ],
    },
  },
  [FeatureId.Documents]: {
    id: FeatureId.Documents,
    label: "Documents",
    shells: FeatureShells.WebAndDesktop,
    routeIds: [
      ShellNavigationRouteId.Documents,
      ShellNavigationRouteId.Issues,
      ShellNavigationRouteId.Plans,
    ],
    aliases: ["issues", "prds", "implementation-plans"],
    filePrefixes: ["document-", "documents-"],
    locations: {
      [FeatureLayer.WebRoute]: [
        `${ORG_ROUTE}/documents/`,
        `${ORG_ROUTE}/issues/`,
        `${ORG_ROUTE}/teams/[teamId]/projects/[projectId]/components/document`,
      ],
      [FeatureLayer.SharedUi]: ["packages/app/documents/"],
      [FeatureLayer.DesktopRenderer]: [
        "apps/desktop/src/renderer/components/documents/",
      ],
      [FeatureLayer.Api]: ["apps/api/app/documents/"],
      [FeatureLayer.DesktopMain]: ["apps/desktop/src/main/ipc/document-"],
      [FeatureLayer.Contracts]: ["packages/api/src/types/document"],
    },
  },
  [FeatureId.Inbox]: {
    id: FeatureId.Inbox,
    label: "Inbox",
    shells: FeatureShells.WebOnly,
    routeIds: [ShellNavigationRouteId.Inbox],
    aliases: [],
    filePrefixes: ["inbox-"],
    locations: {
      [FeatureLayer.WebRoute]: [`${ORG_ROUTE}/inbox/`],
      [FeatureLayer.WebHost]: [
        "apps/app/app/(authenticated)/components/inbox-",
      ],
      [FeatureLayer.SharedUi]: ["packages/app/inbox/"],
    },
  },
  [FeatureId.MyTasks]: {
    id: FeatureId.MyTasks,
    label: "My Tasks",
    shells: FeatureShells.WebOnly,
    routeIds: [ShellNavigationRouteId.MyTasks],
    aliases: [],
    filePrefixes: ["my-task"],
    locations: {
      [FeatureLayer.WebRoute]: [`${ORG_ROUTE}/my-tasks/`],
      [FeatureLayer.SharedUi]: ["packages/app/my-tasks/"],
    },
  },
};

export const FEATURE_IDS: readonly FeatureId[] = Object.values(FeatureId);

/** The declared locations of one feature in one layer (empty when none). */
export function featureLocations(
  id: FeatureId,
  layer: FeatureLayer
): readonly string[] {
  return FEATURE_LAYOUT_MANIFEST[id].locations[layer] ?? [];
}

/** Every declared location of one feature, across all layers. */
export function allFeatureLocations(id: FeatureId): readonly string[] {
  return FEATURE_LAYERS.flatMap((layer) => featureLocations(id, layer));
}

/**
 * The features whose declared locations contain `path` (repo-relative POSIX).
 * A path can belong to more than one feature: `packages/app/agents/` holds
 * both Sessions and Agents.
 */
export function featuresOwningPath(path: string): readonly FeatureId[] {
  return FEATURE_IDS.filter((id) =>
    allFeatureLocations(id).some((location) => path.startsWith(location))
  );
}
