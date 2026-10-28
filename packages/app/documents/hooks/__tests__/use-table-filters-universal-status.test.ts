import { DISPLAYED_ARTIFACT_STATUS } from "@repo/api/src/types/artifact-status";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { useTableFilters } from "../use-table-filters";

const BASE_DOCUMENT: DocumentRowData = {
  assignee: null,
  assigneeId: null,
  createdAt: new Date("2026-09-17T12:00:00.000Z"),
  id: "future-document-status",
  priority: Priority.Medium,
  project: null,
  projectId: "project-1",
  slug: "future-document-status",
  sortOrder: 0,
  status: DocumentStatus.Draft,
  tags: [],
  title: "Future document status",
  type: DocumentType.Prd,
  updatedAt: new Date("2026-09-17T12:00:00.000Z"),
};

describe("useTableFilters — universal status evidence", () => {
  afterEach(() => localStorage.clear());

  test("keeps the legacy fallback for counts and filtering while the flag is off", () => {
    const skewedDocument = documentItem("FUTURE_DOCUMENT_STATUS");
    const { result } = renderHook(() =>
      useTableFilters({ items: [skewedDocument] })
    );

    expect(result.current.statusCounts).toEqual(
      new Map([[DocumentStatus.Draft, 1]])
    );
    act(() => result.current.toggleStatus(DocumentStatus.Draft));
    expect(result.current.applyFilters([skewedDocument])).toEqual([
      skewedDocument,
    ]);
  });

  test("aggregates future tokens under one Unknown facet and keeps null distinct", () => {
    const firstFuture = documentItem("FUTURE_DOCUMENT_STATUS", "future-1");
    const secondFuture = documentItem("ANOTHER_FUTURE_STATUS", "future-2");
    const nullStatus = documentItem(null, "null");
    const known = documentItem(DocumentStatus.Draft, "known");
    const items = [firstFuture, secondFuture, nullStatus, known];
    const { result } = renderHook(() => useTableFilters({ items }), {
      wrapper: universalStatusWrapper(),
    });

    expect(result.current.statusCounts).toEqual(
      new Map([
        [DISPLAYED_ARTIFACT_STATUS.Unknown, 2],
        [DocumentStatus.Draft, 1],
      ])
    );
    act(() => result.current.toggleStatus(DISPLAYED_ARTIFACT_STATUS.Unknown));
    expect(result.current.applyFilters(items)).toEqual([
      firstFuture,
      secondFuture,
    ]);
  });

  test("does not relabel explicit null evidence as the safe fallback", () => {
    const nullStatusDocument = documentItem(null);
    const { result } = renderHook(
      () => useTableFilters({ items: [nullStatusDocument] }),
      { wrapper: universalStatusWrapper() }
    );

    expect(result.current.statusCounts).toEqual(new Map());
    act(() => result.current.toggleStatus(DocumentStatus.Draft));
    expect(result.current.applyFilters([nullStatusDocument])).toEqual([]);
  });

  test("keeps persisted Unknown recoverable but inactive while the flag is off", () => {
    const key = "test:unknown-status";
    localStorage.setItem(
      key,
      JSON.stringify({
        savedAt: Date.now(),
        data: {
          assigneeIds: [],
          assignToMe: false,
          date: null,
          favoritesOnly: false,
          hideCompletedItems: false,
          priorities: [],
          statuses: [DISPLAYED_ARTIFACT_STATUS.Unknown],
          tagIds: [],
        },
      })
    );

    const off = renderHook(() =>
      useTableFilters({ items: [], persistenceKey: key })
    );
    expect(off.result.current.filters.statuses).toEqual([]);
    expect(JSON.parse(localStorage.getItem(key) ?? "{}").data.statuses).toEqual(
      [DISPLAYED_ARTIFACT_STATUS.Unknown]
    );
    off.unmount();

    const on = renderHook(
      () => useTableFilters({ items: [], persistenceKey: key }),
      { wrapper: universalStatusWrapper() }
    );
    expect(on.result.current.filters.statuses).toEqual([
      DISPLAYED_ARTIFACT_STATUS.Unknown,
    ]);
  });
});

function documentItem(
  rawStatus: string | null,
  id = "future-document-status"
): DocumentRowItem {
  return {
    kind: "document",
    data: { ...BASE_DOCUMENT, id, rawStatus },
  };
}

function universalStatusWrapper() {
  const adapter = createStaticFeatureFlagAdapter({
    enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY],
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(FeatureFlagAdapterProvider, { adapter, children });
}
