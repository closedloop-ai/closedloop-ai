"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useApiClient } from "../../shared/api/use-api-client";
import {
  createHttpTraceCommentsDataSource,
  type TraceCommentsDataSource,
} from "./trace-comments-data-source";

const TraceCommentsDataSourceContext =
  createContext<TraceCommentsDataSource | null>(null);

/** Inject a non-HTTP trace-comments data source, currently used by desktop. */
export function TraceCommentsDataSourceProvider({
  dataSource,
  children,
}: {
  dataSource: TraceCommentsDataSource;
  children?: ReactNode;
}) {
  return (
    <TraceCommentsDataSourceContext.Provider value={dataSource}>
      {children}
    </TraceCommentsDataSourceContext.Provider>
  );
}

export function useTraceCommentsDataSource(): TraceCommentsDataSource {
  const injected = useContext(TraceCommentsDataSourceContext);
  const apiClient = useApiClient();
  return useMemo(
    () => injected ?? createHttpTraceCommentsDataSource(apiClient),
    [apiClient, injected]
  );
}
