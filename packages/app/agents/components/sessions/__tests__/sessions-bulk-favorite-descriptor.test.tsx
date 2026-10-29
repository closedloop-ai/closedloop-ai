import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { sessionsFavoriteBulkActions } from "../sessions-bulk-favorite-action";
import type { SessionsFavoriteController } from "../sessions-list-interactions";
import { SessionsBulkRail } from "./sessions-selection.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

/**
 * ISS-8942 — favouriting is a bulk-action DESCRIPTOR, not a case the rail
 * hardcodes. These pin the two things that must survive that move: the rail
 * withholds the action rather than deadening it, and the descriptor acts on the
 * selection it is handed.
 */

const ROWS = [
  createSessionTableRowFixture({ id: "session-1", name: "session/one" }),
  createSessionTableRowFixture({ id: "session-2", name: "session/two" }),
];
const CLEAR_NAME = /^Clear selection$/;
const FAVORITE_NAME = /^Favorite sessions$/;
const UNFAVORITE_NAME = /^Remove sessions from favorites$/;

function controller(
  overrides: Partial<SessionsFavoriteController> = {}
): SessionsFavoriteController {
  return {
    favoriteIds: new Set<string>(),
    onBulkChange: () => Promise.resolve(),
    onChange: () => undefined,
    ...overrides,
  };
}

function renderBar(favorites?: SessionsFavoriteController) {
  render(
    <SessionsBulkRail
      favorites={favorites}
      onClear={() => undefined}
      onRetainSelection={() => undefined}
      selectedRows={ROWS}
    />
  );
  return screen.getByRole("toolbar", { name: "2 sessions selected" });
}

describe("the Sessions favorite bulk action", () => {
  it("is present and operable when the host can batch favourites", () => {
    const toolbar = renderBar(controller());

    expect(
      within(toolbar).getByRole("button", { name: FAVORITE_NAME })
    ).toBeEnabled();
  });

  it("is ABSENT — not disabled — when the favourite list cannot be read", () => {
    const toolbar = renderBar(controller({ isUnavailable: true }));

    expect(within(toolbar).queryByRole("button", { name: FAVORITE_NAME })).toBe(
      null
    );
    // The rail itself still stands, so this is a withheld action rather than a
    // bar that failed to render.
    expect(
      within(toolbar).getByRole("button", { name: CLEAR_NAME })
    ).toBeVisible();
  });

  it("is ABSENT when the host has no batch seam", () => {
    const toolbar = renderBar(
      controller({ onBulkChange: undefined, favoriteIds: new Set(["other"]) })
    );

    expect(within(toolbar).queryByRole("button", { name: FAVORITE_NAME })).toBe(
      null
    );
    expect(
      within(toolbar).getByRole("button", { name: CLEAR_NAME })
    ).toBeVisible();
  });

  it("names the un-favourite direction when every selected row is favourited", () => {
    const toolbar = renderBar(
      controller({ favoriteIds: new Set(ROWS.map((row) => row.id)) })
    );

    const button = within(toolbar).getByRole("button", {
      name: UNFAVORITE_NAME,
    });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(within(toolbar).queryByRole("button", { name: FAVORITE_NAME })).toBe(
      null
    );
  });

  it("mutates exactly the rows the descriptor was handed, resolved from row ids", async () => {
    const user = userEvent.setup();
    const onBulkChange = vi.fn(
      (_rows: readonly SessionTableRow[], _favorited: boolean) =>
        Promise.resolve()
    );
    const [descriptor] = sessionsFavoriteBulkActions({
      favorites: controller({ onBulkChange }),
      rows: ROWS,
    });
    if (descriptor?.kind !== "command") {
      throw new Error("expected one command descriptor");
    }

    render(
      <button
        onClick={() =>
          descriptor.onSelect(["session-2"], {
            clear: () => undefined,
            retain: () => undefined,
          })
        }
        type="button"
      >
        run
      </button>
    );
    await user.click(screen.getByRole("button", { name: "run" }));

    // Only the id passed in — the builder's wider `rows` list is a lookup, not
    // the selection.
    expect(onBulkChange).toHaveBeenCalledTimes(1);
    expect(onBulkChange.mock.calls[0]?.[0]).toEqual([ROWS[1]]);
    expect(onBulkChange.mock.calls[0]?.[1]).toBe(true);
  });
});
