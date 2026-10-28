import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import {
  type DocumentRowData,
  documentRowStatusEvidence,
} from "@repo/app/documents/lib/artifact-row-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  DOCUMENT_STATUS_LABELS,
  ISSUE_STATUS_LABELS,
} from "@repo/app/shared/lib/artifact-status-labels";
import {
  ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY,
  ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { PRIORITY_LABEL_NONE } from "@repo/design-system/lib/priority-order";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MyTasksKanban } from "../my-tasks-kanban";

/**
 * ISS-6721: the board's own column-assignment and drag-resolution logic had no
 * coverage — both suites that reference it (`my-tasks-assigned-tree-gate`,
 * `my-tasks-loading`) `vi.mock` it to `<div data-testid="kanban" />`.
 *
 * Every assertion below is on card IDENTITY per column, never per-column
 * counts: a card rendered in the WRONG column with the right total passes a
 * count assertion, which is the exact false green this ticket names.
 */

// Built from the canonical key factory, not a literal: the revert assertion
// below asserts `documentKeys.lists()`, and a hand-rolled page key could stop
// prefix-matching it without either half of the pair noticing.
const PAGE_QUERY_KEY = documentKeys.list({ assigneeId: "user-1" });

// ISS-7746 name queries, at module scope per `useTopLevelRegex`. `\b` around the
// initials keeps the negative from matching an "al" occurring inside another
// word of the card's accessible name.
const RE_ASSIGNED_NAME = /Ada Lovelace/;
const RE_FALLBACK_INITIALS = /\bAL\b/;

/**
 * ISS-9560's word, and the full accessible name the per-type status icon gives
 * a status it does not recognize. Hand-written oracles — reading them back out
 * of the display module the board resolves them from would let the copy be
 * replaced with garbage and leave this file green.
 */
const UNKNOWN_STATUS_WORD = "Unknown";
const UNKNOWN_ICON_NAME =
  "Unknown, This app version does not recognize this artifact's status. The work may still be in progress.";

const mutateMock = vi.fn();

// dnd-kit resolves drops through pointer sensors and a collision detector that
// jsdom cannot drive (no layout, no pointer capture). The logic under test is
// the board's OWN drag callbacks — which column an `over` id resolves to, which
// status that means for THIS artifact's type, what happens when the write
// fails, and what the DragOverlay's preview card renders — so the context is
// doubled purely to hand those callbacks back to the test. The
// droppable/draggable hooks stay inert so the real columns and cards still
// render and can be asserted by identity.
let capturedDragEnd: ((event: DragEndEvent) => void) | undefined;
let capturedDragStart: ((event: DragStartEvent) => void) | undefined;
/** Reset per test by `beforeEach`; read by the feature-flag mock below. */
let priorityGateOpen = false;

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
    setNodeRef: () => {
      // no-op: jsdom has no layout for dnd-kit to measure
    },
    transform: null,
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

// The card's AssigneeAvatar builds an org-scoped href off the route params, so
// the board cannot render without one.
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

// The board's ScrollArea measures itself with ResizeObserver, which jsdom does
// not implement.
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

