/**
 * Behavior tests for the Kanban Board demo's drag resolution and overlay.
 *
 * The story sweep mounts this board, so the static render is already covered.
 * What nothing exercises is the half that only exists mid-drag: which column an
 * `over` id resolves to, what a drop outside any target does, and which card the
 * `DragOverlay` paints. dnd-kit resolves all of that through pointer sensors and
 * a collision detector jsdom cannot drive (no layout, no pointer capture), so
 * the context is doubled purely to hand `onDragStart` / `onDragEnd` back to the
 * test. The droppable and draggable hooks stay inert so the real columns and
 * cards still render and can be asserted by identity.
 *
 * Every assertion is on card IDENTITY per column, never on per-column counts: a
 * card that landed in the WRONG column with the right total passes a count
 * assertion, which is exactly the false green a drag test has to avoid.
 */
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { composeStory } from "@storybook/react";
import type { ReactNode } from "react";
import { act } from "react";
import { within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dnd = vi.hoisted(() => ({
  onDragEnd: null as ((event: DragEndEvent) => void) | null,
  onDragStart: null as ((event: DragStartEvent) => void) | null,
  /** The id `useDraggable` should report as mid-drag, or null for none. */
  draggingId: null as string | null,
}));

/** The translation dnd-kit hands a card while it is being dragged. */
const DRAG_TRANSFORM = { x: 24, y: 8, scaleX: 1, scaleY: 1 };

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragEnd,
    onDragStart,
  }: {
    children: ReactNode;
    onDragEnd: (event: DragEndEvent) => void;
    onDragStart: (event: DragStartEvent) => void;
  }) => {
    dnd.onDragEnd = onDragEnd;
    dnd.onDragStart = onDragStart;
    return <div>{children}</div>;
  },
  DragOverlay: ({ children }: { children: ReactNode }) => (
    <div data-testid="drag-overlay">{children}</div>
  ),
  PointerSensor: "PointerSensor",
  useDraggable: ({ id }: { id: string }) => {
    const isDragging = dnd.draggingId === String(id);
    return {
      attributes: {},
      isDragging,
      listeners: {},
      setNodeRef: () => {
        // no-op: jsdom has no layout for dnd-kit to measure
      },
      transform: isDragging ? DRAG_TRANSFORM : null,
    };
  },
  useDroppable: () => ({
    isOver: false,
    setNodeRef: () => {
      // no-op: jsdom has no layout for dnd-kit to measure
    },
  }),
  useSensor: (sensor: unknown) => sensor,
  useSensors: (...sensors: unknown[]) => sensors,
}));

const kanbanMeta = await import("../stories/kanban-board.stories");
const Default = composeStory(kanbanMeta.Default, kanbanMeta.default);

const COLUMN_TITLES = ["Queued", "Active", "Review", "Done"] as const;

/**
 * Board item id → a string that item's card renders and no other card does.
 * Session cards print `session.id`, agent cards their name, artifact cards their
 * slug — so a card is located by its own content rather than by position.
 */
const CARD_TEXT: Readonly<Record<string, string>> = {
  "session-sess-1": "sess-1",
  "session-sess-2": "sess-2",
  "session-sess-3": "sess-3",
  "agent-agent-main": "Main Agent",
  "agent-agent-review": "Review Worker",
  "agent-agent-verify": "Verification Agent",
  "artifact-prd": "prd-423",
  "artifact-spec": "spec-kanban-cards",
  "artifact-workflow": "workflow-viz-adoption",
};

/** The board as it starts, so a no-op drop can be asserted against it. */
const INITIAL_BOARD: Readonly<Record<string, string[]>> = {
  Queued: ["session-sess-1", "artifact-spec"],
  Active: ["session-sess-2", "agent-agent-main"],
  Review: ["session-sess-3", "agent-agent-review", "artifact-prd"],
  Done: ["agent-agent-verify", "artifact-workflow"],
};

/**
 * The four column containers in painted order. `KanbanColumnLayout` gives each
 * one a fixed 280px track; the drag overlay borrows the same width but not the
 * `shrink-0` beside it, which is why both classes are required here. The length
 * assertion is the tripwire: a layout change that drops either class fails loudly
 * instead of silently returning an empty board.
 */
