import {
  TableChangeCell,
  TableChoiceCell,
  TableCountCell,
  TableDateCell,
  TableFavoriteCell,
  TableIdentityCell,
  TableNumberCell,
  TablePeopleCell,
  type TablePerson,
  TablePersonCell,
  TableTextCell,
  TableVersionCell,
} from "@closedloop-ai/design-system/components/ui/table-cell-primitives";
import { TooltipProvider } from "@closedloop-ai/design-system/components/ui/tooltip";
import { fireEvent, render, screen } from "@testing-library/react";
import { StarIcon } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadedImage, PERSON_AVATAR_TEST_URL } from "./support/avatar-images";

const REGEX_PATTERN = /^\+/;

/**
 * ISS-7349. `table-cell-primitives.tsx` holds the one presentation primitive per
 * data shape that every table's cells route through, so each of them is the
 * single place a NULL or ABSENT value is turned into something a reader sees.
 * Every one of these components has an empty arm, and getting that arm wrong is
 * the classic false-completeness bug: a missing value rendering as a confident
 * "0", or as blank space that reads as a load that never finished.
 *
 * The story sweep mounts the populated shape of each. These pin the empty arms,
 * plus the two derivations that are genuinely computed rather than passed
 * through — the people cell's dedup-and-overflow and the change cell's
 * percentage split.
 *
 * `GridEmptyValue` renders an em dash, so "shows the empty value" is asserted
 * against that character rather than against an absence.
 */

