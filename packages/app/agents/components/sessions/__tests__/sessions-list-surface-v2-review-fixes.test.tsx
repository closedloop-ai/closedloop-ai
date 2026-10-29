import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { pinSessionFixtureClock } from "@repo/app/test/mocks/session-fixture-clock";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import type { TableBulkActionDescriptor } from "@repo/design-system/components/ui/table-bulk-actions";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FolderPlusIcon } from "lucide-react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { sessionsBulkPickerAction } from "../sessions-bulk-picker-action";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import { SessionsBulkRail } from "./sessions-selection.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

const TOAST_ERROR = vi.hoisted(() => vi.fn());
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: TOAST_ERROR, success: vi.fn() },
}));

const ROWS = [
  createSessionTableRowFixture({ id: "session-1", name: "session/one" }),
  createSessionTableRowFixture({ id: "session-2", name: "session/two" }),
];

const CREATE_OPTION_PATTERN = /Create “Brand new”/;

pinSessionFixtureClock();

describe("Sessions v2 review fixes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TOAST_ERROR.mockClear();
  });

  /**
   * davetho review: the favorite track is a real grid column, so it owns a
   * `columnheader`, and that header must say what the track does. It used to be
   * handed an `aria-hidden` placeholder, which WON over `GridTableV2`'s labelled
   * `sr-only` fallback and left the header with no accessible name at all.
   */
  it("names the favorite column header", () => {
    stubContainerWidthPx(1400);
    render(<FavoritesHarness />);

    const headerRow = screen.getAllByRole("row")[0];
    if (!headerRow) {
      throw new Error("expected a header row");
    }
    const headers = within(headerRow).getAllByRole("columnheader");

    expect(headers.map((header) => header.textContent?.trim())).toContain(
      "Favorite"
    );
  });

  /**
   * The ungrouped inline-create row's context is `{}`, so comparing it against a
   * NULL active context through optional chaining matched `undefined ===
   * undefined` on both halves and reported the row active on first paint: the
   * name input replaced the "Add session" affordance and nothing could get it
   * back.
   */
  it("starts the inline-create row on its Add session affordance", async () => {
    stubContainerWidthPx(1400);
    render(<FavoritesHarness />);

    const addSession = screen.getByRole("button", { name: "Add session" });
    expect(addSession).toBeVisible();
    expect(
      screen.queryByRole("textbox", { name: "Add session name" })
    ).toBeNull();

    await userEvent.click(addSession);
    expect(
      screen.getByRole("textbox", { name: "Add session name" })
    ).toBeVisible();
  });

  /**
   * tamsinb review: `onCreateOption` is the host's mutation. An `async` React
   * onClick turned a rejection into an unhandled promise rejection that the
   * reader never saw.
   */
  it("reports a rejected option creation instead of throwing past React", async () => {
    const rejection = new Error("nope");
    const onCreateOption = vi.fn(() => Promise.reject(rejection));
    const unhandled = vi.fn();
    globalThis.addEventListener("unhandledrejection", unhandled);

    render(
      <SessionsBulkRail
        actions={bulkActions(onCreateOption)}
        onClear={() => undefined}
        onRetainSelection={() => undefined}
        selectedRows={ROWS}
      />
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Add to project" })
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Search add to project" }),
      "Brand new"
    );
    await userEvent.click(
      screen.getByRole("button", { name: CREATE_OPTION_PATTERN })
    );

    await waitFor(() =>
      expect(onCreateOption).toHaveBeenCalledWith("Brand new")
    );
    await waitFor(() =>
      expect(TOAST_ERROR).toHaveBeenCalledWith("Couldn't create add to project")
    );
    expect(unhandled).not.toHaveBeenCalled();
    globalThis.removeEventListener("unhandledrejection", unhandled);
  });
});

function bulkActions(
  onCreateOption: () => Promise<never>
): readonly TableBulkActionDescriptor[] {
  return [
    sessionsBulkPickerAction({
      command: {
        onApply: () => () => undefined,
        onCreateOption,
        options: [{ id: "platform", label: "Platform" }],
      },
      icon: <FolderPlusIcon />,
      id: "projects",
      label: "Add to project",
    }),
  ];
}

function FavoritesHarness() {
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  return (
    <SessionsListSurfaceV2
      favorites={{
        favoriteIds,
        onChange: (row: SessionTableRow, favorited: boolean) =>
          setFavoriteIds((current) => {
            const next = new Set(current);
            if (favorited) {
              next.add(row.id);
            } else {
              next.delete(row.id);
            }
            return next;
          }),
      }}
      inlineCreate={{ onCreate: () => undefined }}
      rows={ROWS}
      selection={{ onChange: setSelectedIds, selectedIds }}
      usage={undefined}
    />
  );
}