describe("MyTasksKanban", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    mutateMock.mockReset();
    capturedDragEnd = undefined;
    priorityGateOpen = false;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("places each artifact in the column its own status vocabulary maps to", () => {
    // Documents and Features carry disjoint status vocabularies (PRD-495) that
    // share columns. A regression that groups by the wrong vocabulary lands a
    // card under a plausible neighbouring heading — visible only if the
    // assertion names WHICH card is under WHICH heading.
    renderBoard([
      artifact({
        id: "a-draft",
        title: "Draft doc",
        status: DocumentStatus.Draft,
      }),
      artifact({
        id: "a-todo",
        title: "Todo issue",
        status: IssueStatus.Todo,
        type: DocumentType.Feature,
      }),
      artifact({
        id: "a-review-doc",
        title: "Doc in review",
        status: DocumentStatus.InReview,
      }),
      artifact({
        id: "a-blocked",
        title: "Blocked issue",
        status: IssueStatus.Blocked,
        type: DocumentType.Feature,
      }),
      artifact({
        id: "a-changes",
        title: "Changes requested doc",
        status: DocumentStatus.ChangesRequested,
      }),
      artifact({
        id: "a-approved",
        title: "Approved doc",
        status: DocumentStatus.Approved,
      }),
      artifact({
        id: "a-done",
        title: "Done issue",
        status: IssueStatus.Done,
        type: DocumentType.Feature,
      }),
    ]);

    expect(
      within(columnFor("Backlog")).getByText("Draft doc")
    ).toBeInTheDocument();
    expect(
      within(columnFor("To Do")).getByText("Todo issue")
    ).toBeInTheDocument();
    expect(
      within(columnFor("In Review")).getByText("Doc in review")
    ).toBeInTheDocument();
    // The shared column: a Feature's BLOCKED and a Document's CHANGES_REQUESTED
    // are the same column, and both must be in it.
    expect(
      within(columnFor("Blocked / Changes")).getByText("Blocked issue")
    ).toBeInTheDocument();
    expect(
      within(columnFor("Blocked / Changes")).getByText("Changes requested doc")
    ).toBeInTheDocument();
    expect(
      within(columnFor("Approved")).getByText("Approved doc")
    ).toBeInTheDocument();
    expect(
      within(columnFor("Done")).getByText("Done issue")
    ).toBeInTheDocument();
    // Negative side of the mapping: the Feature-only "Done" column must not also
    // be where an approved Document landed.
    expect(within(columnFor("Done")).queryByText("Approved doc")).toBeNull();
  });

  test("writes a dropped Document the Document vocabulary's status for that column", () => {
    // "Backlog" is deliberately the column under test: it is one of the few
    // where the two vocabularies genuinely DIVERGE (Document → DRAFT, Feature →
    // BACKLOG). Most shared columns collapse to the same literal — IN_REVIEW is
    // the same string in both — so a drop there cannot tell a type-aware
    // mapping from a type-blind one.
    renderBoard([
      artifact({
        id: "a-1",
        title: "Doc in review",
        status: DocumentStatus.InReview,
      }),
    ]);

    capturedDragEnd?.(dragEvent("a-1", "backlog"));

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock.mock.calls[0][0]).toEqual({
      expectedStatus: DocumentStatus.InReview,
      id: "a-1",
      status: DocumentStatus.Draft,
      surface: ArtifactStatusEditSurface.Board,
    });
  });

  test("writes a dropped Feature the Issue vocabulary's status for the same column", () => {
    // The other half of the divergence: the identical drop target must resolve
    // to BACKLOG for a Feature. Asserted separately so a mapping that collapsed
    // both types onto one vocabulary fails here whichever one it picked.
    renderBoard([
      artifact({
        id: "a-1",
        title: "Todo issue",
        status: IssueStatus.Todo,
        type: DocumentType.Feature,
      }),
    ]);

    capturedDragEnd?.(dragEvent("a-1", "backlog"));

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock.mock.calls[0][0]).toEqual({
      expectedStatus: IssueStatus.Todo,
      id: "a-1",
      status: IssueStatus.Backlog,
      surface: ArtifactStatusEditSurface.Board,
    });
  });

  test("resolves a drop onto another card to that card's column", () => {
    renderBoard([
      artifact({ id: "a-1", title: "Draft doc", status: DocumentStatus.Draft }),
      artifact({
        id: "a-2",
        title: "Approved doc",
        status: DocumentStatus.Approved,
      }),
    ]);

    // `over.id` is a sibling CARD id, not a column id — the board must walk it
    // back to the column that card lives in rather than treating the drop as
    // unresolvable.
    capturedDragEnd?.(dragEvent("a-1", "a-2"));

    expect(mutateMock.mock.calls[0][0]).toEqual({
      expectedStatus: DocumentStatus.Draft,
      id: "a-1",
      status: DocumentStatus.Approved,
      surface: ArtifactStatusEditSurface.Board,
    });
  });

  test("makes no write for a column with no target in the dragged type's vocabulary", () => {
    renderBoard([
      artifact({ id: "a-1", title: "Draft doc", status: DocumentStatus.Draft }),
    ]);

    // Documents have no "Done"; their terminal sign-off is "Approved". Writing
    // Approved here would set a status the user did not choose and teleport the
    // card to a third column, so the drop must be a no-op.
    capturedDragEnd?.(dragEvent("a-1", "done"));

    expect(mutateMock).not.toHaveBeenCalled();
  });

  test("makes no optimistic write when prior raw status evidence is blank", () => {
    renderBoard([
      artifact({
        id: "a-1",
        rawStatus: "",
        status: DocumentStatus.Draft,
        title: "Blank-evidence doc",
      }),
    ]);

    capturedDragEnd?.(dragEvent("a-1", "approved"));

    expect(mutateMock).not.toHaveBeenCalled();
  });

  test("updates retained status evidence before the optimistic write settles", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(PAGE_QUERY_KEY, {
      items: [
        artifact({
          id: "a-1",
          rawStatus: DocumentStatus.Draft,
          title: "Draft doc",
          status: DocumentStatus.Draft,
        }),
      ],
      total: 7,
      limit: 50,
      offset: 0,
      hasMore: false,
    });

    renderBoard(
      [
        artifact({
          id: "a-1",
          rawStatus: DocumentStatus.Draft,
          title: "Draft doc",
          status: DocumentStatus.Draft,
        }),
      ],
      queryClient
    );

    capturedDragEnd?.(dragEvent("a-1", "approved"));

    const cached = queryClient.getQueryData(PAGE_QUERY_KEY) as {
      items: DocumentRowData[];
      total: number;
    };
    expect(cached.items[0].rawStatus).toBe(DocumentStatus.Approved);
    expect(cached.items[0].status).toBe(DocumentStatus.Approved);
    expect(documentRowStatusEvidence(cached.items[0])).toBe(
      DocumentStatus.Approved
    );
    // A status change moves a card between columns; it does not change how many
    // tasks exist, so the server total must survive the optimistic patch.
    expect(cached.total).toBe(7);
  });

  test("invalidates the list so a rejected move reverts instead of staying moved", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderBoard(
      [
        artifact({
          id: "a-1",
          title: "Draft doc",
          status: DocumentStatus.Draft,
        }),
      ],
      queryClient
    );

    capturedDragEnd?.(dragEvent("a-1", "approved"));

    // Without this the optimistic write is never rolled back: the card sits in
    // the column the server refused, and the board silently disagrees with the
    // backend until an unrelated refetch happens to correct it.
    const onError = mutateMock.mock.calls[0][1]?.onError;
    expect(onError).toBeTypeOf("function");
    invalidateSpy.mockClear();
    onError(new Error("rejected"));
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: documentKeys.lists(),
    });
  });

  test("shows the signed-out prompt rather than an empty board when no assignee resolves", () => {
    renderBoard(
      [
        artifact({
          id: "a-1",
          title: "Draft doc",
          status: DocumentStatus.Draft,
        }),
      ],
      undefined,
      { assigneeId: null }
    );

    // "No assignee" is not "no tasks" — an empty board would read as a finished
    // queue to a user who is simply not signed in.
    expect(
      screen.getByText("Sign in to see your assigned tasks.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Draft doc")).toBeNull();
  });

  // ISS-7746: the card's AssigneeAvatar states WHO the artifact belongs to. It
  // used to say so only in a hover Tooltip, and this board suppresses that
  // tooltip, so before the fix a card announced its assignee as the fallback
  // initials or, unassigned, as nothing at all. Asserted through the
  // accessibility tree: `data-slot` does not survive the trigger merge and
  // Radix AvatarImage never mounts in jsdom, so neither can be observed here.
  test("says who each card is assigned to without hovering it", () => {
    renderBoard([
      artifact({
        assignee: {
          id: "user-1",
          email: "ada@example.com",
          firstName: "Ada",
          lastName: "Lovelace",
          avatarUrl: null,
        },
        assigneeId: "user-1",
        id: "a-assigned",
        status: DocumentStatus.Draft,
        title: "Assigned doc",
      }),
      artifact({
        id: "a-unassigned",
        status: DocumentStatus.Approved,
        title: "Unassigned doc",
      }),
    ]);

    const backlog = columnFor("Backlog");
    expect(
      within(backlog).getByRole("img", { name: "Ada Lovelace" })
    ).toBeInTheDocument();
    // The visible footer label is the FIRST name only, so the avatar's name is
    // the sole place the surname is stated on this board.
    expect(within(backlog).getByText("Ada")).toBeInTheDocument();

    // The avatar is not its own link here — `MyTasksCard` already wraps the
    // whole card in one and passes `disableAvatarLink` so a second anchor is
    // never nested inside it — so the card's link is what a reader actually
    // lands on, and its name is computed from the card's contents. That makes
    // this the same regression stated on the element that exists: before the fix
    // the avatar folded its fallback initials into that name, and the card
    // announced "…AL" instead of a person. Both assertions run against the SAME
    // locator, so neither can pass by selecting nothing.
    expect(
      within(backlog).getByRole("link", { name: RE_ASSIGNED_NAME })
    ).toBeInTheDocument();
    expect(
      within(backlog).queryByRole("link", { name: RE_FALLBACK_INITIALS })
    ).toBeNull();

    expect(
      within(columnFor("Approved")).getByRole("img", { name: "Unassigned" })
    ).toBeInTheDocument();
  });

  describe("the priority chip", () => {
    // ISS-9094 review (marisolashgrove): with the gate open, an unset priority went
    // through `priorityLabel()` and came back "No priority", which the card
    // renders as an accent Chip like any other truthy label. So opening the flag
    // GREW a chip on exactly the cards that had nothing to say.
    test("stays absent for an artifact with no priority, gate open", () => {
      priorityGateOpen = true;

      renderBoard([artifact({ id: "no-priority", priority: null })]);

      expect(screen.queryByText(PRIORITY_LABEL_NONE)).not.toBeInTheDocument();
    });

    // The positive sibling: the same gate, the same locator, a row that DOES
    // have something to say still says it — so the assertion above is not
    // passing because the chip never renders at all.
    test("labels a set priority, gate open", () => {
      priorityGateOpen = true;

      renderBoard([artifact({ id: "urgent", priority: Priority.Urgent })]);

      expect(screen.getByText("Urgent")).toBeInTheDocument();
    });

    // Gate closed the board printed the raw enum, and must keep doing so.
    test("prints the raw enum member with the gate closed", () => {
      renderBoard([artifact({ id: "urgent", priority: Priority.Urgent })]);

      expect(screen.getByText("URGENT")).toBeInTheDocument();
    });

    test("resolves the drag preview's priority chip too, not only the lane card", () => {
      priorityGateOpen = true;

      renderBoard([
        artifact({
          id: "urgent",
          priority: Priority.Urgent,
          title: "Priority preview",
        }),
      ]);

      act(() => {
        capturedDragStart?.(dragStartEvent("urgent"));
      });

      expect(screen.getAllByText("Priority preview")).toHaveLength(2);
      expect(screen.getAllByText("Urgent")).toHaveLength(2);
      expect(screen.queryByText(Priority.Urgent)).toBeNull();
    });
  });
});

