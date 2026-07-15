import type { Artifact } from "@repo/api/src/types/artifact";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import type { DocumentWithProject } from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  type DateFilter,
  DateFilterField,
  DatePreset,
  type TableFilters,
  useTableFilters,
} from "../use-table-filters";

// ---- Test fixtures ----

function makeItem(id: string, status: DocumentStatus): DocumentRowItem {
  return {
    kind: "document",
    data: {
      id,
      title: `Item ${id}`,
      type: DocumentType.Prd,
      slug: `item-${id}`,
      status,
      priority: Priority.Medium,
      assigneeId: null,
      assignee: null,
    } as unknown as DocumentWithProject,
  };
}

const ITEM_DRAFT = makeItem("1", DocumentStatus.Draft);
const ITEM_IN_PROGRESS = makeItem("2", DocumentStatus.ChangesRequested);
const ITEM_IN_REVIEW = makeItem("3", DocumentStatus.InReview);
const ITEM_EXECUTED = makeItem("4", DocumentStatus.Executed);
const ITEM_OBSOLETE = makeItem("5", DocumentStatus.Obsolete);
// An APPROVED document is not yet "done" (it awaits execution), so
// hide-completed keeps it visible — unlike EXECUTED / OBSOLETE.
const ITEM_APPROVED = makeItem("6", DocumentStatus.Approved);

const ALL_STATUS_ITEMS = [
  ITEM_DRAFT,
  ITEM_IN_PROGRESS,
  ITEM_IN_REVIEW,
  ITEM_EXECUTED,
  ITEM_OBSOLETE,
  ITEM_APPROVED,
];

function makeBranchItem(id: string, status: GitHubPRState): DocumentRowItem {
  return {
    kind: "branch",
    data: {
      id,
      name: `Branch ${id}`,
      type: ArtifactType.Branch,
      subtype: null,
      slug: null,
      status,
      priority: null,
      assigneeId: null,
      assignee: null,
    } as unknown as Artifact,
  };
}

const BRANCH_OPEN = makeBranchItem("b1", GitHubPRState.Open);
const BRANCH_MERGED = makeBranchItem("b2", GitHubPRState.Merged);
const BRANCH_CLOSED = makeBranchItem("b3", GitHubPRState.Closed);

const ALL_BRANCH_ITEMS = [BRANCH_OPEN, BRANCH_MERGED, BRANCH_CLOSED];

function makeSessionItem(id: string, status: string): DocumentRowItem {
  return {
    kind: "session",
    data: {
      id,
      name: `Session ${id}`,
      type: ArtifactType.Session,
      subtype: null,
      slug: null,
      status,
      priority: null,
      assigneeId: null,
      assignee: null,
    } as unknown as Artifact,
  };
}

const SESSION_ACTIVE = makeSessionItem("s1", "active");
const SESSION_COMPLETED = makeSessionItem("s2", "completed");
const SESSION_FAILED = makeSessionItem("s3", "failed");

