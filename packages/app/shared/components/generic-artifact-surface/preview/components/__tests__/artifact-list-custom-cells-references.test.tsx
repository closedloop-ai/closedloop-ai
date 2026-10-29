// @vitest-environment jsdom

/**
 * PRD-722 (ISS-9349): `EditableReferenceCell` is a thin adapter over the
 * reference champion, `InlineReferenceCell`. The adapter still owns the slug
 * and title filter, how a target and its relationship render, the toast with
 * its undo, and the words; the trigger's name, the empty state and the option
 * role are now the champion's.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { LinkIcon } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactTypeIcons } from "../artifact-icons";
import {
  EditableReferenceCell,
  ResponsiveReferenceList,
} from "../artifact-list-custom-cells";
import type { ReferenceOption } from "../artifact-list-related-sessions";
import {
  runLastToastUndo,
  type ToastSuccessHandler,
} from "./support/toast-spy";

const { toastSuccess } = vi.hoisted(() => ({
  toastSuccess: vi.fn<ToastSuccessHandler>(),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: toastSuccess },
}));

const EMPTY_VALUE_SELECTOR = '[data-slot="grid-empty-value"]';
const NO_MATCH = "No matching artifacts";
const ONE_SELECTED = "1 selected";
const DONE_LABEL = "Done";
const CHECK_ICON_SELECTOR = ".lucide-check";
const OVERFLOW_COUNTER = /^\+\d+$/;

const DOC_OPTION: ReferenceOption = {
  icon: ArtifactTypeIcons.Document,
  id: "doc-1",
  slug: "DOC-1",
  title: "Design brief",
};

const TODAY_SESSION: ReferenceOption = {
  icon: ArtifactTypeIcons.Session,
  id: "ses-1",
  lastInteractionAt: "3:04 pm",
  lastInteractionDate: "2026-09-25",
  ownerInitials: "AE",
  ownerName: "Ottilie Eastwick",
  relationship: "wrote",
  slug: "SES-1",
  status: "active",
  title: "Build the brief",
};

const EARLIER_SESSION: ReferenceOption = {
  icon: ArtifactTypeIcons.Session,
  id: "ses-2",
  lastInteractionAt: "9:15 am",
  lastInteractionDate: "2026-09-20",
  ownerInitials: "PB",
  ownerName: "Pascoe Birchall",
  relationship: "commented",
  slug: "SES-2",
  status: "completed",
  title: "Review comments",
};

const UNDATED_SESSION: ReferenceOption = {
  icon: ArtifactTypeIcons.Session,
  id: "ses-3",
  lastInteractionAt: "8:00 am",
  ownerInitials: "SC",
  ownerName: "Sam Chen",
  slug: "SES-3",
  title: "Loose session",
};

const MALFORMED_DATE_SESSION: ReferenceOption = {
  ...UNDATED_SESSION,
  id: "ses-4",
  lastInteractionDate: "2026-09",
  slug: "SES-4",
};

const OWNERLESS_SESSION: ReferenceOption = {
  icon: LinkIcon,
  id: "ses-5",
  lastInteractionAt: "7:00 am",
  slug: "SES-5",
  title: "Anonymous",
};

const OWNED_DOC_OPTION: ReferenceOption = {
  ...DOC_OPTION,
  id: "doc-owned",
  ownerInitials: "ZZ",
  ownerName: "Zed Zane",
  slug: "DOC-9",
};

const LAST_MONTH_SESSION: ReferenceOption = {
  ...TODAY_SESSION,
  id: "ses-6",
  lastInteractionDate: "2026-08-25",
  slug: "SES-6",
};

const LAST_YEAR_SESSION: ReferenceOption = {
  ...TODAY_SESSION,
  id: "ses-7",
  lastInteractionDate: "2025-09-25",
  slug: "SES-7",
};

const MISSING_MONTH_SESSION: ReferenceOption = {
  ...UNDATED_SESSION,
  id: "ses-8",
  lastInteractionDate: "2026--20",
  slug: "SES-8",
};

const OPTIONS = [DOC_OPTION, TODAY_SESSION, EARLIER_SESSION];

function stubLayout(containerWidth: number, chipWidth: number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
    containerWidth
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(
    chipWidth
  );
}

/** The champion dispatches each commit a microtask after the pick. */
async function flushCommits() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function hrefFor(value: string) {
  return `/artifacts/${value}`;
}