/**
 * ISS-9560. The board passed `artifact.status` straight into a visible `Chip`,
 * so every card read a raw database token where the rest of the product reads
 * words. Both card components on this board resolve the chip through
 * `useKanbanStatusLabel`, and both are covered here — the lane card by default,
 * and the DragOverlay's preview by the case that drives `onDragStart`, because
 * it is a second call site that never mounts without one. The gate is what the
 * assertions swap on.
 *
 * The priority-chip resolver is covered separately above; these cases stay on
 * status so the two gates can fail independently.
 */
describe("MyTasksKanban status chip", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders the canonical status words, not the wire token, when the gate is open", () => {
    renderGatedBoard([
      artifact({
        id: "a-changes",
        title: "Changes requested doc",
        status: DocumentStatus.ChangesRequested,
      }),
    ]);

    const card = within(columnFor("Blocked / Changes"));
    expect(
      card.getByText(DOCUMENT_STATUS_LABELS[DocumentStatus.ChangesRequested])
    ).toBeInTheDocument();
    expect(card.queryByText(DocumentStatus.ChangesRequested)).toBeNull();
  });

  test("reads each artifact's own vocabulary on a mixed board", () => {
    // Documents and Issues are disjoint vocabularies that share this board, so a
    // lookup against one of them alone would leave the other's cards raw.
    // Statuses chosen so no chip's words collide with a COLUMN heading, which
    // would make the assertion ambiguous rather than wrong.
    renderGatedBoard([
      artifact({
        id: "a-draft-doc",
        title: "Draft doc",
        status: DocumentStatus.Draft,
      }),
      artifact({
        id: "a-blocked",
        title: "Blocked issue",
        status: IssueStatus.Blocked,
        type: DocumentType.Feature,
      }),
    ]);

    expect(within(columnFor("Backlog")).getByText("Draft")).toBeInTheDocument();
    expect(
      within(columnFor("Blocked / Changes")).getByText("Blocked")
    ).toBeInTheDocument();
    expect(screen.queryByText(DocumentStatus.Draft)).toBeNull();
    expect(screen.queryByText(IssueStatus.Blocked)).toBeNull();
  });

  test("keeps printing the wire token while the gate is shut", () => {
    // ISS-4779 closed-by-default: the perceivable change must not reach a user
    // without the flag.
    renderBoard([
      artifact({
        id: "a-changes",
        title: "Changes requested doc",
        status: DocumentStatus.ChangesRequested,
      }),
    ]);

    const card = within(columnFor("Blocked / Changes"));
    expect(card.getByText(DocumentStatus.ChangesRequested)).toBeInTheDocument();
    expect(
      card.queryByText(DOCUMENT_STATUS_LABELS[DocumentStatus.ChangesRequested])
    ).toBeNull();
  });

  test("resolves the drag preview's chip too, not only the lane card", () => {
    // `KanbanCardPreview` is a SECOND call site of `useKanbanStatusLabel`, and
    // it mounts only once a drag starts — so with `onDragStart` never driven,
    // reverting ITS wiring to the raw `artifact.status` left every assertion in
    // this block green (review of this chunk). After the drag both cards are on
    // screen, so the canonical words must appear TWICE.
    renderGatedBoard([
      artifact({
        id: "a-changes",
        title: "Changes requested doc",
        status: DocumentStatus.ChangesRequested,
      }),
    ]);

    act(() => {
      capturedDragStart?.(dragStartEvent("a-changes"));
    });

    // The preview really did mount — without this the pair below would be
    // satisfied by the lane card alone if `getAllByText` returned one element.
    expect(screen.getAllByText("Changes requested doc")).toHaveLength(2);
    expect(
      screen.getAllByText(
        DOCUMENT_STATUS_LABELS[DocumentStatus.ChangesRequested]
      )
    ).toHaveLength(2);
    expect(screen.queryByText(DocumentStatus.ChangesRequested)).toBeNull();
  });

  test("agrees with the card's own status icon on a status its vocabulary lacks", () => {
    // `DISPLAY_GROUPS` mixes both vocabularies into one column, so a Document
    // reaches this board carrying an Issue status. The chip resolves through the
    // card's OWN vocabulary — the one the icon beside it already uses — so the
    // two halves of one card cannot state different things about one value:
    // resolving the chip through the COMBINED map read "Triage" beside an icon
    // announcing "Unknown, <sentence>" (review of this chunk).
    renderGatedBoard([
      artifact({
        id: "a-skewed",
        title: "Doc carrying an issue status",
        status: IssueStatus.Triage,
      }),
    ]);

    const card = within(columnFor("Backlog"));
    expect(card.getByText(UNKNOWN_STATUS_WORD)).toBeInTheDocument();
    expect(
      card.queryByText(ISSUE_STATUS_LABELS[IssueStatus.Triage])
    ).toBeNull();
    expect(card.getByLabelText(UNKNOWN_ICON_NAME)).toBeInTheDocument();
  });

  test("says Unknown for a Feature carrying a Document status, not the Document word", () => {
    // The MIRROR of the case above, and the fixture `e2e/my-tasks-status-label-
    // honesty.spec.ts` drives through the browser. That spec cannot run on this
    // machine, so the premise it rests on is pinned here where it does run: a
    // Feature whose status is `CHANGES_REQUESTED` lands in "Blocked / Changes"
    // (the column filters on status alone, without regard to type) and resolves
    // through ISSUE_STATUS_LABELS, which has no such key. Reading the COMBINED
    // map instead would answer "Changes Requested" here.
    renderGatedBoard([
      artifact({
        id: "a-skewed-feature",
        title: "Feature carrying a document status",
        status: DocumentStatus.ChangesRequested,
        type: DocumentType.Feature,
      }),
    ]);

    const card = within(columnFor("Blocked / Changes"));
    expect(card.getByText(UNKNOWN_STATUS_WORD)).toBeInTheDocument();
    expect(
      card.queryByText(DOCUMENT_STATUS_LABELS[DocumentStatus.ChangesRequested])
    ).toBeNull();
    expect(card.queryByText(DocumentStatus.ChangesRequested)).toBeNull();
    expect(card.getByLabelText(UNKNOWN_ICON_NAME)).toBeInTheDocument();
  });
});

