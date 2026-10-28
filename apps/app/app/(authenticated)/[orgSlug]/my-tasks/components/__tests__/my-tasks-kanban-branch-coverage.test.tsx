import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import type { Transform } from "@dnd-kit/utilities";
import { CSS } from "@dnd-kit/utilities";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  type ArtifactStatus,
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MyTasksKanban } from "../my-tasks-kanban";

/**
 * ISS-9714: closes the remaining branch gaps in `my-tasks-kanban.tsx` that
 * `my-tasks-kanban.test.tsx` does not exercise — the full `columnTargetStatus`
 * mapping table, the drag-resolution guard clauses, the loading/assignee
 * gating, the drag-overlay preview, and the per-card fallback branches
 * (unroutable type, non-typed slug, live transform/drag-visual state, and the
 * post-drag click guard). See that file's own header comment for why the
 * dnd-kit context is doubled rather than driven with real pointer events.
 */

const PAGE_QUERY_KEY = documentKeys.list({ assigneeId: "user-1" });

const mutateMock = vi.fn();

/**
 * A `DocumentRowData["type"]` value outside the `DocumentType` enum. The
 * source's own comment on `getKanbanArtifactCardProps` documents that
 * non-Document rows (e.g. a Session) reach this component typed as
 * `DocumentType` but carrying a runtime value with no icon-map or route-map
 * entry; the single cast pins that documented, deliberate mismatch rather than
 * a type-forbidden one.
 */
const NON_DOCUMENT_TYPE = "SESSION" as DocumentType;

let capturedDragEnd: ((event: DragEndEvent) => void) | undefined;
let capturedDragStart: ((event: DragStartEvent) => void) | undefined;