beforeEach(() => {
  toastSuccess.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 25, 12));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("EditableReferenceCell trigger and search", () => {
  it("names the source, or artifact when none is declared", () => {
    render(
      <EditableReferenceCell
        initialValues={[]}
        multiple={false}
        options={OPTIONS}
        source="Sessions"
      />
    );
    render(
      <EditableReferenceCell
        initialValues={[]}
        multiple={false}
        options={OPTIONS}
      />
    );

    expect(
      screen
        .getByRole("button", { name: "Set Sessions reference" })
        .querySelector(EMPTY_VALUE_SELECTOR)
    ).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Set artifact reference" })
        .querySelector(EMPTY_VALUE_SELECTOR)
    ).not.toBeNull();
  });

  it("labels the search with the source and filters on slug and title", () => {
    render(
      <EditableReferenceCell
        initialValues={[]}
        multiple={false}
        options={OPTIONS}
        source="Sessions"
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Set Sessions reference" })
    );
    const search = screen.getByRole("combobox", {
      name: "Search Sessions references",
    });
    expect(search).toHaveAttribute("placeholder", "Search Sessions…");

    fireEvent.change(search, { target: { value: " REVIEW " } });
    expect(screen.getByText("SES-2")).toBeInTheDocument();
    expect(screen.queryByText(DOC_OPTION.slug)).toBeNull();

    fireEvent.change(search, { target: { value: "COMMENTS  " } });
    expect(screen.getByText("SES-2")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "ses-1" } });
    expect(screen.getByText("Build the brief")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText(NO_MATCH)).toBeInTheDocument();
  });

  it("falls back to the artifact wording in the search field", () => {
    render(
      <EditableReferenceCell
        initialValues={[]}
        multiple={false}
        options={OPTIONS}
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Set artifact reference" })
    );

    expect(
      screen.getByRole("combobox", { name: "Search artifact references" })
    ).toHaveAttribute("placeholder", "Search artifacts…");
    expect(screen.queryByText(NO_MATCH)).toBeNull();
  });

  it("describes each option's relationship and status only when present", () => {
    render(
      <EditableReferenceCell
        initialValues={[]}
        multiple={false}
        options={OPTIONS}
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Set artifact reference" })
    );
    const rows = within(screen.getByRole("dialog")).getAllByRole("option");

    expect(rows.map((row) => row.textContent)).toEqual([
      "DOC-1Design brief",
      "SES-1Build the briefWroteActive",
      "SES-2Review commentsCommentedCompleted",
    ]);
  });
});

describe("EditableReferenceCell single selection", () => {
  it("replaces the value, closes, toasts, and undoes", async () => {
    render(
      <EditableReferenceCell
        initialValues={[]}
        multiple={false}
        options={OPTIONS}
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Set artifact reference" })
    );
    fireEvent.click(screen.getByText("Design brief"));
    await flushCommits();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastSuccess).toHaveBeenCalledWith(
      "Reference updated",
      expect.anything()
    );
    const trigger = screen.getByRole("button", {
      name: "Edit artifact reference, currently DOC-1",
    });
    expect(trigger).toHaveTextContent("DOC-1");

    act(() => runLastToastUndo(toastSuccess));
    expect(
      screen.getByRole("button", { name: "Set artifact reference" })
    ).toBeInTheDocument();
  });

  it("marks the selected option and shows no selection footer", () => {
    render(
      <EditableReferenceCell
        initialValues={["doc-1"]}
        multiple={false}
        options={OPTIONS}
      />
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit artifact reference, currently DOC-1",
      })
    );
    const [doc, today] = within(screen.getByRole("dialog")).getAllByRole(
      "option"
    );

    expect(doc?.querySelector(CHECK_ICON_SELECTOR)).not.toBeNull();
    expect(today?.querySelector(CHECK_ICON_SELECTOR)).toBeNull();
    expect(screen.queryByText(ONE_SELECTED)).toBeNull();
  });
});