function columnFor(label: string): HTMLElement {
  // The column heading and its cards share the KanbanColumn container; walk up
  // from the heading rather than relying on a test id the component does not
  // expose.
  const heading = screen.getByText(label);
  const column = heading.closest("div.flex.min-h-0");
  if (!column) {
    throw new Error(`No column container found for "${label}"`);
  }
  return column as HTMLElement;
}

function dragEvent(activeId: string, overId: string): DragEndEvent {
  return {
    active: { id: activeId },
    over: { id: overId },
  } as unknown as DragEndEvent;
}

function dragStartEvent(activeId: string): DragStartEvent {
  return { active: { id: activeId } } as unknown as DragStartEvent;
}

/**
 * The adapter both renderers mount. `priorityGateOpen` is module state the
 * priority cases swap per test; `extraFlags` carries whatever a renderer wants
 * resolved ON for its own reason.
 *
 * Both gates resolve through the REAL adapter deliberately. While ISS-9094 and
 * ISS-9560 were separate branches this file mocked
 * `use-feature-flag-enabled` wholesale, so ONE boolean answered for EVERY key:
 * after the merge the priority gate was also deciding the status chip, and the
 * five status cases failed because nothing opened the key they name. A gate
 * that ignores which key it was asked about cannot fail honestly.
 */
function flagAdapter(extraFlags: readonly string[] = []) {
  return createStaticFeatureFlagAdapter({
    enabledFlags: [
      ...extraFlags,
      ...(priorityGateOpen
        ? [ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY]
        : []),
    ],
  });
}

function renderBoard(
  artifacts: DocumentRowData[],
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
  overrides: { assigneeId?: string | null } = {}
) {
  return render(
    <FeatureFlagAdapterProvider adapter={flagAdapter()}>
      <QueryClientProvider client={queryClient}>
        <MyTasksKanban
          artifacts={artifacts}
          assigneeId={
            overrides.assigneeId === undefined ? "user-1" : overrides.assigneeId
          }
          isLoading={false}
          isUserLoading={false}
          pageQueryKey={PAGE_QUERY_KEY}
        />
      </QueryClientProvider>
    </FeatureFlagAdapterProvider>
  );
}

/** The board with `artifact-status-label-honesty` resolved ON for this render. */
function renderGatedBoard(artifacts: DocumentRowData[]) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={flagAdapter([ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY])}
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
