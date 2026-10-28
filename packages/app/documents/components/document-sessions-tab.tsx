"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import type { DocumentSessionsResponse } from "@repo/api/src/types/document-sessions";
// Documents reuse the Branches Sessions presentation with document-scoped data.
import { BranchSessionsTimelinePanel } from "@repo/app/branches/components/detail/branch-sessions-timeline-tab";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { ListTreeIcon, RefreshCwIcon } from "lucide-react";
import { useRef } from "react";
import { useDocumentSessions } from "../hooks/use-document-sessions";
import {
  RELATED_SESSIONS_EMPTY_MESSAGE,
  RELATED_SESSIONS_ERROR_MESSAGE,
  RELATED_SESSIONS_LOADING_MESSAGE,
} from "../lib/related-sessions-labels";

export function DocumentSessionsTab({
  document,
}: Readonly<{ document: DocumentDetail }>) {
  const query = useDocumentSessions(document.id);
  return (
    <DocumentSessionsPanel
      data={query.data}
      isError={query.isError}
      isLoading={query.isLoading}
      key={document.id}
      onRetry={() => query.refetch()}
    />
  );
}

export function DocumentSessionsPanel({
  data,
  isError,
  isLoading,
  onRetry,
}: Readonly<{
  data?: DocumentSessionsResponse;
  isError: boolean;
  isLoading: boolean;
  onRetry: () => void;
}>) {
  const scrollElementRef = useRef<HTMLDivElement>(null);
  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Alert className="max-w-md" variant="error">
          <AlertDescription>
            {RELATED_SESSIONS_ERROR_MESSAGE}
            <Button
              className="mt-2"
              onClick={onRetry}
              size="sm"
              variant="outline"
            >
              <RefreshCwIcon aria-hidden="true" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!data) {
    return (
      <Skeleton
        aria-label={RELATED_SESSIONS_LOADING_MESSAGE}
        className="m-6 h-96"
        role="status"
      />
    );
  }
  if (data.trace.qualifyingSessionCount === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon={ListTreeIcon}
          size="compact"
          title={RELATED_SESSIONS_EMPTY_MESSAGE}
        />
      </div>
    );
  }
  return (
    <BranchSessionsTimelinePanel
      detail={data.detail}
      scrollElementRef={scrollElementRef}
      showBranchContext={false}
      state={isLoading ? "loading" : "ready"}
      trace={{ data: data.trace, isLoading }}
    />
  );
}
