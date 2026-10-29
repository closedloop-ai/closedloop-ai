import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import {
  type DocumentStatusMutationCapability,
  DocumentStatusMutationOperation,
} from "@repo/api/src/types/document-status-mutation";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { DOCUMENT_STATUS_LABELS } from "@repo/app/shared/lib/artifact-status-labels";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MyTasksKanban } from "../my-tasks-kanban";

const PAGE_QUERY_KEY = documentKeys.list({ assigneeId: "user-1" });
const mutateMock = vi.fn();
let capturedDragEnd: ((event: DragEndEvent) => void) | undefined;
let capturedDragStart: ((event: DragStartEvent) => void) | undefined;

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
    isDragging: false,
    listeners: {},
    setNodeRef: () => undefined,
    transform: null,
  }),
  useDroppable: () => ({ isOver: false, setNodeRef: () => undefined }),
  useSensor: (sensor: unknown) => sensor,
  useSensors: (...sensors: unknown[]) => sensors,
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useUpdateDocument: () => ({ mutate: mutateMock }),
}));

vi.mock("@/hooks/use-org-slug", () => ({ useOrgSlug: () => "acme" }));

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
  disconnect() {}
  observe() {}
  unobserve() {}
}

describe("MyTasksKanban universal artifact status adoption", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    mutateMock.mockReset();
    capturedDragEnd = undefined;
    capturedDragStart = undefined;
  });

  afterEach(() => vi.unstubAllGlobals());

  test("keeps a mixed lane title and gives each card its own canonical status", () => {
    renderUniversalBoard([
      artifact({
        id: "issue-blocked",
        status: IssueStatus.Blocked,
        title: "Blocked issue",
        type: DocumentType.Feature,
      }),
      artifact({
        id: "document-changes",
        status: DocumentStatus.ChangesRequested,
        title: "Changes requested document",
      }),
    ]);

    const lane = within(columnFor("Blocked / Changes"));
    expect(lane.getByText("Blocked issue")).toBeInTheDocument();
    expect(lane.getByText("Blocked")).toBeInTheDocument();
    expect(lane.getByText("Changes requested document")).toBeInTheDocument();
    expect(lane.getByText("Changes requested")).toBeInTheDocument();
  });

  test("uses the Document detail label on a mixed-vocabulary lane", () => {
    renderUniversalBoard([
      artifact({ id: "document-draft", title: "Draft document" }),
    ]);

    const lane = within(columnFor("Backlog"));
    expect(lane.getByText("Drafting")).toBeInTheDocument();
    expect(
      lane.queryByText(DOCUMENT_STATUS_LABELS[DocumentStatus.Draft])
    ).not.toBeInTheDocument();
  });

  test("states a homogeneous lane's status once", () => {
    renderUniversalBoard([
      artifact({
        id: "document-approved-a",
        status: DocumentStatus.Approved,
        title: "First approved document",
      }),
      artifact({
        id: "document-approved-b",
        status: DocumentStatus.Approved,
        title: "Second approved document",
      }),
    ]);

    const lane = within(columnFor("Approved"));
    expect(lane.getByText("First approved document")).toBeInTheDocument();
    expect(lane.getByText("Second approved document")).toBeInTheDocument();
    expect(lane.getAllByText("Approved")).toHaveLength(1);
  });

  test("uses the same canonical status in the drag preview", () => {
    renderUniversalBoard([
      artifact({ id: "preview-draft", title: "Draft preview" }),
    ]);
    act(() => capturedDragStart?.(dragStartEvent("preview-draft")));
    expect(screen.getAllByText("Draft preview")).toHaveLength(2);
    expect(screen.getAllByText("Drafting")).toHaveLength(2);
  });

  test("keeps future and null retained statuses in the Unknown lane", () => {
    renderUniversalBoard([
      artifact({
        id: "future-status",
        rawStatus: "FUTURE_STATUS",
        title: "Future status document",
      }),
      artifact({ id: "null-status", rawStatus: null, title: "Null status" }),
    ]);

    const lane = within(columnFor("Unknown"));
    expect(lane.getByText("Future status document")).toBeInTheDocument();
    expect(lane.getByText("Null status")).toBeInTheDocument();
  });

  test("refuses a drop over an Unknown-lane card", () => {
    renderUniversalBoard([
      artifact({ id: "dragged", title: "Dragged document" }),
      artifact({ id: "unknown-target", rawStatus: null, title: "Unknown" }),
    ]);

    capturedDragEnd?.(dragEvent("dragged", "unknown-target"));

    expect(mutateMock).not.toHaveBeenCalled();
  });

  test("refuses a drag when the producer denies single-status edits", () => {
    renderUniversalBoard([
      artifact({
        id: "denied-status",
        statusMutation: statusMutationCapability({
          permissions: {
            [DocumentStatusMutationOperation.Bulk]: true,
            [DocumentStatusMutationOperation.Single]: false,
          },
        }),
      }),
    ]);
    capturedDragEnd?.(dragEvent("denied-status", "approved"));
    expect(mutateMock).not.toHaveBeenCalled();
  });

  test("refuses a drag target outside the producer's allowed set", () => {
    renderUniversalBoard([
      artifact({
        id: "narrow-status",
        statusMutation: statusMutationCapability({
          allowedStatuses: [DocumentStatus.InReview],
        }),
      }),
    ]);
    capturedDragEnd?.(dragEvent("narrow-status", "approved"));
    expect(mutateMock).not.toHaveBeenCalled();
  });
});

function renderUniversalBoard(artifacts: DocumentRowData[]) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY],
      })}
    >
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MyTasksKanban
          artifacts={artifacts}
          assigneeId="user-1"
          isLoading={false}
          isUserLoading={false}
          pageQueryKey={PAGE_QUERY_KEY}
        />
      </QueryClientProvider>
    </FeatureFlagAdapterProvider>
  );
}

function columnFor(label: string): HTMLElement {
  const headerLabel = screen
    .getAllByText(label)
    .find((node) => node.closest("div.shrink-0.border-b"));
  const column = headerLabel?.closest("div.flex.min-h-0.shrink-0.flex-col");
  if (!column) {
    throw new Error(`No column container found for "${label}"`);
  }
  return column as HTMLElement;
}

function dragEvent(activeId: string, overId: string): DragEndEvent {
  return { active: { id: activeId }, over: { id: overId } } as DragEndEvent;
}

function dragStartEvent(activeId: string): DragStartEvent {
  return { active: { id: activeId } } as DragStartEvent;
}

function artifact(overrides: Partial<DocumentRowData>): DocumentRowData {
  return {
    assignee: null,
    assigneeId: null,
    createdAt: new Date("2026-01-01"),
    id: "artifact-1",
    priority: Priority.Medium,
    project: null,
    projectId: "project-1",
    slug: "DOC-1",
    sortOrder: 0,
    status: DocumentStatus.Draft,
    tags: [],
    title: "Artifact",
    type: DocumentType.Doc,
    updatedAt: new Date("2026-01-02"),
    ...overrides,
  } as DocumentRowData;
}

function statusMutationCapability(
  overrides: Partial<DocumentStatusMutationCapability> = {}
): DocumentStatusMutationCapability {
  return {
    allowedStatuses: [DocumentStatus.Draft, DocumentStatus.InReview],
    expectedStatusByIdField: "expectedStatusById",
    expectedStatusField: "expectedStatus",
    ...overrides,
  };
}
