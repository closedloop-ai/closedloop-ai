import type { ProjectWithDetails } from "@repo/api/src/types/project";
import type { ProjectTreeDetailsResponse } from "@repo/api/src/types/project-tree";

/** Inputs shared by the portable project list and its persisted-key remount. */
export type ProjectArtifactListProps = {
  project: ProjectWithDetails;
  teamId: string;
  tree: ProjectTreeDetailsResponse | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  onRefresh: () => Promise<ProjectTreeDetailsResponse | undefined>;
  onRequestCreate: () => void;
  hasMoreRootPages?: boolean;
  isLoadingMoreRootPages?: boolean;
  loadMoreRootPages?: () => void;
  category?: "all" | "documents" | "issues" | "plans" | "branches";
};
