// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SearchWorkspace } from "./search-workspace";

// Any "N results" the context strip could render for the last-good set. A regex
// query matches as a SUBSTRING, so this catches the count inside the aria-live
// line ("24 results for your query") as well as the bare visible strip.
const RE_RESULT_COUNT = /\d+ results?/;
// The stale line, matched EXACTLY (a string query is exact by default), so the
// aria-live line's old "… for your query" suffix cannot satisfy it.
const STALE_TEXT = "Showing last results";

describe("SearchWorkspace filter-error state", () => {
  it("names the rows as stale in the visible strip AND the aria-live line", () => {
    render(<SearchWorkspace />);

    // Baseline: the Results state is a real count for a query that ran, carried
    // by both nodes.
    expect(screen.getAllByText(RE_RESULT_COUNT)).toHaveLength(2);

    fireEvent.click(
      screen.getByRole("radio", { name: "Show Filter error state" })
    );

    // The filter error means the query returned no set, so the rows still on
    // screen belong to the PREVIOUS query. Counting them here would attribute
    // them to the failed one — the strip must say what they are instead.
    expect(screen.queryAllByText(RE_RESULT_COUNT)).toHaveLength(0);

    // The same fact reaches a sighted user and a screen-reader user through two
    // DIFFERENT nodes, so each gets its own assertion: a single "at least one
    // copy survived" check is satisfied by either, and would stay green while
    // the other silently regressed to the old counting line.
    const staleNodes = screen.getAllByText(STALE_TEXT);
    expect(
      staleNodes.filter((node) => node.getAttribute("aria-live") === null)
    ).toHaveLength(1);
    expect(
      staleNodes.filter((node) => node.getAttribute("aria-live") === "polite")
    ).toHaveLength(1);
  });
});
