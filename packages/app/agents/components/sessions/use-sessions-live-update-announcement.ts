"use client";

import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { sessionsRangeReadout } from "@repo/app/agents/lib/sessions-range-readout";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Announce a settled material replacement without treating clock-only duration
 * ticks as new data. The sentence is the existing Sessions footer copy.
 *
 * `viewKey` names the reader's own query (sort, filters, grouping, window). A
 * change to it re-baselines instead of announcing, so a reorder the reader asked
 * for is not reported as a live update (tamsinb review, #9095).
 */
export function useSessionsLiveUpdateAnnouncement({
  isError,
  isPending,
  isPlaceholderPage,
  pageIndex,
  pageSize,
  rows,
  total,
  viewKey,
}: {
  isError: boolean;
  isPending: boolean;
  isPlaceholderPage: boolean;
  pageIndex: number;
  pageSize: number;
  rows: readonly SessionTableRow[];
  total: number;
  viewKey: string;
}): string | null {
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const previousSignature = useRef<string | null>(null);
  const previousPage = useRef<number | null>(null);
  const previousTotal = useRef<number | null>(null);
  const previousViewKey = useRef<string | null>(null);
  const signature = useMemo(() => materialRowsSignature(rows), [rows]);
  const isSettled = !(isError || isPending || isPlaceholderPage);
  const sentence = sessionsRangeReadout({
    pageIndex,
    pageSize,
    rowsOnPage: rows.length,
    total,
  });

  useEffect(() => {
    if (!isSettled) {
      return;
    }
    if (
      previousSignature.current === null ||
      previousPage.current !== pageIndex ||
      previousTotal.current !== total ||
      previousViewKey.current !== viewKey
    ) {
      if (previousSignature.current !== null) {
        setAnnouncement(null);
      }
      previousSignature.current = signature;
      previousPage.current = pageIndex;
      previousTotal.current = total;
      previousViewKey.current = viewKey;
      return;
    }
    if (previousSignature.current === signature) {
      return;
    }
    previousSignature.current = signature;
    // Clear before repeating an unchanged range sentence, so a same-size row
    // replacement is still an actual live-region text change.
    setAnnouncement(null);
    const timer = setTimeout(() => setAnnouncement(sentence), 0);
    return () => clearTimeout(timer);
  }, [isSettled, pageIndex, sentence, signature, total, viewKey]);

  return announcement;
}

/** Material, rendered facts only; an active session's clock-derived duration is excluded. */
function materialRowsSignature(rows: readonly SessionTableRow[]): string {
  return JSON.stringify(
    rows.map((row) => [
      row.id,
      row.name,
      row.status,
      row.rawStatus,
      row.syncPresentation,
      row.owner,
      row.priority,
      row.tags,
      row.tagAvailability,
      row.tagPermissions,
      row.harness,
      row.branch,
      row.pullRequests,
      row.repo,
      row.model,
      row.costValue,
      row.startedAtMs,
      row.updatedAtMs,
      row.lastActivityAtMs,
      row.autonomy,
    ])
  );
}

/** A stable key for the reader's query; set-valued filters compare by members. */
export function sessionsLiveUpdateViewKey(
  view: Readonly<Record<string, unknown>>
): string {
  return JSON.stringify(view, (_key, value: unknown) =>
    value instanceof Set ? [...value].map(String).sort() : value
  );
}
