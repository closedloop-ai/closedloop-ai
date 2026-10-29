import { BranchDetailTabParam } from "@repo/api/src/types/notification-routes";
import type { ArtifactDetailRouteConfig } from "@repo/app/shared/components/artifact-detail-shell/use-artifact-detail-tab-route";
import {
  ARTIFACT_DETAIL_TABS,
  type ArtifactDetailTab,
  ArtifactDetailTab as ArtifactTab,
} from "@repo/app/shared/lib/artifact-detail-tab";

/** Branch's visible shell tabs and compatibility for existing detail links. */
export const BRANCH_ARTIFACT_TABS = ARTIFACT_DETAIL_TABS;

export const BRANCH_ARTIFACT_TAB_ALIASES = {
  [BranchDetailTabParam.BranchDetails]: ArtifactTab.Artifact,
  [BranchDetailTabParam.SessionsTimeline]: ArtifactTab.Sessions,
} as const satisfies Readonly<Record<BranchDetailTabParam, ArtifactDetailTab>>;

export const BRANCH_ARTIFACT_ROUTE_CONFIG: ArtifactDetailRouteConfig<
  (typeof BRANCH_ARTIFACT_TABS)[number]
> = {
  aliases: BRANCH_ARTIFACT_TAB_ALIASES,
  tabs: BRANCH_ARTIFACT_TABS,
};
