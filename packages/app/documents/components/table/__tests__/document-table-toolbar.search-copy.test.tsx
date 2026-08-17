import { DocumentTableToolbar } from "@repo/app/documents/components/table/document-table-toolbar";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "./render-with-nav";

/**
 * ISS-4682 item 2 — the search box gets to say what it actually searches.
 *
 * A server-paged surface runs its search predicate in the browser over the ONE
 * page it was sent, so a user with 137 tasks can search a title that exists, get
 * nothing, and conclude it is absent. The footer's "on this page" wording only
 * explains that after the fact; the control has to say it before it is used.
 *
 * The seam is optional and defaults to today's copy, because every other surface
 * that mounts this toolbar searches everything it holds and must be byte-
 * unchanged.
 */

const DEFAULT_PLACEHOLDER = "Filter items...";
const DEFAULT_LABEL = "Filter items";
// ISS-5280 (review): the two are ONE sentence — the My Tasks card board passes
// its label verbatim as the accessible name and with an ellipsis as the
// placeholder, so this fixture mirrors that rather than inventing a second
// phrasing.
const PAGE_SCOPED_LABEL = "Filter tasks on this page";
const PAGE_SCOPED_PLACEHOLDER = `${PAGE_SCOPED_LABEL}...`;

function renderToolbar(
  overrides: Partial<React.ComponentProps<typeof DocumentTableToolbar>> = {}
) {
  return render(
    <DocumentTableToolbar
      filterText=""
      onFilterTextChange={vi.fn()}
      tableViewMenuProps={{ view: "list", onChangeView: vi.fn() }}
      {...overrides}
    />
  );
}

afterEach(cleanup);

describe("DocumentTableToolbar search copy (ISS-4682 item 2)", () => {
  it("keeps the existing copy when a surface does not opt in", () => {
    // Every other consumer of this toolbar depends on this default, so the
    // opt-in above cannot be allowed to change them.
    renderToolbar();

    expect(screen.getByLabelText(DEFAULT_LABEL)).toHaveAttribute(
      "placeholder",
      DEFAULT_PLACEHOLDER
    );
  });

  it("narrows both the placeholder and the accessible name together", () => {
    // Both or neither: a visible page-scoped placeholder under an accessible
    // name still saying "Filter items" would tell a screen-reader user the opposite
    // of what the sighted user reads.
    renderToolbar({
      searchLabel: PAGE_SCOPED_LABEL,
      searchPlaceholder: PAGE_SCOPED_PLACEHOLDER,
    });

    expect(screen.getByLabelText(PAGE_SCOPED_LABEL)).toHaveAttribute(
      "placeholder",
      PAGE_SCOPED_PLACEHOLDER
    );
    expect(screen.queryByLabelText(DEFAULT_LABEL)).toBeNull();
  });
});
