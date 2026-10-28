"use client";

import type { FindDocumentsOptions } from "@repo/api/src/types/document";
import type { DocumentCostWindow } from "@repo/api/src/types/document-costs";
import { DOCUMENT_SUMMARY_MAX_QUERY_LENGTH } from "@repo/api/src/types/document-metric-scope";
import { Status } from "@repo/api/src/types/result";
import { useDocumentsCosts } from "@repo/app/documents/hooks/use-documents-costs";
import { useDocumentsSummary } from "@repo/app/documents/hooks/use-documents-summary";
import { buildDocumentListSearchParams } from "@repo/app/documents/lib/document-list-search-params";
import { ApiError } from "@repo/app/shared/api/api-error";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import {
  type ArtifactSummaryScope,
  artifactCostScope,
  cohortSummaryScope,
} from "./artifact-summary-scope";

/**
 * ISS-12600: the cards' summary and cost reads over the server scope, falling
 * back to the complete-cohort id read (`artifactIds`, the origin/main path) when
 * the server refuses that scope. A refusal is a response-backed 400 (a refused
 * custom-field facet, or an older API whose `.strict()` validators do not know
 * the new keys), 414 or 431; a scope whose query string would exceed
 * {@link DOCUMENT_SUMMARY_MAX_QUERY_LENGTH} takes the cohort read without asking.
 *
 * Each read's refusal is remembered per scope (on the QueryClient), and that
 * server read stays off for a remembered scope, so an invalidation or remount never
 * re-sends it: TanStack clears a data-less query's error when it refetches, so
 * deriving the fallback from the live error alone would blank the cards until
 * the same refusal came back. The server read is only skipped while a cohort
 * fallback exists to take its place.
 */
export function useArtifactSummaryReads({
  scope,
  searchParams,
  cohortIds,
  documentIds,
  window,
  summaryEnabled,
  costsEnabled,
}: {
  scope: ArtifactSummaryScope;
  searchParams: FindDocumentsOptions;
  /** The complete matching ids, when the list has read them all. */
  cohortIds: readonly string[] | undefined;
  documentIds: readonly string[];
  window: DocumentCostWindow;
  summaryEnabled: boolean;
  costsEnabled: boolean;
}) {
  const queryClient = useQueryClient();
  const serverScoped =
    scope.canSummarize && scope.params.artifactIds === undefined;
  const scopeKey = JSON.stringify(scope.params);
  const canFallBack = serverScoped && cohortIds !== undefined;
  const refused = refusedScopes(queryClient);
  const overLength =
    buildDocumentListSearchParams(scope.params).length >
    DOCUMENT_SUMMARY_MAX_QUERY_LENGTH;
  const summaryKey = refusalKey(ScopeRead.Summary, scopeKey);
  const costsKey = refusalKey(ScopeRead.Costs, scopeKey);
  const summaryRemembered =
    canFallBack && (refused.has(summaryKey) || overLength);
  const costsRemembered = canFallBack && (refused.has(costsKey) || overLength);
  const serverSummary = useDocumentsSummary(scope.params, {
    enabled: summaryEnabled && !summaryRemembered,
  });
  const serverCosts = useDocumentsCosts(
    documentIds,
    window,
    { enabled: costsEnabled && !costsRemembered },
    artifactCostScope(scope)
  );
  // Each read falls back on its own refusal, so a refused cost scope keeps
  // the server summary it already has.
  const summaryRefusedNow = canFallBack && isScopeRefusal(serverSummary.error);
  const costsRefusedNow = canFallBack && isScopeRefusal(serverCosts.error);
  useEffect(() => {
    if (summaryRefusedNow) {
      rememberRefusal(queryClient, summaryKey);
    }
  }, [queryClient, summaryRefusedNow, summaryKey]);
  useEffect(() => {
    if (costsRefusedNow) {
      rememberRefusal(queryClient, costsKey);
    }
  }, [queryClient, costsRefusedNow, costsKey]);
  const summaryFallBack = summaryRemembered || summaryRefusedNow;
  const costsFallBack = costsRemembered || costsRefusedNow;
  const cohort = useMemo(
    () =>
      (summaryFallBack || costsFallBack) && cohortIds
        ? cohortSummaryScope(searchParams, cohortIds)
        : undefined,
    [summaryFallBack, costsFallBack, cohortIds, searchParams]
  );
  const cohortSummary = useDocumentsSummary(cohort?.params ?? {}, {
    enabled: cohort !== undefined && summaryFallBack && summaryEnabled,
  });
  const cohortCosts = useDocumentsCosts(
    documentIds,
    window,
    { enabled: cohort !== undefined && costsFallBack && costsEnabled },
    undefined
  );
  const summaryCohort = summaryFallBack ? cohort : undefined;
  return {
    scope: summaryCohort ?? scope,
    summary: summaryCohort ? cohortSummary : serverSummary,
    costs: cohort && costsFallBack ? cohortCosts : serverCosts,
  };
}

function isScopeRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    Object.values(ScopeRefusalStatus).some((status) => status === error.status)
  );
}

/** Response statuses that refuse the scope itself rather than fail the read. */
const ScopeRefusalStatus = {
  BadRequest: Status.BadRequest,
  UriTooLong: 414,
  RequestHeaderFieldsTooLarge: 431,
} as const;

/** Bounds the per-client memo; the oldest refusal is forgotten first. */
const REFUSED_SCOPE_MEMO_LIMIT = 50;

const refusedScopesByClient = new WeakMap<QueryClient, Set<string>>();

function refusedScopes(queryClient: QueryClient): Set<string> {
  let scopes = refusedScopesByClient.get(queryClient);
  if (!scopes) {
    scopes = new Set();
    refusedScopesByClient.set(queryClient, scopes);
  }
  return scopes;
}

function rememberRefusal(queryClient: QueryClient, scopeKey: string): void {
  const scopes = refusedScopes(queryClient);
  scopes.delete(scopeKey);
  scopes.add(scopeKey);
  if (scopes.size > REFUSED_SCOPE_MEMO_LIMIT) {
    const oldest = scopes.values().next().value;
    if (oldest !== undefined) {
      scopes.delete(oldest);
    }
  }
}

/** The read a remembered refusal belongs to. */
const ScopeRead = {
  Summary: "summary",
  Costs: "costs",
} as const;
type ScopeRead = (typeof ScopeRead)[keyof typeof ScopeRead];

function refusalKey(read: ScopeRead, scopeKey: string): string {
  return `${read}:${scopeKey}`;
}