describe("EditableReferenceCell multiple selection", () => {
  it("toggles references, counts them, clears the query, and closes on Done", async () => {
    render(
      <EditableReferenceCell initialValues={[]} multiple options={OPTIONS} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Set artifact reference" })
    );
    const search = screen.getByRole("combobox", {
      name: "Search artifact references",
    });
    expect(screen.queryByRole("button", { name: DONE_LABEL })).toBeNull();

    fireEvent.change(search, { target: { value: "brief" } });
    fireEvent.click(screen.getByText("Design brief"));
    await flushCommits();
    expect(search).toHaveValue("");
    fireEvent.click(screen.getByText("Review comments"));
    await flushCommits();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(toastSuccess).toHaveBeenLastCalledWith(
      "References updated",
      expect.anything()
    );

    fireEvent.click(screen.getByText("Design brief"));
    await flushCommits();
    expect(screen.getByText(ONE_SELECTED)).toBeInTheDocument();

    act(() => runLastToastUndo(toastSuccess));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: DONE_LABEL }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ResponsiveReferenceList fitting", () => {
  const VALUES = ["doc-1", "ses-1", "ses-2"];

  function renderFitted(containerWidth: number) {
    stubLayout(containerWidth, 50);
    render(
      <ResponsiveReferenceList
        hrefForValue={hrefFor}
        options={OPTIONS}
        values={VALUES}
      />
    );
    return screen.queryAllByRole("link").length;
  }

  it("shows every badge that fits and no overflow counter", () => {
    expect(renderFitted(1000)).toBe(3);
    expect(screen.queryByText(OVERFLOW_COUNTER)).toBeNull();
  });

  it("stops before a badge whose overflow reserve would not fit", () => {
    expect(renderFitted(120)).toBe(1);
    expect(screen.getByText(OVERFLOW_COUNTER)).toHaveTextContent("+2");
  });

  it("fits the last badge without reserving room for an overflow counter", () => {
    // 50 + 4 + 50 + 4 + 50 = 158: fits only because the final chip reserves no counter.
    expect(renderFitted(158)).toBe(3);
    expect(screen.queryByText(OVERFLOW_COUNTER)).toBeNull();
  });

  it("keeps a too-wide first badge shrinkable so the overflow counter stays in the cell", () => {
    // 60px: the first 50px badge plus the 34px overflow reserve does not fit.
    expect(renderFitted(60)).toBe(1);
    expect(screen.getByText(OVERFLOW_COUNTER)).toHaveTextContent("+2");
    const [first] = screen.getAllByRole("link");
    expect(first).toHaveClass("shrink");
    expect(first).not.toHaveClass("shrink-0");
  });

  it("drops the last badge when it is one pixel short", () => {
    expect(renderFitted(157)).toBe(2);
    expect(screen.getByText(OVERFLOW_COUNTER)).toHaveTextContent("+1");
  });

  it("refits when more values arrive", () => {
    stubLayout(1000, 50);
    const { rerender } = render(
      <ResponsiveReferenceList
        hrefForValue={hrefFor}
        options={OPTIONS}
        values={VALUES.slice(0, 2)}
      />
    );
    expect(screen.getAllByRole("link")).toHaveLength(2);

    rerender(
      <ResponsiveReferenceList
        hrefForValue={hrefFor}
        options={OPTIONS}
        values={VALUES}
      />
    );

    expect(screen.getAllByRole("link")).toHaveLength(3);
    expect(screen.queryByText(OVERFLOW_COUNTER)).toBeNull();
  });

  it("keeps reserving room for a removed badge after the values shrink", () => {
    stubLayout(120, 50);
    const { rerender } = render(
      <ResponsiveReferenceList
        hrefForValue={hrefFor}
        options={OPTIONS}
        values={VALUES}
      />
    );

    rerender(
      <ResponsiveReferenceList
        hrefForValue={hrefFor}
        options={OPTIONS}
        values={VALUES.slice(0, 2)}
      />
    );

    // pins current behavior; looks odd because the unmounted third badge leaves a null measurement slot, so the fit still reserves an overflow counter and hides a second badge that would fit in 104px
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText(OVERFLOW_COUNTER)).toHaveTextContent("+1");
  });

  it("renders nothing for no values", () => {
    const { container } = render(<ResponsiveReferenceList values={[]} />);

    expect(container.textContent).toBe("");
  });
});

