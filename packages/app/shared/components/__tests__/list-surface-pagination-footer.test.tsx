import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagAdapterProvider } from "../../feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../feature-flags/static-feature-flag-adapter";
import { TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY } from "../../lib/feature-flags";
import { ListSurfacePaginationFooter } from "../list-surface-pagination-footer";

/**
 * ISS-9225 — what the ONE footer decides for every v2 list surface, asserted
 * against what it renders rather than against the props a surface hands it.
 *
 * Sessions and Branches each rendered their own strip before this component, so
 * each of these decisions had two answers that agreed. The ladder here is
 * written out as literal option text rather than mapped from
 * `TABLE_PAGE_SIZE_OPTIONS`: a fixture that reads the constant it polices
 * cannot fail when a rung is dropped from it.
 */

/**
 * `PaginationNext` renders an `<a>` with no `href`, which carries no implicit
 * link role — its accessible name is the only handle on it.
 */
const NEXT_PAGE = "Go to next page";

const RANGE_READOUT = (
  { from, to }: { from: number; to: number },
  total: number
) => `${from}-${to} of ${total}`;

function renderFooter(
  overrides: Partial<Parameters<typeof ListSurfacePaginationFooter>[0]> = {}
) {
  return render(
    <ListSurfacePaginationFooter
      formatRange={RANGE_READOUT}
      isPlaceholderPage={false}
      onPageChange={() => undefined}
      onPageSizeChange={() => undefined}
      page={0}
      pageSize={25}
      rowsOnPage={25}
      total={47}
      totalPages={2}
      {...overrides}
    />
  );
}

describe("ListSurfacePaginationFooter", () => {
  it("offers one rows-per-page ladder, stated here and not by the surface", async () => {
    renderFooter();

    await userEvent.click(
      screen.getByRole("combobox", { name: "Rows per page" })
    );

    expect(
      screen.getAllByRole("option").map((option) => option.textContent)
    ).toStrictEqual(["25 / page", "50 / page", "100 / page"]);
  });

  it("states the caller's sentence over the range it derived", () => {
    renderFooter({ page: 1, rowsOnPage: 22 });

    expect(screen.getByRole("status")).toHaveTextContent("26-47 of 47");
  });

  it("says nothing while the rendered rows are a placeholder page, and pins the pager", () => {
    renderFooter({ isPlaceholderPage: true });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    // The footer keeps its height through the read — the pager is still here,
    // and inert, which is the pair of facts a bare absence assertion cannot
    // separate from an unmounted footer.
    expect(screen.getByLabelText(NEXT_PAGE)).toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });

  it("says nothing while the range is unsettled but leaves the reader able to page", () => {
    renderFooter({ isRangeUnsettled: true });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText(NEXT_PAGE)).toHaveAttribute(
      "aria-disabled",
      "false"
    );
  });

  it("withholds the rows-per-page control when the surface offers no handler", () => {
    renderFooter({ onPageSizeChange: undefined });

    expect(
      screen.queryByRole("combobox", { name: "Rows per page" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1-25 of 47");
  });

  it("pages from the index the readout describes", async () => {
    const onPageChange = vi.fn();
    renderFooter({ onPageChange });

    expect(screen.getByRole("status")).toHaveTextContent("1-25 of 47");
    await userEvent.click(screen.getByLabelText(NEXT_PAGE));

    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it("lets the surface withhold its sentence on a page with no rows", () => {
    // Branches' own wording: its empty state already says there is nothing, so
    // a "0-0 of 0" beneath it would restate a non-fact. The footer must let a
    // caller decline, which is only visible against one that does not.
    renderFooter({
      formatRange: (range, total) =>
        range.to === 0 ? null : RANGE_READOUT(range, total),
      rowsOnPage: 0,
      total: 0,
      totalPages: 1,
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    // The strip still renders; only the sentence is declined. The sibling case
    // below states one from the SAME inputs, so this absence is the caller's
    // choice and not a suppression rule firing.
    expect(screen.getByLabelText(NEXT_PAGE)).toBeInTheDocument();
  });

  it("states a caller's own sentence on that same empty page", () => {
    renderFooter({ rowsOnPage: 0, total: 0, totalPages: 1 });

    expect(screen.getByRole("status")).toHaveTextContent("0-0 of 0");
  });
});

/**
 * ISS-9692 (davetho review) — WHICH ladder, asserted on the rendered options
 * of the one footer both list surfaces mount.
 *
 * ISS-9225 made the ladder this component's to state, so ISS-9692's gate belongs
 * here too. The case above pins the closed ladder; these pin that the gate is
 * what moves it, and that the rungs reach the CONTROL rather than only the
 * constant. Sessions and Branches both render this footer, so a surface that
 * offered a different set would have to stop rendering it to do so — which
 * `list-surface-pagination-ownership.test.ts` is what fails on.
 */
describe("ListSurfacePaginationFooter rows-per-page ladder gate", () => {
  function renderGated(extendedLadderEnabled: boolean, pageSize: number) {
    return render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: extendedLadderEnabled
            ? [TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY]
            : [],
        })}
      >
        <ListSurfacePaginationFooter
          formatRange={RANGE_READOUT}
          isPlaceholderPage={false}
          onPageChange={() => undefined}
          onPageSizeChange={() => undefined}
          page={0}
          pageSize={pageSize}
          rowsOnPage={pageSize}
          total={4000}
          totalPages={8}
        />
      </FeatureFlagAdapterProvider>
    );
  }

  async function openLadder() {
    await userEvent.click(
      screen.getByRole("combobox", { name: "Rows per page" })
    );
    return screen.getAllByRole("option").map((option) => option.textContent);
  }

  it("offers 250 and 500 once the gate is open", async () => {
    renderGated(true, 25);

    expect(await openLadder()).toStrictEqual([
      "25 / page",
      "50 / page",
      "100 / page",
      "250 / page",
      "500 / page",
    ]);
  });

  it("offers neither while the gate is closed", async () => {
    renderGated(false, 25);

    expect(await openLadder()).toStrictEqual([
      "25 / page",
      "50 / page",
      "100 / page",
    ]);
  });

  it("selects a large rung the surface is already paging at", () => {
    // A rendered `500 / page` proves the size the caller resolved is one this
    // control can actually name — a blank trigger is what a ladder and a page
    // size that disagree look like on screen.
    renderGated(true, 500);

    expect(
      screen.getByRole("combobox", { name: "Rows per page" })
    ).toHaveTextContent("500 / page");
  });
});
