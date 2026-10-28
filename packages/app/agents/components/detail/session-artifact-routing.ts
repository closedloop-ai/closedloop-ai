import { SessionDetailTab } from "@repo/app/agents/components/detail/session-detail-tabs";
import type { ArtifactDetailRouteConfig } from "@repo/app/shared/components/artifact-detail-shell/use-artifact-detail-tab-route";
import {
  ARTIFACT_DETAIL_TAB_LABELS,
  type ArtifactDetailTab,
  ArtifactDetailTab as ArtifactTab,
} from "@repo/app/shared/lib/artifact-detail-tab";

/**
 * Session's visible shell tabs and compatibility for existing detail links.
 *
 * ISS-12167 (operator, 2026-10-07): a Session hides the generic Artifact tab
 * and shows the Sessions one, singular — the record IS the session, so there is
 * no separate artifact canvas to sit beside it. The session's trace, properties
 * and timeline are therefore the SESSIONS tab's body here, which is why the
 * `artifact` key is absent below and aliased onto `sessions` instead.
 */
export const SESSION_ARTIFACT_TABS = [
  ArtifactTab.Sessions,
  ArtifactTab.Details,
  ArtifactTab.Activity,
] as const;

/**
 * What Session detail calls each of its tabs: the Sessions tab reads
 * "Session", the operator's word (2026-10-07), because the page holds exactly
 * one. Details and Activity point at the shell's own approved strings rather
 * than copying them, and the `Record` makes a new Session tab fail typecheck
 * here until it is labelled. Every other artifact type passes no override and
 * keeps the plural "Sessions".
 */
export const SESSION_ARTIFACT_TAB_LABELS = {
  [ArtifactTab.Sessions]: "Session",
  [ArtifactTab.Details]: ARTIFACT_DETAIL_TAB_LABELS[ArtifactTab.Details],
  [ArtifactTab.Activity]: ARTIFACT_DETAIL_TAB_LABELS[ArtifactTab.Activity],
} as const satisfies Readonly<Record<SessionArtifactTab, string>>;

/**
 * `artifact` joins the legacy nested values as a compatibility alias: it was
 * this page's canonical tab until ISS-12167 moved the same body onto
 * `sessions`, so a shared or bookmarked `?tab=artifact` link keeps landing on
 * the body it named. The route hook canonicalizes it on the next write.
 */
export const SESSION_ARTIFACT_TAB_ALIASES = {
  [SessionDetailTab.Overview]: ArtifactTab.Sessions,
  [SessionDetailTab.Trace]: ArtifactTab.Sessions,
  [ArtifactTab.Artifact]: ArtifactTab.Sessions,
} as const satisfies Readonly<
  Record<SessionDetailTab | typeof ArtifactTab.Artifact, ArtifactDetailTab>
>;

export const SESSION_ARTIFACT_ROUTE_CONFIG: ArtifactDetailRouteConfig<
  (typeof SESSION_ARTIFACT_TABS)[number]
> = {
  aliases: SESSION_ARTIFACT_TAB_ALIASES,
  tabs: SESSION_ARTIFACT_TABS,
};

export type SessionArtifactTab = (typeof SESSION_ARTIFACT_TABS)[number];

/**
 * Session's label for any tab key, including one it does not configure, so a
 * caller covering several artifact types reads the rename from here instead of
 * re-deriving which tab Session renames.
 */
export function sessionArtifactTabLabel(tab: ArtifactDetailTab): string {
  const labels: Readonly<Partial<Record<ArtifactDetailTab, string>>> =
    SESSION_ARTIFACT_TAB_LABELS;
  return labels[tab] ?? ARTIFACT_DETAIL_TAB_LABELS[tab];
}
