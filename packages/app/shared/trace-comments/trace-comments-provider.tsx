"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useApiClient } from "../api/use-api-client";
import {
  createHttpTraceCommentsDataSource,
  type TraceCommentsDataSource,
} from "./trace-comments-data-source";

const TraceCommentsDataSourceContext =
  createContext<TraceCommentsDataSource | null>(null);

/** Injects a surface-specific trace-comments source, currently used by Desktop. */
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

/** Returns the injected source or the shared HTTP implementation. */
export function useTraceCommentsDataSource(): TraceCommentsDataSource {
  const injected = useContext(TraceCommentsDataSourceContext);
  const apiClient = useApiClient();
  return useMemo(
    () => injected ?? createHttpTraceCommentsDataSource(apiClient),
    [apiClient, injected]
  );
}
