import {
  TableBulkActionBar,
  TableBulkActionButton,
  TableSelectionAnnouncer,
} from "@closedloop-ai/design-system/components/ui/table-bulk-action-bar";
import type { CountNoun } from "@closedloop-ai/design-system/lib/count-noun";
import { fireEvent, render, screen } from "@testing-library/react";
import { StarIcon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

describe("TableBulkActionBar", () => {
  it("exposes the selection summary and its actions as one toolbar", () => {
    const onFavorite = vi.fn();
    render(
      <TableBulkActionBar
        actionLabel="3 artifacts selected"
        actions={
          <TableBulkActionButton
            label="Favorite artifacts"
            onClick={onFavorite}
          >
            <StarIcon />
          </TableBulkActionButton>
        }
      />
    );

    const toolbar = screen.getByRole("toolbar", {
      name: "3 artifacts selected",
    });
    expect(toolbar).toBeVisible();
    expect(toolbar).toHaveClass("fixed", "bottom-16", "md:bottom-8");
    fireEvent.click(screen.getByRole("button", { name: "Favorite artifacts" }));
    expect(onFavorite).toHaveBeenCalledTimes(1);
  });

  it("states the selection ONCE in the accessibility tree — named, not live", () => {
    // ISS-9574 moved the live region off this bar because every host mounts it
    // conditionally. The NAME has to stay: it is what a reader who Tabs in is
    // told the toolbar acts on. Both halves are pinned, because putting
    // `aria-live` back would announce the same sentence twice alongside
    // `TableSelectionAnnouncer`, and dropping the name would delete the only
    // statement this bar makes.
    render(
      <TableBulkActionBar actionLabel="3 artifacts selected" actions={null} />
    );

    expect(
      screen.getByRole("toolbar", { name: "3 artifacts selected" })
    ).not.toHaveAttribute("aria-live");
  });
});

describe("TableSelectionAnnouncer source precondition (ISS-9460)", () => {
  it("announces the count politely, through the role a live region carries", () => {
    render(<TableSelectionAnnouncer count={3} noun={ARTIFACT_NOUN} />);

    const region = screen.getByRole("status", {
      name: "3 artifacts selected",
    });
    expect(region).toHaveTextContent("3 artifacts selected");
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  it("says the singular for one, so no surface ships '1 artifacts selected'", () => {
    render(<TableSelectionAnnouncer count={1} noun={ARTIFACT_NOUN} />);

    expect(
      screen.getByRole("status", { name: "1 artifact selected" })
    ).toHaveTextContent("1 artifact selected");
  });

  it("stays mounted at zero and says so — the emptying IS the announcement", () => {
    // The moment the conditionally-mounted bar cannot cover: a filter drops the
    // selection below the host's threshold, the rail unmounts, and a live
    // region that unmounted with it announces nothing.
    render(<TableSelectionAnnouncer count={0} noun={ARTIFACT_NOUN} />);

    expect(
      screen.getByRole("status", { name: "No artifacts selected" })
    ).toHaveTextContent("No artifacts selected");
  });

  it("uses a bare string noun verbatim, for a word whose singular does not differ", () => {
    render(<TableSelectionAnnouncer count={1} noun="staff" />);

    expect(
      screen.getByRole("status", { name: "1 staff selected" })
    ).toHaveTextContent("1 staff selected");
  });
});

const ARTIFACT_NOUN: CountNoun = { one: "artifact", other: "artifacts" };
