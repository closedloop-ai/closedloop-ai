"use client";

import { useCallback, useState } from "react";
import { ApiError } from "../../shared/api/api-error";
import { useApiClient } from "../../shared/api/use-api-client";
import {
  type AgentSessionQueryFilters,
  sessionsExportPath,
} from "../data-source/agent-sessions-data-source";

/**
 * FEA-4217 — download the Sessions CSV for the view currently on screen.
 *
 * A plain `<a href>` cannot do this. `GET /agent-sessions/export` is served by
 * `apps/api`, a different origin from both shells, and it authenticates on the
 * `Authorization` bearer the API client attaches — an anchor would send no token
 * and 401. So the bytes are fetched through the same authenticated client every
 * other read uses and handed to the browser as a blob.
 *
 * Shared by web and desktop rather than written into either shell: the filters
 * that scope the export are the ones already in the toolbar, and two copies of
 * this would be two chances for one surface to export a different population
 * than it is showing.
 */
export const SessionsExportFailure = {
  /** Worth another click — a network blip, a timeout, a 5xx. */
  Retryable: "retryable",
  /**
   * Retrying cannot help: the team scope was denied (`forbiddenResponse`) or the
   * strict export schema rejected the query. Kept apart from
   * {@link SessionsExportFailure.Retryable} because telling a reader denied by
   * RBAC to "try again" sends them at an action that can never succeed.
   */
  Permanent: "permanent",
} as const;
export type SessionsExportFailure =
  (typeof SessionsExportFailure)[keyof typeof SessionsExportFailure];

export function useSessionsCsvExport(filters: AgentSessionQueryFilters): {
  exportCsv: () => void;
  isExporting: boolean;
  /** How the last attempt failed, or null when it did not. */
  exportFailure: SessionsExportFailure | null;
} {
  const api = useApiClient();
  const [isExporting, setIsExporting] = useState(false);
  const [exportFailure, setExportFailure] =
    useState<SessionsExportFailure | null>(null);

  const exportCsv = useCallback(() => {
    if (isExporting) {
      return;
    }
    setIsExporting(true);
    setExportFailure(null);
    api
      .getText(sessionsExportPath(filters))
      .then((csv) => {
        downloadCsv(csv, buildExportFileName(new Date()));
      })
      .catch((error: unknown) => {
        // Surfaced to the reader, never swallowed: a download that silently does
        // nothing is indistinguishable from one the browser blocked. No client
        // log — `no-client-debug-logging`.
        setExportFailure(classifyExportFailure(error));
      })
      .finally(() => setIsExporting(false));
  }, [api, filters, isExporting]);

  return { exportCsv, exportFailure, isExporting };
}

/**
 * Whether another click could plausibly succeed.
 *
 * A 4xx from this route is the server declining THIS request — the team scope
 * was denied, or the strict `baseAgentSessionQuerySchema` rejected the query —
 * and the same click will be declined again. Everything else (a 5xx, a timeout,
 * a transport failure, which `useApiClient` surfaces as status 0) is worth
 * retrying, so an unrecognized error degrades to retryable rather than telling
 * the reader their export is impossible.
 */
function classifyExportFailure(error: unknown): SessionsExportFailure {
  if (error instanceof ApiError && error.isClientError()) {
    return SessionsExportFailure.Permanent;
  }
  return SessionsExportFailure.Retryable;
}

/**
 * Hand `csv` to the browser as a download.
 *
 * The object URL is revoked on the next macrotask rather than synchronously:
 * Safari has not started reading the blob when `click()` returns, and revoking
 * in the same tick cancels the download it just began.
 */
function downloadCsv(csv: string, fileName: string): void {
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" })
  );
  const anchor = globalThis.document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The downloaded file's name.
 *
 * Deliberately NOT the server's `Content-Disposition` name: reading that header
 * would require the export route to expose it cross-origin, which it does not,
 * so a name derived here is the honest one rather than a header read that would
 * silently resolve to nothing. The org slug the server includes is dropped for
 * the same reason — this side does not have it without a second read.
 */
function buildExportFileName(now: Date): string {
  return `agent-sessions-${now.toISOString().slice(0, 10)}.csv`;
}
