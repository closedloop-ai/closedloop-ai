import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import type { SessionsFavoriteController } from "../sessions-list-interactions";
import { SessionsBulkRail } from "./sessions-selection.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

const TOAST = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@repo/design-system/components/ui/sonner", () => ({ toast: TOAST }));

/**
 * ISS-8335 (whitlockk review cid 3880964961) — a bulk favorite that PARTLY landed.
 *
 * The batch is N independent per-artifact mutations, so "some succeeded" is a
 * real outcome and not an edge case. The bar used to take a boolean from the
 * command: a run whose last mutation failed reported a total failure and kept
 * the whole selection, over a server that had already taken the rest. The
 * reader was told nothing changed while their favourites had changed, with no
 * way to tell which — a UI stating the opposite of the data underneath it.
 *
 * These drive the real button and assert from the test body afterwards.
 */

const ROWS = [
  createSessionTableRowFixture({ id: "session-1", name: "session/one" }),
  createSessionTableRowFixture({ id: "session-2", name: "session/two" }),
  createSessionTableRowFixture({ id: "session-3", name: "session/three" }),
];

const FAVORITE_BUTTON_NAME = "Favorite sessions";
const PARTIAL_TOAST_PATTERN =
  /Added to favorites for 2 of 3 sessions\. 1 failed\./;

function renderBar(
  onBulkChange: SessionsFavoriteController["onBulkChange"],
  handlers: {
    getSelectionGeneration?: () => number;
    onClear: () => void;
    onRetainSelection: (rowIds: readonly string[]) => void;
  }
) {
  render(
    <SessionsBulkRail
      favorites={{
        favoriteIds: new Set<string>(),
        onBulkChange,
        onChange: () => undefined,
      }}
      getSelectionGeneration={handlers.getSelectionGeneration}
      onClear={handlers.onClear}
      onRetainSelection={handlers.onRetainSelection}
      selectedRows={ROWS}
    />
  );
}