const EM_DASH = "—";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Tooltip triggers need a provider; the cells do not ship one themselves. */
function renderCell(ui: React.ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const person = (
  name: string,
  extra: Partial<TablePerson> = {}
): TablePerson => ({
  name,
  ...extra,
});

describe("TableIdentityCell", () => {
  it("renders the slug beside the title", () => {
    renderCell(
      <TableIdentityCell icon={StarIcon} slug="ISS-1" title="Fix the thing" />
    );

    expect(screen.getByText("ISS-1")).toBeInTheDocument();
    expect(screen.getByText("Fix the thing")).toBeInTheDocument();
  });
});

describe("TableFavoriteCell", () => {
  it("names the ADD action when not favorited", () => {
    renderCell(
      <TableFavoriteCell
        favorited={false}
        itemLabel="ISS-1"
        onFavoriteChange={vi.fn()}
      />
    );

    expect(
      screen.getByRole("button", { name: "Add ISS-1 to favorites" })
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("names the REMOVE action when favorited", () => {
    renderCell(
      <TableFavoriteCell
        favorited
        itemLabel="ISS-1"
        onFavoriteChange={vi.fn()}
      />
    );

    expect(
      screen.getByRole("button", { name: "Remove ISS-1 from favorites" })
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("reports the TOGGLED state, not the current one", () => {
    const onFavoriteChange = vi.fn();
    renderCell(
      <TableFavoriteCell
        favorited={false}
        itemLabel="ISS-1"
        onFavoriteChange={onFavoriteChange}
      />
    );

    fireEvent.click(screen.getByRole("button"));

    expect(onFavoriteChange).toHaveBeenCalledWith(true);
  });

  it("reports false when un-favoriting", () => {
    const onFavoriteChange = vi.fn();
    renderCell(
      <TableFavoriteCell
        favorited
        itemLabel="ISS-1"
        onFavoriteChange={onFavoriteChange}
      />
    );

    fireEvent.click(screen.getByRole("button"));

    expect(onFavoriteChange).toHaveBeenCalledWith(false);
  });
});

describe("TablePersonCell", () => {
  it("passes the person's photo to the shared avatar", () => {
    vi.stubGlobal("Image", LoadedImage);
    renderCell(
      <TablePersonCell
        person={person("Ada Lovelace", { avatarUrl: PERSON_AVATAR_TEST_URL })}
      />
    );

    expect(
      document.querySelector('img[data-slot="avatar-image"]')
    ).toHaveAttribute("src", PERSON_AVATAR_TEST_URL);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("renders the person's name", () => {
    renderCell(<TablePersonCell person={person("Ada Lovelace")} />);

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("derives initials from the name when none are supplied", () => {
    renderCell(<TablePersonCell person={person("Ada Lovelace")} />);

    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("prefers explicitly supplied initials", () => {
    renderCell(
      <TablePersonCell person={person("Ada Lovelace", { initials: "ZZ" })} />
    );

    // Drawn as one letter, like every avatar (Nerys, 2026-10-22).
    expect(screen.getByText("Z")).toBeInTheDocument();
  });

  it("draws one initial however many names there are", () => {
    renderCell(<TablePersonCell person={person("Ada Byron King Lovelace")} />);

    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.queryByText("AB")).not.toBeInTheDocument();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
  ])("shows the empty value for %s", (_label, value) => {
    renderCell(<TablePersonCell person={value} />);

    expect(screen.getByText(EM_DASH)).toBeInTheDocument();
  });
});

describe("TablePeopleCell", () => {
  it("passes each visible person's photo to the shared avatar", () => {
    vi.stubGlobal("Image", LoadedImage);
    renderCell(
      <TablePeopleCell
        people={[person("Ada Lovelace", { avatarUrl: PERSON_AVATAR_TEST_URL })]}
      />
    );

    expect(
      document.querySelector('img[data-slot="avatar-image"]')
    ).toHaveAttribute("src", PERSON_AVATAR_TEST_URL);
    expect(screen.getByText("People: Ada Lovelace")).toBeInTheDocument();
  });

  it("shows the empty value for no people", () => {
    renderCell(<TablePeopleCell people={[]} />);

    expect(screen.getByText(EM_DASH)).toBeInTheDocument();
  });

  it("lists every name in the accessibility tree", () => {
    // The avatars are visual; the sr-only list is what a screen reader gets.
    renderCell(<TablePeopleCell people={[person("Ada"), person("Linus")]} />);

    expect(screen.getByText("People: Ada, Linus")).toBeInTheDocument();
  });

  it("de-duplicates people who appear more than once", () => {
    renderCell(
      <TablePeopleCell
        people={[person("Ada"), person("Ada"), person("Linus")]}
      />
    );

    expect(screen.getByText("People: Ada, Linus")).toBeInTheDocument();
  });

  it("shows no overflow marker at the visible cap", () => {
    const people = ["A", "B", "C", "D"].map((name) => person(name));

    renderCell(<TablePeopleCell people={people} />);

    expect(screen.queryByText(REGEX_PATTERN)).toBeNull();
  });

  it("counts only the people past the cap in the overflow marker", () => {
    const people = ["A", "B", "C", "D", "E", "F"].map((name) => person(name));

    renderCell(<TablePeopleCell people={people} />);

    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("counts the overflow AFTER de-duplication", () => {
    // Five entries but four distinct people — no overflow.
    const people = ["A", "B", "C", "D", "A"].map((name) => person(name));

    renderCell(<TablePeopleCell people={people} />);

    expect(screen.queryByText(REGEX_PATTERN)).toBeNull();
  });
});

describe("TableChoiceCell", () => {
  it("renders the label as a chip", () => {
    renderCell(<TableChoiceCell label="Blocked" />);

    expect(screen.getByText("Blocked")).toBeInTheDocument();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
  ])("shows the empty value for %s", (_label, value) => {
    renderCell(<TableChoiceCell label={value} />);

    expect(screen.getByText(EM_DASH)).toBeInTheDocument();
  });
});

describe("TableCountCell", () => {
  it("renders a zero count as a real value, not as empty", () => {
    // The distinction that matters: a measured zero is not a missing count.
    renderCell(<TableCountCell count={0} icon={StarIcon} />);

    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.queryByText(EM_DASH)).toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
  ])("shows the empty value for %s", (_label, value) => {
    renderCell(<TableCountCell count={value} icon={StarIcon} />);

    expect(screen.getByText(EM_DASH)).toBeInTheDocument();
  });

  it("renders as static text without a click handler", () => {
    renderCell(<TableCountCell count={3} icon={StarIcon} />);

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("becomes a button when the caller supplies a handler", () => {
    const onClick = vi.fn();
    renderCell(<TableCountCell count={3} icon={StarIcon} onClick={onClick} />);

    fireEvent.click(screen.getByRole("button"));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("falls back to a count-derived accessible name", () => {
    renderCell(<TableCountCell count={3} icon={StarIcon} onClick={vi.fn()} />);

    expect(screen.getByRole("button", { name: "3 items" })).toBeInTheDocument();
  });

  it("prefers an explicit accessible name", () => {
    renderCell(
      <TableCountCell
        ariaLabel="3 comments"
        count={3}
        icon={StarIcon}
        onClick={vi.fn()}
      />
    );

    expect(
      screen.getByRole("button", { name: "3 comments" })
    ).toBeInTheDocument();
  });
});

describe("TableDateCell", () => {
  it("renders the short value with the full value as a title", () => {
    renderCell(<TableDateCell fullValue="Aug 20, 2026 12:00" value="Aug 20" />);

    expect(screen.getByText("Aug 20")).toHaveAttribute(
      "title",
      "Aug 20, 2026 12:00"
    );
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
  ])("shows the empty value for %s", (_label, value) => {
    renderCell(<TableDateCell value={value} />);

    expect(screen.getByText(EM_DASH)).toBeInTheDocument();
  });
});

describe("TableVersionCell", () => {
  it("renders a static version without a handler", () => {
    renderCell(<TableVersionCell value="v3" />);

    expect(screen.getByText("v3")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("becomes a button when the caller supplies a handler", () => {
    const onClick = vi.fn();
    renderCell(
      <TableVersionCell
        ariaLabel="Open version 3"
        onClick={onClick}
        value="v3"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open version 3" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
  ])("shows the empty value for %s", (_label, value) => {
    renderCell(<TableVersionCell value={value} />);

    expect(screen.getByText(EM_DASH)).toBeInTheDocument();
  });
});

describe("TableTextCell", () => {
  it("renders the value", () => {
    renderCell(<TableTextCell value="Some text" />);

    expect(screen.getByText("Some text")).toBeInTheDocument();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
  ])("shows the empty value for %s", (_label, value) => {
    renderCell(<TableTextCell value={value} />);

    expect(screen.getByText(EM_DASH)).toBeInTheDocument();
  });

  it("renders a zero rather than treating it as empty", () => {
    // A falsy-but-present value is a value; `== null` is what distinguishes it.
    renderCell(<TableTextCell value={0} />);

    expect(screen.getByText("0")).toBeInTheDocument();
  });
});

describe("TableNumberCell", () => {
  it("renders the value right-aligned by default", () => {
    renderCell(<TableNumberCell value="1,024" />);

    expect(screen.getByText("1,024").className).toContain("ml-auto");
  });

  it("drops the alignment class when the caller opts out", () => {
    renderCell(<TableNumberCell alignEnd={false} value="1,024" />);

    expect(screen.getByText("1,024").className).not.toContain("ml-auto");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
  ])("shows the empty value for %s", (_label, value) => {
    renderCell(<TableNumberCell value={value} />);

    expect(screen.getByText(EM_DASH)).toBeInTheDocument();
  });
});

describe("TableChangeCell", () => {
  it("shows the empty value only when BOTH counts are absent", () => {
    renderCell(<TableChangeCell />);

    expect(screen.getByText(EM_DASH)).toBeInTheDocument();
  });

  it("renders additions alone when deletions are absent", () => {
    renderCell(<TableChangeCell additions={12} />);

    expect(screen.getByText("+12")).toBeInTheDocument();
    expect(screen.queryByText(EM_DASH)).toBeNull();
  });

  it("renders deletions alone when additions are absent", () => {
    renderCell(<TableChangeCell deletions={5} />);

    expect(screen.getByText("−5")).toBeInTheDocument();
  });

  it("names both counts in the accessibility tree, defaulting an absent side to zero", () => {
    renderCell(<TableChangeCell additions={12} />);

    expect(
      screen.getByLabelText("12 additions, 0 deletions")
    ).toBeInTheDocument();
  });

  it("groups thousands in the rendered counts", () => {
    renderCell(<TableChangeCell additions={1234} deletions={5678} />);

    expect(screen.getByText("+1,234")).toBeInTheDocument();
    expect(screen.getByText("−5,678")).toBeInTheDocument();
  });

  it("splits the bar proportionally between the two counts", () => {
    const { container } = renderCell(
      <TableChangeCell additions={75} deletions={25} />
    );

    const [additionBar, deletionBar] = Array.from(
      container.querySelectorAll("span[style]")
    );

    expect(additionBar).toHaveStyle({ width: "75%" });
    expect(deletionBar).toHaveStyle({ width: "25%" });
  });

  it("renders a zero-width bar when both counts are zero", () => {
    // total === 0, so the percentage guard is what stops a 0/0 NaN width.
    const { container } = renderCell(
      <TableChangeCell additions={0} deletions={0} />
    );

    const [additionBar, deletionBar] = Array.from(
      container.querySelectorAll("span[style]")
    );

    expect(additionBar).toHaveStyle({ width: "0%" });
    expect(deletionBar).toHaveStyle({ width: "0%" });
  });
});