const ALL_SESSION_ITEMS = [SESSION_ACTIVE, SESSION_COMPLETED, SESSION_FAILED];

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
    test("excludes Executed and Obsolete documents but keeps Approved when hideCompletedItems is true", () => {
      const { result } = renderHook(() =>
        useTableFilters({ items: ALL_STATUS_ITEMS })
      );

      expect(result.current.filters.hideCompletedItems).toBe(true);

      const filtered = result.current.applyFilters(ALL_STATUS_ITEMS);

      expect(filtered).toContain(ITEM_DRAFT);
      expect(filtered).toContain(ITEM_IN_PROGRESS);
      expect(filtered).toContain(ITEM_IN_REVIEW);
      // APPROVED documents are still in flight — they stay visible.
      expect(filtered).toContain(ITEM_APPROVED);
      expect(filtered).not.toContain(ITEM_EXECUTED);
      expect(filtered).not.toContain(ITEM_OBSOLETE);
    });

    test("includes Executed and Obsolete items when hideCompletedItems is false", () => {
      const { result } = renderHook(() =>
        useTableFilters({ items: ALL_STATUS_ITEMS })
      );

      act(() => {
        result.current.toggleHideCompletedItems();
      });

      expect(result.current.filters.hideCompletedItems).toBe(false);

      const filtered = result.current.applyFilters(ALL_STATUS_ITEMS);

      expect(filtered).toContain(ITEM_EXECUTED);
      expect(filtered).toContain(ITEM_OBSOLETE);
      expect(filtered).toHaveLength(ALL_STATUS_ITEMS.length);
    });

    test("excludes merged and closed branch/PR rows when hideCompletedItems is true", () => {
      const items = [...ALL_STATUS_ITEMS, ...ALL_BRANCH_ITEMS];
      const { result } = renderHook(() => useTableFilters({ items }));

      expect(result.current.filters.hideCompletedItems).toBe(true);

      const filtered = result.current.applyFilters(items);

      expect(filtered).toContain(BRANCH_OPEN);
      expect(filtered).not.toContain(BRANCH_MERGED);
      expect(filtered).not.toContain(BRANCH_CLOSED);
    });

    test("includes merged and closed branch/PR rows when hideCompletedItems is false", () => {
      const items = [...ALL_STATUS_ITEMS, ...ALL_BRANCH_ITEMS];
      const { result } = renderHook(() => useTableFilters({ items }));

      act(() => {
        result.current.toggleHideCompletedItems();
      });

      const filtered = result.current.applyFilters(items);

      expect(filtered).toContain(BRANCH_OPEN);
      expect(filtered).toContain(BRANCH_MERGED);
      expect(filtered).toContain(BRANCH_CLOSED);
    });

    test("excludes terminal session rows when hideCompletedItems is true (FEA-1763 Phase 2)", () => {
      const items = [...ALL_STATUS_ITEMS, ...ALL_SESSION_ITEMS];
      const { result } = renderHook(() => useTableFilters({ items }));

      expect(result.current.filters.hideCompletedItems).toBe(true);

      const filtered = result.current.applyFilters(items);

      expect(filtered).toContain(SESSION_ACTIVE);
      expect(filtered).not.toContain(SESSION_COMPLETED);
      expect(filtered).not.toContain(SESSION_FAILED);
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

      expect(filtered).not.toContain(ITEM_EXECUTED);
      expect(filtered).not.toContain(ITEM_OBSOLETE);
      expect(filtered).toContain(ITEM_APPROVED);
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

function seedFilters(key: string, data: Record<string, unknown>) {
  const defaults: TableFilters = {
    assigneeIds: [],
    assignToMe: false,
    hideCompletedItems: true,
    statuses: [],
    priorities: [],
    date: null,
    tagIds: [],
    favoritesOnly: false,
  };
  localStorage.setItem(
    key,
    JSON.stringify({ savedAt: Date.now(), data: { ...defaults, ...data } })
  );
}

describe("useTableFilters — persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("writes filters to localStorage when persistenceKey is provided", () => {
    const { result } = renderHook(() =>
      useTableFilters({ items: [], persistenceKey: "test:filters" })
    );

    act(() => {
      result.current.toggleStatus(DocumentStatus.Draft);
    });

    const raw = localStorage.getItem("test:filters");
    expect(raw).not.toBeNull();
    const envelope = JSON.parse(raw!);
    expect(envelope.data.statuses).toContain(DocumentStatus.Draft);
    expect(typeof envelope.savedAt).toBe("number");
  });

  test("restores filters from localStorage on mount", () => {
    seedFilters("test:filters", { statuses: [DocumentStatus.Draft] });

    const { result } = renderHook(() =>
      useTableFilters({ items: [], persistenceKey: "test:filters" })
    );

    expect(result.current.filters.statuses).toContain(DocumentStatus.Draft);
  });

  test("clearAllFilters persists INITIAL_FILTERS with hideCompletedItems false", () => {
    const { result } = renderHook(() =>
      useTableFilters({ items: [], persistenceKey: "test:filters" })
    );

    act(() => {
      result.current.clearAllFilters();
    });

    const raw = localStorage.getItem("test:filters");
    const envelope = JSON.parse(raw!);
    expect(envelope.data.hideCompletedItems).toBe(false);
    expect(envelope.data.statuses).toEqual([]);
    expect(envelope.data.assigneeIds).toEqual([]);
  });

  test("strips invalid statuses on restore", () => {
    seedFilters("test:filters", {
      statuses: [DocumentStatus.Draft, "INVALID_STATUS"],
    });

    const { result } = renderHook(() =>
      useTableFilters({ items: [], persistenceKey: "test:filters" })
    );

    expect(result.current.filters.statuses).toContain(DocumentStatus.Draft);
    expect(result.current.filters.statuses).not.toContain("INVALID_STATUS");
    expect(result.current.filters.statuses).toHaveLength(1);
  });

  test("revives date filter ISO strings as Date objects", () => {
    const startDate = new Date("2025-01-01T00:00:00.000Z");
    const endDate = new Date("2025-01-31T23:59:59.000Z");
    const dateFilter: DateFilter = {
      field: DateFilterField.CreatedAt,
      preset: DatePreset.Custom,
      startDate,
      endDate,
    };
    seedFilters("test:filters", { date: dateFilter });

    const { result } = renderHook(() =>
      useTableFilters({ items: [], persistenceKey: "test:filters" })
    );

    expect(result.current.filters.date).not.toBeNull();
    expect(result.current.filters.date!.startDate).toBeInstanceOf(Date);
    expect(result.current.filters.date!.endDate).toBeInstanceOf(Date);
    expect(result.current.filters.date!.startDate!.toISOString()).toBe(
      startDate.toISOString()
    );
  });

  test("does not write to localStorage when persistenceKey is omitted", () => {
    const { result } = renderHook(() => useTableFilters({ items: [] }));

    act(() => {
      result.current.toggleStatus(DocumentStatus.Draft);
    });

    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key !== "__view-state-noop__") {
        keys.push(key);
      }
    }
    expect(keys).toHaveLength(0);
  });
});