describe("bulk favorite partial outcomes", () => {
  beforeEach(() => {
    TOAST.error.mockClear();
    TOAST.success.mockClear();
    TOAST.warning.mockClear();
  });

  it("names what landed and keeps only the failed rows selected", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const onRetainSelection = vi.fn();
    renderBar(
      () =>
        Promise.resolve({
          failedIds: ["session-3"],
          succeededIds: ["session-1", "session-2"],
        }),
      { onClear, onRetainSelection }
    );

    await user.click(
      screen.getByRole("button", { name: FAVORITE_BUTTON_NAME })
    );

    await waitFor(() =>
      expect(TOAST.warning).toHaveBeenCalledWith(
        expect.stringMatching(PARTIAL_TOAST_PATTERN),
        expect.anything()
      )
    );
    // Neither of the two lies the old shape told: not a success over three, and
    // not a failure over any.
    expect(TOAST.success).not.toHaveBeenCalled();
    expect(TOAST.error).not.toHaveBeenCalled();
    // The selection now IS what still needs doing, so the retry is this same
    // click on the row that failed.
    expect(onRetainSelection).toHaveBeenCalledWith(["session-3"]);
    expect(onClear).not.toHaveBeenCalled();
  });

  it("clears the selection and reports plainly when every row landed", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const onRetainSelection = vi.fn();
    renderBar(
      () =>
        Promise.resolve({
          failedIds: [],
          succeededIds: ROWS.map((row) => row.id),
        }),
      { onClear, onRetainSelection }
    );

    await user.click(
      screen.getByRole("button", { name: FAVORITE_BUTTON_NAME })
    );

    await waitFor(() =>
      expect(TOAST.success).toHaveBeenCalledWith(
        "Added to favorites for 3 sessions",
        expect.anything()
      )
    );
    expect(TOAST.warning).not.toHaveBeenCalled();
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onRetainSelection).not.toHaveBeenCalled();
  });

  it("reports a failure and holds the selection when nothing landed", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const onRetainSelection = vi.fn();
    renderBar(
      () =>
        Promise.resolve({
          failedIds: ROWS.map((row) => row.id),
          succeededIds: [],
        }),
      { onClear, onRetainSelection }
    );

    await user.click(
      screen.getByRole("button", { name: FAVORITE_BUTTON_NAME })
    );

    await waitFor(() =>
      expect(TOAST.error).toHaveBeenCalledWith(
        "Couldn't update favorite sessions"
      )
    );
    expect(onClear).not.toHaveBeenCalled();
    expect(onRetainSelection).toHaveBeenCalledWith(ROWS.map((row) => row.id));
  });

  it("still clears on a host that reports nothing, so the old contract holds", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const onRetainSelection = vi.fn();
    renderBar(() => Promise.resolve(), { onClear, onRetainSelection });

    await user.click(
      screen.getByRole("button", { name: FAVORITE_BUTTON_NAME })
    );

    // A host that cannot split the batch resolved, so every row landed — the
    // all-or-nothing seam every existing caller still uses.
    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
    expect(TOAST.success).toHaveBeenCalledWith(
      "Added to favorites for 3 sessions",
      expect.anything()
    );
  });

  it("leaves the selection untouched when the host rejects outright", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const onRetainSelection = vi.fn();
    renderBar(() => Promise.reject(new Error("offline")), {
      onClear,
      onRetainSelection,
    });

    await user.click(
      screen.getByRole("button", { name: FAVORITE_BUTTON_NAME })
    );

    await waitFor(() =>
      expect(TOAST.error).toHaveBeenCalledWith(
        "Couldn't update favorite sessions"
      )
    );
    // A rejection says nothing about which rows landed, so narrowing the
    // selection off it would be an invented claim.
    expect(onClear).not.toHaveBeenCalled();
    expect(onRetainSelection).not.toHaveBeenCalled();
  });

  it("ignores a partial page-A completion after selection moves A to B to A", async () => {
    const user = userEvent.setup();
    const pending = deferredFavoriteOutcome();
    const onClear = vi.fn();
    const onRetainSelection = vi.fn();
    let generation = 1;
    renderBar(() => pending.promise, {
      getSelectionGeneration: () => generation,
      onClear,
      onRetainSelection,
    });

    await user.click(
      screen.getByRole("button", { name: FAVORITE_BUTTON_NAME })
    );
    generation = 3;
    pending.resolve({
      failedIds: [ROWS[2]!.id],
      succeededIds: ROWS.slice(0, 2).map((row) => row.id),
    });

    await waitFor(() => expect(TOAST.warning).toHaveBeenCalledOnce());
    expect(onClear).not.toHaveBeenCalled();
    expect(onRetainSelection).not.toHaveBeenCalled();
  });

  it("does not clear a new page-B selection when page-A fully succeeds", async () => {
    const user = userEvent.setup();
    const pending = deferredFavoriteOutcome();
    const onClear = vi.fn();
    const onRetainSelection = vi.fn();
    let generation = 4;
    renderBar(() => pending.promise, {
      getSelectionGeneration: () => generation,
      onClear,
      onRetainSelection,
    });

    await user.click(
      screen.getByRole("button", { name: FAVORITE_BUTTON_NAME })
    );
    generation += 1;
    pending.resolve({
      failedIds: [],
      succeededIds: ROWS.map((row) => row.id),
    });

    await waitFor(() => expect(TOAST.success).toHaveBeenCalledOnce());
    expect(onClear).not.toHaveBeenCalled();
    expect(onRetainSelection).not.toHaveBeenCalled();
  });
});

function deferredFavoriteOutcome() {
  let resolve: (value: {
    failedIds: string[];
    succeededIds: string[];
  }) => void = () => undefined;
  const promise = new Promise<{
    failedIds: string[];
    succeededIds: string[];
  }>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
