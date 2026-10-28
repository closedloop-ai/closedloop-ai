import { expect, userEvent, within } from "storybook/test";

const TITLE_AWARE_DRAG_ANNOUNCEMENT =
  /^Draggable item Test PRD was moved over droppable area .+\.$/;
export const DRAG_REORDER_PATTERN = /^Drag to reorder /;

export async function showPlacementFailure({
  canvasElement,
}: {
  canvasElement: HTMLElement;
}) {
  const canvas = within(canvasElement);
  const handle = canvas.getAllByRole("button", {
    name: DRAG_REORDER_PATTERN,
  })[0];
  handle?.focus();
  await userEvent.keyboard("{Control>}{ArrowDown}{/Control}");
  const messages = await within(canvasElement.ownerDocument.body).findAllByText(
    "Failed to move items. Please try again."
  );
  await expect(messages.length).toBeGreaterThan(0);
}

export async function assertPlacementControlsHidden({
  canvas,
}: {
  canvas: ReturnType<typeof within>;
}) {
  await expect(
    canvas.queryByRole("button", { name: DRAG_REORDER_PATTERN })
  ).toBeNull();
  await expect(canvas.queryByRole("checkbox")).toBeNull();
}

export async function assertTitleAwareDragAnnouncement(
  canvasElement: HTMLElement,
  documentIds: readonly string[]
) {
  const status = await within(canvasElement.ownerDocument.body).findByRole(
    "status"
  );
  await expect(status).toHaveTextContent(TITLE_AWARE_DRAG_ANNOUNCEMENT);
  for (const id of documentIds) {
    await expect(status).not.toHaveTextContent(id);
  }
}

export async function beginPointerDrag(source: HTMLElement) {
  await userEvent.pointer([
    { keys: "[MouseLeft>]", target: source },
    { coords: { clientX: 8, clientY: 24 }, target: source },
  ]);
}

export async function beginPointerDragOver(
  source: HTMLElement,
  target: HTMLElement
) {
  layOutPointerRows(source);
  const targetRect = target.getBoundingClientRect();
  await userEvent.pointer([
    { keys: "[MouseLeft>]", target: source },
    { coords: { clientX: 8, clientY: 24 }, target: source },
    {
      coords: {
        clientX: targetRect.left + targetRect.width / 2,
        clientY: targetRect.bottom,
      },
      target,
    },
  ]);
}

export function layOutPointerRows(source: HTMLElement) {
  const rows = Array.from(
    source.ownerDocument.querySelectorAll<HTMLElement>(
      "[data-sortable-subtree-id]"
    )
  );
  if (rows[0]?.getBoundingClientRect().height !== 0) {
    return;
  }
  const topById = new Map([
    ["root", 0],
    ["child", 48],
    ["plan", 96],
  ]);
  for (const row of rows) {
    const top = topById.get(row.dataset.sortableSubtreeId ?? "");
    if (top === undefined) {
      continue;
    }
    const height = row.dataset.sortableSubtreeId === "root" ? 96 : 48;
    const box = (boxTop: number, boxHeight: number) =>
      ({
        x: 0,
        y: boxTop,
        top: boxTop,
        left: 0,
        right: 320,
        bottom: boxTop + boxHeight,
        width: 320,
        height: boxHeight,
        toJSON: () => undefined,
      }) as DOMRect;
    row.getBoundingClientRect = () => box(top, height);
    const root = row.firstElementChild;
    if (root instanceof HTMLElement) {
      root.getBoundingClientRect = () => box(top, 48);
    }
    const handle = row.querySelector<HTMLElement>(
      "[data-sortable-subtree-handle-id]"
    );
    if (handle) {
      handle.getBoundingClientRect = () => box(top, 48);
    }
  }
}

export async function commitPointerDrag(
  source: HTMLElement,
  target: HTMLElement
) {
  const targetRect = target.getBoundingClientRect();
  await userEvent.pointer([
    { keys: "[MouseLeft>]", target: source },
    { coords: { clientX: 8, clientY: 24 }, target: source },
    {
      coords: {
        clientX: targetRect.left + targetRect.width / 2,
        clientY: targetRect.bottom,
      },
      target,
    },
    { keys: "[/MouseLeft]", target },
  ]);
}

export async function assertPlacementAnnounced(canvasElement: HTMLElement) {
  const announcements = await within(
    canvasElement.ownerDocument.body
  ).findAllByText("Moved");
  await expect(
    announcements.some((announcement) => announcement.isConnected)
  ).toBe(true);
}

export function storyGridRow(
  canvasElement: HTMLElement,
  title: string
): HTMLElement {
  const row = within(canvasElement)
    .getByText(title)
    .closest<HTMLElement>("[data-grid-row]");
  if (!row) {
    throw new Error(`Documents story requires the ${title} row`);
  }
  return row;
}

export function storyRowAppearsBefore(
  canvasElement: HTMLElement,
  firstTitle: string,
  secondTitle: string
): boolean {
  const canvas = within(canvasElement);
  const firstRow = canvas
    .getByText(firstTitle)
    .closest<HTMLElement>("[role=row]");
  const secondRow = canvas
    .getByText(secondTitle)
    .closest<HTMLElement>("[role=row]");
  if (!(firstRow && secondRow)) {
    return false;
  }
  const renderedRows = [
    ...canvasElement.querySelectorAll<HTMLElement>("[role=row]"),
  ];
  return renderedRows.indexOf(firstRow) < renderedRows.indexOf(secondRow);
}

export async function openStoryRow(
  canvasElement: HTMLElement,
  title: string
): Promise<void> {
  const row = within(canvasElement)
    .getByText(title)
    .closest<HTMLElement>("[role=row]");
  if (!row) {
    throw new Error(`Hierarchy story requires the ${title} row`);
  }
  const disclosure = within(row).queryByRole("button", {
    name: "Show nested artifacts",
  });
  if (disclosure) {
    await userEvent.click(disclosure);
  }
}

/** The column dividers a row draws: every `border-l` box inside it. */
export function columnDividerCount(row: HTMLElement): number {
  return [row, ...row.querySelectorAll<HTMLElement>("*")].filter((element) =>
    element.classList.contains("border-l")
  ).length;
}

/**
 * At phone width the page and its container do not scroll sideways, and the
 * grid draws cards with no column header.
 */
export async function assertNarrowCardLayout(canvasElement: HTMLElement) {
  const page = canvasElement.ownerDocument.documentElement;
  await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
  const container = canvasElement.querySelector<HTMLElement>(
    "[data-testid='narrow-scroll-container']"
  );
  await expect(container?.scrollWidth ?? 0).toBeLessThanOrEqual(
    container?.clientWidth ?? 0
  );
  if ((container?.clientWidth ?? 0) > 0) {
    const cards = canvasElement.querySelectorAll('[data-slot="card"]');
    await expect(cards.length).toBeGreaterThan(0);
    await expect(within(canvasElement).queryByRole("columnheader")).toBeNull();
  }
}
