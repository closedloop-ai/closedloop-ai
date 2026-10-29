/**
 * ISS-6384 — the documents grid's Due date cell moving onto the shared
 * `InlineScalarCell` `date` variant.
 *
 * The ticket named `DueDateCell` as the REFERENCE for how a date should be
 * edited (a `DatePickerPopover`, never a native `<input type="date">`), so the
 * contract worth pinning is that adopting the shared primitive keeps it: the
 * flag-ON path must still be the popover, and it must still be read-only when
 * the row supplies no update handler.
 */

import { ARTIFACT_CELL_PRIMITIVES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

import type { ProjectWithDetails } from "@repo/api/src/types/project";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { DocumentColumn as Col } from "@repo/app/shared/hooks/use-column-visibility";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { makeProject } from "@repo/app/shared/test-fixtures/project";
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import {
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { act } from "@testing-library/react";
import type { ReactNode } from "react";

const UPDATED_AT = new Date("2026-08-17T12:00:00.000Z");
/** The filled trigger's accessible name is "Due date: <formatted>". */
const DUE_DATE_TRIGGER_PATTERN = /^Due date:/;
const ANY_DUE_DATE_BUTTON_PATTERN = /Due date/;
const SET_DUE_DATE_PATTERN = /Set Due date/;

function renderDueDate({
  sharedCells,
  handlers,
}: {
  sharedCells: boolean;
  handlers: RowEditHandlers;
}) {
  const item: DocumentRowItem = {
    kind: "document",
    data: makeArtifact({ updatedAt: UPDATED_AT }),
  };
  const view = render(
    <Flags sharedCells={sharedCells}>
      <DocumentRow
        editHandlers={handlers}
        item={item}
        visibleColumns={[Col.DueDate]}
      />
    </Flags>
  );
  return {
    ...view,
    rerenderFlags: (nextSharedCells: boolean) =>
      view.rerender(
        <Flags sharedCells={nextSharedCells}>
          <DocumentRow
            editHandlers={handlers}
            item={item}
            visibleColumns={[Col.DueDate]}
          />
        </Flags>
      ),
  };
}

function Flags({
  sharedCells,
  children,
}: {
  sharedCells: boolean;
  children: ReactNode;
}) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: sharedCells
          ? [ARTIFACT_CELL_PRIMITIVES_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}

afterEach(() => {
  cleanup();
});

describe("DueDateCell — shared inline date cell (ISS-6384)", () => {
  it("edits through the date picker, never a native date input", () => {
    const { container } = renderDueDate({
      sharedCells: true,
      handlers: { onUpdateDueDate: vi.fn() },
    });

    // The reason the ticket forbade the native control: it ships the browser's
    // own unstyled, untokenized calendar.
    expect(container.querySelector('input[type="date"]')).toBeNull();
    const trigger = screen.getByRole("button", {
      name: DUE_DATE_TRIGGER_PATTERN,
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("renders no control at all when the row has no update handler", () => {
    // The read-only contract this file already had: a row whose host wired no
    // `onUpdateDueDate` gets a value, not an affordance. Adopting the primitive
    // must not hand one out.
    renderDueDate({ sharedCells: true, handlers: {} });

    expect(
      screen.queryByRole("button", { name: ANY_DUE_DATE_BUTTON_PATTERN })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: SET_DUE_DATE_PATTERN })
    ).toBeNull();
  });

  it("renders the retained failure when the due-date mutation rejects", async () => {
    const onUpdateDueDate = vi.fn<
      NonNullable<RowEditHandlers["onUpdateDueDate"]>
    >(() => Promise.reject(new Error("save refused")));
    const view = renderDueDate({
      sharedCells: true,
      handlers: { onUpdateDueDate },
    });

    fireEvent.click(
      screen.getByRole("button", { name: DUE_DATE_TRIGGER_PATTERN })
    );
    fireEvent.click(within(await screen.findByRole("dialog")).getByText("20"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      INLINE_EDIT_SAVE_ERROR_MESSAGE
    );
    await waitFor(() => expect(onUpdateDueDate).toHaveBeenCalledTimes(1));
    expect(onUpdateDueDate).toHaveBeenCalledWith(
      expect.any(String),
      new Date(2026, 7, 20),
      expect.any(Function)
    );
    const recoverableErrorOwner = onUpdateDueDate.mock.calls[0]?.[2];
    expect(recoverableErrorOwner?.()).toBe(true);
    view.unmount();
    expect(recoverableErrorOwner?.()).toBe(false);
  });

  it("releases feedback ownership when the primitive flag turns off mid-write", async () => {
    const onUpdateDueDate = vi.fn<
      NonNullable<RowEditHandlers["onUpdateDueDate"]>
    >(() => new Promise(() => undefined));
    const view = renderDueDate({
      sharedCells: true,
      handlers: { onUpdateDueDate },
    });

    fireEvent.click(
      screen.getByRole("button", { name: DUE_DATE_TRIGGER_PATTERN })
    );
    fireEvent.click(within(await screen.findByRole("dialog")).getByText("20"));
    await waitFor(() => expect(onUpdateDueDate).toHaveBeenCalledTimes(1));
    const recoverableErrorOwner = onUpdateDueDate.mock.calls[0]?.[2];
    expect(recoverableErrorOwner?.()).toBe(true);

    view.rerenderFlags(false);

    expect(recoverableErrorOwner?.()).toBe(false);
  });
});

const CACHED_PROJECT_KEY = ["due-date-cell-test", "project"] as const;
const CONFIRMED_TARGET_DATE = new Date(2026, 7, 17);

/**
 * A host subscribed to a real query cache with an optimistic patch, so the
 * cell sees its own echo, then the refusal, then the host's rollback, in the
 * order a cache-backed due-date host delivers them.
 */
function CachedProjectDueDateRow({
  write,
}: Readonly<{ write: () => Promise<unknown> }>) {
  const queryClient = useQueryClient();
  const { data } = useQuery<ProjectWithDetails>({
    queryKey: CACHED_PROJECT_KEY,
    queryFn: () => Promise.reject(new Error("seeded only")),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const mutation = useMutation({
    mutationFn: write,
    onMutate: (targetDate: Date | null) => {
      queryClient.setQueryData<ProjectWithDetails>(CACHED_PROJECT_KEY, (row) =>
        row ? { ...row, targetDate } : row
      );
    },
  });
  if (!data) {
    return null;
  }
  return (
    <DocumentRow
      editHandlers={{
        onUpdateDueDate: (_id, date) => mutation.mutateAsync(date),
      }}
      item={{ kind: "project", data }}
      visibleColumns={[Col.DueDate]}
    />
  );
}

describe("DueDateCell — retained failure against a real query cache", () => {
  it("keeps the date error when the host rolls its echo back after the refusal settles", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(
      CACHED_PROJECT_KEY,
      makeProject({ targetDate: CONFIRMED_TARGET_DATE })
    );
    const write = vi.fn(() => Promise.reject(new Error("save refused")));
    render(
      <QueryClientProvider client={queryClient}>
        <Flags sharedCells>
          <CachedProjectDueDateRow write={write} />
        </Flags>
      </QueryClientProvider>
    );

    fireEvent.click(
      screen.getByRole("button", { name: DUE_DATE_TRIGGER_PATTERN })
    );
    fireEvent.click(within(await screen.findByRole("dialog")).getByText("20"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(INLINE_EDIT_SAVE_ERROR_MESSAGE);
    expect(write).toHaveBeenCalledOnce();

    // The cache still holds the optimistic day; the host now rolls it back.
    act(() => {
      queryClient.setQueryData<ProjectWithDetails>(CACHED_PROJECT_KEY, (row) =>
        row ? { ...row, targetDate: CONFIRMED_TARGET_DATE } : row
      );
    });

    const trigger = screen.getByRole("button", {
      name: DUE_DATE_TRIGGER_PATTERN,
    });
    expect(trigger).toHaveAttribute("aria-invalid", "true");
    expect(trigger).toHaveAccessibleName("Due date: Aug 20, 2026");
    expect(screen.getByRole("alert")).toHaveTextContent(
      INLINE_EDIT_SAVE_ERROR_MESSAGE
    );
  });
});