describe("useTableFilters — favoritesOnly", () => {
  const FAVORITE_IDS = ["1", "3"];

  describe("toggleFavoritesOnly", () => {
    test("flips favoritesOnly from false to true", () => {
      const { result } = renderHook(() =>
        useTableFilters({
          items: ALL_STATUS_ITEMS,
          favoriteArtifactIds: FAVORITE_IDS,
        })
      );

      expect(result.current.filters.favoritesOnly).toBe(false);

      act(() => {
        result.current.toggleFavoritesOnly();
      });

      expect(result.current.filters.favoritesOnly).toBe(true);
    });
  });

  describe("applyFilters with favoritesOnly", () => {
    test("shows only favorited items when favoritesOnly is true", () => {
      const { result } = renderHook(() =>
        useTableFilters({
          items: ALL_STATUS_ITEMS,
          favoriteArtifactIds: FAVORITE_IDS,
        })
      );

      act(() => {
        result.current.toggleHideCompletedItems();
        result.current.toggleFavoritesOnly();
      });

      const filtered = result.current.applyFilters(ALL_STATUS_ITEMS);

      expect(filtered.map((i) => i.data.id)).toEqual(["1", "3"]);
    });

    test("returns empty list when favoritesOnly is true and no favorites exist", () => {
      const { result } = renderHook(() =>
        useTableFilters({ items: ALL_STATUS_ITEMS, favoriteArtifactIds: [] })
      );

      act(() => {
        result.current.toggleHideCompletedItems();
        result.current.toggleFavoritesOnly();
      });

      const filtered = result.current.applyFilters(ALL_STATUS_ITEMS);

      expect(filtered).toHaveLength(0);
    });

    test("passes through project-kind items regardless of favorites", () => {
      const projectItem: DocumentRowItem = {
        kind: "project",
        data: { id: "proj-99", name: "Test Project" } as any,
      };
      const items = [...ALL_STATUS_ITEMS, projectItem];

      const { result } = renderHook(() =>
        useTableFilters({ items, favoriteArtifactIds: FAVORITE_IDS })
      );

      act(() => {
        result.current.toggleHideCompletedItems();
        result.current.toggleFavoritesOnly();
      });

      const filtered = result.current.applyFilters(items);

      expect(filtered).toContain(projectItem);
    });
  });

  describe("activeFilterCount and chips", () => {
    test("counts favoritesOnly as one active filter", () => {
      const { result } = renderHook(() =>
        useTableFilters({
          items: ALL_STATUS_ITEMS,
          favoriteArtifactIds: FAVORITE_IDS,
        })
      );

      act(() => {
        result.current.clearAllFilters();
      });

      const countBefore = result.current.activeFilterCount;

      act(() => {
        result.current.toggleFavoritesOnly();
      });

      expect(result.current.activeFilterCount).toBe(countBefore + 1);
    });

    test("includes My Favorites chip when favoritesOnly is true", () => {
      const { result } = renderHook(() =>
        useTableFilters({
          items: ALL_STATUS_ITEMS,
          favoriteArtifactIds: FAVORITE_IDS,
        })
      );

      act(() => {
        result.current.toggleFavoritesOnly();
      });

      const chips = result.current.activeChips;
      expect(chips.some((c) => c.category === "favorites")).toBe(true);
    });

    test("clearAllFilters resets favoritesOnly to false", () => {
      const { result } = renderHook(() =>
        useTableFilters({
          items: ALL_STATUS_ITEMS,
          favoriteArtifactIds: FAVORITE_IDS,
        })
      );

      act(() => {
        result.current.toggleFavoritesOnly();
      });
      expect(result.current.filters.favoritesOnly).toBe(true);

      act(() => {
        result.current.clearAllFilters();
      });
      expect(result.current.filters.favoritesOnly).toBe(false);
    });
  });
});

