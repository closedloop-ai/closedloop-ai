"use client";

import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { DOCUMENTS_UNIVERSAL_LIST_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { ReactNode } from "react";
import {
  DocumentsCreateAction,
  DocumentsCreateProvider,
} from "./documents-create-action";
import { DocumentsIndexView } from "./documents-index-view";
import { DocumentsUniversalIndexView } from "./documents-universal-index-view";

/** Hosts own their header; the reads, controls, and state remain shared. */
export function DocumentsIndexSurface({
  renderHeader,
}: Readonly<{ renderHeader: (action: ReactNode) => ReactNode }>) {
  const universalListEnabled = useFeatureFlagEnabled(
    DOCUMENTS_UNIVERSAL_LIST_FEATURE_FLAG_KEY
  );
  if (universalListEnabled) {
    return (
      <DocumentsCreateProvider>
        <div className="flex min-h-0 flex-1 flex-col">
          {renderHeader(<DocumentsCreateAction label="Add document" />)}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <DocumentsUniversalIndexView />
          </div>
        </div>
      </DocumentsCreateProvider>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {renderHeader(<DocumentsCreateAction />)}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <DocumentsIndexView />
      </div>
    </div>
  );
}
