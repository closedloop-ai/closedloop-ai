import { Priority } from "@repo/api/src/types/common";
import type { DocumentWithWorkstream } from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { DocumentRowItem } from "@/components/document-table/document-row";
import { useTableFilters } from "../use-table-filters";

// ---- Test fixtures ----

function makeItem(id: string, status: DocumentStatus): DocumentRowItem {
  return {
    kind: "artifact",
    data: {
      id,
      title: `Item ${id}`,
      type: DocumentType.Prd,
      slug: `item-${id}`,
      status,
      priority: Priority.Medium,
      assigneeId: null,
      assignee: null,
    } as unknown as DocumentWithWorkstream,
  };
}

const ITEM_DRAFT = makeItem("1", DocumentStatus.Draft);
const ITEM_IN_PROGRESS = makeItem("2", DocumentStatus.InProgress);
const ITEM_IN_REVIEW = makeItem("3", DocumentStatus.InReview);
const ITEM_DONE = makeItem("4", DocumentStatus.Done);
const ITEM_OBSOLETE = makeItem("5", DocumentStatus.Obsolete);

const ALL_STATUS_ITEMS = [
  ITEM_DRAFT,
  ITEM_IN_PROGRESS,
  ITEM_IN_REVIEW,
  ITEM_DONE,
  ITEM_OBSOLETE,
];

// ---- Tests ----

describe("useTableFilters — hideCompletedItems", () => {
  describe("initial state", () => {
    test("hideCompletedItems is true on init", () => {
      const { result } = renderHook(() =>
        useTableFilters({ items: ALL_STATUS_ITEMS })
      );

      expect(result.current.filters.hideCompletedItems).toBe(true);
    });

    test("clearAllFilters resets hideCompletedItems to false", () => {
      const { result } = renderHook(() =>
        useTableFilters({ items: ALL_STATUS_ITEMS })
      );

      act(() => {
        result.current.clearAllFilters();
      });

      expect(result.current.filters.hideCompletedItems).toBe(false);
    });
  });

  describe("toggleHideCompletedItems", () => {
    test("flips hideCompletedItems from true to false", () => {
      const { result } = renderHook(() =>
        useTableFilters({ items: ALL_STATUS_ITEMS })
      );

      expect(result.current.filters.hideCompletedItems).toBe(true);

      act(() => {
        result.current.toggleHideCompletedItems();
      });

      expect(result.current.filters.hideCompletedItems).toBe(false);
    });

    test("flips hideCompletedItems from false to true", () => {
      const { result } = renderHook(() =>
        useTableFilters({ items: ALL_STATUS_ITEMS })
      );

      act(() => {
        result.current.clearAllFilters();
      });

      expect(result.current.filters.hideCompletedItems).toBe(false);

      act(() => {
        result.current.toggleHideCompletedItems();
      });

      expect(result.current.filters.hideCompletedItems).toBe(true);
    });
  });

  describe("applyFilters with hideCompletedItems", () => {
    test("excludes Done and Obsolete items when hideCompletedItems is true", () => {
      const { result } = renderHook(() =>
        useTableFilters({ items: ALL_STATUS_ITEMS })
      );

      expect(result.current.filters.hideCompletedItems).toBe(true);

      const filtered = result.current.applyFilters(ALL_STATUS_ITEMS);

      expect(filtered).toContain(ITEM_DRAFT);
      expect(filtered).toContain(ITEM_IN_PROGRESS);
      expect(filtered).toContain(ITEM_IN_REVIEW);
      expect(filtered).not.toContain(ITEM_DONE);
      expect(filtered).not.toContain(ITEM_OBSOLETE);
    });

    test("includes Done and Obsolete items when hideCompletedItems is false", () => {
      const { result } = renderHook(() =>
        useTableFilters({ items: ALL_STATUS_ITEMS })
      );

      act(() => {
        result.current.toggleHideCompletedItems();
      });

      expect(result.current.filters.hideCompletedItems).toBe(false);

      const filtered = result.current.applyFilters(ALL_STATUS_ITEMS);

      expect(filtered).toContain(ITEM_DONE);
      expect(filtered).toContain(ITEM_OBSOLETE);
      expect(filtered).toHaveLength(ALL_STATUS_ITEMS.length);
    });

    test("hideCompletedItems filter runs even when no category filters are active", () => {
      const { result } = renderHook(() =>
        useTableFilters({ items: ALL_STATUS_ITEMS })
      );

      // No assignee, status, priority, or date filters set — only hideCompletedItems (default true)
      expect(result.current.filters.assigneeIds).toHaveLength(0);
      expect(result.current.filters.statuses).toHaveLength(0);
      expect(result.current.filters.priorities).toHaveLength(0);
      expect(result.current.filters.date).toBeNull();

      const filtered = result.current.applyFilters(ALL_STATUS_ITEMS);

      expect(filtered).not.toContain(ITEM_DONE);
      expect(filtered).not.toContain(ITEM_OBSOLETE);
    });
  });

  describe("activeFilterCount", () => {
    test("counts hideCompletedItems as one active filter when enabled", () => {
      const { result } = renderHook(() =>
        useTableFilters({ items: ALL_STATUS_ITEMS })
      );

      // Toggle off to get baseline count without hideCompletedItems
      act(() => {
        result.current.toggleHideCompletedItems();
      });
      const countWithout = result.current.activeFilterCount;

      // Toggle back on
      act(() => {
        result.current.toggleHideCompletedItems();
      });
      const countWith = result.current.activeFilterCount;

      expect(countWith).toBe(countWithout + 1);
    });

    test("does not count hideCompletedItems when disabled", () => {
      const { result } = renderHook(() =>
        useTableFilters({ items: ALL_STATUS_ITEMS })
      );

      act(() => {
        result.current.clearAllFilters();
      });

      // All filters cleared — hideCompletedItems is false, no other filters active
      expect(result.current.activeFilterCount).toBe(0);
    });
  });
});