describe("useTableFilters — document-only filters vs non-document rows", () => {
  // Status, priority, and tag filters describe document fields. Branch rows
  // carry GitHubPRState statuses and session rows carry free-form harness
  // strings, so an active document filter must NOT exclude them — a status
  // filter persisted from the Documents tab would otherwise blank the
  // Branches tab entirely.
  const MIXED_ITEMS = [
    ITEM_DRAFT,
    ITEM_IN_PROGRESS,
    BRANCH_OPEN,
    SESSION_ACTIVE,
  ];

  test("status filter narrows documents but keeps branch and session rows", () => {
    const { result } = renderHook(() =>
      useTableFilters({ items: MIXED_ITEMS })
    );

    act(() => {
      result.current.toggleStatus(DocumentStatus.ChangesRequested);
    });

    const filtered = result.current.applyFilters(MIXED_ITEMS);

    expect(filtered).toContain(ITEM_IN_PROGRESS);
    expect(filtered).not.toContain(ITEM_DRAFT);
    expect(filtered).toContain(BRANCH_OPEN);
    expect(filtered).toContain(SESSION_ACTIVE);
  });

  test("priority filter does not exclude branch and session rows", () => {
    const { result } = renderHook(() =>
      useTableFilters({ items: MIXED_ITEMS })
    );

    act(() => {
      result.current.togglePriority(Priority.High);
    });

    const filtered = result.current.applyFilters(MIXED_ITEMS);

    // Document fixtures carry Medium priority, so they are filtered out;
    // branch/session rows (no user-set priority) pass through.
    expect(filtered).not.toContain(ITEM_DRAFT);
    expect(filtered).toContain(BRANCH_OPEN);
    expect(filtered).toContain(SESSION_ACTIVE);
  });

  test("tag filter does not exclude branch and session rows", () => {
    const { result } = renderHook(() =>
      useTableFilters({ items: MIXED_ITEMS })
    );

    act(() => {
      result.current.toggleTag("tag-1");
    });

    const filtered = result.current.applyFilters(MIXED_ITEMS);

    expect(filtered).not.toContain(ITEM_DRAFT);
    expect(filtered).toContain(BRANCH_OPEN);
    expect(filtered).toContain(SESSION_ACTIVE);
  });

  test("hide-completed still applies to branch and session rows when a status filter is active", () => {
    const items = [ITEM_IN_PROGRESS, BRANCH_MERGED, SESSION_COMPLETED];
    const { result } = renderHook(() => useTableFilters({ items }));

    expect(result.current.filters.hideCompletedItems).toBe(true);

    act(() => {
      result.current.toggleStatus(DocumentStatus.ChangesRequested);
    });

    const filtered = result.current.applyFilters(items);

    expect(filtered).toContain(ITEM_IN_PROGRESS);
    // Non-document rows bypass the status clause but not hide-completed.
    expect(filtered).not.toContain(BRANCH_MERGED);
    expect(filtered).not.toContain(SESSION_COMPLETED);
  });
});

describe("useTableFilters — hide-completed terminal-session variants", () => {
  // Hide-completed and the registry's status-icon mapping share one terminal
  // definition (isTerminalSessionStatus), so pattern-matched variants like
  // "execution_failed" are hidden, not just the exact strings.
  test("hides pattern-matched terminal session statuses", () => {
    const failedVariant = makeSessionItem("s9", "execution_failed");
    const errorVariant = makeSessionItem("s10", "timeout_error");
    const items = [SESSION_ACTIVE, failedVariant, errorVariant];
    const { result } = renderHook(() => useTableFilters({ items }));

    expect(result.current.filters.hideCompletedItems).toBe(true);

    const filtered = result.current.applyFilters(items);

    expect(filtered).toContain(SESSION_ACTIVE);
    expect(filtered).not.toContain(failedVariant);
    expect(filtered).not.toContain(errorVariant);
  });
});