const draggableState: { isDragging: boolean; transform: Transform | null } = {
  isDragging: false,
  transform: null,
};

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragEnd,
    onDragStart,
  }: {
    children: React.ReactNode;
    onDragEnd: (event: DragEndEvent) => void;
    onDragStart: (event: DragStartEvent) => void;
  }) => {
    capturedDragEnd = onDragEnd;
    capturedDragStart = onDragStart;
    return <div>{children}</div>;
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  MouseSensor: "MouseSensor",
  TouchSensor: "TouchSensor",
  useDraggable: () => ({
    attributes: {},
    isDragging: draggableState.isDragging,
    listeners: {},
    setNodeRef: () => {
      // no-op: jsdom has no layout for dnd-kit to measure
    },
    transform: draggableState.transform,
  }),
  useDroppable: () => ({
    isOver: false,
    setNodeRef: () => {
      // no-op: jsdom has no layout for dnd-kit to measure
    },
  }),
  useSensor: (sensor: unknown) => sensor,
  useSensors: (...sensors: unknown[]) => sensors,
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useUpdateDocument: () => ({ mutate: mutateMock }),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme" }),
  usePathname: () => "/acme/my-tasks",
  useRouter: () => ({
    back: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

class MockResizeObserver {
  disconnect() {
    // no-op
  }
  observe() {
    // no-op
  }
  unobserve() {
    // no-op
  }
}

type ColumnTargetCase = {
  name: string;
  columnKey: string;
  type: DocumentType;
  startStatus: ArtifactStatus;
  expectedStatus: ArtifactStatus | null;
};

// Every switch arm in `columnTargetStatus` that `my-tasks-kanban.test.tsx`
// does not already drive: it covers only "backlog", "approved" (Document
// side), and "done" (Document side). Each row starts the artifact on a status
// that differs from its expected target so a no-op guard elsewhere in
// `handleDragEnd` cannot mask a wrong mapping.
const COLUMN_TARGET_CASES: ColumnTargetCase[] = [
  {
    name: "a Feature dropped on To Do resolves to IssueStatus.Todo",
    columnKey: "todo",
    type: DocumentType.Feature,
    startStatus: IssueStatus.Backlog,
    expectedStatus: IssueStatus.Todo,
  },
  {
    name: "a Document dropped on To Do has no target status in its vocabulary",
    columnKey: "todo",
    type: DocumentType.Doc,
    startStatus: DocumentStatus.Draft,
    expectedStatus: null,
  },
  {
    name: "a Feature dropped on In Progress resolves to IssueStatus.InProgress",
    columnKey: "in_progress",
    type: DocumentType.Feature,
    startStatus: IssueStatus.Todo,
    expectedStatus: IssueStatus.InProgress,
  },
  {
    name: "a Document dropped on In Progress has no target status in its vocabulary",
    columnKey: "in_progress",
    type: DocumentType.Doc,
    startStatus: DocumentStatus.Draft,
    expectedStatus: null,
  },
  {
    name: "a Feature dropped on In Review resolves to IssueStatus.InReview",
    columnKey: "in_review",
    type: DocumentType.Feature,
    startStatus: IssueStatus.Todo,
    expectedStatus: IssueStatus.InReview,
  },
  {
    name: "a Document dropped on In Review resolves to DocumentStatus.InReview",
    columnKey: "in_review",
    type: DocumentType.Doc,
    startStatus: DocumentStatus.Draft,
    expectedStatus: DocumentStatus.InReview,
  },
  {
    name: "a Feature dropped on Blocked resolves to IssueStatus.Blocked",
    columnKey: "blocked",
    type: DocumentType.Feature,
    startStatus: IssueStatus.Todo,
    expectedStatus: IssueStatus.Blocked,
  },
  {
    name: "a Document dropped on Blocked resolves to DocumentStatus.ChangesRequested",
    columnKey: "blocked",
    type: DocumentType.Doc,
    startStatus: DocumentStatus.Draft,
    expectedStatus: DocumentStatus.ChangesRequested,
  },
  {
    name: "a Feature dropped on Approved has no target status in its vocabulary",
    columnKey: "approved",
    type: DocumentType.Feature,
    startStatus: IssueStatus.Todo,
    expectedStatus: null,
  },
  {
    name: "a Feature dropped on Executed has no target status in its vocabulary",
    columnKey: "executed",
    type: DocumentType.Feature,
    startStatus: IssueStatus.Todo,
    expectedStatus: null,
  },
  {
    name: "a Document dropped on Executed resolves to DocumentStatus.Executed",
    columnKey: "executed",
    type: DocumentType.Doc,
    startStatus: DocumentStatus.Draft,
    expectedStatus: DocumentStatus.Executed,
  },
  {
    name: "a Feature dropped on Done resolves to IssueStatus.Done",
    columnKey: "done",
    type: DocumentType.Feature,
    startStatus: IssueStatus.Todo,
    expectedStatus: IssueStatus.Done,
  },
  {
    name: "a Feature dropped on Closed resolves to IssueStatus.Canceled",
    columnKey: "closed",
    type: DocumentType.Feature,
    startStatus: IssueStatus.Todo,
    expectedStatus: IssueStatus.Canceled,
  },
  {
    name: "a Document dropped on Closed resolves to DocumentStatus.Obsolete",
    columnKey: "closed",
    type: DocumentType.Doc,
    startStatus: DocumentStatus.Draft,
    expectedStatus: DocumentStatus.Obsolete,
  },
];

describe("MyTasksKanban branch coverage", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    mutateMock.mockReset();
    capturedDragEnd = undefined;
    capturedDragStart = undefined;
    draggableState.isDragging = false;
    draggableState.transform = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("columnTargetStatus mapping", () => {
    test.each(COLUMN_TARGET_CASES)(
      "$name",
      ({ columnKey, type, startStatus, expectedStatus }) => {
        renderBoard([
          artifact({ id: "a-1", title: "Item", status: startStatus, type }),
        ]);

        act(() => {
          requireDragEnd()(dragEndEvent("a-1", columnKey));
        });

        if (expectedStatus === null) {
          expect(mutateMock).not.toHaveBeenCalled();
          return;
        }
        expect(mutateMock).toHaveBeenCalledTimes(1);
        expect(mutateMock.mock.calls[0][0]).toEqual({
          expectedStatus: startStatus,
          id: "a-1",
          status: expectedStatus,
          surface: ArtifactStatusEditSurface.Board,
        });
      }
    );
  });

  describe("handleDragEnd guard clauses", () => {
    test("makes no write when the drop has no valid target", () => {
      renderBoard([artifact({ id: "a-1", title: "Item" })]);

      act(() => {
        requireDragEnd()(dragEndEvent("a-1", null));
      });

      expect(mutateMock).not.toHaveBeenCalled();
    });

    test("makes no write when a card is dropped back onto its own slot", () => {
      renderBoard([artifact({ id: "a-1", title: "Item" })]);

      act(() => {
        requireDragEnd()(dragEndEvent("a-1", "a-1"));
      });

      expect(mutateMock).not.toHaveBeenCalled();
    });

    test("does not crash and skips the write when the dragged artifact can no longer be found", () => {
      renderBoard([artifact({ id: "a-1", title: "Item" })]);

      expect(() => {
        act(() => {
          requireDragEnd()(dragEndEvent("does-not-exist", "backlog"));
        });
      }).not.toThrow();
      expect(mutateMock).not.toHaveBeenCalled();
    });

    test("makes no write when the drop target resolves to neither a column nor a sibling artifact", () => {
      renderBoard([artifact({ id: "a-1", title: "Item" })]);

      act(() => {
        requireDragEnd()(dragEndEvent("a-1", "not-a-column-or-a-card"));
      });

      expect(mutateMock).not.toHaveBeenCalled();
    });

    test("leaves a sibling card's cached status untouched when only the dragged card moves", () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const draggedItem = artifact({
        id: "a-1",
        title: "Dragged doc",
        status: DocumentStatus.Draft,
      });
      const siblingItem = artifact({
        id: "a-2",
        title: "Sibling doc",
        status: DocumentStatus.Draft,
      });
      queryClient.setQueryData(PAGE_QUERY_KEY, {
        items: [draggedItem, siblingItem],
        total: 2,
        limit: 50,
        offset: 0,
        hasMore: false,
      });

      renderBoard([draggedItem, siblingItem], { queryClient });

      act(() => {
        requireDragEnd()(dragEndEvent("a-1", "approved"));
      });

      const cached = queryClient.getQueryData(PAGE_QUERY_KEY) as {
        items: DocumentRowData[];
      };
      expect(cached.items.find((i) => i.id === "a-1")?.status).toBe(
        DocumentStatus.Approved
      );
      expect(cached.items.find((i) => i.id === "a-2")?.status).toBe(
        DocumentStatus.Draft
      );
    });
  });

  describe("loading and assignee gating", () => {
    test("shows the loading state while the user identity is still resolving", () => {
      renderBoard([artifact({ id: "a-1", title: "Item" })], {
        isUserLoading: true,
      });

      expect(screen.getByText("Loading...")).toBeInTheDocument();
    });

    test("shows the loading state while the assigned page is still loading for a resolved assignee", () => {
      renderBoard([artifact({ id: "a-1", title: "Item" })], {
        assigneeId: "user-1",
        isLoading: true,
      });

      expect(screen.getByText("Loading...")).toBeInTheDocument();
    });

    // Pins that BOTH `assigneeId` and `isLoading` must be true for the
    // loading gate: `isLoading` alone (with no resolved assignee) must fall
    // through to the sign-in prompt instead, since there is nothing to load
    // yet.
    test("does not show the loading state for an unresolved assignee even while isLoading is true", () => {
      renderBoard([artifact({ id: "a-1", title: "Item" })], {
        assigneeId: null,
        isLoading: true,
      });

      expect(screen.queryByText("Loading...")).toBeNull();
      expect(
        screen.getByText("Sign in to see your assigned tasks.")
      ).toBeInTheDocument();
    });
  });

  test("renders the dragged card a second time in the drag overlay once a drag starts", () => {
    renderBoard([artifact({ id: "a-1", title: "Overlay card" })]);

    expect(screen.getAllByText("Overlay card")).toHaveLength(1);

    act(() => {
      capturedDragStart?.(dragStartEvent("a-1"));
    });

    expect(screen.getAllByText("Overlay card")).toHaveLength(2);
  });

  test("falls back to a generic icon and an unclickable href for a row type outside the Document vocabulary", () => {
    renderBoard([
      artifact({
        id: "a-1",
        title: "Session row",
        type: NON_DOCUMENT_TYPE,
      }),
    ]);

    const card = screen.getByText("Session row").closest("a");
    if (!card) {
      throw new Error("Expected the card's title to be wrapped in a link");
    }
    expect(card.querySelector("svg.lucide-terminal")).not.toBeNull();
    expect(card.querySelector("svg.lucide-file-text")).toBeNull();
    expect(card).toHaveAttribute("href", "#");
  });

  test("shows the slug as the card subtitle when it matches a typed prefix", () => {
    renderBoard([
      artifact({
        id: "a-1",
        title: "Typed slug card",
        slug: "PRD-42",
      }),
    ]);

    expect(screen.getByText("PRD-42")).toBeInTheDocument();
  });

  describe("MyTasksCard drag-visual state", () => {
    test("applies the dnd-kit transform as an inline style while idle with a pending transform", () => {
      draggableState.transform = { x: 12, y: 34, scaleX: 1, scaleY: 1 };
      renderBoard([artifact({ id: "a-1", title: "Transform card" })]);

      const wrapper = screen
        .getByText("Transform card")
        .closest("a")?.parentElement;
      expect(wrapper?.style.transform).toBe(
        CSS.Transform.toString(draggableState.transform)
      );
    });

    test("marks the card invisible and grabbing while it is actively being dragged", () => {
      draggableState.isDragging = true;
      renderBoard([artifact({ id: "a-1", title: "Dragging card" })]);

      const wrapper = screen
        .getByText("Dragging card")
        .closest("a")?.parentElement;
      expect(wrapper).toHaveClass("invisible", "cursor-grabbing");
      expect(wrapper).not.toHaveClass("cursor-grab");
    });
  });

  describe("post-drag click guard", () => {
    test("lets a click through normally when the card was not the one just dragged", () => {
      renderBoard([
        artifact({ id: "a-1", title: "Click card", type: NON_DOCUMENT_TYPE }),
      ]);

      const anchor = screen.getByText("Click card").closest("a");
      if (!anchor) {
        throw new Error("Expected the card's title to be wrapped in a link");
      }
      expect(fireEvent.click(anchor)).toBe(true);
    });

    test("swallows the click that immediately follows a drag on the same card, then resets", () => {
      renderBoard([
        artifact({ id: "a-1", title: "Click card", type: NON_DOCUMENT_TYPE }),
      ]);

      act(() => {
        capturedDragStart?.(dragStartEvent("a-1"));
      });

      // The drag overlay now renders a second "Click card" (the drag
      // preview); the lane card is the first one in document order.
      const anchor = screen.getAllByText("Click card")[0].closest("a");
      if (!anchor) {
        throw new Error("Expected the card's title to be wrapped in a link");
      }
      expect(fireEvent.click(anchor)).toBe(false);
      // The guard resets the ref on the swallowed click, so an immediate
      // second click on the same card is no longer treated as post-drag.
      expect(fireEvent.click(anchor)).toBe(true);
    });
  });
});

function dragEndEvent(activeId: string, overId: string | null): DragEndEvent {
  return {
    active: { id: activeId },
    over: overId === null ? null : { id: overId },
  } as unknown as DragEndEvent;
}

// An optional invocation would let the no-write guard cases pass even if
// DndContext never received the production onDragEnd handler at all.
function requireDragEnd(): (event: DragEndEvent) => void {
  if (!capturedDragEnd) {
    throw new Error("DndContext was never given an onDragEnd handler");
  }
  return capturedDragEnd;
}

function dragStartEvent(activeId: string): DragStartEvent {
  return {
    active: { id: activeId },
  } as unknown as DragStartEvent;
}

function renderBoard(
  artifacts: DocumentRowData[],
  options: {
    queryClient?: QueryClient;
    assigneeId?: string | null;
    isLoading?: boolean;
    isUserLoading?: boolean;
  } = {}
) {
  const queryClient =
    options.queryClient ??
    new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MyTasksKanban
        artifacts={artifacts}
        assigneeId={
          options.assigneeId === undefined ? "user-1" : options.assigneeId
        }
        isLoading={options.isLoading ?? false}
        isUserLoading={options.isUserLoading ?? false}
        pageQueryKey={PAGE_QUERY_KEY}
      />
    </QueryClientProvider>
  );
}

function artifact(overrides: Partial<DocumentRowData>): DocumentRowData {
  return {
    id: "artifact-1",
    slug: "DOC-1",
    title: "Artifact",
    type: DocumentType.Doc,
    status: DocumentStatus.Draft,
    priority: null,
    assigneeId: null,
    assignee: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    projectId: "project-1",
    sortOrder: 0,
    tags: [],
    project: null,
    ...overrides,
  } as DocumentRowData;
}
