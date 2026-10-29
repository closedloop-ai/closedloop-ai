import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTableViewOrdering } from "../use-table-view-ordering";

const GATES = vi.hoisted(() => new Map<string, boolean>());

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagGateOptional: (key: string) => ({
    enabled: GATES.get(key) ?? false,
    isReady: true,
  }),
}));

describe("useTableViewOrdering universal status evidence", () => {
  beforeEach(() => GATES.clear());

  it("retains raw grouping evidence without enabling root-first sorting", () => {
    GATES.set(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY, true);
    const { result } = renderHook(() => useTableViewOrdering());

    expect(
      result.current.groupOptions.statusEvidence?.(documentRow(null))
    ).toBe(null);
    expect(
      result.current.groupOptions.statusEvidence?.(
        documentRow("FUTURE_DOCUMENT_STATUS")
      )
    ).toBe("FUTURE_DOCUMENT_STATUS");
  });

  it("keeps root-first ordering independently gated", () => {
    GATES.set(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY, true);
    const universalOnly = renderHook(() => useTableViewOrdering());
    expect(
      universalOnly.result.current.groupOptions.sectionRoot
    ).toBeUndefined();

    GATES.set(ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY, true);
    const rootFirst = renderHook(() => useTableViewOrdering());
    expect(rootFirst.result.current.groupOptions.sectionRoot).toBeTypeOf(
      "function"
    );
  });
});

function documentRow(rawStatus: string | null): DocumentRowItem {
  return {
    kind: "document",
    data: {
      assignee: null,
      assigneeId: null,
      createdAt: new Date("2026-09-17T12:00:00.000Z"),
      id: "document-1",
      priority: Priority.Medium,
      project: null,
      projectId: "project-1",
      rawStatus,
      slug: "document-1",
      sortOrder: 0,
      status: DocumentStatus.Draft,
      tags: [],
      title: "Document",
      type: DocumentType.Prd,
      updatedAt: new Date("2026-09-17T12:00:00.000Z"),
    },
  };
}