function columnRoots(): HTMLElement[] {
  const roots = Array.from(document.querySelectorAll("div")).filter(
    (element) =>
      element.classList.contains("w-[280px]") &&
      element.classList.contains("shrink-0")
  );
  if (roots.length !== COLUMN_TITLES.length) {
    throw new Error(
      `expected ${COLUMN_TITLES.length} columns, found ${roots.length}`
    );
  }
  return roots;
}

/** The board item a rendered card wrapper holds, by the text only it renders. */
function itemIdOf(card: HTMLElement): string {
  const entry = Object.entries(CARD_TEXT).find(
    ([, text]) => within(card).queryAllByText(text).length > 0
  );
  if (!entry) {
    throw new Error(
      `rendered card matched no known board item: ${card.textContent}`
    );
  }
  return entry[0];
}

/**
 * Column title → the ids of the cards painted inside it, in PAINTED order.
 * Order matters: the demo re-renders each column from one filtered list, so a
 * move that landed the card in the right column at the wrong index is a real
 * difference and must not pass.
 */
function board(): Record<string, string[]> {
  const roots = columnRoots();
  return Object.fromEntries(
    COLUMN_TITLES.map((title, index) => {
      const root = roots[index];
      if (!root) {
        throw new Error(`no column rendered at index ${index}`);
      }
      // Fails when the column at this index is not the one it is named for,
      // so a reordered board cannot silently pass a membership assertion.
      // Card text is excluded: a legacy `waiting` session displays "Active"
      // (ISS-10364), the same word as the Active column's title.
      const headings = within(root)
        .getAllByText(title)
        .filter((element) => element.closest(CARD_SELECTOR) === null);
      if (headings.length !== 1) {
        throw new Error(
          `column ${index} should be titled ${title}, found ${headings.length} titles`
        );
      }
      const cards = Array.from(
        root.querySelectorAll<HTMLElement>(CARD_SELECTOR)
      );
      return [title, cards.map(itemIdOf)];
    })
  );
}

/** The card element for `itemId`, read through the text only it renders. */
function cardFor(itemId: string): HTMLElement {
  const text = CARD_TEXT[itemId];
  if (text === undefined) {
    throw new Error(`no card text registered for ${itemId}`);
  }
  const [node] = within(document.body).getAllByText(text);
  const card = node?.closest(
    "div[style], div.cursor-grab, div.cursor-grabbing"
  );
  if (!(card instanceof HTMLElement)) {
    throw new Error(`no draggable wrapper around ${itemId}`);
  }
  return card;
}

async function startDrag(itemId: string): Promise<void> {
  dnd.draggingId = itemId;
  await act(() => {
    dnd.onDragStart?.({ active: { id: itemId } } as DragStartEvent);
  });
}

async function endDrag(overId: string | null): Promise<void> {
  const active = dnd.draggingId;
  await act(() => {
    dnd.onDragEnd?.({
      active: { id: active },
      over: overId === null ? null : { id: overId },
    } as DragEndEvent);
  });
  dnd.draggingId = null;
}

function overlay(): HTMLElement {
  return within(document.body).getByTestId("drag-overlay");
}

const SELECTED_READOUT_PATTERN = /^Selected:/;
/** A rendered card wrapper, idle or mid-drag. */
const CARD_SELECTOR = "div.cursor-grab, div.cursor-grabbing";
const ACT_ENVIRONMENT_KEY = "IS_REACT_ACT_ENVIRONMENT";
let actEnvironmentWasSet = false;
let previousActEnvironment: unknown;

