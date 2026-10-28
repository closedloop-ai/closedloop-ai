import type { ReactNode } from "react";
import {
  type ListLoadingCopy,
  renderListLoadingBody,
} from "../../../shared/components/list-loading-body";
import type { LoadingStallPhase } from "../../../shared/lib/loading-stall-phase";
import { SESSIONS_LIST_LOADING_LABEL } from "./sessions-list-loading-labels";

/** Shared Sessions loading treatment for desktop and web list hosts. */
export function renderSessionsListLoading({
  hasData,
  isLoading,
  loadingLabel,
  quietLoadingBody,
  stallPhase,
}: {
  hasData: boolean;
  isLoading: boolean;
  loadingLabel: string | undefined;
  quietLoadingBody?: ReactNode;
  stallPhase: LoadingStallPhase;
}): ReactNode {
  return renderListLoadingBody({
    copy: SESSIONS_LIST_LOADING_COPY,
    hasData,
    isLoading,
    loadingLabel,
    quietLoadingBody,
    stallPhase,
  });
}

/** The Sessions listing's nouns for the shared loading ladder. */
export const SESSIONS_LIST_LOADING_COPY: ListLoadingCopy = {
  loadingLabel: SESSIONS_LIST_LOADING_LABEL,
};
