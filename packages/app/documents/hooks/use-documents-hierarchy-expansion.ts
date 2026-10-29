"use client";

import { useArtifactHierarchyExpansion } from "@repo/app/shared/hooks/use-artifact-hierarchy-expansion";
import { HIERARCHY_EXPANDED_PARAM } from "@repo/app/shared/lib/hierarchy-expanded-param";

/** Keep the established Documents import and URL contract while sharing the owner. */
export const DOCUMENTS_HIERARCHY_EXPANDED_PARAM = HIERARCHY_EXPANDED_PARAM;

/** Documents adapter for the shared project-hierarchy expansion lifecycle. */
export const useDocumentsHierarchyExpansion = useArtifactHierarchyExpansion;