describe("kanban board demo", () => {
  beforeEach(async () => {
    // The drag callbacks are invoked outside React's own event dispatch, so
    // `act` has to be told this is a test environment or every flush warns.
    actEnvironmentWasSet = Object.hasOwn(globalThis, ACT_ENVIRONMENT_KEY);
    previousActEnvironment = Reflect.get(globalThis, ACT_ENVIRONMENT_KEY);
    Reflect.set(globalThis, ACT_ENVIRONMENT_KEY, true);
    dnd.draggingId = null;
    await Default.run();
  });

  afterEach(() => {
    if (actEnvironmentWasSet) {
      Reflect.set(globalThis, ACT_ENVIRONMENT_KEY, previousActEnvironment);
    } else {
      Reflect.deleteProperty(globalThis, ACT_ENVIRONMENT_KEY);
    }
    // No manual DOM teardown: stripping `document.body` left React holding a
    // root over detached nodes (ISS-9661). The project's `testingLibraryRender`
    // annotation unmounts the root instead, which is what drains its work.
    dnd.onDragEnd = null;
    dnd.onDragStart = null;
    dnd.draggingId = null;
  });

  it("paints every card in its starting column", () => {
    expect(board()).toEqual(INITIAL_BOARD);
  });

  it("moves a card to the column it is dropped on", async () => {
    await startDrag("artifact-spec");
    await endDrag("done");

    expect(board()).toEqual({
      ...INITIAL_BOARD,
      Queued: ["session-sess-1"],
      // The moved card keeps its slot in the board's own item list rather than
      // landing at the end of the column it joined.
      Done: ["agent-agent-verify", "artifact-spec", "artifact-workflow"],
    });
  });

  it("adopts the column of the CARD it is dropped on, not the card's slot", async () => {
    await startDrag("session-sess-1");
    // Dropped onto a card in Review, so the id resolves through that card's
    // `columnId` rather than through the column list.
    await endDrag("artifact-prd");

    expect(board()).toEqual({
      ...INITIAL_BOARD,
      Queued: ["artifact-spec"],
      Review: [
        "session-sess-1",
        "session-sess-3",
        "agent-agent-review",
        "artifact-prd",
      ],
    });
  });

  it("leaves the board unchanged when the card is dropped outside every target", async () => {
    await startDrag("artifact-spec");
    await endDrag(null);

    expect(board()).toEqual(INITIAL_BOARD);
  });

  it("leaves the board unchanged when the drop target is neither a column nor a card", async () => {
    await startDrag("artifact-spec");
    await endDrag("not-a-target");

    expect(board()).toEqual(INITIAL_BOARD);
  });

  it("clears the overlay after a drop so no card is painted twice", async () => {
    await startDrag("artifact-spec");
    expect(overlay().textContent).toContain("spec-kanban-cards");

    await endDrag("done");
    expect(overlay().textContent).toBe("");
  });

  it.each([
    ["a session", "session-sess-2", "sess-2"],
    ["an agent", "agent-agent-main", "Main Agent"],
    ["an artifact", "artifact-workflow", "workflow-viz-adoption"],
  ])("paints %s card into the drag overlay", async (_kind, itemId, text) => {
    await startDrag(itemId);

    expect(overlay().textContent).toContain(text);
  });

  it("renders the overlay artifact as a static preview, not as a clickable card", async () => {
    await startDrag("artifact-workflow");

    // The board's own artifact cards are wrapped in a button so a click selects
    // them; the overlay copy is handed no `onClick` and stays plain markup.
    expect(within(overlay()).queryByRole("button")).toBeNull();
    expect(
      within(cardFor("artifact-workflow")).getByRole("button")
    ).toBeVisible();
  });

  it("marks only the dragged card as grabbing and translates it", async () => {
    await startDrag("artifact-spec");

    const dragged = cardFor("artifact-spec");
    expect(dragged.className).toContain("cursor-grabbing");
    expect(dragged.className).toContain("opacity-40");
    expect(dragged.style.transform).toBe("translate3d(24px, 8px, 0)");

    const other = cardFor("session-sess-1");
    expect(other.className).toContain("cursor-grab");
    expect(other.className).not.toContain("cursor-grabbing");
    expect(other.style.transform).toBe("");
  });

  it("selects the card a drag starts on", async () => {
    expect(
      within(document.body).getByText(SELECTED_READOUT_PATTERN).textContent
    ).toBe("Selected: session-sess-1");

    await startDrag("agent-agent-verify");

    expect(
      within(document.body).getByText(SELECTED_READOUT_PATTERN).textContent
    ).toBe("Selected: agent-agent-verify");
  });
});