describe("ResponsiveReferenceList badges", () => {
  beforeEach(() => stubLayout(1000, 50));

  it("links a badge when an href is supplied and keeps the click from the row", () => {
    const onRowClick = vi.fn();
    const onRowPointerDown = vi.fn();
    render(
      // biome-ignore lint/a11y: stands in for the clickable row the badge sits in
      <div onClick={onRowClick} onPointerDown={onRowPointerDown}>
        <ResponsiveReferenceList
          hrefForValue={hrefFor}
          options={OPTIONS}
          values={["doc-1"]}
        />
      </div>
    );
    const link = screen.getByRole("link", { name: "DOC-1" });

    expect(link).toHaveAttribute("href", "/artifacts/doc-1");
    fireEvent.pointerDown(link);
    fireEvent.click(link);
    expect(onRowClick).not.toHaveBeenCalled();
    expect(onRowPointerDown).not.toHaveBeenCalled();
  });

  it("renders a plain badge when the href resolver returns nothing", () => {
    const { container } = render(
      <ResponsiveReferenceList
        hrefForValue={() => undefined}
        options={OPTIONS}
        values={["doc-1"]}
      />
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getAllByTitle(DOC_OPTION.slug).length).toBeGreaterThan(0);
  });

  it("labels an unknown value with the value itself", () => {
    render(
      <ResponsiveReferenceList
        hrefForValue={hrefFor}
        options={OPTIONS}
        values={["missing"]}
      />
    );

    expect(screen.getByRole("link", { name: "missing" })).toHaveTextContent(
      "missing"
    );
  });

  it("draws a session reference with its owner initials and recency label", () => {
    render(
      <ResponsiveReferenceList
        hrefForValue={hrefFor}
        options={[
          TODAY_SESSION,
          EARLIER_SESSION,
          UNDATED_SESSION,
          MALFORMED_DATE_SESSION,
          OWNERLESS_SESSION,
          OWNED_DOC_OPTION,
          LAST_MONTH_SESSION,
          LAST_YEAR_SESSION,
          MISSING_MONTH_SESSION,
        ]}
        values={[
          "ses-1",
          "ses-2",
          "ses-3",
          "ses-4",
          "ses-5",
          "doc-owned",
          "ses-6",
          "ses-7",
          "ses-8",
        ]}
      />
    );
    const links = screen.getAllByRole("link");

    // One initial on every avatar (Nerys, 2026-10-22).
    expect(links.map((link) => link.textContent)).toEqual([
      "A3:04 pm",
      "P09/20",
      "S8:00 am",
      "S8:00 am",
      "7:00 am",
      "DOC-9",
      "A08/25",
      "A09/25",
      "S8:00 am",
    ]);
  });

  it("spells out a session's owner, status, relationship, and last interaction", () => {
    render(
      <ResponsiveReferenceList
        hrefForValue={hrefFor}
        options={[
          TODAY_SESSION,
          EARLIER_SESSION,
          UNDATED_SESSION,
          OWNERLESS_SESSION,
          OWNED_DOC_OPTION,
        ]}
        values={["ses-1", "ses-2", "ses-3", "ses-5", "doc-owned"]}
      />
    );

    expect(
      screen.getAllByRole("link").map((link) => link.getAttribute("aria-label"))
    ).toEqual([
      "SES-1 · Ottilie Eastwick · Active · Wrote to artifact · Most recent interaction 2026-09-25 3:04 pm",
      "SES-2 · Pascoe Birchall · Completed · Commented on artifact · Most recent interaction 2026-09-20 9:15 am",
      "SES-3 · Sam Chen · Status unavailable · Related to artifact · Most recent interaction 8:00 am",
      "SES-5",
      "DOC-9",
    ]);
  });
});

describe("ResponsiveReferenceList overflow tooltip", () => {
  function hoverCounter(label: string) {
    const counter = screen.getByText(label);
    fireEvent.pointerEnter(counter, { pointerType: "mouse" });
    fireEvent.pointerMove(counter, { pointerType: "mouse" });
  }

  it("links each hidden reference when an href is supplied", async () => {
    stubLayout(120, 50);
    render(
      <ResponsiveReferenceList
        hrefForValue={hrefFor}
        options={OPTIONS}
        values={["doc-1", "ses-2", "missing"]}
      />
    );

    hoverCounter("+2");
    const tooltip = await screen.findByRole("tooltip");
    const links = within(tooltip).getAllByRole("link");

    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/artifacts/ses-2",
      "/artifacts/missing",
    ]);
    expect(links.map((link) => link.textContent)).toEqual([
      "SES-2 · Pascoe Birchall · Completed · Commented on artifact · Most recent interaction 2026-09-20 9:15 am",
      "missing",
    ]);
  });

  it("lists hidden references as text without an href", async () => {
    stubLayout(120, 50);
    render(
      <ResponsiveReferenceList
        options={OPTIONS}
        values={["doc-1", "ses-1", "missing"]}
      />
    );

    hoverCounter("+2");
    const tooltip = await screen.findByRole("tooltip");

    expect(within(tooltip).queryByRole("link")).toBeNull();
    expect(tooltip).toHaveTextContent("SES-1 · Ottilie Eastwick");
    expect(tooltip).toHaveTextContent("missing");
  });
});
